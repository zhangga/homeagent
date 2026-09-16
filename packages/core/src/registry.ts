/**
 * Registry of known spaces and their metadata (plan §6: bindings stored under
 * data/config). Keeps a cache of open SpaceStore instances and persists a small
 * JSON registry so schedulers keep lightweight per-Space completion state across restarts.
 *
 * The markdown/DB on disk is authoritative for knowledge; this registry only
 * tracks lightweight operational metadata and space existence.
 */
import { existsSync, lstatSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SpaceId } from "@homeagent/shared";
import { isSpaceId, spaceToDir } from "@homeagent/shared";
import type { SpaceMeta, SpaceMetaPatch } from "./types.ts";
import { SpaceStore } from "./space.ts";
import { assertLocalStatePath, writeAtomicStateFile } from "./durable-file.ts";
import { CommittedStateChanges } from "./committed-state-changes.ts";
import { isExecutionScopeEpoch } from "./execution-identities.ts";
import { isGroupParticipationLevel } from "./group-participation.ts";

interface RegistryFile {
  version: 1;
  spaces: Record<string, SpaceMeta>;
}

const MAX_REGISTRY_SPACES = 10_000;
const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;
function validMeta(value: unknown, id: string, requireEpoch: boolean): value is SpaceMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const meta = value as Partial<SpaceMeta>;
  return Object.keys(meta).every(key => ["id", "createdAt", "name", "chatId", "agentId", "agentBindingEpoch", "lastDreamAt", "lastMaintenanceAt",
    "lastMaintenanceScannedPages", "lastMaintenanceIssueCount", "lastMaintenanceTruncated", "replyInThread", "mentionsOnly", "participationLevel"].includes(key))
    && isSpaceId(id) && id.length <= 256 && meta.id === id
    && typeof meta.createdAt === "number" && Number.isSafeInteger(meta.createdAt) && meta.createdAt >= 0
    && (!requireEpoch || isExecutionScopeEpoch(meta.agentBindingEpoch))
    && [meta.name, meta.chatId, meta.agentId].every(text => text === undefined || (typeof text === "string" && text.length <= 1_000))
    && [meta.lastDreamAt, meta.lastMaintenanceAt, meta.lastMaintenanceScannedPages, meta.lastMaintenanceIssueCount]
      .every(n => n === undefined || (typeof n === "number" && Number.isSafeInteger(n) && n >= 0))
    && [meta.replyInThread, meta.mentionsOnly, meta.lastMaintenanceTruncated].every(flag => flag === undefined || typeof flag === "boolean")
    && (meta.participationLevel === undefined || isGroupParticipationLevel(meta.participationLevel));
}

export class SpaceRegistry {
  private readonly changes = new CommittedStateChanges();

