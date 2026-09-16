import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Attachment, RawEntry, RawRecord, SpaceId } from "@homeagent/shared";

export const MAX_CHAT_IMPORT_BYTES = 8 * 1024 * 1024;
export const MAX_CHAT_IMPORT_MESSAGES = 1000;
export const MAX_CHAT_IMPORT_TEXT = 100_000;

export interface ChatRawImportReceipt {
  imported: number;
  updated?: number;
  progress?: { retryStartAt: number; coveredThrough?: number };
  duplicates: number;
  excluded: number;
  incomplete: boolean;
}

export interface ChatRawCapture {
  file: string;
  workdir: string;
  instruction: string;
}

export interface ParsedChatRawImport {
  chatId: string;
  entries: RawEntry[];
  startAt: number;
  endAt: number;
  failedMessageIds: string[];
  excluded: number;
  incomplete: boolean;
}

export interface ChatRawSourceScope {
  requestedName?: string;
  requestedChatId?: string;
}

function normalizedChatName(name: string): string { return name.normalize("NFKC").replace(/\s+/gu, ""); }

/** Only user request text can select an external source; fetched text cannot grant scope. */
export function chatRawSourceScope(input: string): ChatRawSourceScope {
  if (input.length > 20_000) return {};
  if (/(?:飞书群|群聊)\s*[:：]?\s*(?:最近|近一周|过去)/u.test(input)) return {};
  const names = [...input.matchAll(/(?:飞书群|群聊)\s*[:：]?\s*[「“"《]?([^\n，,。；;」”"》]+?)(?:[」”"》]|(?=\s*(?:提炼|总结|整理|查询|拉取|读取|分析|最近|近一周))|$)/gu)];
  if (names.length > 1) return {};
  if (names.length === 1) {
    const name = normalizedChatName(names[0]![1]!);
    if (!name || name.length > 256 || /^(?:本群|当前群|这个群)$/u.test(name) || /^(?:最近|近一周|过去)/u.test(name)) return {};
    return /^oc_[A-Za-z0-9]+$/.test(name) ? { requestedChatId: name } : { requestedName: name };
  }
  const ids = [...new Set(input.match(/\boc_[A-Za-z0-9]+\b/g) ?? [])];
  if (ids.length === 1 && !/(?:不要|别|排除|不是).{0,20}oc_/u.test(input)) return { requestedChatId: ids[0]! };
  return {};
}

function invalid(): never { throw new Error("聊天原始记录文件无效或超出入库范围"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim()) || value.includes("\0")) invalid();
  return value;
}
function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 253_402_300_799_999) invalid();
  return value;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  return value;
}
function boolean(value: unknown): boolean { if (typeof value !== "boolean") invalid(); return value; }

/** Explicit preservation intent only; never inspect fetched source text for authorization. */
function requestsRawPreservation(text: string): boolean {
  const preservation = /保存|收录|入库|留存/u.test(text)
    // Match the action “记录相关信息” / “把消息记录下来”, not the noun “聊天记录”.
    || /(?:^|[，,。；;\s]|并|请|再|同时|以及)记录|记录(?:下来|一下|到|进)/u.test(text);
  return preservation && !declinesRawPreservation(text);
}

function declinesRawPreservation(text: string): boolean {
  return /(?:不要|无需|不必|不用|别|不想|不需要|不再|不|取消|停止)\s*(?:自动)?\s*(?:保存|记录|收录|入库|留存)/u.test(text)
    || /(?:只|仅)(?:要|需|需要)?\s*(?:保存|记录|收录|入库|留存)\s*(?:总结|摘要|周报|报告|结论|提炼结果)/u.test(text);
}

export function requestsChatRawImport(text: string): boolean {
  return text.length <= 20_000 && /群|聊天|飞书/u.test(text) && requestsRawPreservation(text);
}

