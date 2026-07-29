/**
 * Registry of known spaces and their metadata (plan §6: bindings stored under
 * data/config). Keeps a cache of open SpaceStore instances and persists a small
 * JSON registry so the scheduler knows each space's lastDreamAt across restarts.
 *
 * The markdown/DB on disk is authoritative for knowledge; this registry only
 * tracks lightweight operational metadata and space existence.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SpaceId } from "@homeagent/shared";
import { isSpaceId, spaceToDir } from "@homeagent/shared";
import type { SpaceMeta, SpaceMetaPatch } from "./types.ts";
import { SpaceStore } from "./space.ts";

interface RegistryFile {
  spaces: Record<string, SpaceMeta>;
}

export class SpaceRegistry {
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
    const map = new Map<string, SpaceMeta>();
    if (existsSync(this.configPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as RegistryFile;
        for (const [id, m] of Object.entries(parsed.spaces ?? {})) {
          if (isSpaceId(id)) map.set(id, m);
        }
      } catch {
        // corrupt registry: fall back to filesystem discovery below
      }
    }
    // Discover any space directories not yet in the registry (e.g. after a
    // registry loss) so knowledge is never orphaned.
    const wsDir = join(this.dataDir, "workspaces");
    if (existsSync(wsDir)) {
      const known = new Set([...map.values()].map((m) => spaceToDir(m.id)));
      for (const dir of readdirSync(wsDir)) {
        if (known.has(dir)) continue;
        // We cannot reverse a sanitized dir back to the exact id, so we only
        // adopt dirs we can't map if a marker file records the id.
        const marker = join(wsDir, dir, ".spaceid");
        if (existsSync(marker)) {
          const id = readFileSync(marker, "utf8").trim();
          if (isSpaceId(id) && !map.has(id)) {
            map.set(id, { id, createdAt: Date.now() });
          }
        }
      }
    }
    return map;
  }

  private persist(meta = this.meta): void {
    mkdirSync(join(this.dataDir, "config"), { recursive: true });
    const obj: RegistryFile = { spaces: Object.fromEntries(meta) };
    writeFileSync(this.configPath, JSON.stringify(obj, null, 2), "utf8");
  }

  /** Get (creating on first use) the SpaceStore for a space. */
  store(space: SpaceId): SpaceStore {
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
    const store = this.store(space);
    store.ensure();
    // Record the space id in a marker so the registry can self-heal.
    const marker = join(store.root, ".spaceid");
    if (!existsSync(marker)) writeFileSync(marker, space, "utf8");
    if (!this.meta.has(space)) {
      this.meta.set(space, { id: space, createdAt: Date.now(), chatId: opts.chatId });
      this.persist();
    } else if (opts.chatId && this.meta.get(space)!.chatId !== opts.chatId) {
      this.meta.get(space)!.chatId = opts.chatId;
      this.persist();
    }
    return store;
  }

  get(space: SpaceId): SpaceMeta | undefined {
    return this.meta.get(space);
  }

  list(): SpaceMeta[] {
    return [...this.meta.values()];
  }

  listByAgent(agentId: string): SpaceMeta[] {
    return [...this.meta.values()]
      .filter((meta) => meta.agentId === agentId)
      .map((meta) => ({ ...meta }));
  }

  clearAgentBindings(agentId: string): SpaceMeta[] {
    const affected = this.listByAgent(agentId);
    if (affected.length === 0) return [];
    const candidate = new Map(
      [...this.meta].map(([id, meta]) => [id, { ...meta }]),
    );
    for (const meta of candidate.values()) {
      if (meta.agentId === agentId) meta.agentId = undefined;
    }
    this.persist(candidate);
    this.meta = candidate;
    return affected;
  }

  setLastDream(space: SpaceId, at: number): void {
    const m = this.meta.get(space);
    if (m) {
      m.lastDreamAt = at;
      this.persist();
    }
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
    const m = this.meta.get(space);
    if (!m) return undefined;
    if (patch.name !== undefined) m.name = patch.name;
    if (patch.agentId !== undefined) m.agentId = patch.agentId || undefined;
    if (patch.replyInThread !== undefined) m.replyInThread = patch.replyInThread;
    if (patch.mentionsOnly !== undefined) m.mentionsOnly = patch.mentionsOnly;
    if (patch.participationLevel !== undefined) m.participationLevel = patch.participationLevel;
    if (patch.chatId !== undefined) m.chatId = patch.chatId;
    this.persist();
    return m;
  }

  /** Restore an authoritative metadata snapshot after the space is on disk. */
  restoreMeta(meta: SpaceMeta): SpaceMeta {
    this.ensure(meta.id, { chatId: meta.chatId });
    const restored = { ...meta };
    this.meta.set(meta.id, restored);
    this.persist();
    return restored;
  }

  /** Remove a registered space and its entire on-disk workspace. */
  remove(space: SpaceId): boolean {
    const original = this.meta.get(space);
    if (!original) return false;
    const store = this.stores.get(space) ?? new SpaceStore(space, this.dataDir);
    store.close();
    this.stores.delete(space);
    this.meta.delete(space);
    try {
      // Persist the logical deletion first. If the process exits before the
      // physical delete, startup discovery recovers the workspace via .spaceid.
      this.persist();
      rmSync(store.root, { recursive: true, force: true });
    } catch (err) {
      this.meta.set(space, original);
      try {
        this.persist();
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
