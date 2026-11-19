import type { KnowledgeEngine } from "@homeagent/core";
import type { SpaceId } from "@homeagent/shared";

/** Real action/run transitions driven by deterministic, isolated provider responses. */
export function workItemBrowserSamples() {
  const running = Promise.withResolvers<void>();
  const finishRun = Promise.withResolvers<void>();
  let completion: Promise<unknown> | undefined;
  let calls = 0;
  const examples = [
    { title: "复核上线清单", instruction: "核对上线前的三项检查", state: "review" },
    { title: "更新值班手册", instruction: "更新交班手册的联系人", state: "approval" },
    { title: "核验交付样本", instruction: "核对交付样本的来源记录", state: "blocked" },
    { title: "整理用户访谈", instruction: "提取访谈中的共性反馈", state: "running" },
  ] as const;
  return {
    get calls() { return calls; },
    async respond(prompt: string) {
      const sample = examples.find(({ instruction }) => prompt.includes(`## 本次动作\n${instruction}\n`));
      if (!sample) throw new Error("Unrecognized offline work action");
      calls++;
      if (sample.state === "running") {
        running.resolve();
        await finishRun.promise;
      }
      const blocked = sample.state === "blocked";
      return JSON.stringify({
        version: 1, outcome: blocked ? "blocked" : "completed",
        result: blocked ? "样本缺少来源记录。" : `已完成：${sample.instruction}。`,
        blockers: blocked ? ["样本缺少来源记录"] : [],
        checks: [{ name: "核对离线样本", status: blocked ? "failed" : "passed" }],
      });
    },
    async seed(engine: KnowledgeEngine, workdir: string) {
      const spaces = ["team/oc_work_delivery", "team/oc_work_interviews"] as const satisfies readonly SpaceId[];
      for (const space of spaces) {
        const name = space === spaces[0] ? "交付团队" : "用户研究组";
        const agent = engine.agents.create({
          name: name + "助手", provider: "claude", visibility: "Team", permission: "write", workdir,
        });
        engine.ensureSpace(space);
        engine.updateSpaceMeta(space, { name, agentId: agent.id });
      }
      for (const entry of examples) {
        const item = engine.workItems.create({
          space: entry.state === "running" ? spaces[1] : spaces[0],
          title: entry.title, brief: entry.instruction, nextActions: [entry.instruction],
        });
        const pending = engine.startWorkContinuation(item.id);
        if (entry.state === "approval") continue;
        const approved = engine.approveTaskRun(pending.run.id, "fixture-operator");
        if (entry.state === "running") {
          completion = approved.completion;
          await Promise.race([running.promise, completion.then(() => { throw new Error("Expected the running work sample"); })]);
        } else {
          await approved.completion;
        }
      }
    },
    async close() {
      finishRun.resolve();
      await completion;
    },
  };
}