/** Resolve workflow intent from durable user turns; never replay conversation text to the Provider. */
export function resolveChatRawImportRequest(inputs: readonly string[]): ChatRawSourceScope | undefined {
  let enabled = false;
  let hasChatContext = false;
  let scope: ChatRawSourceScope = {};
  let captureThisTurn = false;
  for (const input of inputs) {
    captureThisTurn = false;
    if (input.length > 20_000) continue;
    const declared = chatRawSourceScope(input);
    if (declared.requestedName || declared.requestedChatId || /本群|当前群|这个群/u.test(input)) {
      scope = declared;
      hasChatContext = true;
    }
    if (/群|聊天|飞书/u.test(input)) hasChatContext = true;
    if (declinesRawPreservation(input)) enabled = false;
    else if (hasChatContext && requestsRawPreservation(input)) enabled = true;
    const continuation = /提炼|总结|整理|查询|拉取|读取|补查|补读|补全|增量|继续|再查|重试/u.test(input)
      || /(?:最近|过去|近)[一二两三四五六七八九十\d]+(?:天|周|个月)/u.test(input);
    captureThisTurn = enabled && (requestsRawPreservation(input) || continuation);
  }
  return captureThisTurn ? { ...scope } : undefined;
}

export function createChatRawCapture(workdir: string, chatId: string, sourceScope: ChatRawSourceScope = {}): ChatRawCapture {
  const canonical = realpathSync(workdir);
  if (canonical !== workdir || !lstatSync(workdir).isDirectory() || lstatSync(workdir).isSymbolicLink()) invalid();
  const file = join(workdir, `homeagent-chat-raw-${randomUUID()}.json`);
  return {
    file, workdir,
    instruction: [
      "## 本轮聊天原文自动入库交接",
      `当前消息发送与回答所在群 ID 是 ${JSON.stringify(chatId)}，它只用于当前 Space 的入库校验，不是用户指定的查询目标。用户明确指定的群名或群 ID 决定查询来源；不得用当前群替换目标群。`,
      CHAT_SOURCE_QUERY_INSTRUCTIONS,
      `本轮由当前及同话题此前用户请求确定的查询来源范围：${JSON.stringify(sourceScope)}。沿用同话题已明确的原文保存要求，时间窗口按本轮请求执行。Raw 保存到发起请求的当前 Space，source chatId 保留实际来源；当范围含 requestedName 时，必须通过群搜索唯一匹配并在交接顶层提供实际返回的 chatName，名称忽略空白和全半角后须匹配；含 requestedChatId 时只能交接该 ID。范围为空时自动入库只接受当前群。`,
      `将实际 CLI 查询结果用程序转换为 UTF-8 JSON，写入 ${JSON.stringify(file)}；不要在回答中转抄全文，也不要用总结改写原文。查询目标已匹配本轮来源范围时，即使与当前群不同也正常交接，不要求用户重复确认群 ID。不得把实际来源群 ID 改成当前群来绕过校验。`,
      '若查询目标不在上述可自动入库范围，继续完成用户明确指定的目标群查询、提炼及授权的 Workdir 文件保存。交接路径只写状态 {"version":1,"status":"source-outside-current-space","chatId":"实际目标群 ID"}，不附正文，说明未自动入库；不要因此停下查询。只有群名重名、无法解析或实际权限不足时才说明需要补充的信息。',
      "只使用本轮指定的交接路径，忽略历史会话中的旧交接路径；不要把旧文件当作本次查询结果。作者未知时省略 author，不猜测身份。",
      `文件最多 ${MAX_CHAT_IMPORT_BYTES} 字节、${MAX_CHAT_IMPORT_MESSAGES} 条消息；每条正文最多 ${MAX_CHAT_IMPORT_TEXT} 字符、32 个附件引用。超限时交接有界批次并将完整性标为 false，不静默截断正文。`,
      '格式：{"version":1,"chatId":"来源群 ID","startAt":毫秒时间戳,"endAt":毫秒时间戳,"mainComplete":布尔值,"threadsComplete":布尔值,"olderThreadsScanned":布尔值,"failedMessageIds":["未取得正文的消息 ID"],"messages":[{"messageId":"消息 ID","createdAt":毫秒时间戳,"author":"发送者 ID 或名称","text":"原始正文","threadId":"可选线程 ID","rootMessageId":"可选根消息 ID","url":"可选 https 消息链接","attachments":[{"kind":"file 或 image 或 audio 或 pdf","ref":"附件引用","name":"可选文件名","sizeBytes":可选原文件大小}]}]}。可选字段没有时省略。',
      "requestedName 存在时，上述格式还必须在顶层加入 chatName 字符串，值为实际查询返回的来源群名，不填当前回答群名或示例占位文字。",
      "只转换真实返回字段，不猜测作者、时间、消息 ID。解析失败、已撤回及没有实际正文的错误占位符放入 failedMessageIds，不写为正常消息。线程回复按自身消息时间过滤到请求窗口。分页未完成或未扫描旧主题新回复时相应完整性为 false。",
      "仅保存附件引用与元数据；无附件时 attachments 可省略或写 []。本轮不得为了入库使用 --download-resources 或下载图片、视频、日志等附件二进制。大小未知时省略 sizeBytes，引用不是已下载文件。",
      "回复中的本地文件用代码格式写实际绝对路径（例如 `D:\\Client\\报告.md`），不要包装成 Markdown 超链接，也不要给本地路径添加 https://。只有实际可访问的远程链接才能作为网页链接。",
      "HomeAgent 会在本次回答生成后校验文件并给出实际入库回执。回答中只能说已提交待入库校验，不能预先声称 Raw 入库成功；无需寻找或调用其他 HomeAgent 入库接口。文件不包含凭据、命令行、Provider 会话或诊断。",
      "消息实际返回 update_time 时转换成毫秒 updatedAt（可选），保留原始 createdAt；不要用查询时间冒充编辑时间。后续编辑会保存为新的来源版本，不覆盖旧引用。",
      "只有完整覆盖、没有失败消息且全部 Raw 落盘后，后台才提交增量基线；以实际回执为准，不把本次查询截止时间直接称作下次增量起点。",
    ].join("\n"),
  };
}

