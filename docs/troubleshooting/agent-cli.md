# Agent CLI、数据与运行排障

这些条目只描述 HomeAgent 当前公开契约。命令示例默认离线、只读；不要在运行中的数据目录上手工改文件。

## CLI-001 — 进程继承了旧 PATH

**指纹：** 安装 `bun`、`codex`、`claude` 或 `trae-cli` 后，新终端能找到命令，但旧终端、Codex Desktop 或 HomeAgent 服务仍提示 `not found` / `not recognized`。

Windows 和 macOS/Linux 进程都只继承启动时的环境。安装器更新用户配置后，不会反向更新已经运行的父进程和服务。

处理顺序：

1. 在新终端执行对应的 `--version`，确认安装本身可见。
2. 完全退出并重新启动持有旧环境的终端、Codex Desktop 或 HomeAgent 服务。
3. 再从 HomeAgent 管理页刷新 Provider 探测。
4. 仅为诊断临时修正当前进程 PATH；不要把凭据或私有配置复制进启动脚本。

验证应同时满足：新终端可解析命令、服务重启后管理页显示探测结果、最小离线/获准调用按预期执行。

## CLI-002 — CLI 存在不等于 Provider 可用

把问题分成四层：

1. **binary：** 当前 HomeAgent 进程能否解析可执行文件并读取版本。
2. **authentication：** CLI 自己的登录/托管凭据是否有效。
3. **routing：** 所选模型是否被当前 CLI 和上游账户支持；HomeAgent 的模型下拉是维护清单，不是上游可用性证明。
4. **execution：** 一次无敏感内容、明确获准的最小调用是否成功，sandbox、权限和超时是否符合冻结 Run。

不要把菜单中出现模型、`--version` 成功或端口可达写成“Provider 已验证”。不要把 provider 未上报的 token/cost 补成 0；应保留 unknown 与覆盖率。

普通聊天与任务使用本机 CLI；`trae-cli` 只用于显式任务。提炼和后台学习走受限 no-tools 调用。实际支持范围与模型清单以 [`README.md`](../../README.md) 为准。

## CLI-003 — Codex 参数作用域与版本不匹配

**指纹：** Codex 在读取 prompt 前就以参数解析错误退出，常见于 isolation flag 放在错误位置或本机版本过旧。

当前 HomeAgent 的一次性调用需要 Codex 0.147+；飞书话题的原生会话 fork 及其隔离参数需要 Codex 0.152.1+。
`--ephemeral`、`--ignore-user-config` 和 `--ignore-rules` 属于 `exec` 子命令，必须位于 `exec` 之后。先核对：

```bash
codex --version
codex --help
codex exec --help
codex exec fork --help
codex mcp list --json
```

HomeAgent 通过 stdin 传多行 prompt，并使用 `approval_policy="never"`、ephemeral、忽略用户配置/规则、
`project_doc_max_bytes=0`、关闭 Codex 自动 Skill 发现和按权限映射的 sandbox。冻结 Skill 由 HomeAgent 在每次调用前
按已记录摘要捕获，复制到本轮私有临时目录并对副本复验，再以唯一允许的 exact `name → SKILL.md` 映射传入；
live Skill 目录不会进入 prompt/profile，fork 也会忽略历史 turn 中已清理的旧临时路径。不要为了绕过解析错误删除隔离参数、恢复项目
`AGENTS.md` 注入或改成继承用户规则；这会改变安全契约。版本不匹配时升级受支持 CLI，或在代码和相邻
provider 测试中显式完成兼容改动。

