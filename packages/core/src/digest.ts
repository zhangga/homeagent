/**
 * Deterministic regeneration of progressive Knowledge maps. Content pages are
 * grouped into topic maps, while the top-level index and overview stay small
 * and point at those maps. No LLM is involved, so the hierarchy is cheap,
 * reproducible, and safe to refresh after every Knowledge page change.
 */
import type { Page, PageRef, PageType } from "@homeagent/shared";
import type { SpaceStore } from "./space.ts";
import { slugifyName } from "./slug.ts";

const NAVIGATION_TYPES = new Set<PageType>(["index", "overview", "log", "glossary", "map"]);
const MAX_EXPLICIT_TOPIC_MAPS = 24;
const MAX_TOPIC_MAP_ENTRIES = 100;
const TYPE_LABELS: Record<Exclude<PageType, "index" | "overview" | "log" | "glossary" | "map">, string> = {
  entity: "实体",
  concept: "概念",
  source: "来源",
  analysis: "分析",
};

export function isKnowledgeContentRef(ref: Pick<PageRef, "type">): boolean {
  return !NAVIGATION_TYPES.has(ref.type);
}

interface TopicGroup {
  slug: string;
  title: string;
  refs: PageRef[];
}

function explicitTopic(ref: PageRef): { slug: string; title: string } | undefined {
  const tag = ref.tags.find((candidate) => Boolean(candidate.normalize("NFKC").trim()));
  if (!tag) return undefined;
  const title = tag.normalize("NFKC").trim();
  return { slug: `maps/${slugifyName(title)}`, title };
}

function fallbackTopic(ref: PageRef): { slug: string; title: string } {
  const title = TYPE_LABELS[ref.type as keyof typeof TYPE_LABELS] || "其他";
  return { slug: `maps/type-${slugifyName(ref.type)}`, title };
}

function digestHash(parts: string[]): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(parts.join("\n"));
  return hash.digest("hex").slice(0, 16);
}

function refKey(ref: PageRef): string {
  return [
    ref.slug,
    ref.type,
    ref.title,
    ref.summary,
    ref.aliases.join(","),
    ref.tags.join(","),
  ].join(":");
}

function topicGroups(refs: PageRef[]): TopicGroup[] {
  const candidates = new Map<string, TopicGroup>();
  for (const ref of refs) {
    const topic = explicitTopic(ref);
    if (!topic) continue;
    const group = candidates.get(topic.slug) ?? { ...topic, refs: [] };
    group.refs.push(ref);
    candidates.set(topic.slug, group);
  }
  const selected = [...candidates.values()]
    .sort((left, right) =>
      right.refs.length - left.refs.length || left.slug.localeCompare(right.slug)
    )
    .slice(0, MAX_EXPLICIT_TOPIC_MAPS);
  const selectedSlugs = new Set(selected.map((group) => group.slug));
  const groups = new Map<string, TopicGroup>(
    selected.map((group) => [group.slug, { ...group, refs: [] as PageRef[] }]),
  );
  for (const ref of refs) {
    const explicit = explicitTopic(ref);
    const topic = explicit && selectedSlugs.has(explicit.slug) ? explicit : fallbackTopic(ref);
    const group = groups.get(topic.slug) ?? { ...topic, refs: [] };
    group.refs.push(ref);
    groups.set(topic.slug, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      refs: group.refs.slice().sort((left, right) => left.slug.localeCompare(right.slug)),
    }))
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

function contentMap(slug: string, title: string, refs: PageRef[], summaryCount = refs.length): Page {
  const lines = [
    `# ${title}`,
    "",
    `本主题包含 ${summaryCount} 个知识页（由系统自动生成）。`,
    "",
    "## 页面",
    "",
    ...refs.map((ref) => `- [[${ref.slug}|${ref.title}]]：${ref.summary}`),
    "",
  ];
  return {
    slug,
    type: "map",
    title,
    summary: `${title}：${summaryCount} 个知识页`,
    aliases: [],
    tags: [],
    sources: [],
    links: refs.map((ref) => ref.slug),
    content: lines.join("\n"),
    updatedAt: Date.now(),
    contentHash: digestHash(refs.map(refKey)),
  };
}

