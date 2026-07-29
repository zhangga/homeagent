import type { Agent, SpaceMeta, TaskRun } from "@homeagent/core";
import {
  AGENT_PERMISSIONS,
  AGENT_VISIBILITIES,
  resolveAgentExecution,
} from "@homeagent/core";
import {
  codexReasoningEffortsForModel,
  isCliProvider,
  isCodexReasoningEffortSupported,
  normalizeProviderSkills,
  type DetectedProvider,
} from "@homeagent/llm";

export type AgentWorkbenchMode = "empty" | "create" | "edit";

export interface AgentEditorValues {
  name: string;
  instruction: string;
  provider: string;
  model: string;
  reasoningEffort: string;
  visibility: string;
  permission: string;
  workdir: string;
  skills: string;
}

export type AgentFieldErrors = Partial<Record<keyof AgentEditorValues, string>>;

export interface AgentWorkbenchListItem {
  id: string;
  name: string;
  providerName: string;
  modelLabel: string;
  readiness: "ready" | "unavailable";
  readinessLabel: string;
  running: boolean;
  selected: boolean;
}

export interface AgentBindingView {
  id: string;
  label: string;
  detail: string;
  typeLabel: string;
}

export interface AgentRunView {
  id: string;
  taskId: string;
  taskName: string;
  topic: string;
  status: TaskRun["status"];
  startedAt: number;
  finishedAt?: number;
  provider: string;
  model: string;
  space: string;
  retryable: boolean;
}

export interface AgentInspectorView {
  provider: {
    id: string;
    name: string;
    available: boolean;
    statusLabel: string;
    detail: string;
  };
  bindings: AgentBindingView[];
  runs: AgentRunView[];
  runTotal: number;
  runLimit: number;
  hasMoreRuns: boolean;
}

export interface AgentWorkbenchView {
  mode: AgentWorkbenchMode;
  list: AgentWorkbenchListItem[];
  selected: Agent | null;
  editor: AgentEditorValues;
  generatedNames: AgentNameCandidates;
  automaticName: boolean;
  errors: AgentFieldErrors;
  providers: DetectedProvider[];
  models: Record<string, string[]>;
  defaults: { provider: string; model: string };
  inspector: AgentInspectorView | null;
  flash?: string;
  formError?: string;
}

export interface BuildAgentWorkbenchInput {
  agents: Agent[];
  mode: AgentWorkbenchMode;
  selected: Agent | null;
  providers: DetectedProvider[];
  models: Record<string, string[]>;
  defaults: { provider: string; model: string };
  bindings: SpaceMeta[];
  runs: TaskRun[];
  /** Runs for all Agents, used only for the left-list running indicator. */
  listRuns?: TaskRun[];
  runTotal?: number;
  runLimit?: number;
  values?: AgentEditorValues;
  errors?: AgentFieldErrors;
  flash?: string;
  formError?: string;
}

export interface AgentValidationContext {
  providers: DetectedProvider[];
  models?: Record<string, string[]>;
  defaults: { provider: string; model: string };
  current?: Agent | null;
}

export interface AgentValidationResult {
  ok: boolean;
  errors: AgentFieldErrors;
}

const MAX_NAME_LENGTH = 100;
const MAX_INSTRUCTION_LENGTH = 20_000;
const MAX_MODEL_LENGTH = 200;
const MAX_WORKDIR_LENGTH = 2_048;
const MAX_SKILLS_LENGTH = 4_000;

const AGENT_BASE_NAMES = {
  claude: "Claude Code Agent",
  codex: "Codex Agent",
  "trae-cli": "Trae CLI Agent",
} as const;

type GeneratedAgentProvider = keyof typeof AGENT_BASE_NAMES;

export type AgentNameCandidates = Record<GeneratedAgentProvider, string>;

