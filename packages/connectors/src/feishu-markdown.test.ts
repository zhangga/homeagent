import { expect, test } from "bun:test";
import { formatFeishuLocalFileLinks } from "./feishu-markdown.ts";

test.each([
  ["[周报](D:/Client/PST周报.md)", "D:/Client/PST周报.md"],
  ["[周报](D:\\Client\\PST周报.md)", "D:\\Client\\PST周报.md"],
  ["[周报](<D:/Client/报告 (最终版).md>)", "D:/Client/报告 (最终版).md"],
  ["[周报](file:///D:/Client/%E5%91%A8%E6%8A%A5.md)", "D:/Client/周报.md"],
  ["[周报](/tmp/report.md)", "/tmp/report.md"],
])("local file links become copyable paths before Feishu rendering: %s", (input, path) => {
  const output = formatFeishuLocalFileLinks(input);
  expect(output).toBe(`周报（本机文件：\` ${path} \`）`);
  expect(formatFeishuLocalFileLinks(output)).toBe(output);
});

test("remote links, images and code examples keep their original content", () => {
  const markdown = '[证据](https://applink.feishu.cn/client/message/open?messageId=om_one)\n'
    + '![图](D:/Client/image.png)\n`[示例](D:/Client/example.md)`\n'
    + '```markdown\n[示例](D:/Client/example.md)\n```';
  expect(formatFeishuLocalFileLinks(markdown)).toBe(markdown);
});