interface MapNode {
  page: Page;
  contentCount: number;
}

function navigationMap(slug: string, title: string, nodes: MapNode[]): Page {
  const contentCount = nodes.reduce((total, node) => total + node.contentCount, 0);
  const lines = [
    `# ${title}`,
    "",
    `本主题包含 ${contentCount} 个知识页，已拆分为 ${nodes.length} 个下级地图（由系统自动生成）。`,
    "",
    "## 下级地图",
    "",
    ...nodes.map((node) =>
      `- [[${node.page.slug}|${node.page.title}]]：${node.contentCount} 个知识页`
    ),
    "",
  ];
  return {
    slug,
    type: "map",
    title,
    summary: `${title}：${contentCount} 个知识页`,
    aliases: [],
    tags: [],
    sources: [],
    links: nodes.map((node) => node.page.slug),
    content: lines.join("\n"),
    updatedAt: Date.now(),
    contentHash: digestHash(nodes.flatMap((node) => [
      node.page.slug,
      node.page.title,
      String(node.contentCount),
    ])),
  };
}

function topicMaps(group: TopicGroup): Page[] {
  if (group.refs.length <= MAX_TOPIC_MAP_ENTRIES) {
    return [contentMap(group.slug, group.title, group.refs)];
  }
  const generated: Page[] = [];
  const leafCount = Math.ceil(group.refs.length / MAX_TOPIC_MAP_ENTRIES);
  let nodes: MapNode[] = [];
  for (let index = 0; index < leafCount; index += 1) {
    const number = String(index + 1).padStart(3, "0");
    const refs = group.refs.slice(
      index * MAX_TOPIC_MAP_ENTRIES,
      (index + 1) * MAX_TOPIC_MAP_ENTRIES,
    );
    const page = contentMap(
      `${group.slug}-part-${number}`,
      `${group.title} · ${index + 1}/${leafCount}`,
      refs,
    );
    generated.push(page);
    nodes.push({ page, contentCount: refs.length });
  }
  let level = 2;
  while (nodes.length > MAX_TOPIC_MAP_ENTRIES) {
    const next: MapNode[] = [];
    const parentCount = Math.ceil(nodes.length / MAX_TOPIC_MAP_ENTRIES);
    for (let index = 0; index < parentCount; index += 1) {
      const children = nodes.slice(
        index * MAX_TOPIC_MAP_ENTRIES,
        (index + 1) * MAX_TOPIC_MAP_ENTRIES,
      );
      const page = navigationMap(
        `${group.slug}-level-${level}-part-${String(index + 1).padStart(3, "0")}`,
        `${group.title} · 第 ${level} 层 ${index + 1}/${parentCount}`,
        children,
      );
      generated.push(page);
      next.push({
        page,
        contentCount: children.reduce((total, child) => total + child.contentCount, 0),
      });
    }
    nodes = next;
    level += 1;
  }
  return [navigationMap(group.slug, group.title, nodes), ...generated];
}

function indexPage(groups: TopicGroup[], contentCount: number): Page {
  const lines = [
    "# Index",
    "",
    "本空间的一级主题导航（由系统自动生成）。",
    "",
    ...groups.map((group) =>
      `- [[${group.slug}|${group.title}]]：${group.refs.length} 个知识页`
    ),
    "",
  ];
  return {
    slug: "index",
    type: "index",
    title: "Index",
    summary: `主题导航：${groups.length} 个主题，${contentCount} 个知识页`,
    aliases: [],
    tags: [],
    sources: [],
    links: groups.map((group) => group.slug),
    content: lines.join("\n"),
    updatedAt: Date.now(),
    contentHash: digestHash(groups.flatMap((group) => [group.slug, group.title, String(group.refs.length)])),
  };
}

