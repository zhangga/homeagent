# Codex 双执行模式：设计与实施交接

状态：**实施中，P0–P4 已落地，P5 的 Windows Edge 离线浏览器和 Codex 最小真实验收已通过；完整 Skill、真实飞书/重启衔接与支持平台门禁未完成**。本文面向实现者。

设计日期：2026-09-14。已核对代码基线：`main` / `227d580`（`fix: preserve frozen Skills and audit native topic failures`）。
该基线已包含此前功能分支的原生话题实现。当前工作树已接通可信 Core 发布授权、执行门禁及页面确认流程；默认检测不再启动隔离探针。当前机器的一次性完全访问实例已取得真实模型/文件工具证据，既有生产服务未变更、未据此认定恢复。

## 1. 接手须知与实施入口

用户希望继续在 Windows 原生环境使用 HomeAgent，不尝试 WSL；控制台 Codex 已可用，不希望反复登录、设置沙箱仍无法在群里回答。
本设计保留现有隔离路线，同时增加由本机操作者明确开启的完全访问路线。它移除已知的隔离前置阻塞，但不保证解决鉴权、模型、网络或飞书权限问题。

新会话按以下顺序开始：

1. 检查 `git status`、当前分支与 `227d580` 后的新变更；保留用户改动。
2. 阅读 [AGENTS.md](../AGENTS.md)、[README.md](../README.md)、[CONTEXT.md](../CONTEXT.md) 与本文件。
3. 按第 12 节核对已实施部分，再继续尚未完成的阶段；第 3–11 节是对应的设计约束。下一步为 P5 完整 Skill、测试飞书群/重启衔接及支持平台门禁；第 13.2a/13.3a 节的离线浏览器和最小真实流程已通过，不重做 P0–P4。
4. 每次真实调用仍须授权；测试飞书群和测试实例重启需要单独明确范围，不因最小真实验收获准而扩展到生产操作。
5. 用第 14 节逐项交付；未经验证的能力保持“未验证”，不要把取消检查说成修复了沙箱。

本文设计已获得用户“根据文档开始实施”的确认，代码变更按本文范围推进。
本文不授权下载/升级 CLI、修改机器 ACL、操作真实飞书群、修改 live data、推送远端或发布版本。

### 1.1 已知事实，而不是待猜测的原因

以下是此前本机诊断的历史结果；环境变化后需要重新核验，不可套用于所有 Windows：

| 检查 | 历史结果 | 能得出的结论 |
| --- | --- | --- |
| 本机 Codex CLI | `0.154.0`，普通 CLI 可用，`exec fork --help` 成功 | 安装及原生 fork 命令存在，不等于某个模型调用必然成功 |
| 独立 Codex 状态目录 | 已配置 Windows `elevated` | 不是单纯没有设置该配置项 |
| 有效 MCP | 严格空数组 | 这次阻塞不是 MCP 非空 |
| 已发布 Agent | `write`，非 `full` | 用户已调整并发布权限，不能继续只建议改成 write |
| 无 Skill／完整 Skill 预检 | 均返回 HomeAgent 探针码 `75` | 应受根目录拒绝规则保护的测试文件仍可读取 |
| 更换 CLI 入口、临时 Workdir 所在盘、缩小允许目录 | 仍返回 `75` | 尚未找到维持同等隔离要求的兼容方案 |
| 完整 Skill 副本准备 | `112 / 112`，argv 约 2,251 字符 | 此前的目录静默删减已修复，与当前根目录读取问题分开处理 |

`73 / 74 / 75` 是 HomeAgent 自己的隔离探针退出码，不是 Codex 官方统一错误编号。
没有证明根因究竟是某个 Windows 配置、CLI 实现缺陷还是权限配置兼容问题。
更早出现过 `codex-windows-sandbox-setup.exe` 缺少模块弹窗；完全访问模式是避开其执行依赖，不是修复缺失模块。

### 1.2 已完成的基线能力必须保留

- 控制台身份可通过已有受控 file/keyring 路线复用；独立 `CODEX_HOME` 不接管用户的配置或旧会话。
- Chat 默认冻结全部兼容 Skill；副本完整性、总容量限制、整轮失败与清理已经实现。
- 原生话题失败不自动重试为无状态回答，也不把未送达的 child 会话作为后续 parent。
- 新 Chat Run 已保存有界、脱敏的工具执行与准备失败证据。
- Astra 的模型及 reasoning 配置已合入；双模式不应改写用户选择的模型。

## 2. 目标、范围与非目标

### 2.1 首版范围

- 同一 HomeAgent 安装保留两种显式执行模式，配置粒度为 **Agent 发布版本**。
- 新的完全访问模式首版只支持 **Codex 的普通 Chat 和显式 Task**；Windows 是必须实际验收的平台。
- 私聊／非话题 Chat 仍为一次性调用；仅符合现有路由规则的飞书话题使用原生会话。
- Task／WorkAction 仍遵守自己的执行前人工审批及结果验收规则。
- 管理页可完成选择、风险确认、发布、检测和撤销；不要求用户手工编辑配置文件。
- 类型与策略设计不写成 `win32` 自动放权分支；macOS/Linux 可以使用同一实现，但未经该平台验证不宣称已支持新模式。
- 默认 Provider 没有关联显式 Agent 时继续用受限路线；首版不增加全局自动完全访问开关。

### 2.2 不在首版内

- 不更换为 WSL、Docker、虚拟机或另一个 Provider，不全面迁移到 Codex App Server。
- 不把 Claude/TRAE 的行为、Dream、学习、定时后台分类或知识读取接口扩大为完全访问。
- 不为质量重评偷偷复制高权限；首版明确拒绝完全访问计划的重评，直到独立的高权限重评审批实现。
- 不自动导入用户全部 `.codex` 配置、Plugins、MCP、hooks、rules 或终端会话历史。
- 不自动开通飞书权限、给机器人加群，也不声称“全部 Skill”意味着全部飞书数据可访问。
- 不把有界审计改成完整命令／输出录制，不新增 embeddings 或知识数据外发接口。

## 3. 必须明确调整的产品契约

当前 [AGENTS.md](../AGENTS.md) 与 [CONTEXT.md](../CONTEXT.md) 要求共享话题的 Provider 文件访问也隔离。
完全访问模式无法兑现这个承诺。实现时必须显式修改相应契约，不能仅删检查、给测试特判或把报错转成成功。

建议的新契约：

> HomeAgent 在两种模式下都按授权的 Space 选择应用层检索、Raw、Knowledge page 和话题路由。
> 隔离模式额外要求 Provider 的操作系统级文件隔离检查通过。
> 本机完全访问模式只有在明确发布配置及有效本机确认后执行；它不提供 Provider 的文件与网络隔离，
> 因此不能保证 Provider 工具只读取当前 Space。页面、运行记录及操作文档必须持续明确这一差异。

这里的“只读取 Team Space”在完全访问模式下仅能承诺 **HomeAgent 主动提供的上下文与检索结果**。
Provider 执行的命令可能读取同一 Windows 用户有权限读取的其他目录、凭据与 Space；提示词和 Workdir 不是访问控制。
完全访问也不自动授予 Windows 管理员权限，实际权限不超过启动 HomeAgent 的进程身份及已有系统策略。

以下契约在两种模式下均保持不变：

- 数据始终属于一个 Space；应用层不得自动合并 Personal 与共享话题的 Team 数据。
- 原生会话首轮 start，后续 fork；成功原子提交与持久化送达后才推进 head。
- 模式、权限、Agent revision、模型、Workdir、Skill 等执行语义冻结；重试不偷换计划。
- `write`/`full` Task 在调用 Provider 前须有该 Run 的持久化正向人工审批。
- WorkAction 结果先 `held`，接受后才准入；拒绝、失败、取消结果保持 `excluded`。
- 原始凭据、命令正文、模型输入与原始诊断不进入公开错误、URL、日志或健康摘要。
- 正在运行的进程遇到应用重启时不重放；恢复、外发和重试的幂等规则保持原样。

新模式中的执行记录是操作审计，不是能够抵御同一账户下完全访问进程篡改的安全证明。

## 4. 模式与权限模型

建议固定枚举：

```ts
type CodexExecutionMode = "isolated" | "local-full-access";
```

字段统一使用 `executionMode`：Agent → AgentRevisionSnapshot → ProviderExecution → 冻结执行计划。
`ResolvedExecutionPlan.execution.executionMode` 为执行时唯一模式来源，避免另存一个可能不一致的顶层 mode。
读取历史记录与解析新配置必须分开；未知枚举拒绝，不能归一化为完全访问。

| 新 Codex 配置 | `read-only` | `write` | `full` |
| --- | --- | --- | --- |
| `isolated` | 允许；按调用类别使用现有受限策略 | 允许；工作目录可写，Task 要审批 | 拒绝，提示选择完全访问模式并确认 |
| `local-full-access` | 拒绝，不能伪装为系统只读 | 拒绝，不能伪装为仅工作目录可写 | 允许，但必须满足本机确认与具体调用的审批要求 |

这张矩阵约束首版的新 Codex Chat/Task 配置，不重定义其他 Provider 的权限。
`isolated` 不是给所有普通调用新增 exact root-deny：普通受限调用维持基线；原生话题及其内部路由仍须满足原有精确隔离。
页面必须说明差异，不能把普通 `workspace-write` 描述为已验证的 Team-only 文件读取。

### 4.1 发布与生效

1. 草稿可以保存模式选择，但不产生执行授权，也不影响已有发布版本。
2. 切到完全访问时，页面显式展示权限将变为 `full`；保存字段必须与页面一致。
3. 发布前显示 Workdir、模型、受影响的绑定 Space／群与响应策略。群成员消息触发本机执行的含义必须出现。
4. 用户勾选“允许该 Agent 以 HomeAgent 运行账户权限执行，可能访问工作目录外文件和网络”后，提交带防陈旧令牌的发布请求。
5. 服务端验证模式矩阵、已安装 Provider、目录、确认凭据与当前草稿 head，原子保存发布版本和本机确认。
6. 下一条新请求采用新版本；旧 Run 的重试仍用旧计划。UI 提供“按当前配置新建运行”，不得把它叫作原 Run 重试。
7. 回滚到历史完全访问配置也必须新建发布版本并重新确认，历史确认不能直接复活。

