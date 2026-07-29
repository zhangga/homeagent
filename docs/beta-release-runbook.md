# HomeAgent Beta 发布与稳定性演练

本清单用于 `0.x beta` 发布候选。目标是验证普通用户无需终端即可安装，并确认进程异常退出后，
知识、任务、提醒和学习状态不会丢失。签名、公证、真实飞书消息和长时间运行必须在发布环境完成，
不能只用离线单测代替。

## 1. 候选代码本地预检

候选提交必须位于干净工作树，并已通过 push / pull request CI：

```bash
bun install --frozen-lockfile
bun run verify:beta
```

`verify:beta` 只负责本地可自动化部分，会依次检查：

- 版本号和发布输入文件；
- 工作树是否干净；
- 全量离线测试；
- TypeScript 类型检查；
- 固定 AI 质量评测，以及基于 FTS 覆盖率的检索策略建议；
- 子进程遭受 `SIGKILL` 后的数据恢复验收。

质量评测必须覆盖检索与引用、对话路由、群聊主动参与和学习路线四类用例。当前候选只有在全部
固定用例通过时才进入后续发布门禁；报告中的 `improve_fts_retrieval` 表示下一轮应补强 aliases/tags、
查询改写和大目录路由。项目明确不引入 embedding、向量索引或相关外部数据通道。

真实试用中出现的“没帮助 / 引用有误”回答应进入管理后台“AI 质量”工作台：先查看回答轨迹与引用，
必要时跳转知识页人工纠错，再加入待校准评测集并记录处理说明。导出的候选 JSON 仍需人工确认标准答案
和正确引用后才能并入仓库固定评测集；不得把错误答案自动学习回知识库。

命令成功时仍会明确列出尚未完成的外部门禁。它不代表签名、公证、全新 Mac 安装或真实飞书
Soak 已经完成，也不能替代 GitHub Release 工作流和发布记录。

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
Developer ID 签名、公证、staple、DMG 挂载 smoke 和 GitHub Release 发布。

## 3. DMG 与无终端安装验收

arm64 和 Intel 架构至少各完成一次；测试机不得依赖仓库 checkout、全局 Bun、Node、npm、
Homebrew 或 lark-cli。

1. 下载 GitHub Release 中对应架构的 DMG。
2. 验证 Gatekeeper 未提示“开发者无法验证”或已损坏。
3. 将 `HomeAgent.app` 拖入 `/Applications`，双击启动。
4. 确认应用自动安装并启动 LaunchAgent，然后自动打开 `/setup`。
5. 完成 Codex 安装和 ChatGPT 登录。
6. 创建或连接飞书机器人，确认两个事件消费者就绪。
7. 加入测试群，在 “Integrations” 中显式连接该群并选择响应方式，再发送真实消息完成首次知识收录，
   记下原始记录 ID。
8. 在同一空间创建一个禁用的研究任务、一个未来提醒和一个学习计划，记下各自名称或 ID。
9. 在后台确认知识、任务、提醒和学习计划均可查看。
10. 运行 `"/Applications/HomeAgent.app/Contents/MacOS/homeagent" doctor --json`，保存脱敏结果到发布记录。

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

可先加 `--dry-run` 检查场景和路径而不发送消息。默认自动执行前十项；`network_recovery` 不接受
自动伪造的接口失败，必须在明确获准中断测试机网络后受控执行，并继续使用 `--record-evidence`
记录恢复后的真实消息或发布记录编号。

必须覆盖以下场景；失败的尝试使用 `--failed` 记录，修复后再记录新的成功证据：

- `group_binding_lifecycle`：显式连接、断开隐私、原空间重连和状态恢复；
- `message_capture`：群消息静默收录；
- `mention_answer`：@ 问答；
- `proactive_participation`：一次主动参与；
- `image_analysis`：图片回复分析；
- `attachment_extraction`：文本或 PDF 附件提取；
- `research_notification`：研究任务及飞书通知；
- `reminder_delivery`：提醒创建与送达；
- `learning_interaction`：学习课程推送与回答；
- `distill_citation`：手动提炼和引用问答；
- `network_recovery`：网络短暂中断后恢复。

Soak 默认要求 `/healthz` 和 `/readyz` 同时成功，并记录延迟、失败、连续失败和进程替换次数。
发布门禁只有在 runtime 指标和上述十一项最新证据都成功时才通过。两个 JSONL 文件不得包含消息
正文或凭据。

## 6. 发布决定

只有以下条件全部满足才发布或扩大测试范围：

- push / PR CI 在 Linux 和 macOS 全绿；
- 两个架构的签名、公证和 DMG smoke 全绿；
- 至少一个全新用户环境完成无终端安装；
- 自动与真实崩溃恢复均通过；
- 24 小时 soak 达标；公开 Beta 前完成 48 小时 soak；
- 已记录仍由飞书管理员完成的权限、发布和外部共享步骤。