function glossaryPage(refs: PageRef[]): Page {
  const sorted = refs.slice().sort((left, right) => left.title.localeCompare(right.title));
  const lines = ["# Glossary", "", "标题与别名到页面的映射（自动生成）。", ""];
  for (const ref of sorted) {
    lines.push(`- ${[ref.title, ...ref.aliases].join(" / ")} → [[${ref.slug}]]`);
  }
  lines.push("");
  return {
    slug: "glossary",
    type: "glossary",
    title: "Glossary",
    summary: `术语表：${refs.length} 项`,
    aliases: [],
    tags: [],
    sources: [],
    links: refs.map((ref) => ref.slug),
    content: lines.join("\n"),
    updatedAt: Date.now(),
    contentHash: digestHash(sorted.map(refKey)),
  };
}

function overviewPage(groups: TopicGroup[], pages: Page[]): Page {
  const ranked = groups.slice().sort((left, right) =>
    right.refs.length - left.refs.length || left.slug.localeCompare(right.slug)
  );
  const recent = pages.slice().sort((left, right) =>
    right.updatedAt - left.updatedAt || left.slug.localeCompare(right.slug)
  ).slice(0, 8);
  const untagged = pages.filter((page) => page.tags.length === 0).length;
  const unlinked = pages.filter((page) => page.links.length === 0).length;
  const lines = [
    "# Overview",
    "",
    "## 核心主题",
    "",
    ...ranked.map((group) =>
      `- [[${group.slug}|${group.title}]]：${group.refs.length} 个知识页`
    ),
    "",
    "## 最近更新",
    "",
    ...recent.map((page) => `- [[${page.slug}|${page.title}]]：${page.summary}`),
    "",
    "## 知识缺口",
    "",
    `- ${untagged} 个知识页没有主题标签。`,
    `- ${unlinked} 个知识页没有关联其他知识页。`,
    "",
    `共 ${pages.length} 个知识页。完整一级导航见 [[index]]，术语定位见 [[glossary]]。`,
    "",
  ];
  return {
    slug: "overview",
    type: "overview",
    title: "Overview",
    summary: `概览：${groups.length} 个主题，${pages.length} 个知识页`,
    aliases: [],
    tags: [],
    sources: [],
    links: [
      ...ranked.map((group) => group.slug),
      ...recent.map((page) => page.slug),
      "index",
      "glossary",
    ],
    content: lines.join("\n"),
    updatedAt: Date.now(),
    contentHash: digestHash([
      ...ranked.flatMap((group) => [group.slug, group.title, String(group.refs.length)]),
      ...recent.map((page) => `${page.slug}:${page.title}:${page.updatedAt}:${page.summary}`),
      `untagged:${untagged}`,
      `unlinked:${unlinked}`,
    ]),
  };
}

/**
 * Regenerate topic maps plus index/glossary/overview from current content
 * pages. The returned count is the number of generated pages written.
 */
export function refreshDigest(store: SpaceStore): number {
  const allPages = store.index().allPages();
  const pages = allPages
    .filter(isKnowledgeContentRef)
    .sort((left, right) => left.slug.localeCompare(right.slug));
  const refs: PageRef[] = pages;
  const groups = topicGroups(refs);
  const maps = groups.flatMap(topicMaps);
  const generated = [
    ...maps,
    indexPage(groups, refs.length),
    glossaryPage(refs),
    overviewPage(groups, pages),
  ];
  let written = 0;
  for (const page of generated) {
    const existing = store.index().getPage(page.slug);
    if (existing?.type === page.type && existing.contentHash === page.contentHash) continue;
    store.writePage(page);
    written += 1;
  }
  const generatedMapSlugs = new Set(maps.map((page) => page.slug));
  for (const stale of allPages.filter((ref) =>
    ref.type === "map" && !generatedMapSlugs.has(ref.slug)
  )) {
    store.deletePage(stale.slug);
  }
  return written;
}
