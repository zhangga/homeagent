# HomeAgent Beta 发布与稳定性演练

本清单用于 `0.x beta` 发布候选。目标是验证普通用户无需终端即可安装，并确认进程异常退出后，
知识、Agent 发布历史、任务审批/重试、提醒、学习和质量审计不会丢失。签名、公证、真实飞书消息、
旧归档迁移和长时间运行必须在发布环境完成，不能只用离线单测代替。

## 1. 候选代码本地预检

候选提交必须位于干净工作树，并已通过 push / pull request CI：

```bash
bun install --frozen-lockfile
bun run verify:beta
```

`verify:beta` 只负责本地可自动化部分，会依次检查：

- 版本号和发布输入文件；
- 工作树是否干净；
- 品牌 SVG、飞书头像与 macOS iconset 的自动化校验（`bun run verify:brand`）；
- 全量离线测试；
- TypeScript 类型检查；
- 固定 AI 质量评测，以及基于 FTS 覆盖率的检索策略建议；
- 子进程遭受 `SIGKILL` 后的数据恢复验收。

Agent 生命周期、任务审批/重试、Provider 隔离、v10–v15 归档和质量重新评测还应单独运行一次聚焦回归，
便于把失败定位到本轮硬化范围：

```bash
bun test \
  packages/core/src/agents.test.ts \
  packages/core/src/engine.test.ts \
  packages/core/src/task-runs.test.ts \
  packages/core/src/governance.test.ts \
  packages/core/src/quality-rerun.test.ts \
  packages/core/src/usage.test.ts \
  packages/llm/src/budget.test.ts \
  packages/llm/src/providers.test.ts \
  packages/app/src/scheduler.test.ts \
  packages/app/src/task-scheduler.test.ts \
  packages/web/src/app.test.ts
```

质量评测必须覆盖检索与引用、对话路由、群聊主动参与和学习路线四类用例。当前候选只有在全部
固定用例通过时才进入后续发布门禁；报告中的 `improve_fts_retrieval` 表示下一轮应补强 aliases/tags
生成和大目录有界路由。项目明确不引入 embedding、向量索引或相关外部数据通道。

真实试用中出现的“没帮助 / 引用有误”回答应进入管理后台“AI 质量”工作台：先查看回答轨迹与引用，
必要时跳转知识页人工纠错，再加入待校准评测集并记录处理说明。导出的候选 JSON 仍需人工确认标准答案
和正确引用后才能并入仓库固定评测集；不得把错误答案自动学习回知识库。

命令成功时仍会把品牌资产自动校验与人工视觉验收分开报告。它不代表 Finder、Dock、DMG、
飞书圆形裁切、签名、公证、全新 Mac 安装或真实飞书 Soak 已经完成，也不能替代 GitHub Release
工作流和发布记录。

在开发中的脏工作树仅用于临时自检：

```bash
bun run verify:beta -- --allow-dirty
```

## 2. 签名与公证准备

GitHub `macos-release` environment 必须配置：

