import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { assertLocalStatePath, writeAtomicStateFile } from "./durable-file.ts";

const MAX_BYTES = 512 * 1024;
const MAX_IDS = 1000;
export interface ChatSourceProgress {
  version: 1;
  scope: string;
  sourceChatId?: string;
  retryStartAt: number;
  pendingThrough: number;
  coveredThrough?: number;
  failedMessageIds: string[];
}

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 253_402_300_799_999;
}
function parse(value: unknown): ChatSourceProgress {
  if (!value || typeof value !== "object") throw new Error("Invalid chat source progress");
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.scope !== "string" || !/^[a-f0-9]{64}$/.test(v.scope)
    || !validTime(v.retryStartAt) || !validTime(v.pendingThrough) || v.retryStartAt > v.pendingThrough
    || (v.coveredThrough !== undefined && (!validTime(v.coveredThrough) || v.coveredThrough > v.pendingThrough))
    || (v.sourceChatId !== undefined && (typeof v.sourceChatId !== "string" || !v.sourceChatId.trim() || v.sourceChatId.length > 256 || v.sourceChatId.includes("\0")))
    || !Array.isArray(v.failedMessageIds) || v.failedMessageIds.length > MAX_IDS
    || v.failedMessageIds.some(id => typeof id !== "string" || !id.trim() || id.length > 256 || id.includes("\0"))) {
    throw new Error("Invalid chat source progress");
  }
  return { version: 1, scope: v.scope, retryStartAt: v.retryStartAt, pendingThrough: v.pendingThrough,
    ...(typeof v.sourceChatId === "string" ? { sourceChatId: v.sourceChatId } : {}),
    ...(v.coveredThrough === undefined ? {} : { coveredThrough: v.coveredThrough as number }),
    failedMessageIds: v.failedMessageIds.map(id => String(id)) };
}

/** Local workflow state, never an independent claim of verified source completeness. */
export class ChatSourceProgressStore {
  readonly file: string;
  readonly scope: string;
  private readonly legacySourceChatId?: string;
  constructor(private dataDir: string, spaceRoot: string, space: string, ownership: string, sourceSelector?: string) {
    this.file = sourceSelector === undefined ? join(spaceRoot, ".chat-source-progress.json")
      : join(spaceRoot, ".chat-source-progress", `${createHash("sha256").update(sourceSelector).digest("hex")}.json`);
    this.scope = createHash("sha256").update(JSON.stringify(sourceSelector === undefined ? [space, ownership] : [space, ownership, sourceSelector])).digest("hex");
    this.legacySourceChatId = sourceSelector === undefined && space.startsWith("team/") ? space.slice(5) : undefined;
  }
  read(): ChatSourceProgress | undefined {
    assertLocalStatePath(this.dataDir, this.file);
    if (!existsSync(this.file)) return undefined;
    const fd = openSync(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES) throw new Error("Invalid chat source progress");
      const bytes = Buffer.alloc(before.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, null);
        if (!count) break;
        size += count;
      }
      const after = fstatSync(fd);
      if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("Invalid chat source progress");
      assertLocalStatePath(this.dataDir, this.file);
      const state = parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))));
      return state.scope === this.scope ? state : undefined;
    } finally { closeSync(fd); }
  }
  /** Serialize per Space. Register incomplete before Raw writes; commit complete only after all succeed. */
  commit(window: { startAt: number; endAt: number; incomplete: boolean; failedMessageIds: string[]; sourceChatId?: string }): ChatSourceProgress {
    const saved = this.read();
    // Legacy default files were restricted to their own Team Space's group.
    const previous = saved && (saved.sourceChatId === window.sourceChatId
      || (saved.sourceChatId === undefined && window.sourceChatId === this.legacySourceChatId)) ? saved : undefined;
    const retryStartAt = Math.min(previous?.retryStartAt ?? window.startAt, window.startAt);
    const pendingThrough = Math.max(previous?.pendingThrough ?? window.endAt, window.endAt);
    // A later or partial window cannot erase an earlier gap. Re-querying the full pending interval is deliberate.
    const complete = !window.incomplete && window.startAt <= retryStartAt && window.endAt >= pendingThrough;
    const failedMessageIds = complete ? [] : [...new Set([...(previous?.failedMessageIds ?? []), ...window.failedMessageIds])];
    const next = parse({ version: 1, scope: this.scope, sourceChatId: window.sourceChatId, retryStartAt: complete ? pendingThrough : retryStartAt,
      pendingThrough, coveredThrough: complete ? pendingThrough : previous?.coveredThrough, failedMessageIds });
    const content = JSON.stringify(next);
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error("Invalid chat source progress");
    assertLocalStatePath(this.dataDir, this.file);
    writeAtomicStateFile(this.file, content);
    return structuredClone(next);
  }
}

export function chatSourceProgressInstruction(state: ChatSourceProgress | undefined): string {
  if (!state) return "尚无已提交的增量基线；按用户指定时间窗口查询。";
  const hint = { retryStartAt: state.retryStartAt, pendingThrough: state.pendingThrough, coveredThrough: state.coveredThrough,
    sourceChatId: state.sourceChatId,
    failedMessageIds: state.failedMessageIds.slice(0, 50), failedCount: state.failedMessageIds.length };
  return `该来源目标上次已落盘的查询进度（不代表服务器独立验证）：${JSON.stringify(hint)}。failedMessageIds 最多展示前 50 个，failedCount 为总数；仍需重新查询整个待补窗口，不能只补展示的 ID 就声称完成。只有用户要求继续/增量时才以 retryStartAt 为起点，并回看至少 1 秒防止边界漏数；明确指定最近一周时仍完整查询最近一周，不缩短。存在未完成窗口时，补查范围应包含 retryStartAt—pendingThrough，并用 +messages-mget 补读 failedMessageIds；若超出本次用户指定窗口，只报告尚有历史缺口，不擅自扩大正文范围。已完成基线也需重叠回查以发现编辑，不能声称覆盖了未重查的历史编辑。`;
}
