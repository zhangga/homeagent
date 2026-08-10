import type {
  Agent,
  AgentActivityRun,
  AgentChatRecord,
  AgentInput,
  AgentRevision,
  AgentSkillBinding,
  SkillCatalogSnapshot,
  SkillRootKind,
  SpaceMeta,
  TaskRun,
} from "@homeagent/core";
import {
  AGENT_PERMISSIONS,
  AGENT_VISIBILITIES,
  isAgentSkillSourceKey,
  providerSkillRootKinds,
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
  /** Exact source keys submitted by the catalog selector. */
  skillSourceKeys?: string[];
  /** Unresolved names explicitly retained from a legacy Agent record. */
  legacySkillNames?: string[];
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
  kind: "task" | "chat";
  href: string;
  taskId?: string;
  taskName: string;
  topic: string;
  status: TaskRun["status"] | "recorded";
  deliveryStatus?: "pending" | "sent" | "failed";
  error?: string;
  startedAt: number;
  runStartedAt?: number;
  queuePosition?: number;
  queueWaitMs?: number;
  queueReason?: string;
  finishedAt?: number;
  provider: string;
  model: string;
  space: string;
  retryable: boolean;
}

function queueReason(keys: string[] | undefined): string | undefined {
  const labels = (keys ?? []).map((key) => {
    if (key === "run:global") return "全局额度";
    if (key.startsWith("run:provider-model:")) return "Provider/模型额度";
    if (key.startsWith("run:agent:")) return "Agent 额度";
    if (key.startsWith("run:conversation:")) return "会话额度";
    return "并发额度";
  });
  return [...new Set(labels)].join("、") || undefined;
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

export interface AgentRevisionView {
  id: string;
  number: number;
  source: AgentRevision["source"];
  basedOnRevisionId?: string;
  createdAt: number;
  provider: string;
  model: string;
  permission: string;
  published: boolean;
  draft: boolean;
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
  revision: {
    headRevisionId?: string;
    publishedRevisionId?: string;
    draftRevisionId?: string;
    history: AgentRevisionView[];
  } | null;
  skillCatalog: AgentSkillCatalogView;
  flash?: string;
  formError?: string;
}

export type AgentSkillCatalogStatus =
  | "available"
  | "invalid"
  | "incompatible"
  | "shadowed";

export interface AgentSkillCatalogRow {
  key: string;
  name: string;
  description: string;
  sourceKey: string;
  sourceLabel: string;
  providerIds: string[];
  status: AgentSkillCatalogStatus;
  statusLabel: string;
  selected: boolean;
  sourceCount: number;
  diagnostics: string[];
}

export interface AgentSkillSelectionView {
  kind: "source" | "legacy-name";
  name: string;
  sourceKey?: string;
  sourceLabel: string;
  status: "selected" | "provider-native" | "missing" | "legacy";
  statusLabel: string;
}

export interface AgentSkillCatalogView {
  rows: AgentSkillCatalogRow[];
  selected: AgentSkillSelectionView[];
  diagnostics: string[];
  refreshedAt?: number;
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
  /** Preferred unified Task + durable/legacy Chat activity stream. */
  activityRuns?: AgentActivityRun[];
  chatRecords?: AgentChatRecord[];
  /** Runs for all Agents, used only for the left-list running indicator. */
  listRuns?: TaskRun[];
  runTotal?: number;
  runLimit?: number;
  values?: AgentEditorValues;
  errors?: AgentFieldErrors;
  flash?: string;
  formError?: string;
  catalog?: SkillCatalogSnapshot;
  revisions?: AgentRevision[];
  draft?: AgentRevision;
  /** Preserve a stale CAS token on conflict pages until the user explicitly reloads. */
  expectedHeadRevisionId?: string;
}

export interface AgentValidationContext {
  providers: DetectedProvider[];
  models?: Record<string, string[]>;
  defaults: { provider: string; model: string };
  current?: Agent | null;
  catalog?: SkillCatalogSnapshot;
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
    skills: (agent?.skills ?? []).map((binding) => binding.name).join(", "),
    skillSourceKeys: (agent?.skills ?? [])
      .filter((binding) => binding.kind === "source")
      .map((binding) => binding.sourceKey),
    legacySkillNames: (agent?.skills ?? [])
      .filter((binding) => binding.kind === "legacy-name")
      .map((binding) => binding.name),
  };
}

const SKILL_STATUS_LABELS: Record<AgentSkillCatalogStatus, string> = {
  available: "可用于当前 Provider",
  invalid: "Skill 配置无效",
  incompatible: "与当前 Provider 不兼容",
  shadowed: "被更高优先级来源遮蔽",
};

