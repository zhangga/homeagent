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

当前 HomeAgent 适配 Codex 0.147+：`--ephemeral`、`--ignore-user-config` 和 `--ignore-rules` 属于 `exec` 子命令，必须位于 `exec` 之后。先核对：

```bash
codex --version
codex --help
codex exec --help
```

HomeAgent 通过 stdin 传多行 prompt，并使用 `approval_policy="never"`、ephemeral、忽略用户配置/规则和按权限映射的 sandbox。不要为了绕过解析错误删除隔离参数或改成继承用户规则；这会改变安全契约。版本不匹配时升级受支持 CLI，或在代码和相邻 provider 测试中显式完成兼容改动。

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

## RUN-002 — WorkAction 结果先 held 再验收

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