- `APPLE_CERTIFICATE_BASE64`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_KEYCHAIN_PASSWORD`
- `APPLE_CODESIGN_IDENTITY`
- `APPLE_ID`
- `APPLE_TEAM_ID`
- `APPLE_APP_PASSWORD`

仓库变量 `BINARY_REDISTRIBUTION_APPROVED` 必须在完成 Bun、lark-cli 和依赖许可证审查后设置为
`true`。发布工作流会在导入证书前只报告缺少的变量名称，不输出任何凭据内容。

确认 `package.json` 版本后，由维护者创建匹配的 `v<version>` 标签。标签会触发双架构构建、
Developer ID 签名、公证、staple、DMG 挂载 smoke，并把产物上传到 **Draft Prerelease**。Draft 只供维护者和
受控测试人员完成下面的外部门禁；在第 6 节全部通过前不得公开。

## 3. DMG 与无终端安装验收

arm64 和 Intel 架构至少各完成一次；测试机不得依赖仓库 checkout、全局 Bun、Node、npm、
Homebrew 或 lark-cli。

1. 由有仓库权限的测试人员从 Draft Prerelease 下载对应架构的 DMG；不要先公开 Release。
2. 验证 Gatekeeper 未提示“开发者无法验证”或已损坏。
3. 将 `HomeAgent.app` 拖入 `/Applications`，双击启动。
4. 确认应用自动安装并启动 LaunchAgent，然后自动打开 `/setup`。
5. 验证普通调用 Provider。Claude CLI 必须使用 strict no-tools 模式；Codex / ChatGPT 登录可直接用于普通问答，
   但必须记录 `ephemeral`、忽略用户配置/规则、`approval_policy=never` 与 `read-only` sandbox 证据。若所选 Provider 仍要求用户打开终端补齐安装或登录，本轮“无终端安装”应记为失败；
   内部 Soak 可预装 Claude 继续硬化，但不得拿它代替新用户门禁。
6. 创建或连接飞书机器人，确认两个事件消费者就绪。
7. 加入测试群，确认机器人只登记待确认并发送一次提示；由群主或管理员发送“@HomeAgent 启用群聊”，
   再发送真实消息完成首次知识收录并记下原始记录 ID。
8. 在同一空间创建一个禁用的研究任务、一个未来提醒和一个学习计划，记下各自名称或 ID。
9. 在后台确认知识、任务、提醒和学习计划均可查看。
10. 运行 `"/Applications/HomeAgent.app/Contents/MacOS/homeagent" doctor --json`，保存脱敏结果到发布记录。
11. 分别在 DMG、Finder 和 Dock 中检查 HomeAgent 图标，确认屋檐与智能火花居中、清晰且没有被系统遮罩裁掉。
12. 在“飞书连接”下载品牌头像 PNG，到飞书开放平台手动上传，并在圆形裁切预览和真实聊天中检查安全边距。
    HomeAgent 不会自动改动已有飞书应用，未执行手动上传时原头像必须保持不变。

构建机还应对最终 app 执行：

```bash
bun run smoke:macos -- --app dist/HomeAgent.app
bun run verify:beta -- --app dist/HomeAgent.app --require-signing-env
```

DMG smoke 会通过打包应用的归档恢复入口写入知识、任务、提醒和学习计划，验证可导出后将独立
应用进程真正 `SIGKILL`；随后用同一数据目录重启，再次导出并逐项比对四类数据，最后验证设置
向导和应用包不可变性。

## 4. 数据恢复验收

仓库级自动验收：

```bash
bun run verify:crash-recovery
```

它会在隔离数据目录中写入原始知识、研究任务、运行中任务、未来提醒和学习计划，随后真正
`SIGKILL` 子进程。重启后必须满足：

- 原始知识仍可读取；
- 任务配置仍存在；
- 中断运行被标记为持久化失败，而不是继续显示运行中；
- 提醒仍为待发送；
- 学习计划和材料快照仍存在。

真实安装还需执行一次 LaunchAgent 恢复：

```bash
launchctl kill SIGKILL "gui/$(id -u)/com.homeagent.agent"
```

KeepAlive 应自动启动新 PID。随后检查 `/readyz`，并使用第 3 节记录的名称或 ID 确认原始知识、
任务配置、待发送提醒和学习进度均仍存在。将前后 PID、四类记录的检查结果写入发布记录。

在测试空间页手动运行一次 Wiki Maintenance，记录完成时间、扫描页数、问题数和截断状态；再次
`SIGKILL` 并重启后，运行状态页必须保留同一份有界摘要，且一周内的启动 catch-up 不得重复扫描。
`/readyz` 必须包含独立 Maintenance 调度器：调度器未启动或最近失败时返回 503；仅发现断链、孤立页、
重复标识、超大页或无效 provenance 时整体可为 degraded，但仍可服务。

Dream 调度的积压回归必须确认：单批仍有 40 条 Raw 上限，一次 tick 最多追赶 4 批；超过上限的
遗留 Raw 会在下一次 tick 继续，而正常新 Raw 仍等待每日窗口。批次失败或没有处理任何 Raw 时，本轮
必须立即停止该 Space 的追赶且运行状态可见错误，不能在同一 tick 重复调用 Provider；仅因达到追赶
上限而仍有积压时整体可为 degraded，但 `/readyz` 仍可服务。

分层知识地图回归必须使用一个超过 24 个标签且至少有一个主题超过 100 页的测试空间：确认 `index.md`
只链接一级地图，长尾页面全部进入按类型划分的兜底地图，大主题递归拆成每页最多 100 项的下级地图；重启旧
数据目录会补齐地图，内容移动后旧地图会删除，未变化时不会重写。问答检索可沿命中地图逐层展开，但送入
LLM 路由的仍只能是最多 60 个普通知识页，地图本身不能成为引用证据或触发额外 Provider 调用。管理后台
应把一级地图与普通知识页分开展示，并拒绝对地图执行人工纠错、重新生成或删除；新生成的 Space
`AGENTS.md` 应指引外部 agent 按 `overview → maps → 内容页 → 有界 Raw` 的顺序读取。

可追溯性与时效性回归必须准备三类普通知识页：最新完整 Raw 证据、最新完整证据超过 365 天、来源 Raw
缺失或未准入。页面详情必须显示最新证据时间、时效等级、来源数、完整性及可打开的本地 Raw 元数据，
而系统生成地图不得显示或参与证据链；超过 365 天只能提示复核，不能自动删除页面或断言事实失效。
问答引用必须显示同一份有界证据摘要；综合调用面对冲突页时应收到最新证据时间与完整性并优先采用更新、
完整的证据，但 Prompt 和对外回答不得泄露 Raw id 或额外 Raw 正文。检查 Provider 调用记录，追溯展示和
Maintenance 不得增加调用次数。Wiki Maintenance 必须分别报告无 Raw 来源的不可追溯页和最新完整证据
超过 365 天的陈旧页，缺失或未准入来源仍按既有 invalid provenance 报告；以上检查均不得自动改写 Wiki。

本地 Agent 只读接口回归必须在 HomeAgent 服务运行时完成：

1. 用打包可执行文件执行 `homeagent mcp`，完成 `initialize`、`notifications/initialized` 和
   `tools/list`；必须稳定列出 `list_spaces`、`get_overview`、`list_maps`、`search_knowledge`、
   `get_page`、`get_page_trace` 六个工具，且全部声明 read-only、non-destructive、idempotent、closed-world。
2. 按 `Space → overview → map/search → page` 调用完整链路，确认每次内容查询都要求一个显式 Space，
   搜索最多返回 20 个普通知识页且不把 Knowledge map 当作搜索证据；未知工具、额外参数、危险 slug、
   畸形 JSON 和超大请求必须固定失败，不能触发治理动作。
3. `get_page` 只能返回正文和证据摘要，不得返回 Raw id 或内容摘要哈希；只有显式
   `get_page_trace` 可返回有界 Raw 元数据，且不得包含 Raw 正文、Raw 的 `chatId`/`messageId`、工作归属字段
   或跨 Space 来源；显式 SpaceId 仍应保留。
   超过 200,000 字符的页面必须截断并返回 `contentTruncated=true`，不能静默伪装成完整页面。
4. 同时配置不同的 `HOMEAGENT_WEB_ADMIN_TOKEN` 与 `HOMEAGENT_AGENT_READ_TOKEN`：read token 调用
   `POST /api/agent/v1/query` 应成功，访问任意管理页面或写接口必须返回 401；凭据不得进入 URL、stdout、
   日志或设置文件。未鉴权默认模式仍必须拒绝非回环请求。
5. 分别运行 `homeagent knowledge list_spaces` 与一个带 Space 的 JSON 查询；停止 HomeAgent 后两者必须
   明确报告服务不可用，不能自行打开或迁移数据目录。MCP stdout 只能包含逐行 JSON-RPC 协议消息。
6. 对比调用前后的 Raw journal、Knowledge page、运行记录和 Provider 用量：必须没有持久化变化、Provider
   调用或 token 增量。最后用 DMG 中的可执行文件重复 MCP 与 JSON CLI smoke，仓库内源码命令不能代替该门禁。

本地 Agent 消费反馈闭环另做以下回归：

1. 配置与管理/read token 均不同的 `HOMEAGENT_AGENT_FEEDBACK_TOKEN`。feedback token 调用
   `POST /api/agent/v1/feedback` 应成功，调用查询端点或管理页面必须返回 401；read token 调用反馈端点也必须返回 401。
2. `get_page` 返回稳定 opaque revision；用 `slug + revision` 提交 `incorrect/stale/conflicting/hard_to_reuse`
   页面反馈，用有界 query 提交 `not_found`。相同 idempotency key + 相同内容只能生成一条记录，相同 key 改内容必须冲突。
3. 在「AI 质量 → Agent 知识反馈」核验队列、Space 隔离、consumer、目标和说明。页面未变化时选择“知识页已修正”
   必须返回冲突；通过页面纠错形成新 revision 后才能关闭。搜索反馈只能使用覆盖计划、重复或无需处理等适用结论。
4. `helpful` 应自动确认且不进入人工待处理队列。任何反馈提交或关闭都不得自动创建 Raw、改写 Wiki、触发
   Dream/Maintenance Provider 调用或增加 token；运行状态只显示聚合计数，不得泄露 query/note/正文。
5. 启用反馈写入口后 MCP 应额外声明 `submit_knowledge_feedback` 为 non-destructive、idempotent、closed-world，
   但不是 read-only；未启用时仍只能看到六个读取工具。分别 smoke MCP 与 `homeagent feedback` JSON CLI。
6. 导出 `homeagent.space v19` 并恢复到全新目录，确认 open/resolved 状态、revision、处置说明与幂等键保持；
   v1–v17 归档应归一化为空反馈集合，跨 Space、伪造处置关系或超过 5000 条反馈的 v18/v19 归档必须 fail-closed。

原文件持久化另做以下回归：

1. 从空间详情页上传一份正文超过 200,000 字符且尾部有唯一标记的 UTF-8 文件；Raw 提炼文本可以有界，
   但 Raw 详情页下载的原文件必须逐字节一致，SHA-256 与上传前一致。
   再分别上传二进制、无效 UTF-8 和空文件，确认均创建 Raw 且可原样下载，不把乱码或占位文本冒充原正文。
2. 在飞书回复一份文件并明确说“请记录这个原文件”；即使文本提取失败或格式不支持，也必须在对应 Space 的
   `raw/sources/` 留下按 SHA-256 寻址的完整文件，并能从 Raw 详情页下载。临时下载文件清理失败不得回滚已保存原件。
3. 导出 `homeagent.space v19`，确认原文件载荷、摘要、字节数和 Raw attachment 双向一致；篡改 base64、摘要、
   字节数或引用关系必须在创建目标 Space 前 fail-closed。恢复到全新目录后再次下载并逐字节比对。

### 4.1 Agent 发布与 Skill 执行边界验收

在发布机的 Agents 工作台完成一次生命周期与本机 Skill 验收：

1. 为测试群绑定一个 Claude Team Agent，保存一版带唯一指令标记的 v1；修改 Instruction 和 Pinned Skills 后只点“保存草稿”，
   确认线上版本、群回答和历史运行仍引用 v1，工作台显示“有未发布草稿”。
2. 发布草稿为 v2，确认发布历史同时保留不可变的 v1/v2；启动一条研究任务后立刻修改 Agent，确认该 Run 仍显示启动时冻结的
   Agent revision、Provider、Model、Permission、Workdir 和完整 Skill 证据。
3. 从发布历史选择 v1 回滚，确认系统不是原地改写 v1，而是创建并发布一个内容等同 v1 的新版本；回滚前已创建的 Run 仍引用 v2，
   回滚后新建的 Run 引用新的线上版本。
4. 在飞书发起一次普通 @ 问答。Claude 必须使用 safe mode、空工具集且不保存 Provider 会话；Codex 必须使用临时只读模式、
   忽略用户配置/规则、禁止审批且不加载 Pinned Skills。Codex 应以冻结的 Agent Workdir（如已配置）作为只读当前目录，Claude 不使用
   Workdir 工具；绑定的 native Skills 记录为 `no_tools_context` 跳过且未被声明为已执行。普通问答、提炼、学习和质量重新评测都不得加载本机 Skill。
5. 把 Agent 切换为 Codex 后确认普通 @ 问答正常；切换为 TRAE 后确认系统明确安全拒绝且不产生工具副作用。再运行一条显式研究任务，
   确认只有该任务按冻结计划使用 Permission / Workdir / Pinned Skills。
6. 临时修改 Pinned Skill 目录中的一个非 `SKILL.md` 资源文件，再运行先前已排队的显式任务；必须因完整目录树摘要变化而
   fail-closed，不能只校验入口文件或静默使用新内容。恢复目录并重新创建 Run 后才允许执行。
7. 在工作上下文中配置两个下一动作，手动续作第一个并确认 Task Run 成功后先生成“结果 / 检查 / 证据”验收报告；`read-only` 仅在 Raw 已落盘、输出未截断且 Provider 返回严格 JSON 报告（`outcome=completed`、无 blocker、全部检查通过）时自动验收。普通文本或畸形报告必须停在人工验收，结构化 `blocked` 必须形成 blocker 且不得消费动作；`write/full` 即使执行前已审批，执行后仍必须人工接受。接受后才写入 checkpoint、消费当前首个动作；驳回必须填写原因，保留动作和证据并允许从同一边界重试。修改计划后可显式放弃旧的受阻动作，确认系统 blocker 被清除且新的首个动作可继续。待验收时自动续跑暂停，旧 Run 页面不能决定新重试结果。失败应转为阻塞，取消不得消费动作；重启后排队动作按冻结计划恢复，已中断的运行中动作只转为阻塞、不得重放。
8. 导出并恢复该空间，确认格式为 `homeagent.space v19`，Agent 发布历史、运行所引用的 revision、完整 Skill 证据、跳过原因、工作上下文、WorkAction/checkpoint/验收审计、自动续作策略、Raw 准入状态、分层知识地图、本地 Agent 知识反馈、完整原文件及 Wiki Maintenance 最近完成时间/有界摘要保持不变；待验收动作必须阻止导出与删除。验收前 Raw 必须为 `held` 且不能被 Dream、强制重跑、隔离重试或人工重新提炼读取；接受后才变为 `ready`，驳回、取消或失败后必须为 `excluded`。

这里验收的是当前 native Skill 冻结与执行链。`ManagedSkillStore` 仍是未接入 Provider 运行时的安全基础设施；不得把 Git/URL
导入、Managed release 执行或 Skill 市场写成已发布能力。

### 4.2 v10–v18 真实归档迁移验收

从对应历史版本各准备一份脱敏的真实 `homeagent.space v10`、v11、v12、v13、v14、v15、v16、v17、v18 归档；不得只修改 JSON 的 `version` 字段伪造。
每份归档使用独立的全新数据目录执行以下步骤，避免同名空间相互覆盖：

1. 先只读保存原归档、文件摘要和来源版本，再通过管理后台导入；导入失败时保留原文件和错误，不手改历史审计绕过校验。
2. v10 确认冻结执行计划仍可查看；v11 确认 Agent 发布历史和已有审批审计仍在；v12 确认审批期限与通知审计仍在；
   v13 确认用量、失败分类和自动重试关系仍在；v14 确认 Chat 评测 Trace 与已结束重评审计仍在；v15 确认工作上下文、WorkAction、checkpoint 与验收审计仍在，且历史 WorkAction Raw 按事实迁移为 `ready/excluded`，引用非准入来源的污染页被移除。旧版本本来没有的字段应保持 legacy/未知，不得补成虚假的成功、0 成本或已审批。
3. 对缺少可验证审批或执行计划的历史 `write/full` 活动运行做负向检查：恢复必须 fail-closed，不能用当前 Agent 配置继续执行。
4. 将迁移后的空间重新导出，确认版本为 `homeagent.space v19`；重启 HomeAgent 后再次导出，比对知识及分层地图、Agent revision、Task/Chat Run、工作上下文、WorkAction/checkpoint、Raw 准入状态、自动续作策略、
   审批/通知/重试/用量审计、提醒和学习数据的数量与关键 ID。
5. 把该 v19 归档导入第二个全新数据目录，确认没有重复通知、自动续跑、重复动作 checkpoint、重复原始材料、悬空工作关联、未验收 Raw 污染 Wiki、丢失原文件或悬空质量 trace。把原归档摘要、两次 v19
   导出摘要及逐项结果附到发布记录。

### 4.3 用量与质量重新评测验收

1. 分别打开一条 Chat Run、一条 Task Run 和一次质量 trace，确认调用次数、token 可见数、成本可见数和记账覆盖率一致。
   CLI 未报告成本时必须显示“成本未知”，且持久化审计满足 `unknownCostCalls > 0`、`knownCostCalls < calls`；不能显示为 `$0`。
   对应每日成本参考摘要必须为 `accountingComplete=false`；已知成本超出参考线或存在未知成本时，Provider 调用都应继续执行，不能出现成本准入拒绝。
2. 在一条已完成 Chat Run 的详情页执行“重新评测”，确认生成独立 candidate trace、记录本次用量，并且不向飞书再次发送回复。
3. 确认重新评测使用原问题和冻结计划；若原引用空间已不存在则应 fail-closed。它是一次可审计的 re-evaluation，输出允许变化，
   不得在发布记录中称为 deterministic replay。

## 5. 24–48 小时真实飞书 Soak

完成机器人配置并确认 `/readyz` 返回 200 后运行。发布门禁模式会强制至少运行 24 小时，并要求
每一种真实飞书业务场景都有本次时间窗内的成功证据：

```bash
bun run soak -- \
  --release-gate \
  --hours 24 \
  --interval-seconds 60 \
  --max-failure-rate 0.01 \
  --max-consecutive-failures 3 \
  --max-restarts 0 \
  --evidence ./artifacts/soak-evidence.jsonl \
  --output ./artifacts/soak-24h.jsonl