function rootRank(provider: string, rootKind: SkillRootKind): number {
  if (!isCliProvider(provider)) return Number.MAX_SAFE_INTEGER;
  const rank = providerSkillRootKinds(provider).indexOf(rootKind);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
}

function buildSkillCatalogView(
  catalog: SkillCatalogSnapshot | undefined,
  provider: string,
  selected: Agent | null,
  editor: AgentEditorValues,
): AgentSkillCatalogView {
  const snapshot = catalog ?? {
    sources: [],
    entries: [],
    diagnostics: [],
    refreshedAt: undefined,
  };
  const selectedKeys = new Set(
    editor.skillSourceKeys
      ?? selected?.skills
        .filter((binding) => binding.kind === "source")
        .map((binding) => binding.sourceKey)
      ?? [],
  );
  const selectedLegacy = editor.legacySkillNames
    ?? selected?.skills
      .filter((binding) => binding.kind === "legacy-name")
      .map((binding) => binding.name)
    ?? [];
  const highestByName = new Map<string, { rootKind: SkillRootKind; sourceKey: string }>();
  for (const source of snapshot.sources) {
    if (
      source.status !== "available"
      || !source.providerIds.includes(provider as never)
    ) continue;
    const key = source.name.toLowerCase();
    const current = highestByName.get(key);
    if (
      !current
      || rootRank(provider, source.rootKind) < rootRank(provider, current.rootKind)
      || (
        rootRank(provider, source.rootKind) === rootRank(provider, current.rootKind)
        && source.sourceKey.localeCompare(current.sourceKey) < 0
      )
    ) {
      highestByName.set(key, {
        rootKind: source.rootKind,
        sourceKey: source.sourceKey,
      });
    }
  }
  const rows = snapshot.entries.flatMap((entry): AgentSkillCatalogRow[] => {
    const sharedSources = entry.sources.filter(
      (candidate) => candidate.rootKind === "shared-agents",
    );
    if (sharedSources.length === 0) return [];
    const ordered = [...sharedSources].sort((a, b) =>
      rootRank(provider, a.rootKind) - rootRank(provider, b.rootKind)
      || a.sourceKey.localeCompare(b.sourceKey)
    );
    const selectedSource = ordered.find((source) => selectedKeys.has(source.sourceKey));
    const source = selectedSource
      ?? ordered.find((candidate) =>
        candidate.status === "available"
        && candidate.providerIds.includes(provider as never)
      )
      ?? ordered[0]!;
    let status: AgentSkillCatalogStatus = "available";
    if (source.status !== "available") status = "invalid";
    else if (!source.providerIds.includes(provider as never)) status = "incompatible";
    else {
      const highest = highestByName.get(source.name.toLowerCase());
      if (
        highest
        && highest.sourceKey !== source.sourceKey
        && !entry.sources.some((candidate) => candidate.sourceKey === highest.sourceKey)
      ) {
        status = "shadowed";
      }
    }
    return [{
      key: entry.key,
      name: entry.name,
      description: entry.description,
      sourceKey: source.sourceKey,
      sourceLabel: `共享 · ${source.relativeDir}`,
      providerIds: [...new Set(sharedSources.flatMap((candidate) => candidate.providerIds))],
      status,
      statusLabel: SKILL_STATUS_LABELS[status],
      selected: sharedSources.some((candidate) => selectedKeys.has(candidate.sourceKey)),
      sourceCount: sharedSources.length,
      diagnostics: sharedSources.flatMap((candidate) =>
        candidate.diagnostics.map((diagnostic) => diagnostic.message)
      ),
    }];
  });
  const knownByKey = new Map(snapshot.sources.map((source) => [source.sourceKey, source]));
  const selectedViews: AgentSkillSelectionView[] = [];
  for (const sourceKey of selectedKeys) {
    const source = knownByKey.get(sourceKey);
    selectedViews.push(source
      ? {
          kind: "source",
          name: source.name,
          sourceKey,
          sourceLabel: `${source.rootKind} · ${source.relativeDir}`,
          status: source.rootKind === "shared-agents" ? "selected" : "provider-native",
          statusLabel: source.rootKind === "shared-agents"
            ? "已固定"
            : "Provider 自带 · 保留绑定",
        }
      : {
          kind: "source",
          name: selected?.skills.find(
            (binding) => binding.kind === "source" && binding.sourceKey === sourceKey,
          )?.name ?? "Unknown Skill",
          sourceKey,
          sourceLabel: sourceKey.split(":", 1)[0] ?? "unknown",
          status: "missing",
          statusLabel: "来源缺失，保存时将保留",
        });
  }
  for (const name of selectedLegacy) {
    selectedViews.push({
      kind: "legacy-name",
      name,
      sourceLabel: "legacy-name",
      status: "legacy",
      statusLabel: "旧名称尚未绑定来源",
    });
  }
  return {
    rows,
    selected: selectedViews,
    diagnostics: snapshot.diagnostics
      .filter((diagnostic) => diagnostic.rootKind === "shared-agents")
      .map((diagnostic) => `共享: ${diagnostic.message}`),
    refreshedAt: snapshot.refreshedAt,
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
  if (values.skillSourceKeys !== undefined) {
    const sourceKeys = values.skillSourceKeys;
    if (sourceKeys.length > 50) {
      errors.skills = "Skills 最多配置 50 个";
    } else if (
      new Set(sourceKeys).size !== sourceKeys.length
      || sourceKeys.some((sourceKey) => !isAgentSkillSourceKey(sourceKey))
    ) {
      errors.skills = "Skill 来源标识无效或重复";
    } else {
      const known = new Set(context.catalog?.sources.map((source) => source.sourceKey) ?? []);
      const existing = new Set(
        context.current?.skills
          .filter((binding) => binding.kind === "source")
          .map((binding) => binding.sourceKey)
        ?? [],
      );
      if (sourceKeys.some((sourceKey) => !known.has(sourceKey) && !existing.has(sourceKey))) {
        errors.skills = "所选 Skill 来源已不存在，请刷新目录后重试";
      }
    }
    const legacyNames = values.legacySkillNames ?? [];
    if (
      legacyNames.length > 50
      || normalizeProviderSkills(legacyNames).length !== new Set(legacyNames).size
    ) {
      errors.skills = "旧 Skill 绑定无效";
    }
  }
  if (values.skillSourceKeys === undefined && values.skills.length > MAX_SKILLS_LENGTH) {
    errors.skills = `Skills 不能超过 ${MAX_SKILLS_LENGTH} 个字符`;
  } else if (values.skillSourceKeys === undefined) {
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

export function agentInputForEditor(
  values: AgentEditorValues,
  catalog: SkillCatalogSnapshot | undefined,
  current?: Agent | null,
): AgentInput {
  if (values.skillSourceKeys === undefined) {
    return { ...values, skills: values.skills };
  }
  const catalogByKey = new Map(
    catalog?.sources.map((source) => [source.sourceKey, source]) ?? [],
  );
  const currentByKey = new Map(
    current?.skills
      .filter((binding) => binding.kind === "source")
      .map((binding) => [binding.sourceKey, binding])
    ?? [],
  );
  const skills: AgentSkillBinding[] = values.skillSourceKeys.map((sourceKey) => {
    const source = catalogByKey.get(sourceKey);
    const existing = currentByKey.get(sourceKey);
    return {
      kind: "source",
      sourceKey,
      name: source?.name ?? existing?.name ?? "unknown",
    };
  });
  for (const name of values.legacySkillNames ?? []) {
    skills.push({ kind: "legacy-name", name });
  }
  return {
    name: values.name,
    instruction: values.instruction,
    provider: values.provider,
    model: values.model,
    reasoningEffort: values.reasoningEffort,
    visibility: values.visibility,
    permission: values.permission,
    workdir: values.workdir,
    skills,
  };
}

export function buildAgentWorkbench(input: BuildAgentWorkbenchInput): AgentWorkbenchView {
  const generatedNames = generatedAgentNames(input.agents);
  const automaticName = input.mode === "create" && input.values === undefined;
  const editorAgent = input.selected && input.draft
    ? {
        ...input.selected,
        ...input.draft.snapshot,
        skills: input.draft.snapshot.skills.map((binding) => ({ ...binding })),
      }
    : input.selected;
  const editor = input.values
    ?? editorValuesFor(editorAgent, input.providers, input.defaults);
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
  for (const activity of input.activityRuns ?? []) {
    const run = activity.kind === "task"
      ? activity.run
      : activity.legacy
        ? undefined
        : activity.run;
    if (run?.status === "running" && run.agentId) runningAgentIds.add(run.agentId);
  }
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
    const activityRunViews: AgentRunView[] | undefined = input.activityRuns?.map(
      (activity): AgentRunView => {
        if (activity.kind === "task") {
          const run = activity.run;
          return {
            id: run.id,
            kind: "task",
            href: `/tasks/runs/${encodeURIComponent(run.id)}`,
            taskId: run.taskId,
            taskName: run.taskName,
            topic: run.topic,
            status: run.status,
            error: run.error,
            startedAt: run.startedAt,
            runStartedAt: run.runStartedAt,
            queuePosition: activity.queue?.position,
            queueWaitMs: activity.queue?.waitedMs,
            queueReason: queueReason(activity.queue?.blockedBy),
            finishedAt: run.finishedAt,
            provider: run.provider ?? "未记录",
            model: run.model || "CLI 默认模型",
            space: run.space,
            retryable: ["failed", "cancelled", "timed_out"].includes(run.status),
          };
        }
        if (activity.legacy) {
          const record = activity.record;
          return {
            id: record.id,
            kind: "chat",
            href:
              `/spaces/${encodeURIComponent(record.space)}/raw/${encodeURIComponent(record.id)}`,
            taskName: "Chat",
            topic: record.content,
            status: "recorded",
            startedAt: record.createdAt,
            provider: input.selected!.provider,
            model: effectiveModel(input.selected!, input.defaults),
            space: record.space,
            retryable: false,
          };
        }
        const run = activity.run;
        return {
          id: run.id,
          kind: "chat",
          href: `/chats/runs/${encodeURIComponent(run.id)}`,
          taskName: "Chat",
          topic: activity.record?.content ?? run.input,
          status: run.status,
          deliveryStatus: run.delivery.status,
          error: run.error?.message
            ?? (run.delivery.status === "failed" ? run.delivery.error : undefined),
          startedAt: run.startedAt,
          runStartedAt: run.runStartedAt,
          queuePosition: activity.queue?.position,
          queueWaitMs: activity.queue?.waitedMs,
          queueReason: queueReason(activity.queue?.blockedBy),
          finishedAt: run.finishedAt,
          provider: run.provider ?? "未记录",
          model: run.model || "CLI 默认模型",
          space: run.space,
          retryable:
            ["failed", "cancelled", "timed_out"].includes(run.status)
            || (
              run.status === "succeeded"
              && run.delivery.status !== "sent"
              && Boolean(run.output)
            ),
        };
      },
    );
    const legacyRunViews: AgentRunView[] = [
      ...input.runs.map((run): AgentRunView => ({
        id: run.id,
        kind: "task",
        href: `/tasks/runs/${encodeURIComponent(run.id)}`,
        taskId: run.taskId,
        taskName: run.taskName,
        topic: run.topic,
        status: run.status,
        error: run.error,
        startedAt: run.startedAt,
        runStartedAt: run.runStartedAt,
        finishedAt: run.finishedAt,
        provider: run.provider ?? "未记录",
        model: run.model || "CLI 默认模型",
        space: run.space,
        retryable: ["failed", "cancelled", "timed_out"].includes(run.status),
      })),
      ...(input.chatRecords ?? []).map((record): AgentRunView => ({
        id: record.id,
        kind: "chat",
        href:
          `/spaces/${encodeURIComponent(record.space)}/raw/${encodeURIComponent(record.id)}`,
        taskName: "Chat",
        topic: record.content,
        status: "recorded",
        startedAt: record.createdAt,
        provider: input.selected!.provider,
        model: effectiveModel(input.selected!, input.defaults),
        space: record.space,
        retryable: false,
      })),
    ];
    const runViews = activityRunViews ?? legacyRunViews;
    const runTotal = input.runTotal ?? runViews.length;
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
      runs: runViews
        .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id))
        .slice(0, input.runLimit ?? 20),
      runTotal,
      runLimit: input.runLimit ?? 20,
      hasMoreRuns: runTotal > (input.runLimit ?? 20),
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
    revision: input.selected
      ? {
          headRevisionId: input.expectedHeadRevisionId
            ?? input.revisions?.[0]?.id
            ?? input.selected.publishedRevisionId,
          publishedRevisionId: input.selected.publishedRevisionId,
          draftRevisionId: input.draft?.id,
          history: (input.revisions ?? []).slice(0, 20).map((revision) => ({
            id: revision.id,
            number: revision.number,
            source: revision.source,
            basedOnRevisionId: revision.basedOnRevisionId,
            createdAt: revision.createdAt,
            provider: revision.snapshot.provider,
            model: revision.snapshot.model || "CLI 默认模型",
            permission: revision.snapshot.permission,
            published: revision.id === input.selected?.publishedRevisionId,
            draft: revision.source === "draft" && revision.id === input.draft?.id,
          })),
        }
      : null,
    skillCatalog: buildSkillCatalogView(
      input.catalog,
      editor.provider,
      input.selected,
      editor,
    ),
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
