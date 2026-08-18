/**
 * Agent store (management backend, mew-style Agents page). An "agent" is a
 * named persona + provider CLI + model the bot uses to answer and execute
 * research tasks in a space.
 *
 * Active fields: name, instruction (persona), provider (local CLI), model,
 * Codex reasoning effort, visibility, and task execution controls.
 * Task permission is consumed only by explicit research tasks; Workdir also
 * anchors ordinary Codex calls as read-only context. Ordinary calls receive no
 * ProviderExecution grant. Claude disables tools; Codex stays ephemeral and
 * read-only; TRAE remains task-only.
 *
 * Agents are persisted to data/config/agents.json using the same whole-file
 * JSON pattern as the space registry (registry.ts). The markdown/DB knowledge is
 * unaffected; this is lightweight operational config.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  CodexReasoningEffort,
  ProviderExecution,
  ProviderExecutionPermission,
  ProviderId,
} from "@homeagent/llm";
import {
  CODEX_REASONING_EFFORTS,
  DEFAULT_CLI_PROVIDER,
  isCliProvider,
  isCodexReasoningEffortSupported,
  normalizeProviderSkills,
} from "@homeagent/llm";
import { canonicalModelId, logger, type SpaceId } from "@homeagent/shared";
import { durableFsyncSync, durableRenameSync } from "./durable-file.ts";
import {
  isAgentRevisionId,
  MAX_EXECUTION_PLAN_INSTRUCTION_CHARACTERS,
  MAX_EXECUTION_PLAN_MODEL_CHARACTERS,
  MAX_EXECUTION_PLAN_WORKDIR_CHARACTERS,
} from "./execution-plan.ts";

const log = logger.child("agents");

/** Task-execution permission tier enforced by each local CLI provider. */
export type AgentPermission = ProviderExecutionPermission;
export const AGENT_PERMISSIONS: AgentPermission[] = ["read-only", "write", "full"];
export type AgentVisibility = "Team" | "Personal";
export const AGENT_VISIBILITIES: AgentVisibility[] = ["Team", "Personal"];

export type AgentExecution = ProviderExecution;

export interface SourceSkillBinding {
  kind: "source";
  sourceKey: string;
  name: string;
}

export interface LegacySkillBinding {
  kind: "legacy-name";
  name: string;
}

export type AgentSkillBinding = SourceSkillBinding | LegacySkillBinding;