```

准备公开 Beta 时将 `--hours` 提高到 48。只运行健康探针而不加 `--release-gate` 的结果属于
runtime 监控，不能作为真实飞书发布门禁。

运行期间完成场景后，在另一个终端记录脱敏证据。`--artifact-id` 只填写飞书消息 ID、任务运行
ID、提醒 ID、学习计划 ID 或发布记录编号，不写消息正文：

```bash
bun run soak -- --record-evidence message_capture \
  --evidence ./artifacts/soak-evidence.jsonl --artifact-id om_xxx
bun run soak -- --record-evidence reminder_delivery \
  --evidence ./artifacts/soak-evidence.jsonl --artifact-id reminder_xxx
```

每次 soak 必须使用全新的 artifacts 子目录和 JSONL 路径，不得向上一轮 monitor 文件继续追加。
除真实网络中断外，优先使用自动验收驱动，不再由操作人逐项发送和确认。驱动以已授权的用户身份
向指定测试群发送带唯一标记的消息，以机器人只读身份轮询回复，并同时检查本地持久化状态；只有
场景断言成功后才向 evidence JSONL 追加记录。研究通知会优先复用当前 soak 时间窗内已经成功且
通知已发送的运行，不会为了留证重复执行同一研究任务：

```bash
bun run soak:feishu -- \
  --chat-id oc_xxx \
  --bot-open-id ou_xxx \
  --admin-url http://127.0.0.1:3000 \
  --sender ui \
  --data-dir ./data \
  --evidence ./artifacts/soak-evidence.jsonl \
  --monitor ./artifacts/soak-24h.jsonl \
  --scenarios group_binding_lifecycle,message_capture,mention_answer,proactive_participation,attachment_extraction,research_notification,reminder_delivery,learning_interaction,distill_citation \
  --research-task "发布浸泡研究"