切回隔离模式时让用户明确选择 `read-only` 或 `write`，并重新检测。不会为了切换成功而自动改权限或停止报告隔离失败。

### 4.2 本机确认与撤销

推荐在 AgentStore 的同一个原子状态文件中增加独立的、本机专属确认集合，**不放入可导出的 AgentRevisionSnapshot**。
这样发布版本与确认可以一起提交，不产生“页面说已发布，但授权未落盘”的中间状态。Core 拥有此状态，Web 只调用公开 Interface。

确认记录至少包含：版本、随机 ID、Agent ID、发布 revision ID、确认条款版本、确认时间、来源类别与撤销状态。
另保存已确认的 `chatScopes`（Space ID 与该绑定的执行策略摘要）和 `taskExecutionEnabled`；不保存群名或消息正文。
来源由服务端填充为本机操作者或已认证管理会话，不从客户端接受任意 `decidedBy`，也不伪造 Windows SID／个人身份。
所有字段使用枚举／有界字符串；时间为非负安全整数；ID 有固定格式；每个 Agent 最多保留 100 条确认，
整个集合最多 10,000 条；每条最多 256 个 Chat scope，去重且按 Space 排序；scope 摘要为固定长度 SHA-256。
确认集合按紧凑 JSON 编码为 UTF-8 后另设 16 MiB 总上限，计数或字节任一超限均拒绝候选写入，读取时在逐条解析前校验。
仍被非终态 Run 引用的确认不能被淘汰；没有持久化 Run 的预检/问答/客户端在途调用同样保护其引用，直到整个调用结束。
只在发布触及上限时按确认时间从旧到新清理；当前与候选发布版本、新确认均保留。清理和发布使用同一原子提交，不另写一个先删除授权的事务。
无可清理项或引用状态未知时拒绝新发布并明确原因。已淘汰确认的旧终态 Run 仍可查看，但不能靠历史引用恢复授权。

冻结计划保存本机确认的 ID（例如 `localExecutionGrantId`），但授权判断必须读取 Core 的实际持久化记录并匹配 revision。
仅有某个 ID、历史 `full` 字段或 UI 勾选值均不算获得授权。

- 执行前重新检查确认未撤销；这是撤销检查，不是拿最新 Agent 配置替换冻结计划。
- 修改 instruction、模型或其他字段后产生的新完全访问发布版本，每次重新确认，减少确认复用规则。
- 模式切回隔离或点击“撤销完全访问”时，原子撤销该 Agent 尚有效的完全访问确认；旧 queued/retry Run 固定失败，不降级。
- 对已经开始的 Run，撤销后发出已有取消信号并展示结果；新调用不得再开始。不能承诺已执行的命令或外部副作用会被回滚。
- 删除 Agent 时同样停止后续完全访问调用；孤立的旧确认引用不能继续授权。
- 普通版本更新若仍为完全访问且未撤销旧确认，旧队列可按旧计划继续；页面清楚列出尚在使用旧版本的 Run。
- 确认不会随 Space 归档转移。整份本机数据目录复制不是 Space 导出，可能包含本机授权状态；首版不能宣称能自动识别所有跨机复制，应要求迁机后重新确认，并在操作说明中标明这一限制。

本机确认授权的是已展示的 Agent 自动响应范围，按以下固定规则执行，不能只实现页面勾选：

1. 发布完全访问 Agent 时，Core 从实际 Space/飞书绑定状态生成 `chatScopes`。策略摘要覆盖 Space、Agent、绑定 Bot App、chat、响应模式、参与等级及下面定义的持久化 epoch；排除探测时间、送达计数等无关运行字段。私聊 scope 使用 Personal Space 与 Agent 绑定，不伪造群字段。
2. 新绑定或执行策略变化先按现有管理流程落盘。新范围不在旧确认内，因此只影响该范围的完全访问 Chat 显示“绑定已保存，等待本机确认”，Provider 不启动；已有仍匹配的范围不受影响。
3. 页面提供“确认更新范围并发布”，展示当前完整范围，重新确认并生成新 revision 与对应确认。发布时校验范围摘要未变；若绑定写入成功但发布失败，保持待确认，不宣称执行已启用。
4. 无需给两个状态文件虚构原子事务：绑定写入与授权发布按上述顺序处理，实际可执行条件永远是“当前绑定有效且精确匹配持久化确认”。任何中间失败都不能扩大可执行范围。
5. 冻结 Run 保存自己使用的 scope 摘要；排队与每次 Provider 启动前都验证当前触发 Space／绑定、冻结 scope 和实际确认记录三者匹配。绑定断开或变化后旧 Run 停止，不偷换为新范围。
6. 群内启用命令、自动发现、已有 `AgentStore.update` 或恢复路径不能生成本机确认。Core 的统一授权门禁覆盖这些入口，缺少确认时仅保持待确认状态。

为让规则简单可测，首版任何上述执行策略字段变化（包括缩小范围）都重新确认，而不实现权限集合的大小比较。
仅对内容做 hash 不足以阻止 A → B → A 恢复旧确认，必须引入不可复用的范围版本：

- `SpaceMeta.agentBindingEpoch`：Agent 绑定改变、清空、Space 重建或导入时生成新的随机 UUID；Registry 中 chat、回复模式、参与等级变化也轮换，以防仅修改 Registry 后 A→B→A 复用旧确认。名字／维护时间变化不更新它。
- `FeishuGroupBinding.executionScopeEpoch`：绑定 Bot／chat／响应策略变化、断开后重连、删除后重建时生成新的随机 UUID；单纯健康检测不更新它。
- 群 Chat scope 同时包含两者，私聊 scope 包含 `agentBindingEpoch`。任何内容改回原值都使用新 epoch，不恢复旧值。
- 正常同机重启保留 epoch；Space 导入重新生成且不从归档接受旧 epoch。legacy 缺失时只在受控迁移中生成，不将旧完全访问确认与它自动关联。
- epoch 和对应绑定变化在所属状态文件中一起原子提交；写失败不得替换内存。新增 epoch 的 Registry 持久化必须采用候选校验、fsync、原子替换与深克隆，不能沿用直接覆盖文件来保存授权关联。

Task 不按 Chat scope 自动授权：发布时明确确认 `taskExecutionEnabled`，每个 Task 的目标 Space／所有权仍由该 Run 的正向人工审批决定。
新范围发布会产生新 Agent revision，因此已绑定话题下一次请求都可能新建会话；页面预告这一行为。

### 4.3 Workdir 与 Task

完全访问模式要求显式、存在且 canonical 的 Workdir；拒绝 HomeAgent 数据根或独立 Codex 状态目录的父子重叠。
这是减少误操作与维护冻结契约，并不限制进程读取别处。继续拒绝路径逃逸、junction/symlink 替换，以及冻结后目录变更。
隔离只读话题未提供 Workdir 时，仍使用已有调用专属空目录。

Task／WorkAction 的审批卡同时显示模式和权限；本机确认不能代替每个 `full` Task 的人工审批。
Task 通过审批后仍须在实际 Provider 调用前重新验证目录与本机确认；两者失效均停止执行。
取消、超时、审批过期、所有权、预算观测与结果验收继续沿用已有逻辑。

## 5. 模块职责与调用路线

把差异集中在 LLM 的执行策略 Module，通过小的 Interface 供能力检测、预检与真实执行复用。
Core 负责“谁授权了这个冻结 Run”，LLM 负责“这个模式怎样映射为 Codex 参数及探测”；不要让 Web 自己拼 CLI 参数。

```text
管理页草稿 + 明确确认
  → Core 原子发布 Agent revision + 本机确认
  → Core 冻结 Run 执行计划、Skill、确认引用
  → 执行前：计划／目录／确认／Task 审批校验
  → LLM 共用准备：身份、版本、Skill 副本、工具配置
      ├─ isolated：原生话题构造 exact profile + 沙箱证明
      └─ local-full-access：显式 full 参数，沙箱证明不适用
  → 临时路由调用 + 原生 start/fork 最终回答
  → 原子保存 Run 结果和 child → 外发 → 持久化 sent → head 可复用
```

### 5.1 建议的代码落点

| Module／文件 | 责任与需要检查的现有入口 |
| --- | --- |
| [LLM providers](../packages/llm/src/providers.ts) | `ProviderExecution`、`RunInput`、`preflightProviderNativeSession`、`runProviderDetailed`、Codex `buildRun`、能力检测与隔离辅助函数 |
| 新 `packages/llm/src/codex-execution-policy.ts` | 纯策略选择及参数约束；只有存在重复分支时抽取，避免新建大型通用 Provider 框架 |
| [Provider preparation](../packages/llm/src/provider-preparation.ts) | 有界模式／确认相关原因；保留既有 73/74/75 的含义 |
| [Execution evidence](../packages/llm/src/execution-evidence.ts) | 记录实际准备的模式、沙箱检查适用性、使用参数的类别；不存原始命令 |
| [Agents](../packages/core/src/agents.ts) | 配置与 snapshot、create/update/saveDraft/release/rollback、同状态文件中的本机确认、迁移与克隆 |
| [Execution plan](../packages/core/src/execution-plan.ts) | 新旧计划版本、字段验证、克隆、模式矩阵与确认引用 |
| [Engine](../packages/core/src/engine.ts) | `agentRunExecutionSnapshot`、`executionPlanCallContext`、原生验证、Task 审批执行、撤销后取消与重试门禁 |
| [CLI client](../packages/core/src/cli-client.ts) / [types](../packages/core/src/types.ts) / [usage](../packages/core/src/usage.ts) | 传递冻结模式与准备证据，不在代理／回调层丢字段 |
| [Chat runs](../packages/core/src/chat-runs.ts) | 可恢复计划、模式兼容摘要、head 迁移、本机证据、导出剥离 |
| [Task runs](../packages/core/src/task-runs.ts) | 冻结计划、审批、queued/retry/recovery、历史全权限迁移 |
| [Feishu bindings](../packages/core/src/feishu-bindings.ts) / [Governance](../packages/core/src/governance.ts) | 绑定语义摘要与待确认判定、归档 DTO/版本/恢复；执行确认只由 AgentStore 持有 |
| [Space registry](../packages/core/src/registry.ts) | 持久化 Agent 绑定 epoch；将承载授权关联的 metadata 写入改为校验后的原子提交，不改变 Raw/Wiki 所有权 |
| [Orchestrator](../packages/orchestrator/src/runtime.ts) / [messages](../packages/orchestrator/src/messages.ts) | 各 Chat 入口、能力错误、无降级、最终送达；模式切换不隐式重试 |
| [Agent workbench](../packages/web/src/agent-workbench.ts) / [view](../packages/web/src/agent-workbench-view.ts) | 双模式编辑、确认、绑定影响、按模式就绪状态 |
| [Web app](../packages/web/src/app.ts) / [views](../packages/web/src/views.ts) | 发布／撤销／恢复端点、运行详情、重评拒绝、防陈旧与跨站请求验证 |
| [App root](../packages/app/src/main.ts) / [health](../packages/app/src/health.ts) / [Codex setup](../packages/app/src/codex-setup.ts) | 依赖装配、聚合健康、仅显式操作触发沙箱设置 |
| [Runtime data](../packages/app/src/runtime-data.ts) | 新本机状态随同机迁移的处理；不手工修改已运行的数据目录 |

