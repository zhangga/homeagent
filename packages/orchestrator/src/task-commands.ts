/**
 * Chat commands for tasks (feishu). Task control uses explicit `/task ...`
 * commands rather than the LLM intent classifier: a task spec is easy to
 * misparse, and requiring a clear syntax is safer than guessing. Detection runs
 * BEFORE capture/gate in the runtime, so a control message is never stored as
 * knowledge and always gets a reply (even in a group without an @-mention).
 *
 * Commands (case-insensitive verb):
 *   /task | /task list           list this space's tasks
 *   /task new <topic>            create a daily research task in this space
 *   /task run <name-or-index>    run a task now (matches by 1-based index or name)
 *   /task help                   usage
 *
 * The handler is a pure-ish function over the engine, returning the reply text;
 * long-running work (run) is fire-and-forget so the event loop isn't blocked.
 */
import type { SpaceId } from "@homeagent/shared";
import { logger, spaceKind } from "@homeagent/shared";
import {
  TaskAlreadyRunningError,
  type KnowledgeEngine,
  type Task,
} from "@homeagent/core";
import { TASK_HELP } from "./messages.ts";

const log = logger.child("task-commands");

export interface TaskCommand {
  verb: "list" | "new" | "run" | "help";
  arg: string;
}

/** Parse a `/task ...` message. Returns null when it isn't a task command. */
export function parseTaskCommand(text: string): TaskCommand | null {
  const m = text.trim().match(/^\/tasks?\b\s*(.*)$/is);
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  if (rest === "") return { verb: "list", arg: "" };
  const sp = rest.search(/\s/);
  const first = (sp === -1 ? rest : rest.slice(0, sp)).toLowerCase();
  const arg = sp === -1 ? "" : rest.slice(sp + 1).trim();
  if (first === "list" || first === "列表") return { verb: "list", arg: "" };
  if (first === "new" || first === "新建" || first === "创建") return { verb: "new", arg };
  if (first === "run" || first === "运行" || first === "跑") return { verb: "run", arg };
  if (first === "help" || first === "帮助") return { verb: "help", arg: "" };
  // Unknown subcommand -> help.
  return { verb: "help", arg: "" };
}

function fmtTask(t: Task, i: number): string {
  const weekdays = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const cad = t.cadence === "daily"
    ? `每天${t.hour}点`
    : t.cadence === "weekly"
      ? `每${weekdays[t.dayOfWeek] ?? "周一"}${t.hour}点`
      : "每小时";
  const status = t.lastStatus ? (t.lastStatus === "ok" ? "✅" : "⚠️") : "—";
  const off = t.enabled ? "" : "（已停用）";
  return `${i + 1}. ${t.name} · ${cad} · ${status}${off}`;
}

/** Find a task in a space by 1-based index or (case-insensitive) name. */
function findTask(tasks: Task[], arg: string): Task | undefined {
  const idx = Number(arg);
  if (Number.isInteger(idx) && idx >= 1 && idx <= tasks.length) return tasks[idx - 1];
  const lower = arg.toLowerCase();
  return tasks.find((t) => t.name.toLowerCase() === lower);
}

export interface TaskCommandDeps {
  /** run a task in the background (fire-and-forget); injected for tests */
  runTask?: (taskId: string) => void;
}

/**
 * Handle a parsed task command for a space. Returns the reply text. `run` is
 * dispatched via deps.runTask (fire-and-forget) so a slow research call never
 * blocks the single-consumer event loop.
 */
export async function handleTaskCommand(
  engine: KnowledgeEngine,
  space: SpaceId,
  cmd: TaskCommand,
  deps: TaskCommandDeps = {},
): Promise<string> {
  if (cmd.verb === "help") return TASK_HELP;

  const tasks = engine.tasks.list().filter((t) => t.space === space);

  if (cmd.verb === "list") {
    if (tasks.length === 0) return "本空间还没有任务。用 `/task new <主题>` 新建一个。";
    return ["本空间的任务：", ...tasks.map(fmtTask)].join("\n");
  }

  if (cmd.verb === "new") {
    const topic = cmd.arg.trim();
    if (!topic) return "请给出研究主题：`/task new <主题>`";
    // Personal spaces have no bound chat to notify; default notify off there.
    const notify = spaceKind(space) === "team";
    const name = topic.length <= 20 ? topic : topic.slice(0, 20) + "…";
    const task = engine.tasks.create({ name, space, topic, cadence: "daily", notify });
    if (!task) return "创建失败：空间无效。";
    log.info("task created via chat", { space, taskId: task.id });
    return `已创建每日任务「${task.name}」，将每天 ${task.hour} 点研究并写入本空间。发送 \`/task run ${task.name}\` 可立即运行。`;
  }

  // run
  if (!cmd.arg.trim()) return "请指定要运行的任务：`/task run <名称或序号>`（用 `/task` 查看列表）";
  const target = findTask(tasks, cmd.arg.trim());
  if (!target) return `没找到任务「${cmd.arg.trim()}」。用 \`/task\` 查看本空间任务列表。`;
  try {
    if (deps.runTask) {
      deps.runTask(target.id);
      return `已开始运行任务「${target.name}」，完成后结果会写入本空间知识库${target.notify ? "并在此通知你" : ""}。`;
    }
    const started = engine.startTaskRun(target.id, { trigger: "chat" });
    void started.completion.catch((err) => {
      log.error("chat task run failed", { id: target.id, runId: started.run.id, err: String(err) });
    });
    return `已开始运行任务「${target.name}」（运行编号：${started.run.id}），完成后结果会写入本空间知识库${target.notify ? "并在此通知你" : ""}。`;
  } catch (err) {
    if (err instanceof TaskAlreadyRunningError) {
      return `任务「${target.name}」正在运行（运行编号：${err.runId}），不会重复启动。`;
    }
    log.error("chat task run could not start", { id: target.id, err: String(err) });
    return `任务「${target.name}」启动失败，请稍后重试。`;
  }
}