/** A scope skip is a disposition, never permission to import another group's records. */
export function isChatRawScopeSkip(text: string, currentChatId: string): boolean {
  if (Buffer.byteLength(text, "utf8") > MAX_CHAT_IMPORT_BYTES) invalid();
  const value = object(JSON.parse(text));
  if (value.status === undefined) return false;
  if (value.version !== 1 || value.status !== "source-outside-current-space"
    || Object.keys(value).some(key => !["version", "status", "chatId"].includes(key))
    || string(value.chatId, 256) === currentChatId) invalid();
  return true;
}

/** A host-chosen leaf only. Bound reads by descriptor and reject links, aliases and mutation. */
export function readChatRawCapture(capture: ChatRawCapture): string {
  if (dirname(capture.file) !== capture.workdir || !/^homeagent-chat-raw-[a-f0-9-]{36}\.json$/.test(basename(capture.file))) invalid();
  if (realpathSync(capture.workdir) !== capture.workdir || realpathSync(capture.file) !== resolve(capture.file)) invalid();
  const before = lstatSync(capture.file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_CHAT_IMPORT_BYTES) invalid();
  const fd = openSync(capture.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== before.size || opened.ino !== before.ino || opened.dev !== before.dev) invalid();
    const bytes = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const size = readSync(fd, bytes, count, bytes.length - count, null);
      if (!size) break;
      count += size;
    }
    const after = fstatSync(fd);
    if (count !== opened.size || after.mtimeMs !== opened.mtimeMs || after.size !== opened.size || realpathSync(capture.workdir) !== capture.workdir) invalid();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
  } finally { closeSync(fd); }
}