跨包只扩展公开导出；必要时同步 `packages/llm/src/index.ts` 与 `packages/core/src/index.ts`。
Core 不依赖 Web/App；LLM 不读取 Core 的 AgentStore；装配留在 App。

### 5.2 可测试的策略 Interface

可用以下判别联合表达策略输出；这是设计示意，不要求逐字照搬文件／函数名：

```ts
type CodexExecutionPolicy =
  | { mode: "isolated"; filesystemProof: "required" | "not-native" }
  | { mode: "local-full-access"; filesystemProof: "not-applicable" };
```

输入应包含已经验证的冻结 execution、调用类别及原生话题请求；纯选择阶段不创建进程。
身份选择、Skill 准备、取消、输出解析和清理由两种策略共享，不复制两套 `runProviderDetailed`。
`nativeSessionIsolation` 目前同时表示“这是话题内部调用”和“必须隔离”；实现时将这两个含义拆开或明确重命名，
确保话题内部路由在完全访问模式下仍能拿到同一冻结策略，而不是因没有 `nativeSession` 就走错分支。

撤销检查精确到 **每次实际启动 Provider 模型调用**，不是整个 Run 只查一次。
Core 提供启动许可的内部 Seam，与撤销共用按确认 ID 的串行控制；许可检查到子进程注册取消句柄之间不可插入成功撤销。
LLM 通过注入的启动许可回调使用该 Seam，不读取 Core 存储、不独立相信客户端传入的确认 ID；锁不持有到模型回答结束。
若撤销先提交，后续 routing/final 均不得启动；若进程先注册，撤销会取消它。撤销失败未落盘时不向用户宣称成功。
一次 routing 后发布新的 Agent 不改变后续 final 的冻结输入；routing 后撤销确认则 final 不启动。

## 6. Codex 参数、身份和能力探测

### 6.1 共用部分

两种模式都继续使用已有独立 `CODEX_HOME` 与受控 file/keyring 身份复用。
身份可用、原生命令支持、模式就绪是不同结论；无需为了新模式让用户再次登录。

继续保留：

- `exec` 后的 `--strict-config`、`--ignore-user-config`、`--ignore-rules`、`--json`。
- `project_doc_max_bytes=0`、环境变量白名单、关闭 ambient hooks/Plugins/自动 Skill 发现及其他既有受控配置。
- prompt 经 stdin；argv 不含正文、凭据或原始诊断；JSON schema／结果文件和图片走现有受控机制。
- 每轮冻结 Skill 副本、内容摘要复验、完整映射与清理；128 MiB／200,000 条目总上限以及每 bundle 16 MiB／50,000 条目不变。
- 原生 fork 命令与最低版本检查。首版沿用基线最低 `0.152.1`，不因关闭沙箱就降低要求；实际参数仍须核对本机 `--help`。
- 原生调用有效 MCP 严格为空；新的完全访问模式所有调用都验证为空，包括非话题 Chat/Task。完全访问不等于同意导入未冻结工具；放开 MCP 是另一项设计，不在此次范围。
- 管理员托管配置仍然有效；不允许通过忽略、覆写或删除企业策略强行启用完全访问。

### 6.2 两种策略的差异

| 项目 | `isolated` 原生话题 | `local-full-access` |
| --- | --- | --- |
| 文件系统策略 | 原有 `:root=deny` 与精确允许目录 | `exec --sandbox danger-full-access` |
| Codex 执行确认策略 | 保持已有 `approval_policy="never"` | 显式 `approval_policy="never"`，用户已确认无人值守执行 |
| filesystem sentinel probe | 必须执行且全部通过 | 不构造／不执行；证据为 `not-applicable`，不是 `passed` |
| Windows sandbox setup | 只在操作者明确要求时运行 | 不作为该模式前置条件，不因刷新页面自动启动 |
| 身份／版本／fork／MCP 检查 | 必须 | 必须 |
| 路由/分类调用 | 原生话题的同一精确 profile，ephemeral | 原生话题的同一完全访问模式，ephemeral |
| 最终话题回答 | start/fork，不加 ephemeral | start/fork，不加 ephemeral |
| 私聊／非话题／Task | 按基线的一次性调用契约 | 仍 ephemeral，不引入共享历史 |

`--sandbox` 会覆盖旧的权限 profile 选择，完全访问分支应主动不构造 root-deny 参数，而不是同时传两种互相矛盾的配置。
不使用全局环境开关让任意 `permission=full` 自动绕过所有校验。
官方也提供合并跳过确认与沙箱的 CLI flag，但实现优先使用显式 sandbox 与 approval 配置，方便审计及测试。

### 6.3 不要用一个布尔值表示全部能力

现有 `DetectedProvider.nativeSessions` 由隔离探测产生，旧调用者会把它解释为“原生隔离可用”。
过渡期保留这一旧含义，并新增按模式的结构；更新所有消费者后再决定是否移除旧字段。

新结构至少区分：

- CLI／身份状态。
- 原生命令支持状态。
- 当前模式的准备状态：ready / unavailable / unknown。
- 沙箱证明：passed / failed / not-applicable / not-checked。
- 固定原因码与检查时间；有界且不暴露 paths、server 名或 stdout/stderr。

主机命令能力与每个 Agent 的确认、Workdir、Skill 状态分开：机器支持完全访问，不代表每个 Agent 已获准运行。
按模式和实际执行上下文缓存；隔离模式的 `75` 不得污染完全访问缓存，完全访问就绪也不能覆盖隔离失败。
缓存命中不代替执行前的授权、路径、Skill 复验。新模式不能设置 `nativeSessions=true` 来欺骗旧消费者。

对于选择完全访问的 Agent，页面加载、刷新、预检和运行均不应触发沙箱 setup／探针。
用户明确点击“检测隔离能力”时可以单独检查隔离模式，不改变已发布模式。

启动时全量 Provider 检测也遵守按需原则：先探测共用命令／身份，再根据实际启用的工作流安排对应模式检查。
`/healthz`、`/readyz` 与聚合健康读取有界缓存，不为填充旧 `nativeSessions` 布尔值同步启动隔离探针；
未请求的隔离能力保持 unknown/not-checked。另一个已启用的隔离工作流需要探测时，应标明来源且独立调度，
它的失败不触发完全访问模式回退，任何检测都不得自动发起 sandbox setup。

`/healthz` 仍是存活检查；`/readyz` 按所需能力及现有组件健康判定，不把一个未选模式的失败当作全局阻断。
当前策略：所需 Agent 的已知准备/确认失败阻断就绪，unknown/过期/checking 只降级提示，不因未执行手动诊断而单独阻断。`ready=true` 不是实际模型或每个执行配置已验证。
但 Dream／后台学习等仍走受限路线，若它们另有沙箱故障，不能被前台完全访问模式掩盖；此模式不承诺整机所有流程可用。

## 7. 冻结计划、话题与治理

### 7.1 冻结模式

建议 `ResolvedExecutionPlan` 增加 v2。v2 的 Codex Chat/Task execution 必须显式带 `executionMode`。
完全访问计划还须带有界本机确认引用；在 Core 排队前及实际执行前验证其对应的 revision。
Provider 不从页面、当前 Agent、环境变量或上一轮会话反推 mode。

统一审计所有传播路径：普通 Chat、私聊、飞书话题、Task、WorkAction、内部 routing、取消、重试、恢复、质量重评、
Agent revision、clone、持久化 validator、Space 归档 parser 与 compatibility hash。
质量重评首版遇到完全访问计划时应给固定原因并停止，不得按当前模型改造成一次受限调用，也不能无人确认启动高权限执行。

### 7.2 话题兼容性

将模式、策略版本和本机确认 ID 纳入已有执行计划兼容摘要；建议 topic compatibility version 从 1 升至 2。
完全访问计划中的冻结 Chat scope 摘要也参与兼容计算。
同一模式内，既有 revision／model／permission／Workdir／Skill 变化触发新链的规则保持不变。

必须满足以下案例：

| 事件 | 后续行为 |
| --- | --- |
| 第一次完全访问话题回答 | start，成功并送达后才有可复用 head |
| 完全访问模式连续追问，兼容计划不变 | 从最近成功且已送达的 head fork |
| `isolated → local-full-access` | 新链；不 fork 旧隔离会话 |
| `local-full-access → isolated` | 新链并重新通过隔离检查；不把全权限历史带回隔离链 |
| 隔离 → 完全访问 → 原隔离配置 | 仍是新发布版本／新链，不复活早先被替代的历史链 |
| 仅重启同一个安装、计划与确认均未变 | 使用已提交且已送达的兼容 head；不重放 running Run |
| 探测失败／模型失败／取消／超时 | 不推进 head，不自动切换模式或做无状态重试 |
| 外发失败／外发成功但 sent 未持久化 | child 不作为下一轮 parent；继续沿用幂等外发恢复规则 |
| 父会话缺失、静态控制回复、撤回、Space 删除 | 按既有治理规则失效；不能从 prompt 重建旧历史 |
| Space 导入／受支持的跨机恢复 | 不导入原生 session ID；首次回答重新 start；原始目录复制的限制见第 8 节 |

旧 head 的迁移及兼容摘要升级必须保留历史 Run 审计；可以一次性失效旧 head 并提示升级后首轮无旧上下文，
不能因为新 parser 不认识旧映射而导致整个 ChatRunStore 无法启动。
已失败 Run 的“原计划重试”与“新配置新请求”是不同操作，页面和测试都要区分。

