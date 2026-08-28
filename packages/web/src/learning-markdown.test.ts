import { describe, expect, test } from "bun:test";
import { learningMarkdownHtml } from "./learning-markdown.ts";

async function render(markdown: string): Promise<string> {
  return String(await learningMarkdownHtml(markdown));
}

describe("learningMarkdownHtml", () => {
  test("turns lesson structure into readable HTML", async () => {
    const output = await render([
      "## 今日目标",
      "理解 **Future** 与 `poll`。",
      "",
      "1. 阅读材料",
      "2. 完成练习",
      "",
      "[Rust 文档](https://doc.rust-lang.org/book/)",
    ].join("\n"));

    expect(output).toContain("<h2>今日目标</h2>");
    expect(output).toContain("<strong>Future</strong>");
    expect(output).toContain("<code>poll</code>");
    expect(output).toContain("<ol><li>阅读材料</li><li>完成练习</li></ol>");
    expect(output).toContain('href="https://doc.rust-lang.org/book/"');
    expect(output).toContain('rel="noreferrer noopener"');
  });

  test("escapes model HTML and refuses executable link schemes", async () => {
    const output = await render([
      "## 练习",
      "<script>alert('lesson')</script>",
      "<img src=x onerror=alert(1)>",
      "[危险链接](javascript:alert(1))",
    ].join("\n"));

    expect(output).toContain("&lt;script&gt;alert(&#39;lesson&#39;)&lt;/script&gt;");
    expect(output).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(output).not.toContain("<script>");
    expect(output).not.toContain("<img");
    expect(output).not.toContain("javascript:");
    expect(output).toContain("危险链接");
  });
});
