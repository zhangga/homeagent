import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceId } from "@homeagent/shared";
import type { Task } from "./tasks.ts";
import type { ResolvedExecutionPlan } from "./execution-plan.ts";
import {
  DEFAULT_TASK_RUN_APPROVAL_TTL_MS,
  MAX_TASK_RUN_ERROR_CHARACTERS,
  MAX_TASK_RUN_HISTORY_PER_TASK,
  MAX_TASK_RUN_OUTPUT_CHARACTERS,
  TaskRunStore,
} from "./task-runs.ts";

let dir: string;
const SPACE: SpaceId = "team/oc_task_runs";
const TASK: Task = {
  id: "task_history",
  name: "历史任务",
  space: SPACE,
  topic: "记录运行历史",
  cadence: "daily",
  hour: 8,
  enabled: true,
  notify: false,
  distillOnRun: false,
  timeoutMinutes: 5,
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ha-task-runs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("TaskRunStore", () => {
  test("atomically claims one due read-only provider retry with its frozen plan", () => {
    const store = new TaskRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Keep the originally approved read-only research plan.",
      provider: "claude",
      model: "claude-frozen",
      execution: {
        permission: "read-only",
        workdir: "C:\\workspace\\research",
        skills: ["review"],
      },
    };
    const run = store.start({
      task: TASK,
      trigger: "scheduled",
      agentId: "agent_frozen",
      provider: "claude",
      model: "claude-frozen",
      executionPlan,
      skillEvidence: {
        requested: [{ kind: "legacy-name", name: "review" }],
        resolved: [{
          sourceKey: "claude-user:review",
          name: "review",
          invocationName: "review",
          reference: "/review",
          skillFileHash: "a".repeat(64),
        }],
        skipped: [],
      },
      distill: true,
      timeoutMs: 90_000,
      startedAt: 1_000,
    });
    store.begin(run.id, 1_010);
    const failed = store.fail(run.id, {
      finishedAt: 1_020,
      error: "Error: provider overloaded (503)",
      failure: { phase: "provider", kind: "overloaded", retryable: true },
      retry: {
        attempt: 1,
        maxAttempts: 2,
        status: "waiting",
        nextAttemptAt: 61_020,
      },
    })!;

    expect(failed.retry).toEqual({
      attempt: 1,
      maxAttempts: 2,
      status: "waiting",
      nextAttemptAt: 61_020,
    });
    expect(store.listDueRetries(61_019)).toEqual([]);
    expect(store.claimRetry(run.id, 61_019)).toBeUndefined();

    const child = store.claimRetry(run.id, 61_020)!;
    expect(child).toEqual(expect.objectContaining({
      taskId: TASK.id,
      taskName: TASK.name,
      space: TASK.space,
      topic: TASK.topic,
      trigger: "retry",
      retryOf: run.id,
      agentId: "agent_frozen",
      provider: "claude",
      model: "claude-frozen",
      executionPlan,
      skillEvidence: failed.skillEvidence,
      distill: true,
      timeoutMs: 90_000,
      status: "queued",
      retry: {
        attempt: 2,
        maxAttempts: 2,
        status: "claimed",
      },
    }));
    expect(store.get(run.id)?.retry).toEqual({
      attempt: 1,
      maxAttempts: 2,
      status: "claimed",
      claimedByRunId: child.id,
    });
    expect(store.claimRetry(run.id, 61_020)).toBeUndefined();

    const reopened = new TaskRunStore(dir);
    expect(reopened.get(run.id)?.retry?.claimedByRunId).toBe(child.id);
    expect(reopened.get(child.id)?.status).toBe("queued");
    expect(reopened.listDueRetries(100_000)).toEqual([]);
  });

  test("bases retry backoff on the clamped durable terminal time", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({
      task: TASK,
      trigger: "scheduled",
      distill: false,
      startedAt: 100,
      executionPlan: {
        version: 1,
        instruction: "Survive clock rollback.",
        provider: "claude",
        execution: { permission: "read-only", skills: [] },
      },
    });
    store.begin(run.id, 1_000);

    const failed = store.fail(run.id, {
      finishedAt: 200,
      error: "Error: provider overloaded (503)",
      failure: { phase: "provider", kind: "overloaded", retryable: true },
      retry: {
        attempt: 1,
        maxAttempts: 2,
        status: "waiting",
        nextAttemptAt: 60_200,
      },
    })!;

    expect(failed.finishedAt).toBe(1_000);
    expect(failed.retry?.nextAttemptAt).toBe(61_000);
    expect(store.listDueRetries(60_999)).toEqual([]);
    expect(store.listDueRetries(61_000).map((item) => item.id)).toEqual([run.id]);
  });

  test("does not prune a waiting or claimed retry chain before its child settles", () => {
    const store = new TaskRunStore(dir);
    const parent = store.start({
      task: TASK,
      trigger: "scheduled",
      distill: false,
      startedAt: 1,
      executionPlan: {
        version: 1,
        instruction: "Keep retry lineage.",
        provider: "claude",
        execution: { permission: "read-only", skills: [] },
      },
    });
    store.begin(parent.id, 2);
    store.fail(parent.id, {
      finishedAt: 3,
      error: "Error: provider overloaded (503)",
      failure: { phase: "provider", kind: "overloaded", retryable: true },
      retry: {
        attempt: 1,
        maxAttempts: 2,
        status: "waiting",
        nextAttemptAt: 60_003,
      },
    });
    const child = store.claimRetry(parent.id, 60_003)!;

    for (let index = 0; index <= MAX_TASK_RUN_HISTORY_PER_TASK; index += 1) {
      const completed = store.start({
        task: TASK,
        trigger: "manual",
        distill: false,
        startedAt: 70_000 + index,
      });
      store.succeed(completed.id, {
        finishedAt: 80_000 + index,
        output: `history ${index}`,
      });
    }

    expect(store.has(parent.id)).toBe(true);
    expect(store.has(child.id)).toBe(true);
    expect(store.get(parent.id)?.retry?.claimedByRunId).toBe(child.id);
  });

  test("restore refuses an external waiting retry that could execute later", () => {
    const source = new TaskRunStore(dir);
    const run = source.start({
      task: TASK,
      trigger: "scheduled",
      distill: false,
      startedAt: 1,
      executionPlan: {
        version: 1,
        instruction: "Local pending retry.",
        provider: "claude",
        execution: { permission: "read-only", skills: [] },
      },
    });
    source.begin(run.id, 2);
    const waiting = source.fail(run.id, {
      finishedAt: 3,
      error: "Error: provider overloaded (503)",
      failure: { phase: "provider", kind: "overloaded", retryable: true },
      retry: {
        attempt: 1,
        maxAttempts: 2,
        status: "waiting",
        nextAttemptAt: 60_003,
      },
    })!;

    const target = new TaskRunStore(join(dir, "restore-target"));
    expect(() => target.restore([waiting])).toThrow(/waiting|active|retry/i);
  });

  test("recovers an interrupted final retry as a non-retryable exhausted failure", () => {
    const store = new TaskRunStore(dir);
    const parent = store.start({
      task: TASK,
      trigger: "scheduled",
      distill: false,
      startedAt: 1,
      executionPlan: {
        version: 1,
        instruction: "Final retry crash recovery.",
        provider: "claude",
        execution: { permission: "read-only", skills: [] },
      },
    });
    store.begin(parent.id, 2);
    store.fail(parent.id, {
      finishedAt: 3,
      error: "Error: provider overloaded (503)",
      failure: { phase: "provider", kind: "overloaded", retryable: true },
      retry: {
        attempt: 1,
        maxAttempts: 2,
        status: "waiting",
        nextAttemptAt: 60_003,
      },
    });
    const child = store.claimRetry(parent.id, 60_003)!;
    store.begin(child.id, 60_004);

    const reopened = new TaskRunStore(dir, { recoverInterrupted: true });
    expect(reopened.get(child.id)).toEqual(expect.objectContaining({
      status: "failed",
      failure: { phase: "admission", kind: "interrupted", retryable: false },
      retry: { attempt: 2, maxAttempts: 2, status: "exhausted" },
    }));
    expect(reopened.listDueRetries(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  test("keeps risky work durable and inactive until it is approved once", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      startedAt: 100,
      approvalRequired: true,
      executionPlan: {
        version: 1,
        instruction: "Edit the workspace only after approval.",
        provider: "codex",
        execution: {
          permission: "write",
          workdir: "C:\\workspace\\approved",
          skills: [],
        },
      },
    });

    expect(run).toEqual(expect.objectContaining({
      status: "awaiting_approval",
      approval: expect.objectContaining({
        status: "pending",
        requestedAt: 100,
      }),
    }));
    expect(store.begin(run.id, 110)).toBeUndefined();
    expect(store.succeed(run.id, {
      finishedAt: 111,
      output: "must not bypass approval",
    })).toBeUndefined();
    expect(store.get(run.id)?.status).toBe("awaiting_approval");

    const reopened = new TaskRunStore(dir, { recoverInterrupted: true });
    expect(reopened.get(run.id)?.status).toBe("awaiting_approval");
    expect(reopened.approve(run.id, {
      decidedAt: 120,
      decidedBy: "ou_approver",
      reason: "Reviewed the frozen execution plan.",
    })).toEqual(expect.objectContaining({
      status: "queued",
      approval: expect.objectContaining({
        status: "approved",
        requestedAt: 100,
        decidedAt: 120,
        decidedBy: "ou_approver",
        reason: "Reviewed the frozen execution plan.",
      }),
    }));
    expect(reopened.approve(run.id, {
      decidedAt: 121,
      decidedBy: "ou_approver",
    })).toBeUndefined();
    expect(reopened.begin(run.id, 130)?.status).toBe("running");
  });

  test("treats the approval deadline as an atomic execution boundary", () => {
    const store = new TaskRunStore(dir);
    const startPending = (startedAt: number) => store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      startedAt,
      approvalRequired: true,
      executionPlan: {
        version: 1,
        instruction: "Never cross the approval deadline.",
        provider: "codex",
        execution: {
          permission: "write",
          workdir: "C:\\workspace\\deadline",
          skills: [],
        },
      },
    });

    const beforeDeadline = startPending(1_000);
    const firstExpiry = beforeDeadline.approval!.expiresAt!;
    expect(store.approve(beforeDeadline.id, {
      decidedAt: firstExpiry - 1,
      decidedBy: "on-time-admin",
    })).toEqual(expect.objectContaining({
      status: "queued",
      approval: expect.objectContaining({ status: "approved" }),
    }));
    expect(store.expireApprovals(firstExpiry)).toEqual([]);

    const atDeadline = startPending(2_000);
    const secondExpiry = atDeadline.approval!.expiresAt!;
    expect(store.approve(atDeadline.id, {
      decidedAt: secondExpiry,
      decidedBy: "late-admin",
    })).toBeUndefined();
    expect(store.get(atDeadline.id)).toEqual(expect.objectContaining({
      status: "cancelled",
      finishedAt: secondExpiry,
      approval: expect.objectContaining({
        status: "expired",
        decidedAt: secondExpiry,
      }),
    }));
    expect(store.expireApprovals(secondExpiry)).toEqual([]);
  });

  test("reject and expiry sweep converge on the same canonical deadline decision", () => {
    const store = new TaskRunStore(dir);
    const pending = (startedAt: number) => store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      startedAt,
      approvalRequired: true,
      executionPlan: {
        version: 1,
        instruction: "Deadline wins over a late rejection.",
        provider: "codex",
        execution: { permission: "write", workdir: "C:\\workspace", skills: [] },
      },
    });

    const rejectAtDeadline = pending(10_000);
    const firstDeadline = rejectAtDeadline.approval!.expiresAt!;
    expect(store.reject(rejectAtDeadline.id, {
      decidedAt: firstDeadline,
      decidedBy: "late-reviewer",
      reason: "too late to reject",
    })).toBeUndefined();
    expect(store.get(rejectAtDeadline.id)).toEqual(expect.objectContaining({
      status: "cancelled",
      finishedAt: firstDeadline,
      approval: expect.objectContaining({
        status: "expired",
        decidedAt: firstDeadline,
        decidedBy: "homeagent.approval-expiry",
      }),
    }));

    const sweepFirst = pending(20_000);
    const secondDeadline = sweepFirst.approval!.expiresAt!;
    expect(store.expireApprovals(secondDeadline).map((run) => run.id)).toContain(sweepFirst.id);
    expect(store.reject(sweepFirst.id, {
      decidedAt: secondDeadline + 1,
      decidedBy: "later-reviewer",
    })).toBeUndefined();
    expect(store.get(sweepFirst.id)?.approval).toEqual(expect.objectContaining({
      status: "expired",
      decidedAt: secondDeadline,
      decidedBy: "homeagent.approval-expiry",
    }));
  });

  test("keeps an approval notification retryable across restarts until it is sent", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({
      task: TASK,
      trigger: "scheduled",
      distill: false,
      startedAt: 3_000,
      approvalRequired: true,
      executionPlan: {
        version: 1,
        instruction: "Notify an approver before editing.",
        provider: "codex",
        execution: {
          permission: "write",
          workdir: "C:\\workspace\\notification",
          skills: [],
        },
      },
    });
    expect(run.approvalNotification).toEqual({ status: "pending", attempts: 0 });
    expect(store.listNeedingApprovalNotification(3_000).map((item) => item.id))
      .toEqual([run.id]);

    const attempting = store.startApprovalNotificationAttempt(run.id, 3_100)!;
    expect(attempting.approvalNotification).toEqual(expect.objectContaining({
      status: "pending",
      attempts: 1,
      lastAttemptAt: 3_100,
      nextAttemptAt: 63_100,
    }));
    store.approvalNotificationFailed(run.id, "Feishu unavailable");

    const reopened = new TaskRunStore(dir);
    expect(reopened.listNeedingApprovalNotification(63_099)).toEqual([]);
    expect(reopened.listNeedingApprovalNotification(63_100).map((item) => item.id))
      .toEqual([run.id]);
    reopened.startApprovalNotificationAttempt(run.id, 63_100);
    reopened.approvalNotificationSent(run.id, 63_101);

    const sent = new TaskRunStore(dir).get(run.id);
    expect(sent?.approvalNotification).toEqual(expect.objectContaining({
      status: "sent",
      attempts: 2,
      sentAt: 63_101,
    }));
    expect(new TaskRunStore(dir).listNeedingApprovalNotification(100_000)).toEqual([]);
  });

  test("upgrades a v7 pending approval with a deadline and durable notification outbox", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      startedAt: 4_000,
      approvalRequired: true,
      executionPlan: {
        version: 1,
        instruction: "Migrate the pending request.",
        provider: "codex",
        execution: {
          permission: "write",
          workdir: "C:\\workspace\\migration",
          skills: [],
        },
      },
    });
    const path = join(dir, "config", "task-runs.json");
    const legacy = JSON.parse(readFileSync(path, "utf8"));
    legacy.version = 7;
    delete legacy.runs[run.id].approval.expiresAt;
    delete legacy.runs[run.id].approvalNotification;
    writeFileSync(path, JSON.stringify(legacy), "utf8");

    const migrated = new TaskRunStore(dir).get(run.id);
    expect(migrated).toEqual(expect.objectContaining({
      status: "awaiting_approval",
      approval: expect.objectContaining({
        status: "pending",
        expiresAt: 4_000 + DEFAULT_TASK_RUN_APPROVAL_TTL_MS,
      }),
      approvalNotification: { status: "pending", attempts: 0 },
    }));
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(9);
  });

  test("rejects pending approval as a durable cancelled run", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({
      task: TASK,
      trigger: "scheduled",
      distill: false,
      startedAt: 200,
      approvalRequired: true,
      executionPlan: {
        version: 1,
        instruction: "Run a privileged task.",
        provider: "codex",
        execution: {
          permission: "full",
          workdir: "C:\\workspace\\full",
          skills: [],
        },
      },
    });

    expect(store.reject(run.id, {
      decidedAt: 220,
      decidedBy: "ou_reviewer",
      reason: "The requested access is too broad.",
    })).toEqual(expect.objectContaining({
      status: "cancelled",
      finishedAt: 220,
      error: "The requested access is too broad.",
      approval: expect.objectContaining({
        status: "rejected",
        requestedAt: 200,
        decidedAt: 220,
        decidedBy: "ou_reviewer",
        reason: "The requested access is too broad.",
      }),
    }));
    expect(store.reject(run.id, { decidedAt: 221 })).toBeUndefined();
    expect(new TaskRunStore(dir, { recoverInterrupted: true }).get(run.id))
      .toEqual(expect.objectContaining({ status: "cancelled" }));
  });

  test("cancelling pending approval records a rejected decision", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      startedAt: 300,
      approvalRequired: true,
      executionPlan: {
        version: 1,
        instruction: "Edit after approval.",
        provider: "codex",
        execution: {
          permission: "write",
          workdir: "C:\\workspace\\cancelled",
          skills: [],
        },
      },
    });

    expect(store.cancel(run.id, {
      finishedAt: 310,
      error: "Cancelled by the requester.",
    })).toEqual(expect.objectContaining({
      status: "cancelled",
      approval: expect.objectContaining({
        status: "rejected",
        decidedAt: 310,
        reason: "Cancelled by the requester.",
      }),
    }));
    expect(new TaskRunStore(dir).get(run.id)?.approval?.status).toBe("rejected");
  });

  test("fails closed when upgrading an unapproved legacy queued write run", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({
      task: TASK,
      trigger: "scheduled",
      distill: false,
      startedAt: 400,
      executionPlan: {
        version: 1,
        instruction: "Legacy execution.",
        provider: "codex",
        execution: { permission: "read-only", skills: [] },
      },
    });
    const path = join(dir, "config", "task-runs.json");
    const legacy = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
      runs: Record<string, Record<string, any>>;
    };
    legacy.version = 6;
    legacy.runs[run.id]!.executionPlan.execution = {
      permission: "write",
      workdir: "C:\\workspace\\legacy",
      skills: [],
    };
    writeFileSync(path, JSON.stringify(legacy), "utf8");

    const reopened = new TaskRunStore(dir, { recoverInterrupted: true });
    expect(reopened.get(run.id)).toEqual(expect.objectContaining({
      status: "failed",
      finishedAt: expect.any(Number),
      error: expect.stringMatching(/approval/i),
    }));
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(9);
  });

  test("preserves an unapproved legacy running write run as a durable failure", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({
      task: TASK,
      trigger: "scheduled",
      distill: false,
      startedAt: 450,
      executionPlan: {
        version: 1,
        instruction: "Legacy running execution.",
        provider: "codex",
        execution: { permission: "read-only", skills: [] },
      },
    });
    const path = join(dir, "config", "task-runs.json");
    const legacy = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
      runs: Record<string, Record<string, any>>;
    };
    legacy.version = 6;
    legacy.runs[run.id]!.status = "running";
    legacy.runs[run.id]!.runStartedAt = 460;
    legacy.runs[run.id]!.executionPlan.execution = {
      permission: "write",
      workdir: "C:\\workspace\\legacy-running",
      skills: [],
    };
    writeFileSync(path, JSON.stringify(legacy), "utf8");

    const clock = spyOn(Date, "now").mockReturnValue(100);
    try {
      const reopened = new TaskRunStore(dir, { recoverInterrupted: true });
      expect(reopened.get(run.id)).toEqual(expect.objectContaining({
        status: "failed",
        runStartedAt: 460,
        finishedAt: 460,
        error: expect.stringMatching(/approval/i),
      }));
      expect(new TaskRunStore(dir).get(run.id)?.finishedAt).toBe(460);
      expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(9);
    } finally {
      clock.mockRestore();
    }
  });

  test("canonicalizes a v6 terminal writable run as an honest legacy approval audit", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      startedAt: 500,
      executionPlan: {
        version: 1,
        instruction: "Legacy terminal execution.",
        provider: "codex",
        execution: { permission: "read-only", skills: [] },
      },
    });
    store.succeed(run.id, { finishedAt: 550, output: "legacy result" });
    const path = join(dir, "config", "task-runs.json");
    const legacy = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
      runs: Record<string, Record<string, any>>;
    };
    legacy.version = 6;
    legacy.runs[run.id]!.executionPlan.execution = {
      permission: "full",
      workdir: "C:\\workspace\\legacy-terminal",
      skills: [],
    };
    delete legacy.runs[run.id]!.approval;
    writeFileSync(path, JSON.stringify(legacy), "utf8");

    const reopened = new TaskRunStore(dir);
    expect(reopened.get(run.id)?.approval).toMatchObject({
      status: "legacy",
      requestedAt: 500,
      decidedAt: 550,
      decidedBy: "homeagent.archive-v10",
      reason: expect.stringMatching(/not recorded/i),
    });
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(9);

    const dishonest = JSON.parse(readFileSync(path, "utf8"));
    dishonest.runs[run.id].approval.decidedAt = 551;
    writeFileSync(path, JSON.stringify(dishonest), "utf8");
    expect(new TaskRunStore(dir).get(run.id)).toBeUndefined();
  });

  test("rejects a current v8 risky run whose approval audit was removed", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      startedAt: 600,
      approvalRequired: true,
      executionPlan: {
        version: 1,
        instruction: "Current risky execution.",
        provider: "codex",
        execution: {
          permission: "write",
          workdir: "C:\\workspace\\current-risky",
          skills: [],
        },
      },
    });
    store.approve(run.id, { decidedAt: 610, decidedBy: "ou_approver" });
    store.begin(run.id, 620);
    store.succeed(run.id, { finishedAt: 650, output: "done" });
    const path = join(dir, "config", "task-runs.json");
    const corrupted = JSON.parse(readFileSync(path, "utf8"));
    delete corrupted.runs[run.id].approval;
    writeFileSync(path, JSON.stringify(corrupted), "utf8");

    const reopened = new TaskRunStore(dir);
    expect(reopened.get(run.id)).toBeUndefined();
    expect(reopened.list()).toEqual([]);
  });

  test("terminal transitions clamp rollback timestamps and survive restart", () => {
    const store = new TaskRunStore(dir);
    const startReadOnly = (startedAt: number) => store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      startedAt,
      executionPlan: {
        version: 1,
        instruction: "Clamp terminal time.",
        provider: "codex",
        execution: { permission: "read-only", skills: [] },
      },
    });
    const succeeded = startReadOnly(1_000);
    store.begin(succeeded.id, 1_100);
    store.succeed(succeeded.id, { finishedAt: 900, output: "done" });
    const failed = startReadOnly(2_000);
    store.begin(failed.id, 2_100);
    store.fail(failed.id, { finishedAt: 1_900, error: "failed" });
    const cancelled = startReadOnly(3_000);
    store.begin(cancelled.id, 3_100);
    store.cancel(cancelled.id, { finishedAt: 2_900, error: "cancelled" });
    const rejected = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      startedAt: 4_000,
      approvalRequired: true,
      executionPlan: {
        version: 1,
        instruction: "Reject safely.",
        provider: "codex",
        execution: {
          permission: "write",
          workdir: "C:\\workspace\\reject",
          skills: [],
        },
      },
    });
    store.reject(rejected.id, { decidedAt: 4_000, decidedBy: "ou_reviewer" });

    const reopened = new TaskRunStore(dir);
    expect(reopened.get(succeeded.id)?.finishedAt).toBe(1_100);
    expect(reopened.get(failed.id)?.finishedAt).toBe(2_100);
    expect(reopened.get(cancelled.id)?.finishedAt).toBe(3_100);
    expect(reopened.get(rejected.id)?.finishedAt).toBe(4_000);
  });

  test("approval time bounds execution and completion when the clock rolls back", () => {
    const store = new TaskRunStore(dir);
    const pending = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      startedAt: 5_000,
      approvalRequired: true,
      executionPlan: {
        version: 1,
        instruction: "Preserve approval chronology.",
        provider: "codex",
        execution: {
          permission: "write",
          workdir: "C:\\workspace\\clock-rollback",
          skills: [],
        },
      },
    });
    store.approve(pending.id, {
      decidedAt: 5_200,
      decidedBy: "ou_reviewer",
    });

    expect(store.begin(pending.id, 5_100)?.runStartedAt).toBe(5_200);
    expect(store.succeed(pending.id, {
      finishedAt: 5_150,
      output: "done",
    })?.finishedAt).toBe(5_200);

    const reopened = new TaskRunStore(dir);
    expect(reopened.get(pending.id)).toEqual(expect.objectContaining({
      runStartedAt: 5_200,
      finishedAt: 5_200,
    }));

    const directSuccess = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      startedAt: 5_300,
      approvalRequired: true,
      executionPlan: {
        version: 1,
        instruction: "Complete directly after approval.",
        provider: "codex",
        execution: {
          permission: "write",
          workdir: "C:\\workspace\\direct-success",
          skills: [],
        },
      },
    });
    store.approve(directSuccess.id, { decidedAt: 5_500, decidedBy: "ou_reviewer" });
    expect(store.succeed(directSuccess.id, {
      finishedAt: 5_400,
      output: "done",
    })).toEqual(expect.objectContaining({
      runStartedAt: 5_500,
      finishedAt: 5_500,
    }));

    const queuedFailure = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      startedAt: 5_600,
      approvalRequired: true,
      executionPlan: {
        version: 1,
        instruction: "Fail setup after approval.",
        provider: "codex",
        execution: {
          permission: "write",
          workdir: "C:\\workspace\\queued-failure",
          skills: [],
        },
      },
    });
    store.approve(queuedFailure.id, { decidedAt: 5_800, decidedBy: "ou_reviewer" });
    const queuedFailureResult = store.fail(queuedFailure.id, {
      finishedAt: 5_700,
      error: "setup failed",
    });
    expect(queuedFailureResult).toEqual(expect.objectContaining({
      finishedAt: 5_800,
    }));
    expect(queuedFailureResult?.runStartedAt).toBeUndefined();
  });

  test("rejects persisted execution timestamps that predate approval", () => {
    const store = new TaskRunStore(dir);
    const pending = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      startedAt: 6_000,
      approvalRequired: true,
      executionPlan: {
        version: 1,
        instruction: "Validate approval chronology.",
        provider: "codex",
        execution: {
          permission: "write",
          workdir: "C:\\workspace\\invalid-chronology",
          skills: [],
        },
      },
    });
    store.approve(pending.id, { decidedAt: 6_100, decidedBy: "ou_reviewer" });
    store.begin(pending.id, 6_200);
    store.succeed(pending.id, { finishedAt: 6_300, output: "done" });
    const path = join(dir, "config", "task-runs.json");
    const corrupted = JSON.parse(readFileSync(path, "utf8"));
    corrupted.runs[pending.id].runStartedAt = 6_050;
    writeFileSync(path, JSON.stringify(corrupted), "utf8");

    expect(new TaskRunStore(dir).get(pending.id)).toBeUndefined();
  });

  test("terminal runs cannot be rewritten by another terminal transition", () => {
    const store = new TaskRunStore(dir);
    const pending = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      startedAt: 7_000,
      approvalRequired: true,
      executionPlan: {
        version: 1,
        instruction: "Keep rejection terminal.",
        provider: "codex",
        execution: {
          permission: "write",
          workdir: "C:\\workspace\\terminal-rewrite",
          skills: [],
        },
      },
    });
    store.reject(pending.id, {
      decidedAt: 7_100,
      decidedBy: "ou_reviewer",
      reason: "Rejected once.",
    });

    expect(store.succeed(pending.id, {
      finishedAt: 7_200,
      output: "must not resurrect",
    })).toBeUndefined();
    expect(store.fail(pending.id, {
      finishedAt: 7_200,
      error: "must not rewrite",
    })).toBeUndefined();
    expect(store.cancel(pending.id, {
      finishedAt: 7_200,
      error: "must stay unchanged",
    })).toBeUndefined();
    expect(store.timeout(pending.id, {
      finishedAt: 7_200,
      error: "must not rewrite",
    })).toBeUndefined();

    expect(new TaskRunStore(dir).get(pending.id)).toEqual(expect.objectContaining({
      status: "cancelled",
      finishedAt: 7_100,
      error: "Rejected once.",
      approval: expect.objectContaining({ status: "rejected" }),
    }));
  });

  test("treats awaiting approval as active during restore", () => {
    const source = new TaskRunStore(dir);
    const pending = source.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      approvalRequired: true,
      executionPlan: {
        version: 1,
        instruction: "Await review.",
        provider: "codex",
        execution: {
          permission: "write",
          workdir: "C:\\workspace\\restore",
          skills: [],
        },
      },
    });

    const target = new TaskRunStore(join(dir, "restore-target"));
    expect(() => target.restore([pending])).toThrow("cannot restore an active task run");
    expect(target.list()).toEqual([]);
  });

  test("restore rejects a terminal run that the persisted schema cannot reopen", () => {
    const source = new TaskRunStore(dir);
    const pending = source.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      startedAt: 700,
      approvalRequired: true,
      executionPlan: {
        version: 1,
        instruction: "Validate restored approval.",
        provider: "codex",
        execution: {
          permission: "write",
          workdir: "C:\\workspace\\restore-schema",
          skills: [],
        },
      },
    });
    source.approve(pending.id, { decidedAt: 710, decidedBy: "ou_reviewer" });
    source.begin(pending.id, 720);
    const completed = source.succeed(pending.id, {
      finishedAt: 730,
      output: "done",
    })!;
    completed.approval!.decidedBy = "";

    const target = new TaskRunStore(join(dir, "invalid-restore-target"));
    expect(() => target.restore([completed])).toThrow(/invalid task run/i);
    expect(target.list()).toEqual([]);
  });

  test("persists queued work and only marks it running when admitted", () => {
    const store = new TaskRunStore(dir);
    const queued = store.start({
      task: TASK,
      trigger: "scheduled",
      distill: false,
      startedAt: 100,
    });

    expect(queued).toEqual(expect.objectContaining({
      status: "queued",
      priority: "scheduled",
      queuedAt: 100,
    }));
    expect(new TaskRunStore(dir, { recoverInterrupted: true }).get(queued.id)?.status)
      .toBe("queued");
    expect(store.begin(queued.id, 120)).toEqual(expect.objectContaining({
      status: "running",
      runStartedAt: 120,
    }));
  });

  test("recovers an interrupted running record as a durable failure", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({ task: TASK, trigger: "manual", distill: false });
    store.begin(run.id);

    const secondary = new TaskRunStore(dir);
    expect(secondary.get(run.id)?.status).toBe("running");

    const reopened = new TaskRunStore(dir, { recoverInterrupted: true });

    expect(reopened.get(run.id)).toEqual(expect.objectContaining({
      status: "failed",
      error: "应用在任务完成前停止，运行已标记为失败",
      finishedAt: expect.any(Number),
    }));
  });

  test("retains the latest 100 completed runs per task", () => {
    const store = new TaskRunStore(dir);
    for (let index = 0; index <= MAX_TASK_RUN_HISTORY_PER_TASK; index += 1) {
      const run = store.start({ task: TASK, trigger: "scheduled", distill: false });
      store.succeed(run.id, {
        finishedAt: run.startedAt,
        output: `运行输出 ${index}`,
        summary: `运行输出 ${index}`,
      });
    }

    const runs = store.list(TASK.id);
    expect(runs).toHaveLength(MAX_TASK_RUN_HISTORY_PER_TASK);
    expect(runs[0]?.output).toBe("运行输出 100");
    expect(runs.at(-1)?.output).toBe("运行输出 1");
  });

  test("bounds persisted output while recording that it was truncated", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({ task: TASK, trigger: "manual", distill: false });
    store.succeed(run.id, {
      finishedAt: run.startedAt,
      output: "x".repeat(MAX_TASK_RUN_OUTPUT_CHARACTERS + 1),
    });

    expect(store.get(run.id)).toEqual(expect.objectContaining({
      output: "x".repeat(MAX_TASK_RUN_OUTPUT_CHARACTERS),
      outputTruncated: true,
    }));
  });

  test("bounds persisted errors", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({ task: TASK, trigger: "manual", distill: false });
    store.fail(run.id, {
      finishedAt: run.startedAt,
      error: "e".repeat(MAX_TASK_RUN_ERROR_CHARACTERS + 1),
    });

    expect(store.get(run.id)?.error).toBe("e".repeat(MAX_TASK_RUN_ERROR_CHARACTERS));
  });

  test("keeps runs and the monotonic timestamp unchanged when persistence fails", () => {
    const store = new TaskRunStore(dir);
    const persist = (TaskRunStore.prototype as unknown as {
      persist: () => void;
    }).persist.bind(store);
    Object.defineProperty(store, "persist", {
      configurable: true,
      value: () => {
        throw new Error("disk unavailable");
      },
    });

    expect(() => store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      startedAt: 100,
    })).toThrow("disk unavailable");
    expect(store.list()).toEqual([]);

    Object.defineProperty(store, "persist", { configurable: true, value: persist });
    const run = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      startedAt: 100,
    });
    expect(run.startedAt).toBe(100);
  });

  test("persists the Agent execution selected when a run starts", () => {
    const store = new TaskRunStore(dir);

    const run = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      agentId: "agent_codex",
      provider: "codex",
      model: "gpt-5.6-luna",
    });

    expect(new TaskRunStore(dir).get(run.id)).toEqual(expect.objectContaining({
      agentId: "agent_codex",
      provider: "codex",
      model: "gpt-5.6-luna",
    }));
  });

  test("persists and deep-clones the resolved execution plan captured when a run starts", () => {
    const store = new TaskRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Use the original task persona.",
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      execution: {
        permission: "write",
        workdir: "C:\\workspace\\original",
        skills: ["code-review"],
      },
    };

    const run = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      approvalRequired: true,
      executionPlan,
    });
    executionPlan.execution!.skills[0] = "mutated";

    expect(new TaskRunStore(dir).get(run.id)?.executionPlan).toEqual({
      version: 1,
      instruction: "Use the original task persona.",
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      execution: {
        permission: "write",
        workdir: "C:\\workspace\\original",
        skills: ["code-review"],
      },
    });
    expect(JSON.parse(readFileSync(join(dir, "config", "task-runs.json"), "utf8")).version)
      .toBe(9);
  });

  test("rejects an invalid resolved execution plan before persisting a run", () => {
    const store = new TaskRunStore(dir);

    expect(() => store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      executionPlan: {
        version: 1,
        instruction: "Use a task Skill.",
        execution: {
          permission: "full",
          skills: ["code-review"],
        },
      },
    })).toThrow("Resolved execution plan");
    expect(store.list()).toEqual([]);
  });

  test("rejects a resolved Task plan without an execution grant or resolution error", () => {
    const store = new TaskRunStore(dir);

    expect(() => store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      executionPlan: {
        version: 1,
        instruction: "Research safely.",
        provider: "claude",
      },
    })).toThrow("task execution grant");
    expect(store.list()).toEqual([]);
  });

  test("persists and deep-clones the Skill evidence captured when a run starts", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      skillEvidence: {
        requested: [{
          kind: "source",
          sourceKey: "codex-user:review",
          name: "review",
        }],
        resolved: [{
          sourceKey: "codex-user:review",
          name: "review",
          invocationName: "review",
          reference: "$review",
          skillFileHash: "a".repeat(64),
        }],
        skipped: [],
      },
    });

    run.skillEvidence!.resolved[0]!.name = "mutated";
    const reopened = new TaskRunStore(dir);
    expect(reopened.get(run.id)?.skillEvidence).toEqual({
      requested: [{
        kind: "source",
        sourceKey: "codex-user:review",
        name: "review",
      }],
      resolved: [{
        sourceKey: "codex-user:review",
        name: "review",
        invocationName: "review",
        reference: "$review",
        skillFileHash: "a".repeat(64),
      }],
      skipped: [],
    });
    expect(JSON.parse(readFileSync(join(dir, "config", "task-runs.json"), "utf8")).version).toBe(9);
  });

  test("rejects unbounded Skill evidence before persisting a run", () => {
    const store = new TaskRunStore(dir);

    expect(() => store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      skillEvidence: {
        requested: Array.from({ length: 51 }, (_, index) => ({
          kind: "legacy-name" as const,
          name: `skill-${index}`,
        })),
        resolved: [],
        skipped: [],
      },
    })).toThrow("Skill evidence");
    expect(store.list()).toEqual([]);
  });

  test("lists only exact Agent runs newest first with a bounded limit", () => {
    const store = new TaskRunStore(dir);
    store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      agentId: "agent_other",
      provider: "claude",
      startedAt: 10,
    });
    const older = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      agentId: "agent_codex",
      provider: "codex",
      startedAt: 20,
    });
    const newer = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      agentId: "agent_codex",
      provider: "codex",
      startedAt: 30,
    });

    expect(store.listByAgent("agent_codex", 1).map((run) => run.id)).toEqual([newer.id]);
    expect(store.listByAgent("agent_codex", 1000).map((run) => run.id)).toEqual([
      newer.id,
      older.id,
    ]);
    const listed = store.listByAgent("agent_codex");
    listed[0]!.taskName = "mutated";
    expect(store.get(newer.id)?.taskName).toBe(TASK.name);
  });

  test("loads version 2 history but rejects unknown file versions and providers", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      agentId: "agent_legacy",
      provider: "codex",
    });
    const path = join(dir, "config", "task-runs.json");
    const legacy = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
      runs: Record<string, Record<string, unknown>>;
    };
    legacy.version = 2;
    delete legacy.runs[run.id]!.agentId;
    delete legacy.runs[run.id]!.provider;
    writeFileSync(path, JSON.stringify(legacy), "utf8");
    expect(new TaskRunStore(dir).get(run.id)).toBeDefined();

    legacy.version = 3;
    legacy.runs[run.id]!.provider = "gateway";
    writeFileSync(path, JSON.stringify(legacy), "utf8");
    expect(new TaskRunStore(dir).get(run.id)).toBeUndefined();

    legacy.version = 99;
    delete legacy.runs[run.id]!.provider;
    writeFileSync(path, JSON.stringify(legacy), "utf8");
    expect(new TaskRunStore(dir).list()).toEqual([]);
  });
});
