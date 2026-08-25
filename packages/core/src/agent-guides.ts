import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isSpaceId, spaceToDir } from "@homeagent/shared";
import { durableFsyncSync } from "./durable-file.ts";

const DATA_REPOSITORY_AGENT_GUIDE = [
  "# HomeAgent 数据仓库 agent guide",
  "",
  "本目录是正在使用的 HomeAgent 数据目录，不是应用源码仓库。除非用户明确要求通过 HomeAgent 的公开治理流程变更数据，否则默认只读。",
  "",
  "## 首选：本地只读 Agent 接口",
  "",
  "- 若宿主已经配置 HomeAgent MCP，优先使用它，不要直接遍历数据目录：先用 `list_spaces` 确定一个 Space，再按 `get_overview` → `list_maps`/`search_knowledge` → `get_page` 的顺序渐进读取。",
  "- 只有需要核验 provenance 时才调用 `get_page_trace`。该接口只返回有界的 Raw 元数据，不返回 Raw 正文，也不能写入、触发 Provider 或跨 Space 查询。",
  "- MCP 不可用时，才按下面的文件读取顺序降级；不要为了绕过接口边界而批量扫描目录。",
  "",
  "## 渐进式读取",
  "",
  "1. 先确定请求属于哪一个 Space；一条记录只属于一个 Space，禁止跨 Space 拼接、推断或写入。",
  "2. 进入目标 `workspaces/<dir>/` 后，先读 `purpose.md` 和 `schema.md`。",
  "3. 再读 `wiki/overview.md`，从核心主题或最近更新判断下一步；需要完整主题列表或术语定位时再读 `wiki/index.md` 与 `wiki/glossary.md`。",
  "4. 命中主题后沿 `wiki/maps/*.md` 逐层缩小范围；大型主题可能指向下一级 map，只继续读取与请求相关的分支。",
  "5. 只打开地图命中的普通知识页。需要核对来源时，再读取页面列出的来源或相关 `wiki/sources/*.md`；页面更新时间不是证据时间，证据时间以其最新一条已准入 Raw 的 `createdAt` 为准。",
  "6. 只有在用户明确要求核验 provenance、撤回状态或原始上下文时，才按已知日期或 Raw id 有界读取 `raw/records/**/*.jsonl` 与 `raw/retractions.jsonl`；不要批量加载整个 Raw journal。",
  "",
  "## 数据契约",
  "",
  "- `raw/records/**/*.jsonl` 与 `raw/retractions.jsonl` 是 Raw 状态的权威来源。",
  "- `wiki/**/*.md` 是 Knowledge page 的权威来源；`.index.db*` 只是可重建的 SQLite projection。",
  "- held 证据在人工接受前不能进入知识页；rejected、cancelled、failed 或 excluded 证据不能被知识页引用。",
  "- 来源 Raw 缺失或未准入时证据链不完整，应停止把页面结论当作已核验事实；证据较久只触发复核，不表示知识自动失效。",
  "- 回答时明确区分已提炼知识、原始证据和 agent 自己的推断，并保留页面或 Raw id 引用。",
  "",
  "## 写入与隐私边界",
  "",
  "- 不要手工编辑运行中的 HomeAgent 数据目录。需要变更时使用 HomeAgent 管理后台或公开治理接口；没有安全写入入口时停止并请求用户决定。",
  "- 不要手工修改 `config/`、`quality/`、`run/`、`logs/`、`.index.db*`、Raw journal、系统生成的 `wiki/{index,overview,log,glossary}.md` 或 `wiki/maps/*.md`。",
  "- 不要把 App Secret、token、授权码、完整消息正文或原始 provider diagnostics 复制到日志、公开错误、提交说明或其他 Space。",
  "- 不要删除旧数据目录；迁移必须先暂存并验证，再原子切换。",
  "",
  "进入具体 Space 后继续遵守该目录中的 `AGENTS.md`。",
  "",
].join("\n");