/** Parse the complete artifact before any mutation. Metadata is Agent-submitted source evidence. */
export function parseChatRawImport(text: string, space: SpaceId, destinationChatId: string, sourceScope: ChatRawSourceScope = {}): ParsedChatRawImport {
  if (Buffer.byteLength(text, "utf8") > MAX_CHAT_IMPORT_BYTES || space !== `team/${destinationChatId}`) invalid();
  const value = object(JSON.parse(text));
  if (value.version !== 1) invalid();
  const chatId = string(value.chatId, 256);
  const chatName = value.chatName === undefined ? undefined : string(value.chatName, 256);
  if (sourceScope.requestedChatId) {
    if (chatId !== sourceScope.requestedChatId) invalid();
  } else if (sourceScope.requestedName) {
    if (!chatName || normalizedChatName(chatName) !== sourceScope.requestedName) invalid();
  } else if (chatId !== destinationChatId) invalid();
  const startAt = timestamp(value.startAt), endAt = timestamp(value.endAt);
  if (endAt < startAt) invalid();
  const mainComplete = boolean(value.mainComplete), threadsComplete = boolean(value.threadsComplete);
  const olderThreadsScanned = boolean(value.olderThreadsScanned);
  const failedIds = list(value.failedMessageIds, MAX_CHAT_IMPORT_MESSAGES).map(id => string(id, 256));
  const failed = new Set(failedIds);
  const messages = list(value.messages, MAX_CHAT_IMPORT_MESSAGES);
  if (messages.length + failed.size > MAX_CHAT_IMPORT_MESSAGES) invalid();
  const seen = new Set<string>();
  const entries = messages.map((candidate, index) => {
    const message = object(candidate);
    const messageId = string(message.messageId, 256);
    if (seen.has(messageId) || failed.has(messageId)) invalid();
    seen.add(messageId);
    const createdAt = timestamp(message.createdAt);
    const updatedAt = message.updatedAt === undefined ? undefined : timestamp(message.updatedAt);
    if (updatedAt !== undefined && (updatedAt < createdAt || updatedAt > endAt)) invalid();
    if (createdAt > endAt || (createdAt < startAt && (updatedAt === undefined || updatedAt < startAt))) invalid();
    const author = message.author === undefined ? undefined : string(message.author, 512);
    const content = string(message.text, MAX_CHAT_IMPORT_TEXT, true);
    if (/^\s*\[.*(?:parse.*fail|fail.*pars|解析失败).*\]\s*$/iu.test(content)) invalid();
    const references = list(message.attachments === undefined ? [] : message.attachments, 32).map(candidate => {
      const ref = object(candidate);
      if (!["file", "image", "audio", "pdf"].includes(String(ref.kind)) || ref.sourceDigest !== undefined) invalid();
      const attachment: Attachment = { kind: ref.kind as Attachment["kind"], ref: string(ref.ref, 2048) };
      if (ref.name !== undefined) attachment.name = string(ref.name, 512);
      const sizeBytes = ref.sizeBytes === undefined ? undefined : timestamp(ref.sizeBytes);
      return { attachment, sizeBytes };
    });
    if (!content.trim() && references.length === 0) invalid();
    const metadata: Record<string, unknown> = {
      format: "homeagent.chat-source", version: 1, capture: "agent-submitted", chatId, chatName, messageId, createdAt, author,
      ...(updatedAt === undefined ? {} : { updatedAt }),
      window: { startAt, endAt },
      coverage: { mainComplete, threadsComplete, olderThreadsScanned, failedCount: failed.size,
        ...(index === 0 ? { failedMessageIds: failedIds } : {}) },
    };
    for (const field of ["threadId", "rootMessageId", "url"] as const) {
      if (message[field] === undefined) continue;
      const item = string(message[field], field === "url" ? 2048 : 256);
      if (field === "url") {
        const url = new URL(item);
        if (url.protocol !== "https:" || url.username || url.password) invalid();
      }
      metadata[field] = item;
    }
    metadata.attachments = references.map(({ attachment, sizeBytes }) => ({ ...attachment, ...(sizeBytes === undefined ? {} : { sizeBytes }) }));
    return {
      space, source: "manual" as const, chatId, messageId, author, createdAt,
      content: `<!-- HomeAgent: Agent 查询所得来源快照；附件仅为引用 -->\n${JSON.stringify(metadata)}\n\n${content}`,
      attachments: references.map(item => item.attachment),
    };
  });
  return { entries, chatId, startAt, endAt, failedMessageIds: [...failed], excluded: failed.size,
    incomplete: !mainComplete || !threadsComplete || !olderThreadsScanned || failed.size > 0 };
}

export function chatRawImportId(space: SpaceId, chatId: string, messageId: string, updatedAt?: number): string {
  return `chat-import-${createHash("sha256").update(JSON.stringify(updatedAt === undefined ? [space, chatId, messageId] : [space, chatId, messageId, updatedAt])).digest("hex")}`;
}

export function chatRawEntryUpdatedAt(entry: RawEntry): number | undefined {
  if (!entry.content.startsWith("<!-- HomeAgent: Agent 查询所得来源快照；附件仅为引用 -->\n")) return undefined;
  try {
    const metadata = object(JSON.parse(entry.content.split("\n", 2)[1]!));
    return metadata.format === "homeagent.chat-source" && metadata.updatedAt !== undefined ? timestamp(metadata.updatedAt) : undefined;
  } catch { return undefined; }
}

