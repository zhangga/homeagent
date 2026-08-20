import {
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeEngine } from "@homeagent/core";

const SPACE = "team/oc_beta_recovery" as const;
const RAW_CONTENT = "Beta 崩溃恢复验收：知识、任务、提醒和学习状态必须保留。";
const INTERRUPTED_ERROR = "应用在任务完成前停止，运行已标记为失败";

interface SeedRecord {
  rawId: string;
  taskId: string;
  runId: string;
  reminderId: string;
  learningPlanId: string;
}

export interface CrashRecoveryReport {
  childExitCode: number;
  rawCount: number;
  taskRunStatus: string;
  reminderStatus: string;
  learningStatus: string;
}

function writeDurableJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function seedThenCrash(dataDir: string, recordPath: string): Promise<never> {
  const engine = new KnowledgeEngine({
    dataDir,
    runProvider: async () => "unused",
  });
  engine.ensureSpace(SPACE, { chatId: "oc_beta_recovery" });
  const rawId = await engine.remember({
    space: SPACE,
    source: "message",
    author: "ou_beta",
    chatId: "oc_beta_recovery",
    messageId: "om_beta_recovery",
    content: RAW_CONTENT,
  });
  const task = engine.tasks.create({
    name: "Beta 恢复任务",
    space: SPACE,
    topic: "验证非正常退出后的任务状态",
    enabled: false,
    notify: false,
    distillOnRun: false,
  });
  if (!task) throw new Error("failed to seed recovery task");
  const snapshot = engine.agentRunExecutionSnapshot(SPACE, true);
  const run = engine.taskRuns.start({
    task,
    trigger: "manual",
    agentId: snapshot.agent?.id,
    provider: snapshot.provider,
    model: snapshot.model,
    executionPlan: snapshot.executionPlan,
    skillEvidence: snapshot.skillEvidence,
    distill: false,
  });
  const reminder = engine.reminders.create({
    title: "Beta 恢复提醒",
    space: SPACE,
    chatId: "oc_beta_recovery",
    creatorId: "ou_beta",
    triggerAt: Date.now() + 7 * 24 * 60 * 60_000,
  });
  if (!reminder) throw new Error("failed to seed recovery reminder");
  const learning = engine.learning.create({
    name: "Beta 恢复学习计划",
    space: SPACE,
    creatorId: "ou_beta",
    chatId: "oc_beta_recovery",
    sourceTitle: "恢复验收材料",
    sourceContent: RAW_CONTENT,
    sourceRawIds: [rawId],
    sourceMessageId: "om_beta_recovery",
  });
  writeDurableJson(recordPath, {
    rawId,
    taskId: task.id,
    runId: run.id,
    reminderId: reminder.id,
    learningPlanId: learning.id,
  } satisfies SeedRecord);

  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL did not terminate the seed process");
}

export async function verifyCrashRecovery(): Promise<CrashRecoveryReport> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`crash recovery verification is unsupported on ${process.platform}`);
  }
  const root = mkdtempSync(join(tmpdir(), "homeagent-crash-recovery-"));
  const dataDir = join(root, "data");
  const recordPath = join(root, "seed.json");
  const script = fileURLToPath(import.meta.url);
  try {
    const child = Bun.spawn(
      [process.execPath, script, "--seed-child", dataDir, recordPath],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, childExitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (childExitCode !== 128 + 9) {
      throw new Error(
        `seed process exited with ${childExitCode} instead of SIGKILL exit 137: `
        + `${stdout || stderr}`,
      );
    }

    const seed = JSON.parse(readFileSync(recordPath, "utf8")) as SeedRecord;
    const engine = new KnowledgeEngine({
      dataDir,
      recoverInterruptedTaskRuns: true,
      runProvider: async () => "unused",
    });
    try {
      const rawRecords = engine.registry.store(SPACE).index().listRaw({});
      const run = engine.getTaskRun(seed.runId);
      const reminder = engine.reminders.get(seed.reminderId);
      const learning = engine.learning.get(seed.learningPlanId);
      const source = engine.learning.source(seed.learningPlanId);

      if (!rawRecords.some((raw) => raw.id === seed.rawId && raw.content === RAW_CONTENT)) {
        throw new Error("raw knowledge did not survive the crash");
      }
      if (!engine.tasks.has(seed.taskId)) throw new Error("task did not survive the crash");
      if (run?.status !== "failed" || run.error !== INTERRUPTED_ERROR) {
        throw new Error("interrupted task run was not recovered as a durable failure");
      }
      if (reminder?.status !== "scheduled") throw new Error("reminder did not survive the crash");
      if (learning?.status !== "active" || source?.content !== RAW_CONTENT) {
        throw new Error("learning plan did not survive the crash");
      }

      return {
        childExitCode,
        rawCount: rawRecords.length,
        taskRunStatus: run.status,
        reminderStatus: reminder.status,
        learningStatus: learning.status,
      };
    } finally {
      engine.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--seed-child") {
    const dataDir = args[1];
    const recordPath = args[2];
    if (!dataDir || !recordPath) {
      process.stderr.write("verify:crash-recovery: missing child paths\n");
      process.exit(2);
    }
    await seedThenCrash(dataDir, recordPath);
  } else {
    try {
      const report = await verifyCrashRecovery();
      console.log(`Crash recovery passed: ${JSON.stringify(report)}`);
    } catch (error) {
      console.error(
        `verify:crash-recovery: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    }
  }
}