export function generatedAgentName(
  provider: GeneratedAgentProvider,
  agents: Pick<Agent, "name">[],
): string {
  const base = AGENT_BASE_NAMES[provider];
  const names = new Set(agents.map((agent) => agent.name));
  if (!names.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} (${suffix})`;
    if (!names.has(candidate)) return candidate;
  }
}

export function generatedAgentNames(
  agents: Pick<Agent, "name">[],
): AgentNameCandidates {
  return {
    claude: generatedAgentName("claude", agents),
    codex: generatedAgentName("codex", agents),
    "trae-cli": generatedAgentName("trae-cli", agents),
  };
}

function isGeneratedAgentProvider(provider: string): provider is GeneratedAgentProvider {
  return provider in AGENT_BASE_NAMES;
}

function detectedProvider(
  providers: DetectedProvider[],
  providerId: string,
): DetectedProvider | undefined {
  return providers.find((provider) => provider.id === providerId);
}

function effectiveModel(
  agent: Pick<Agent, "provider" | "model">,
  defaults: { provider: string; model: string },
): string {
  if (agent.model) return agent.model;
  if (agent.provider === defaults.provider && defaults.model) return defaults.model;
  return "CLI 默认模型";
}

export function editorValuesFor(
  agent: Agent | null,
  providers: DetectedProvider[],
  defaults: { provider: string; model: string },
): AgentEditorValues {
  const initialProvider = agent?.provider
    ?? providers.find((provider) => provider.available)?.id
    ?? (isCliProvider(defaults.provider) ? defaults.provider : "claude");
  return {
    name: agent?.name ?? "",
    instruction: agent?.instruction ?? "",
    provider: initialProvider,
    model: agent?.model ?? "",
    reasoningEffort: agent?.reasoningEffort ?? "",
    visibility: agent?.visibility ?? "Team",
    permission: agent?.permission ?? "read-only",
    workdir: agent?.workdir ?? "",
    skills: (agent?.skills ?? []).join(", "),
  };
}

export function validateAgentEditor(
  values: AgentEditorValues,
  context: AgentValidationContext,
): AgentValidationResult {
  const errors: AgentFieldErrors = {};
  const name = values.name.trim();
  const provider = values.provider.trim();
  const model = values.model.trim();
  const reasoningEffort = values.reasoningEffort.trim();
  const permission = values.permission.trim();

  if (!name) errors.name = "请输入 Agent 名称";
  else if (name.length > MAX_NAME_LENGTH) {
    errors.name = `名称不能超过 ${MAX_NAME_LENGTH} 个字符`;
  }
  if (values.instruction.length > MAX_INSTRUCTION_LENGTH) {
    errors.instruction = `Instruction 不能超过 ${MAX_INSTRUCTION_LENGTH} 个字符`;
  }
  if (!isCliProvider(provider)) {
    errors.provider = "请选择受支持的本地 CLI";
  } else if (!detectedProvider(context.providers, provider)) {
    errors.provider = "当前环境无法识别这个 CLI";
  }
  if (model.length > MAX_MODEL_LENGTH) {
    errors.model = `模型名称不能超过 ${MAX_MODEL_LENGTH} 个字符`;
  } else if (model && context.models) {
    const catalog = context.models[provider] ?? [];
    const unchangedLegacyModel = context.current?.provider === provider
      && context.current.model === model;
    if (!catalog.includes(model) && !unchangedLegacyModel) {
      errors.model = `模型 ${model} 不属于所选 Provider；请选择列表模型或使用默认模型`;
    }
  }
  if (!AGENT_VISIBILITIES.includes(values.visibility as Agent["visibility"])) {
    errors.visibility = "请选择 Team 或 Personal";
  }
  if (!AGENT_PERMISSIONS.includes(permission as Agent["permission"])) {
    errors.permission = "请选择有效的任务权限";
  }
  if (values.workdir.length > MAX_WORKDIR_LENGTH) {
    errors.workdir = `Workdir 不能超过 ${MAX_WORKDIR_LENGTH} 个字符`;
  } else if ((permission === "write" || permission === "full") && !values.workdir.trim()) {
    errors.workdir = "可写或完全访问权限必须配置 Workdir";
  } else if (
    values.workdir.trim()
    && AGENT_PERMISSIONS.includes(permission as Agent["permission"])
    && isCliProvider(provider)
  ) {
    try {
      resolveAgentExecution({
        id: context.current?.id ?? "agent_validation",
        name: name || "Agent",
        instruction: values.instruction,
        provider,
        model,
        reasoningEffort: "",
        visibility: values.visibility === "Personal" ? "Personal" : "Team",
        permission: permission as Agent["permission"],
        workdir: values.workdir.trim(),
        skills: [],
        createdAt: context.current?.createdAt ?? 0,
        updatedAt: context.current?.updatedAt ?? 0,
      });
    } catch (error) {
      errors.workdir = error instanceof Error ? error.message : "Workdir 无效";
    }
  }
  if (values.skills.length > MAX_SKILLS_LENGTH) {
    errors.skills = `Skills 不能超过 ${MAX_SKILLS_LENGTH} 个字符`;
  } else {
    const submittedSkills = values.skills
      .split(/[,\n]/)
      .map((skill) => skill.trim())
      .filter(Boolean);
    if (submittedSkills.length > 50) {
      errors.skills = "Skills 最多配置 50 个";
    } else if (normalizeProviderSkills(submittedSkills).length < new Set(submittedSkills).size) {
      errors.skills = "Skill 名称只能包含字母、数字、点、下划线、冒号或短横线，且不超过 80 个字符";
    }
  }

  if (reasoningEffort) {
    if (provider !== "codex") {
      errors.reasoningEffort = "只有 Codex 支持推理强度";
    } else {
      const inheritedModel = context.defaults.provider === "codex"
        ? context.defaults.model
        : "";
      const resolvedModel = model || inheritedModel;
      if (!isCodexReasoningEffortSupported(resolvedModel, reasoningEffort)) {
        errors.reasoningEffort = resolvedModel
          ? `模型 ${resolvedModel} 不支持该推理强度`
          : "当前 Codex 默认模型不支持该推理强度";
      }
    }
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

export function buildAgentWorkbench(input: BuildAgentWorkbenchInput): AgentWorkbenchView {
  const generatedNames = generatedAgentNames(input.agents);
  const automaticName = input.mode === "create" && input.values === undefined;
  const editor = input.values
    ?? editorValuesFor(input.selected, input.providers, input.defaults);
  if (
    automaticName
    && isGeneratedAgentProvider(editor.provider)
  ) {
    editor.name = generatedNames[editor.provider];
  }
  const runningAgentIds = new Set(
    (input.listRuns ?? input.runs)
      .filter((run) => run.status === "running" && run.agentId)
      .map((run) => run.agentId!),
  );
  const list = input.agents.map((agent) => {
    const provider = detectedProvider(input.providers, agent.provider);
    const available = provider?.available === true;
    return {
      id: agent.id,
      name: agent.name,
      providerName: provider?.name ?? agent.provider,
      modelLabel: effectiveModel(agent, input.defaults),
      readiness: available ? "ready" as const : "unavailable" as const,
      readinessLabel: available ? "CLI 就绪" : "CLI 不可用",
      running: runningAgentIds.has(agent.id),
      selected: input.selected?.id === agent.id,
    };
  });

  let inspector: AgentInspectorView | null = null;
  if (input.selected) {
    const provider = detectedProvider(input.providers, input.selected.provider);
    inspector = {
      provider: {
        id: input.selected.provider,
        name: provider?.name ?? input.selected.provider,
        available: provider?.available === true,
        statusLabel: provider?.available ? "CLI 就绪" : "CLI 不可用",
        detail: provider?.detail ?? "未检测到此 CLI",
      },
      bindings: input.bindings.map((binding) => ({
        id: binding.id,
        label: binding.name?.trim() || binding.chatId?.trim() || binding.id,
        detail: binding.id,
        typeLabel: binding.id.startsWith("team/") ? "团队空间" : "个人空间",
      })),
      runs: input.runs.map((run) => ({
        id: run.id,
        taskId: run.taskId,
        taskName: run.taskName,
        topic: run.topic,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        provider: run.provider ?? "未记录",
        model: run.model || "CLI 默认模型",
        space: run.space,
        retryable: ["failed", "cancelled", "timed_out"].includes(run.status),
      })),
      runTotal: input.runTotal ?? input.runs.length,
      runLimit: input.runLimit ?? 20,
      hasMoreRuns: (input.runTotal ?? input.runs.length) > input.runs.length,
    };
  }

  return {
    mode: input.mode,
    list,
    selected: input.selected,
    editor,
    generatedNames,
    automaticName,
    errors: input.errors ?? {},
    providers: input.providers,
    models: input.models,
    defaults: input.defaults,
    inspector,
    flash: input.flash,
    formError: input.formError,
  };
}

export function reasoningEffortsForEditor(
  values: Pick<AgentEditorValues, "provider" | "model">,
  defaults: { provider: string; model: string },
): string[] {
  if (values.provider !== "codex") return [];
  const inheritedModel = defaults.provider === "codex" ? defaults.model : "";
  return [...codexReasoningEffortsForModel(values.model || inheritedModel || undefined)];
}