  onCommittedChange(listener: () => void): () => void { return this.changes.subscribe(listener); }
  private dataDir: string;
  private configPath: string;
  private stores = new Map<string, SpaceStore>();
  private meta: Map<string, SpaceMeta>;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.configPath = join(dataDir, "config", "spaces.json");
    this.meta = this.load();
  }

  private load(): Map<string, SpaceMeta> {
    assertLocalStatePath(this.dataDir, this.configPath);
    const map = new Map<string, SpaceMeta>();
    let changed = false;
    if (existsSync(this.configPath)) {
      if (lstatSync(this.configPath).isSymbolicLink()) throw new Error("Invalid Space registry path");
      let parsed: unknown;
      try { parsed = JSON.parse(readFileSync(this.configPath, "utf8")); } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        changed = true; // Discover knowledge below, without recovering any Agent binding.
      }
      if (parsed !== undefined) {
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid Space registry");
        const file = parsed as Partial<RegistryFile>;
        if (file.version !== undefined && file.version !== 1) throw new Error("Unsupported Space registry");
        if (!file.spaces || typeof file.spaces !== "object" || Array.isArray(file.spaces)
          || Object.keys(file.spaces).length > MAX_REGISTRY_SPACES
          || Buffer.byteLength(JSON.stringify(file.spaces)) > MAX_REGISTRY_BYTES) throw new Error("Invalid Space registry");
        for (const [id, meta] of Object.entries(file.spaces)) {
          if (!validMeta(meta, id, file.version === 1)) throw new Error("Invalid Space registry entry");
          map.set(id, { ...structuredClone(meta), agentBindingEpoch: file.version === 1 ? meta.agentBindingEpoch : randomUUID() });
        }
        changed ||= file.version === undefined;
      }
    }
    // Discover any space directories not yet in the registry (e.g. after a
    // registry loss) so knowledge is never orphaned.
    const wsDir = join(this.dataDir, "workspaces");
    assertLocalStatePath(this.dataDir, wsDir);
    if (existsSync(wsDir)) {
      const known = new Set([...map.values()].map((m) => spaceToDir(m.id)));
      for (const entry of readdirSync(wsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const dir = entry.name;
        if (known.has(dir)) continue;
        // We cannot reverse a sanitized dir back to the exact id, so we only
        // adopt dirs we can't map if a marker file records the id.
        const marker = join(wsDir, dir, ".spaceid");
        if (existsSync(marker) && !lstatSync(marker).isSymbolicLink()) {
          const id = readFileSync(marker, "utf8").trim();
          if (isSpaceId(id) && id.length <= 256 && spaceToDir(id) === dir && !map.has(id)) {
            map.set(id, { id, createdAt: Date.now(), agentBindingEpoch: randomUUID() });
            changed = true;
          }
        }
      }
    }
    if (changed) this.persist(map);
    return map;
  }

  private persist(meta = this.meta): void {
    assertLocalStatePath(this.dataDir, this.configPath);
    if (meta.size > MAX_REGISTRY_SPACES || [...meta].some(([id, value]) => !validMeta(value, id, true))) {
      throw new Error("Invalid Space registry entry");
    }
    const obj: RegistryFile = { version: 1, spaces: Object.fromEntries(meta) };
    if (Buffer.byteLength(JSON.stringify(obj.spaces)) > MAX_REGISTRY_BYTES) throw new Error("Space registry exceeds capacity");
    writeAtomicStateFile(this.configPath, JSON.stringify(obj, null, 2));
  }

  private commit(change: (candidate: Map<string, SpaceMeta>) => void): void {
    const candidate = new Map([...this.meta].map(([id, meta]) => [id, structuredClone(meta)]));
    change(candidate);
    this.persist(candidate);
    this.meta = candidate;
    this.changes.notify();
  }

  /** Get (creating on first use) the SpaceStore for a space. */
  store(space: SpaceId): SpaceStore {
    assertLocalStatePath(this.dataDir, join(this.dataDir, "workspaces", spaceToDir(space)));
    let s = this.stores.get(space);
    if (!s) {
      s = new SpaceStore(space, this.dataDir);
      this.stores.set(space, s);
    }
    return s;
  }

  /** True if the space has been registered/created. */
  has(space: SpaceId): boolean {
    return this.meta.has(space);
  }

  /** Return the logical owner of a colliding workspace path, if any. */
  storageConflict(space: SpaceId): string | undefined {
    const directory = spaceToDir(space);
    const owner = this.list().find(
      (meta) => meta.id !== space && spaceToDir(meta.id) === directory,
    );
    if (owner) return owner.id;
    if (!this.meta.has(space) && this.store(space).exists()) return "unregistered workspace";
    return undefined;
  }

  /** Ensure a space exists on disk and is registered. Idempotent. */
  ensure(space: SpaceId, opts: { chatId?: string } = {}): SpaceStore {
    if (!isSpaceId(space) || space.length > 256 || (opts.chatId !== undefined && opts.chatId.length > 1_000)) throw new Error("Invalid Space registry entry");
    const store = this.store(space);
    store.ensure();
    // Record the space id in a marker so the registry can self-heal.
    const marker = join(store.root, ".spaceid");
    if (!existsSync(marker)) writeFileSync(marker, space, "utf8");
    if (!this.meta.has(space)) {
      this.commit(candidate => candidate.set(space, { id: space, createdAt: Date.now(), chatId: opts.chatId, agentBindingEpoch: randomUUID() }));
    } else if (opts.chatId && this.meta.get(space)!.chatId !== opts.chatId) {
      this.updateMeta(space, { chatId: opts.chatId });
    }
    return store;
  }

  get(space: SpaceId): SpaceMeta | undefined {
    const meta = this.meta.get(space);
    return meta ? structuredClone(meta) : undefined;
  }

  list(): SpaceMeta[] {
    return [...this.meta.values()].map(meta => structuredClone(meta));
  }

  listByAgent(agentId: string): SpaceMeta[] {
    return [...this.meta.values()]
      .filter((meta) => meta.agentId === agentId)
      .map((meta) => structuredClone(meta));
  }

  clearAgentBindings(agentId: string): SpaceMeta[] {
    const affected = this.listByAgent(agentId);
    if (affected.length === 0) return [];
    const candidate = new Map(
      [...this.meta].map(([id, meta]) => [id, structuredClone(meta)]),
    );
    for (const meta of candidate.values()) {
      if (meta.agentId === agentId) { meta.agentId = undefined; meta.agentBindingEpoch = randomUUID(); }
    }
    this.persist(candidate);
    this.meta = candidate;
    return affected;
  }

  setLastDream(space: SpaceId, at: number): void {
    if (this.meta.has(space)) this.commit(candidate => { candidate.get(space)!.lastDreamAt = at; });
  }

  setLastMaintenance(
    space: SpaceId,
    result: {
      finishedAt: number;
      scannedPages: number;
      issueCount: number;
      truncated: boolean;
    },
  ): void {
    if (this.meta.has(space)) this.commit(candidate => {
      const m = candidate.get(space)!;
      m.lastMaintenanceAt = result.finishedAt;
      m.lastMaintenanceScannedPages = result.scannedPages;
      m.lastMaintenanceIssueCount = result.issueCount;
      m.lastMaintenanceTruncated = result.truncated;
    });
  }

  /**
   * Patch mutable per-space settings (management backend): display name, the
   * assigned agent, and the reply-behavior toggles. `id`/`createdAt` are never
   * changed. No-op (returns undefined) if the space is unknown.
   */
  updateMeta(
    space: SpaceId,
    patch: SpaceMetaPatch,
  ): SpaceMeta | undefined {
    const m = this.get(space);
    if (!m) return undefined;
    if (patch.name !== undefined) m.name = patch.name;
    if (patch.agentId !== undefined) m.agentId = patch.agentId || undefined;
    if (patch.replyInThread !== undefined) m.replyInThread = patch.replyInThread;
    if (patch.mentionsOnly !== undefined) m.mentionsOnly = patch.mentionsOnly;
    if (patch.participationLevel !== undefined) m.participationLevel = patch.participationLevel;
    if (patch.chatId !== undefined) m.chatId = patch.chatId;
    const previous = this.meta.get(space)!;
    if (["agentId", "chatId", "replyInThread", "mentionsOnly", "participationLevel"]
      .some(key => Reflect.get(m, key) !== Reflect.get(previous, key))) m.agentBindingEpoch = randomUUID();
    this.commit(candidate => candidate.set(space, m));
    return structuredClone(m);
  }

  /** Restore an authoritative metadata snapshot after the space is on disk. */
  restoreMeta(meta: SpaceMeta): SpaceMeta {
    const restored = { ...structuredClone(meta), agentBindingEpoch: randomUUID() };
    if (!validMeta(restored, meta.id, true)) throw new Error("Invalid Space registry entry");
    const store = this.store(meta.id);
    store.ensure();
    const marker = join(store.root, ".spaceid");
    if (!existsSync(marker)) writeFileSync(marker, meta.id, "utf8");
    this.commit(candidate => candidate.set(meta.id, restored));
    return structuredClone(restored);
  }

  /** Remove a registered space and its entire on-disk workspace. */
  remove(space: SpaceId): boolean {
    const original = this.meta.get(space);
    if (!original) return false;
    const store = this.stores.get(space) ?? new SpaceStore(space, this.dataDir);
    assertLocalStatePath(this.dataDir, store.root);
    store.close();
    this.stores.delete(space);
    try {
      // Persist the logical deletion first. If the process exits before the
      // physical delete, startup discovery recovers the workspace via .spaceid.
      this.commit(candidate => candidate.delete(space));
      rmSync(store.root, { recursive: true, force: true });
    } catch (err) {
      try {
        this.commit(candidate => candidate.set(space, original));
      } catch {
        // Preserve the original failure; filesystem discovery is the fallback.
      }
      throw err;
    }
    return true;
  }

  closeAll(): void {
    for (const s of this.stores.values()) s.close();
    this.stores.clear();
  }
}