HomeAgent 的 Codex setup、能力探测和实际运行共同使用 `<dataDir>/provider-state/codex`。启动时会初始化该独立目录；
若当前控制台 `CODEX_HOME/auth.json` 是有效的普通文件，HomeAgent 会以有界读取、JSON 校验、同目录临时文件和原子发布
把登录缓存导入独立目录。源文件不会被修改或链接，控制台的配置、规则、Plugins、Skills、原生会话及其他状态也不会被继承。
导入后，HomeAgent 优先使用独立目录中的 file credential cache，Codex 可自行刷新该副本；若 file cache 不可用，
会再用无模型 `login status` 探测 Codex 的系统 keyring，并在验证成功后仅复用这份 OS 凭据。两条路径都继续使用独立
`CODEX_HOME`，不会继承控制台配置、规则、Plugins、Skills 或会话历史。两种缓存都不可用时，设置页会显示
“HomeAgent 尚未连接当前 Codex 账号”，需要完成一次官方设备授权；源码模式和打包应用都提供该入口。
需要自定义隔离位置时设置 `HOMEAGENT_CODEX_HOME`。Codex 专属 Skill 也只从该目录的
`skills/` 发现；共享 Skill 请放在 `~/.agents/skills`。Provider 已禁用 Plugin/Vendor，不要把 ambient
`~/.codex/plugins` 或 `~/.codex/vendor_imports` 中的能力写进冻结 Run 证据。

Windows 控制台里的 Codex 能正常执行普通任务，不等于 HomeAgent 飞书话题所需的 exact filesystem profile 已可用：
Codex 的 `unelevated` fallback 无法满足 restricted read-only root-deny 时，HomeAgent 会继续允许普通调用，但把原生会话标成
“安全沙箱待设置”。此时在 Agent 详情右侧点击“启用 Windows 安全沙箱”；HomeAgent 通过 Codex App Server 发起官方
`elevated` 设置，请在弹出的 UAC/管理员窗口中批准。页面会等待完成并自动重新执行同一无模型隔离探测，只有探测通过才显示
“Codex 已完全可用”。拒绝 UAC、企业策略禁止本地用户/组、防火墙或登录权限变更时，设置会固定失败并允许重试；不要改成
跳过 root-deny 或把用户的完整 `~/.codex` 配置复制进 HomeAgent。

飞书话题的 Codex 原生会话还要求“有效 MCP 列表为空”且 filesystem root-deny 确实生效。HomeAgent 会用同一受控子进程环境、
隔离 `CODEX_HOME`、冻结 Workdir、本轮私有 Skill 副本和 exact permission profile 执行
`codex mcp list --json`（只接受严格的 `[]`）及不调用模型的 sandbox probe。probe 必须同时证明本轮允许目录可读、
`CODEX_HOME` sentinel 不可读、`<dataDir>/run/` 下仅受 `:root=deny` 保护的 sibling sentinel 也不可读；只证明某条显式 deny 不算通过。
每次调用都会一边捕获 live Skill bundle 一边核对冻结摘要，复制到私有临时目录后再对副本重算同一摘要；prompt 和 permission profile
只包含副本路径，成功、失败或取消后都会清理。live 目录在冻结后发生变化时固定拒绝，不会降级为直接授权原路径。
路由/分类和最终生成都使用这套边界，只有最终生成携带原生会话。`full`、Workdir 与数据目录重叠、无 Workdir 时回退到进程 cwd，
或任一 probe 失败都会在模型调用前固定拒绝；无 Workdir 的只读话题改用本轮专用空目录。
System/MDM MCP 无法由本次 CLI 调用全局关闭；只要列表
非空、非法、探测失败或超时，原生会话都会在模型调用前 fail-closed，且公开错误不显示 server 名称。
请让机器管理员从 System/MDM 删除这些 MCP，再刷新 Provider 探测；不能清空时改用 Claude
或保持 Codex 一次性调用，不要绕过该门禁。

### 群话题权限与执行证据

排查“只看得到几个群”时，从 Agent 的 Recent runs 打开本轮 Chat Run，先看冻结的 Skill 目录和权限，
再看执行证据中的飞书操作、显式身份和 CLI 报告身份。普通 Chat 默认冻结全部兼容 Skill；这不会自动
授予飞书用户身份或跨 Space 读取权限。没有执行证据的旧回答不能当作权限检查结果。
`full` 的群话题会明确报配置冲突，不会降级成普通完全访问调用；修改为 `read-only` 或 `write` 后须发布
并发送新请求，旧运行重试不会采用新配置。受限权限下平台沙箱检查仍失败时，应继续排查隔离后端，不能改回
`full` 绕过。详情页只显示脱敏元数据，不显示完整命令或原始工具输出；未知身份和截断证据必须保留不确定性。