```

`--admin-url` 指向本次受测 HomeAgent 的管理后台。若后台启用了
`HOMEAGENT_WEB_ADMIN_TOKEN`，在启动驱动的终端通过
`HOMEAGENT_SOAK_ADMIN_TOKEN='<管理令牌>'` 提供同一个值；不要把令牌写进命令参数、发布记录或
evidence JSONL。本机回环且未启用后台认证时无需设置该环境变量。驱动只对固定的群连接/断开路径发起
Bearer、同源、禁止自动重定向的管理请求。

`--sender ui` 是外部群和真实用户验收的默认选择。驱动会逐步输出以
`[F5_USER_ACTION]` 开头的结构化动作（发送文本、回复、上传图片或文件），由已登录的飞书
浏览器自动化代理解析并完成；驱动随后通过机器人只读接口和本地状态做断言并写证据，不需要测试者
逐项手工确认。单独在无人消费这些动作的终端运行时，驱动会等待浏览器代理完成对应动作。

只有受控的内部测试群才使用 `--sender api`。首次运行前，需要给 `lark-cli` 用户身份完成
消息和媒体上传的最小增量授权：

```bash
lark-cli auth login --scope "im:message.send_as_user im:message im:resource:upload im:resource"
```

飞书对外部群的用户身份消息接口可能返回 `230027`；这时不要重复授权，改用 `--sender ui`。

群绑定生命周期应先单独在获准的测试群执行；目标群可以原本已连接或已断开，推荐预先配置为
“仅在 @ Bot 时回复”。驱动会保存原状态，通过公开管理路由执行连接、@ 回复、断开后的零收录/零回复、
原空间重连与恢复收录，并在 `finally` 中恢复原来的已连接/已断开状态：

```bash
HOMEAGENT_SOAK_ADMIN_TOKEN='<仅在后台启用认证时设置>' \
bun run soak:feishu -- \
  --chat-id oc_xxx \
  --bot-open-id ou_xxx \
  --admin-url http://127.0.0.1:3000 \
  --sender ui \
  --data-dir ./data \
  --evidence ./artifacts/soak-evidence.jsonl \
  --scenarios group_binding_lifecycle,mention_answer
