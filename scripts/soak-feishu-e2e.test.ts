import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTOMATED_FEISHU_SOAK_SCENARIOS,
  assertAgentRevisionLifecycleEvidence,
  assertWritableTaskApprovalEvidence,
  assertReadonlyTaskRetryEvidence,
  assertAgentPlatformPreconditions,
  agentPlatformEvidencePath,
  executeVerifiedScenario,
  executeVerifiedAgentPlatformScenario,
  findBotReply,
  findFreshUserMessage,
  flattenLarkMessages,
  collectLarkMessagesSince,
  isTransientLarkFailure,
  invokeLarkCliWithRetry,
  latestDeliveredLearningSession,
  postFeishuSoakAdminForm,
  parseLarkCliResult,
  parseLarkCreateTime,
  parseFeishuSoakOptions,
  resolveRequestedScenarios,
  resourceIdFromAdminRedirect,
  canRestoreTemporaryAgentBinding,
  currentSoakWindowStartedAt,
  installSoakShutdownHandlers,
  SoakCleanupRegistry,
  shouldAbortRemainingAgentPlatformScenarios,
  selectInFlightResearchRun,
  selectReusableResearchRun,
  type LarkMessage,
  type StoredAgent,
  type StoredAgentRevision,
  type StoredTask,
  type StoredTaskRun,
} from "./soak-feishu-e2e.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function message(
  id: string,
  senderId: string,
  content: string,
  threadReplies: LarkMessage[] = [],
): LarkMessage {
  return {
    message_id: id,
    content,
    sender: {
      sender_type: senderId.startsWith("ou_bot") ? "app" : "user",
      open_bot_id: senderId.startsWith("ou_bot") ? senderId : undefined,
      id: senderId,
    },
    thread_replies: threadReplies,
  };
}

