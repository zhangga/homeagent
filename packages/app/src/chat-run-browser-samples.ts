import { CliConnector, type Connector } from "@homeagent/connectors";
import type { KnowledgeEngine } from "@homeagent/core";
import { Orchestrator } from "@homeagent/orchestrator";
import type { ProviderProgressEvent } from "@homeagent/shared";

const questions = {
  answer: "周五的交接会是几点？",
  cancel: "下一班班车几点出发？",
  failure: "周末的开放时间是几点？",
};
type Example = keyof typeof questions;
const space = "team/oc_chat_browser";
const chatId = "oc_chat_browser";

/** Real message intake, Run lifecycle and retries. Only provider output and outbound transport are simulated. */
export function chatRunBrowserSamples(engine: KnowledgeEngine, workdir: string) {
  const agent = engine.agents.create({ name: "值班助手", provider: "claude", visibility: "Team",
    permission: "read-only", workdir });
  engine.ensureSpace(space, { chatId });
  engine.updateSpaceMeta(space, { name: "值班交接群", agentId: agent.id });
  engine.feishuBindings.connect({ spaceId: space, chatId, boundAppId: "cli_offline_chat",
    responseMode: "mentions_only", replyInThread: true });
  const transport = new CliConnector();
  const ready = { answer: Promise.withResolvers<void>(), cancel: Promise.withResolvers<void>(), failure: Promise.withResolvers<void>() };
  const finishAnswer = Promise.withResolvers<void>();
  const finishFailure = Promise.withResolvers<void>();
  const deliveryStarted = Promise.withResolvers<void>();
  const finishDelivery = Promise.withResolvers<void>();
  const calls = { answer: 0, cancel: 0, failure: 0, answerDelivery: 0 };
  const inflight = new Map<Example, Promise<void>>();
  const connector: Connector = {
    name: "feishu", start: handler => transport.start(handler), stop: () => transport.stop(),
    notice: (chat, text, options) => transport.notice(chat, text, options),
    async reply(reply) {
      if (reply.replyToMessageId === "om_chat_answer" && ++calls.answerDelivery === 1) {
        deliveryStarted.resolve();
        await finishDelivery.promise;
        throw new Error("离线飞书通道暂时不可用");
      }
      return transport.reply(reply);
    },
  };
  const runtime = new Orchestrator({ engine, connector });
  return {
    agentId: agent.id, calls, runtime,
    async respond(prompt: string, signal?: AbortSignal, onProgress?: (event: ProviderProgressEvent) => Promise<void> | void) {
      const sample = (Object.keys(questions) as Example[]).find(key => prompt.includes(questions[key]));
      if (!sample) throw new Error("Unexpected offline chat prompt");
      calls[sample]++;
      ready[sample].resolve();
      if (sample === "cancel") {
        if (signal?.aborted) throw signal.reason;
        if (!signal) throw new Error("Expected a cancellable chat provider");
        await new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      if (sample === "failure") {
        if (calls.failure > 1) return "周末的开放时间是上午九点至下午五点。";
        await finishFailure.promise;
        throw new Error("离线回答服务暂时不可用");
      }
      await onProgress?.({ kind: "assistant_snapshot", visibility: "public", at: Date.now(), title: "进度说明", delta: "正在核对值班安排。" });
      await finishAnswer.promise;
      return "交接会定在周五下午三点，请提前准备交接记录。";
    },
    async control(command: string): Promise<Response> {
      if (command === "finish-answer") {
        finishAnswer.resolve();
        await Promise.race([deliveryStarted.promise, inflight.get("answer")]);
      } else if (command === "fail-delivery") {
        finishDelivery.resolve();
        await Promise.allSettled([inflight.get("answer")]);
      }
      else if (command === "fail-answer") finishFailure.resolve();
      else if (command === "answer" || command === "cancel" || command === "failure") {
        const messageId = "om_chat_" + command;
        if (!inflight.has(command)) {
          const completion = transport.inject({ kind: "message", chatType: "group", chatId, eventId: messageId, messageId,
            senderId: "ou_offline_browser", mentionsBot: true, text: questions[command], createdAt: Date.now() });
          inflight.set(command, completion);
          // A held provider lets the browser open the Run before releasing either output or delivery.
          await Promise.race([ready[command].promise, completion]);
        }
        const run = engine.chatRuns.list(space).find(run => run.messageId === messageId && !run.retryOf);
        if (!run) throw new Error("Offline sample did not create a Chat Run");
        return Response.json({ id: run.id, question: questions[command] });
      } else return new Response(null, { status: 404 });
      return new Response(null, { status: 204 });
    },
    async close() {
      finishAnswer.resolve(); finishFailure.resolve(); finishDelivery.resolve();
      await runtime.stop();
      await Promise.allSettled(inflight.values());
    },
  };
}
