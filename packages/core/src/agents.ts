/**
 * Agent store (management backend, mew-style Agents page). An "agent" is a
 * named persona + provider CLI + model the bot uses to answer and execute
 * research tasks in a space.
 *
 * Active fields: name, instruction (persona), provider (local CLI), model,
 * Codex reasoning effort, visibility, and task-only execution controls.
 * Workdir/permission/skills are consumed only by research tasks; ordinary
 * ask/dream/learning calls deliberately remain in no-tool read-only mode.
 *
 * Agents are persisted to data/config/agents.json using the same whole-file
 * JSON pattern as the space registry (registry.ts). The markdown/DB knowledge is
 * unaffected; this is lightweight operational config.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
import { canonicalModelId, type SpaceId } from "@homeagent/shared";

/** Task-execution permission tier enforced by each local CLI provider. */
export type AgentPermission = ProviderExecutionPermission;
export const AGENT_PERMISSIONS: AgentPermission[] = ["read-only", "write", "full"];
export type AgentVisibility = "Team" | "Personal";
export const AGENT_VISIBILITIES: AgentVisibility[] = ["Team", "Personal"];

export type AgentExecution = ProviderExecution;

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
  /** Skill/plugin names the provider must load before a task begins. */
  skills: string[];
  createdAt: number;
  updatedAt: number;
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
  /** comma/newline-separated string or a string array */
  skills?: string | string[];
}

interface AgentsFile {
  agents: Record<string, Agent>;
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

/** Parse skills from a string (comma/newline) or array into a clean string[]. */
function normalizeSkills(raw?: string | string[]): string[] {
  const parts = Array.isArray(raw) ? raw : (raw ?? "").split(/[,\n]/);
  return normalizeProviderSkills(parts);
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

/** Resolve the task-only execution contract before a provider process starts. */
export function resolveAgentExecution(agent?: Agent): AgentExecution {
  const permission = agent?.permission ?? "read-only";
  const workdir = agent?.workdir ? resolveWorkdir(agent.workdir) : undefined;
  if (permission !== "read-only" && !workdir) {
    throw new Error(`Agent 的 ${permission} 权限必须配置 Workdir`);
  }
  return {
    permission,
    workdir,
    skills: [...(agent?.skills ?? [])],
  };
}

export class AgentStore {
  private configPath: string;
  private agents: Map<string, Agent>;

  constructor(dataDir: string) {
    this.configPath = join(dataDir, "config", "agents.json");
    this.agents = this.load();
  }

  private load(): Map<string, Agent> {
    const map = new Map<string, Agent>();
    let migrated = false;
    if (existsSync(this.configPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as AgentsFile;
        for (const [id, a] of Object.entries(parsed.agents ?? {})) {
          if (a && typeof a.id === "string") {
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
            const skills = normalizeSkills(a.skills as unknown as string | string[] | undefined);
            if (JSON.stringify(skills) !== JSON.stringify(a.skills)) migrated = true;
            a.skills = skills;
            const reasoningEffort = normalizeReasoningEffort(a.reasoningEffort, a.model);
            if (reasoningEffort !== a.reasoningEffort) migrated = true;
            a.reasoningEffort = reasoningEffort;
            map.set(id, a);
          }
        }
      } catch {
        // corrupt file: start empty rather than crash the backend
      }
    }
    this.agents = map;
    // Rewrite once so the on-disk file reflects the migration.
    if (migrated) this.persist();
    return map;
  }

  private persist(agents = this.agents): void {
    mkdirSync(join(this.configPath, ".."), { recursive: true });
    const obj: AgentsFile = { agents: Object.fromEntries(agents) };
    writeFileSync(this.configPath, JSON.stringify(obj, null, 2), "utf8");
  }

  list(): Agent[] {
    return [...this.agents.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  create(input: AgentInput): Agent {
    const now = Date.now();
    const model = normalizeModel(input.model);
    const agent: Agent = {
      id: `agent_${randomUUID()}`,
      name: input.name?.trim() || "未命名 Agent",
      instruction: input.instruction ?? "",
      model,
      reasoningEffort: normalizeReasoningEffort(input.reasoningEffort, model),
      provider: normalizeProvider(input.provider),
      visibility: normalizeVisibility(input.visibility),
      workdir: input.workdir?.trim() || undefined,
      permission: normalizePermission(input.permission),
      skills: normalizeSkills(input.skills),
      createdAt: now,
      updatedAt: now,
    };
    this.agents.set(agent.id, agent);
    this.persist();
    return agent;
  }

  /** Patch an existing agent. Only provided fields change. Returns undefined if absent. */
  update(id: string, input: AgentInput): Agent | undefined {
    const agent = this.agents.get(id);
    if (!agent) return undefined;
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
    if (input.skills !== undefined) agent.skills = normalizeSkills(input.skills);
    agent.updatedAt = Date.now();
    this.persist();
    return agent;
  }

  remove(id: string): boolean {
    if (!this.agents.has(id)) return false;
    const candidate = new Map(this.agents);
    candidate.delete(id);
    this.persist(candidate);
    this.agents = candidate;
    return true;
  }

  /** Restore an exact archived agent only when that id is not already present. */
  restore(agent: Agent): Agent {
    const existing = this.agents.get(agent.id);
    if (existing) return existing;
    const restored = { ...agent, skills: [...agent.skills] };
    this.agents.set(restored.id, restored);
    this.persist();
    return restored;
  }
}

export function agentVisibleInSpace(agent: Agent, space: SpaceId): boolean {
  return agent.visibility === (space.startsWith("personal/") ? "Personal" : "Team");
}