/** A configurable answering persona. `model` empty => fall back to global default. */
export interface Agent {
  id: string;
  name: string;
  /** persona / extra system prompt injected into ask() */
  instruction: string;
  /** model id; empty string means "use the global default model" */
  model: string;
  /** Codex reasoning effort; empty string means "inherit the Codex default". */
  reasoningEffort: CodexReasoningEffort | "";
  /** local agent CLI to run (claude / codex / trae-cli) */
  provider: ProviderId;
  /** Space type this Agent may be assigned to. */
  visibility: AgentVisibility;
  /** Task execution directory. Write/full permissions require it. */
  workdir?: string;
  /** Task execution permission tier. */
  permission: AgentPermission;
  /** Exact local Skill sources selected for this Agent, plus unresolved legacy names. */
  skills: AgentSkillBinding[];
  /** Immutable revision currently used by get()/list() and runtime calls. */
  publishedRevisionId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRevisionSnapshot {
  name: string;
  instruction: string;
  model: string;
  reasoningEffort: CodexReasoningEffort | "";
  provider: ProviderId;
  visibility: AgentVisibility;
  workdir?: string;
  permission: AgentPermission;
  skills: AgentSkillBinding[];
}

export type AgentRevisionSource =
  | "create"
  | "migration"
  | "restore"
  | "draft"
  | "release"
  | "update"
  | "rollback";

/** An append-only snapshot of every saved or published Agent configuration. */
export interface AgentRevision {
  id: string;
  agentId: string;
  number: number;
  source: AgentRevisionSource;
  basedOnRevisionId?: string;
  createdAt: number;
  snapshot: AgentRevisionSnapshot;
}

/** Fields a caller may set when creating/updating an agent. */
export interface AgentInput {
  name?: string;
  instruction?: string;
  model?: string;
  reasoningEffort?: string;
  provider?: string;
  visibility?: string;
  workdir?: string;
  permission?: string;
  /** Source-bound Skills. String values are accepted only for legacy callers. */
  skills?: AgentSkillBinding[] | string | string[];
}

interface AgentsFileV4 {
  version: 4;
  agents: Record<string, Agent>;
  revisions: Record<string, AgentRevision[]>;
}

interface AgentStoreState {
  agents: Map<string, Agent>;
  revisions: Map<string, AgentRevision[]>;
}

export interface AgentStoreOptions {
  resolveLegacySkill?: (
    name: string,
    provider: ProviderId,
  ) => SourceSkillBinding | undefined;
  validateSourceSkill?: (
    binding: SourceSkillBinding,
    provider: ProviderId,
  ) => boolean;
}

/** Normalize a free-text provider into a valid CLI id; unknown => default CLI. */
function normalizeProvider(raw?: string): ProviderId {
  const v = raw?.trim();
  if (v && isCliProvider(v)) return v;
  return DEFAULT_CLI_PROVIDER;
}

/** Normalize a permission value; unknown/empty => read-only (safest default). */
function normalizePermission(raw?: unknown): AgentPermission {
  const v = typeof raw === "string"
    ? raw.trim() as AgentPermission
    : undefined;
  return v && AGENT_PERMISSIONS.includes(v) ? v : "read-only";
}

function normalizeVisibility(raw?: unknown): AgentVisibility {
  const value = typeof raw === "string"
    ? raw.trim() as AgentVisibility
    : undefined;
  return value && AGENT_VISIBILITIES.includes(value) ? value : "Team";
}

/** Normalize a Codex reasoning level; unknown/empty => inherit the CLI default. */
function normalizeReasoningEffort(raw: string | undefined, model: string): CodexReasoningEffort | "" {
  const value = raw?.trim() as CodexReasoningEffort | undefined;
  if (!value) return "";
  if (!model) return CODEX_REASONING_EFFORTS.includes(value) ? value : "";
  return isCodexReasoningEffortSupported(model, value) ? value : "";
}

/** Store the explicit GPT-5.6 Sol id instead of its shorter routing alias. */
function normalizeModel(raw?: string): string {
  return canonicalModelId(raw ?? "");
}

export function isAgentSkillSourceKey(value: string): boolean {
  return value.length <= 600
    && /^(?:shared-agents|codex-user|codex-plugin|codex-vendor|claude-user|claude-plugin|claude-marketplace|trae-user):[^\u0000-\u001f\\]+$/u.test(
      value,
    );
}

export function isAgentSkillName(value: string): boolean {
  return normalizeProviderSkills([value])[0] === value;
}

/** Normalize persisted bindings while preserving unresolved legacy names. */
function normalizeSkills(
  raw?: AgentSkillBinding[] | string | string[],
): AgentSkillBinding[] {
  const parts: unknown[] = typeof raw === "string"
    ? raw.split(/[,\n]/)
    : Array.isArray(raw) ? raw : [];
  const bindings: AgentSkillBinding[] = [];
  const seenSources = new Set<string>();
  const seenLegacyNames = new Set<string>();
  for (const part of parts) {
    if (typeof part === "string") {
      const name = normalizeProviderSkills([part])[0];
      if (!name || seenLegacyNames.has(name)) continue;
      seenLegacyNames.add(name);
      bindings.push({ kind: "legacy-name", name });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const candidate = part as Partial<AgentSkillBinding> & { sourceKey?: unknown };
    const name = normalizeProviderSkills([candidate.name])[0];
    if (!name) continue;
    if (candidate.kind === "legacy-name") {
      if (seenLegacyNames.has(name)) continue;
      seenLegacyNames.add(name);
      bindings.push({ kind: "legacy-name", name });
      continue;
    }
    if (
      candidate.kind === "source"
      && typeof candidate.sourceKey === "string"
      && isAgentSkillSourceKey(candidate.sourceKey)
      && !seenSources.has(candidate.sourceKey)
    ) {
      seenSources.add(candidate.sourceKey);
      bindings.push({ kind: "source", sourceKey: candidate.sourceKey, name });
    }
  }
  return bindings;
}

const MAX_AGENT_SKILLS = 50;
export const MAX_AGENT_REVISION_HISTORY = 10_000;
const DEFAULT_AGENT_NAME = "未命名 Agent";

class UnsupportedAgentConfigVersionError extends Error {
  constructor(readonly version: number) {
    super(`Unsupported Agent config version: ${version}`);
    this.name = "UnsupportedAgentConfigVersionError";
  }
}

function isPersistedSkillBindings(value: unknown): value is AgentSkillBinding[] {
  if (!Array.isArray(value) || value.length > MAX_AGENT_SKILLS) return false;
  if (!value.every((binding) => {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      return false;
    }
    const candidate = binding as Partial<AgentSkillBinding> & {
      sourceKey?: unknown;
    };
    if (candidate.kind === "legacy-name") {
      return typeof candidate.name === "string"
        && isAgentSkillName(candidate.name);
    }
    return candidate.kind === "source"
      && typeof candidate.name === "string"
      && isAgentSkillName(candidate.name)
      && typeof candidate.sourceKey === "string"
      && isAgentSkillSourceKey(candidate.sourceKey);
  })) {
    return false;
  }
  return JSON.stringify(normalizeSkills(value)) === JSON.stringify(value);
}

function isCurrentAgentRecord(value: unknown, id: string): value is Agent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<Agent>;
  return candidate.id === id
    && typeof candidate.name === "string"
    && candidate.name.trim().length > 0
    && candidate.name.trim() === candidate.name
    && typeof candidate.instruction === "string"
    && candidate.instruction.length <= MAX_EXECUTION_PLAN_INSTRUCTION_CHARACTERS
    && typeof candidate.model === "string"
    && candidate.model.length <= MAX_EXECUTION_PLAN_MODEL_CHARACTERS
    && normalizeModel(candidate.model) === candidate.model
    && typeof candidate.provider === "string"
    && isCliProvider(candidate.provider)
    && typeof candidate.reasoningEffort === "string"
    && normalizeReasoningEffort(candidate.reasoningEffort, candidate.model)
      === candidate.reasoningEffort
    && typeof candidate.visibility === "string"
    && AGENT_VISIBILITIES.includes(candidate.visibility as AgentVisibility)
    && (candidate.workdir === undefined || (
      typeof candidate.workdir === "string"
      && candidate.workdir.trim() === candidate.workdir
      && candidate.workdir.length > 0
      && candidate.workdir.length <= MAX_EXECUTION_PLAN_WORKDIR_CHARACTERS
    ))
    && typeof candidate.permission === "string"
    && AGENT_PERMISSIONS.includes(candidate.permission as AgentPermission)
    && isPersistedSkillBindings(candidate.skills)
    && (candidate.publishedRevisionId === undefined
      || isAgentRevisionId(candidate.publishedRevisionId))
    && typeof candidate.createdAt === "number"
    && Number.isFinite(candidate.createdAt)
    && typeof candidate.updatedAt === "number"
    && Number.isFinite(candidate.updatedAt)
    && candidate.updatedAt >= candidate.createdAt;
}

