import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { providerSkillReference, type ProviderId } from "@homeagent/llm";
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

export function defaultSkillRoots(homeDirectory = homedir()): SkillRoot[] {
  return [
    {
      kind: "shared-agents",
      path: join(homeDirectory, ".agents", "skills"),
      providerIds: ["claude", "codex", "trae-cli"],
    },
    {
      kind: "codex-user",
      path: join(homeDirectory, ".codex", "skills"),
      providerIds: ["codex"],
    },
    {
      kind: "codex-plugin",
      path: join(homeDirectory, ".codex", "plugins", "cache"),
      providerIds: ["codex"],
    },
    {
      kind: "codex-vendor",
      path: join(homeDirectory, ".codex", "vendor_imports", "skills"),
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

interface SkillBundleFile {
  path: string;
  mode: number;
  content: Buffer;
}

/**
 * Hash every regular file a native Skill can load. A single-file Skill keeps
 * its historical SKILL.md digest for compatibility; once resources exist the
 * manifest binds path, mode and bytes. Symlinks/junctions and oversized trees
 * fail closed instead of following content outside the selected Skill.
 */
function hashSkillBundle(
  skillFile: string,
  maxEntries: number,
  maxTotalBytes: number,
): string {
  const root = dirname(skillFile);
  const canonicalRoot = realpathSync(root);
  if (lstatSync(root).isSymbolicLink()) {
    throw new Error("Skill bundle root cannot be a symbolic link");
  }
  const files: SkillBundleFile[] = [];
  const pending = [{ directory: root, relativeDir: "", depth: 0 }];
  let entries = 0;
  let totalBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > 32) throw new Error("Skill bundle is too deeply nested");
    const children = readdirSync(current.directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      entries += 1;
      if (entries > maxEntries) throw new Error("Skill bundle has too many entries");
      const fullPath = join(current.directory, child.name);
      const metadata = lstatSync(fullPath);
      if (metadata.isSymbolicLink()) {
        throw new Error("Skill bundle cannot contain symbolic links");
      }
      const canonicalPath = realpathSync(fullPath);
      const fromRoot = relative(canonicalRoot, canonicalPath);
      if (
        fromRoot === ".."
        || fromRoot.startsWith(`..${sep}`)
        || isAbsolute(fromRoot)
      ) {
        throw new Error("Skill bundle entry escapes its root");
      }
      const relativePath = join(current.relativeDir, child.name).split(sep).join("/");
      if (metadata.isDirectory()) {
        pending.push({
          directory: fullPath,
          relativeDir: relativePath,
          depth: current.depth + 1,
        });
        continue;
      }
      if (!metadata.isFile()) throw new Error("Skill bundle contains a non-regular file");
      totalBytes += metadata.size;
      if (totalBytes > maxTotalBytes) throw new Error("Skill bundle is too large");
      const content = readFileSync(fullPath);
      const after = lstatSync(fullPath);
      if (
        after.isSymbolicLink()
        || after.size !== metadata.size
        || after.mtimeMs !== metadata.mtimeMs
      ) {
        throw new Error("Skill bundle changed while it was being hashed");
      }
      files.push({ path: relativePath, mode: metadata.mode & 0o777, content });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (files.length === 1 && files[0]!.path === "SKILL.md") {
    return createHash("sha256").update(files[0]!.content).digest("hex");
  }
  const hash = createHash("sha256").update("homeagent-skill-bundle-v1\0");
  for (const file of files) {
    hash.update(`${Buffer.byteLength(file.path)}:${file.path}\0${file.mode}\0${file.content.length}\0`);
    hash.update(file.content);
  }
  return hash.digest("hex");
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

  resolve(bindings: readonly SkillBindingRequest[], provider: ProviderId): ResolvedAgentSkills {
    const snapshot = this.current();
    const byKey = new Map(snapshot.sources.map((source) => [source.sourceKey, source]));
    const requested = bindings.map((binding): SkillRequestSnapshot => ({
      kind: "source",
      sourceKey: binding.sourceKey,
      name: binding.name,
    }));
    const resolved: ResolvedSkillSnapshot[] = [];
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
        bundleHash = hashSkillBundle(
          resolvedSource.skillFile,
          this.maxEntries,
          this.maxTotalBytes,
        );
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
    }
    return {
      requested,
      resolved,
      skipped,
      warnings: skipped.map((item) => ({ ...item })),
    };
  }
}
