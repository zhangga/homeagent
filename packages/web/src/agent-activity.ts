import type { Agent, ChatRun, TaskRun } from "@homeagent/core";

export interface AgentActivityEntry {
  id: string;
  href: string;
  kind: "chat" | "task";
  title: string;
  agentId?: string;
  agentLabel: string;
  space: string;
  provider: string;
  model: string;
  status: ChatRun["status"] | TaskRun["status"];
  startedAt: number;
}

export interface AgentActivity {
  agents: { id: string; running: boolean; queued: boolean }[];
  activeRuns: AgentActivityEntry[];
  defaultRuns: AgentActivityEntry[];
  activeCount: number;
  summary: string;
}

/** Management projection only: retain each Run's frozen Agent and Space ownership. */
export function buildAgentActivity(
  agents: Agent[],
  taskRuns: TaskRun[],
  chatRuns: ChatRun[],
): AgentActivity {
  const names = new Map(agents.map((agent) => [agent.id, agent.name]));
  const owner = (id: string | undefined) => id
    ? names.get(id) ?? "已删除的 Agent"
    : "默认（全局）";
  const entries: AgentActivityEntry[] = [
    ...taskRuns.map((run): AgentActivityEntry => ({
      id: run.id, href: `/tasks/runs/${encodeURIComponent(run.id)}`, kind: "task",
      title: run.taskName, agentId: run.agentId, agentLabel: owner(run.agentId),
      space: run.space, provider: run.provider ?? "未记录", model: run.model || "CLI 默认模型",
      status: run.status, startedAt: run.startedAt,
    })),
    ...chatRuns.map((run): AgentActivityEntry => ({
      id: run.id, href: `/chats/runs/${encodeURIComponent(run.id)}`, kind: "chat",
      title: run.input.slice(0, 200), agentId: run.agentId, agentLabel: owner(run.agentId),
      space: run.space, provider: run.provider ?? "未记录", model: run.model || "CLI 默认模型",
      status: run.status, startedAt: run.startedAt,
    })),
  ].sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
  const activeRuns = entries.filter((run) => ["running", "queued", "awaiting_approval"].includes(run.status));
  const running = activeRuns.filter((run) => run.status === "running").length;
  const queued = activeRuns.filter((run) => run.status === "queued").length;
  const approval = activeRuns.filter((run) => run.status === "awaiting_approval").length;
  return {
    agents: agents.map((agent) => ({
      id: agent.id,
      running: activeRuns.some((run) => run.agentId === agent.id && run.status === "running"),
      queued: activeRuns.some((run) => run.agentId === agent.id && run.status === "queued"),
    })),
    activeRuns,
    defaultRuns: entries.filter((run) => !run.agentId && !["running", "queued", "awaiting_approval"].includes(run.status)).slice(0, 20),
    activeCount: activeRuns.length,
    summary: activeRuns.length
      ? `${running} 个运行中 · ${queued} 个排队中${approval ? ` · ${approval} 个待审批` : ""}`
      : "当前没有运行或排队的任务",
  };
}