```

缺少 `im:message.group_msg` 时，生命周期仍以“仅在 @ Bot 时回复”完成；`proactive_participation`
会给出明确的权限前置条件并失败，不得用 @ 消息伪装通过。只有确认企业已批准该敏感权限后，才能运行
智能参与、普通群消息收录以及“响应所有消息”的验收。

可先加 `--dry-run` 检查场景和路径而不发送消息。必须显式传入本轮需要自动执行的 `--scenarios`；普通问答类场景使用
Claude strict no-tools 或 Codex 临时只读路径。`network_recovery` 不接受自动伪造的接口失败，必须在明确获准中断测试机网络后受控执行，
并继续使用 `--record-evidence` 记录恢复后的真实消息或发布记录编号。

必须覆盖以下场景；失败的尝试使用 `--failed` 记录，修复后再记录新的成功证据：

- `group_binding_lifecycle`：入群待确认、管理员启用、断开隐私、原空间重连和状态恢复；
- `message_capture`：群消息静默收录；
- `mention_answer`：Claude strict no-tools 或 Codex 临时只读的 @ 问答；绑定的 native Skills 必须显示为跳过；
- `proactive_participation`：一次主动参与；
- `image_analysis`：绑定 Codex 时验证临时只读普通会话的原生图片输入；绑定不支持图片的 Provider 时必须明确拒绝，
  不得猜测图片内容。自动驱动的正向识别断言只允许在本轮空间已绑定 Codex 时运行；
- `attachment_extraction`：文本或 PDF 附件提取；
- `research_notification`：研究任务及飞书通知；
- `reminder_delivery`：提醒创建与送达；
- `learning_interaction`：学习课程推送与回答；至少验证一次 `review` 留在当前内容且不产生 `source=learning` Raw，再用正确回答触发 `ready`、已验证学习记录和后续课程中的间隔回忆；
- `distill_citation`：Claude no-tools 或 Codex 临时只读的手动提炼和引用问答；
- `network_recovery`：网络短暂中断后恢复。

Soak 默认要求 `/healthz` 和 `/readyz` 同时成功，并记录延迟、失败、连续失败和进程替换次数。
发布门禁只有在 runtime 指标和上述十一项最新证据都成功时才通过。两个 JSONL 文件不得包含消息
正文或凭据。

### 5.1 本轮三个真实飞书灰度场景

以下三项必须在同一轮 24 小时 Soak 的真实测试群完成。仓库聚焦回归是自动验收基础，但不能替代飞书消息、真实 CLI
进程、持久化重启和通知去重证据。每一步记录脱敏的 Agent revision、Task Run、父/子重试 Run、飞书消息和发布记录 ID。

完成人工故障动作并取得真实 ID 后，用同一驱动做自动交叉校验：

```bash
HOMEAGENT_SOAK_ADMIN_TOKEN='<仅在后台启用认证时设置>' \
bun run soak:feishu -- \
  --chat-id oc_xxx \
  --bot-open-id ou_xxx \
  --admin-url http://127.0.0.1:3000 \
  --sender ui \
  --data-dir ./data \
  --evidence ./artifacts/soak-evidence.jsonl \
  --monitor ./artifacts/soak-24h.jsonl \
  --window-started-at 2026-08-10T00:00:00Z \
  --approval-expired-run-id run_expired_xxx \
  --approval-idempotency-run-id run_approval_retry_xxx \
  --retry-task-id task_retry_xxx \
  --retry-business-marker F5-RETRY-UNIQUE-xxx \
  --scenarios agent_revision_lifecycle,writable_task_approval,readonly_task_retry