### 7.3 应用层数据归属

共享话题的检索与主动拼接上下文仍只读已路由的 Team Space。
完全访问模式不自动把其他 Space 加入提示词、不开放新的跨 Space HTTP 查询，也不绕过已撤回 Raw 的治理检查。
Provider 直接使用文件／网络工具的实际访问范围无法由这些应用层规则保证；运行页必须说明这一限制。

## 8. 迁移、归档与回退

基线的格式：Agents 文件 v4、ResolvedExecutionPlan v1、ChatRuns 文件 v6、TaskRuns 文件 v12、topic compatibility v1、Space 归档 v19。
基线中的 Feishu bindings 为 v2，Space Registry 是未带 version 的对象；已分别升级为 v3 与有版本的 v1，并保留旧格式读取。
实施前再次从 parser／writer 核实版本；不要只修改常量而漏掉旧格式读取、备份与恢复。

建议升级：Agents v5、计划 v2、ChatRuns v8（v7 先用于 P1 的执行证据扩展）、TaskRuns v13、topic compatibility v2；Space 归档若新增模式等可移植字段，升级至 v20。
这些是本设计建议，若接手基线已占用版本，使用下一个版本并同步本文及实际文档。

| 旧状态／输入 | 迁移与执行规则 |
| --- | --- |
| 无 mode 的旧 Codex `read-only`／`write` Agent | 语义按隔离路线解释，不自动打开新模式 |
| 无 mode 的旧 Codex `full` Agent | 显示“旧完全访问配置，需重新确认模式”；不自动生成确认或改成 write |
| 已完成旧 Run | 保留原冻结计划与历史事实，模式显示 legacy/unknown；不补造新模式确认或沙箱通过证据 |
| 旧 queued／retry Codex `full` Run | 即使有旧 Task 审批，也不推断获得新模式确认；停止并要求操作者用明确模式重新创建 Run |
| 旧 queued `read-only`／`write` Run | 通过专门旧格式兼容路线保持原语义；实际调用仍重新验证，不替换当前 Agent |
| 升级时已 running Run | 记录中断结果，不重启同一个进程 |
| 来自归档的完全访问 Agent | 可以保留模式意图，但没有本机确认，因此不能执行；本机重新确认并发布新 revision |
| 旧 `awaiting_approval` Codex `full` Run | 保留待批准的历史事实，但新版本不允许批准后直接执行；标为需要新模式确认并重新创建运行 |
| 未知 mode／未来 schema／畸形确认 | 拒绝或保持不可执行状态，不降级到某个更宽松模式 |

迁移时不要为了凑 v2 给旧计划逐项补入当前默认值，导致原兼容摘要、历史 fingerprint 或 Task 审批语义被改写。
旧 snapshot 的不可变内容与其当时格式一起读取；新发布／新 Run 才使用新格式。
旧普通 Codex `full` Task 也需要重新确认，这是显式的兼容性变化：实施时在 README 和升级提示中单独写出。
其他 Provider 的旧 `full` 行为不因本设计被重分类。

本机确认集合、确认 ID、原生计划/head/session ID 和私人执行证据均不进入 Space 归档。
冻结 scope 摘要也是本机授权关联，不随归档导出；恢复时从当前有效绑定重新生成。
Space/飞书绑定 epoch 同样不从归档复用。
归档中可保留 executionMode 作为历史／配置意图。为此需要明确 archive DTO，而不是删完字段后再让本机可执行计划 validator 勉强通过。
恢复出的 terminal Run 可展示历史意图；任何再次执行必须重新走本机授权与计划校验。未知高权限历史不伪造批准。

持久化继续使用候选状态校验、同目录临时文件、fsync、原子替换、成功后替换内存。
发布／撤销、备份恢复、Space 导入失败都需注入故障验证；旧目录与旧备份不删除。

### 8.1 不同恢复路径的授权处理

| 路径 | 确认与会话处理 |
| --- | --- |
| 正常同机重启，主文件有效 | 保留有效确认与兼容且已送达的 head；逐次调用仍重验 |
| 同机受支持的数据目录迁移 | 先 stage/verify；冻结 Workdir 与身份不变时可保留本机确认，仍重新验证路径与当前 CLI；兼容摘要改变则新链 |
| AgentStore 主文件损坏而读取 `.bak` | 备份可能早于撤销；恢复的完全访问确认全部失效，必须重新确认发布，不自动以备份中的 active 为准 |
| 产品明确执行的同机备份恢复 | 先使恢复出的完全访问确认失效，再开放接收新任务；新 revision 不复用旧完全访问 head |
| Space 导入或受支持的跨机恢复 | 不恢复本机确认与原生 head，按当前机器重新确认和 start |
| 用户直接复制／覆盖整份数据目录 | 首版无法可靠识别有效旧主文件来自回滚或另一机器；可能带入确认和 CLI 历史，必须人工撤销并重新确认，不宣称自动保护 |

自动 `.bak` 恢复须在恢复候选中标记确认失效，原子持久化成功后才能使完全访问运行可调度；落盘失败时阻断该模式，不能先执行再补写。
恢复出的非终态完全访问 Run 记录固定的授权失效失败／取消原因；不隐式重建新 Run，不改变其冻结计划。
已完成历史保持可读，受限运行遵守各自原有恢复规则。这项处理防止“撤销成功但备份刷新失败，随后从旧备份恢复”复活授权。
上述保证不适用于用户绕过产品直接覆盖全部状态的情形；没有新的外部防回滚信任根，不能声称能检测所有回滚。

代码回退时，不承诺旧版本能读取新 schema。保留升级前备份，先停止实例后采用项目支持的恢复流程；
旧程序面对未来版本应拒绝启动而不是覆盖数据。不要对 live data 手工改版本号。

## 9. 页面、错误与证据

### 9.1 页面文案

- 模式选择：“隔离模式（默认）”／“本机完全访问（无沙箱）”。
- 隔离失败：“CLI 已连接；原生话题隔离未通过：受保护目录仍可读取。”提供检测、具体原因及另一模式的说明入口，不自动切换。
- 完全访问未确认：“配置已保存，尚未确认并发布；当前运行仍使用已发布版本。”
- 完全访问准备通过：“本机完全访问已就绪 · 未启用沙箱；尚未验证实际模型调用。”
- 完全访问实际调用通过：“原生会话已验证 · 本机完全访问 · 未隔离”。
- 原生能力不足：“当前 Codex 版本／fork 能力不满足要求”；不建议重新登录来修复版本。
- 管理员策略拒绝：“机器管理策略不允许该执行模式”；不提供绕过管理策略按钮。
- 撤销后旧重试：“该冻结运行的完全访问确认已撤销，请按当前配置新建运行。”
- 新增／变更绑定：“绑定已保存，该范围的完全访问执行等待本机确认并重新发布。”

可用与否应基于当前已发布配置，不用未发布草稿替代实际状态。
不要在成功回答后反复附加“本轮丢失话题上下文”的旧降级文案。切模式产生新链时用一次性明确提示解释上下文变化。
成功状态不能暗示登录、模型、飞书权限、后台所有流程均已验证。

### 9.2 准备与执行证据

在既有有界 `ExecutionEvidence` 上新增固定元数据或等价字段：

```text
executionMode = isolated | local-full-access
sandboxCheck = passed | failed | not-applicable | not-checked
effectiveSandbox = permission-profile | read-only | workspace-write | danger-full-access
```

这是 HomeAgent 实际选定／启动的参数证据，不是根据模型回答文字推断的事实。
模式选择未完成时保持 unknown／字段缺失；只有通过了对应校验才写 passed。
准备失败即使没有 Codex JSONL 输出也应持久化。可新增固定原因：
`execution-mode-invalid`、`local-execution-consent-required`、`local-execution-consent-revoked`、`managed-policy-disallows-mode`。
只有能从结构化或可靠有界诊断判断时才使用精确托管策略原因；其余保留通用进程失败，避免字符串猜测。

Web 详情显示模式、权限、确认状态、Provider 进程启动状态及原生 start/fork 类型。
只有收到可验证的模型事件／结果才显示模型调用已验证；仅启动 CLI 不等于已调用模型，缺少证据时保持未知。
确认 ID／revision 关联只在私有运行审计中使用，不进入群通知、公共健康摘要或 Provider prompt。
保留已有事件／调用数量限制与未知、截断状态，不记录 token、SID、用户名、命令、资源名或 stdout/stderr。

### 9.3 管理操作

复用现有管理认证及跨站写请求拦截，但对新增完全访问发布／撤销动作再测试 Origin、Host、转发头与旧表单 head。
页面发起显式 POST；GET 检测不生成授权。客户端勾选不算服务端身份；Bot 消息、模型输出、Skill 不能直接授予本机确认。
发布写失败时版本与确认均不生效；撤销先落盘再阻断新调用／发送取消，重启后仍保持撤销结果。

## 10. 保留与替代方案的取舍

本设计选择“显式完全访问作为可选路线”，不是宣称 Windows 无法实现隔离。
官方推荐 Windows 原生 elevated，unelevated 只是能力较弱的备用实现；某些细分读取策略不能执行时仍会被拒绝。
以后找到可验证的隔离修复时，可继续使用原有模式，不必移除完全访问模式或迁回另一套会话架构。

- 只删除 `75` 检查：页面与真实权限不一致，拒绝。
- 隔离失败自动改 full：改变冻结计划与操作者授权，拒绝。
- `full` 与 root-deny 同时传参：可能由参数优先级掩盖真正模式，拒绝。
- 降级无状态回答：损失用户明确要的原生话题能力，拒绝。
- 只更换 Codex 可执行文件或重装：此前几种入口同样失败，不能作为已验证修复。
- 全面接管用户 `.codex` 或迁移 App Server：范围大，无法自动解决操作系统文件隔离，不作为前置工作。

## 11. 文档与既有契约同步清单

实现 PR 必须同步：

