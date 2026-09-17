/**
 * SQLite index for one space (plan §2.4). This is a rebuildable projection of
 * the authoritative Markdown pages and readable Raw journal. We use bun:sqlite.
 *
 * Two roles:
 *   1. `pages` + `pages_fts` — the queryable metadata + full-text mirror. FTS
 *      stores CJK-bigram-tokenized text (see tokenize.ts) under the default
 *      tokenizer so two-character Chinese queries actually match.
 *   2. `raw` — query projection of the Raw journal. remember() writes the
 *      journal first without calling an LLM, then mirrors it here; the dream
 *      cycle reads un-ingested rows and marks them in both stores.
 *
 * Provenance note: pages rebuild from Markdown and Raw rebuilds from daily
 * JSONL. A legacy SQLite-only Raw table is backfilled on first journal-aware
 * open, preserving existing installations without a separate migration step.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  Hit,
  Page,
  PageRef,
  RawAdmission,
  RawEntry,
  RawRecord,
  SpaceId,
} from "@homeagent/shared";
import type { MessageRetractionRecord } from "./governance.ts";
import { RawJournal } from "./raw-journal.ts";
import { chatRawEntryUpdatedAt, chatRawVersionContent } from "./chat-raw-import.ts";
import { toMatchQuery, toSearchText } from "./tokenize.ts";

export const MAX_SEARCH_RESULTS = 100;

export function normalizeSearchLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) return 0;
  return Math.min(limit, MAX_SEARCH_RESULTS);
}

export class SpaceIndex {
  private db: Database;
  private rawJournal?: RawJournal;

  constructor(
    dbPath: string,
    options: { rawDir?: string; space?: SpaceId } = {},
  ) {
    if (options.rawDir !== undefined && !options.space) {
      throw new Error("Raw journal requires a space id");
    }
    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.migrate();
    if (options.rawDir !== undefined) {
      try {
        this.rawJournal = new RawJournal(options.rawDir, options.space!);
        this.initializeRawProjection();
      } catch (error) {
        // A corrupt authoritative journal must fail closed without leaking the
        // SQLite handle (notably important on Windows, where it locks cleanup).
        this.db.close();
        throw error;
      }
    }
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
        work_item_id TEXT,
        work_action_id TEXT,
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
        ingested INTEGER NOT NULL DEFAULT 0,
        admission TEXT NOT NULL DEFAULT 'ready'
          CHECK(admission IN ('ready', 'held', 'excluded'))
      )
    `);
    const rawColumns = this.db.query(`PRAGMA table_info(raw)`).all() as {
      name: string;
    }[];
    if (!rawColumns.some((column) => column.name === "work_item_id")) {
      this.db.run(`ALTER TABLE raw ADD COLUMN work_item_id TEXT`);
    }
    if (!rawColumns.some((column) => column.name === "work_action_id")) {
      this.db.run(`ALTER TABLE raw ADD COLUMN work_action_id TEXT`);
    }
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
    if (!rawColumns.some((column) => column.name === "admission")) {
      this.db.run(
        `ALTER TABLE raw ADD COLUMN admission TEXT NOT NULL DEFAULT 'ready'
         CHECK(admission IN ('ready', 'held', 'excluded'))`,
      );
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
    this.db.run(`CREATE INDEX IF NOT EXISTS raw_work_item ON raw(work_item_id, created DESC)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS raw_work_action ON raw(work_action_id, created DESC)`);
    this.db.run(
      `CREATE INDEX IF NOT EXISTS raw_admission_pending
       ON raw(admission, ingested, created)`,
    );
    this.db.run(
      `CREATE INDEX IF NOT EXISTS raw_agent_created
       ON raw(agent_id, agent_handled, created DESC)`,
    );
    this.db.run(`CREATE INDEX IF NOT EXISTS pages_type ON pages(type)`);
    const rawFtsProbe = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'raw_fts'");
    let hasRawFts: unknown;
    try { hasRawFts = rawFtsProbe.get(); } finally { rawFtsProbe.finalize(); }
    this.db.transaction(() => {
      this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS raw_fts USING fts5(id UNINDEXED, body)`);
      this.db.run(`DROP TRIGGER IF EXISTS raw_fts_delete`);
      if (!hasRawFts) for (const record of this.listRaw()) this.insertRawFts(record);
    })();
  }

  /**
   * Establish the readable journal as Raw authority. Existing SQLite-only
   * installations are backfilled once; initialized journals replace the SQL
   * projection so a deleted or stale index repairs itself on open.
   */
  private initializeRawProjection(): void {
    const journal = this.rawJournal!;
    if (!journal.isInitialized()) {
      journal.initialize(this.listRaw({}), this.listMessageRetractions());
      return;
    }
    const raw = journal.listRaw();
    const retractions = journal.listRetractions();
    const replace = this.db.transaction(() => {
      this.db.run(`DELETE FROM raw_fts`);
      this.db.run(`DELETE FROM raw`);
      this.db.run(`DELETE FROM message_retractions`);
      for (const record of raw) this.insertRawProjection(record);
      for (const record of retractions) this.insertRetractionProjection(record);
    });
    replace();
  }

  private insertRawProjection(record: RawRecord): void {
    this.db.transaction(() => {
    this.db
      .query(
        `INSERT INTO raw (id, space, source, work_item_id, work_action_id, agent_id, agent_handled, agent_response, agent_responded_at, author, chat_id, message_id, content, attachments_json, created, ingested, admission)
         VALUES ($id, $space, $source, $workItem, $workAction, $agent, $handled, $response, $respondedAt, $author, $chat, $msg, $content, $att, $created, $ingested, $admission)`,
      )
      .run({
        $id: record.id,
        $space: record.space,
        $source: record.source,
        $workItem: record.workItemId ?? null,
        $workAction: record.workActionId ?? null,
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
        $admission: record.admission,
      });
      this.insertRawFts(record);
    })();
  }

  private insertRawFts(record: RawRecord): void {
    // Finalize these extra FTS statements instead of extending Bun's query cache;
    // otherwise complex Space workflows can retain Windows database handles on close.
    this.db.run(`INSERT INTO raw_fts (rowid, id, body) VALUES ((SELECT rowid FROM raw WHERE id = ?), ?, ?)`, [record.id, record.id,
      toSearchText([record.id, record.chatId, record.messageId, record.author, record.content].filter(Boolean).join("\n"))]);
  }

  private insertRetractionProjection(record: MessageRetractionRecord): void {
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

  // ---- pages ---------------------------------------------------------------

  assertPageSourcesAdmitted(page: Page): void {
    for (const sourceId of page.sources) {
      const source = this.getRaw(sourceId);
      if (source && source.admission !== "ready") {
        throw new Error(`page source Raw is not admitted: ${sourceId}`);
      }
    }
  }

  upsertPage(page: Page): void {
    this.assertPageSourcesAdmitted(page);
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
    const safeLimit = normalizeSearchLimit(limit);
    if (safeLimit === 0) return [];
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
        .all(match, safeLimit) as Record<string, unknown>[];
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

  /** FTS projection of admitted Raw, including records not yet distilled into pages. */
  searchRaw(query: string, limit = 20): RawRecord[] {
    const safeLimit = normalizeSearchLimit(limit);
    const match = toMatchQuery(query.slice(0, 4000));
    if (!safeLimit || !match) return [];
    const statement = this.db.prepare(`SELECT r.* FROM raw_fts f JOIN raw r ON r.id = f.id
      WHERE raw_fts MATCH ? AND r.admission = 'ready'
        AND NOT EXISTS (SELECT 1 FROM message_retractions m WHERE m.chat_id = r.chat_id AND m.message_id = r.message_id)
      ORDER BY bm25(raw_fts), r.created DESC, r.id LIMIT ?`);
    try {
      const rows = statement.all(match, safeLimit) as Record<string, unknown>[];
      return rows.map(rowToRaw);
    } finally { statement.finalize(); }
  }

  insertRaw(entry: RawEntry): string {
    const admission = entry.admission ?? "ready";
    const hasWorkAction = entry.workActionId !== undefined;
    const validWorkActionCapture = hasWorkAction
      && typeof entry.workActionId === "string"
      && entry.workActionId.trim().length > 0
      && entry.source === "task"
      && admission === "held";
    if ((hasWorkAction && !validWorkActionCapture) || (!hasWorkAction && admission !== "ready")) {
      throw new Error("New WorkAction Raw must start as a held task owned by an action");
    }
    const id = randomUUID();
    const record: RawRecord = {
      ...entry,
      id,
      admission,
      createdAt: entry.createdAt ?? Date.now(),
      ingested: false,
      ...(entry.source === "message"
        ? { agentHandled: entry.agentHandled ?? Boolean(entry.agentId) }
        : {}),
    };
    this.rawJournal?.insert(record);
    this.insertRawProjection(record);
    return id;
  }

  /** Idempotent source snapshot capture; repair only the rebuildable projection on retry. */
  captureImportedRaw(id: string, entry: RawEntry): boolean {
    if (!/^chat-import-[a-f0-9]{64}$/.test(id) || entry.source !== "manual" || entry.workActionId || entry.admission) {
      throw new Error("Invalid imported Raw capture");
    }
    // The journal may already have committed when a previous projection write failed.
    const existing = this.rawJournal ? this.rawJournal.getRaw(id) : this.getRaw(id);
    if (existing) {
      if (existing.space !== entry.space || existing.chatId !== entry.chatId || existing.messageId !== entry.messageId) {
        throw new Error("Imported Raw identity mismatch");
      }
      if (chatRawEntryUpdatedAt(entry) !== undefined && chatRawVersionContent(existing) !== chatRawVersionContent(entry)) {
        throw new Error("Imported Raw version conflict");
      }
      if (!this.getRaw(id)) this.insertRawProjection(existing);
      return false;
    }
    const record: RawRecord = { ...structuredClone(entry), id, admission: "ready", ingested: false, createdAt: entry.createdAt ?? Date.now() };
    this.rawJournal?.insert(record);
    this.insertRawProjection(record);
    return true;
  }

  /** Restore one exact raw record, preserving its provenance id and state. */
  restoreRaw(record: RawRecord): void {
    if (this.getRaw(record.id)) throw new Error(`Raw id already exists: ${record.id}`);
    this.rawJournal?.insert(record);
    this.insertRawProjection(record);
  }

  /** Chronological order, with durable id as the stable same-millisecond tie-breaker. */
  listRaw(
    opts: { onlyPending?: boolean; onlyAdmitted?: boolean; limit?: number } = {},
  ): RawRecord[] {
    const filters: string[] = [];
    if (opts.onlyPending) filters.push("ingested = 0");
    if (opts.onlyPending || opts.onlyAdmitted) filters.push("admission = 'ready'");
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ``;
    const limit = opts.limit === undefined
      ? ``
      : `LIMIT ${Math.max(0, Math.floor(opts.limit))}`;
    const rows = this.db
      .query(`SELECT * FROM raw ${where} ORDER BY created ASC, id ASC ${limit}`)
      .all() as Record<string, unknown>[];
    return rows.map(rowToRaw);
  }

  getRaw(id: string): RawRecord | null {
    const row = this.db.query(`SELECT * FROM raw WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | null;
    return row ? rowToRaw(row) : null;
  }

  /** Admit one held WorkAction result; repeated calls for the same action are safe. */
  promoteRawAdmission(id: string, workActionId: string): boolean {
    return this.transitionRawAdmission(id, workActionId, "ready");
  }

  /** Exclude one held WorkAction result; terminal states cannot be reversed. */
  excludeRawAdmission(id: string, workActionId: string): boolean {
    return this.transitionRawAdmission(id, workActionId, "excluded");
  }

  private transitionRawAdmission(
    id: string,
    workActionId: string,
    target: "ready" | "excluded",
  ): boolean {
    if (!workActionId.trim()) return false;
    const current = this.getRaw(id);
    if (!current || current.workActionId !== workActionId) return false;
    if (current.admission === target) return true;
    if (current.admission !== "held") return false;
    this.rawJournal?.replaceMany([{ ...current, admission: target }]);
    const result = this.db
      .query(
        `UPDATE raw SET admission = ?
         WHERE id = ? AND work_action_id = ? AND admission = 'held'`,
      )
      .run(target, id, workActionId);
    return result.changes > 0;
  }

  /**
   * Repair pre-admission task captures from durable WorkAction state at startup.
   * This is intentionally stronger than the normal terminal transition APIs.
   */
  reconcileWorkActionRawAdmission(
    id: string,
    workActionId: string,
    admission: RawAdmission,
  ): boolean {
    if (!workActionId.trim()) return false;
    const current = this.getRaw(id);
    if (
      !current
      || current.source !== "task"
      || (current.workActionId !== undefined && current.workActionId !== workActionId)
    ) return false;
    this.rawJournal?.replaceMany([{
      ...current,
      workActionId,
      admission,
    }]);
    const result = this.db
      .query(
        `UPDATE raw
         SET work_action_id = ?, admission = ?
         WHERE id = ?
           AND source = 'task'
           AND (work_action_id IS NULL OR work_action_id = ?)`,
      )
      .run(workActionId, admission, id, workActionId);
    return result.changes > 0;
  }

  attributeRawToAgent(id: string, agentId: string): boolean {
    if (!agentId.trim()) return false;
    const current = this.getRaw(id);
    if (!current || current.source !== "message") return false;
    this.rawJournal?.replaceMany([{ ...current, agentId, agentHandled: true }]);
    const result = this.db
      .query(
        `UPDATE raw
         SET agent_id = ?, agent_handled = 1
         WHERE id = ? AND source = 'message'`,
      )
      .run(agentId, id);
    return result.changes > 0;
  }

  markRawAgentHandled(id: string): boolean {
    const current = this.getRaw(id);
    if (!current || current.source !== "message") return false;
    if (current.agentHandled === true) return true;
    this.rawJournal?.replaceMany([{ ...current, agentHandled: true }]);
    const result = this.db
      .query(`UPDATE raw SET agent_handled = 1 WHERE id = ? AND source = 'message'`)
      .run(id);
    return result.changes > 0;
  }

  recordAgentResponse(
    chatId: string,
    messageId: string,
    response: string,
    respondedAt = Date.now(),
  ): boolean {
    const current = this.findRawsByMessageId(messageId, chatId)
      .filter((record) => record.source === "message");
    if (current.length === 0) return false;
    this.rawJournal?.replaceMany(current.map((record) => ({
      ...record,
      agentResponse: response,
      agentRespondedAt: respondedAt,
    })));
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

  listRawsByWorkAction(workActionId: string): RawRecord[] {
    if (!workActionId.trim()) return [];
    const rows = this.db
      .query(
        `SELECT * FROM raw
         WHERE work_action_id = ?
         ORDER BY created ASC, id ASC`,
      )
      .all(workActionId) as Record<string, unknown>[];
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

  /** Matches listRaw ordering even when the caller supplies ids in another order. */
  listRawByIds(
    ids: string[],
    opts: { onlyPending?: boolean; onlyAdmitted?: boolean; limit?: number } = {},
  ): RawRecord[] {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const pending = opts.onlyPending ? "AND ingested = 0" : "";
    const admitted = opts.onlyAdmitted ? "AND admission = 'ready'" : "";
    const limit = opts.limit === undefined ? "" : `LIMIT ${Math.max(0, Math.floor(opts.limit))}`;
    const rows = this.db
      .query(
        `SELECT * FROM raw
         WHERE id IN (${placeholders}) ${pending} ${admitted}
         ORDER BY created ASC, id ASC ${limit}`,
      )
      .all(...uniqueIds) as Record<string, unknown>[];
    return rows.map(rowToRaw);
  }

  deleteRaw(id: string): void {
    this.rawJournal?.deleteMany([id]);
    this.db.transaction(() => {
      this.db.run(`DELETE FROM raw_fts WHERE rowid = (SELECT rowid FROM raw WHERE id = ?)`, [id]);
      this.db.query(`DELETE FROM raw WHERE id = ?`).run(id);
    })();
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
    if (this.getMessageRetraction(input.chatId, input.messageId)) return;
    const record: MessageRetractionRecord = { ...input, createdAt: Date.now() };
    this.rawJournal?.insertRetraction(record);
    this.insertRetractionProjection(record);
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
    if (this.getMessageRetraction(record.chatId, record.messageId)) {
      throw new Error(`message retraction already exists: ${record.chatId}/${record.messageId}`);
    }
    this.rawJournal?.insertRetraction(record);
    this.insertRetractionProjection(record);
  }

  markIngested(ids: string[]): void {
    this.setRawIngested(ids, true);
  }

  markPending(ids: string[]): void {
    this.setRawIngested(ids, false);
  }

  private setRawIngested(ids: string[], ingested: boolean): void {
    if (ids.length === 0) return;
    const records = this.listRawByIds(ids);
    this.rawJournal?.replaceMany(records.map((record) => ({ ...record, ingested })));
    const value = ingested ? 1 : 0;
    const update = this.db.transaction((batch: string[]) => {
      const stmt = this.db.query(`UPDATE raw SET ingested = ? WHERE id = ?`);
      for (const id of batch) stmt.run(value, id);
    });
    update(ids);
  }

  countRaw(onlyPending = false): number {
    const q = onlyPending
      ? `SELECT COUNT(*) n FROM raw WHERE ingested = 0 AND admission = 'ready'`
      : `SELECT COUNT(*) n FROM raw`;
    const r = this.db.query(q).get() as { n: number };
    return r.n;
  }

  countRawByAdmission(admission: RawAdmission): number {
    const row = this.db
      .query(`SELECT COUNT(*) n FROM raw WHERE admission = ?`)
      .get(admission) as { n: number };
    return row.n;
  }

  /** Delete expired message bodies only after they have been distilled/handled. */
  deleteExpiredRawMessages(cutoff: number, protectedIds: ReadonlySet<string> = new Set()): number {
    const candidates = this.db
      .query(`SELECT * FROM raw WHERE source = 'message' AND ingested = 1 AND created < ?`)
      .all(cutoff) as Array<Record<string, unknown>>;
    const records = candidates.map(rowToRaw).filter((record) => !protectedIds.has(record.id));
    this.rawJournal?.deleteMany(records.map((record) => record.id));
    let deleted = 0;
    const remove = this.db.transaction((ids: string[]) => {
      const statement = this.db.query(`DELETE FROM raw WHERE id = ?`);
      for (const id of ids) {
        this.db.run(`DELETE FROM raw_fts WHERE rowid = (SELECT rowid FROM raw WHERE id = ?)`, [id]);
        deleted += statement.run(id).changes;
      }
    });
    remove(records.map(({ id }) => id));
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
    ...(row.work_item_id == null ? {} : { workItemId: String(row.work_item_id) }),
    ...(row.work_action_id == null ? {} : { workActionId: String(row.work_action_id) }),
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
    admission: String(row.admission ?? "ready") as RawRecord["admission"],
  };
}
