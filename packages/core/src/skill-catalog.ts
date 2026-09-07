import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  hashProviderSkillBundle,
  providerCodexHome,
  providerSkillReference,
  type ProviderSkillInput,
  type ProviderId,
} from "@homeagent/llm";
import type { SkillWarningView } from "@homeagent/shared";

export type SkillRootKind =
  | "shared-agents"
  | "codex-user"
  | "codex-plugin"
  | "codex-vendor"
  | "claude-user"
  | "claude-plugin"
  | "claude-marketplace"
  | "trae-user";

export interface SkillRoot {
  kind: SkillRootKind;
  path: string;
  providerIds: ProviderId[];
}

export interface SkillDiagnostic {
  code: string;
  message: string;
}

export interface SkillSource {
  sourceKey: string;
  rootKind: SkillRootKind;
  relativeDir: string;
  name: string;
  description: string;
  providerIds: ProviderId[];
  skillFile: string;
  skillFileHash: string;
  status: "available" | "invalid";
  diagnostics: SkillDiagnostic[];
}

export interface SkillCatalogSnapshot {
  sources: SkillSource[];
  entries: SkillCatalogEntry[];
  diagnostics: SkillCatalogDiagnostic[];
  refreshedAt: number;
}

export interface SkillCatalogDiagnostic {
  code: "root_unavailable";
  rootKind: SkillRootKind;
  message: string;
}

export interface SkillBindingRequest {
  kind?: "source";
  sourceKey: string;
  name: string;
}

export interface LegacySkillBindingRequest {
  kind: "legacy-name";
  name: string;
}

export type SkillRequestSnapshot =
  | (SkillBindingRequest & { kind: "source" })
  | LegacySkillBindingRequest;

export type SkillSkipCode =
  | "missing_source"
  | "invalid_skill"
  | "provider_incompatible"
  | "ambiguous_legacy_name"
  | "shadowed_source"
  | "invalid_invocation_name"
  | "no_tools_context";

export interface ResolvedSkillSnapshot {
  sourceKey: string;
  name: string;
  invocationName: string;
  reference: string;
  skillFileHash: string;
}

export interface SkippedSkillSnapshot {
  sourceKey?: string;
  name: string;
  code: SkillSkipCode;
  message: string;
}

export interface ResolvedAgentSkills {
  requested: SkillRequestSnapshot[];
  resolved: ResolvedSkillSnapshot[];
  skipped: SkippedSkillSnapshot[];
  warnings: SkippedSkillSnapshot[];
}

const warningMessages: Record<SkillSkipCode, string> = {
  missing_source: "Skill 当前不可用，已跳过",
  invalid_skill: "Skill 配置无效，已跳过",
  provider_incompatible: "Skill 与当前 Provider 不兼容，已跳过",
  ambiguous_legacy_name: "旧 Skill 名称未绑定到唯一来源，已跳过",
  shadowed_source: "Skill 来源被更高优先级版本遮蔽，已跳过",
  invalid_invocation_name: "Skill 名称无法安全调用，已跳过",
  no_tools_context: "普通 no-tools 调用不会加载本机 Skill，已跳过",
};

