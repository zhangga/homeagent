import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTOMATED_FEISHU_SOAK_SCENARIOS,
  executeVerifiedScenario,
  findBotReply,
  findFreshUserMessage,
  flattenLarkMessages,
  isTransientLarkFailure,
  invokeLarkCliWithRetry,
  latestDeliveredLearningSession,
  postFeishuSoakAdminForm,
  parseLarkCliResult,
  parseLarkCreateTime,
  parseFeishuSoakOptions,
  resolveRequestedScenarios,
  selectInFlightResearchRun,
  selectReusableResearchRun,
  type LarkMessage,
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
  test("automates every business scenario except the destructive network recovery check", () => {
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

    const lines = readFileSync(evidence, "utf8").trim().split("\n").map(JSON.parse);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual(expect.objectContaining({
      scenario: "message_capture",
      artifactId: "om_pass",
      ok: true,
    }));
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