function assertAgentInputFitsExecutionPlan(input: AgentInput): void {
  if (
    input.instruction !== undefined
    && input.instruction.length > MAX_EXECUTION_PLAN_INSTRUCTION_CHARACTERS
  ) {
    throw new Error(
      `Agent instruction exceeds ${MAX_EXECUTION_PLAN_INSTRUCTION_CHARACTERS} characters`,
    );
  }
  if (
    input.model !== undefined
    && normalizeModel(input.model).length > MAX_EXECUTION_PLAN_MODEL_CHARACTERS
  ) {
    throw new Error(`Agent model exceeds ${MAX_EXECUTION_PLAN_MODEL_CHARACTERS} characters`);
  }
  if (
    input.workdir !== undefined
    && input.workdir.trim().length > MAX_EXECUTION_PLAN_WORKDIR_CHARACTERS
  ) {
    throw new Error(
      `Agent workdir exceeds ${MAX_EXECUTION_PLAN_WORKDIR_CHARACTERS} characters`,
    );
  }
}

function normalizeAgentForPersistence(agent: Agent): Agent {
  if (
    typeof agent.id !== "string"
    || agent.id.length === 0
    || typeof agent.name !== "string"
    || typeof agent.instruction !== "string"
    || typeof agent.model !== "string"
    || typeof agent.reasoningEffort !== "string"
    || typeof agent.provider !== "string"
    || typeof agent.visibility !== "string"
    || (agent.workdir !== undefined && typeof agent.workdir !== "string")
    || typeof agent.permission !== "string"
    || !Array.isArray(agent.skills)
    || typeof agent.createdAt !== "number"
    || !Number.isFinite(agent.createdAt)
    || typeof agent.updatedAt !== "number"
    || !Number.isFinite(agent.updatedAt)
  ) {
    throw new Error(`Invalid Agent config entry: ${String(agent.id)}`);
  }
  const model = normalizeModel(agent.model);
  const normalized: Agent = {
    ...agent,
    name: agent.name.trim() || DEFAULT_AGENT_NAME,
    model,
    reasoningEffort: normalizeReasoningEffort(agent.reasoningEffort, model),
    provider: normalizeProvider(agent.provider),
    visibility: normalizeVisibility(agent.visibility),
    workdir: agent.workdir?.trim() || undefined,
    permission: normalizePermission(agent.permission),
    skills: normalizeSkills(agent.skills).slice(0, MAX_AGENT_SKILLS),
    updatedAt: Math.max(agent.updatedAt, agent.createdAt),
  };
  const normalizedId = normalized.id;
  if (!isCurrentAgentRecord(normalized, normalizedId)) {
    throw new Error(`Invalid Agent config entry: ${normalizedId}`);
  }
  return normalized;
}

function cloneAgent(agent: Agent): Agent {
  return {
    ...agent,
    skills: agent.skills.map((binding) => ({ ...binding })),
  };
}

function cloneRevisionSnapshot(snapshot: AgentRevisionSnapshot): AgentRevisionSnapshot {
  return {
    ...snapshot,
    skills: snapshot.skills.map((binding) => ({ ...binding })),
  };
}

function cloneRevision(revision: AgentRevision): AgentRevision {
  return {
    ...revision,
    snapshot: cloneRevisionSnapshot(revision.snapshot),
  };
}

function snapshotFromAgent(agent: Agent): AgentRevisionSnapshot {
  return {
    name: agent.name,
    instruction: agent.instruction,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
    provider: agent.provider,
    visibility: agent.visibility,
    workdir: agent.workdir,
    permission: agent.permission,
    skills: agent.skills.map((binding) => ({ ...binding })),
  };
}

/** Compare a legacy archive Agent before revision ids existed. */
export function sameLegacyAgentSnapshot(left: Agent, right: Agent): boolean {
  return left.id === right.id
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
    && JSON.stringify(snapshotFromAgent(left)) === JSON.stringify(snapshotFromAgent(right));
}

function legacyRestoreRevisionId(agent: Agent): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      id: agent.id,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      snapshot: snapshotFromAgent(agent),
    }))
    .digest("hex");
  return `agent_revision_legacy-${digest}`;
}

function materializeRevision(
  identity: Pick<Agent, "id" | "createdAt">,
  revision: AgentRevision,
): Agent {
  return {
    id: identity.id,
    ...cloneRevisionSnapshot(revision.snapshot),
    publishedRevisionId: revision.id,
    createdAt: identity.createdAt,
    updatedAt: Math.max(identity.createdAt, revision.createdAt),
  };
}

/** Upgrade a pre-revision Agent into a deterministic, current restore snapshot. */
export function materializeLegacyAgentRevisionHistory(agent: Agent): {
  agent: Agent;
  revisions: AgentRevision[];
} {
  const normalized = normalizeAgentForPersistence(cloneAgent(agent));
  const revision: AgentRevision = {
    id: normalized.publishedRevisionId || legacyRestoreRevisionId(normalized),
    agentId: normalized.id,
    number: 1,
    source: "restore",
    createdAt: Math.max(normalized.createdAt, normalized.updatedAt),
    snapshot: snapshotFromAgent(normalized),
  };
  return {
    agent: materializeRevision(normalized, revision),
    revisions: [revision],
  };
}

/** True only for the exact deterministic history synthesized for a legacy Agent. */
export function isMaterializedLegacyAgentRevisionHistory(
  agent: Agent,
  revisions: AgentRevision[],
): boolean {
  try {
    const expected = materializeLegacyAgentRevisionHistory({
      ...cloneAgent(agent),
      publishedRevisionId: undefined,
    });
    return JSON.stringify(agent) === JSON.stringify(expected.agent)
      && JSON.stringify(revisions) === JSON.stringify(expected.revisions);
  } catch {
    return false;
  }
}

