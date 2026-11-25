import { raw } from "hono/html";
import type { Page, SpaceId } from "@homeagent/shared";
import { learningMarkdownHtml } from "./learning-markdown.ts";

export function knowledgeMarkdownHtml(space: SpaceId, page: Page) {
  // Generated pages often repeat their title at the start of the Markdown.
  const heading = /^(?:[ \t]*\r?\n)* {0,3}#[ \t]+([^\r\n]+)(?:\r?\n|$)/u.exec(page.content);
  const body = heading?.[1]?.trim() === page.title.trim()
    ? page.content.slice(heading[0].length)
    : page.content;
  if (typeof Bun.markdown?.html !== "function") return learningMarkdownHtml(body);
  const markdown = Bun.markdown.html(body, {
    wikiLinks: true,
    noHtmlBlocks: true,
    noHtmlSpans: true,
  });
  // Bun has already escaped the source HTML. Only explicit HTTP(S) links
  // navigate off-site. Images show their descriptions without fetching them.
  const reading = new HTMLRewriter()
    .on("a", { element(link) {
      const target = link.getAttribute("href") ?? "";
      if (!/^https?:\/\//iu.test(target) || !URL.canParse(target)) {
        link.removeAndKeepContent();
        return;
      }
      link.setAttribute("rel", "noreferrer noopener");
    } })
    .on("img", { element(image) { image.replace(image.getAttribute("alt") || "图片"); } })
    .on("x-wikilink", { element(link) {
      const slug = link.getAttribute("data-target");
      if (!slug || slug === "." || slug === "..") {
        link.removeAndKeepContent();
        return;
      }
      link.tagName = "a";
      link.removeAttribute("data-target");
      link.setAttribute("href", `/spaces/${encodeURIComponent(space)}/pages/${encodeURIComponent(slug)}`);
    } })
    .transform(markdown);
  return raw(reading);
}
