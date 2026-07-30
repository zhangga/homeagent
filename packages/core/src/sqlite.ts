/**
 * SQLite index for one space (plan §2.4). This is a rebuildable projection of
 * the markdown pages plus the durable `raw` capture table. We use bun:sqlite.
 *
 * Two roles:
 *   1. `pages` + `pages_fts` — the queryable metadata + full-text mirror. FTS
 *      stores CJK-bigram-tokenized text (see tokenize.ts) under the default
 *      tokenizer so two-character Chinese queries actually match.
 *   2. `raw` — durable capture of every RawEntry. remember() writes here without
 *      calling any LLM; the dream cycle reads un-ingested rows and marks them.
 *
 * Provenance note: pages can always be rebuilt from markdown via rebuildFromPages,
 * but `raw` is authoritative capture and is never derived from anything else.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Hit, Page, PageRef, RawEntry, RawRecord } from "@homeagent/shared";
import type { MessageRetractionRecord } from "./governance.ts";
import { toMatchQuery, toSearchText } from "./tokenize.ts";

export class SpaceIndex {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS pages (
        slug TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        aliases_json TEXT NOT NULL DEFAULT '[]',
        tags_json TEXT NOT NULL DEFAULT '[]',
        sources_json TEXT NOT NULL DEFAULT '[]',
        links_json TEXT NOT NULL DEFAULT '[]',
        content TEXT NOT NULL DEFAULT '',
        updated INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL DEFAULT ''
      )
    `);
    // External-content-free FTS mirror. We manage rows manually (delete+insert)
    // and store the CJK-tokenized projection, not the raw content.
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
        slug UNINDEXED,
        title,
        body
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS raw (
        id TEXT PRIMARY KEY,
        space TEXT NOT NULL,
        source TEXT NOT NULL,
        agent_id TEXT,
        agent_handled INTEGER,
        agent_response TEXT,
        agent_responded_at INTEGER,
        author TEXT,
        chat_id TEXT,
        message_id TEXT,
        content TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        created INTEGER NOT NULL,
        ingested INTEGER NOT NULL DEFAULT 0
      )
    `);
    const rawColumns = this.db.query(`PRAGMA table_info(raw)`).all() as {
      name: string;
    }[];
    if (!rawColumns.some((column) => column.name === "agent_id")) {
      this.db.run(`ALTER TABLE raw ADD COLUMN agent_id TEXT`);
    }
    if (!rawColumns.some((column) => column.name === "agent_handled")) {
      this.db.run(`ALTER TABLE raw ADD COLUMN agent_handled INTEGER`);
    }
    if (!rawColumns.some((column) => column.name === "agent_response")) {
      this.db.run(`ALTER TABLE raw ADD COLUMN agent_response TEXT`);
    }
    if (!rawColumns.some((column) => column.name === "agent_responded_at")) {
      this.db.run(`ALTER TABLE raw ADD COLUMN agent_responded_at INTEGER`);
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS message_retractions (
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        original_author TEXT NOT NULL,
        retracted_by TEXT NOT NULL,
        created INTEGER NOT NULL,
        PRIMARY KEY (chat_id, message_id)
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS raw_ingested ON raw(ingested, created)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS raw_message ON raw(chat_id, message_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS raw_chat_created ON raw(chat_id, created DESC)`);
    this.db.run(
      `CREATE INDEX IF NOT EXISTS raw_agent_created
       ON raw(agent_id, agent_handled, created DESC)`,
    );
    this.db.run(`CREATE INDEX IF NOT EXISTS pages_type ON pages(type)`);
  }

  // ---- pages ---------------------------------------------------------------

  upsertPage(page: Page): void {
    this.db
      .query(
        `INSERT INTO pages (slug, type, title, summary, aliases_json, tags_json, sources_json, links_json, content, updated, content_hash)
         VALUES ($slug, $type, $title, $summary, $aliases, $tags, $sources, $links, $content, $updated, $hash)
         ON CONFLICT(slug) DO UPDATE SET
           type=$type, title=$title, summary=$summary, aliases_json=$aliases,
           tags_json=$tags, sources_json=$sources, links_json=$links,
           content=$content, updated=$updated, content_hash=$hash`,
      )
      .run({
        $slug: page.slug,
        $type: page.type,
        $title: page.title,
        $summary: page.summary,
        $aliases: JSON.stringify(page.aliases),
        $tags: JSON.stringify(page.tags),
        $sources: JSON.stringify(page.sources),
        $links: JSON.stringify(page.links),
        $content: page.content,
        $updated: page.updatedAt,
        $hash: page.contentHash,
      });
    this.reindexFts(page);
  }

  private reindexFts(page: Page): void {
    this.db.query(`DELETE FROM pages_fts WHERE slug = ?`).run(page.slug);
    // Index title (with aliases) and the full body, both CJK-tokenized so that
    // Chinese substrings match; ascii is lowercased word-level.
    const titleText = toSearchText([page.title, ...page.aliases].join(" "));
    const bodyText = toSearchText(
      [page.title, page.summary, ...page.tags, page.content].join(" \n "),
    );
    this.db
      .query(`INSERT INTO pages_fts (slug, title, body) VALUES (?, ?, ?)`)
      .run(page.slug, titleText, bodyText);
  }

  getPage(slug: string): Page | null {
    const row = this.db.query(`SELECT * FROM pages WHERE slug = ?`).get(slug) as
      | Record<string, unknown>
      | null;
    return row ? rowToPage(row) : null;
  }

  deletePage(slug: string): void {
    this.db.query(`DELETE FROM pages WHERE slug = ?`).run(slug);
    this.db.query(`DELETE FROM pages_fts WHERE slug = ?`).run(slug);
  }

  listPages(type?: string): PageRef[] {
    const rows = (
      type
        ? this.db.query(`SELECT slug, type, title, summary, aliases_json, tags_json FROM pages WHERE type = ? ORDER BY updated DESC`).all(type)
        : this.db.query(`SELECT slug, type, title, summary, aliases_json, tags_json FROM pages ORDER BY updated DESC`).all()
    ) as Record<string, unknown>[];
    return rows.map(rowToRef);
  }

  countPages(): number {
    const r = this.db.query(`SELECT COUNT(*) n FROM pages`).get() as { n: number };
    return r.n;
  }

  allPages(): Page[] {
    const rows = this.db.query(`SELECT * FROM pages ORDER BY updated DESC`).all() as Record<
      string,
      unknown
    >[];
    return rows.map(rowToPage);
  }

  // ---- search --------------------------------------------------------------

  search(query: string, limit = 10): Hit[] {
    const match = toMatchQuery(query);
    if (!match) return [];
    try {
      const rows = this.db
        .query(
          `SELECT f.slug slug, p.title title, p.type type,
                  snippet(pages_fts, 2, '[', ']', '…', 12) snippet,
                  bm25(pages_fts, 5.0, 1.0) score
           FROM pages_fts f JOIN pages p ON p.slug = f.slug
           WHERE pages_fts MATCH ?
           ORDER BY score
           LIMIT ?`,
        )
        .all(match, limit) as Record<string, unknown>[];
      return rows.map((r) => ({
        slug: String(r.slug),
        title: String(r.title),
        type: String(r.type) as Hit["type"],
        snippet: String(r.snippet ?? ""),
        score: Number(r.score ?? 0),
      }));
    } catch {
      // A malformed MATCH expression should degrade to "no hits", not crash.
      return [];
    }
  }

  // ---- raw -----------------------------------------------------------------

  insertRaw(entry: RawEntry): string {
    const id = randomUUID();
    this.db
      .query(
        `INSERT INTO raw (id, space, source, agent_id, agent_handled, agent_response, agent_responded_at, author, chat_id, message_id, content, attachments_json, created, ingested)
         VALUES ($id, $space, $source, $agent, $handled, $response, $respondedAt, $author, $chat, $msg, $content, $att, $created, 0)`,
      )
      .run({
        $id: id,
        $space: entry.space,
        $source: entry.source,
        $agent: entry.agentId ?? null,
        $handled: entry.source === "message"
          ? (entry.agentHandled ?? Boolean(entry.agentId) ? 1 : 0)
          : null,
        $response: entry.agentResponse ?? null,
        $respondedAt: entry.agentRespondedAt ?? null,
        $author: entry.author ?? null,
        $chat: entry.chatId ?? null,
        $msg: entry.messageId ?? null,
        $content: entry.content,
        $att: JSON.stringify(entry.attachments ?? []),
        $created: entry.createdAt ?? Date.now(),
      });
    return id;
  }

  /** Restore one exact raw record, preserving its provenance id and state. */
  restoreRaw(record: RawRecord): void {
    this.db
      .query(
        `INSERT INTO raw (id, space, source, agent_id, agent_handled, agent_response, agent_responded_at, author, chat_id, message_id, content, attachments_json, created, ingested)
         VALUES ($id, $space, $source, $agent, $handled, $response, $respondedAt, $author, $chat, $msg, $content, $att, $created, $ingested)`,
      )
      .run({
        $id: record.id,
        $space: record.space,
        $source: record.source,
        $agent: record.agentId ?? null,
        $handled: record.agentHandled === undefined ? null : record.agentHandled ? 1 : 0,
        $response: record.agentResponse ?? null,
        $respondedAt: record.agentRespondedAt ?? null,
        $author: record.author ?? null,
        $chat: record.chatId ?? null,
        $msg: record.messageId ?? null,
        $content: record.content,
        $att: JSON.stringify(record.attachments ?? []),
        $created: record.createdAt,
        $ingested: record.ingested ? 1 : 0,
      });
  }

  listRaw(opts: { onlyPending?: boolean; limit?: number } = {}): RawRecord[] {
    const where = opts.onlyPending ? `WHERE ingested = 0` : ``;
    const limit = opts.limit ? `LIMIT ${Math.max(0, Math.floor(opts.limit))}` : ``;
    const rows = this.db
      .query(`SELECT * FROM raw ${where} ORDER BY created ASC ${limit}`)
      .all() as Record<string, unknown>[];
    return rows.map(rowToRaw);
  }

  getRaw(id: string): RawRecord | null {
    const row = this.db.query(`SELECT * FROM raw WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | null;
    return row ? rowToRaw(row) : null;
  }

  attributeRawToAgent(id: string, agentId: string): boolean {
    if (!agentId.trim()) return false;
    const result = this.db
      .query(
        `UPDATE raw
         SET agent_id = ?, agent_handled = 1
         WHERE id = ? AND source = 'message'`,
      )
      .run(agentId, id);
    return result.changes > 0;
  }

  recordAgentResponse(
    chatId: string,
    messageId: string,
    response: string,
    respondedAt = Date.now(),
  ): boolean {
    const result = this.db
      .query(
        `UPDATE raw
         SET agent_response = ?, agent_responded_at = ?
         WHERE chat_id = ? AND message_id = ? AND source = 'message'`,
      )
      .run(response, respondedAt, chatId, messageId);
    return result.changes > 0;
  }

  findRawsByMessageId(messageId: string, chatId: string): RawRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM raw
         WHERE message_id = ? AND chat_id = ?
         ORDER BY created ASC`,
      )
      .all(messageId, chatId) as Record<string, unknown>[];
    return rows.map(rowToRaw);
  }

  listAgentChatRaws(
    agentId: string,
    opts: { includeLegacy?: boolean; limit?: number } = {},
  ): RawRecord[] {
    const safeLimit = Math.max(0, Math.floor(opts.limit ?? 20));
    if (!agentId.trim() || safeLimit === 0) return [];
    const legacy = opts.includeLegacy
      ? `OR (agent_id IS NULL AND agent_handled IS NULL)`
      : ``;
    const rows = this.db
      .query(
        `SELECT * FROM raw
         WHERE source = 'message'
           AND (agent_id = ? ${legacy})
         ORDER BY created DESC
         LIMIT ${safeLimit}`,
      )
      .all(agentId) as Record<string, unknown>[];
    return rows.map(rowToRaw);
  }

  findRecentRawsByChat(
    chatId: string,
    maxCreatedAt: number,
    limit = 50,
  ): RawRecord[] {
    const safeLimit = Math.max(0, Math.floor(limit));
    const rows = this.db
      .query(
        `SELECT * FROM raw
         WHERE chat_id = ? AND created <= ?
         ORDER BY created DESC
         LIMIT ${safeLimit}`,
      )
      .all(chatId, maxCreatedAt) as Record<string, unknown>[];
    return rows.map(rowToRaw);
  }

  listRawByIds(
    ids: string[],
    opts: { onlyPending?: boolean; limit?: number } = {},
  ): RawRecord[] {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const pending = opts.onlyPending ? "AND ingested = 0" : "";
    const limit = opts.limit === undefined ? "" : `LIMIT ${Math.max(0, Math.floor(opts.limit))}`;
    const rows = this.db
      .query(
        `SELECT * FROM raw
         WHERE id IN (${placeholders}) ${pending}
         ORDER BY created ASC ${limit}`,
      )
      .all(...uniqueIds) as Record<string, unknown>[];
    return rows.map(rowToRaw);
  }

  deleteRaw(id: string): void {
    this.db.query(`DELETE FROM raw WHERE id = ?`).run(id);
  }

  getMessageRetraction(
    chatId: string,
    messageId: string,
  ): { originalAuthor: string; retractedBy: string; createdAt: number } | null {
    const row = this.db
      .query(
        `SELECT original_author, retracted_by, created
         FROM message_retractions
         WHERE chat_id = ? AND message_id = ?`,
      )
      .get(chatId, messageId) as Record<string, unknown> | null;
    return row
      ? {
          originalAuthor: String(row.original_author),
          retractedBy: String(row.retracted_by),
          createdAt: Number(row.created),
        }
      : null;
  }

  recordMessageRetraction(input: {
    chatId: string;
    messageId: string;
    originalAuthor: string;
    retractedBy: string;
  }): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO message_retractions
         (chat_id, message_id, original_author, retracted_by, created)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.chatId,
        input.messageId,
        input.originalAuthor,
        input.retractedBy,
        Date.now(),
      );
  }

  listMessageRetractions(): MessageRetractionRecord[] {
    const rows = this.db
      .query(
        `SELECT chat_id, message_id, original_author, retracted_by, created
         FROM message_retractions ORDER BY created ASC, chat_id ASC, message_id ASC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      chatId: String(row.chat_id),
      messageId: String(row.message_id),
      originalAuthor: String(row.original_author),
      retractedBy: String(row.retracted_by),
      createdAt: Number(row.created),
    }));
  }

  restoreMessageRetraction(record: MessageRetractionRecord): void {
    this.db
      .query(
        `INSERT INTO message_retractions
         (chat_id, message_id, original_author, retracted_by, created)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.chatId,
        record.messageId,
        record.originalAuthor,
        record.retractedBy,
        record.createdAt,
      );
  }

  markIngested(ids: string[]): void {
    this.setRawIngested(ids, true);
  }

  markPending(ids: string[]): void {
    this.setRawIngested(ids, false);
  }

  private setRawIngested(ids: string[], ingested: boolean): void {
    if (ids.length === 0) return;
    const value = ingested ? 1 : 0;
    const update = this.db.transaction((batch: string[]) => {
      const stmt = this.db.query(`UPDATE raw SET ingested = ? WHERE id = ?`);
      for (const id of batch) stmt.run(value, id);
    });
    update(ids);
  }

  countRaw(onlyPending = false): number {
    const q = onlyPending
      ? `SELECT COUNT(*) n FROM raw WHERE ingested = 0`
      : `SELECT COUNT(*) n FROM raw`;
    const r = this.db.query(q).get() as { n: number };
    return r.n;
  }

  /** Delete expired message bodies only after they have been distilled/handled. */
  deleteExpiredRawMessages(cutoff: number, protectedIds: ReadonlySet<string> = new Set()): number {
    const candidates = this.db
      .query(`SELECT id FROM raw WHERE source = 'message' AND ingested = 1 AND created < ?`)
      .all(cutoff) as Array<{ id: string }>;
    let deleted = 0;
    const remove = this.db.transaction((ids: string[]) => {
      const statement = this.db.query(`DELETE FROM raw WHERE id = ?`);
      for (const id of ids) deleted += statement.run(id).changes;
    });
    remove(candidates.map(({ id }) => id).filter((id) => !protectedIds.has(id)));
    return deleted;
  }

  // ---- maintenance ---------------------------------------------------------

  /** Rebuild pages + FTS from an authoritative list of markdown-derived pages. */
  rebuildFromPages(pages: Page[]): void {
    const tx = this.db.transaction((list: Page[]) => {
      this.db.run(`DELETE FROM pages`);
      this.db.run(`DELETE FROM pages_fts`);
      for (const p of list) this.upsertPage(p);
    });
    tx(pages);
  }

  close(): void {
    this.db.close();
  }
}