- [AGENTS.md](../AGENTS.md)：将共享话题操作系统文件隔离要求限定于 isolated，补充明确的完全访问例外及冻结／授权条件。
- [CONTEXT.md](../CONTEXT.md)：解释模式、本机确认、应用层 Space 选择与系统文件隔离的差异；标明新本机状态所有权。
- [README.md](../README.md)：双模式 UI、配置生效、旧 full 升级、Task 审批、作用范围与不支持能力。
- [Agent CLI 排障](troubleshooting/agent-cli.md)：75 仍表示隔离失败；启用另一个模式不是“沙箱已修好”。更新原来的无条件 full 禁止说明。
- [Beta runbook](beta-release-runbook.md)：双模式独立门禁、Windows live 最小验证、支持平台回归、归档／旧状态升级。
- 发布／CI 定义：若新增可自动化门禁，按现有流程加入；不能把 Windows fake 测试替代支持平台或真实飞书门禁。

只改本设计时，不修改上述文件的当前行为描述。实现生效后再同步，并将本设计标成已实施或记录仍未完成的部分。

## 12. 分阶段实施与完成条件

### 当前工作树实施记录（2026-09-14）

已落地的第一批代码：

- P0：AGENTS 工程契约明确完全访问例外；没有将此例外套用到旧 `full`、Dream 或默认 Provider。
- P1：`codex-execution-policy.ts` 集中选择权限/profile；`runProviderDetailed` 与原生预检复用，显式 full 不创建 sentinel 或启动沙箱 probe，仍检查版本、fork、严格空 MCP、file/keyring 身份与完整冻结 Skill。
- `nativeTopic` 表示话题调用类别，独立于执行模式。Core 的路由和最终调用传递此字段；LLM 暂保留旧 `nativeSessionIsolation` 作为兼容别名，不再让它选择执行模式。
- LLM 要求内部 `acquireExecutionPermit`，已连接 Core 确认集合；异步准备结束后同步获取许可、启动并注册取消，等待输出前释放。缺少回调或回调未返回有效许可均拒绝 full，不能把测试许可当作产品授权。
- 完全访问在取得许可后重新核对 Workdir 的 canonical 路径与文件身份、私有 Skill 根与内容；失败不启动模型，取消会解除注册并清理副本。
- 执行证据加入模式、sandboxCheck、effectiveSandbox、进程及模型验证状态；页面显示“不适用（未启用沙箱）”，旧记录不补造证据。公开错误只映射固定原因。
- Chat 新写入格式升级至 v7，以免旧程序将新执行证据当作无效数据丢弃；新程序读取 v1–v7，保留 v6 的已送达话题会话，未来未知版本明确拒绝。没有手工改动运行中数据。

P2 的已落地数据契约：

- Agent／revision snapshot 保留显式模式并校验权限矩阵；旧缺失模式的快照不补默认字段。新建/更新 Codex `full` 必须显式选择模式；不改变其他 Provider 的 full。
- Agents 新写入 v5，读取兼容旧格式；`localExecutionGrants` 与 Agent 分开保存。release／rollback 必须传当前 head 与本机确认，原子产生新版本和确认。create／update／draft／restore 不生成确认。
- 支持撤销全部有效确认；切回隔离原子撤销旧版本确认，删除 Agent 移除确认，回滚 full 重新确认。正常重启保留有效确认；从 `.bak` 恢复必须先持久化撤销，否则构造失败。
- grant 字段、唯一 revision、空间类型、数量／字节、scope 格式／排序／去重、深克隆均有校验；发布复用 LLM 的 Workdir 检查。P2 初版超限拒绝；后续 Core 已接入按真实非终态 Run 与临时调用引用的安全清理，详见下文。
- Space 归档新写入 v20、兼容 v1–v20；保留 Agent 模式意图与历史，但不携带确认集合或 ID。Agent／revision 元数据按明确字段克隆，额外字段不能夹带确认。新目录恢复无本机授权。
- Registry 新写入 v1、飞书绑定新写入 v3：候选校验、同目录临时文件、fsync、原子替换后更新内存。旧文件迁移时生成 epoch；重启保留；解绑/重连、策略 A→B→A、Space 重建/导入不复用。Registry/绑定数量各限 10,000，紧凑 JSON UTF-8 各限 16 MiB，并拒绝本机状态路径重定向。
- `LocalExecutionAuthorizations` 从真实 Space/有效飞书绑定计算最多 256 个范围；Personal 不混入群字段。`preview` 返回摘要，`release/rollback` 校验当前摘要及 Agent head 后发布，HTTP 不能传入任意 scopes。绑定写入成功而发布失败时保持未确认。
- Engine 新建计划为 v2：`localExecution={grantId,kind:"chat",scope}` 或 `{grantId,kind:"task"}`；没有有效确认、绑定变化或无工具的后台调用不生成授权引用，记录固定的解析失败。Task 本机确认不替代该 Run 的人工审批。
- 新 Run/恢复读取校验调用类别及 Chat Space。旧计划 v1 保持原形，旧头使用 compatibility v1；新计划使用 compatibility v2，模式、确认 ID、scope 参与摘要。成功且已持久化 sent 的 head 才可续用。
- Space 归档为新 v2 计划生成 `ArchivedExecutionPlan`（`archiveVersion=1`），保留模式意图但剥离确认 ID/scope；epoch 不导出。该 DTO 只能用于终态历史，执行、重试、重评入口拒绝；旧 v1 历史计划原形保留。
- 当前格式为 **Agents v5／Plan v2（读 v1）／Chat v8（读 v1–v8）／Task v13（读 v2–v13）／Bindings v3（读 v1–v3）／Registry v1（读无版本）／archive v20（读 v1–v20）**。运行文件损坏、未来版本或新格式无效记录拒绝启动，不能静默覆盖为空历史。

消费者盘点与后续归属：

| 类别 | 已核对的消费者 | 后续责任 |
| --- | --- | --- |
| 共用检查 | LLM 身份、fork/MCP、Skill staging、取消和解析；Core CLI client | 两模式共用；许可只传给模型调用，不传给探测 |
| 模式策略 | LLM buildRun／preflight／run、Core nativeTopic | 两路线已接通；full 不执行隔离专属 Skill 源目录重叠检查，仍冻结/校验完整 Skill 并私有 staging |
| 本机授权 | AgentStore create/update/draft/release/rollback/restore；Engine Chat/Task/重评；Registry/Bindings | 逐调用门禁、提交后取消、非终态 Run/临时调用引用安全清理均已落地；无安全候选时仍拒绝 |
| 历史展示 | execution-plan clone/validator、Chat compatibility、Task 审批、governance archive、Run 页面 | 旧 full/失效确认的队列和待审批明确停止；重试不换当前配置，高权限重评拒绝 |
| 按模式就绪 | detectProviders、AgentReadiness、workbench/view、Web 恢复端点、App health | 默认只查命令/身份；逐 Agent 无模型检查、失效键、历史展示与只读健康汇总已接通 |

P3 已落地：

- Chat（含私聊/普通调用）、Task、内部 routing 与最终回答共用 Core 授权门禁。注入的客户端也不能跳过入口检查；实际 CLI 准备完成后再同步校验，校验到 spawn/register 不让出事件循环，等待模型输出不持有许可。
- 授权 Store 原子提交成功后才通知在途调用；撤销、删除 Agent、解绑/群断开、响应策略变化及 Engine 关闭触发取消。迟到结果不接受，失败落盘不误取消；取消不改冻结计划，也不回滚外部效果。
- Task 启动许可读取实际 running Run、持久化正向审批、冻结计划一致性、所有权和 WorkAction 边界。手动 Task/WorkAction 重试保留原计划与时限，新的高权限 Run 再次审批；失效确认和不可执行归档不能借重试换成当前 Agent。
- 恢复时旧 full queued/awaiting_approval 和授权失效队列明确失败/取消；正常同机重启继续有效的已批准计划，Agent 备份恢复的确认不复活。running 沿用原来的中断不重放规则。
- Core 原生预检按模式分支；full 保留 Workdir/Skill 完整性及版本/身份/MCP 检查，但不套隔离专属目录 profile 检查。准备期间替换 Workdir 或修改调用方计划不能改变最终输入。
- 完全访问质量重评固定拒绝；Task 后 Dream 改为冻结 Provider/model 的独立无工具客户端。Task 的撤销监听覆盖模型结束后的结果落盘/提炼阶段，不因模型已退出而失去取消能力。授权/准备失败不得被 FTS 兜底吞掉并记为成功。
- 新增不替换 Engine 的假 Provider/假飞书传输集成用例，覆盖 start → sent → fork、模型失败不推进、撤销不再调用。
- 确认超限时自动清理最旧的无引用记录。AgentStore 在可信同步引用读取器之外，自行保护旧/新当前发布和本次新确认；清理与 release/rollback 使用同一次候选原子提交，失败不替换内存或通知消费者。
- ChatRunStore/TaskRunStore 提供不分页、只读取元数据的非终态确认引用；queued/running Chat 与 awaiting_approval/queued/running Task 均保留。终态历史和 revision 不因授权清理删除，重启仍可查看，但缺失授权的旧计划不能执行。
- 没有持久化 Run 的原生预检、整轮普通问答和独立客户端调用使用临时引用计数保护，并发调用各自释放，异常退出也释放；引用保留不代替授权检查或阻止显式撤销。关闭 Engine 或引用未知时不清理。
- 数量/字节的清理策略共用 `local-execution-retention.ts`，先解决每 Agent 超限再处理全局压力，只清理达到上限所必需的记录；无可信引用读取器的独立 AgentStore 仍超限拒绝。

实现利用当前所有授权 Store 的同步提交在同一 JS 事件循环内串行化；若改为异步提交或跨 Worker，必须重建启动/撤销锁协议。
P4a 已落地：

- 工作台显式模式字段：Codex 隔离只接受 read-only/write，完全访问只接受 full；旧 full 需要选择。切回隔离清空 full 权限选择，必须由操作者选择受限权限；不自动降级。非 Codex 不提交此字段。
- 保存草稿不授权；完全访问新建/发布/回滚进入独立确认页，列出来源版本、模型、指令、Workdir、完整真实 Chat 范围和旧运行影响。确认后由 Engine 检查绑定兼容性，再调用可信 Core 原子产生版本与确认。
- 风险确认和 Task 开关都不预勾选；来源由后台鉴权状态决定，HTTP 不接受自报 source/scopes。确认/撤销 POST 校验同实例令牌、精确 Origin/Host、版本 CAS 与范围摘要；不信任转发头，表单限 8 KiB，重复/未知字段拒绝，公开错误固定有界。
- 右侧显示当前已发布版本的已确认/待确认 Chat 数量和 Task 开关，并可撤销全部版本确认；新增范围不自动授权。撤销写失败不误报成功，回滚完全访问重新确认，重复提交不产生额外版本。
- `detectProviders()` 默认只检查 CLI、身份及版本/fork 命令（`nativeSessionCommands`），未请求时 `nativeSessions` 保持 undefined。显式 `codexNativeIsolation:true` 才运行原机器级受限探针，旧隔离测试保留不弱化。
- 完全访问恢复仅查 CLI，不复用隔离失败、启动 sandbox setup 或继续旧沙箱轮询；隔离模式提供显式“检测隔离能力”。机器探测通过文案不再声称“完全可用”。