对于新运行，先看准备失败的固定原因码，而不是再次尝试登录：

| 原因码 / 退出码 | 检查结果 | 处理边界 |
| --- | --- | --- |
| `codex-home-readable` / 73 | 沙箱仍能读隔离的 Codex 状态目录 | 停止话题执行，修复隔离后复检 |
| `allowed-path-unreadable` / 74 | 沙箱无法读已授权测试目录 | 排查平台沙箱、目录 ACL 和工作目录 |
| `protected-root-readable` / 75 | 沙箱仍能读仅受根目录拒绝规则保护的数据目录测试文件 | 不是登录失败；不能增加对测试文件的专门拒绝规则来伪造根目录验证通过，也不能改 full 绕过 |

`windows-elevated-sandbox-required` 才表示应走页面中的 elevated 沙箱设置流程。版本、fork、MCP 与文件隔离是独立门禁；CLI 可连接不代表原生话题可用。即使没有模型输出，新运行也会保留已识别的准备失败证据；旧运行不补造。

Skill 副本总预算为 128 MiB / 200,000 个条目，单 bundle 仍为 16 MiB / 50,000 个条目。容量不足时停止整轮并清理全部副本，不会按目录顺序跳过后面的 Skill。新运行应核对冻结目录与实际完整映射；需要采用更改后的目录时必须重新发起请求，不能改写旧 Run 的冻结证据。

## CLI-004 — 编码由消费方决定

Windows PowerShell 5.1 可能把含中文的 UTF-8 无 BOM `.ps1` 当作系统代码页读取，产生乱码和位于无关 `}` 附近的级联语法错误。先检查宿主版本和文件首字节，再用 PowerShell Parser API 验证，不要先改业务逻辑。

相反，Codex Skill 的 `SKILL.md` frontmatter 必须从首字节 `---` 开始，BOM 可能使校验器认为 frontmatter 缺失。结论不是“统一加 BOM”或“统一去 BOM”，而是按真实消费方选择编码并用真实解析器验证。

## DATA-001 — 先确认有效数据目录

`HOMEAGENT_DATA_DIR` 显式设置时会固定数据目录；否则还要结合启动方式和设置页迁移结果判断。清理仓库相对路径 `data/` 后仍看到旧 Space/群绑定，通常说明运行实例使用了别的目录。

只读定位：

1. 确认正在运行的进程/服务及其实际环境。
2. 检查是否显式设置 `HOMEAGENT_DATA_DIR`，并核对管理页当前配置。
3. 停止实例后再备份或迁移有效目录；不要在 live data 上手工编辑。
4. 迁移必须 stage、校验、切换、重启验证，并保留旧目录。

## DATA-002 — Raw/Wiki 权威，SQLite 是投影

权威数据是：

- `raw/records/**/*.jsonl` 与 `raw/retractions.jsonl`：Raw journal；
- `wiki/**/*.md`：Knowledge pages。

SQLite 用于查询和 FTS，是可重建投影。SQLite 损坏或删除不应等价为 Raw 丢失，也不能把 SQLite 当唯一备份。遇到 JSONL 校验失败应停止并报告，不得静默跳过或为通过测试而弱化恢复。

## RUN-001 — Run 必须使用冻结执行证据

Chat/Task Run 创建时冻结 Agent revision、instruction、provider、model、permission、Workdir、execution limits 和 Skill evidence。重试或恢复使用冻结计划，不能读取“现在的 Agent 配置”替换它。

`write`/`full` 运行在 provider 调用前必须已有持久化正向人工审批。执行前还要确认冻结 Workdir 仍是目录，重新 canonicalize 后与创建 Run 时的位置相同；缺少审批、owner、来源或执行证据时 fail-closed。应用停止时已经 running 的 provider 进程不得在恢复时重放。

