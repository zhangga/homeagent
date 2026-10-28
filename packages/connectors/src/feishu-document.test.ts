import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_MATERIAL_FILES } from "@homeagent/shared";
import { documentImages } from "./feishu-document.ts";
import { FeishuConnector } from "./feishu.ts";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

test("resolves image aliases, inline tokens and Markdown while ignoring code and other resources", () => {
  const content = '<img ref="picture_1"/>\n<img token="token_2" caption="A &amp; B"/>\n![third](token_3)\n![again](token_3)\n![remote][remote]\n[remote]: https://example.com/image.png\n`<img token="code"/>`\n```xml\n<img token="example"/>\n```';
  expect(documentImages(content, { image: { picture_1: { token: "token_1", name: "流程.png" } },
    comments: { comment_1: { token: "not_image" } }, sheet: { sheet_1: { token: "not_image" } } })).toEqual([
    { attachment: { kind: "image", ref: "picture_1", name: "流程.png" }, token: "token_1" },
    { attachment: { kind: "image", ref: "token_2", name: "A & B" }, token: "token_2" },
    { attachment: { kind: "image", ref: "token_3", name: "third" }, token: "token_3" },
    { attachment: { kind: "image", ref: "https://example.com/image.png", name: "remote" } },
  ]);
});

test("does not count sidecar tokens twice and retains unresolved image blocks", () => {
  expect(documentImages('<img token="token_1"/>\n![same](token_1)\n<img/>', {
    img: { image_1: { token: "token_1" } },
  })).toEqual([
    { attachment: { kind: "image", ref: "image_1" }, token: "token_1" },
    { attachment: { kind: "image", ref: "unresolved-image-2" } },
  ]);
});

test("downloads full-detail document images as user; leaves failed references and removes temporary files", async () => {
  const directories: string[] = [];
  const calls: string[][] = [];
  const content = '# 工作流\n<img ref="image_1"/>\n<img token="denied"/>\n![外链](https://example.com/image.png)\n末尾';
  const connector = new FeishuConnector({ runCommand: async (cmd, opts) => {
    calls.push(cmd);
    if (cmd.includes("+fetch")) return JSON.stringify({ ok: true, data: { document: { content,
      reference_map: { image: { image_1: { token: "available", caption: "流程" } } } } } });
    directories.push(opts!.cwd!);
    expect(cmd).toContain("user");
    expect(opts?.maxOutputBytes).toBe(20 * 1024 * 1024);
    writeFileSync(join(opts!.cwd!, "image.bin"), png);
    if (cmd.includes("denied")) return JSON.stringify({ ok: false });
    return JSON.stringify({ ok: true });
  } });
  const result = await connector.fetchDocWithImages("https://example.larkoffice.com/wiki/article");
  try {
    expect(calls[0]).toContain("--detail");
    expect(calls[0]).toContain("full");
    expect(calls).toHaveLength(3);
    expect(result?.content).toBe(content);
    expect(result?.images).toHaveLength(3);
    expect(result?.downloads).toHaveLength(1);
    expect(result?.downloads[0]?.attachment).toEqual({ kind: "image", ref: "image_1", name: "流程.png" });
    expect(new Uint8Array(readFileSync(result!.downloads[0]!.localPath))).toEqual(png);
    expect(existsSync(directories[1]!)).toBe(false);
  } finally { for (const download of result?.downloads ?? []) download.cleanup(); }
  expect(directories.every(directory => !existsSync(directory))).toBe(true);
});

test.each(["oversize", "empty", "missing", "failed"])("keeps the complete body when image download is %s", async failure => {
  const directories: string[] = [];
  const connector = new FeishuConnector({ maxAttachmentBytes: 10, runCommand: async (cmd, opts) => {
    if (cmd.includes("+fetch")) return JSON.stringify({ content: '# article\n<img src="image_token"/>\nend' });
    directories.push(opts!.cwd!);
    if (failure === "failed") throw new Error("private diagnostic");
    if (failure !== "missing") writeFileSync(join(opts!.cwd!, "image.bin"), failure === "empty" ? new Uint8Array() : png);
    return JSON.stringify({ ok: true });
  } });
  const result = await connector.fetchDocWithImages("doc");
  expect(result?.content.endsWith("end")).toBe(true);
  expect(result?.images).toHaveLength(1);
  expect(result?.downloads).toHaveLength(0);
  expect(directories.every(directory => !existsSync(directory))).toBe(true);
});

test("retains more than forty images and uses the existing document import reference budget", async () => {
  let count = 41;
  const connector = new FeishuConnector({ runCommand: async cmd => {
    if (cmd.includes("+fetch")) return JSON.stringify({ content: "# full body", reference_map: {
      image: Object.fromEntries(Array.from({ length: count }, (_, i) => [`ref_${i}`, { url: `https://example.com/${i}.png` }])) } });
    throw new Error("no remote URL requests expected");
  } });
  expect((await connector.fetchDocWithImages("doc"))?.images).toHaveLength(41);
  count = MAX_MATERIAL_FILES;
  expect((await connector.fetchDocWithImages("doc"))?.images).toHaveLength(MAX_MATERIAL_FILES);
  count++;
  const result = await connector.fetchDocWithImages("doc");
  expect(result?.content).toBe("# full body");
  expect(result?.imageNotice).toContain("配图原件未保存");
});