export function isAgentRevision(value: unknown, agent: Agent): value is AgentRevision {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const revision = value as Partial<AgentRevision>;
  if (
    !isAgentRevisionId(revision.id)
    || revision.agentId !== agent.id
    || typeof revision.number !== "number"
    || !Number.isSafeInteger(revision.number)
    || revision.number < 1
    || ![
      "create",
      "migration",
      "restore",
      "draft",
      "release",
      "update",
      "rollback",
    ].includes(String(revision.source))
    || (revision.basedOnRevisionId !== undefined
      && !isAgentRevisionId(revision.basedOnRevisionId))
    || typeof revision.createdAt !== "number"
    || !Number.isFinite(revision.createdAt)
    || !revision.snapshot
    || typeof revision.snapshot !== "object"
    || Array.isArray(revision.snapshot)
  ) {
    return false;
  }
  const materialized: Agent = {
    id: agent.id,
    ...(revision.snapshot as AgentRevisionSnapshot),
    publishedRevisionId: revision.id,
    createdAt: agent.createdAt,
    updatedAt: Math.max(agent.createdAt, revision.createdAt),
  };
  return isCurrentAgentRecord(materialized, agent.id)
    && JSON.stringify(snapshotFromAgent(materialized))
      === JSON.stringify(revision.snapshot);
}

/**
 * Enforce the complete v4 lifecycle invariant before revisions cross a durable
 * boundary. Archives call the same validator as AgentStore load/restore so a
 * successful import can never create a config that fails on the next restart.
 */
export function assertAgentRevisionHistory(
  agent: Agent,
  history: AgentRevision[],
  label = `Agent revision history: ${agent.id}`,
): void {
  if (!agent.publishedRevisionId || history.length === 0) {
    throw new Error(`${label}: published revision history is missing`);
  }
  if (history.length > MAX_AGENT_REVISION_HISTORY) {
    throw new Error(`${label}: exceeds ${MAX_AGENT_REVISION_HISTORY} revisions`);
  }
  const revisionsById = new Map<string, AgentRevision>();
  for (let index = 0; index < history.length; index += 1) {
    const revision = history[index];
    if (
      !revision
      || !isAgentRevision(revision, agent)
      || revision.number !== history.length - index
      || revisionsById.has(revision.id)
    ) {
      throw new Error(`${label}: revision ordering is invalid`);
    }
    revisionsById.set(revision.id, revision);
  }
  for (const revision of history) {
    const ancestor = revision.basedOnRevisionId
      ? revisionsById.get(revision.basedOnRevisionId)
      : undefined;
    if (revision.basedOnRevisionId && (!ancestor || ancestor.number >= revision.number)) {
      throw new Error(`${label}: revision ancestry must reference an older revision`);
    }
  }
  const published = revisionsById.get(agent.publishedRevisionId);
  if (!published) throw new Error(`${label}: published revision is missing`);
  if (published.source === "draft") {
    throw new Error(`${label}: published revision cannot be a draft`);
  }
  if (JSON.stringify(snapshotFromAgent(agent)) !== JSON.stringify(published.snapshot)) {
    throw new Error(`${label}: published revision does not match materialized Agent`);
  }
  if (agent.updatedAt !== Math.max(agent.createdAt, published.createdAt)) {
    throw new Error(`${label}: Agent updatedAt does not match materialized published revision`);
  }
}

function resolveWorkdir(raw: string): string {
  let expanded = raw;
  if (raw === "~") expanded = homedir();
  else if (raw.startsWith("~/")) expanded = join(homedir(), raw.slice(2));
  else if (raw.startsWith("~")) throw new Error("Workdir 只支持当前用户的 ~/ 路径");
  if (!existsSync(expanded)) throw new Error(`Workdir 不存在：${raw}`);
  const resolved = realpathSync(expanded);
  if (!statSync(resolved).isDirectory()) throw new Error(`Workdir 不是目录：${raw}`);
  return resolved;
}

/** Resolve an Agent's configured directory for ordinary read-only context. */
export function resolveAgentWorkdir(agent?: Agent): string | undefined {
  return agent?.workdir ? resolveWorkdir(agent.workdir) : undefined;
}

/** Resolve the task-only execution contract before a provider process starts. */
export function resolveAgentExecution(agent?: Agent): AgentExecution {
  const permission = agent?.permission ?? "read-only";
  const workdir = resolveAgentWorkdir(agent);
  if (permission !== "read-only" && !workdir) {
    throw new Error(`Agent 的 ${permission} 权限必须配置 Workdir`);
  }
  return {
    permission,
    workdir,
    skills: [],
  };
}

export class AgentStore {
  private configPath: string;
  private backupPath: string;
  private agents: Map<string, Agent>;
  private revisions: Map<string, AgentRevision[]>;
  private readonly resolveLegacySkill?: AgentStoreOptions["resolveLegacySkill"];
  private readonly validateSourceSkill?: AgentStoreOptions["validateSourceSkill"];

  constructor(dataDir: string, options: AgentStoreOptions = {}) {
    this.configPath = join(dataDir, "config", "agents.json");
    this.backupPath = `${this.configPath}.bak`;
    this.resolveLegacySkill = options.resolveLegacySkill;
    this.validateSourceSkill = options.validateSourceSkill;
    const loaded = this.load();
    this.agents = loaded.agents;
    this.revisions = loaded.revisions;
  }