export function skillWarningViews(
  resolution: Pick<ResolvedAgentSkills, "skipped">,
  limit = 10,
): SkillWarningView[] {
  const seen = new Set<string>();
  const warnings: SkillWarningView[] = [];
  for (const skipped of resolution.skipped) {
    const key = `${skipped.code}\0${skipped.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    warnings.push({
      name: skipped.name,
      code: skipped.code,
      message: warningMessages[skipped.code],
    });
    if (warnings.length >= Math.max(0, Math.trunc(limit))) break;
  }
  return warnings;
}

export interface SkillCatalogEntry {
  key: string;
  name: string;
  description: string;
  skillFileHash: string;
  sources: SkillSource[];
}

export interface SkillCatalogOptions {
  roots: SkillRoot[];
  cacheTtlMs?: number;
  now?: () => number;
  limits?: {
    maxDepth?: number;
    maxFileBytes?: number;
    maxSkills?: number;
    maxTotalBytes?: number;
    maxEntries?: number;
  };
}

export function defaultSkillRoots(
  homeDirectory = homedir(),
  codexHome = providerCodexHome(),
): SkillRoot[] {
  return [
    {
      kind: "shared-agents",
      path: join(homeDirectory, ".agents", "skills"),
      providerIds: ["claude", "codex", "trae-cli"],
    },
    {
      kind: "codex-user",
      path: join(codexHome, "skills"),
      providerIds: ["codex"],
    },
    {
      kind: "claude-user",
      path: join(homeDirectory, ".claude", "skills"),
      providerIds: ["claude"],
    },
    {
      kind: "claude-plugin",
      path: join(homeDirectory, ".claude", "plugins", "cache"),
      providerIds: ["claude"],
    },
    {
      kind: "claude-marketplace",
      path: join(homeDirectory, ".claude", "plugins", "marketplaces"),
      providerIds: ["claude"],
    },
    {
      kind: "trae-user",
      path: join(homeDirectory, ".trae", "skills"),
      providerIds: ["trae-cli"],
    },
  ];
}

function frontmatterScalar(source: string, field: string): string {
  const frontmatter = source.match(
    /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|[ \t]*$)/u,
  )?.[1];
  if (!frontmatter) return "";
  const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+?)\\s*$`, "mu"));
  if (!match) return "";
  const value = match[1]!.trim();
  if (
    value.length >= 2
    && ((value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizedRelativeDir(root: string, directory: string): string {
  return relative(root, directory).split(sep).join("/");
}

function validSkillName(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(value);
}

/** Bound the memoized bundle-hash table so a churning corpus cannot grow it. */
const MAX_BUNDLE_HASH_CACHE_ENTRIES = 4_000;

const providerRootPrecedence: Record<ProviderId, readonly SkillRootKind[]> = {
  gateway: [],
  codex: ["codex-user", "shared-agents", "codex-plugin", "codex-vendor"],
  claude: ["claude-user", "shared-agents", "claude-plugin", "claude-marketplace"],
  "trae-cli": ["trae-user", "shared-agents"],
};

export function providerSkillRootKinds(provider: ProviderId): SkillRootKind[] {
  return [...providerRootPrecedence[provider]];
}

function rootPrecedence(provider: ProviderId, rootKind: SkillRootKind): number {
  const rank = providerRootPrecedence[provider].indexOf(rootKind);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
}

function effectiveProviderSource(
  sources: readonly SkillSource[],
  provider: ProviderId,
  name: string,
): SkillSource | undefined {
  return sources
    .filter((source) =>
      source.status === "available"
      && source.providerIds.includes(provider)
      && source.name.toLowerCase() === name.toLowerCase()
      && providerSkillReference(provider, source.name) !== undefined
    )
    .sort((a, b) =>
      rootPrecedence(provider, a.rootKind) - rootPrecedence(provider, b.rootKind)
      || a.sourceKey.localeCompare(b.sourceKey)
    )[0];
}

function catalogEntries(sources: SkillSource[]): SkillCatalogEntry[] {
  const entries = new Map<string, SkillCatalogEntry>();
  for (const source of sources) {
    const normalizedName = source.name.toLowerCase();
    const key = source.status === "available"
      ? `${normalizedName}:${source.skillFileHash}`
      : `${normalizedName}:${source.sourceKey}`;
    const existing = entries.get(key);
    if (existing) {
      existing.sources.push(source);
      continue;
    }
    entries.set(key, {
      key,
      name: source.name,
      description: source.description,
      skillFileHash: source.skillFileHash,
      sources: [source],
    });
  }
  return [...entries.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || a.key.localeCompare(b.key)
  );
}

/**
 * Bounded metadata key for one Skill bundle. Walking metadata is far cheaper
 * than reading every byte, and any write changes an entry's size, mode, mtime
 * or ctime, so an unchanged signature means a previously computed bundle hash
 * is still valid. This is only ever a cache key: any miss, or any walk failure,
 * falls through to the authoritative content hash, which keeps the symlink,
 * escape and size rules of `hashProviderSkillBundle` in force.
 */
function skillBundleSignature(skillFile: string, maxEntries: number): string {
  const root = dirname(skillFile);
  const parts: string[] = [];
  const pending = [{ directory: root, relativeDir: "", depth: 0 }];
  let entries = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > 32) throw new Error("Skill bundle is too deeply nested");
    const children = readdirSync(current.directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      entries += 1;
      if (entries > maxEntries) throw new Error("Skill bundle has too many entries");
      const fullPath = join(current.directory, child.name);
      const relativePath = join(current.relativeDir, child.name).split(sep).join("/");
      const metadata = lstatSync(fullPath);
      const kind = metadata.isSymbolicLink()
        ? "l"
        : metadata.isDirectory()
        ? "d"
        : metadata.isFile()
        ? "f"
        : "o";
      parts.push([
        relativePath,
        kind,
        metadata.size,
        metadata.mode,
        metadata.mtimeMs,
        metadata.ctimeMs,
        metadata.dev,
        metadata.ino,
      ].join("\0"));
      if (kind === "d") {
        pending.push({
          directory: fullPath,
          relativeDir: relativePath,
          depth: current.depth + 1,
        });
      }
    }
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

function skillDirectories(root: string, maxDepth: number, maxEntries: number): string[] {
  const pending = [{ directory: root, depth: 0 }];
  const found: string[] = [];
  let visitedEntries = 0;
  while (pending.length > 0) {
    const { directory, depth } = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    let hasSkillFile = false;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (visitedEntries >= maxEntries) return found.sort();
      visitedEntries += 1;
      if (entry.isFile() && entry.name === "SKILL.md") {
        hasSkillFile = true;
      } else if (depth < maxDepth && entry.isDirectory()) {
        pending.unshift({ directory: join(directory, entry.name), depth: depth + 1 });
      }
    }
    if (hasSkillFile) {
      found.push(directory);
      continue;
    }
  }
  return found.sort();
}

export class SkillCatalog {
  private readonly roots: SkillRoot[];
  private readonly maxDepth: number;
  private readonly maxFileBytes: number;
  private readonly maxSkills: number;
  private readonly maxTotalBytes: number;
  private readonly maxEntries: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private snapshot?: SkillCatalogSnapshot;
  /** Bundle hashes produced by the immediately preceding synchronous resolve. */
  private lastResolvedBundleHashes = new Map<string, string>();
  /**
   * Content hashes keyed by canonical path plus a bounded metadata signature.
   * Reading every bundle byte on each resolve made admission cost scale with
   * the whole installed Skill corpus; this keeps repeat resolves metadata-only
   * while still recomputing whenever any entry's metadata changes.
   */
  private readonly bundleHashCache = new Map<string, string | null>();

  constructor(options: SkillCatalogOptions) {
    this.roots = options.roots.map((root) => ({
      ...root,
      providerIds: [...root.providerIds],
    }));
    this.maxDepth = Math.max(0, Math.trunc(options.limits?.maxDepth ?? 8));
    this.maxFileBytes = Math.max(1, Math.trunc(options.limits?.maxFileBytes ?? 256 * 1024));
    this.maxSkills = Math.max(1, Math.trunc(options.limits?.maxSkills ?? 2_000));
    this.maxTotalBytes = Math.max(
      1,
      Math.trunc(options.limits?.maxTotalBytes ?? 16 * 1024 * 1024),
    );
    this.maxEntries = Math.max(1, Math.trunc(options.limits?.maxEntries ?? 50_000));
    this.cacheTtlMs = Math.max(0, Math.trunc(options.cacheTtlMs ?? 30_000));
    this.now = options.now ?? Date.now;
  }

  /**
   * Authoritative bundle hash, memoized on a bounded metadata signature.
   * A cache hit still proves nothing was written since the stored hash, and a
   * miss recomputes through `hashProviderSkillBundle`, so every symlink, escape,
   * entry-count and size rule keeps failing closed exactly as before.
   */
  private bundleHash(skillFile: string): string {
    let signature: string | undefined;
    try {
      signature = `${realpathSync(skillFile)}\u0000${
        skillBundleSignature(skillFile, this.maxEntries)
      }`;
    } catch {
      // An unreadable or hostile tree must reach the authoritative hash below,
      // which raises the specific failure the caller already handles.
      signature = undefined;
    }
    if (signature !== undefined) {
      const cached = this.bundleHashCache.get(signature);
      // `null` records a bundle that is deterministically unusable for this exact
      // metadata shape (oversized, symlinked, escaping). Rejecting it from cache
      // keeps the same fail-closed outcome without re-reading the whole tree.
      if (cached === null) throw new Error("Skill bundle is invalid or changed");
      if (cached !== undefined) return cached;
    }
    const remember = (value: string | null): void => {
      if (signature === undefined) return;
      if (this.bundleHashCache.size >= MAX_BUNDLE_HASH_CACHE_ENTRIES) {
        this.bundleHashCache.clear();
      }
      this.bundleHashCache.set(signature, value);
    };
    let hash: string;
    try {
      hash = hashProviderSkillBundle(skillFile, this.maxEntries, this.maxTotalBytes);
    } catch (error) {
      remember(null);
      throw error;
    }
    remember(hash);
    return hash;
  }

  refresh(): SkillCatalogSnapshot {
    const sources: SkillSource[] = [];
    const diagnostics: SkillCatalogDiagnostic[] = [];
    let totalBytes = 0;
    const seenRootPaths = new Set<string>();
    rootLoop:
    for (const root of this.roots) {
      let resolvedRoot: string;
      try {
        resolvedRoot = realpathSync(root.path);
      } catch {
        diagnostics.push({
          code: "root_unavailable",
          rootKind: root.kind,
          message: "Skill root is unavailable",
        });
        continue;
      }
      if (seenRootPaths.has(resolvedRoot)) continue;
      seenRootPaths.add(resolvedRoot);
      for (const directory of skillDirectories(root.path, this.maxDepth, this.maxEntries)) {
        if (sources.length >= this.maxSkills) break rootLoop;
        const skillFile = join(directory, "SKILL.md");
        const relativeDir = normalizedRelativeDir(root.path, directory);
        try {
          const fileSize = statSync(skillFile).size;
          if (fileSize > this.maxFileBytes) {
            sources.push({
              sourceKey: `${root.kind}:${relativeDir}`,
              rootKind: root.kind,
              relativeDir,
              name: basename(directory),
              description: "",
              providerIds: [...root.providerIds],
              skillFile,
              skillFileHash: "",
              status: "invalid",
              diagnostics: [{
                code: "file_too_large",
                message: `SKILL.md exceeds the ${this.maxFileBytes} byte scan limit`,
              }],
            });
            continue;
          }
          if (totalBytes + fileSize > this.maxTotalBytes) break rootLoop;
          totalBytes += fileSize;
        } catch {
          continue;
        }
        let content: string;
        try {
          content = readFileSync(skillFile, "utf8");
        } catch {
          continue;
        }
        const name = frontmatterScalar(content, "name");
        const diagnostics = validSkillName(name)
          ? []
          : [{
              code: "invalid_name",
              message: "SKILL.md frontmatter must contain a valid name",
            }];
        sources.push({
          sourceKey: `${root.kind}:${relativeDir}`,
          rootKind: root.kind,
          relativeDir,
          name,
          description: frontmatterScalar(content, "description"),
          providerIds: [...root.providerIds],
          skillFile,
          skillFileHash: createHash("sha256").update(content).digest("hex"),
          status: diagnostics.length === 0 ? "available" : "invalid",
          diagnostics,
        });
      }
    }
    sources.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
    const snapshot = {
      sources,
      entries: catalogEntries(sources),
      diagnostics,
      refreshedAt: this.now(),
    };
    this.snapshot = snapshot;
    return snapshot;
  }

  current(): SkillCatalogSnapshot {
    if (
      this.snapshot
      && this.now() - this.snapshot.refreshedAt < this.cacheTtlMs
    ) {
      return this.snapshot;
    }
    return this.refresh();
  }

  resolveLegacyName(
    name: string,
    provider: ProviderId,
  ): SkillBindingRequest | undefined {
    if (!validSkillName(name)) return undefined;
    const candidates = this.current().sources.filter((source) =>
      source.status === "available"
      && source.providerIds.includes(provider)
      && source.name.toLowerCase() === name.toLowerCase()
      && providerSkillReference(provider, source.name) !== undefined
    );
    if (new Set(candidates.map((source) => source.skillFileHash)).size !== 1) {
      return undefined;
    }
    const source = effectiveProviderSource(candidates, provider, name);
    return source ? { sourceKey: source.sourceKey, name: source.name } : undefined;
  }

  hasSourceBinding(binding: SkillBindingRequest, provider: ProviderId): boolean {
    const result = this.resolve([binding], provider);
    return result.resolved.length === 1
      && result.resolved[0]!.sourceKey === binding.sourceKey
      && result.resolved[0]!.name === binding.name;
  }

  hasCatalogSourceBinding(binding: SkillBindingRequest): boolean {
    const source = this.current().sources.find(
      (candidate) => candidate.sourceKey === binding.sourceKey,
    );
    return source?.status === "available" && source.name === binding.name;
  }

  resolveAgentBindings(
    bindings: readonly (SkillBindingRequest | LegacySkillBindingRequest)[],
    provider: ProviderId,
  ): ResolvedAgentSkills {
    const sourceBindings = bindings.filter(
      (binding): binding is SkillBindingRequest => !("kind" in binding)
        || binding.kind !== "legacy-name",
    );
    const result = this.resolve(sourceBindings, provider);
    const legacySkipped: SkippedSkillSnapshot[] = bindings
      .filter((binding): binding is LegacySkillBindingRequest =>
        "kind" in binding && binding.kind === "legacy-name"
      )
      .map((binding) => ({
        name: binding.name,
        code: "ambiguous_legacy_name",
        message: "Legacy Skill name is not bound to an exact source",
      }));
    return {
      ...result,
      requested: bindings.map((binding): SkillRequestSnapshot =>
        "kind" in binding && binding.kind === "legacy-name"
          ? { ...binding }
          : { kind: "source", sourceKey: binding.sourceKey, name: binding.name }
      ),
      skipped: [...result.skipped, ...legacySkipped],
      warnings: [...result.warnings, ...legacySkipped.map((item) => ({ ...item }))],
    };
  }

  /** Resolve every valid Skill that the selected Provider can invoke. */
  resolveAll(provider: ProviderId): ResolvedAgentSkills {
    const snapshot = this.current();
    const names = new Map<string, string>();
    for (const source of snapshot.sources) {
      if (
        source.status !== "available"
        || !source.providerIds.includes(provider)
        || providerSkillReference(provider, source.name) === undefined
      ) {
        continue;
      }
      const key = source.name.toLowerCase();
      if (!names.has(key)) names.set(key, source.name);
    }
    const sources = [...names.values()]
      .map((name) => effectiveProviderSource(snapshot.sources, provider, name))
      .filter((source): source is SkillSource => source !== undefined)
      .sort((left, right) =>
        left.name.localeCompare(right.name) || left.sourceKey.localeCompare(right.sourceKey)
      );
    return this.resolve(
      sources.map((source) => ({
        sourceKey: source.sourceKey,
        name: source.name,
      })),
      provider,
    );
  }

  /**
   * Convert already-resolved, frozen Skill evidence into per-call filesystem
   * inputs. Paths are deliberately absent from durable Run state and UI views.
   * Re-hash here so only the exact bundle admitted immediately before the
   * Provider call receives a filesystem grant. This gate deliberately bypasses
   * the metadata-keyed hash cache: it is the last check before granting
   * filesystem access, so it always reads the bundle's real bytes.
   */
  executionInputs(resolved: readonly ResolvedSkillSnapshot[]): ProviderSkillInput[] {
    const byKey = new Map(this.current().sources.map((source) => [source.sourceKey, source]));
    return resolved.map((skill) => {
      const source = byKey.get(skill.sourceKey);
      let bundleMatches = false;
      try {
        bundleMatches = Boolean(
          source
          && source.status === "available"
          && source.name === skill.name
          && hashProviderSkillBundle(source.skillFile, this.maxEntries, this.maxTotalBytes)
            === skill.skillFileHash,
        );
      } catch {
        bundleMatches = false;
      }
      if (!source || !bundleMatches) {
        throw new Error(
          "Queued Run Skill snapshot changed after enqueue; refusing to execute mutable Skill content.",
        );
      }
      try {
        const directory = realpathSync(dirname(source.skillFile));
        const skillFile = realpathSync(source.skillFile);
        if (
          lstatSync(dirname(source.skillFile)).isSymbolicLink()
          || lstatSync(source.skillFile).isSymbolicLink()
          || relative(directory, skillFile) !== "SKILL.md"
        ) {
          throw new Error("invalid");
        }
        return {
          name: skill.invocationName,
          directory,
          skillFile,
          bundleHash: skill.skillFileHash,
        };
      } catch {
        throw new Error("Resolved Skill bundle path is invalid.");
      }
    });
  }

  /**
   * Map paths without hashing every bundle a second time. Call only
   * immediately after `resolve*` validated the same frozen snapshots.
   */
  executionInputsAfterValidation(
    resolved: readonly ResolvedSkillSnapshot[],
  ): ProviderSkillInput[] {
    const byKey = new Map(this.current().sources.map((source) => [source.sourceKey, source]));
    return resolved.map((skill) => {
      const source = byKey.get(skill.sourceKey);
      if (
        !source
        || source.status !== "available"
        || source.name !== skill.name
        || this.lastResolvedBundleHashes.get(skill.sourceKey) !== skill.skillFileHash
      ) {
        throw new Error(
          "Queued Run Skill snapshot changed after enqueue; refusing to execute mutable Skill content.",
        );
      }
      try {
        const directory = realpathSync(dirname(source.skillFile));
        const skillFile = realpathSync(source.skillFile);
        if (
          lstatSync(dirname(source.skillFile)).isSymbolicLink()
          || lstatSync(source.skillFile).isSymbolicLink()
          || relative(directory, skillFile) !== "SKILL.md"
        ) {
          throw new Error("invalid");
        }
        return {
          name: skill.invocationName,
          directory,
          skillFile,
          bundleHash: skill.skillFileHash,
        };
      } catch {
        throw new Error("Resolved Skill bundle path is invalid.");
      }
    });
  }

  resolve(bindings: readonly SkillBindingRequest[], provider: ProviderId): ResolvedAgentSkills {
    const snapshot = this.current();
    const byKey = new Map(snapshot.sources.map((source) => [source.sourceKey, source]));
    const requested = bindings.map((binding): SkillRequestSnapshot => ({
      kind: "source",
      sourceKey: binding.sourceKey,
      name: binding.name,
    }));
    const resolved: ResolvedSkillSnapshot[] = [];
    const resolvedBundleHashes = new Map<string, string>();
    const skipped: SkippedSkillSnapshot[] = [];
    for (const binding of bindings) {
      const source = byKey.get(binding.sourceKey);
      if (!source) {
        skipped.push({
          ...binding,
          code: "missing_source",
          message: "Skill source is unavailable",
        });
        continue;
      }
      try {
        if (statSync(source.skillFile).size > this.maxFileBytes) {
          skipped.push({
            ...binding,
            code: "invalid_skill",
            message: "Skill metadata is invalid",
          });
          continue;
        }
      } catch {
        skipped.push({
          ...binding,
          code: "missing_source",
          message: "Skill source is unavailable",
        });
        continue;
      }
      let currentContent: string;
      try {
        currentContent = readFileSync(source.skillFile, "utf8");
      } catch {
        skipped.push({
          ...binding,
          code: "missing_source",
          message: "Skill source is unavailable",
        });
        continue;
      }
      const currentName = frontmatterScalar(currentContent, "name");
      if (!validSkillName(currentName) || currentName !== source.name) {
        skipped.push({
          ...binding,
          code: "invalid_skill",
          message: "Skill metadata is invalid",
        });
        continue;
      }
      if (source.status !== "available") {
        skipped.push({
          ...binding,
          code: "invalid_skill",
          message: "Skill metadata is invalid",
        });
        continue;
      }
      if (!source.providerIds.includes(provider)) {
        skipped.push({
          ...binding,
          code: "provider_incompatible",
          message: "Skill is unavailable for the selected provider",
        });
        continue;
      }
      const effectiveSource = effectiveProviderSource(snapshot.sources, provider, source.name);
      if (
        effectiveSource
        && effectiveSource.sourceKey !== source.sourceKey
        && effectiveSource.skillFileHash !== source.skillFileHash
      ) {
        skipped.push({
          ...binding,
          code: "shadowed_source",
          message: `Skill source is shadowed by ${effectiveSource.sourceKey} for ${provider}`,
        });
        continue;
      }
      let resolvedSource = source;
      if (effectiveSource && effectiveSource.sourceKey !== source.sourceKey) {
        try {
          currentContent = readFileSync(effectiveSource.skillFile, "utf8");
          resolvedSource = effectiveSource;
        } catch {
          // The exact bound source still exists, so let the provider use its
          // next available same-name source until the catalog refreshes.
        }
      }
      const reference = providerSkillReference(provider, resolvedSource.name);
      if (!reference) {
        skipped.push({
          ...binding,
          code: "invalid_invocation_name",
          message: "Skill name cannot be invoked by the selected provider",
        });
        continue;
      }
      let bundleHash: string;
      try {
        bundleHash = this.bundleHash(resolvedSource.skillFile);
      } catch {
        skipped.push({
          ...binding,
          code: "invalid_skill",
          message: "Skill bundle is invalid or changed",
        });
        continue;
      }
      resolved.push({
        sourceKey: resolvedSource.sourceKey,
        name: resolvedSource.name,
        invocationName: resolvedSource.name,
        reference,
        skillFileHash: bundleHash,
      });
      resolvedBundleHashes.set(resolvedSource.sourceKey, bundleHash);
    }
    this.lastResolvedBundleHashes = resolvedBundleHashes;
    return {
      requested,
      resolved,
      skipped,
      warnings: skipped.map((item) => ({ ...item })),
    };
  }
}