P4b 已落地：

- Core `AgentReadiness.status/check`：GET/健康不启动 Provider，显式检查复用原生无模型预检，分别检查实际模式、Workdir、完整 Skill、MCP、身份和原生命令；不创建 Run/确认，不调用模型，不启动 sandbox setup。
- 以当前发布快照、确认/范围、Workdir canonical 身份、CLI/凭据文件元数据和 Skill 目录版本区分缓存，最多 256 个 Agent、60 秒、两个并发检查；同 Agent 合并，忙时固定返回可重试提示。
- 探针前后校验配置与 Skill 全内容/路径；发布/撤销/绑定变化取消旧探针，迟到结果不覆盖新状态。临时引用保护确认到检查结束，退出清理。相同共享 Skill 的再次完整校验可保留其他 Agent 的旧诊断，但不改原配置键或延长有效期。
- 仅缓存诊断，不缓存启动许可；Workdir/身份变化与手动 Skill 刷新使旧结果未知。文件元数据无法即时反映 OS keyring/MDM 变化，最多 60 秒缓存窗口内仍可能变化，因此实际执行保留全部重验。
- 页面提供受同实例 CSRF/Origin/发布版本保护的“检测当前发布配置”，区分原生命令、当前准备、授权与模型验证。恢复连接清理旧机器/Agent 诊断；发布历史显示模式，Run 详情按原冻结引用展示当前本机确认是否有效。
- `agentExecution` 健康汇总只输出数量，覆盖活跃原生群聊、个人完全访问及启用的完全访问 Task；断开的群/未选模式不算所需能力，Task 本机开关未授权会阻断。未知/过期为 degraded，已知不可用阻断；既有后台和 Provider 最近运行故障继续独立判定，前台诊断不清除它们。

P5 浏览器与 Codex 最小真实部分已通过，剩余完整 Skill、真实飞书/重启衔接与支持平台全量/crash-recovery。
机器隔离缓存和逐 Agent 准备通过均不是实际模型调用证据；不能用绿色状态、CLI 可连接或发布成功代替真实调用验证。
Store 的确认参数只供可信 Core 使用，不能直接透传 HTTP 字段。后续真实调用与服务重启仍需另行授权。

P5 最小真实验证（2026-09-14）：Windows / Bun 1.3.14 / Codex CLI 0.154.0 / `gpt-5.6-sol`，经用户单独授权执行。HomeAgent 既有认证复用流程成功导入当前控制台文件缓存；未重新登录。完全访问的实际 Core/LLM 调用验证了首轮精确随机标记、fork 回忆未在新 prompt 重放的标记、不同 child ID，以及 Workdir 中小于 256 字节且内容正确的文件。最终两次模型调用的证据均为 `process=started`、`model=verified`、`effectiveSandbox=danger-full-access`、`sandboxCheck=not-applicable`；第二轮为 `file-change/completed`，不宣称执行过 PowerShell。撤销持久化确认后，原冻结计划被 `local-execution-consent-revoked` 拒绝，新增执行证据为 0。
最小入口初次使用系统 Temp，Codex 拒绝创建辅助程序的警告使空 MCP 列表仍不能通过严格检查；对照验证改用仓库内一次性目录后 stderr 为 0、列表仍为空，未修改 Provider 检查。随后首次模型运行的原生 fork 和文件写入实际成功，但脚本过窄地只接受 command，改为同时接受已完成的文件编辑（且独立检查文件）后重新完整通过。共两轮有模型验收、四次模型调用；其他探测未调用模型。
全新测试实例的隔离预检为 `windows-elevated-sandbox-required` / 退出码 1，没有执行 sandbox setup，也没有读取或替换既有实例的沙箱配置；这不是旧实例 `75` 已消失的证明。使用空受控 SkillCatalog，未连接飞书 transport、未提交 Chat Run 送达/话题映射、未启动 Task 或调度器、未重启服务；因此完整 Skill、群话题送达/重启与高权限 Task 的真实验收仍未完成。
本轮定向回归 6 文件 **44 项**、`bun run typecheck` 通过；未重跑支持平台全量/crash-recovery、质量/签名/发布/soak 门禁。临时数据、认证副本、Provider 会话和测试文件均已清理，诊断脚本已删除；未改生产数据、未提交/推送。本轮新增可重复运行的显式 opt-in 入口及 5 项离线自检，见第 13.3a 节。

P5 离线浏览器验证（2026-09-14）：Windows / Bun 1.3.14 / Playwright CLI 0.1.17 / 本机 Edge 153（headless），桌面 1600×1100、手机宽度 390×844，使用全新临时数据与假 Provider；不是实际手机设备验收。
真实管理页面完成：默认不探测、隔离失败展示、模式选择即时文案、草稿不授权、独立风险确认与 Task 默认关闭、未勾选无法提交、同站 Origin、发布后缓存失效、陈旧页面 409、完全访问准备通过但模型未验证、CLI 恢复不运行隔离检测/设置、撤销后不再预检、切回隔离必须明确选择 write 并重新检查。
浏览器复现并修复三个问题：模式变更后发布按钮仍为旧文案；确认页 `no-referrer` 使 Chromium 的同站表单 POST 带 `Origin: null` 导致 403；手机通用面板样式使固定详情抽屉无法滚动到检测按钮。确认页改为 `same-origin`，不放宽服务端 Origin/CSRF 校验；抽屉恢复独立视口高度和滚动，不使用强制点击绕过问题。
自动脚本仅替换撤销时原生 `confirm` 的同意决定（该原生弹窗另外已实测出现并确认），不替换风险勾选或表单提交。最终累计无模型准备 3 次（隔离 2、完全访问 1），模型/设备登录/系统沙箱设置各 0 次；假身份复用入口 1 次，不是实际身份导入证据。没有浏览器 JavaScript 异常；已知隔离失败产生的 `/readyz` 503 和既有 favicon 404 不作为脚本异常。
本轮定向回归 **258 项**（7 文件 85 项 + Web app 173 项）、`bun run typecheck`、质量评测 14/14 通过。固定质量评测原用例实测因扫描本机 Skills 超过 5 秒；仅注入空 SkillCatalog 后由约 12.8 秒降到 0.63 秒，4 项原测试通过，未延长超时或改变生产边界。
重新执行 Windows `bun test --bail` 已越过原质量失败，运行至 9 文件 77 项时因 `crash recovery verification is unsupported on win32` 退出；**全量仍未通过、未跑完**。Ubuntu/macOS 全量/crash-recovery、真实 Codex/飞书、签名/发布/soak 仍未运行；未操作生产服务或 live data，未提交/推送。

P4b 的 Windows 离线验证（2026-09-14）：App/Orchestrator 4 文件 314 项、Engine/执行许可/范围/问答/Skill 6 文件 271 项、
LLM/CLI client 6 文件 161 项、准备状态/管理页/证据/健康/doctor 7 文件 88 项，合计 **834 项**通过（重复运行不重复计数）。
其中准备状态 10 项覆盖授权撤销、配置和目录/身份/Skill 变化、迟到结果、并发合并/上限、缓存容量/到期、关闭取消及共享 Skill 重验不延长旧证明；HTTP 覆盖只读 GET、受保护 POST 和发布版本校验。
`bun run typecheck`、质量评测 14/14、41 个本地文档链接、内联脚本语法解析及 `git diff --check` 通过。
本轮执行 Windows `bun test --bail`，首个 `scripts/ai-quality-evaluation.test.ts` 用例失败后退出，**全量未通过且未跑完**；独立质量评测通过不替代该测试或全量门禁。
仍未运行 Ubuntu/macOS 全量和 crash-recovery、浏览器交互、真实 Codex/飞书及发布门禁；未重启服务、编辑 live data、提交或推送。

P4a 的 Windows 离线验证（2026-09-14）：管理页/Orchestrator 8 文件 364 项、Engine/问答 5 文件 238 项、Provider 116 项、
质量重评/健康/doctor/CLI client/策略/证据 7 文件 70 项，合计 **788 项**通过（重复运行不重复计数）。
新确认 HTTP 21 项覆盖正向发布、Task 默认关闭、范围增量、撤销、切回隔离、回滚、身份、表单篡改/跨站、并发范围变化与写失败；纯视图/编辑器覆盖模式矩阵与错误展开。
`bun run typecheck`、质量评测 14/14、41 个本地文档链接、内联脚本语法解析及 `git diff --check` 通过。
健康错误用例曾因扫描开发机 Skills 超过 Bun 默认测试时限；已将该测试的 SkillCatalog 固定为空，不改变生产超时或执行校验，7 文件重新通过。
本轮尝试了 Windows `bun test`：出现 macOS LaunchAgent/POSIX 权限、Windows 不支持的 SIGKILL 验证，以及调度/质量等超时；约 6 分钟后因长时间无新输出中止，**全量未通过且未跑完**。
没有将这些失败统称为平台问题或改弱断言；支持平台仍须重新跑全量/crash-recovery。未做浏览器交互或真实 Codex/飞书验收，未重启服务、编辑 live data、提交、推送或发布。

