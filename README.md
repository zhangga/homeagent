# HomeAgent

深度绑定飞书的团队/家庭 AI 知识库 Agent。定位是「最了解我们的 agent」：它常驻飞书群与私聊，
默默收录大家分享的知识，夜间提炼成 wiki 知识页，并在被 @ 或私聊时基于知识库作答（带引用）；也能按天带读一本书，提问、反馈并记录进度。
回复飞书图片或含图片的富文本消息后，可以直接让 Codex Agent 分析视觉内容。

知识引擎借鉴 [`nashsu/llm_wiki`](https://github.com/nashsu/llm_wiki) 的设计（项目明确采用无 embedding 路线：
中文 CJK bigram、整页范式、成熟的 ingest/检索思路）与 `gbrain` 的 dream cycle 思路，
**编排/多用户/飞书层完全自建**。llm_wiki 为 GPL-3.0 → 仅借鉴设计，不 fork/拷贝代码或 prompt 原文。

## 架构

Bun workspaces monorepo，依赖严格单向：`web/app → orchestrator → core → llm → shared`，`connectors → shared`。

| 包 | 职责 |
|---|---|
| `packages/shared` | 类型、写串行化 `Serializer`、logger、config、SpaceId 工具 |
| `packages/llm` | 网关 fetch 封装（Anthropic messages 格式）+ 成本治理（JSONL 日志 + 每日预算） |
| `packages/core` | 知识层 seam `Knowledge` + llm_wiki 式引擎：markdown/SQLite(FTS5)/dream cycle/ask 检索问答 |
| `packages/connectors` | `Connector` 抽象 + `cli`（调试）+ `feishu`（lark-cli 子进程守护） |
| `packages/orchestrator` | runtime 单消费者 + 对话解释 + 应答网关 + 空间归属 + 冷启动话术 |
| `packages/web` | Hono 管理后台（空间/知识、Agents、任务、学习、提醒、Integrations、运行状态、数据治理、日志、设置） |
| `packages/app` | 入口：feishu 连接器 + orchestrator + web + 调度器（含 catch-up） |

### 双层空间模型

- `personal/<open_id>`：每人一个（私聊知识）
- `team/<chat_id>`：每个飞书群一个
- 检索视野 = 个人空间 ∪ 所属团队空间

每个空间的磁盘布局（Obsidian 兼容）：

```
data/workspaces/<dir>/
  purpose.md schema.md        # 空间意图 + 页类型规则（团队可编辑）
  raw/sources/                # 预留：不可变原始来源
  wiki/{index,overview,log,glossary}.md + {entities,concepts,sources,analysis}/*.md
  .index.db                   # SQLite，可从 wiki/*.md 重建
```

## 普通用户安装（macOS 13+）

正式发布后，普通用户只需下载与 Mac 架构对应的 DMG，把 `HomeAgent.app` 拖入“应用程序”并双击：

1. HomeAgent 自动安装并启动当前用户的后台服务，然后在默认浏览器打开设置向导。
2. 点击“安装并连接 ChatGPT”，明确同意后由 HomeAgent 下载、校验并安装 OpenAI 官方 Codex；登录在
   OpenAI 官方页面完成，不需要复制 API Key。
3. 点击“一键创建飞书机器人”，在飞书页面确认。HomeAgent 会自动申请运行权限、验证机器人身份，并引导完成消息监听。
4. 消息监听就绪后首次设置即完成。之后把机器人加入企业内部群聊，群主或管理员按群内提示发送
   “@HomeAgent 启用群聊”；确认前 HomeAgent 不会读取或记录该群消息。
5. 如需加入外部群，完成首次设置后在“飞书连接”的可选对外共享配置中打开当前应用；完成飞书版本发布和管理员审批后，用一条真实外部群消息验证。

应用包已自带 Bun 运行时、`lark-cli` 和 macOS 附件提取助手，用户不需要安装 Git、Bun、Node、npm、
Homebrew 或全局 CLI。知识数据保存在 `~/Library/Application Support/HomeAgent`，日志保存在
`~/Library/Logs/HomeAgent`；替换应用版本不会覆盖知识数据。

需要统一飞书机器人头像时，可在 HomeAgent 的“飞书连接”页面下载本地品牌头像 PNG，再到飞书开放平台手动上传。
HomeAgent 不会自动修改任何已有飞书应用；上传后请在飞书的圆形裁切预览中确认屋檐与智能火花完整可见。

> 当前仓库提供 beta 构建与发布流水线。面向外部分发的 DMG 仍须由维护者配置 Apple Developer ID
> 签名/公证凭据，并完成 Bun 等二进制再分发审查；未经签名的本地构建仅供开发验证。

## 从源码运行的环境要求

- **Bun**（`curl -fsSL https://bun.sh/install | bash`），Node v22 仅作参考。
- **Agent CLI**：至少安装并登录 `claude`、`codex`、`trae-cli` 之一。旧 LLM 网关仅用于兼容测试，生产主流程不依赖它。
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
export HOMEAGENT_DAILY_BUDGET_USD=5                 # 每日预算
export HOMEAGENT_WEB_HOST=127.0.0.1                 # 默认仅本机访问
export HOMEAGENT_WEB_PORT=3000                      # 管理后台端口
export HOMEAGENT_DREAM_HOUR=3                        # 每日提炼时刻（0-23，Asia/Shanghai）
export HOMEAGENT_RAW_RETENTION_DAYS=90              # 已提炼原始消息保留天数；0=永久
# 仅当 HOMEAGENT_WEB_HOST 不是本机回环地址时必须设置（环境变量专属，不写盘）
export HOMEAGENT_WEB_ADMIN_TOKEN=replace-with-a-strong-secret
# 可选：精确 @ 识别（否则群内任意 @ 都视为叫机器人）
export HOMEAGENT_FEISHU_BOT_NAME=homeagent
export HOMEAGENT_FEISHU_BOT_OPEN_ID=ou_xxx
```

改名前的 `HOMEBRAIN_*` 环境变量仍可读取；若新旧变量同时存在，以 `HOMEAGENT_*` 为准。
打包应用首次启动时也会在确认后复制旧版 Homebrain 数据，并保留旧目录不变。

> 后台「设置 / Agents / Integrations」里改的配置会写入
> `data/config/{settings,agents,spaces,feishu-group-bindings}.json`
> 并叠加在上述环境变量之上（后台显式设置优先）。模型 / 预算 / 提炼时刻 / 群设置即时生效；
> Bot 身份与端口需重启生效。`HOMEAGENT_WEB_HOST` 与 `HOMEAGENT_WEB_ADMIN_TOKEN` 仅从环境变量读取：
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

- **空间 / 知识**：空间列表、知识页、原始条目、问答测试、手动触发提炼，以及提炼失败记录的单条/批量恢复。支持编辑 `purpose.md` / `schema.md`、查看完整原始记录及其关联知识页、单条重新提炼、固定目标重新生成、删除知识页和提交可追溯的人工纠错；所有人工治理操作都会写入审计记录。
- **Agents**（三栏工作台）：左侧选择 Agent，中间编辑配置，右侧查看真实的 CLI 状态、当前空间/飞书群绑定和该 Agent 最近处理的 Chat / 研究任务运行。Chat 记录会固定归属到实际处理它的 Agent，并可从 Recent runs 进入对应的原始消息详情。支持新建 / 编辑 / 删除，配置 **名称、Provider、Instruction（人格，会注入到回答）、Model、推理强度、Visibility、Permission、Workdir、Pinned Skills**；所有更改都要显式保存，不会自动写入。
  - 桌面端保持三栏并可拖拽或用方向键调整栏宽；窄屏把右侧信息收进详情抽屉，手机端在 Agent 列表和详情之间切换。页面不显示 HomeAgent 没有实现的 Mew Device、Repository、Environment、Concurrency 或独立 Chats 模块。
  - **Provider = 本机已安装的 agent CLI**（`claude` / `codex` / `trae-cli`）。**所有 LLM 工作（自然对话/问答 ask + 提炼 dream + 任务）都通过当前空间配置的本机 CLI 子进程执行，homeagent 不直连任何网络 API**。普通消息不再先调用一次通用意图分类：明确的副作用操作由窄规则处理，其他表达默认交给 Agent 自然回应，指代不清时只追问一个关键问题。后台**探测本机** CLI，只让可用的可选（装了但跑不了的灰显并标注原因，如 WSL 下无 Linux node 的 codex）。
  - **Pinned Skill 绑定属于 Agent，不属于群聊**：飞书群绑定团队空间，空间再绑定 Team Agent；个人空间绑定 Personal Agent。因此不同群可以使用不同 Agent，并自然获得各自的 Instruction、Provider、Model 与显式固定能力。Agent 编辑器只扫描并选择 `~/.agents/skills` 中的共享 Skill，不接受 Git URL 或任意路径输入。
  - **全局继承是默认行为**：Agent 没有固定任何 Skill 时，Codex、Claude 或 TRAE 仍可按各自的默认规则使用电脑上安装的全局 Skills；固定后的 Pinned Skills 才由 HomeAgent 在每次调用时显式解析与加载。空列表不表示“禁用全部 Skills”。
  - **本机 Skill 目录**：共享 Skill 来自 `~/.agents/skills`，选择器按来源保存精确绑定；同名同内容合并展示，同名不同内容标出冲突。后端仍识别 Codex、Claude 和 TRAE 的原生 Skill 目录，用于运行时解析、优先级和遮蔽判断，但 Provider 专属 Skill 不在普通清单或选择器中重复展示。页面不暴露绝对路径或 `SKILL.md` 正文。
  - **Pinned Skill 执行边界**：普通问答、提炼和学习都会显式加载空间 Agent 的 Pinned Skills，但始终使用 `read-only` 且不传 Workdir；研究任务加载同一组 Pinned Skills，并使用 Agent 的 Permission / Workdir。每次调用前都会重新核对文件、名称与内容哈希；缺失、损坏、不兼容或被遮蔽的 Skill 会被跳过，基础 Agent 继续运行，并在问答或任务通知中给出安全警告。
  - **图片分析使用 Codex 的原生视觉输入**：在飞书中回复图片或含图片的富文本消息，再说“分析一下”“看看这张图”等即可。每次最多传入 4 张、总计 20 MiB，回答完成后立即清理临时文件；下载失败或当前 Agent 不是 Codex 时会明确提示，不会假装已经看过图片。
  - **Model 随 Provider 变化**：切 Provider 时 Model 下拉自动换成该 provider 的维护清单（CLI 无“列模型”接口）；Codex 当前提供 `gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna / gpt-5.5 / gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex-spark`。其中 `gpt-5.6-sol` 是 GPT-5.6 Sol 的完整模型 ID；HomeAgent 日常问答优先选择较快、成本更低的 `gpt-5.6-luna`，复杂研究可选择 `gpt-5.6-terra` 或 `gpt-5.6-sol`。
  - **推理强度按 Agent 配置**：Codex Agent 可选择继承默认值，或从当前模型支持的档位中选择；GPT-5.6 系列支持 `none / low / medium / high / xhigh / max`，旧模型不会显示不支持的档位。普通问答建议从 `medium` 开始，级别越高通常耗时和 token 越多。其他 Provider 暂不传递此配置。
  - **Visibility 会限制空间绑定**：Team Agent 只能绑定群空间；Personal Agent 只能绑定个人空间。群设置只展示 Team Agent，个人空间详情页只展示 Personal Agent，后端也会拒绝类型不匹配的绑定。已有不兼容绑定时不能直接切换 Visibility，必须先解除绑定；显式删除 Agent 则会先一次性清除所有绑定，让这些空间回退到默认 AI。
  - **任务权限会真实映射到 CLI 沙箱**：`read-only` 开启只读工具并禁止写入，`write` 以 Workdir 为工作根目录并启用 Provider 的工作区写入模式，`full` 会绕过 Provider 沙箱。`write/full` 必须配置存在的 Workdir。Permission 与 Workdir 只影响研究任务；Skills 则属于 Agent 的统一能力，并遵守上一条的普通调用只读边界。
- **Skills**（共享能力清单）：只读展示 `~/.agents/skills` 中可跨 Provider 分配的共享 Skills、同名冲突/无效配置，以及反向的 **Used by Agents**。Codex、Claude 和 TRAE 的 Provider 专属 Skills 仍由各自 CLI 自动发现，HomeAgent 后端保留扫描用于运行时解析和冲突诊断，但不在普通清单和 Agent 选择器中重复展示。支持本地搜索、状态筛选和手动刷新；安装与更新仍由本机 CLI/Skill 管理工具负责。
- **任务**（研究任务执行）：新建定期任务，让某空间的 Agent CLI 定期研究一个主题；产出**存为该空间的原始材料**（`source=task`），**运行结束立即触发一次本空间提炼**（当场变成 wiki 知识页，而非等夜间），并可**推送摘要到该空间绑定的飞书群/私聊**。
  - 字段：名称、目标空间、研究主题、周期（每天几点 / 每小时）、最长运行时间、启用开关、推送开关、完成后立即提炼开关。
  - **定时**（TaskScheduler，每任务独立周期，启动即 catch-up）+ **后台「立即运行」**。每次启动会立即生成持久化运行编号，并保存启动时实际采用的 Agent、Provider、Model 与 Skill 解析证据；之后即使空间重新绑定、Agent 改配置或本机 Skill 文件变化，历史归属和当次实际加载/跳过情况也不会被改写。任务详情页可查看状态、触发来源、耗时、完整输出或错误，并可重试失败、取消或超时的运行；Agent 工作台按准确归属展示最近记录。
  - 同一任务只允许一个活动运行；后台、定时调度和飞书命令共享互斥保护，不会重复执行。任务可配置 1–60 分钟的运行上限，后台可取消活动运行，超时或取消都会向本机 CLI 发出终止信号并保存独立状态。每个任务保留最近 100 条完成记录，应用异常退出时未完成记录会自动标为失败。
  - 飞书推送采用持久化通知状态：发送失败会记录错误、尝试次数和退避时间，TaskScheduler 后续自动重试，运行详情页也可手动重试；任务本身的成功结果不会因通知通道暂时故障而丢失。
  - 研究按空间 Agent 的 Permission / Workdir / Skills 执行；未指定 Agent 时默认 `read-only`。任务写入是异步的，不占用空间写锁；即时提炼始终回到无工具模式并尽力而为——失败不影响任务成功，原始材料仍会被夜间提炼兜底。
  - **飞书里也能管任务**（`/task` 命令，在群或私聊，控制消息不会被当成知识收录）：
    - `/task` 或 `/task list` — 查看本空间任务
    - `/task new <主题>` — 新建每日研究任务（写入本空间）
    - `/task run <名称或序号>` — 立即运行
    - `/task help` — 帮助
  - **消息撤回**：回复原消息，@机器人说「别记这条」。原作者、群主或群管理员可执行；系统会删除该消息派生的全部原始记录，二次撤回会明确提示且事件重投不会重新入库。若内容已经进入知识页，会先移除受影响页面，再用仍有效的来源完成重新提炼后回复。撤回控制命令本身不会入库。
- **学习**（材料阅读 + 持续迭代的主题学习）：回复书籍、文章、附件或飞书文档后发送 `/learn new <名称>`，HomeAgent 会保存清洗后的材料快照，按标题和段落边界每天带读一课。也可以直接发送 `/learn topic <主题>`；Agent 会先提出 3–6 个入学诊断问题，了解已有经验、概念基础、实践能力、学习目标、可投入时间和偏好，再生成真正适合当前水平的路线。
  - 主题计划可以继续回复其他材料并发送 `/learn add <名称或序号>`；课程会使用 `[材料1]` 这样的标记引用用户材料，并把“来源材料”“模型一般知识”和“推荐资料”分栏展示。
  - 每当入学诊断或学习反馈生成了新路线，下一课准备前会按当前水平、目标和知识缺口自动联网检索 1–5 份资料。系统优先选择官方文档、标准、大学课程、研究机构与原始论文，实际打开页面核验后才保存 HTTPS 链接，并以 `[联网资料1]` 引用。也可以发送 `/learn resources <名称或序号>` 主动刷新和查看推荐。
  - 联网检索复用本机 Agent CLI：Codex 使用原生 Web Search，Claude 使用 WebSearch/WebFetch，不需要额外配置第三方搜索 API Key；TRAE 当前不支持该通道。网络、提供方或结果校验失败时，课程会明确写“本次未获得可验证的联网资料”，继续使用用户材料和标注为“未经外部检索验证”的模型一般知识，不会伪造来源或链接。
  - 用 `学习回答：<你的回答>` 完成入学诊断或提交每日作答。材料阅读计划给出基于原文的点评；主题计划会从回答中提取新的水平证据、知识优势和缺口，重新判断学习节奏，并只修订尚未开始的后续步骤。达到目标后进入下一步，存在关键误解时保留当前步骤并换一种方式补强；已经完成的路线和课程历史不会被改写。完成记录都会以 `source=learning` 写回知识空间。
  - 完整闭环是：**主题创建 → 入学诊断 → 个性化路线 → 每日一课 → 回答反馈 → 画像与后续路线迭代**。`/learn route <名称或序号>` 可查看当前路线、学习次数、最近一次路线调整和下一课重点；暂停、恢复、跳过和删除仍使用 `/learn pause`、`/learn resume`、`/learn skip`、`/learn delete`。
  - 默认每天北京时间 8:00 推送，停机后启动会补发当日未送课程；发送失败保留同一课重试，不会误推进。如果课程送达 24 小时后仍未作答，系统每天最多友好跟进一次，并在三次后停止催促；暂停计划也会停止跟进。
  - 管理后台用“学习地图”HTML 页面展示当前水平判断、判断依据、目标、知识优势、待补缺口、每日时间、路线版本、每一步状态、路线调整原因、用户材料、联网推荐资料和反馈轨迹，并可调整推送时间；材料阅读计划还可调整每课字数。
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
  学习回答：<你的理解或答案>      提交当前课程回答并获取点评
  ```

  首版沿用现有附件/文档导入能力：支持 UTF-8 文本与 Markdown、带文本层的 PDF，以及飞书文档；单个附件上限 20 MiB，提取文本最多 200,000 字符。扫描版 PDF、EPUB、Office、音频和视频暂不支持。
- **提醒**（与研究任务、知识记忆相互独立）：在群聊或私聊中 @机器人说“周日上午提醒我去茶饼斋”或“1 小时后提醒我喝水”，确定格式会直接按上海时区创建。规则无法可靠解析时，系统会让当前空间的 Agent 提取候选内容和时间并回显；只有原用户在 15 分钟内回复“确认”才会持久化，回复“取消”或不确认都不会进入提醒调度。
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
- **运行状态**：集中展示后台托管方式、PID、启动时间、两条飞书事件消费者的详细状态、必需 CLI、知识存储、任务、提醒、学习、Dream Cycle 与四个调度器；同时展示 AI 回答延迟、失败/超时、主动参与结果和事件队列积压。质量或积压告警会标为 degraded，但不会把仍可服务的实例误判为未就绪。LaunchAgent 托管时可从页面安全重启。
- **数据治理**：按空间导出 `homeagent.space v7` JSON 完整备份（知识页、原始记录、人工治理审计、撤回标记、任务及运行历史、Skill 解析证据、运行时限、通知状态、提醒、学习计划、主题路线、多来源材料及课程历史、空间元数据及关联 Agent），兼容恢复 v1–v7 备份；v6 及更早的字符串 Skill 会保留为待解析的 legacy 绑定，不会被静默绑定到错误来源。也可永久删除整个空间，或按保留周期立即清理已提炼的过期消息。
- **设置**：**默认 Provider + 默认 Model**（群未指定 Agent 时用它）、每日预算、提炼时刻、原始消息保留周期、端口。

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
- 负面反馈可加入本机待校准评测集，并从 `/quality/evaluation-cases.json` 导出版本化 JSON。候选只记录当时的答案、引用、反馈和人工校准说明；确认正确答案与引用后才手工并入固定评测集，不会自动学习或改写知识库。
- `bun run evaluate:quality` 离线运行固定评测集，覆盖检索与引用、对话路由、群聊主动参与和学习路线校验。命令会输出机器可读报告及检索建议：
  - `keep_fts`：当前 FTS、路由和引用达到阈值；
  - `improve_fts_retrieval`：路由和引用正常，但 FTS 覆盖率低于 85%，应补强知识页 aliases/tags、查询改写和大目录路由；
  - `insufficient_data`：检索样本不足，暂不调整架构。
- 项目架构决定不引入 embedding；后续检索改进保持 FTS + LLM 路由路线，不新增向量模型、向量索引或知识数据外发通道。
- 评测已进入 CI 和 `verify:beta`。阶段二不引入个人空间隐藏或隐私策略，仍以家庭和团队协作为产品边界。

### 首次启动与飞书连接

1. 普通用户双击 `HomeAgent.app`；源码开发者运行 `bun start`。全新数据目录会自动进入 `/setup`。
2. 应用包用户点击“安装并连接 ChatGPT”即可完成 Codex 下载、校验与 OpenAI 官方登录；源码运行会提供
   已检测到的 Codex、Claude Code 或 TRAE CLI，并把手动安装命令留在高级路径。
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

正式发布由 `v*` tag 触发 GitHub Actions，分别在 Apple Silicon 与 Intel runner 上构建，签名嵌套可执行文件，
生成并公证两个架构的 DMG，最后发布带 SHA-256 的更新清单。流水线要求 Apple 签名/公证 secrets，且只有
仓库变量 `BINARY_REDISTRIBUTION_APPROVED=true` 时才允许进入二进制发布阶段。

### 附件提炼（P2 首版）

飞书直接发送的图片和文件消息会通过 bot 身份下载并在本机提取文字，再作为同一条消息的原始材料进入知识库。
首版支持 UTF-8 编码的 `.txt`、`.md`、`.markdown`、`.csv`、`.json`、`.log` 文件、图片 OCR，
以及 PDF 已有文本层的提取；扫描版 PDF 不会自动执行 OCR。单个附件下载上限为 20 MiB，
每个附件最多保留 200,000 个提取字符，超限、损坏或不支持的附件会安全跳过，不影响原消息收录和回复。
资源元数据查询和下载各有 30 秒超时，下载期间会监视输出文件大小；本地图片/PDF 提取总计最多 60 秒，
图片在解码前还会执行 4,000 万像素上限检查。

提取记录保留原飞书 `messageId`，因此回复原消息执行「别记这条」、原始消息保留策略、空间导出和空间删除
都会覆盖这些派生记录。macOS 使用系统自带的 Vision/PDFKit；其他平台仍可提取上述 UTF-8 文本文件，
但会安全跳过图片 OCR 和 PDF 文本提取。音频转写、Office 文件、视频理解和 `post` 消息内嵌资源暂不支持。

> **CLI-only 的代价（务必知悉）**：claude/trae-cli 是完整编码 agent，单次调用**慢、开销大**，dream 批量提炼会明显变慢；它们**自带鉴权和模型选择**，不一定尊重你在 homeagent 里选的 model。dream 的结构化抽取靠"让 CLI 只输出 JSON + 解析校验 + 失败隔离（quarantine）"，偶有条目建不出页。失败记录会持续显示在对应空间的“提炼失败”页，并让知识健康状态降级但不阻断 `/readyz`；可单条或批量重试，且每次只处理该记录关联的原始来源，不会连带重跑无关消息。恢复所需来源不会被原始消息保留策略清理；若来源被撤回，旧失败记录会移除，仍有效的其他来源会重新进入待提炼队列。每日预算仅对可计费的 provider 有意义。

### 生产启动（接真实飞书）

```bash
bun run packages/app/src/main.ts
# 或 bun start
```

启动后：feishu 连接器监听事件、管理后台在 `HOMEAGENT_WEB_HOST:HOMEAGENT_WEB_PORT`、调度器做启动 catch-up + 每日 03:00 提炼，并按保留周期清理已提炼的过期消息。
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

部署探针：`GET /healthz` 是不依赖外部组件的快速进程存活检查，始终返回 200；`GET /readyz` 只有在知识存储、必需 CLI、两条飞书事件消费者及 Dream Cycle、任务、提醒、学习四个调度器都可用时返回 200，否则返回 503。管理后台 `/health` 提供完整健康快照的人类可读视图。

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