  private normalizeInputSkills(
    raw: AgentInput["skills"],
    provider: ProviderId,
  ): AgentSkillBinding[] {
    if (Array.isArray(raw)) {
      for (const candidate of raw) {
        if (typeof candidate === "string") continue;
        if (!candidate || typeof candidate !== "object") {
          throw new Error("Skill binding is invalid");
        }
        if (
          candidate.kind === "source"
          && (
            typeof candidate.sourceKey !== "string"
            || !isAgentSkillSourceKey(candidate.sourceKey)
            || !isAgentSkillName(candidate.name)
          )
        ) {
          throw new Error("Skill source binding is invalid");
        }
        if (
          candidate.kind === "legacy-name"
          && !isAgentSkillName(candidate.name)
        ) {
          throw new Error("Legacy Skill binding is invalid");
        }
        if (candidate.kind !== "source" && candidate.kind !== "legacy-name") {
          throw new Error("Skill binding is invalid");
        }
      }
    }
    const bindings = normalizeSkills(raw);
    if (bindings.length > MAX_AGENT_SKILLS) {
      throw new Error(`An Agent can bind at most ${MAX_AGENT_SKILLS} Skills`);
    }
    if (this.validateSourceSkill) {
      for (const binding of bindings) {
        if (
          binding.kind === "source"
          && !this.validateSourceSkill(binding, provider)
        ) {
          throw new Error(`Skill source is unavailable: ${binding.name}`);
        }
      }
    }
    return bindings;
  }

  private read(path: string): AgentStoreState & { migrated: boolean } {
    const agents = new Map<string, Agent>();
    const revisions = new Map<string, AgentRevision[]>();
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      !parsed
      || typeof parsed !== "object"
      || Array.isArray(parsed)
    ) {
      throw new Error(`Invalid Agent config schema: ${path}`);
    }
    const rawVersion = (parsed as { version?: unknown }).version;
    if (
      typeof rawVersion === "number"
      && Number.isInteger(rawVersion)
      && rawVersion > 4
    ) {
      throw new UnsupportedAgentConfigVersionError(rawVersion);
    }
    if (
      rawVersion !== undefined
      && rawVersion !== 1
      && rawVersion !== 2
      && rawVersion !== 3
      && rawVersion !== 4
    ) {
      throw new Error(`Invalid Agent config schema: ${path}`);
    }
    if (
      !("agents" in parsed)
      || !parsed.agents
      || typeof parsed.agents !== "object"
      || Array.isArray(parsed.agents)
    ) {
      throw new Error(`Invalid Agent config schema: ${path}`);
    }
    if (rawVersion === 4) {
      if (
        !("revisions" in parsed)
        || !parsed.revisions
        || typeof parsed.revisions !== "object"
        || Array.isArray(parsed.revisions)
      ) {
        throw new Error(`Invalid Agent revision schema: ${path}`);
      }
      const revisionTable = parsed.revisions as Record<string, unknown>;
      for (const [id, value] of Object.entries(parsed.agents as Record<string, unknown>)) {
        if (!isCurrentAgentRecord(value, id) || !value.publishedRevisionId) {
          throw new Error(`Invalid Agent config entry: ${path}#${id}`);
        }
        const agent = cloneAgent(value);
        const rawRevisions = revisionTable[id];
        if (
          !Array.isArray(rawRevisions)
          || rawRevisions.length === 0
          || rawRevisions.length > MAX_AGENT_REVISION_HISTORY
        ) {
          throw new Error(`Invalid Agent revisions: ${path}#${id}`);
        }
        const history = rawRevisions.map((revision) => {
          if (!isAgentRevision(revision, agent)) {
            throw new Error(`Invalid Agent revision: ${path}#${id}`);
          }
          return cloneRevision(revision);
        });
        assertAgentRevisionHistory(agent, history, `Invalid Agent revisions: ${path}#${id}`);
        agents.set(id, agent);
        revisions.set(id, history);
      }
      for (const id of Object.keys(revisionTable)) {
        if (!agents.has(id)) throw new Error(`Orphan Agent revisions: ${path}#${id}`);
      }
      return { agents, revisions, migrated: false };
    }

