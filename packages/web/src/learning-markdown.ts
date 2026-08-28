import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

type HtmlFragment = HtmlEscapedString | Promise<HtmlEscapedString>;
type ListKind = "ordered" | "unordered";

const INLINE_MARKUP = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/gu;
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:"]);

function safeLearningLink(candidate: string): string | undefined {
  try {
    const parsed = new URL(candidate);
    return SAFE_LINK_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function inlineLearningMarkup(value: string): HtmlFragment[] {
  const fragments: HtmlFragment[] = [];
  let cursor = 0;

  for (const match of value.matchAll(INLINE_MARKUP)) {
    const token = match[0];
    const index = match.index;
    if (index > cursor) fragments.push(html`${value.slice(cursor, index)}`);

    if (token.startsWith("`")) {
      fragments.push(html`<code>${token.slice(1, -1)}</code>`);
    } else if (token.startsWith("**")) {
      fragments.push(html`<strong>${token.slice(2, -2)}</strong>`);
    } else if (token.startsWith("*")) {
      fragments.push(html`<em>${token.slice(1, -1)}</em>`);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/u);
      const label = link?.[1] ?? token;
      const target = link?.[2] ? safeLearningLink(link[2]) : undefined;
      fragments.push(target
        ? html`<a href="${target}" target="_blank" rel="noreferrer noopener">${label}</a>`
        : html`${label}`);
    }
    cursor = index + token.length;
  }

  if (cursor < value.length) fragments.push(html`${value.slice(cursor)}`);
  return fragments;
}

/**
 * Render the small Markdown subset used by generated lessons and feedback.
 * Dynamic text always passes through Hono's escaping; raw model markup is never
 * inserted into the page. Links are limited to absolute HTTP(S) destinations.
 */
export function learningMarkdownHtml(
  markdown: string,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const blocks: HtmlFragment[] = [];
  const lines = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listKind: ListKind | undefined;
  let quote: string[] = [];
  let code: string[] | undefined;
  let codeLanguage = "";

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(html`<p>${inlineLearningMarkup(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listKind || listItems.length === 0) return;
    const items = listItems.map((item) => html`<li>${inlineLearningMarkup(item)}</li>`);
    blocks.push(listKind === "ordered" ? html`<ol>${items}</ol>` : html`<ul>${items}</ul>`);
    listItems = [];
    listKind = undefined;
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    blocks.push(html`<blockquote><p>${inlineLearningMarkup(quote.join(" "))}</p></blockquote>`);
    quote = [];
  };
  const flushTextBlocks = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/u);
    if (code) {
      if (fence) {
        const language = codeLanguage.replace(/[^a-z0-9_-]/giu, "").toLowerCase();
        blocks.push(language
          ? html`<pre><code class="language-${language}">${code.join("\n")}</code></pre>`
          : html`<pre><code>${code.join("\n")}</code></pre>`);
        code = undefined;
        codeLanguage = "";
      } else {
        code.push(line);
      }
      continue;
    }
    if (fence) {
      flushTextBlocks();
      code = [];
      codeLanguage = fence[1] ?? "";
      continue;
    }
    if (line.trim().length === 0) {
      flushTextBlocks();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/u);
    if (heading) {
      flushTextBlocks();
      const content = inlineLearningMarkup(heading[2]!.trim());
      if (heading[1]!.length === 1) blocks.push(html`<h1>${content}</h1>`);
      else if (heading[1]!.length === 2) blocks.push(html`<h2>${content}</h2>`);
      else if (heading[1]!.length === 3) blocks.push(html`<h3>${content}</h3>`);
      else blocks.push(html`<h4>${content}</h4>`);
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u.test(line)) {
      flushTextBlocks();
      blocks.push(html`<hr />`);
      continue;
    }

    const unordered = line.match(/^\s*[-+*]\s+(.+)$/u);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/u);
    if (unordered || ordered) {
      flushParagraph();
      flushQuote();
      const nextKind: ListKind = unordered ? "unordered" : "ordered";
      if (listKind && listKind !== nextKind) flushList();
      listKind = nextKind;
      listItems.push((unordered?.[1] ?? ordered?.[1] ?? "").trim());
      continue;
    }

    const quoted = line.match(/^\s*>\s?(.*)$/u);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1] ?? "");
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }

  if (code) {
    const language = codeLanguage.replace(/[^a-z0-9_-]/giu, "").toLowerCase();
    blocks.push(language
      ? html`<pre><code class="language-${language}">${code.join("\n")}</code></pre>`
      : html`<pre><code>${code.join("\n")}</code></pre>`);
  } else {
    flushTextBlocks();
  }

  return html`${blocks}`;
}
