import { expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frozenReplyFileBytes, isChatReplyFile, namesReplyFile, prepareReplyFile } from "./chat-reply-file.ts";

test("source material and complete explicit output names select distinct files", () => {
  expect(namesReplyFile("根据 data.xlsx 生成周报并作为附件发到本群", "周报.md", true)).toBe(true);
  expect(namesReplyFile("根据 data.xlsx 生成周报.md 并发给我", "data.xlsx", true)).toBe(false);
  expect(namesReplyFile("把 old-report.md 发到本群", "report.md")).toBe(false);
  expect(namesReplyFile("把刚生成的周报.md发到本群", "周报.md")).toBe(true);
  expect(namesReplyFile("把 “weekly report.docx” 发给我", "weekly report.docx")).toBe(true);
});

test("only the exact final file from the dedicated directory can be uploaded", () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "ha-file-boundary-")));
  try {
    const capture = prepareReplyFile(workdir, "生成 report.pdf 并发给我", true);
    const dir = JSON.parse(capture.instruction.match(/专属目录 ("[^\n]+?") 中/u)![1]!) as string;
    mkdirSync(dir);
    const path = join(dir, "report.pdf");
    const sidecar = join(dir, "internal.json");
    writeFileSync(path, "frozen content");
    const file = capture.finish()!;
    expect(isChatReplyFile(file)).toBe(true);
    expect(new TextDecoder().decode(frozenReplyFileBytes(workdir, file))).toBe("frozen content");
    writeFileSync(sidecar, "must not be uploaded alongside the report");
    expect(capture.finish()).toBeUndefined();
    unlinkSync(sidecar);
    writeFileSync(path, "edited content");
    expect(() => frozenReplyFileBytes(workdir, file)).toThrow();
    const another = join(workdir, "another-file.pdf");
    writeFileSync(another, "unrelated"); unlinkSync(path); linkSync(another, path);
    expect(capture.finish()).toBeUndefined();
    unlinkSync(path);
    writeFileSync(sidecar, "not the requested file");
    expect(capture.finish()).toBeUndefined();
    unlinkSync(sidecar); writeFileSync(path, "");
    expect(capture.finish()).toBeUndefined();
    truncateSync(path, 30 * 1024 * 1024 + 1);
    expect(capture.finish()).toBeUndefined();
    expect(() => frozenReplyFileBytes(workdir, { ...file, name: "../escape" })).toThrow();
  } finally { rmSync(workdir, { recursive: true, force: true }); }
});