describe("Feishu soak acceptance primitives", () => {
  test("offers every non-destructive driver scenario with explicit external preconditions", () => {
    expect(AUTOMATED_FEISHU_SOAK_SCENARIOS).toEqual([
      "group_binding_lifecycle",
      "message_capture",
      "mention_answer",
      "proactive_participation",
      "image_analysis",
      "attachment_extraction",
      "research_notification",
      "reminder_delivery",
      "learning_interaction",
      "distill_citation",
      "agent_revision_lifecycle",
      "writable_task_approval",
      "readonly_task_retry",
    ]);
  });

  test("adds and orders dependencies when rerunning an individual failed scenario", () => {
    expect(resolveRequestedScenarios("group_binding_lifecycle")).toEqual([
      "group_binding_lifecycle",
    ]);
    expect(resolveRequestedScenarios("learning_interaction")).toEqual([
      "attachment_extraction",
      "learning_interaction",
    ]);
    expect(resolveRequestedScenarios("distill_citation,mention_answer")).toEqual([
      "message_capture",
      "mention_answer",
      "distill_citation",
    ]);
  });

  test("requires immutable run attribution before and after an Agent rollback", () => {
    const agent: StoredAgent = {
      id: "agent_acceptance",
      name: "Acceptance Agent",
      instruction: "release one",
      provider: "claude",
      model: "",
      reasoningEffort: "",
      visibility: "Team",
      permission: "read-only",
      skills: [],
      publishedRevisionId: "agent_revision_rollback",
      createdAt: 100,
      updatedAt: 500,
    };
    const snapshot = (instruction: string) => ({
      name: agent.name,
      instruction,
      provider: agent.provider,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      visibility: agent.visibility,
      permission: agent.permission,
      skills: [...agent.skills],
    });
    const revisions: StoredAgentRevision[] = [
      {
        id: "agent_revision_rollback",
        agentId: agent.id,
        number: 5,
        source: "rollback",
        basedOnRevisionId: "agent_revision_v1",
        createdAt: 500,
        snapshot: snapshot("release one"),
      },
      {
        id: "agent_revision_v2",
        agentId: agent.id,
        number: 4,
        source: "release",
        createdAt: 300,
        snapshot: snapshot("release two"),
      },
      {
        id: "agent_revision_v1",
        agentId: agent.id,
        number: 1,
        source: "create",
        createdAt: 100,
        snapshot: snapshot("release one"),
      },
    ];
    const runs: StoredTaskRun[] = [
      {
        id: "run_v2",
        taskId: "task_lifecycle",
        taskName: "Lifecycle acceptance",
        status: "succeeded",
        startedAt: 350,
        agentId: agent.id,
        executionPlan: {
          version: 1,
          agentRevisionId: "agent_revision_v2",
          instruction: "release two",
          provider: "claude",
          model: "",
          execution: { permission: "read-only", skills: [] },
        },
        output: "V2-MARKER accepted",
        notification: { status: "sent", sentAt: 530 },
        finishedAt: 520,
      },
      {
        id: "run_rollback",
        taskId: "task_lifecycle",
        taskName: "Lifecycle acceptance",
        status: "succeeded",
        startedAt: 550,
        agentId: agent.id,
        executionPlan: {
          version: 1,
          agentRevisionId: "agent_revision_rollback",
          instruction: "release one",
          provider: "claude",
          model: "",
          execution: { permission: "read-only", skills: [] },
        },
        output: "ROLLBACK-MARKER accepted",
        notification: { status: "sent", sentAt: 620 },
      },
    ];
    const lifecycleNotices = [
      message("om_v2", "ou_bot_1", "Lifecycle acceptance\nV2-MARKER accepted"),
      message("om_rollback", "ou_bot_1", "Lifecycle acceptance\nROLLBACK-MARKER accepted"),
    ];
    const evidenceInput = () => ({
      agent,
      revisions,
      runs,
      firstRevisionId: "agent_revision_v1",
      secondRevisionId: "agent_revision_v2",
      rollbackRevisionId: "agent_revision_rollback",
      secondRevisionRunId: "run_v2",
      rollbackRunId: "run_rollback",
      businessMarkers: { secondRevision: "V2-MARKER", rollback: "ROLLBACK-MARKER" },
      businessNotices: lifecycleNotices,
      botOpenId: "ou_bot_1",
    });

    expect(assertAgentRevisionLifecycleEvidence(evidenceInput()))
      .toBe("agent_acceptance:run_v2:run_rollback");

    revisions[0]!.snapshot.instruction = "release two";
    expect(() => assertAgentRevisionLifecycleEvidence(evidenceInput()))
      .toThrow("rollback revision did not restore the v1 snapshot");
    revisions[0]!.snapshot.instruction = "release one";

    runs[0]!.executionPlan!.provider = "codex";
    expect(() => assertAgentRevisionLifecycleEvidence(evidenceInput()))
      .toThrow("v2 Run did not freeze the complete v2 execution plan");
    runs[0]!.executionPlan!.provider = "claude";

    runs[0]!.executionPlan!.agentRevisionId = "agent_revision_rollback";
    expect(() => assertAgentRevisionLifecycleEvidence(evidenceInput()))
      .toThrow("v2 Run is not attributed to the published v2 revision");
    runs[0]!.executionPlan!.agentRevisionId = "agent_revision_v2";

    runs[0]!.notification = { status: "pending" };
    expect(() => assertAgentRevisionLifecycleEvidence(evidenceInput()))
      .toThrow("v2 Run completion notification was not durably sent");
    runs[0]!.notification = { status: "sent", sentAt: 530 };

    lifecycleNotices.push(
      message("om_v2_duplicate", "ou_bot_1", "Lifecycle acceptance\nV2-MARKER accepted"),
    );
    expect(() => assertAgentRevisionLifecycleEvidence(evidenceInput()))
      .toThrow("v2 Feishu business notification expected one message, found 2");
  });

  test("requires zero pre-approval execution and one notice across a retried delivery", () => {
    const pending: StoredTaskRun = {
      id: "run_approved",
      taskId: "task_write",
      taskName: "Write acceptance",
      space: "team/oc_test",
      status: "awaiting_approval",
      startedAt: 100,
      executionPlan: {
        instruction: "write only after approval",
        execution: { permission: "write", workdir: "C:\\acceptance" },
      },
      approval: { status: "pending", requestedAt: 100, expiresAt: 200 },
      approvalNotification: { status: "pending", attempts: 0 },
    };
    const approved: StoredTaskRun = {
      ...pending,
      status: "succeeded",
      runStartedAt: 130,
      finishedAt: 160,
      output: "APPROVED-MARKER approved output",
      usage: { calls: 1 },
      rawId: "raw_approved",
      pagesWritten: 1,
      approval: {
        status: "approved",
        requestedAt: 100,
        expiresAt: 200,
        decidedAt: 120,
        decidedBy: "local-admin",
      },
      approvalNotification: {
        status: "sent",
        attempts: 1,
        sentAt: 115,
      },
      notification: { status: "sent", sentAt: 165 },
    };
    const rejected: StoredTaskRun = {
      ...pending,
      id: "run_rejected",
      status: "cancelled",
      finishedAt: 180,
      approval: {
        status: "rejected",
        requestedAt: 170,
        expiresAt: 270,
        decidedAt: 180,
        decidedBy: "local-admin",
      },
    };
    const expired: StoredTaskRun = {
      ...pending,
      id: "run_expired",
      status: "cancelled",
      finishedAt: 300,
      approval: {
        status: "expired",
        requestedAt: 190,
        expiresAt: 290,
        decidedAt: 300,
      },
    };
    const idempotency = {
      ...approved,
      id: "run_idempotency",
      rawId: "raw_idempotency",
      approvalNotification: {
        status: "sent",
        attempts: 2,
        sentAt: 115,
      },
    };
    const notices = [
      message("om_completion", "ou_bot_1", "Write acceptance APPROVED-MARKER approved output"),
      message("om_approval", "ou_bot_1", "Write acceptance\nRun：run_idempotency"),
      message("om_unrelated", "ou_bot_1", "another Run：run_other"),
    ];

    expect(assertWritableTaskApprovalEvidence({
      pending,
      approved,
      rejected,
      expired,
      idempotency,
      spaceId: "team/oc_test",
      windowStartedAt: 90,
      approvalNotices: notices,
      botOpenId: "ou_bot_1",
      completionMarker: "APPROVED-MARKER",
    })).toBe("run_approved:run_rejected:run_expired:run_idempotency");

    idempotency.id = "run_expired";
    expect(() => assertWritableTaskApprovalEvidence({
      pending,
      approved,
      rejected,
      expired,
      idempotency,
      spaceId: "team/oc_test",
      windowStartedAt: 90,
      approvalNotices: notices,
      botOpenId: "ou_bot_1",
      completionMarker: "APPROVED-MARKER",
    })).toThrow("approval evidence Run ids must be distinct");
    idempotency.id = "run_idempotency";

    expired.startedAt = 80;
    expect(() => assertWritableTaskApprovalEvidence({
      pending,
      approved,
      rejected,
      expired,
      idempotency,
      spaceId: "team/oc_test",
      windowStartedAt: 90,
      approvalNotices: notices,
      botOpenId: "ou_bot_1",
      completionMarker: "APPROVED-MARKER",
    })).toThrow("approval evidence is outside the current soak window");
    expired.startedAt = 100;

    approved.notification = { status: "pending" };
    expect(() => assertWritableTaskApprovalEvidence({
      pending,
      approved,
      rejected,
      expired,
      idempotency,
      spaceId: "team/oc_test",
      windowStartedAt: 90,
      approvalNotices: notices,
      botOpenId: "ou_bot_1",
      completionMarker: "APPROVED-MARKER",
    })).toThrow("approved Run completion notification was not durably sent");
    approved.notification = { status: "sent", sentAt: 165 };

    notices.push(
      message("om_completion_duplicate", "ou_bot_1", "Write acceptance APPROVED-MARKER approved output"),
    );
    expect(() => assertWritableTaskApprovalEvidence({
      pending,
      approved,
      rejected,
      expired,
      idempotency,
      spaceId: "team/oc_test",
      windowStartedAt: 90,
      approvalNotices: notices,
      botOpenId: "ou_bot_1",
      completionMarker: "APPROVED-MARKER",
    })).toThrow("approved Feishu business notification expected one message, found 2");
  });

  test("requires one linked read-only retry and one business output", () => {
    const parent: StoredTaskRun = {
      id: "run_parent",
      taskId: "task_retry",
      taskName: "Retry acceptance",
      status: "failed",
      trigger: "scheduled",
      startedAt: 100,
      finishedAt: 120,
      executionPlan: {
        agentRevisionId: "agent_revision_retry",
        instruction: "frozen retry instruction",
        provider: "claude",
        execution: { permission: "read-only" },
      },
      failure: { phase: "provider", kind: "overloaded", retryable: true },
      retry: {
        attempt: 1,
        maxAttempts: 2,
        status: "claimed",
        claimedByRunId: "run_child",
      },
    };
    const child: StoredTaskRun = {
      id: "run_child",
      taskId: "task_retry",
      taskName: "Retry acceptance",
      status: "succeeded",
      trigger: "retry",
      retryOf: "run_parent",
      startedAt: 60_120,
      runStartedAt: 60_121,
      finishedAt: 60_220,
      executionPlan: {
        agentRevisionId: "agent_revision_retry",
        instruction: "frozen retry instruction",
        provider: "claude",
        execution: { permission: "read-only" },
      },
      retry: { attempt: 2, maxAttempts: 2, status: "claimed" },
      output: "RETRY-OK production output",
      summary: "RETRY-OK production output",
      rawId: "raw_retry",
      pagesWritten: 1,
      notification: { status: "sent", sentAt: 60_230 },
    };
    const notices = [
      message("om_retry", "ou_bot_1", "Retry acceptance\nRETRY-OK production output"),
    ];

    expect(assertReadonlyTaskRetryEvidence({
      runs: [parent, child],
      taskId: "task_retry",
      parentRunId: "run_parent",
      retryRunId: "run_child",
      windowStartedAt: 90,
      businessMarker: "RETRY-OK",
      businessNotices: notices,
      botOpenId: "ou_bot_1",
    })).toBe("run_parent:run_child:raw_retry");

    parent.failure!.kind = "authentication";
    expect(() => assertReadonlyTaskRetryEvidence({
      runs: [parent, child],
      taskId: "task_retry",
      parentRunId: "run_parent",
      retryRunId: "run_child",
      windowStartedAt: 90,
      businessMarker: "RETRY-OK",
      businessNotices: notices,
      botOpenId: "ou_bot_1",
    })).toThrow("failure kind is not transient");
    parent.failure!.kind = "overloaded";

    child.executionPlan!.provider = "codex";
    expect(() => assertReadonlyTaskRetryEvidence({
      runs: [parent, child],
      taskId: "task_retry",
      parentRunId: "run_parent",
      retryRunId: "run_child",
      windowStartedAt: 90,
      businessMarker: "RETRY-OK",
      businessNotices: notices,
      botOpenId: "ou_bot_1",
    })).toThrow("did not reuse the frozen execution plan");
    child.executionPlan!.provider = "claude";

    expect(() => assertReadonlyTaskRetryEvidence({
      runs: [parent, child],
      taskId: "task_retry",
      parentRunId: "run_parent",
      retryRunId: "run_child",
      windowStartedAt: 90,
      businessMarker: "RETRY-OK",
      businessNotices: [...notices, message(
        "om_retry_duplicate",
        "ou_bot_1",
        "Retry acceptance\nRETRY-OK production output",
      )],
      botOpenId: "ou_bot_1",
    })).toThrow("expected one Feishu business notification, found 2");
  });

  test("accepts an admin URL and reads its secret only from the soak environment", () => {
    const options = parseFeishuSoakOptions([
      "--chat-id", "oc_test",
      "--bot-open-id", "ou_bot",
      "--admin-url", "http://127.0.0.1:3210/",
      "--scenarios", "group_binding_lifecycle",
    ], {
      HOMEAGENT_SOAK_ADMIN_TOKEN: "soak-secret",
    });

    expect(options.adminUrl).toBe("http://127.0.0.1:3210");
    expect(options.adminToken).toBe("soak-secret");
    expect(options.scenarios).toEqual(["group_binding_lifecycle"]);
    expect(() => parseFeishuSoakOptions([
      "--chat-id", "oc_test",
      "--bot-open-id", "ou_bot",
      "--admin-token", "must-not-be-an-argument",
    ])).toThrow("unknown argument");
  });

  test("fails before mutation when externally-produced approval or retry evidence is absent", () => {
    const baseArgs = [
      "--chat-id", "oc_test",
      "--bot-open-id", "ou_bot",
    ];
    const missingApproval = parseFeishuSoakOptions([
      ...baseArgs,
      "--scenarios", "writable_task_approval",
    ]);
    expect(() => assertAgentPlatformPreconditions(missingApproval)).toThrow(
      "writable_task_approval requires --approval-expired-run-id",
    );

    const missingRetry = parseFeishuSoakOptions([
      ...baseArgs,
      "--scenarios", "readonly_task_retry",
      "--retry-task-id", "task_retry",
    ]);
    expect(() => assertAgentPlatformPreconditions(missingRetry)).toThrow(
      "readonly_task_retry requires --retry-business-marker",
    );

    const ready = parseFeishuSoakOptions([
      ...baseArgs,
      "--scenarios", "writable_task_approval,readonly_task_retry",
      "--approval-expired-run-id", "run_expired",
      "--approval-idempotency-run-id", "run_idempotency",
      "--retry-task-id", "task_retry",
      "--retry-business-marker", "RETRY-20260810",
      "--window-started-at", "1786280000000",
    ]);
    expect(() => assertAgentPlatformPreconditions(ready)).not.toThrow();
    expect(ready).toEqual(expect.objectContaining({
      approvalExpiredRunId: "run_expired",
      approvalIdempotencyRunId: "run_idempotency",
      retryTaskId: "task_retry",
      retryBusinessMarker: "RETRY-20260810",
      windowStartedAt: 1_786_280_000_000,
    }));
  });

  test("uses an explicit current window when one monitor path contains two soak runs", () => {
    const root = mkdtempSync(join(tmpdir(), "homeagent-soak-window-test-"));
    roots.push(root);
    const monitorPath = join(root, "soak-24h.jsonl");
    const firstWindow = 1_786_270_000_000;
    const secondWindow = 1_786_280_000_000;
    writeFileSync(monitorPath, [
      JSON.stringify({ at: firstWindow, ok: true, latencyMs: 3 }),
      JSON.stringify({ at: firstWindow + 60_000, ok: true, latencyMs: 4 }),
      JSON.stringify({ at: secondWindow, ok: true, latencyMs: 2 }),
    ].join("\n") + "\n");

    expect(currentSoakWindowStartedAt(monitorPath, secondWindow)).toBe(secondWindow);
    expect(() => currentSoakWindowStartedAt(monitorPath, undefined))
      .toThrow("--window-started-at is required");
    expect(() => currentSoakWindowStartedAt(monitorPath, secondWindow + 60_000))
      .toThrow("has no sample in the declared current window");
  });

  test("admin mutations use bearer auth, same-origin headers, and disabled redirects", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    await postFeishuSoakAdminForm({
      adminUrl: "http://127.0.0.1:3210",
      adminToken: "soak-secret",
      path: "/integrations/groups/connect",
      form: {
        chatId: "oc_test",
        responseMode: "mentions_only",
        replyInThread: "on",
      },
      fetchImpl: async (input, init) => {
        requestedUrl = String(input);
        requestedInit = init;
        return new Response(null, {
          status: 302,
          headers: { location: "/integrations?ok=connected" },
        });
      },
    });

    expect(requestedUrl).toBe("http://127.0.0.1:3210/integrations/groups/connect");
    expect(requestedInit?.method).toBe("POST");
    expect(requestedInit?.redirect).toBe("manual");
    const headers = new Headers(requestedInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer soak-secret");
    expect(headers.get("origin")).toBe("http://127.0.0.1:3210");
    expect(headers.get("sec-fetch-site")).toBe("same-origin");
    expect(String(requestedInit?.body)).toContain("responseMode=mentions_only");

    let surfacedError: unknown;
    try {
      await postFeishuSoakAdminForm({
        adminUrl: "http://127.0.0.1:3210",
        adminToken: "soak-secret",
        path: "/integrations/groups/connect",
        form: { chatId: "oc_test", responseMode: "mentions_only" },
        fetchImpl: async () =>
          new Response("debug echo: Bearer soak-secret", { status: 500 }),
      });
    } catch (error) {
      surfacedError = error;
    }
    expect(String(surfacedError)).not.toContain("soak-secret");
  });

  test("allows only the public Agent platform management forms needed by the soak", async () => {
    const allowed = [
      "/agents",
      "/agents/agent_1",
      "/agents/agent_1/revisions/agent_revision_1/rollback",
      "/agents/agent_1/delete",
      "/spaces/team%2Foc_test/agent",
      "/tasks",
      "/tasks/task_1",
      "/tasks/task_1/run",
      "/tasks/task_1/delete",
      "/tasks/runs/run_1/approve",
      "/tasks/runs/run_1/reject",
      "/tasks/runs/run_1/cancel",
    ];
    for (const path of allowed) {
      const result = await postFeishuSoakAdminForm({
        adminUrl: "http://127.0.0.1:3210",
        path,
        form: {},
        fetchImpl: async () => new Response(null, {
          status: 303,
          headers: { location: "/accepted/resource_1" },
        }),
      });
      expect(result).toEqual({ status: 303, location: "/accepted/resource_1" });
    }

    await expect(postFeishuSoakAdminForm({
      adminUrl: "http://127.0.0.1:3210",
      path: "/settings/reset-everything",
      form: {},
      fetchImpl: async () => new Response(null, { status: 303 }),
    })).rejects.toThrow("unsupported soak administration path");
  });

  test("takes created resource ids only from same-path administration redirects", () => {
    expect(resourceIdFromAdminRedirect(
      "/agents/agent_123?ok=created",
      "/agents/",
    )).toBe("agent_123");
    expect(resourceIdFromAdminRedirect(
      "/tasks/task_456?ok=created",
      "/tasks/",
    )).toBe("task_456");
    expect(() => resourceIdFromAdminRedirect(
      "/tasks/runs/run_1?ok=started",
      "/tasks/",
    )).toThrow("did not identify one direct resource");
  });

  test("does not overwrite a concurrent space Agent assignment during cleanup", () => {
    expect(canRestoreTemporaryAgentBinding("agent_temporary", "agent_original", "agent_temporary"))
      .toBeTrue();
    expect(canRestoreTemporaryAgentBinding("agent_original", "agent_original", "agent_temporary"))
      .toBeTrue();
    expect(canRestoreTemporaryAgentBinding("agent_concurrent", "agent_original", "agent_temporary"))
      .toBeFalse();
  });

  test("SIGTERM interrupts mutations, records cleanup failure, and exits nonzero", async () => {
    const events: string[] = [];
    const failures: unknown[] = [];
    const exitCodes: number[] = [];
    const registry = new SoakCleanupRegistry();
    registry.register({
      scenario: "agent_revision_lifecycle",
      label: "F5-signal-agent",
      manualRecovery: "restore team/oc_test and remove F5-signal-agent",
      interrupt: () => events.push("interrupt"),
      cleanup: async () => {
        events.push("cleanup");
        return ["temporary Agent is still bound to a concurrent space"];
      },
    });
    const processEvents = new EventEmitter();
    const dispose = installSoakShutdownHandlers({
      registry,
      processEvents,
      timeoutMs: 1_000,
      recordFailure: (failure) => failures.push(failure),
      exit: (code) => exitCodes.push(code),
    });

    processEvents.emit("SIGTERM");
    for (let attempt = 0; attempt < 50 && exitCodes.length === 0; attempt += 1) {
      await Bun.sleep(1);
    }
    dispose();

    expect(events).toEqual(["interrupt", "cleanup"]);
    expect(exitCodes).toEqual([143]);
    expect(failures).toEqual([expect.objectContaining({
      scenario: "agent_revision_lifecycle",
      ok: false,
      reason: "SIGTERM",
      cleanupErrors: ["temporary Agent is still bound to a concurrent space"],
      manualRecovery: "restore team/oc_test and remove F5-signal-agent",
    })]);
  });

  test("keeps failed cleanup ownership and aborts later Agent platform mutations", async () => {
    const registry = new SoakCleanupRegistry();
    const registration = registry.register({
      scenario: "agent_revision_lifecycle",
      label: "F5-residual",
      manualRecovery: "restore the original Agent",
      interrupt: () => {},
      cleanup: async () => ["restore space Agent failed"],
    });

    expect(await registration.cleanup()).toEqual(["restore space Agent failed"]);
    expect(registry.size).toBe(1);
    expect(shouldAbortRemainingAgentPlatformScenarios(
      "agent_revision_lifecycle",
      registry,
    )).toBeTrue();
  });

  test("runs global cleanup serially in reverse registration order", async () => {
    const events: string[] = [];
    const registry = new SoakCleanupRegistry();
    for (const label of ["first", "second"]) {
      registry.register({
        scenario: "agent_revision_lifecycle",
        label,
        manualRecovery: `recover ${label}`,
        interrupt: () => {},
        cleanup: async () => {
          events.push(`${label}:start`);
          await Bun.sleep(1);
          events.push(`${label}:end`);
          return [];
        },
      });
    }

    await registry.shutdown("SIGINT", 1_000);
    expect(events).toEqual([
      "second:start",
      "second:end",
      "first:start",
      "first:end",
    ]);
  });

  test("treats beforeExit with owned resources as a failed bounded cleanup", async () => {
    const failures: unknown[] = [];
    const exitCodes: number[] = [];
    const registry = new SoakCleanupRegistry();
    registry.register({
      scenario: "writable_task_approval",
      label: "F5-before-exit",
      manualRecovery: "remove F5-before-exit",
      interrupt: () => {},
      cleanup: async () => [],
    });
    const processEvents = new EventEmitter();
    const dispose = installSoakShutdownHandlers({
      registry,
      processEvents,
      timeoutMs: 1_000,
      recordFailure: (failure) => failures.push(failure),
      exit: (code) => exitCodes.push(code),
    });

    processEvents.emit("beforeExit", 0);
    for (let attempt = 0; attempt < 50 && exitCodes.length === 0; attempt += 1) {
      await Bun.sleep(1);
    }
    dispose();

    expect(exitCodes).toEqual([1]);
    expect(failures).toEqual([expect.objectContaining({
      scenario: "writable_task_approval",
      reason: "beforeExit",
      cleanupErrors: [],
    })]);
  });

  test("parses successful CLI envelopes and rejects logical failures even with JSON output", () => {
    expect(parseLarkCliResult('{"ok":true,"data":{"message_id":"om_1"}}'))
      .toEqual({ ok: true, data: { message_id: "om_1" } });
    expect(() => parseLarkCliResult('{"ok":false,"error":{"message":"rate limited"}}'))
      .toThrow("rate limited");
    expect(() => parseLarkCliResult("not-json")).toThrow("invalid JSON");
  });

  test("parses Feishu second, millisecond, ISO, and CLI display timestamps", () => {
    expect(parseLarkCreateTime("1784283627")).toBe(1_784_283_627_000);
    expect(parseLarkCreateTime("1784283627136")).toBe(1_784_283_627_136);
    expect(parseLarkCreateTime("2026-07-17T18:20:00+08:00"))
      .toBe(Date.parse("2026-07-17T18:20:00+08:00"));
    expect(parseLarkCreateTime("2026-07-17 18:20"))
      .toBe(Date.parse("2026-07-17T18:20"));
  });

  test("flattens thread replies once and finds only the target bot response", () => {
    const botReply = message("om_bot", "ou_bot_1", "F5-OK");
    const root = message("om_root", "ou_user", "question", [botReply, botReply]);
    const unrelated = message("om_other", "ou_bot_1", "other");

    expect(flattenLarkMessages([root, unrelated]).map((item) => item.message_id))
      .toEqual(["om_root", "om_bot", "om_other"]);
    expect(findBotReply([root, unrelated], {
      botOpenId: "ou_bot_1",
      rootMessageId: "om_root",
      contentIncludes: ["F5-OK"],
    })?.message_id).toBe("om_bot");
    expect(findBotReply([root, unrelated], {
      botOpenId: "ou_bot_1",
      rootMessageId: "om_root",
      contentIncludes: ["missing"],
    })).toBeUndefined();
  });

  test("finds only fresh user actions for UI-sender handoff", () => {
    const notBefore = Date.parse("2026-07-17T13:00:00Z");
    const stale = {
      ...message("om_stale", "ou_user", "F5-UI-PROBE"),
      create_time: String(notBefore - 120_000),
    };
    const bot = {
      ...message("om_bot", "ou_bot_1", "F5-UI-PROBE"),
      create_time: String(notBefore + 1_000),
    };
    const fresh = {
      ...message("om_fresh", "ou_user", "F5-UI-PROBE"),
      create_time: String(notBefore + 2_000),
    };

    expect(findFreshUserMessage([stale, bot, fresh], {
      botOpenId: "ou_bot_1",
      notBefore,
      contentIncludes: "F5-UI-PROBE",
    })?.message_id).toBe("om_fresh");
    expect(findFreshUserMessage([message("om_missing_time", "ou_user", "F5-UI-PROBE")], {
      botOpenId: "ou_bot_1",
      notBefore,
      contentIncludes: "F5-UI-PROBE",
    })).toBeUndefined();
  });

  test("scopes UI-sender reply detection to the requested root", () => {
    const notBefore = Date.parse("2026-07-17T13:00:00Z");
    const reply = {
      ...message("om_reply", "ou_user", "/learn new F5-UI"),
      create_time: String(notBefore + 1_000),
    };
    const root = message("om_root", "ou_user", "[文件] fixture.txt", [reply]);

    expect(findFreshUserMessage([root], {
      botOpenId: "ou_bot_1",
      notBefore,
      contentIncludes: "F5-UI",
      rootMessageId: "om_root",
    })?.message_id).toBe("om_reply");
    expect(findFreshUserMessage([root], {
      botOpenId: "ou_bot_1",
      notBefore,
      contentIncludes: "F5-UI",
      rootMessageId: "om_other",
    })).toBeUndefined();
  });

  test("waits for the delivered learning session itself to complete", () => {
    const latest = latestDeliveredLearningSession([
      {
        id: "session_old",
        planId: "plan_1",
        status: "completed",
        deliveredAt: 1_000,
        completedAt: 1_100,
      },
      {
        id: "session_current",
        planId: "plan_1",
        status: "awaiting_reply",
        deliveredAt: 1_200,
      },
      {
        id: "session_other",
        planId: "plan_2",
        status: "completed",
        deliveredAt: 1_300,
        completedAt: 1_400,
      },
    ], "plan_1");

    expect(latest?.id).toBe("session_current");
    expect(latest?.status).toBe("awaiting_reply");
  });

  test("recognizes retryable Feishu and transport failures but not permission failures", () => {
    expect(isTransientLarkFailure(new Error("HTTP 429 Too Many Requests"))).toBeTrue();
    expect(isTransientLarkFailure(new Error("invalid response: unexpected end of JSON input")))
      .toBeTrue();
    expect(isTransientLarkFailure(new Error("ECONNRESET while reading response"))).toBeTrue();
    expect(isTransientLarkFailure(new Error("missing required scope im:message"))).toBeFalse();
  });

  test("retries a nonzero 429 with empty stdout before accepting valid JSON", async () => {
    let calls = 0;
    const result = await invokeLarkCliWithRetry(["im", "+chat-messages-list"], "/tmp", {
      attempts: 2,
      sleep: async () => {},
      processRunner: async () => {
        calls += 1;
        return calls === 1
          ? { exitCode: 1, stdout: "", stderr: "HTTP 429 Too Many Requests" }
          : { exitCode: 0, stdout: '{"ok":true,"data":{"messages":[]}}', stderr: "" };
      },
    });

    expect(calls).toBe(2);
    expect(result.ok).toBeTrue();
  });

  test("records evidence only after the scenario assertion succeeds", async () => {
    const root = mkdtempSync(join(tmpdir(), "homeagent-feishu-soak-test-"));
    roots.push(root);
    const evidence = join(root, "evidence.jsonl");

    await expect(executeVerifiedScenario(
      "message_capture",
      evidence,
      async () => "om_pass",
    )).resolves.toEqual(expect.objectContaining({ artifactId: "om_pass", ok: true }));
    await expect(executeVerifiedScenario(
      "mention_answer",
      evidence,
      async () => {
        throw new Error("reply did not contain the acceptance marker");
      },
    )).rejects.toThrow("acceptance marker");

    const lines = readFileSync(evidence, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual(expect.objectContaining({
      scenario: "message_capture",
      artifactId: "om_pass",
      ok: true,
    }));
  });

  test("paginates Feishu messages through the current soak window", async () => {
    const windowStartedAt = 1_784_000_000_000;
    const requestedTokens: Array<string | undefined> = [];
    const pages = [
      {
        messages: [{
          ...message("om_notice_new", "ou_bot_1", "Run：run_idempotency"),
          create_time: String(windowStartedAt + 2_000),
        }],
        hasMore: true,
        pageToken: "page-2",
      },
      {
        messages: [{
          ...message("om_notice_duplicate", "ou_bot_1", "Run：run_idempotency"),
          create_time: String(windowStartedAt + 1_000),
        }],
        hasMore: false,
      },
    ];

    const messages = await collectLarkMessagesSince(async (pageToken) => {
      requestedTokens.push(pageToken);
      return pages.shift()!;
    }, windowStartedAt);

    expect(requestedTokens).toEqual([undefined, "page-2"]);
    expect(messages.map((item) => item.message_id)).toEqual([
      "om_notice_new",
      "om_notice_duplicate",
    ]);
  });

  test("isolates Agent platform evidence and records it only after verification", async () => {
    const root = mkdtempSync(join(tmpdir(), "homeagent-agent-platform-soak-test-"));
    roots.push(root);
    const legacyEvidence = join(root, "soak-evidence.jsonl");
    const platformEvidence = agentPlatformEvidencePath(legacyEvidence);

    await expect(executeVerifiedAgentPlatformScenario(
      "agent_revision_lifecycle",
      platformEvidence,
      async () => "agent_1:run_v2:run_rollback",
      () => ({
        triggerPath: "web_admin_post",
        windowStartedAt: 1_786_280_000_000,
        resourceIds: { agentId: "agent_1" },
        runs: [{
          id: "run_v2",
          status: "succeeded",
          instruction: "SENSITIVE-INSTRUCTION",
          output: "SENSITIVE-OUTPUT",
        }],
        messages: [{
          id: "om_1",
          contentSha256: "a".repeat(64),
          content: "SENSITIVE-MESSAGE",
        }],
        prompt: "SENSITIVE-PROMPT",
      }),
    )).resolves.toEqual(expect.objectContaining({
      scenario: "agent_revision_lifecycle",
      artifactId: "agent_1:run_v2:run_rollback",
      ok: true,
      details: expect.objectContaining({ triggerPath: "web_admin_post" }),
    }));
    await expect(executeVerifiedAgentPlatformScenario(
      "writable_task_approval",
      platformEvidence,
      async () => {
        throw new Error("expired approval evidence is missing");
      },
    )).rejects.toThrow("expired approval evidence is missing");

    const records = readFileSync(platformEvidence, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(expect.objectContaining({
      details: expect.objectContaining({
        runs: [{ id: "run_v2", status: "succeeded" }],
      }),
    }));
    const serialized = JSON.stringify(records[0]);
    expect(serialized).not.toContain("SENSITIVE-");
    expect(serialized).not.toMatch(/"(?:instruction|output|content|prompt)"/u);
    expect(() => readFileSync(legacyEvidence, "utf8")).toThrow();
  });

  test("reuses only a succeeded notified research run inside the current soak window", () => {
    const tasks: StoredTask[] = [{
      id: "task_1",
      name: "F5 research",
      space: "team/oc_test",
      notify: true,
    }];
    const runs: StoredTaskRun[] = [
      {
        id: "run_old",
        taskId: "task_1",
        status: "succeeded",
        trigger: "chat",
        startedAt: 900,
        finishedAt: 950,
        rawId: "raw_old",
        pagesWritten: 1,
        notification: { status: "sent" },
      },
      {
        id: "run_failed",
        taskId: "task_1",
        status: "failed",
        trigger: "chat",
        startedAt: 1_100,
        finishedAt: 1_150,
        notification: { status: "sent" },
      },
      {
        id: "run_current",
        taskId: "task_1",
        status: "succeeded",
        trigger: "chat",
        startedAt: 1_200,
        finishedAt: 1_300,
        rawId: "raw_current",
        pagesWritten: 1,
        notification: { status: "sent" },
      },
    ];

    expect(selectReusableResearchRun(tasks, runs, {
      chatId: "oc_test",
      windowStartedAt: 1_000,
    })?.run.id).toBe("run_current");
    expect(selectReusableResearchRun(tasks, runs, {
      chatId: "oc_other",
      windowStartedAt: 1_000,
    })).toBeUndefined();
  });

  test("waits for an in-flight research run instead of starting a duplicate", () => {
    const tasks: StoredTask[] = [{
      id: "task_1",
      name: "F5 research",
      space: "team/oc_test",
      notify: true,
    }];
    const runs: StoredTaskRun[] = [{
      id: "run_active",
      taskId: "task_1",
      status: "running",
      trigger: "chat",
      startedAt: 1_200,
    }];

    expect(selectInFlightResearchRun(tasks, runs, {
      chatId: "oc_test",
      windowStartedAt: 1_000,
    })?.run.id).toBe("run_active");
  });
});
