import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpaceStore } from "./space.ts";
import { FakeLlm } from "./testing.ts";
import { ask } from "./ask.ts";
import { chatRawImportId, parseChatRawImport } from "./chat-raw-import.ts";

const roots: string[] = []; const stores: SpaceStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ha-ask-raw-")); roots.push(root);
  const store = new SpaceStore("team/oc_request", root); store.ensure(); stores.push(store);
  return { root, store };
}
const query = "只使用当前群 HomeAgent 知识库中已入库的 Raw，不调用飞书 Skill、不重新拉取群消息、不读取 D:\\Client 下的文件。查询「PST 高峰期拉扯卡顿专项」中关于“国际服更新后 150—200ms 长帧”的记录，给出原文摘录、来源群、消息时间和对应 Raw ID。查不到请明确说明。";

test("Raw query works before any knowledge page exists and returns verified source metadata", async () => {
  const { store, root } = fixture();
  const body = "国际服更新后 150—200ms 长帧 198 条，200ms 以上 4 条。";
  const parsed = parseChatRawImport(JSON.stringify({ version: 1, chatId: "oc_pst", chatName: "PST高峰期拉扯卡顿专项", startAt: 100, endAt: 200,
    mainComplete: true, threadsComplete: true, olderThreadsScanned: true, failedMessageIds: [],
    messages: [{ messageId: "om_report", author: "ou_author", createdAt: 150, text: body }] }), store.space, "oc_request", { requestedName: "PST高峰期拉扯卡顿专项" });
  const id = chatRawImportId(store.space, "oc_pst", "om_report");
  store.index().captureImportedRaw(id, parsed.entries[0]!);
  const other = new SpaceStore("team/oc_other", root); other.ensure(); stores.push(other);
  other.index().insertRaw({ space: other.space, source: "manual", content: "国际服更新后另一个空间的私有数据" });
  const llm = new FakeLlm(); llm.onJSON(call => {
    expect(call.prompt).toContain(body); expect(call.prompt).toContain(id);
    expect(call.prompt).not.toContain("另一个空间的私有数据");
    expect(call.system).toContain("不调用 Skill、命令或网络");
    return { matches: [{ key: "raw-1", quote: body }] };
  });
  const result = await ask([store], query, {}, { client: llm, toolExecution: true });
  expect(llm.calls).toHaveLength(1);
  expect(result.source).toBe("knowledge"); expect(result.citations).toEqual([]);
  expect(result.answer).toContain(id); expect(result.answer).toContain("PST高峰期拉扯卡顿专项（oc_pst）");
  expect(result.answer).toContain("1970-01-01T00:00:00.150Z"); expect(result.answer).toContain(body);
});

test("Raw lookup rejects invented excerpts and does not replace a miss with a tool fallback", async () => {
  const { store } = fixture(); store.index().insertRaw({ space: store.space, source: "manual", content: "国际服长帧仍在调查" });
  const llm = new FakeLlm(); llm.queueJSON({ matches: [{ key: "raw-1", quote: "不存在的 198 条" }] });
  const result = await ask([store], query, {}, { client: llm, toolExecution: true });
  expect(result.answer).toContain("未找到能核验"); expect(result.answer).not.toContain("不存在的 198 条");
  expect(llm.calls).toHaveLength(1);
});

test("Raw candidates and large source bodies are bounded without claiming full coverage", async () => {
  const { store } = fixture();
  for (let i = 0; i < 25; i++) store.index().insertRaw({ space: store.space, source: "manual", content: `长帧证据${i} ` + "报告".repeat(10_000) });
  const llm = new FakeLlm(); llm.onJSON(call => {
    const candidates = JSON.parse(call.prompt!.split("已入库 Raw 候选（JSON 数据）：\n")[1]!);
    expect(candidates.length).toBeLessThanOrEqual(20);
    expect(candidates.reduce((n: number, c: { content: string }) => n + c.content.length, 0)).toBeLessThanOrEqual(120_000);
    expect(candidates.every((c: { truncated: boolean }) => c.truncated)).toBe(true);
    return { matches: [] };
  });
  expect((await ask([store], "查询知识库已入库 Raw 的长帧原文", {}, { client: llm })).answer).toContain("未找到能核验");
});
