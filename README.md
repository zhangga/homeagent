# HomeAgent

深度绑定飞书的团队/家庭 AI 知识库 Agent。定位是「最了解我们的 agent」：它常驻飞书群与私聊，
默默收录大家分享的知识，夜间提炼成 wiki 知识页，并在被 @ 或私聊时基于知识库作答（带引用）；也能按天带读一本书，提问、反馈并记录进度。
图片仍会作为受治理的消息附件保存；Codex 普通会话可接收原生图片输入，并按 Agent 的 Permission / Workdir 与 Skills 执行，其他不支持图片的 Provider 会明确提示能力边界。

知识引擎借鉴 [`nashsu/llm_wiki`](https://github.com/nashsu/llm_wiki) 的设计（项目明确采用无 embedding 路线：
中文 CJK bigram、整页范式、成熟的 ingest/检索思路）与 `gbrain` 的 dream cycle 思路，
**编排/多用户/飞书层完全自建**。llm_wiki 为 GPL-3.0 → 仅借鉴设计，不 fork/拷贝代码或 prompt 原文。

## 架构

Bun workspaces monorepo，依赖严格单向：`web/app → orchestrator → core → llm → shared`，`connectors → shared`。

| 包 | 职责 |
|---|---|
| `packages/shared` | 类型、写串行化 `Serializer`、logger、config、SpaceId 工具 |
| `packages/llm` | 网关 fetch 封装（Anthropic messages 格式）+ 成本观测（JSONL 日志 + 每日成本参考线） |
| `packages/core` | 知识层 seam `Knowledge` + llm_wiki 式引擎：markdown/SQLite(FTS5)/dream cycle/Wiki Maintenance/ask 检索问答 |
| `packages/connectors` | `Connector` 抽象 + `cli`（调试）+ `feishu`（lark-cli 子进程守护） |
| `packages/orchestrator` | runtime 单消费者 + 对话解释 + 应答网关 + 空间归属 + 冷启动话术 |
| `packages/web` | Hono 管理后台（空间/知识、Agents、任务、学习、提醒、Integrations、运行状态、数据治理、日志、设置） |
| `packages/app` | 入口：feishu 连接器 + orchestrator + web + 调度器（含 catch-up） |

### 双层空间模型

- `personal/<open_id>`：每人一个（私聊知识）
- `team/<chat_id>`：每个飞书群一个
- 检索视野 = 个人空间 ∪ 所属团队空间

数据仓库与每个空间的磁盘布局（Obsidian 兼容）：

```
data/
  AGENTS.md                    # 数据仓库安全边界与跨 Space 读取路由
  workspaces/<dir>/
    AGENTS.md                  # 当前 Space 的渐进式读取与证据规则
    purpose.md schema.md       # 空间意图 + 页类型规则（团队可编辑）
    raw/records/YYYY/MM/DD.jsonl # Raw 当前状态，按 UTC 创建日期分区、可直接阅读
    raw/retractions.jsonl      # 消息撤回标记
    raw/sources/               # 不可变原始来源
    wiki/{index,overview,log,glossary}.md + maps/*.md + {entities,concepts,sources,analysis}/*.md
    .index.db                  # SQLite 查询投影，可从 raw/**/*.jsonl + wiki/**/*.md 重建
```

Raw JSONL 与知识 Markdown 是权威数据源，SQLite 只负责结构化查询与 FTS。每条 JSONL 记录额外包含
`createdAtIso`，方便直接查看和 Git diff；Raw 状态改变时会原子替换对应日期文件。升级旧数据目录时，
首次打开空间会自动把 SQLite-only Raw 回填到 JSONL；后续启动则以 JSONL 校准 SQLite，因此删除
`.index.db*` 不会丢失原始消息。可在 HomeAgent 停止运行时检查或备份这些文件，不应在运行中手工编辑。

HomeAgent 在初始化数据目录、创建 Space、重启旧数据目录或执行安全迁移时补齐两级 `AGENTS.md`。根级文件要求
外部 agent 先确定单一 Space；Space 级文件再引导按 `purpose.md`、`schema.md`、`wiki/overview.md`、
命中的 `wiki/maps/*.md` 分支、相关知识页、最后才有界追溯 Raw 的顺序读取；`wiki/index.md` 与
`wiki/glossary.md` 作为完整主题或术语定位的后备入口。文件只在缺失时创建；
已有的用户自定义 `AGENTS.md` 不会被覆盖。它们是访问说明，不改变 Raw journal、Knowledge page 和 SQLite
projection 的权威关系，也不授权外部 agent 手工修改运行中的数据目录。

普通 Knowledge page 可从 `sources` 只读追溯到同一 Space 的 Raw 元数据。管理后台的页面详情和问答引用会
显示最新证据时间、`recent / aging / stale / unknown` 时效等级、Raw 数量与证据链完整性；点击页面详情中的
来源可继续查看本地 Raw。分级以最新 Raw 的 `createdAt` 计算：不超过 90 天为较新，91–365 天为较久，
超过 365 天为陈旧；来源缺失或未准入时为未知。证据年龄只用于提示复核，不会自动判定知识事实失效，
也不会增加 Provider 调用或把 Raw 正文送入新的通道。

### 本地 Agent 知识复用与反馈

其他本机 Agent 不需要理解 HomeAgent 的磁盘布局，也不需要直接打开运行中的数据目录。HomeAgent 服务运行时，
可通过同一个可执行文件启动只读 MCP stdio 代理；它只连接固定的本地查询端点，并复用现有 SQLite FTS 与
Knowledge page，不启动 Provider、不消耗模型 token、不写入知识或运行状态。接口一次只接受一个显式 Space，
所有列表和搜索都有上限。

推荐按渐进披露顺序调用：`list_spaces` 选择 Space → `get_overview` 看概览 → `list_maps` 或
`search_knowledge` 缩小主题 → `get_page` 读取页面；只有确实需要核验 provenance 时再用
`get_page_trace`。普通页面读取只返回证据数量、最新证据时间、时效等级和完整性；trace 也只暴露有界的
Raw id、来源、准入状态、时间和可选作者，不返回 Raw 正文、飞书消息 ID 或群绑定。不同 Space 的结果不会
由接口自动合并。单页正文最多返回 200,000 字符，超出时 `contentTruncated` 为 `true`，调用方不得把截断
内容当作完整页面。`get_page` 同时返回 opaque `revision`，供消费方反馈精确绑定当时读取的页面版本。

这是当前本机操作者级接口：默认回环访问或一个 read token 会授权读取全部 Space，但每次内容调用仍只允许
一个 Space，不提供按 Agent 身份细分的 Space ACL。`SpaceId` 本身会照常返回（团队 Space 的标识包含其
`team/` 后缀）；接口不会额外返回 Raw 的 `chatId`、`messageId`、工作归属字段或空间绑定配置。不要把 read
token 提供给不应读取全部本机知识的进程。

源码运行时先在一个进程中启动 HomeAgent，再把下面的 MCP 命令配置给本机 Agent：

```bash
bun start
bun run mcp
```

例如支持 MCP stdio 的客户端可使用等价配置（`cwd` 换成仓库绝对路径）：

```json
{
  "mcpServers": {
    "homeagent": {
      "command": "bun",
      "args": ["run", "mcp"],
      "cwd": "/absolute/path/to/homeagent"
    }
  }
}
```

打包应用使用 `"/Applications/HomeAgent.app/Contents/MacOS/homeagent" mcp`。也可用稳定 JSON
命令行做脚本化查询，例如：

```bash
bun run knowledge list_spaces
bun run knowledge get_overview --space team/oc_xxx
bun run knowledge search_knowledge --space team/oc_xxx --query "发布流程" --limit 8
bun run knowledge get_page --space team/oc_xxx --slug concepts/release
bun run knowledge get_page_trace --space team/oc_xxx --slug concepts/release
```

消费方可以提交 `helpful / not_found / incorrect / stale / conflicting / hard_to_reuse` 六类反馈。页面反馈必须
携带 `get_page` 返回的 `slug + revision`，搜索未命中反馈必须携带原始有界 query；每次提交还要提供稳定的
`idempotency-key` 与 `consumer`。反馈只写入当前 Space 的人工治理队列，不会自动创建 Raw、改写 Wiki、触发
Dream cycle 或调用 Provider。正向反馈会自动确认，其他反馈在「AI 质量 → Agent 知识反馈」中等待人工核验；
选择“知识页已修正”时，HomeAgent 会验证当前 revision 确实已变化后才允许关闭。

```bash
bun run feedback --space team/oc_xxx --idempotency-key run-42:feedback-1 \
  --consumer codex --kind not_found --query "灰度发布负责人" --note "没有命中"
bun run feedback --space team/oc_xxx --idempotency-key run-42:feedback-2 \
  --consumer codex --kind stale --slug concepts/release --revision <get_page 返回值>
```

MCP 默认仍提供六个读取工具；当反馈写入口可用时额外提供非破坏、幂等的
`submit_knowledge_feedback`。该工具只提交治理反馈，不改变六个读取工具的 read-only 声明。

服务保持默认回环绑定且未启用管理令牌时，本机查询无需凭据。启用管理令牌后，可在 HomeAgent 服务和 MCP
代理的环境中配置相同的 `HOMEAGENT_AGENT_READ_TOKEN`；该凭据允许读取全部 Space，但只允许访问
`POST /api/agent/v1/query`，不能访问管理页面或写接口。未配置专用凭据时代理会兼容使用
`HOMEAGENT_WEB_ADMIN_TOKEN`，但推荐为 Agent 单独配置只读令牌。令牌只通过 Authorization header
传递，不出现在 URL、输出或设置文件中。反馈使用另一个环境变量专属
`HOMEAGENT_AGENT_FEEDBACK_TOKEN`，只允许访问 `POST /api/agent/v1/feedback`，不能读取知识或访问管理页面；
HomeAgent 会拒绝把它配置成管理/read token 的同一密钥。MCP/JSON 命令不会自行启动服务；连接失败时应先
确认 HomeAgent 服务、端口和令牌环境一致。

`raw/sources/` 当前不是文件监听目录，手动复制文件进去不会自动入库。需要从空间详情页使用「导入本地资料」，
或把文件发送到对应的飞书群/私聊，资料先登记为 Raw 后才会进入自动提炼流程。

## 普通用户安装（macOS 13+）

正式发布体验是：普通用户只需下载与 Mac 架构对应的 DMG，把 `HomeAgent.app` 拖入“应用程序”并双击。
候选版本按下面的无终端主路径验收：

1. HomeAgent 自动安装并启动当前用户的后台服务，然后在默认浏览器打开设置向导。若数据目录尚未初始化，
   向导会先展示默认位置，也允许选择一个不存在或为空的绝对路径；确认后通过安全重启切换，再继续后续设置。
2. 设置向导以“安装并连接 ChatGPT”为普通用户主路径：获得明确同意后，HomeAgent 下载并校验 OpenAI
   官方 Codex，安装到 HomeAgent 专用数据目录，再打开 OpenAI 官方页面完成登录，全程不需要终端。
   Codex 普通会话使用 `ephemeral + ignore config/rules + read-only` 限制模式，并以绑定 Agent 的
   Workdir（如已配置）作为只读上下文根目录。已自行安装并登录的 Claude Code 是可选高级 Provider，
   使用严格 no-tools 模式，但不会出现在首次安装主路径中要求普通用户手动安装。
3. 点击“一键创建飞书机器人”，在飞书页面确认。HomeAgent 会自动申请运行权限、验证机器人身份，并引导完成消息监听。
4. 消息监听就绪后首次设置即完成。之后把机器人加入企业内部群聊，群主或管理员按群内提示发送
   “@HomeAgent 启用群聊”；确认前 HomeAgent 不会读取或记录该群消息。
5. 如需加入外部群，完成首次设置后在“飞书连接”的可选对外共享配置中打开当前应用；完成飞书版本发布和管理员审批后，用一条真实外部群消息验证。

应用包已自带 Bun 运行时、`lark-cli` 和 macOS 附件提取助手，用户不需要安装 Git、Bun、Node、npm 或
Homebrew；首次设置通过受托管的 Codex 安装与 ChatGPT 登录完成 AI 连接，不依赖预装 Claude。
Claude Code 和 TRAE CLI 仍是需要用户自行管理的可选高级 Provider。知识数据保存在
`~/Library/Application Support/HomeAgent`，日志保存在
`~/Library/Logs/HomeAgent`；替换应用版本不会覆盖知识数据。

需要统一飞书机器人头像时，可在 HomeAgent 的“飞书连接”页面下载本地品牌头像 PNG，再到飞书开放平台手动上传。
HomeAgent 不会自动修改任何已有飞书应用；上传后请在飞书的圆形裁切预览中确认屋檐与智能火花完整可见。

> 当前仓库提供 beta 构建与发布流水线。面向外部分发的 DMG 仍须由维护者配置 Apple Developer ID
> 签名/公证凭据，并完成 Bun 等二进制再分发审查；未经签名的本地构建仅供开发验证。

## 从源码运行的环境要求

- **Bun**（`curl -fsSL https://bun.sh/install | bash`），Node v22 仅作参考。
- **Agent CLI**：普通聊天和任务可使用已登录的 `claude` 或 `codex`，并自动获得当前 Provider 兼容的全部本机 Skills；Agent 会按请求选择相关 Skill。提炼和后台学习仍使用 no-tools 调用。`trae-cli` 仅用于显式任务。旧 LLM 网关仅用于兼容测试，生产主流程不依赖它。
- **飞书 `lark-cli`**：需已安装并可执行。首次启动可在浏览器里一键创建并验证飞书应用；
  附件下载使用 bot 身份，应用需开通 `im:message:readonly` 权限。读取用户文档时的 user 授权仍由
  `lark-cli auth login` 管理。

### 环境变量

```bash
# 可选：仅旧网关客户端/网关 live test 使用；生产主流程无需配置
export ANTHROPIC_BASE_URL=https://api.gameaigc.cn
export ANTHROPIC_AUTH_TOKEN=sk-...
export HOMEAGENT_DATA_DIR=./data                    # 默认 ./data
export HOMEAGENT_LLM_MODEL=claude-sonnet-5          # ask/提炼默认模型
export HOMEAGENT_DAILY_BUDGET_USD=5                 # 每日成本参考线（只观察，不阻断调用）
export HOMEAGENT_CHAT_TIMEOUT_MINUTES=360           # 聊天/Agent 回答至少 360 分钟，可设至 1440
export HOMEAGENT_WEB_HOST=127.0.0.1                 # 默认仅本机访问
export HOMEAGENT_WEB_PORT=3000                      # 管理后台端口
export HOMEAGENT_DREAM_HOUR=3                        # 每日提炼时刻（0-23，Asia/Shanghai）
export HOMEAGENT_RAW_RETENTION_DAYS=90              # 已提炼原始消息保留天数；0=永久
# 仅当 HOMEAGENT_WEB_HOST 不是本机回环地址时必须设置（环境变量专属，不写盘）
export HOMEAGENT_WEB_ADMIN_TOKEN=replace-with-a-strong-secret
# 可选：只授权固定本地 Agent 查询端点；启用后台鉴权时推荐与管理令牌分开
export HOMEAGENT_AGENT_READ_TOKEN=replace-with-a-read-only-secret
# 可选：只授权固定本地 Agent 反馈端点；必须与管理/read token 不同
export HOMEAGENT_AGENT_FEEDBACK_TOKEN=replace-with-a-feedback-secret
# 可选：精确 @ 识别（否则群内任意 @ 都视为叫机器人）
export HOMEAGENT_FEISHU_BOT_NAME=homeagent
export HOMEAGENT_FEISHU_BOT_OPEN_ID=ou_xxx
# 可选：已安装并登录的 bytedcli；用于只读同步 ByteTech 文章正文
export HOMEAGENT_BYTEDCLI_BIN=/absolute/path/to/bytedcli
```

改名前的 `HOMEBRAIN_*` 环境变量仍可读取；若新旧变量同时存在，以 `HOMEAGENT_*` 为准。
打包应用首次启动时也会在确认后复制旧版 Homebrain 数据，并保留旧目录不变。
如果显式设置了 `HOMEAGENT_DATA_DIR`，它会固定数据目录；需要先移除该变量，才能从设置页迁移。

> `HOMEAGENT_DATA_DIR` 是需要从进程外固定目录时的可选覆盖；全新安装也可直接在首次设置中选择数据位置，
> 后续启动会读取持久化的目录选择，无需保留该环境变量。显式设置环境变量时，页面内目录迁移会被锁定。

> 后台「设置 / Agents / Integrations」里改的配置会写入
> `data/config/{settings,agents,spaces,feishu-group-bindings}.json`
> 并叠加在上述环境变量之上（后台显式设置优先）。模型 / 成本参考线 / 提炼时刻 / 群设置即时生效；
> Bot 身份与端口需重启生效。`HOMEAGENT_WEB_HOST`、`HOMEAGENT_WEB_ADMIN_TOKEN` 与
> `HOMEAGENT_AGENT_READ_TOKEN` 与 `HOMEAGENT_AGENT_FEEDBACK_TOKEN` 仅从环境变量读取：
> 默认绑定 `127.0.0.1`；开放到局域网或 `0.0.0.0` 时必须配置管理令牌，后台支持浏览器 Basic Auth
> （密码填令牌）及 Bearer Token。可选的 `ANTHROPIC_*` 只在调用旧网关客户端时校验，只读、不写盘，
> LaunchAgent 也不会保存它们。

网关关键事实（已实测验证）：认证用 `x-api-key` + `anthropic-version: 2023-06-01`；
结构化输出走强制 `tool_use`，**网关会改写返回的 tool 名**，因此按 block 类型（而非名字）提取；
真实模型 ID：`claude-haiku-4-5-20251001` / `claude-sonnet-5` / `claude-opus-4-8`。

## 开发

```bash
bun install
bun test                              # 全部离线单测/契约测试
HOMEAGENT_LIVE=1 bun test packages/llm/src/gateway.live.test.ts   # 真调网关
HOMEAGENT_LIVE=1 bun test packages/core/src/dream.live.test.ts    # 真跑提炼
HOMEAGENT_LIVE=1 bun test packages/core/src/ask.live.test.ts      # 真跑问答
bunx tsc -p tsconfig.json --noEmit    # 类型检查
bun run verify:brand                  # 品牌 SVG、头像与 macOS iconset 离线校验
bun run evaluate:quality              # 固定 AI 质量评测 + 检索策略建议
bun run verify:crash-recovery         # SIGKILL 后知识/任务/提醒/学习恢复验收
bun run verify:beta                   # 干净候选树的本地预检（不代替外部发布门禁）
```

该预检不会宣称签名、公证、全新 Mac 安装或真实飞书演练已经完成。外部门禁见
[`docs/beta-release-runbook.md`](docs/beta-release-runbook.md)。
常见 Provider、数据目录、持久化和运行故障见
[`docs/troubleshooting/README.md`](docs/troubleshooting/README.md)。

## 本地测试

按「想测什么」选，从快到全共四种。前提：`bun` 在 PATH 上（`curl -fsSL https://bun.sh/install | bash`）。

### 1. 快速回归（离线 · 最快 · 不联网不花钱）

每次改完代码先跑这个。测试全程用假 LLM / 假 CLI runner，无需配置网关变量：

```bash
bun test
bunx tsc -p tsconfig.json --noEmit
```

### 2. 点管理后台（离线 · 推荐先用）

```bash
bun run packages/web/src/dev.ts        # http://localhost:3000（启动日志：LLM=离线假回答）
```

能测**全部界面**：空间/知识、Agents、任务、学习、提醒、Integrations、运行状态、数据治理、设置——增删改、开关、落盘、任务「立即运行」都可验证。
问答框与任务运行返回**固定假答案**（不 spawn 真 CLI，秒回），看不到真实模型效果。数据写 `./data`（或 `HOMEAGENT_DATA_DIR`）。
默认不会创建虚假的飞书群或 `oc_demo` 连接；飞书连接测试应使用用户自己创建或选择的真实群聊。

仅需查看带示例内容的界面时，可显式开启隔离的演示数据：

```bash
HOMEAGENT_SEED_DEMO=1 bun run packages/web/src/dev.ts
```

未指定 `HOMEAGENT_DATA_DIR` 时，演示数据写入 `./data/dev-demo`，不会混入正常运行数据。

### 3. 后台真跑本机 CLI（能看到真实效果 · 慢）

```bash
HOMEAGENT_DEV_REAL_CLI=1 bun run packages/web/src/dev.ts   # 启动日志：LLM=真实本机 CLI
```

给某群指定 Agent（或在设置里配默认 CLI），问答/任务会真的 spawn `claude`/`trae-cli`。单次数秒，任务的即时提炼会再多调几次。

### 4. 终端模拟飞书（repl · 不接飞书跑通全主干 · 会真跑 CLI）

```bash
bun run packages/app/src/repl.ts       # 启动横幅列出全部命令
```

行内命令：`/at <text>`（群内 @ 提问）、`/group <text>`（群内不 @，静默收录）、`/added`（模拟入群）、
`/dream`（立即提炼）、`/task ...`（管理个人空间任务；`/at /task ...` 管群空间）、`/learn ...`（管理学习计划），其余按私聊处理。典型闭环：

```
/group Alice 负责后端，主导架构。      # 收录到群空间
/dream                                # 提炼成知识页
/at 谁负责后端？                       # @提问，带引用作答
/at /task new 每周AI进展               # 在群空间建研究任务
/at /task run 每周AI进展               # 立即跑（写库 + 即时提炼）
```

> **注意事项**：
> - 第 3、4 种会 **spawn 真 claude/trae-cli**：慢、有开销，且 CLI **用它自己的鉴权和模型**，不一定尊重 homeagent 里选的 model；想快速点功能用第 2 种。
> - 本机 `codex` 之前探测不可用（WSL 无 Linux node），`claude`/`trae-cli` 可用；后台每次启动**实时探测**，以界面显示为准。

## 管理后台（mew 风格，可读写）

左侧导航包含：

- **空间 / 知识**：空间列表、分层知识地图、知识页、原始条目、问答测试、手动触发提炼，以及提炼失败记录的单条/批量恢复。
  - 地图按首个有效标签组织最多 24 个显式一级主题，长尾进入按页面类型划分的兜底主题；单个主题超过 100 页时递归拆成每页最多 100 项的下级地图。地图由系统确定性增量维护，不调用 LLM、不消耗 Token，也不作为回答证据；检索命中地图后只会沿相关分支展开，并继续遵守最多 60 个候选页的 LLM 路由上限。
  - 普通知识页详情显示只读的 Raw 证据链和时效等级，来源可继续打开本地 Raw；问答引用同步显示最新证据时间、来源数量和完整性。回答综合遇到冲突页面时优先采用证据更新且证据链完整的页面，但证据较久只会提示复核，不会自动让事实失效。系统生成的地图不显示也不参与证据链。
  - Dream 调度每批最多处理 40 条 Raw，一次 tick 最多连续追赶 4 批；超过单轮安全上限的遗留积压会在下一次 15 分钟 tick 自动续跑，不再等到第二天。失败或没有进展的批次会立即停止该 Space 的本轮追赶，避免重复调用 Provider。
  - 独立的只读 **Wiki Maintenance cycle** 不依赖待处理 Raw 或 LLM：启动时补跑、此后每周检查断链、孤立页、重复标题/别名、超大页、没有 Raw 来源的不可追溯页、超过 365 天的完整陈旧证据和无效 provenance；空间页可手动运行并查看有界摘要，不会自动改写 Wiki。
  - 空间详情页可一次导入最多 20 份本地 UTF-8 文本、Markdown、CSV、JSON 或日志文件；每份不超过 20 MiB，正文最多保留 200,000 字符，文件名与原始内容 SHA-256 会进入可追溯的 `source=manual` Raw。可只登记后等待夜间提炼，也可立即且仅提炼本批资料。
  - 支持编辑 `purpose.md` / `schema.md`、查看完整原始记录及其关联知识页、单条重新提炼、固定目标重新生成、删除知识页和提交可追溯的人工纠错；所有人工治理操作都会写入审计记录。系统生成的地图单独展示，不允许人工纠错、重新生成或删除。
- **Agents**（三栏工作台）：左侧选择 Agent，中间编辑配置，右侧查看真实的 CLI 状态、当前空间/飞书群绑定和该 Agent 最近处理的 Chat / 研究任务运行。Chat 记录会固定归属到实际处理它的 Agent，并可从 Recent runs 进入对应的原始消息详情。支持新建 / 删除，以及配置 **名称、Provider、Instruction（人格，会注入到回答）、Model、推理强度、Visibility、Permission、Workdir**；旧版 Pinned Skill 绑定会保留兼容，但不再限制运行时能力。编辑先保存为草稿，显式发布后才影响未来运行，发布历史不可变并支持通过新版本回滚，避免在途运行被原地改写。
  - 桌面端保持三栏并可拖拽或用方向键调整栏宽；窄屏把右侧信息收进详情抽屉，手机端在 Agent 列表和详情之间切换。页面不显示 HomeAgent 没有实现的 Mew Device、Repository、Environment、Concurrency 或独立 Chats 模块。
  - **Provider = 本机已安装的 agent CLI**（`claude` / `codex` / `trae-cli`）。所有 LLM 工作都通过当前空间配置的本机 CLI 子进程执行，homeagent 不直连网络 API。普通聊天和研究任务使用绑定 Agent 的 Permission / Workdir，并显式传入全部兼容 Skill；提炼和后台学习继续使用受限 no-tools 调用。Provider 会话仍是一次性的，不写入全局历史；TRAE 当前仍只用于显式任务。后台会探测本机 CLI 的安装和可运行状态。
  - **Skills 自动加载**：飞书群绑定团队空间，空间再绑定 Team Agent；个人空间绑定 Personal Agent。每次普通聊天或任务启动时，HomeAgent 都会扫描当前 Provider 可用的本机 Skill 目录，把完整兼容目录交给 Agent，再由 Agent 按当前请求加载相关 Skill，无需逐个固定。旧 Agent 的 Pinned Skill 仅作为兼容配置保留，不再形成能力白名单。
  - **仍隔离环境规则**：运行不会继承用户级规则、Hooks、Plugins 或 Provider 会话历史；Skill 来源由 HomeAgent 自己的目录扫描结果明确传入。任务和 Chat Run 会冻结并记录实际可见的 Skill 列表，方便审计本次运行获得了哪些能力。
  - **本机 Skill 目录**：共享 Skill 来自 `~/.agents/skills`；后端同时识别 Codex、Claude 和 TRAE 的原生 Skill 目录，并按 Provider 兼容性、来源优先级和同名遮蔽规则生成有效目录。同名同内容合并展示，同名不同内容标出冲突；页面不暴露绝对路径或 `SKILL.md` 正文。
  - **当前全量模式边界**：普通聊天和研究任务都会冻结全部兼容 Skill 的名称、来源与 `SKILL.md` 摘要，但不会在每次调用前重新散列整个 Skill 目录树。若 Agent 实际选择的 Skill 无法加载，Provider 必须明确报告失败，不得假装已使用。提炼和后台学习不执行本机 Skill。
  - **图片输入的安全边界**：Codex 临时只读普通会话支持原生图片参数（每次最多 4 张）；其他不支持图片输入的 Provider 会明确失败，不会假装已经看过图片。
  - **Model 随 Provider 变化**：切 Provider 时 Model 下拉自动换成该 provider 的维护清单（CLI 无“列模型”接口）；Codex 当前提供 `gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna / gpt-5.5 / gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex-spark`。其中 `gpt-5.6-sol` 是 GPT-5.6 Sol 的完整模型 ID；HomeAgent 日常问答优先选择较快、成本更低的 `gpt-5.6-luna`，复杂研究可选择 `gpt-5.6-terra` 或 `gpt-5.6-sol`。
  - **推理强度按 Agent 配置**：Codex Agent 可选择继承默认值，或从当前模型支持的档位中选择；GPT-5.6 系列支持 `none / low / medium / high / xhigh / max`，旧模型不会显示不支持的档位。此配置用于普通 Chat 和显式 Codex 任务；其他 Provider 暂不传递。
  - **Visibility 会限制空间绑定**：Team Agent 只能绑定群空间；Personal Agent 只能绑定个人空间。群设置只展示 Team Agent，个人空间详情页只展示 Personal Agent，后端也会拒绝类型不匹配的绑定。已有不兼容绑定时不能直接切换 Visibility，必须先解除绑定；显式删除 Agent 则会先一次性清除所有绑定，让这些空间回退到默认 AI。
  - **Chat / 任务权限会真实映射到 CLI 沙箱**：`read-only` 开启只读工具并禁止写入，`write` 以 Workdir 为工作根目录并启用 Provider 的工作区写入模式，`full` 会绕过 Provider 沙箱。`write/full` 必须配置存在的 Workdir；高权限任务仍需持久化人工审批，普通 Chat 则直接使用已发布 Agent 的权限配置。
- **Skills**（能力清单）：只读展示 `~/.agents/skills` 中的共享 Skills、同名冲突和无效配置；运行时还会合并当前 Provider 的原生 Skill 目录。普通聊天和任务自动获得有效的完整目录，不需要在 Agent 上逐个分配。支持本地搜索、状态筛选和手动刷新；安装与更新仍由本机 CLI/Skill 管理工具负责。
- **任务**（研究任务执行）：新建定期任务，让某空间的 Agent CLI 定期研究一个主题；产出**存为该空间的原始材料**（`source=task`），**运行结束立即触发一次本空间提炼**（当场变成 wiki 知识页，而非等夜间），并可**推送摘要到该空间绑定的飞书群/私聊**。
  - 字段：名称、目标空间、研究主题、周期（每小时 / 每天几点 / 每周星期几几点）、最长运行时间、启用开关、推送开关、完成后立即提炼开关。
  - **定时**（TaskScheduler，每任务独立周期，启动即 catch-up）+ **后台「立即运行」**。每次启动会立即生成持久化运行编号，并冻结当时的 Agent 发布版本、Instruction、Provider、Model、Permission、Workdir 与完整兼容 Skill 目录证据；之后即使空间重新绑定、Agent 发布新版本或本机 Skill 变化，当次计划也不会被替换。任务详情页可查看状态、触发来源、耗时、用量/成本覆盖、完整输出或错误，并可重试失败、取消或超时的运行；Agent 工作台按准确归属展示最近记录。
  - `write/full` 运行先进入持久化人工审批，页面展示真正被冻结的主题、权限、Workdir、Provider、Model、Agent 版本和计划摘要；审批 24 小时过期，批准、拒绝、过期、通知尝试均留审计。`read-only` 保持直接排队；两者都使用冻结计划，执行前仍重新核验 Workdir。
  - 同一任务只允许一个活动运行；后台、定时调度和飞书命令共享互斥保护，不会重复执行。任务默认和最低运行上限为 360 分钟，可配置至 1440 分钟；后台可取消活动运行，超时或取消都会等待本机 CLI 退出或达到安全上限后再释放并发位。排队项在重启后按冻结计划恢复；已经运行的项会标记为失败，不会拿当前 Agent 配置偷偷续跑。
  - 仅定时触发、`read-only`、尚未产生输出且属于可重试 Provider 故障的运行会在 60 秒后自动再尝试一次；这是创建一条关联的新运行，不是进程 checkpoint。工作续作的 Task Run 成功只会提交带“结果 / 检查 / 证据”的验收候选；自动验收还要求冻结权限为 `read-only`、Raw 已落盘、输出未截断，并收到严格 JSON 执行报告（`outcome=completed`、无 blocker、全部检查通过）。普通文本或畸形报告统一停在人工验收，结构化 `blocked` 结果则保留动作边界并形成 blocker；`write/full/unknown` 必须人工接受后才记录动作边界 checkpoint。手动重试、禁用任务、取消或高权限运行都会终结/替代等待中的自动重试，避免重复执行。
  - Provider 报告的 token 与成本会按调用聚合到 Chat / Task / 质量 trace；无法从 CLI 获得的字段保持“未知”，不会伪装成 0。每日成本参考线只用于观察，超出参考线或成本未知都不会暂停、降级或拒绝 Provider 调用；系统仍会展示已知成本、未知成本调用与记账覆盖率。
  - 飞书推送采用持久化通知状态：发送失败会记录错误、尝试次数和退避时间，TaskScheduler 后续自动重试，运行详情页也可手动重试；任务本身的成功结果不会因通知通道暂时故障而丢失。
  - 研究按空间 Agent 的 Permission / Workdir 执行，并自动获得当前 Provider 兼容的全部 Skills；未指定 Agent 时默认 `read-only`。任务写入是异步的，不占用空间写锁；即时提炼始终回到普通受限模式并尽力而为——失败不影响任务成功，原始材料仍会被夜间提炼兜底。
  - **飞书里也能管任务**（`/task` 命令；群聊仅群主/管理员可执行，私聊由本人管理；控制消息不会被当成知识收录）：
    - `/task` 或 `/task list` — 查看本空间任务
    - `/task new <主题>` — 新建每日研究任务（写入本空间）
    - `/task run <名称或序号>` — 立即运行
    - `/task help` — 帮助
  - **消息撤回**：回复原消息，@机器人说「别记这条」。原作者、群主或群管理员可执行；系统会删除该消息派生的全部原始记录，二次撤回会明确提示且事件重投不会重新入库。若内容已经进入知识页，会先移除受影响页面，再用仍有效的来源完成重新提炼后回复。撤回控制命令本身不会入库。
- **学习**（材料阅读 + 持续迭代的主题学习）：回复书籍、文章、附件或飞书文档后发送 `/learn new <名称>`，HomeAgent 会保存清洗后的材料快照，按标题和段落边界每天带读一课。也可以直接发送 `/learn topic <主题>`；Agent 会先提出 3–6 个入学诊断问题，了解已有经验、概念基础、实践能力、学习背后的现实目标、可观察成功标准、时间约束、偏好和暂不涉及的范围，再生成真正适合当前水平的路线。
  - 群聊里的 `/learn` 创建、刷新与治理操作，以及“重新提炼”，仅允许群主/管理员触发；私聊仍由本人管理。鉴权发生在 Provider 调用和任何持久化变更之前。
  - 主题计划可以继续回复其他材料并发送 `/learn add <名称或序号>`；课程会使用 `[材料1]` 这样的标记引用用户材料，并把“来源材料”“模型一般知识”和“推荐资料”分栏展示。
  - 每当入学诊断或带有明确“下一课要求”的学习反馈生成了新路线，下一课准备前会按当前水平、成功标准和知识缺口自动联网检索 1–5 份资料。系统优先选择官方文档、标准、大学课程、研究机构与原始论文，实际打开页面核验后才保存 HTTPS 链接，并以 `[联网资料1]` 引用；课程会明确选出最适合当前小目标的一份首选来源。也可以发送 `/learn resources <名称或序号>` 主动刷新和查看推荐。
  - 联网检索复用本机 Agent CLI：Claude 仅开放 WebSearch/WebFetch，不开放本地文件工具，也不需要额外配置第三方搜索 API Key；Codex/TRAE 因无法可靠隔离联网与本地文件工具，当前不启用该通道。网络、提供方或结果校验失败时，课程会明确写“本次未获得可验证的联网资料”，继续使用用户材料和标注为“未经外部检索验证”的模型一般知识，不会伪造来源或链接。
  - 每课只追求一个可验证的小进步，并加入不直接提示答案的“回忆练习”和带自检标准的实践任务。后续课程会从最近已验证的学习记录中抽取旧知识，进行间隔提取；适合技能练习时再与当前任务交错，避免把一时熟悉误判成长期掌握。
  - 用 `学习回答：[计划名称或序号] <你的回答>` 完成入学诊断或提交每日作答；只有一个待答计划时可继续使用 `学习回答：<你的回答>`。材料阅读和主题计划都会根据回答证据判定 `ready` 或 `review`，但普通回答只形成点评和已验证记录，不会阻塞或改写明天的课程。确实想改变下一课时，在回答后另起一行写 `下一课要求：<你的要求>`；这时 `review` 才会保留当前内容补强，主题计划也才会更新画像、缺口、节奏和后续路线。已经完成的路线和课程历史不会被改写。
  - 只有被回答证据支持的 `ready` 理解才会压缩成学习记录，并以 `source=learning` 写回知识空间供 Dream 使用；`review` 尝试仍保留在课程反馈历史中，但不会把未纠正的误解写入 Raw 或知识页。完整闭环是：**主题创建 → 入学诊断 → 个性化路线 → 单目标课程 → 提取练习 → 可选证据反馈 → 已验证学习记录 → 按明确要求迭代后续路线**。`/learn route <名称或序号>` 可查看当前路线、学习次数、学习使命与成功标准、最近一次路线调整和下一课重点；暂停、恢复、跳过和删除仍使用 `/learn pause`、`/learn resume`、`/learn skip`、`/learn delete`。
  - 默认每天北京时间 8:00 推送，停机后启动会补发当日未送课程；发送失败保留同一课重试，不会误推进。上一课未回答时，到下一次课程时间会自动归档为跳过并继续新课，不要求先清空其他计划的待答课程；暂停计划仍会停止推送。
  - 管理后台用“学习地图”HTML 页面展示当前水平判断、判断依据、学习使命与成功标准、知识优势、待补缺口、每日时间、路线版本、每一步状态、路线调整原因、已验证学习记录、用户材料、联网推荐资料和反馈轨迹，并可调整推送时间；当前一课与历史反馈会把受限 Markdown 安全转换为标题、段落、列表、代码和 HTTPS 链接等结构化 HTML，危险 HTML 或链接协议只会按普通文字展示。材料阅读计划还可调整每课字数。
  - 回复任一来源执行「别记这条」会删除包含该来源的学习计划及课程历史；计划、路线、材料快照和历史也随空间导出、恢复或删除。

  ```text
  /learn                         查看我的学习计划
  /learn topic <主题>            创建自适应主题学习路线
  /learn new <名称>              回复附件/文章/飞书文档后创建材料阅读计划
  /learn add <名称或序号>        回复另一份材料并加入现有计划
  /learn route <名称或序号>      查看路线和下一课重点
  /learn pause <名称或序号>      暂停
  /learn resume <名称或序号>     恢复
  /learn skip <名称或序号>       跳过当前一课并推进进度
  /learn delete <名称或序号>     删除计划和复制的学习源
  学习回答：[计划名称] <回答>     回答指定计划；只有一个待答计划时可省略名称
  下一课要求：<你的要求>          仅在回答后另起一行填写，明确调整下一课
  ```

  首版沿用现有附件/文档导入能力：支持 UTF-8 文本与 Markdown、带文本层的 PDF，以及飞书文档；单个附件上限 20 MiB，提取文本最多 200,000 字符。扫描版 PDF、EPUB、Office、音频和视频暂不支持。
- **提醒**（与研究任务、知识记忆相互独立）：在群聊或私聊中 @机器人说“周日上午提醒我去茶饼斋”或“1 小时后提醒我喝水”，确定格式会直接按上海时区创建。群聊中的创建、候选确认、查询、延后、取消和完成统一要求群主或群管理员授权；私聊仍由本人直接管理。规则无法可靠解析时，系统会让当前空间的 Agent 提取候选内容和时间并回显；只有发起者在 15 分钟内回复“确认”且仍具备群管理权限时才会持久化，回复“取消”或不确认都不会进入提醒调度。
  - “我最近一周有什么安排”“我这周有哪些安排”直接查询提醒数据，不依赖夜间知识提炼。
  - 支持“确认/完成……”“取消……的提醒”“把……的提醒延后 2 小时”。管理后台也可查看、完成或取消提醒。
  - 支持“提前 2 天提醒……，每隔 3 小时重复，直到确认”；重复提醒会明确要求在群里回复并 @机器人确认。
  - ReminderScheduler 每 30 秒检查到期提醒，启动时会补发停机期间到期的提醒；只有飞书发送成功后才推进状态，失败会保留待重试。
- **飞书连接**：HomeAgent 同一时间只使用一个当前 Bot。首次连接使用引导式设置，一键创建飞书应用并自动识别
  Bot 名称与 open_id；也保留 App ID / App Secret 手动接入作为高级选项。Bot 被加入群聊后只登记为“等待群管理员确认”
  并发送一次提示；群主或管理员发送“@HomeAgent 启用群聊”后才创建或复用群空间。待确认和已断开的群消息既不收录，也不回复。
  如果入群事件或提示发送失败，可在 “Integrations” 中请求或重发确认，但网页不会绕过群管理员直接激活。
  断开群连接只停用后续处理，已有知识、任务、提醒、学习计划和空间设置全部保留，重新连接会复用原空间。
  每个群可选择“仅在 @ Bot 时回复”“智能参与群聊”或“响应所有消息”，并可指定 Agent、`Topic reply`
  和智能活跃度（稳重 / 均衡 / 积极），还可发送测试消息验证通道。
- **Bot 停用与更换**：在 HomeAgent 中停用 Bot 只关闭本机事件消费和发送，不删除 `lark-cli` 系统钥匙串凭据，
  也不撤销读取飞书文档所用的用户授权。重新启用或更换 Bot 后必须重启 HomeAgent；旧 App 的群绑定会显示为
  “需要重连”，不会被新旧运行实例混用。对外共享状态也按 App ID 独立记录。
- **运行状态**：集中展示后台托管方式、PID、启动时间、两条飞书事件消费者的详细状态、必需 CLI、知识存储、任务、提醒、学习、Dream Cycle、Wiki Maintenance 与六个调度器；同时展示 AI 回答延迟、失败/超时、Agent 知识反馈待处理数、主动参与结果、事件队列积压，以及最近一次 Dream 追赶的批次数、已处理 Raw、剩余积压和是否达到单轮上限。积压仍在安全追赶时整体标为 degraded 但不阻断 readiness；维护检查发现知识问题或报告被截断时也采用同一服务降级语义。调度器本身未启动或最近失败仍会让 readiness 失败。LaunchAgent 托管时可从页面安全重启。
- **工作上下文**：为每个空间维护目标、Brief、Runbook、当前进展、阻塞项与下一步；新 Raw、Chat Run、Task Run 和由 Raw 生成的 Wiki 页会自动关联到当前工作项，并投影为 `work/<id>/{brief.md,runbook.md,status.json}`。可手动执行下一动作，也可对单个工作项显式开启自动续作；每轮最多领取一个动作，复用 Task Run 的冻结计划、权限审批、通知、超时与一次安全重试。Task Run 成功后先进入动作验收门：后台展示结构化结果、确定性检查和 Run/Raw 证据，只有验收通过才消费当前首个下一步并记录 checkpoint；驳回会保留动作边界和证据、形成可见 blocker，并允许从同一动作重试。计划改变时可显式放弃受阻动作并清除其系统 blocker，再继续新的首个动作。待验收期间自动续作暂停；重启只恢复尚未执行的排队动作，绝不重放已中断的运行中动作。
- **数据治理**：按空间导出 `homeagent.space v18` JSON 完整备份（知识页及系统生成的分层地图、原始记录及其动作验收准入状态、工作上下文、续作动作/checkpoint/验收审计/策略及其证据关联、人工治理审计、本地 Agent 知识消费反馈及处置记录、撤回标记、任务及 Chat 运行历史、冻结执行计划、Agent 发布历史、审批/重试/通知/用量审计、Skill 证据、相关质量 trace 与封闭的重评记录、提醒、学习计划、主题路线、多来源材料及课程历史、Wiki Maintenance 最近摘要、空间元数据），兼容恢复 v1–v18 备份；WorkAction 输出在验收前保持 `held`、接受后才进入待提炼队列，驳回/取消/失败后永久 `excluded`。旧版缺失的高权限审批与执行计划会 fail-closed，legacy Skill 不会被静默绑定到错误来源；升级时会重新派生 WorkAction Raw 状态并清理引用未准入来源的旧 Wiki 页。导出、恢复和删除会阻止仍在运行、等待审批/验收/重试或正在外发的工作，恢复会校验 WorkItem、WorkAction、Task Run、验收证据、Raw 准入与 checkpoint 的双向关联，避免删除后继续副作用、恢复后重复执行、污染知识或重复通知。
- **设置**：**默认 Provider + 默认 Model**（群未指定 Agent 时用它）、聊天最长回答时间（默认和最低 360 分钟，可设至 1440 分钟）、每日成本参考线（只观察，不阻断）、提炼时刻、原始消息保留周期、端口，以及安全的数据目录迁移与可选 Git 初始化。最长回答时间会冻结到新建 Chat Run，旧的短时限配置在加载时提升到 360 分钟；进行中的回答仍可随时取消。本机其他 Agent 可通过独立 MCP/JSON 接口渐进复用已提炼知识；可选反馈凭据只允许写入治理反馈队列，不授予 Raw/Wiki/管理权限，也不触发 Provider。

### 数据目录迁移与 Git

在「设置 → 数据目录」输入绝对路径，确认后安排迁移。目标可以不存在、为空，或仅包含受支持的仓库元数据：
`.git/`、`.obsidian/`、`.gitignore`、`.gitattributes`、`.DS_Store` 和 `AGENTS.md`；这些内容会保留并合并到新数据树。
若目标还有其他文件，或源数据中存在同名根目录项，迁移会拒绝执行，避免覆盖。`.git` 必须是目录，不接管
以 `.git` 文件表示的 worktree。LaunchAgent 托管的应用会自动优雅重启；源码直接运行时需停止并重新执行
`bun start`。复制发生在知识引擎、SQLite、调度器和进程锁打开
之前，并先写入目标同级的临时目录，完整复制成功后再原子切换。旧目录不会自动删除；请在新实例中核验空间、
任务和设置后再自行处理旧目录。目标不能与旧目录相同，也不能是旧目录的父目录或子目录。
迁移仍在临时目录阶段时就会补齐缺失的根级与已验证 Space 级 `AGENTS.md`；若生成失败，迁移不会切换目标目录。

全新安装的数据根不存在，或只有 LaunchAgent 预先创建的 `logs/`、`run/` 等运行时内容时，`/setup`
会先显示同一套数据目录选择。选择默认位置后直接继续；选择新位置则沿用上述复制、校验和重启流程。
已有配置、Raw journal、Knowledge page 或其他持久内容的数据目录不会被误判为全新安装。

勾选「在新目录初始化 Git 仓库」会对新目录运行 `git init`；若目标已有 `.git/`，则直接沿用仓库，不需要
勾选。已有 `.gitignore` 会保留并追加 HomeAgent 规则，但不会执行 `git add`、提交、配置远端或推送。
`.gitignore` 默认排除 `run/`、`logs/`、`bin/` 和可重建的 `.index.db*`，其余配置、运行历史、
原始来源与知识 Markdown 可由用户自行决定是否提交。数据中可能包含群消息、附件提取内容和内部知识；配置
远端前应先检查 `git status`，并只使用访问受控的私有仓库。

无页面可用时，手动迁移遵循同一顺序：停止 HomeAgent，复制 `data` 到空目标，核对文件，再设置
`HOMEAGENT_DATA_DIR` 并重启。不要在服务运行时直接移动目录，也不要先删除旧目录。

后台默认只监听 `127.0.0.1`，无需登录。若通过 `HOMEAGENT_WEB_HOST` 开放到非回环地址，启动时会强制要求
`HOMEAGENT_WEB_ADMIN_TOKEN`；除 `/healthz`、`/readyz` 外的所有页面与操作都需要认证。
非本机访问应置于 HTTPS 反向代理之后；不要在不可信网络上直接使用明文 HTTP 传输管理令牌。

给群指定 Agent 后，回答和群聊参与判断都使用该 Agent 的 CLI。“仅在 @ Bot 时回复”只处理飞书实际投递的
@ 消息；“智能参与群聊”会对未 @ 消息分别评估“参与价值”和“打扰风险”，再按群的活跃度决定是否回复；
“响应所有消息”则不经过参与判断。稳重档只参与明确提问和高价值请求，均衡档也参与求建议、问题讨论和重要补充，
积极档还会更愿意补充观点、提示风险和追问。`Topic reply` 控制是否在话题内回复。
群没指定 Agent 时用「设置」里的默认 CLI；若没有可用 CLI，机器人会提示去后台配置（不静默）。

### AI 质量闭环

- 每次 `ask()` 都会在本机 `data/quality/quality.json` 保存有上限的回答追踪，包括来源、引用、耗时和成功/失败结果；健康页只读取聚合指标，不展示问题、回答或错误正文。
- 管理后台的问答测试页提供“有帮助 / 没帮助 / 引用有误”反馈。每个回答只接受一次反馈，反馈与回答追踪一起留在本机。
- 管理后台的“AI 质量”工作台集中展示“没帮助 / 引用有误”的待处理回答，可跳转到引用知识页进行人工纠错、写处理说明并保留已解决历史。
- 已完成的 Chat 可按原始问题与冻结的 Agent 执行计划发起候选重评，并对比 Provider、Model、Agent 版本、Prompt / Skill / 引用页面摘要及用量；这是可审计的重新评估，不宣称能确定性 replay 已变化的外部模型。
- 负面反馈可加入本机待校准评测集，并从 `/quality/evaluation-cases.json` 导出版本化 JSON。候选只记录当时的答案、引用、反馈和人工校准说明；确认正确答案与引用后才手工并入固定评测集，不会自动学习或改写知识库。
- `bun run evaluate:quality` 离线运行固定评测集，覆盖检索与引用、对话路由、群聊主动参与和学习路线校验。命令会输出机器可读报告及检索建议：
  - `keep_fts`：当前 FTS、路由和引用达到阈值；
  - `improve_fts_retrieval`：路由和引用正常，但 FTS 覆盖率低于 85%，应补强知识页 aliases/tags 生成与大目录有界路由；
  - `insufficient_data`：检索样本不足，暂不调整架构。
- 项目架构决定不引入 embedding；后续检索改进保持 FTS + LLM 路由路线，不新增向量模型、向量索引或知识数据外发通道。
- 评测已进入 CI 和 `verify:beta`。阶段二不引入个人空间隐藏或隐私策略，仍以家庭和团队协作为产品边界。

### 首次启动与飞书连接

1. 普通用户双击 `HomeAgent.app`；源码开发者运行 `bun start`。全新数据目录会自动进入 `/setup`，
   首步可确认默认数据位置或选择新的绝对路径，不需要预先设置 `HOMEAGENT_DATA_DIR`。
2. 打包应用以“安装并连接 ChatGPT”为主操作：HomeAgent 在用户确认后下载、校验并安装 OpenAI 官方
   Codex，再进入官方登录；登录后 Codex 可用于普通问答和显式任务。已经自行安装并登录的 Claude Code
   可从高级选项重新检测并选用；TRAE 仍只用于显式任务。源码运行则由开发者自行准备可用的 Claude 或 Codex CLI。
3. 点击“一键创建飞书机器人”，在飞书官方页面确认。HomeAgent 通过官方 Node SDK 显式提交完整授权清单，
   一次申请私聊、群内 @、群内全部消息、消息读取/发送、附件、表情、群信息、机器人进群权限和两条事件订阅。
   App Secret 只通过 stdin 写入 `lark-cli` 的系统钥匙串，不进入 HomeAgent 设置、页面或日志。
4. `im:message.group_msg` 是敏感权限；如果企业启用了自建应用审核，管理员会在这次创建确认中批准。
   不需要用户创建完成后再进入开放平台逐项补权限或事件。
5. LaunchAgent 托管时点击“激活消息监听”安全重启；源码运行时重启 `bun start`。
6. 消息监听就绪后首次设置完成。把机器人加入企业内部群聊，等待机器人发送确认提示，再由群主或管理员发送
   “@HomeAgent 启用群聊”；启用后默认仅响应 @机器人并使用 `Topic reply`，其他响应方式可在 “Integrations” 调整。
7. 如需对外共享，在完成首次设置后进入“飞书连接”的可选对外共享配置并打开当前应用。进入
   “应用发布 → 版本管理与发布 → 创建版本”，开启
   “允许机器人被添加到外部群中使用”和“允许外部用户与机器人单聊”，然后保存、提交发布并完成管理员审批。
   这两个开关不属于飞书 SDK 的创建权限清单，当前不能由 HomeAgent 代替用户或管理员自动开启。
8. 发布获批后，把机器人加入一个外部群并发送“@机器人 对外共享测试”。HomeAgent 会通过只读群信息接口确认该群
   确实是外部群，而且只接受点击“开始验证”之后收到的消息；验证通过后仍由该群群主或管理员执行群内启用命令。

已有应用可在“手动输入 App ID”中接入。App Secret 只通过子进程 stdin 交给
`lark-cli config init --app-secret-stdin`，不会写入 `data/config/settings.json`、页面或日志。后续可从
“飞书连接”重新进入引导、验证现有配置、调整群聊 Agent 与回复方式。

一键创建使用飞书官方智能体应用模板，并通过 `addons` 显式叠加 HomeAgent 的全部运行时权限和事件。
敏感权限 `im:message.group_msg` 也在首次确认中申请；若企业要求审核，需在创建阶段由管理员批准。
HomeAgent 只有在 `im.message.receive_v1` 和 `im.chat.member.bot.added_v1` 都通过有界监听验证后才显示创建完成。
若飞书仍漏配事件，创建页会直接给出官方增量授权链接并持续复检，不要求用户进入开发者后台操作。
已有应用仍可在“更多设置”中通过 App ID / App Secret 接入。
Provider 自身的登录授权仍由对应 CLI 管理。

### 构建 macOS 应用

本机开发构建（仅生成 ad-hoc 签名的当前架构应用）：

```bash
bun install --frozen-lockfile
bun run build:macos --target arm64 --allow-dirty
bun run smoke:macos --app dist/HomeAgent.app
```

候选构建由 `v*` tag 触发 GitHub Actions，分别在 Apple Silicon 与 Intel runner 上构建，签名嵌套可执行文件，
生成并公证两个架构的 DMG 与带 SHA-256 的更新清单，但只上传为 Draft Prerelease。流水线要求 Apple
签名/公证 secrets，且只有仓库变量 `BINARY_REDISTRIBUTION_APPROVED=true` 时才允许进入二进制候选阶段；
全新 Mac、真实飞书和 24–48 小时 Soak 等外部门禁全部通过后，维护者才把 Draft 公开为 Prerelease。

### 附件提炼（P2 首版）

飞书直接发送的图片和文件消息会通过 bot 身份下载并在本机提取文字，再作为同一条消息的原始材料进入知识库。
消息中的飞书 docx/wiki 链接会通过现有用户授权同步；`https://bytetech.info/articles/*` 链接会在运行环境已安装并登录
`bytedcli` 时通过固定的只读 `insearch get` 命令同步。同步成功的正文会作为同一消息的 `doc` Raw 保存，并立即作为
本次回答上下文；同步失败时机器人只说明正文未读取，不会让普通 Chat 放宽沙箱后重试，也不会假装已理解全文。
首版支持 UTF-8 编码的 `.txt`、`.md`、`.markdown`、`.csv`、`.json`、`.log` 文件、图片 OCR，
以及 PDF 已有文本层的提取；扫描版 PDF 不会自动执行 OCR。单个附件下载上限为 20 MiB，
每个附件最多保留 200,000 个提取字符，超限、损坏或不支持的附件会安全跳过，不影响原消息收录和回复。
资源元数据查询和下载各有 30 秒超时，下载期间会监视输出文件大小；本地图片/PDF 提取总计最多 60 秒，
图片在解码前还会执行 4,000 万像素上限检查。

提取记录保留原飞书 `messageId`，因此回复原消息执行「别记这条」、原始消息保留策略、空间导出和空间删除
都会覆盖这些派生记录。macOS 使用系统自带的 Vision/PDFKit；其他平台仍可提取上述 UTF-8 文本文件，
但会安全跳过图片 OCR 和 PDF 文本提取。音频转写、Office 文件、视频理解和 `post` 消息内嵌资源暂不支持。

> **CLI-only 的代价（务必知悉）**：这些本机 CLI 单次调用**慢、开销大**，dream 批量提炼会明显变慢；它们**自带鉴权和模型选择**，不一定尊重 HomeAgent 里选择的 model。普通聊天和任务会获得完整兼容 Skill 目录；提炼与后台学习仍使用严格 no-tools 调用，TRAE 仅用于显式任务。生产 AI 调用采用稳定性优先的统一边界：单次 Provider、Dream 与学习调用默认允许 6 小时，Chat/Task 最低 6 小时且可配至 24 小时，Chat 队列最多等待 24 小时；路由/分类输出预算为 8K tokens，正文生成、综合回答与学习产物为 64K tokens。仍可通过取消操作主动终止，不用短超时替代人工取消。dream 的结构化抽取使用 Provider 的最终结果通道（Codex 使用 `--output-schema` + `--output-last-message`）并在 Core 做业务校验；长 Raw 不会整份塞入单次生成请求，而会按固定大小分段、逐步合并为同一份完整知识页。失败记录会冻结原 Knowledge page 生成计划并持续显示在对应空间的“提炼失败”页，使知识健康状态降级但不阻断 `/readyz`；单条或批量重试只重做失败的 generate，不会重新 analyze、改换目标页或连带处理无关消息。恢复所需来源不会被原始消息保留策略清理；若来源被撤回，旧失败记录会移除，仍有效的其他来源会重新进入待提炼队列。CLI 未报告的成本会明确记为未知；每日成本参考线对已知和未知成本都只作观察，不执行硬限制。

### 生产启动（接真实飞书）

```bash
bun run packages/app/src/main.ts
# 或 bun start
```

启动后：feishu 连接器监听事件、管理后台在 `HOMEAGENT_WEB_HOST:HOMEAGENT_WEB_PORT`、Dream 调度器做启动 catch-up + 每日 03:00 提炼，并以有界多批次和 15 分钟续跑消化历史积压；Wiki Maintenance 调度器做启动 catch-up + 每周只读检查，并按保留周期清理已提炼的过期消息。
SIGTERM/SIGINT 优雅退出（对 lark-cli 子进程发 SIGTERM，绝不 kill -9）。

### macOS 后台常驻（P3.2）

在仓库根目录安装当前用户的 LaunchAgent；安装后关闭终端不影响运行，重新登录 macOS 会自动启动：

```bash
bun run service install
bun run service status
```

常用维护命令：

```bash
bun run service start
bun run service stop
bun run service restart
bun run service logs                 # 最近 100 行 stdout/stderr
bun run service logs --lines 300 --follow
bun run service status --json
bun run service uninstall            # 保留 data 与日志
```

服务定义写在 `~/Library/LaunchAgents/com.homeagent.agent.plist`，日志写到
`$HOMEAGENT_DATA_DIR/logs/service.{stdout,stderr}.log`（默认仓库内 `data/logs`）。plist 权限为 0600，
只包含 HOME、PATH、数据目录和托管标记，不保存 Anthropic 或后台管理密钥。主进程使用
`data/run/homebrain.lock` 上由内核自动释放的独占锁阻止重复实例（macOS/Linux 使用 `flock`，
Windows 源码运行使用 `LockFileEx`）；SIGTERM/SIGINT 仍会优雅停止所有子进程。活动日志超过
10 MiB 时会保留最近 1 MiB 并轮转 3 份，所有日志文件权限均为 0600。

部署探针：`GET /healthz` 是不依赖外部组件的快速进程存活检查，始终返回 200；`GET /readyz` 只有在知识存储、必需 CLI、两条飞书事件消费者及 Dream Cycle、Wiki Maintenance、工作续跑、任务、提醒、学习六个调度器都可用时返回 200，否则返回 503。管理后台 `/health` 提供完整健康快照的人类可读视图；Wiki Maintenance 发现内容问题只使整体状态 degraded，不单独阻断 readiness。

## 飞书权限边界

一键创建在首次飞书确认页显式申请以下 HomeAgent 运行时能力：

- 消息接收：`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、
  `im:message.group_at_msg.include_bot:readonly`、`im:message.group_msg`；
- 消息处理：`im:message:readonly`、`im:message:send_as_bot`、`im:resource`、
  `im:message.reactions:write_only`；
- 群与机器人：`im:chat:read`、`im:chat.members:bot_access`、`application:bot.basic_info:read`；
- 文档只读同步：`drive:drive.metadata:readonly`、`docx:document:readonly`、`wiki:node:read`；
- 事件订阅：`im.message.receive_v1` 和 `im.chat.member.bot.added_v1`。

用户仍需在飞书官方页面确认；如果企业启用了自建应用审核，管理员会在这次创建流程中批准本次安装。
机器人加入群聊本身不会授权 HomeAgent 收录或回复；只有群主或管理员在群内发送明确启用命令后才创建或复用群空间。
文档同步所用的 user 身份 token 到期时会在下次 API 调用时自动刷新。

对外共享是单独的可选发布能力，不是首次设置的必需步骤，也不是可随创建 `addons` 自动授予的权限。完成首次设置后，
用户可在“飞书连接”中打开当前 App、开启外部群与外部私聊两个开关，并在管理员审批后用真实外部群消息验证；验证进度
与 App ID 绑定。飞书企业/团队认证、个人实名认证、版本发布及管理员审批仍由飞书官方页面处理。

群内非 @ 消息的收录、智能参与和响应所有消息依赖敏感权限 `im:message.group_msg`，该权限已经放进首次创建确认页。
如果管理员尚未批准，HomeAgent 会阻止新群选择“智能参与”或“响应所有消息”，仍可使用“仅在 @ Bot 时回复”。
迁移前已经使用完整群消息策略的群会保留原设置并显示权限降级，不会把权限未知误报为可用。

## 实施状态

MVP = Slice 0–6，均已完成并通过测试；Slice 7（调度器 + 端到端联调）亦已完成。
后续已完成：研究任务、引导式每日阅读学习计划、真实飞书消息收发主干、思考表情、精确消息撤回、健康检查与可观测性（`/healthz`、`/readyz`、运行状态页与异常提示）、空间导出/恢复/删除、原始消息保留策略、非本机后台鉴权、P2 首版附件提炼、P3.1 飞书配置向导、P3.2 macOS LaunchAgent 后台常驻与服务管理，以及 P4.1 CLI-only 意图路由。
未纳入 MVP（已预留）：音频、Office、视频和 `post` 内嵌资源的进一步多模态提炼。