## RUN-002 — 飞书话题只推进已提交的 Provider 会话

Codex 的飞书群话题使用 Provider 原生会话，而不是由 HomeAgent 重放聊天记录；Claude 当前仍是一次性隔离调用。
首轮 start，后续每轮从最近成功 head fork；只有 Provider 回答和 Chat Run 成功状态在同一次原子提交中落盘后
才提升 child。失败、取消、超时或进程中断都保留旧 head。父会话在 Provider 本机不可用，或话题中出现没有进入
Provider 历史的静态产品回复时，HomeAgent 会废弃旧 head，让下一轮重新 start。

原生链只包含真正进入回答阶段的 Agent 问答，不包含未触发回答的普通群消息、路由或分类调用。当前消息正文以及明确回复目标
的正文或图片仍可能作为本 turn 的不可信来源上下文传入；未明确回复时不会用同一 chat 的“最近附件”启发式跨话题补上下文。
若同一话题突然丢失上下文，依次核对 root message、
冻结配置兼容摘要、Provider 本机历史是否仍存在，以及 `config/chat-runs.json` 是否随同一数据目录重启；不要
手工填写或从归档导入 session ID。

话题映射不会进入 `homeagent.space` 归档，换机或恢复备份后第一轮重新 start 是预期行为。多人话题只读取 Team
Space；若发现 Personal Space 内容进入共享话题，应视为隔离故障并停止该版本。撤回消息后相关映射必须与
Chat Run 删除原子失效，重启后重投同一 `message_id` 也不得重新收录或回答；
HomeAgent 不负责清除 Provider CLI 账户自己保留的本机会话文件。

## RUN-003 — WorkAction 结果先 held 再验收

WorkAction 产生的 Raw 一开始必须是 `held`：

- accepted 后才可变为 `ready` 并进入 Dream 队列；
- rejected、cancelled 或 failed 后必须为终态 `excluded`；
- Knowledge page 永远不能引用 `held` 或 `excluded` evidence。

排查污染知识时同时核对 Raw、Run、WorkAction、acceptance 和 checkpoint 的 Space、owner 与 attempt 双向关联。缺失或冲突时停止自动恢复，不要猜测归属。

## STORE-001 — 先持久化候选再替换内存

安全 mutation 顺序是：深拷贝当前状态 → 修改候选 → 完整校验 → 同目录临时文件写入并 fsync → 原子替换 → 成功后替换内存。

否则写失败会留下 phantom create、脏 update，或出现“内存已删、重启又回来”。未知的未来 schema 必须 fail-closed，不能当 legacy 降级后覆盖。故障修复至少覆盖 validation failure、persistence failure、reopen/recovery 和相关 legacy migration 测试。

## SEC-001 — 路径必须规范化并拒绝链接逃逸

Workdir、Skill、导入、迁移和进程执行都把路径当作信任边界：

- 转为绝对路径并 canonicalize；
- 用相对路径边界判断，不使用简单 `startsWith`；
- 在信任边界拒绝 symlink、junction 和其他 reparse-point 逃逸；
- 执行前重新确认目标仍存在且没有被替换。

App Secret、token、authorization code、消息正文和 provider diagnostics 不得出现在 URL、argv、健康输出或公开错误。敏感 `lark-cli` 输入应通过 stdin 和托管凭据存储传递。

## RELEASE-001 — 本地通过不等于 beta-ready

Windows 可用于聚焦跨平台测试和 typecheck，但不能证明 SIGKILL、目录 fsync、LaunchAgent、Swift helper、hard-link 或 POSIX path 契约。发布结论还需要 Ubuntu/macOS CI、签名/公证、全新 Mac 安装、真实飞书、迁移和 soak 门禁。

因此报告要明确区分：已通过的聚焦测试、未运行的支持平台测试、未运行的 live/外部门禁。完整流程见 [`docs/beta-release-runbook.md`](../beta-release-runbook.md)。