```

`--window-started-at` 必须记录本轮灰度真正开始的时间（epoch 毫秒或 ISO 时间），不得沿用上轮值；monitor/evidence 文件即使采用 append，
驱动也只接受该时间之后的 Run、消息和状态样本。`run_expired_xxx` 必须来自生产审批过期循环；`run_approval_retry_xxx` 必须已有至少两次审批通知投递尝试且飞书只保留一条可见消息；
`task_retry_xxx` 必须已经发生一次真实的定时只读暂态失败，并把唯一业务标记同时写入重试输出和通知。驱动不得制造这些状态，
缺少任一真实前置证据就必须在任何管理写入前失败。三项通过后会写入与主 evidence 同目录的
`soak-evidence.agent-platform.jsonl`；这个 sidecar 只保存短 artifact ID，以及严格 allowlist 的 ID、状态、时间、计数和 SHA-256
metadata，不得包含消息正文、Instruction、Prompt、凭据或完整模型输出。
为稳定控制“运行中回滚”和审批时序，自动驱动通过受认证的公开 Web 管理表单创建/操作测试资源，并核验真实飞书出站通知；
它不覆盖群内 `/task run` 的入站命令链。下面要求的两次飞书 `/task run` 仍需由群主/管理员手工执行并单独归档证据，
不能用 Web 驱动 sidecar 替代。

正常失败、`SIGINT` 与 `SIGTERM` 会触发有界清理：先禁用临时 Task，再按归属检查恢复 Space 绑定并删除无引用的临时资源。
`SIGKILL` 或机器断电无法执行进程内清理；恢复后必须先把测试 Space 重新绑定到原 Agent，禁用并删除所有本轮 `F5-*` Task，
确认没有 Run 活跃后再删除无绑定的 `F5-*` Agent，完成前不得重跑或把 sidecar 计为通过。

#### `agent_revision_lifecycle`：Agent 发布、冻结与回滚

1. 给测试群的 Team Agent 发布带唯一标记的 v1，再保存并发布带另一标记的 v2；确认仅保存草稿时群内线上行为不变化。
2. 由群主或管理员在飞书执行 `/task run <测试任务>` 创建 v2 Run，并在运行详情记下冻结的 v2 revision ID。
3. Run 创建后立即在 Agents 工作台回滚到 v1。确认回滚产生新的已发布 revision，而不是改写历史 v1/v2。
4. 等待 v2 Run 完成并只收到一次研究通知；详情中的 revision、Provider、Model、Permission、Workdir 和 Skill 摘要仍为创建时的 v2 计划。
5. 再从飞书创建一条新 Run，确认它引用回滚产生的新线上 revision；两条 Run 的原始材料和通知各一份，没有串用版本。

自动验收以第 1 节的 `agents.test.ts`、`engine.test.ts`、`app.test.ts` 回归及两条真实 Run 详情字段为准；只观察最终回答文本，
不能证明执行计划已冻结。

#### `writable_task_approval`：`write/full` 审批、重启与过期

1. 在一次性测试 Workdir 上发布 `write` Agent，并创建开启飞书通知的测试任务。由群主或管理员从飞书立即运行，确认 Run 进入
   `awaiting_approval`，审批前没有 Provider 启动时间、输出、原始材料或 Workdir 变更，审批通知只出现一次。
2. 保持待审批状态重启 HomeAgent；确认 Run 仍等待原冻结计划、没有重复审批通知。随后从后台批准，确认只执行一次并只产生一份
   原始材料/完成通知。另建一条 Run 执行“拒绝”，确认 Provider 调用仍为 0。
3. 另建一条审批 Run，在受控网络中断下让第一次审批通知投递失败，再恢复网络等待调度器重试；确认通知审计至少两次尝试、
   飞书最终只有一条包含该 Run ID 的审批消息。随后批准并等待 Run 成功，把它作为 `--approval-idempotency-run-id`；无法安全制造
   真实投递故障时，本项记为未覆盖，不得直接修改通知审计。
4. 在 Soak 开始时各创建一条 `write` 与 `full` Run 并不作决定；到 24 小时截止后确认二者均转为 `expired`，过期审批不可再批准，
   无 Provider 输出、文件副作用或重复通知。`full` 绕过 Provider 沙箱，灰度中不得批准，只验收等待与过期。
5. 核对每条 Run 的申请时间、24 小时截止时间、决定人/过期 actor、通知尝试和冻结计划；审批后若 Workdir 已移动或被替换，
   必须在 Provider 启动前 fail-closed。

自动验收以 `task-runs.test.ts`、`task-scheduler.test.ts`、`engine.test.ts` 和 `app.test.ts` 中的审批、过期、重启及通知去重用例为准。

#### `readonly_task_retry`：定时只读任务自动重试

1. 创建启用通知的 `read-only` 定时任务，在主题中要求输出且通知原样包含一个不超过 120 字符的单行唯一标记，并记下下一次
   触发时间；手动“立即运行”不符合自动重试条件，不能替代本场景。
2. 经批准后，在任务到期前短暂断开测试机网络。只有首条 Run 的详情明确记录 Provider 阶段、`retryable=true` 的
   `overloaded`、`rate_limited` 或 `transient_provider` 失败并进入等待重试，才算成功触发；认证、配置、外部 Provider 成本准入、超时、Skill、
   Workdir、取消或已有输出的失败都不得自动重试。
3. 首条 Run 进入等待后立即恢复网络。约 60 秒后确认系统原子创建且只创建一条关联子 Run，子 Run 的 `trigger=retry`、
   `retryOf=<父 Run ID>`、attempt 和冻结执行计划均正确。
4. 确认子 Run 从头重新执行并最终只有一份业务原始材料和一条成功通知；禁用任务后不得继续等待或生成新的自动重试。

这是一条使用冻结计划的新 Run，不是进程 checkpoint 或确定性续跑。若真实网络故障没有被 Provider 报告为上述可重试分类，
本场景应记为未覆盖/失败，不能手改归档或运行状态伪造通过；自动状态机证据由 `task-runs.test.ts`、`engine.test.ts` 和
`task-scheduler.test.ts` 提供。

## 6. 发布决定

只有以下条件全部满足才发布或扩大测试范围：

- push / PR CI 在 Linux 和 macOS 全绿；
- `bun run verify:brand` 全绿，且 Finder、Dock、DMG 与飞书圆形头像的人工视觉记录已归档；
- 两个架构的签名、公证和 DMG smoke 全绿；
- 至少一个全新用户环境完成无终端安装；
- 自动与真实崩溃恢复均通过；
- v10、v11、v12、v13、v14、v15、v16、v17、v18 九份真实归档均完成独立迁移、v19 再导出、重启和二次恢复，比对记录已归档；
- Agent 草稿/发布/回滚、`write/full` 审批与过期、定时只读自动重试三个真实飞书灰度场景全部通过；
- 普通调用的 Claude strict no-tools 或 Codex 临时只读、native Skill `no_tools_context` 跳过、TRAE 安全拒绝和图片输入边界均有真实消息证据；
- 用量页面没有把未知成本显示为 0，质量重新评测没有外发副作用且被标记为 re-evaluation 而非 deterministic replay；
- 24 小时 soak 达标；公开 Beta 前完成 48 小时 soak；
- 已记录仍由飞书管理员完成的权限、发布和外部共享步骤。

全部证据归档后，由维护者在 GitHub Release 页面把该 Draft 发布为 Prerelease；公开前再次确认 tag、两个 DMG、
`update-manifest.json` 与本清单记录属于同一版本。任何一项未通过都保留 Draft 或删除候选产物，不得提前公开。
