import { describe, expect, test } from "bun:test";
import type { CommandOptions } from "./feishu.ts";
import {
  ByteTechArticleFetcher,
  normalizeByteTechArticleUrl,
} from "./bytetech.ts";

const ARTICLE_URL = "https://bytetech.info/articles/7525079282028621867";

describe("ByteTechArticleFetcher", () => {
  test("accepts only canonical HTTPS ByteTech article URLs", () => {
    expect(normalizeByteTechArticleUrl(`${ARTICLE_URL}?from=share#section`)).toBe(ARTICLE_URL);
    for (const value of [
      "http://bytetech.info/articles/123",
      "https://www.bytetech.info/articles/123",
      "https://bytetech.info.evil.example/articles/123",
      "https://user:pass@bytetech.info/articles/123",
      "https://bytetech.info/search/123",
      "https://bytetech.info/articles/123/extra",
    ]) {
      expect(normalizeByteTechArticleUrl(value)).toBeUndefined();
    }
  });

  test("uses the fixed JSON GET-only command and returns bounded markdown", async () => {
    const calls: Array<{ command: string[]; options?: CommandOptions }> = [];
    const fetcher = new ByteTechArticleFetcher({
      bin: "bytedcli-test",
      runCommand: async (command, options) => {
        calls.push({ command, options });
        return JSON.stringify({ markdown: `# 文章标题\n\n${"正".repeat(210_000)}` });
      },
    });

    const markdown = await fetcher.fetch(`${ARTICLE_URL}?from=share`);

    expect(calls).toEqual([{
      command: ["bytedcli-test", "--json", "insearch", "get", ARTICLE_URL],
      options: expect.objectContaining({
        timeoutMs: 30_000,
        maxCapturedBytes: 1_048_576,
      }),
    }]);
    expect(markdown).toStartWith("# 文章标题");
    expect(markdown!.length).toBe(200_000);
    expect(markdown).toEndWith("【来源正文已按 200,000 字符上限截断】");
  });

  test("rejects unsafe URLs before spawning and fails closed on command errors", async () => {
    let calls = 0;
    const fetcher = new ByteTechArticleFetcher({
      runCommand: async () => {
        calls += 1;
        throw new Error("private provider diagnostics");
      },
    });

    expect(await fetcher.fetch("https://evil.example/articles/123")).toBeNull();
    expect(calls).toBe(0);
    expect(await fetcher.fetch(ARTICLE_URL)).toBeNull();
    expect(calls).toBe(1);
  });
});