    const legacyAgentSchema = rawVersion !== 3;
    let migrated = true;
    for (const [id, value] of Object.entries(parsed.agents as Record<string, unknown>)) {
      const candidate = value as Partial<Agent> | null;
      if (
        legacyAgentSchema
          ? !candidate
            || typeof candidate !== "object"
            || Array.isArray(candidate)
            || candidate.id !== id
            || typeof candidate.name !== "string"
            || typeof candidate.instruction !== "string"
            || (candidate.model !== undefined && typeof candidate.model !== "string")
            || (candidate.provider !== undefined && typeof candidate.provider !== "string")
            || (candidate.reasoningEffort !== undefined
              && typeof candidate.reasoningEffort !== "string")
            || (candidate.visibility !== undefined && typeof candidate.visibility !== "string")
            || (candidate.workdir !== undefined && typeof candidate.workdir !== "string")
            || (candidate.permission !== undefined && typeof candidate.permission !== "string")
            || (candidate.skills !== undefined
              && typeof candidate.skills !== "string"
              && !Array.isArray(candidate.skills))
            || typeof candidate.createdAt !== "number"
            || !Number.isFinite(candidate.createdAt)
            || typeof candidate.updatedAt !== "number"
            || !Number.isFinite(candidate.updatedAt)
          : !isCurrentAgentRecord(candidate, id)
      ) {
        throw new Error(`Invalid Agent config entry: ${path}#${id}`);
      }
      const a = { ...candidate } as Agent;
      // Migrate older files: unknown/legacy providers (e.g. "gateway",
      // which is no longer selectable) normalize to the default CLI.
      const normalized = normalizeProvider(a.provider as string | undefined);
      if (normalized !== a.provider) migrated = true;
      a.provider = normalized;
      const model = normalizeModel(a.model);
      if (model !== a.model) migrated = true;
      a.model = model;
      const visibility = normalizeVisibility(a.visibility);
      if (visibility !== a.visibility) migrated = true;
      a.visibility = visibility;
      // Backfill and constrain task-execution fields for older records.
      const permission = normalizePermission(a.permission);
      if (permission !== a.permission) migrated = true;
      a.permission = permission;
      let skills = normalizeSkills(
        a.skills as unknown as AgentSkillBinding[] | string | string[] | undefined,
      ).slice(0, MAX_AGENT_SKILLS);
      if (legacyAgentSchema && this.resolveLegacySkill) {
        skills = skills.map((binding) => {
          if (binding.kind !== "legacy-name") return binding;
          try {
            return this.resolveLegacySkill?.(binding.name, normalized) ?? binding;
          } catch {
            return binding;
          }
        });
      }
      if (JSON.stringify(skills) !== JSON.stringify(a.skills)) migrated = true;
      a.skills = skills;
      const reasoningEffort = normalizeReasoningEffort(a.reasoningEffort, a.model);
      if (reasoningEffort !== a.reasoningEffort) migrated = true;
      a.reasoningEffort = reasoningEffort;
      const persisted = normalizeAgentForPersistence(a);
      const revision: AgentRevision = {
        id: `agent_revision_${randomUUID()}`,
        agentId: id,
        number: 1,
        source: "migration",
        createdAt: persisted.updatedAt,
        snapshot: snapshotFromAgent(persisted),
      };
      const published = materializeRevision(persisted, revision);
      agents.set(id, published);
      revisions.set(id, [revision]);
    }
    return { agents, revisions, migrated };
  }

  private load(): AgentStoreState {
    if (!existsSync(this.configPath) && !existsSync(this.backupPath)) {
      return { agents: new Map(), revisions: new Map() };
    }
    let loaded: AgentStoreState & { migrated: boolean };
    let recovered = false;
    try {
      if (!existsSync(this.configPath)) {
        throw new Error(`Agent config is missing: ${this.configPath}`);
      }
      loaded = this.read(this.configPath);
    } catch (primaryError) {
      if (primaryError instanceof UnsupportedAgentConfigVersionError) {
        throw primaryError;
      }
      if (!existsSync(this.backupPath)) {
        throw new Error(
          `Failed to load Agent config and no backup is available: ${this.configPath}. ${String(primaryError)}`,
        );
      }
      try {
        loaded = this.read(this.backupPath);
        recovered = true;
      } catch (backupError) {
        throw new Error(
          `Failed to load Agent config and backup: ${this.configPath}. Primary: ${String(primaryError)}. Backup: ${String(backupError)}`,
        );
      }
    }
    // Rewrite once so the on-disk file reflects a migration or recovery.
    if (loaded.migrated || recovered) {
      this.persist(loaded.agents, loaded.revisions);
    } else {
      this.ensureRecoveryCopy(loaded.agents, loaded.revisions);
    }
    return { agents: loaded.agents, revisions: loaded.revisions };
  }

  private writeAtomic(path: string, contents: string): void {
    const configDir = dirname(path);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let committed = false;
    try {
      writeFileSync(temporaryPath, contents, {
        encoding: "utf8",
        mode: 0o600,
      });
      const fileDescriptor = openSync(temporaryPath, "r+");
      try {
        durableFsyncSync(fileDescriptor);
      } finally {
        closeSync(fileDescriptor);
      }
      durableRenameSync(temporaryPath, path);
      committed = true;
      try {
        const directoryDescriptor = openSync(configDir, "r");
        try {
          durableFsyncSync(directoryDescriptor, {
            allowUnsupportedDirectoryOnWindows: true,
          });
        } finally {
          closeSync(directoryDescriptor);
        }
      } catch (error) {
        // The rename is the logical commit point. A later directory-flush
        // failure degrades crash durability but must not roll memory back to a
        // value that no longer matches the visible primary file.
        log.warn("Agent config directory sync failed after commit", {
          path,
          err: String(error),
        });
      }
    } finally {
      if (existsSync(temporaryPath)) {
        try {
          unlinkSync(temporaryPath);
        } catch (error) {
          if (!committed) throw error;
          log.warn("Agent temporary file cleanup failed after commit", {
            path: temporaryPath,
            err: String(error),
          });
        }
      }
    }
  }

  private serialize(
    agents: Map<string, Agent>,
    revisions: Map<string, AgentRevision[]>,
  ): string {
    const file: AgentsFileV4 = {
      version: 4,
      agents: Object.fromEntries(agents),
      revisions: Object.fromEntries(revisions),
    };
    return JSON.stringify(file, null, 2);
  }

  private ensureRecoveryCopy(
    agents: Map<string, Agent>,
    revisions: Map<string, AgentRevision[]>,
  ): void {
    const contents = this.serialize(agents, revisions);
    let current = false;
    if (existsSync(this.backupPath)) {
      try {
        const backup = this.read(this.backupPath);
        current = !backup.migrated
          && readFileSync(this.backupPath, "utf8") === contents;
      } catch {
        current = false;
      }
    }
    if (current) return;
    try {
      this.writeAtomic(this.backupPath, contents);
    } catch (error) {
      log.warn("Agent recovery copy repair failed", {
        path: this.backupPath,
        err: String(error),
      });
    }
  }

  private persist(
    agents = this.agents,
    revisions = this.revisions,
  ): void {
    mkdirSync(dirname(this.configPath), { recursive: true, mode: 0o700 });
    const contents = this.serialize(agents, revisions);
    this.writeAtomic(this.configPath, contents);
    try {
      // The primary rename is the commit point. Refresh recovery only after it
      // succeeds so a failed mutation can never be resurrected from `.bak`.
      this.writeAtomic(this.backupPath, contents);
    } catch (error) {
      // The primary is already committed, so rolling back memory here would
      // create a disk/memory split. Keep the operation successful and surface
      // the degraded recovery copy for operators.
      log.warn("Agent backup refresh failed after primary commit", {
        path: this.backupPath,
        err: String(error),
      });
    }
  }

  private commit<T>(
    change: (
      candidateAgents: Map<string, Agent>,
      candidateRevisions: Map<string, AgentRevision[]>,
    ) => T,
  ): T {
    const candidateAgents = new Map(
      [...this.agents].map(([id, agent]) => [id, cloneAgent(agent)]),
    );
    const candidateRevisions = new Map(
      [...this.revisions].map(([id, history]) => [
        id,
        history.map(cloneRevision),
      ]),
    );
    const result = change(candidateAgents, candidateRevisions);
    for (const [id, agent] of candidateAgents) {
      candidateAgents.set(id, normalizeAgentForPersistence(agent));
    }
    this.persist(candidateAgents, candidateRevisions);
    this.agents = candidateAgents;
    this.revisions = candidateRevisions;
    return result;
  }

  list(): Agent[] {
    return [...this.agents.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(cloneAgent);
  }

  get(id: string): Agent | undefined {
    const agent = this.agents.get(id);
    return agent ? cloneAgent(agent) : undefined;
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  listRevisions(id: string): AgentRevision[] {
    return (this.revisions.get(id) ?? []).map(cloneRevision);
  }

  /** Return only an unpublished draft; published heads are not drafts. */
  getDraft(id: string): AgentRevision | undefined {
    const agent = this.agents.get(id);
    const latest = this.revisions.get(id)?.[0];
    return latest && latest.id !== agent?.publishedRevisionId && latest.source === "draft"
      ? cloneRevision(latest)
      : undefined;
  }

  private patchAgent(base: Agent, input: AgentInput): Agent {
    assertAgentInputFitsExecutionPlan(input);
    const agent = cloneAgent(base);
    if (input.name !== undefined) agent.name = input.name.trim() || agent.name;
    if (input.instruction !== undefined) agent.instruction = input.instruction;
    if (input.model !== undefined) agent.model = normalizeModel(input.model);
    if (input.reasoningEffort !== undefined) {
      agent.reasoningEffort = normalizeReasoningEffort(input.reasoningEffort, agent.model);
    } else if (input.model !== undefined) {
      agent.reasoningEffort = normalizeReasoningEffort(agent.reasoningEffort, agent.model);
    }
    if (input.provider !== undefined) agent.provider = normalizeProvider(input.provider);
    if (input.visibility !== undefined) agent.visibility = normalizeVisibility(input.visibility);
    if (input.workdir !== undefined) agent.workdir = input.workdir.trim() || undefined;
    if (input.permission !== undefined) agent.permission = normalizePermission(input.permission);
    if (input.skills !== undefined) {
      agent.skills = this.normalizeInputSkills(input.skills, agent.provider);
    }
    return normalizeAgentForPersistence(agent);
  }

  private nextRevision(
    agent: Agent,
    history: AgentRevision[],
    snapshot: AgentRevisionSnapshot,
    source: AgentRevisionSource,
    basedOnRevisionId?: string,
    revisionId = `agent_revision_${randomUUID()}`,
  ): AgentRevision {
    if (history.length >= MAX_AGENT_REVISION_HISTORY) {
      throw new Error(`Agent revision history exceeds ${MAX_AGENT_REVISION_HISTORY}: ${agent.id}`);
    }
    return {
      id: revisionId,
      agentId: agent.id,
      number: history.length + 1,
      source,
      basedOnRevisionId,
      createdAt: Math.max(Date.now(), agent.createdAt, history[0]?.createdAt ?? agent.createdAt),
      snapshot: cloneRevisionSnapshot(snapshot),
    };
  }

  private assertExpectedHead(
    history: AgentRevision[],
    expectedHeadRevisionId?: string,
  ): void {
    if (
      expectedHeadRevisionId !== undefined
      && history[0]?.id !== expectedHeadRevisionId
    ) {
      throw new Error("Agent 版本已变化，请刷新后重试");
    }
  }

  create(input: AgentInput): Agent {
    assertAgentInputFitsExecutionPlan(input);
    const now = Date.now();
    const model = normalizeModel(input.model);
    const provider = normalizeProvider(input.provider);
    const identity: Agent = {
      id: `agent_${randomUUID()}`,
      name: input.name?.trim() || DEFAULT_AGENT_NAME,
      instruction: input.instruction ?? "",
      model,
      reasoningEffort: normalizeReasoningEffort(input.reasoningEffort, model),
      provider,
      visibility: normalizeVisibility(input.visibility),
      workdir: input.workdir?.trim() || undefined,
      permission: normalizePermission(input.permission),
      skills: this.normalizeInputSkills(input.skills, provider),
      createdAt: now,
      updatedAt: now,
    };
    const revision = this.nextRevision(
      identity,
      [],
      snapshotFromAgent(identity),
      "create",
    );
    const agent = materializeRevision(identity, revision);
    this.commit((candidateAgents, candidateRevisions) => {
      candidateAgents.set(agent.id, agent);
      candidateRevisions.set(agent.id, [revision]);
    });
    return cloneAgent(agent);
  }

  /** Compatibility path: patch and publish one immutable update revision. */
  update(id: string, input: AgentInput): Agent | undefined {
    const current = this.agents.get(id);
    if (!current) return undefined;
    const history = this.revisions.get(id) ?? [];
    const patched = this.patchAgent(current, input);
    const revision = this.nextRevision(
      current,
      history,
      snapshotFromAgent(patched),
      "update",
      current.publishedRevisionId,
    );
    const agent = materializeRevision(current, revision);
    this.commit((candidateAgents, candidateRevisions) => {
      candidateAgents.set(id, agent);
      candidateRevisions.set(id, [revision, ...history]);
    });
    return cloneAgent(agent);
  }

  /** Append an unpublished revision without changing get()/list(). */
  saveDraft(
    id: string,
    input: AgentInput,
    expectedHeadRevisionId?: string,
  ): AgentRevision | undefined {
    const published = this.agents.get(id);
    if (!published) return undefined;
    const history = this.revisions.get(id) ?? [];
    this.assertExpectedHead(history, expectedHeadRevisionId);
    const baseRevision = history[0];
    const base = baseRevision
      ? materializeRevision(published, baseRevision)
      : published;
    const patched = this.patchAgent(base, input);
    const revision = this.nextRevision(
      published,
      history,
      snapshotFromAgent(patched),
      "draft",
      baseRevision?.id ?? published.publishedRevisionId,
    );
    this.commit((_candidateAgents, candidateRevisions) => {
      candidateRevisions.set(id, [revision, ...history]);
    });
    return cloneRevision(revision);
  }

  /** Publish the latest draft by copying it into a new immutable release revision. */
  release(
    id: string,
    draftRevisionId?: string,
    expectedHeadRevisionId?: string,
  ): Agent | undefined {
    const current = this.agents.get(id);
    if (!current) return undefined;
    const history = this.revisions.get(id) ?? [];
    this.assertExpectedHead(history, expectedHeadRevisionId);
    const draft = history[0]?.source === "draft"
      && history[0].id !== current.publishedRevisionId
      && (draftRevisionId === undefined || history[0].id === draftRevisionId)
        ? history[0]
        : undefined;
    if (!draft) return undefined;
    const revision = this.nextRevision(
      current,
      history,
      draft.snapshot,
      "release",
      draft.id,
    );
    const agent = materializeRevision(current, revision);
    this.commit((candidateAgents, candidateRevisions) => {
      candidateAgents.set(id, agent);
      candidateRevisions.set(id, [revision, ...history]);
    });
    return cloneAgent(agent);
  }

  /** Roll back by copying history into a new publication; old revisions never change. */
  rollback(
    id: string,
    revisionId: string,
    expectedHeadRevisionId?: string,
  ): Agent | undefined {
    const current = this.agents.get(id);
    if (!current) return undefined;
    const history = this.revisions.get(id) ?? [];
    this.assertExpectedHead(history, expectedHeadRevisionId);
    const target = history.find((revision) => revision.id === revisionId);
    if (!target || target.source === "draft") return undefined;
    const revision = this.nextRevision(
      current,
      history,
      target.snapshot,
      "rollback",
      target.id,
    );
    const agent = materializeRevision(current, revision);
    this.commit((candidateAgents, candidateRevisions) => {
      candidateAgents.set(id, agent);
      candidateRevisions.set(id, [revision, ...history]);
    });
    return cloneAgent(agent);
  }

  remove(id: string): boolean {
    if (!this.agents.has(id)) return false;
    return this.commit((candidateAgents, candidateRevisions) => {
      candidateRevisions.delete(id);
      return candidateAgents.delete(id);
    });
  }

  /** Restore an exact archived agent and, when supplied, its immutable history. */
  restore(agent: Agent, revisions?: AgentRevision[]): Agent {
    const existing = this.agents.get(agent.id);
    if (existing) return cloneAgent(existing);
    const normalized = normalizeAgentForPersistence(cloneAgent(agent));
    if (revisions !== undefined) {
      if (revisions.length > MAX_AGENT_REVISION_HISTORY) {
        throw new Error(
          `Agent revision history exceeds ${MAX_AGENT_REVISION_HISTORY}: ${normalized.id}`,
        );
      }
      const history = revisions.map(cloneRevision);
      assertAgentRevisionHistory(normalized, history);
      this.commit((candidateAgents, candidateRevisions) => {
        candidateAgents.set(normalized.id, normalized);
        candidateRevisions.set(normalized.id, history);
      });
      return cloneAgent(normalized);
    }
    const legacy = materializeLegacyAgentRevisionHistory(normalized);
    this.commit((candidateAgents, candidateRevisions) => {
      candidateAgents.set(legacy.agent.id, legacy.agent);
      candidateRevisions.set(legacy.agent.id, legacy.revisions);
    });
    return cloneAgent(legacy.agent);
  }

  /** Replace only an exact synthesized legacy history with authoritative revisions. */
  upgradeMaterializedLegacyRestore(agent: Agent, revisions: AgentRevision[]): Agent {
    const existing = this.agents.get(agent.id);
    const existingRevisions = this.revisions.get(agent.id) ?? [];
    if (
      !existing
      || !isMaterializedLegacyAgentRevisionHistory(existing, existingRevisions)
    ) {
      throw new Error(`Agent is not a materialized legacy restore: ${agent.id}`);
    }
    const normalized = normalizeAgentForPersistence(cloneAgent(agent));
    const history = revisions.map(cloneRevision);
    if (!sameLegacyAgentSnapshot(existing, normalized)) {
      throw new Error(`Legacy Agent snapshot differs from restore: ${agent.id}`);
    }
    if (history.length > MAX_AGENT_REVISION_HISTORY) {
      throw new Error(
        `Agent revision history exceeds ${MAX_AGENT_REVISION_HISTORY}: ${normalized.id}`,
      );
    }
    assertAgentRevisionHistory(normalized, history);
    this.commit((candidateAgents, candidateRevisions) => {
      candidateAgents.set(normalized.id, normalized);
      candidateRevisions.set(normalized.id, history);
    });
    return cloneAgent(normalized);
  }
}

export function agentVisibleInSpace(agent: Agent, space: SpaceId): boolean {
  return agent.visibility === (space.startsWith("personal/") ? "Personal" : "Team");
}