const SPACE_AGENT_GUIDE = [
  "# HomeAgent Space agent guide",
  "",
  "本目录只代表当前 Space。根目录 `AGENTS.md` 的隔离、写入和隐私规则继续适用；不要读取或合并相邻 Space 的内容。",
  "",
  "## 首选：本地只读 Agent 接口",
  "",
  "- 若宿主已经配置 HomeAgent MCP，先用 `get_overview` 读取当前 Space，再用 `list_maps` 或 `search_knowledge` 定位主题，最后用 `get_page` 读取正文。",
  "- 只有需要核验 provenance 时才调用 `get_page_trace`；不要借此读取或拼接其他 Space。MCP 不可用时才按下面的文件顺序降级。",
  "",
  "## 按需读取顺序",
  "",
  "1. 先读 `purpose.md`，确认当前 Space 的目标、受众和关注范围。",
  "2. 再读 `schema.md`，理解 entity、concept、source、analysis 等页面类型的使用规则。",
  "3. 用 `wiki/overview.md` 了解核心主题与最近更新；需要完整主题列表或术语定位时，再读 `wiki/index.md` 与 `wiki/glossary.md`。",
  "4. 沿命中的 `wiki/maps/*.md` 逐层缩小范围；大型主题可能包含下一级 map，只读取相关分支。",
  "5. 只读取地图命中的普通知识页。需要补足来源语境时，再读页面引用的 `wiki/sources/` 页面。",
  "6. 只有需要验证 provenance 时，才根据知识页记录的 Raw id 或已知日期有界读取 `raw/`；不要扫描整个 Raw journal。",
  "",
  "## 回答与证据",
  "",
  "- 优先依据与问题直接相关、来源清楚的 Knowledge page；页面更新时间不是证据时间，证据时间以已准入 Raw 的 `createdAt` 为准。",
  "- 引用结论时给出知识页 slug；核验过 Raw 后同时给出 Raw id，并说明哪些内容是 agent 推断。",
  "- 信息冲突时优先采用证据最新且证据链完整的页面；来源 Raw 缺失或未准入时停止并明确说明，不要用其他 Space 的材料补齐。",
  "- 证据年龄只表示 provenance 新旧；证据较久应提示复核，但知识不会自动失效。",
  "- held 或 excluded Raw 不能作为可进入知识页的证据，也不能被描述成已接受结论。",
  "",
  "## 变更边界",
  "",
  "- `purpose.md` 与 `schema.md` 只能通过 HomeAgent 的空间治理入口修改。",
  "- `wiki/{index,overview,log,glossary}.md` 与 `wiki/maps/*.md` 由系统生成；Raw、SQLite projection 和运行配置都不得手工编辑。",
  "- 请求超出当前 Space、需要批量读取 Raw 或缺少安全写入入口时，停止并请求用户明确授权或补充范围。",
  "",
].join("\n");

export function ensureDataRepositoryAgentGuide(dataDir: string): void {
  writeGuideIfAbsent(join(dataDir, "AGENTS.md"), DATA_REPOSITORY_AGENT_GUIDE);
}

/** Seed root and verified Space guides without opening runtime projections. */
export function ensureDataRepositoryAgentGuides(dataDir: string): void {
  ensureDataRepositoryAgentGuide(dataDir);
  const workspaces = join(dataDir, "workspaces");
  if (!existsSync(workspaces)) return;

  for (const entry of readdirSync(workspaces, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const spaceRoot = join(workspaces, entry.name);
    const marker = join(spaceRoot, ".spaceid");
    let space: string;
    try {
      const markerStat = lstatSync(marker);
      if (!markerStat.isFile() || markerStat.size > 512) continue;
      space = readFileSync(marker, "utf8").trim();
    } catch {
      // A missing, changing, or unreadable marker does not prove ownership of
      // the directory, so migration and startup leave that entry untouched.
      continue;
    }
    if (!isSpaceId(space) || spaceToDir(space) !== entry.name) continue;
    ensureSpaceAgentGuide(spaceRoot);
  }
}

export function ensureSpaceAgentGuide(spaceRoot: string): void {
  writeGuideIfAbsent(join(spaceRoot, "AGENTS.md"), SPACE_AGENT_GUIDE);
}

function writeGuideIfAbsent(path: string, contents: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  if (existsSync(path)) return;

  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const fileDescriptor = openSync(temporary, "r+");
    try {
      durableFsyncSync(fileDescriptor);
    } finally {
      closeSync(fileDescriptor);
    }

    try {
      // Linking a same-directory temporary file is an atomic create-if-absent
      // commit. Unlike rename, it cannot replace a guide written by the user or
      // by another HomeAgent process between the existence check and commit.
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return;
    }

    try {
      const directoryDescriptor = openSync(directory, "r");
      try {
        durableFsyncSync(directoryDescriptor, {
          allowUnsupportedDirectoryOnWindows: true,
        });
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch {
      // The hard link is the logical commit point. Some Windows/Bun versions
      // cannot open or flush directories, but the complete guide is visible.
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}