// ---- row mappers -----------------------------------------------------------

function parseJsonArray(v: unknown): string[] {
  if (typeof v !== "string") return [];
  try {
    const a = JSON.parse(v) as unknown[];
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

function rowToPage(row: Record<string, unknown>): Page {
  return {
    slug: String(row.slug),
    type: String(row.type) as Page["type"],
    title: String(row.title),
    summary: String(row.summary ?? ""),
    aliases: parseJsonArray(row.aliases_json),
    tags: parseJsonArray(row.tags_json),
    sources: parseJsonArray(row.sources_json),
    links: parseJsonArray(row.links_json),
    content: String(row.content ?? ""),
    updatedAt: Number(row.updated ?? 0),
    contentHash: String(row.content_hash ?? ""),
  };
}

function rowToRef(row: Record<string, unknown>): PageRef {
  return {
    slug: String(row.slug),
    type: String(row.type) as PageRef["type"],
    title: String(row.title),
    summary: String(row.summary ?? ""),
    aliases: parseJsonArray(row.aliases_json),
    tags: parseJsonArray(row.tags_json),
  };
}

function rowToRaw(row: Record<string, unknown>): RawRecord {
  return {
    id: String(row.id),
    space: String(row.space) as RawRecord["space"],
    source: String(row.source) as RawRecord["source"],
    ...(row.agent_id == null ? {} : { agentId: String(row.agent_id) }),
    ...(row.agent_handled == null
      ? {}
      : { agentHandled: Number(row.agent_handled) === 1 }),
    ...(row.agent_response == null ? {} : { agentResponse: String(row.agent_response) }),
    ...(row.agent_responded_at == null
      ? {}
      : { agentRespondedAt: Number(row.agent_responded_at) }),
    author: row.author == null ? undefined : String(row.author),
    chatId: row.chat_id == null ? undefined : String(row.chat_id),
    messageId: row.message_id == null ? undefined : String(row.message_id),
    content: String(row.content ?? ""),
    attachments: (() => {
      try {
        return JSON.parse(String(row.attachments_json ?? "[]")) as RawRecord["attachments"];
      } catch {
        return [];
      }
    })(),
    createdAt: Number(row.created ?? 0),
    ingested: Number(row.ingested ?? 0) === 1,
  };
}