确认清理阶段的 Windows 离线验证（2026-09-14）：核心 Store/范围/计划/归档 314 项、Engine/问答/质量重评 240 项、
Orchestrator/管理页/工作台 341 项、CLI client/Provider 策略/证据 159 项，合计 **1,054 项**（本阶段新增 18 项）；
`bun run typecheck`、质量评测 14/14、38 个本地文档链接与 `git diff --check` 通过。
回归先复现“容量满时不能安全发布”和“无持久化 Run 的预检/问答会被误清理”，随后接通真实引用读取与临时引用计数。
新增覆盖数量/字节边界、全部受保护/未知引用拒绝、当前发布保护、原子写失败、回滚、非终态保留、终态历史重开及旧引用不可执行。
本阶段未改变持久化格式版本，未编辑实时数据、重启服务、提交或推送；Ubuntu/macOS 全量回归、支持平台 crash-recovery、
真实 Codex/飞书、迁移/live、签名/发布均未执行。该轮结束时 P4 尚未开始；当前 P4a 进度见上文。

上一轮 P3 的 Windows 离线验证（2026-09-14）：核心 Store/范围/计划/归档 302 项、Engine/问答/质量重评 234 项、
Orchestrator/管理页/工作台 341 项、CLI client/Provider 策略/证据 159 项，合计 1,036 项；
`bun run typecheck`、质量评测 14/14、41 个文档本地链接与 `git diff --check` 通过。
回归曾暴露两条旧断言仍按“全部 full 拒绝/重试改用新时限”预期，已按批准的模式与冻结契约更新；没有提高生产超时或削弱隔离测试。
仍未运行 Ubuntu/macOS 全量回归、支持平台 crash-recovery、真实 Codex/飞书、服务重启、迁移/live、签名或发布；未编辑实时数据、提交或推送。

上一轮 P2b 的 Windows 离线验证（2026-09-14）：核心 Store/范围/计划/归档 301 项、Engine 180 项、
Orchestrator/管理页/工作台 326 项、CLI client/Provider 策略/证据 159 项，合计 966 项；
`bun run typecheck`、质量评测 14/14 通过。新增覆盖范围变更、失败落盘、256 范围边界、旧计划重启、
v2 已送达 head 续用与确认变化新链、不可执行归档 DTO，以及时间回拨后 Chat 记录仍可重开。
这是 Windows 定向回归，不等于 Ubuntu/macOS 全量测试或 crash-recovery 门禁；真实 Codex/飞书、服务重启、
迁机、签名/公证/发布均未执行。未修改 live data，未提交或合并本轮改动。

上一轮 P2a 片段的 Windows 离线验证：Agent／本机确认／归档 4 文件 177 项，Engine 全文件 178 项，
管理页／工作台 3 文件 197 项，Provider 策略／执行／证据 4 文件 129 项，共 681 项通过；
`bun run typecheck`、质量评测 14/14、文档 41 个本地链接及 `git diff --check` 通过。
Engine 扩展回归首次出现真实 Skill 扫描超时和重启前后 Skill 快照不一致；已为无显式目录的测试实例补齐空目录依赖，
真实 Skill 夹具保留其临时目录，未修改生产超时或削弱冻结校验，最终全文件重跑通过。
这些是测试夹具内的 fake Provider 结果，不证明完整授权链或本机 Codex 已恢复。未运行 Ubuntu/macOS 全仓回归、
支持平台崩溃恢复、真实迁移／Provider／飞书或发布验收；没有修改 live 数据、重启服务、提交或推送。

离线回归先发现 10 个既有编排/Web 用例重建 Engine 时漏传测试 SkillCatalog，扫描了本机真实目录而超出 5 秒；
补齐后 10 项单独回归通过，后续全组重跑又暴露一个同类 CLI-only 用例，已连同相邻 CLI-only 测试一起补齐隔离目录。
这些调整只影响测试依赖，未修改生产超时、断言或执行逻辑。
归档组也暴露同类超时，首次运行已中止；为 26 个假 Provider 夹具及 1 个待审批夹具补齐隔离 SkillCatalog 后，最终 75 项通过。
最终组合复跑还发现模拟重启的 Engine 未延续测试依赖，导致恢复正向群响应决策的用例再次扫描真实目录；已将这些重建入口同样固定为隔离目录。
新增 stdin 写入失败的回归先复现清理问题，再修复为立即终止进程，避免清理定时器后仍遗留子进程。
完整验证结果见下面的阶段验证记录；这不是 Windows live、Ubuntu/macOS 全套或发布门禁的通过证明。

#### P0/P1 离线验证记录

- Provider 策略／准备／执行证据／进程：129 项通过；覆盖两模式参数、start/fork/ephemeral、file/keyring、版本/fork/MCP 拒绝、缺少或撤销许可、Workdir 替换、Skill 副本篡改和取消清理。
- ChatRunStore：44 项通过；新写入 v7、兼容 v6 已送达 head、未知未来格式拒绝、失败/待送达不推进、重启与原子提交回归。
- Governance：75 项通过；执行证据不导出，旧归档与恢复、Raw 撤回和话题失效规则保持有效。
- Core CLI／编排／Web 七文件组合：370 项通过；Engine 原生 Chat 选择回归：4 项通过。
- `bun run evaluate:quality`：14/14；`bun run typecheck` 通过。
- 未运行 Ubuntu/macOS 全量、crash-recovery、Windows live、真实飞书、soak、签名或发布；未重启服务、编辑实时数据、提交或推送本轮改动。

### P0：契约和回归基线

确认第 2 节范围、第 3 节例外、第 4 节矩阵及第 8 节旧 full 兼容变化；更新仓库工程契约。
查找所有 `nativeSessions`、`nativeSessionIsolation`、`permission === "full"`、执行计划 clone/validator 与归档消费者。

完成条件：每个消费者归入“共用检查／模式策略／本机授权／历史展示”之一；测试清单和迁移版本确定；未改 Provider 执行行为。

### P1：纯策略与 Provider 契约测试

先用 fake runner 写红测试，再抽出策略选择。让显式完全访问只跳过 filesystem profile／probe，保留身份、版本、fork、MCP、Skill、取消和托管配置。
所有真实运行入口调用同一个策略选择；不可只改管理检测而漏掉真实执行，或只改最终回答而漏掉 routing。

完成条件：相同 fake 返回 `75` 时，隔离路线失败，完全访问路线根本不启动沙箱探针；完整参数与 start/fork 断言通过。
尚无持久化授权的上层请求仍不可用；不得提前默认开启。

### P2：Agent、确认、冻结计划与迁移

实现模式字段、原子发布确认、撤销、计划 v2、严格旧格式读取和完整 clone；处理旧 full 不可执行说明。
实现模式／确认变更后的话题兼容性、新链、导出剥离和恢复后的重新确认。

完成条件：持久化失败无 phantom publication；重启、未知格式、旧计划、陈旧表单和授权撤销测试通过；所有新字段均有边界测试。

### P3：Chat／Task／恢复／治理

把同一模式贯穿计划生成、内部路由、最终 Provider、错误、执行证据和外发。
每次 Provider 启动前重验本机确认、Chat scope 或 Task 审批；撤销后中断／停止新调用；取消不改写冻结计划。
对高权限质量重评给出首版固定拒绝。验证 Space/消息治理和原生链规则仍成立。

完成条件：start → sent → fork、失败不推进、外发不重复、取消、不重放 running、同机重启与归档恢复案例全通过。

### P4：管理页面与能力状态

实现草稿模式选择、确认并发布、撤销、逐模式检测、失效状态和运行详情；新绑定／响应范围扩展有明确确认提示。
更新所有旧 `nativeSessions` 消费者的含义，保证页面不会将完全访问执行称作隔离通过。

分批交付：P4a 页面确认/撤销及按需机器诊断、P4b 逐 Agent 准备状态/缓存失效/版本和 Run 展示/健康汇总均已实现；浏览器及真实机器验证归 P5，不因代码完成自动通过。

完成条件：纯视图、HTTP、跨站／陈旧请求、恢复卡、readyz 及错误脱敏测试通过；页面无需手工改配置即可完成整个操作流程。

### P5：支持平台与真实验收

运行第 13 节。先离线后 live；采用测试账户、独立 Workdir、临时数据目录与指定测试群，不拿生产群消息做试验。
已通过的离线浏览器和 Codex 最小真实流程见第 12 节记录，重跑方式见第 13.2a/13.3a 节。P5 整体仍未完成。

完成条件：实际 Windows 身份复用、回答、fork 追问、工具执行、重启衔接有证据；受限模式无回归；未跑的门禁明确列出。
没有真实验证时交付只能说“实现与离线测试完成”，不能说“用户机器完全恢复”。

## 13. 验证矩阵与执行方式

### 13.1 必须新增的回归

| 类别 | 最低覆盖 |
| --- | --- |
| 模式矩阵 | 两模式 × 三权限；缺失／非法 mode；非 Codex 提交新模式；默认无 Agent；平台支持未知 |
| Provider 参数 | start/fork/ephemeral、stdin、受控 CODEX_HOME、无 ambient rules/plugins、full 不携带 profile/probe、托管拒绝不绕过 |
| 身份与能力 | file/keyring 复用；失效登录不等于隔离失败；旧版本/fork 缺失/MCP 非空两路线均停止；逐模式缓存不串扰 |
| Skill | 完整目录、超容量、内容变更、替换 staged 目录、取消、成功／失败清理；切模式不重选 Skill |
| 本机确认 | 未确认、原子发布、回滚重新确认、撤销、陈旧 revision、集合边界、clone 不共享、非终态引用不丢失；绑定更新后发布失败保持待确认；策略改回原值／解绑原样重建不恢复旧确认或旧 Run |
| Task | 无审批拒绝、确认不替代审批、审批过期、批准后目录／确认失效、retry 保持旧计划、WorkAction held/excluded |
| 原生链 | 模式双向切换和切回、首轮/fork、模型失败、父会话缺失、外发失败、sent 写失败、重启、不重放 running；routing 后发布不改 final，routing 后撤销阻止 final |
| 持久化／迁移 | Agents v4、计划 v1、ChatRuns v6/v7、TaskRuns v12、Bindings v2、未版本化 Registry、旧 full、未知未来版本、备份恢复、写失败内存不变；撤销后旧备份恢复不复活授权 |
| 归档／治理 | 新模式意图可移植但确认不可移植；本机证据／ID 不导出；撤回/删除失效；Team 主动上下文不包含 Personal |
| UI／健康 | 草稿≠发布；not-applicable≠passed；未选模式失败不误阻断；后台受限流程失败不隐瞒；新绑定确认；启动／健康无未请求隔离探测 |
| 公开数据 | 错误枚举有界，私有命令/输出/凭据/身份信息不出现在 URL、日志、公共健康、群提示 |