export function isChatSourceSnapshot(raw: RawRecord): boolean {
  return raw.source === "manual" && /^chat-import-[a-f0-9]{64}$/.test(raw.id)
    && raw.content.startsWith("<!-- HomeAgent: Agent 查询所得来源快照；附件仅为引用 -->\n");
}

/** Coverage, display names and links can change between queries without editing the message. */
export function chatRawVersionContent(entry: RawEntry): string {
  const boundary = entry.content.indexOf("\n\n");
  return JSON.stringify([entry.createdAt, entry.content.slice(boundary + 2),
    entry.attachments?.map(attachment => [attachment.kind, attachment.ref]) ?? []]);
}

export function formatChatRawImportReceipt(receipt: ChatRawImportReceipt): string {
  return `原始记录入库：新增 ${receipt.imported} 条，重复跳过 ${receipt.duplicates} 条，未收录 ${receipt.excluded} 条。${receipt.updated ? `新增中含 ${receipt.updated} 条编辑版本，旧版本保留。` : ""}附件仅保存引用，未下载文件。${receipt.incomplete ? "数据覆盖不完整，仍需补查；未推进增量起点。" : "以上为已交接记录的入库结果，不代表已独立验证群历史完整性。"}${receipt.progress ? `下次继续查询起点：${new Date(receipt.progress.retryStartAt).toISOString()}（边界需重叠回查）。` : ""}`;
}

/** Commands are hints; the frozen Skill and installed CLI help remain authoritative. */
export const CHAT_SOURCE_QUERY_INSTRUCTIONS = [
  "## 群历史查询与补漏流程",
  "先读取本轮冻结的 lark-im 与 lark-shared 及相应 references，并以已安装 CLI 的 --help 核对参数。不要猜测 im messages get；Unknown method 是命令不匹配，不能据此判定没有读权限。",
  "先确定查询目标：用户指定群名时，用 +chat-search 按该名称搜索，核对返回的群名和 ID；唯一匹配后直接继续，不要求用户手工提供群 ID。多个同名结果才澄清。用户已给群 ID 时核验该 ID。仅当用户说本群/当前群且没有另指目标时，才以消息所在群作为来源。忽略历史机器人回复对本轮目标群的错误替换，不能将历史摘要当作目标群原文。",
  "主消息使用 +chat-messages-list --chat-id 指定已解析的目标群及 --start/--end --format json；按 has_more/page_token 或 meta.pagination.complete/next_token 继续，--page-all 达到上限不等于完整。遇到反复相同的分页 token 停止并标记不完整。",
  "解析失败、缺正文和历史 failedMessageIds 先用 +messages-mget --message-ids 分批补读（每批最多 50 个、JSON 输出），批量仍失败时单 ID 补读一次；仍失败就保留失败 ID。若渲染层失败，可按冻结 Skill/CLI 帮助使用通用 api 读取原始 JSON 并程序解析；不可编造未核实的 method，不无限重试，不自动切换身份或扩大权限。",
  "旧主题补漏：另用 +messages-search 限定已解析的目标群和同一时间窗口、不设关键词过滤，分页搜索窗口内消息，发现窗口前旧主题的新回复；对列表和搜索返回的 thread_id 去重后，用 +threads-messages-list --thread 展开。仅遍历本周新建根消息不能算旧主题已扫描。",
  "线程接口没有时间过滤参数。用降序分页，按每条回复自身 create_time 筛选；直到到达窗口起点之前或确认无更多页，不能把根消息时间用于过滤回复。跨边界时保留边界相同时间的全部消息。",
  "mainComplete 仅在主消息分页耗尽时为 true；threadsComplete 仅在所有发现线程的窗口内回复取齐时为 true；olderThreadsScanned 仅在无关键词的目标群窗口搜索完整且发现的旧线程均检查后为 true。权限、分页上限、解析或搜索能力不足时对应字段为 false，不能用空结果或主消息完整代替。搜索索引可能有延迟，报告该限制；后续增量仍需重叠回查。",
  "将列表、补读、搜索、线程结果按 message_id 合并；优先采用有实际正文且 update_time 较新的返回。所有结果必须复核来源群，搜索不得省略 chat-id。已有编辑时间保留为 updatedAt；完整周报必须查询完整用户窗口，不能只总结新增入库条目。",
].join("\n");
