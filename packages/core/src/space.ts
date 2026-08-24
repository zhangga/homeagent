/**
 * Space storage: the on-disk layout for one knowledge space (plan §2.1).
 *
 *   data/workspaces/<dir>/
 *     purpose.md schema.md          space intent + page-type rules
 *     raw/records/YYYY/MM/DD.jsonl  authoritative, human-readable Raw records
 *     raw/sources/                  immutable imported source files
 *     wiki/<type>/<name>.md         distilled pages, foldered by type
 *     wiki/{index,overview,log,glossary}.md   top-level singletons
 *     .index.db                     SQLite projection (rebuildable from raw + wiki)
 *
 * Markdown and Raw JSONL are the source of truth; SpaceIndex is the queryable
 * mirror. Writing a page writes the .md file and upserts the index together.
 * Raw mutations atomically replace the affected daily JSONL before updating
 * SQLite. Because a slug like "entities/alice" encodes its own subfolder, page
 * files live at wiki/<slug>.md.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Page, SpaceId } from "@homeagent/shared";
import { spaceToDir } from "@homeagent/shared";
import { SpaceIndex } from "./sqlite.ts";
import { markdownToPage, pageToMarkdown } from "./markdown.ts";
import { ensureSpaceAgentGuide } from "./agent-guides.ts";

export const DEFAULT_PURPOSE = `# 空间意图 (purpose)

这是一个 homeagent 知识空间。此文件描述本空间收集与提炼知识的目标。
团队成员可编辑本文件，让 agent 更了解本空间关注什么。
`;

export const DEFAULT_SCHEMA = `# 页类型规则 (schema)

- entity: 人、团队、项目、系统等实体
- concept: 概念、术语、约定
- source: 重要来源（文档、会议、链接）的提要
- analysis: 综合分析、决策记录

提炼时如果一条原始信息只是噪声或寒暄，跳过不建页。
`;

export class SpaceStore {
  readonly space: SpaceId;
  readonly root: string;
  readonly wikiDir: string;
  readonly rawSourcesDir: string;
  readonly dbPath: string;
  private _index: SpaceIndex | null = null;

  constructor(space: SpaceId, dataDir: string) {
    this.space = space;
    this.root = join(dataDir, "workspaces", spaceToDir(space));
    this.wikiDir = join(this.root, "wiki");
    this.rawSourcesDir = join(this.root, "raw", "sources");
    this.dbPath = join(this.root, ".index.db");
  }

  /** Create the directory scaffold and seed purpose/schema if absent. */
  ensure(): void {
    mkdirSync(this.wikiDir, { recursive: true });
    mkdirSync(this.rawSourcesDir, { recursive: true });
    this.ensureAgentGuide();
    const purpose = join(this.root, "purpose.md");
    if (!existsSync(purpose)) writeFileSync(purpose, DEFAULT_PURPOSE, "utf8");
    const schema = join(this.root, "schema.md");
    if (!existsSync(schema)) writeFileSync(schema, DEFAULT_SCHEMA, "utf8");
    // touch the index
    this.index();
  }

  /** Seed the scoped agent reading guide without opening the SQLite projection. */
  ensureAgentGuide(): void {
    ensureSpaceAgentGuide(this.root);
  }

  exists(): boolean {
    return existsSync(this.root);
  }

  index(): SpaceIndex {
    if (!this._index) {
      mkdirSync(this.root, { recursive: true });
      const projectionExisted = existsSync(this.dbPath);
      try {
        this._index = new SpaceIndex(this.dbPath, {
          rawDir: join(this.root, "raw"),
          space: this.space,
        });
        if (!projectionExisted) {
          // A Git restore or deliberate index deletion must be enough to
          // recover a working space. Raw has already been projected by the
          // SpaceIndex constructor; rebuild pages from authoritative Markdown.
          this._index.rebuildFromPages(this.listPagesFromDisk());
        }
      } catch (error) {
        this._index?.close();
        this._index = null;
        throw error;
      }
    }
    return this._index;
  }

  purpose(): string {
    const p = join(this.root, "purpose.md");
    return existsSync(p) ? readFileSync(p, "utf8") : DEFAULT_PURPOSE;
  }

  schema(): string {
    const p = join(this.root, "schema.md");
    return existsSync(p) ? readFileSync(p, "utf8") : DEFAULT_SCHEMA;
  }

  setPurpose(content: string): void {
    writeFileSync(join(this.root, "purpose.md"), content, "utf8");
  }

  setSchema(content: string): void {
    writeFileSync(join(this.root, "schema.md"), content, "utf8");
  }

  private pagePath(slug: string): string {
    return join(this.wikiDir, `${slug}.md`);
  }

  /** Write a page to markdown and mirror it into the index. */
  writePage(page: Page): void {
    // Markdown is authoritative and can be read without consulting SQLite, so
    // reject non-admitted evidence before creating or replacing the file.
    this.index().assertPageSourcesAdmitted(page);
    const path = this.pagePath(page.slug);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, pageToMarkdown(page), "utf8");
    this.index().upsertPage(page);
  }

  readPageFile(slug: string): Page | null {
    const path = this.pagePath(slug);
    if (!existsSync(path)) return null;
    return markdownToPage(readFileSync(path, "utf8"));
  }

  deletePage(slug: string): void {
    const path = this.pagePath(slug);
    if (existsSync(path)) rmSync(path);
    this.index().deletePage(slug);
  }

  /** Enumerate every wiki/*.md file's slug (relative path without extension). */
  listPageFiles(): string[] {
    const slugs: string[] = [];
    const walk = (dir: string, prefix: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full, prefix ? `${prefix}/${entry}` : entry);
        } else if (entry.endsWith(".md")) {
          const name = entry.slice(0, -3);
          slugs.push(prefix ? `${prefix}/${name}` : name);
        }
      }
    };
    walk(this.wikiDir, "");
    return slugs;
  }

  /** Read every authoritative Markdown page, failing rather than exporting a partial backup. */
  listPagesFromDisk(): Page[] {
    return this.listPageFiles().sort().map((slug) => {
      const page = this.readPageFile(slug);
      if (!page) throw new Error(`knowledge page disappeared during export: ${slug}`);
      return page;
    });
  }

  /**
   * Rebuild the SQLite index from the markdown files on disk. Corrupt pages
   * (unparseable frontmatter) are skipped and returned so callers can quarantine
   * them. This makes the index fully derivable from wiki/*.md.
   */
  rebuildIndex(): { rebuilt: number; corrupt: string[] } {
    const corrupt: string[] = [];
    const pages: Page[] = [];
    for (const slug of this.listPageFiles()) {
      try {
        const md = readFileSync(this.pagePath(slug), "utf8");
        pages.push(markdownToPage(md));
      } catch {
        corrupt.push(slug);
      }
    }
    this.index().rebuildFromPages(pages);
    return { rebuilt: pages.length, corrupt };
  }

  close(): void {
    if (this._index) {
      this._index.close();
      this._index = null;
    }
  }
}