不要编写“完全访问模式阻止读取 Personal 文件”的通过测试；这与其实际能力矛盾。
可以验证 HomeAgent 应用层不主动提供 Personal 数据，并通过无敏感测试文件证明 full 的真实范围。

### 13.2 离线命令

在仓库根目录用 Bun，逐组运行。以下均为已有测试文件；新 Module 的测试与实现同目录加入相应组：

```bash
bun test packages/llm/src/codex-execution-policy.test.ts packages/llm/src/providers.test.ts packages/llm/src/provider-preparation.test.ts packages/llm/src/execution-evidence.test.ts
bun test packages/core/src/agents.test.ts packages/core/src/agents-local-execution.test.ts packages/core/src/local-execution-grants.test.ts packages/core/src/local-execution-retention.test.ts packages/core/src/local-execution-scopes.test.ts packages/core/src/chat-runs.test.ts packages/core/src/task-runs.test.ts packages/core/src/cli-client.test.ts packages/core/src/feishu-bindings.test.ts packages/core/src/registry.test.ts
bun test packages/core/src/engine.test.ts packages/core/src/engine-execution-permits.test.ts packages/core/src/engine-execution-retention.test.ts packages/core/src/engine-execution-scopes.test.ts packages/core/src/ask.test.ts packages/core/src/governance.test.ts packages/core/src/quality-rerun.test.ts
bun test packages/orchestrator/src/runtime.test.ts packages/orchestrator/src/runtime-full-execution.test.ts packages/orchestrator/src/messages.test.ts
bun test packages/web/src/agent-workbench.test.ts packages/web/src/agent-workbench-view.test.ts packages/web/src/chat-run-evidence.test.ts packages/web/src/app.test.ts
bun test packages/app/src/codex-setup.test.ts packages/app/src/runtime-data.test.ts packages/app/src/health.test.ts
bun run typecheck
bun run evaluate:quality
git diff --check
```

在 Ubuntu/macOS 支持主机运行 `bun test`，持久化改变还需 `bun run verify:crash-recovery`，候选版本再走 beta runbook。
Windows 的 SIGKILL、POSIX、LaunchAgent 等测试结果不能用来宣称支持主机完整回归通过。
基线提交前曾有 565 项通过、1 项 5 秒超时，超时用例原样单独重跑在约 2.25 秒通过；记录历史，不据此免跑或提高测试时限。

### 13.2a 离线浏览器验收

在仓库根目录启动专用 [离线实例](../packages/app/src/dual-mode-browser-fixture.ts)，不要使用生产 `bun start` 或默认 dev 入口替代：

```powershell
bun run packages/app/src/dual-mode-browser-fixture.ts
```

它总是创建新的临时数据目录及 sibling Workdir，只监听随机回环端口；Provider 探测、准备、身份复用和沙箱设置都是测试替身，模型入口固定拒绝，没有飞书连接器或调度进程。浏览器页面中的绿色状态仅是假的准备结果，不代表本机 CLI 已恢复。此入口不被生产 main 导入，`/__fixture` 只属于该测试实例。

用已安装的 Playwright CLI 和 Edge，在另一个终端打开启动输出中的 URL（将下列 `<端口>` 替换为实际值）：

```powershell
playwright-cli -s=homeagent-p5 open http://127.0.0.1:<端口> --browser=msedge
playwright-cli -s=homeagent-p5 --raw run-code --filename=scripts/dual-mode-browser-flow.js
playwright-cli -s=homeagent-p5 close
```

[浏览器脚本](../scripts/dual-mode-browser-flow.js) 检查离线标记并要求全新实例；只对该实例操作，不接受生产页面。必须返回包含 `desktopAndMobile: true` 的 JSON 才计为完整通过；CLI 显示 `Error`、超时、原生弹窗或仅有部分输出都不能计通过，即使 CLI 退出码是 0。脚本内撤销弹窗模拟同意；风险确认仍通过实际 checkbox 与表单验证。失败后关闭这个具名浏览器会话，在实例终端输入 `stop` 回车停止并清理，再创建全新实例重跑。

无需升级/下载工具，不连接用户现有浏览器 profile，不修改既有 HomeAgent 数据或确认。Windows 终端不能转发 Ctrl+C 时使用 `stop`；该命令只作用于离线入口的 stdin，不是管理 HTTP 功能。此检查验证 Web/Core 交互而非真实 CLI 参数、身份、Skill 副本、原生 start/fork 或系统隔离。

### 13.3 Windows 最小真实验证（需另行授权）

1. 确认测试范围和账户，使用隔离测试数据目录及显式临时 Workdir；所有 `HOMEAGENT_LIVE=1` 调用显式 opt-in。
2. 同一 Windows 用户先在 PowerShell 验证 CLI 身份，HomeAgent 通过既有流程复用；不打印 auth 文件或 keyring 内容。
3. 以隔离模式运行无模型预检，记录当前真实结果；仍为 `75` 时保留失败证据。
4. 从 HomeAgent 页面选择完全访问、确认、发布并检测；确认不调用 Windows sandbox setup 或 filesystem probe。
5. 获准后运行无敏感内容的最小模型请求，执行一个只写测试 Workdir 的无害命令并返回固定结果；保存有界执行证据。
6. 在指定测试群首次 @ 回复后追问一个依赖首轮随机测试标记的问题；同时验证 fork ID 变化与同话题路由，不能只凭“回答似乎记得”判断。
7. 明确批准重启测试实例，再追问并验证使用已送达的 head；进行中的 Run 被中断后不重放。
8. 切回隔离模式，确认新链且重新受隔离门禁约束；若仍为 `75`，应明确失败而不是重用完全访问会话。
9. 撤销确认后尝试旧运行重试，证明 Provider 未被启动；检查 Task 仍需自己的人工审批。

完成这组验证不意味着真实生产飞书、长时间 soak、跨平台或发布门禁全部通过。

### 13.3a 不接飞书的最小真实验收入口

此入口只覆盖第 13.3 节的一部分，不替代完整 P5。必须事先获得当前用户对真实模型开销及无沙箱文件工具的明确同意；普通 `bun test` 不运行它。

在非系统 Temp 的源码仓库使用 PowerShell：

```powershell
$env:HOMEAGENT_LIVE = '1'
try {
  bun run packages/app/src/codex-dual-mode-live.ts --confirm-local-full-access
} finally {
  Remove-Item Env:HOMEAGENT_LIVE -ErrorAction SilentlyContinue
}
```

入口在仓库内创建被 Git 忽略的 `.codex-live-<随机值>/`，内部 `data/` 与 `work/` 互为兄弟；通过既有 helper 仅导入控制台认证缓存，不导入配置、Rules、Plugins、Skills 或旧会话。选择这个位置是因为 [Codex 0.154.0 的辅助程序初始化](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/arg0/src/lib.rs#L319-L329) 拒绝使用系统临时目录作为 Codex Home；不能忽略该警告来伪造准备通过。

入口使用真实 KnowledgeEngine/Provider，无注入假 Provider 或假预检；本地创建一次性 Space/绑定/Agent 和 Task 关闭的持久化本机确认，但不连接飞书。先分别执行无模型准备，再以 `gpt-5.6-sol` 执行两轮最小请求，核对首轮标记、fork child 不同、新 prompt 不重放标记、第二轮模型结果、实际小文件内容和已完成的 command/file-change 工具证据，最后撤销并验证原冻结计划拒绝执行。输出仅保留固定结果、脱敏证据和布尔值，不输出认证、原生会话 ID、回答、命令或 Provider 诊断原文。

正常完成或失败后关闭 Engine 并清理本次目录；运行中可输入 `stop` 或 Ctrl+C 受控取消。强制结束整个进程/断电不能保证 finally 清理，应在确认测试子进程已退出后按本次精确目录安全清理，不能删除整个仓库或用户 Codex Home。入口不下载 CLI、不运行系统沙箱设置、不改既有服务、不开启 Task，也不验证完整 Skill、真实管理页与 Provider 的联合流程、真实飞书送达/映射持久化或重启。

## 14. 交付与新会话启动文本

交付时列出：代码提交、改变的契约、迁移版本、两种模式分别通过的测试、真实验证环境、未运行门禁，以及当前机器隔离失败是否仍存在。
必须能回答：默认是什么、谁明确开启、怎样撤销、哪些 Run 受影响、如何迁移旧 full、如何在 UI 区分“已连接／已准备／已实际验证”。

可复制到新会话的请求：

```text
请在 C:\work\github\homeagent 实施 docs/codex-dual-execution-mode.md 中的 Codex 双执行模式。
先读取该文档、AGENTS.md、README.md、CONTEXT.md 并检查 git status；基线 main 为 227d580，注意之后可能有新变更。
我确认按文档范围调整现有隔离契约：保留默认隔离模式，增加操作者明确确认并发布的本机完全访问模式。
同意文档规定的旧 Codex full 配置需要重新确认，以及模式切换后新建原生话题链；不要自动降级。
按 P0–P5 分阶段实现并添加回归测试，保留冻结 Skill、Task 人工审批、原生 fork/送达提交和执行证据。
本次只授权代码、文档与离线测试；真实 Provider/飞书调用、下载升级、系统配置变更、服务重启、推送和发布前另行确认。
开始前若文档不存在，先停止并让我提供文件，不要根据聊天标题猜测实现。
```

本文件在新会话开始前需要可见：如果仍未提交，选择当前本地目录；新建的独立 worktree／远端任务不一定包含这份未提交文档。

## 15. 官方资料与设计依据

官方资料核对日期：2026-09-14。它们说明 Codex 能力，不替代 HomeAgent 本机验证：

- [Sandbox：权限与确认策略](https://learn.chatgpt.com/docs/sandboxing#configure-defaults)：`danger-full-access` 移除沙箱限制；搭配 `approval_policy="never"` 为无交互完全访问。
- [Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)：原生 elevated 为优先选择，setup 依赖机器策略；完全访问不限制在项目目录。
- [Permissions：平台执行能力](https://learn.chatgpt.com/docs/permissions#how-enforcement-works)：Windows unelevated 不能执行所有细分读写约束，不应把它当作精确隔离的等价替代。

本设计关于本机确认、冻结计划、迁移、两模式 UI 与验收次序的规定是 HomeAgent 的工程选择，不是 Codex 官方要求。
