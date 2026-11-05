# DeepSeek Super-agent 与 HomeAgent 接入研究

核验日期：2026-11-03（Asia/Shanghai）。这是资料与源码静态核验，不是已经交付的功能设计，也不是部署或运行验收。本文没有启动真实 Provider、安装依赖、改动飞书或修改 HomeAgent 数据目录。

原始介绍：[Super-agent 设计探索：迈向更自主的 Agent 系统](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)。下文以 DeepSeek 官方仓库、文档和源码核实原型当前能力；建议与未验证项单独注明。

原型核验版本：`deepseek-ai/dsh-superagent-prototype` 的 `main`，通过只读 `git ls-remote` 确认提交为 `6337fc823ce20251c8de8085948165c81aaa701e`。Harness 文档按核验日的公开版本读取，实际部署仍须匹配原型要求的版本。

## 结论

适合结合，最有价值的是借鉴事件驱动的多任务路由、任务订阅与异步结果交付；HomeAgent 继续保有飞书入口、Space 归属、长期知识、任务状态与验收流程。若希望直接试用开源原型，单个 GitHub 仓库的研发协作是最贴近其现有能力的场景。

不能把它理解为配置一个 DeepSeek 模型就获得 Super-agent，也不能把接通知识查询当成已经实现双向任务委派。HomeAgent 当前 `ProviderId` 只有 `gateway / claude / codex / trae-cli`，没有现成的 `dsh` 适配；原型有自己的任务、会话、执行和恢复体系。[HomeAgent Provider 定义](../../packages/llm/src/providers.ts)、[原型架构](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/007-architecture.md)

## HomeAgent 现有基础与具体差距

以下来自当前仓库源码静态核验，不是本次运行得到的性能数据。

- 已有能力：Space 知识、Raw journal、Dream cycle、主动参与群聊、Chat/Task Run、分层并发调度、定时任务、工作续作、结果验收和知识 MCP。引入 Super-agent 不需要重新建设这些模块。[README](../../README.md)、[主动参与判断](../../packages/orchestrator/src/group-participation.ts)、[RunScheduler](../../packages/core/src/run-scheduler.ts)、[工作续作](../../packages/core/src/work-continuation.ts)
- 同一聊天仍有阻塞点：`Orchestrator.enqueue()` 按 `chatId` 串行并等待 `handle()`；普通回答路径又等待 `scheduleChatRun()` 完成。因此，从代码路径看，同群长 Chat 会延后该聊天后续事件的处理。不同聊天已有并发调度及回归测试，不能概括成整个 HomeAgent 只能串行执行。[事件与回答路径](../../packages/orchestrator/src/runtime.ts)、[不同聊天并发测试](../../packages/orchestrator/src/runtime.test.ts)
- 技术方案阶段补充核实：真实 `FeishuConnector.pumpStdout()` 逐条 `await handler(event)`，所以同一 NDJSON 消费流中的后续事件也会被阻塞，包括来自其他聊天的消息。直接调用 Orchestrator 的并发测试未覆盖这一传输入口，实施必须增加 Connector 与 Orchestrator 联动回归。[飞书消费链](../../packages/connectors/src/feishu.ts)、[完整技术方案](../superpowers/specs/2026-11-03-homeagent-multitask-coordination-design.md)
- 工作归属还不是多事项路由：`WorkItemStore.activeForSpace()` 返回一个活动工作项，激活另一项会取消同 Space 其他项的 active 标志；Chat 默认关联这个活动项。这不等于不能保存多个事项，但要在同一群中交错跟进多个目标，需建立消息/话题到事项的稳定关联。[工作项存储](../../packages/core/src/work-items.ts)、[Chat 工作项绑定](../../packages/orchestrator/src/runtime.ts)
- 多 Worker 需要协调现有调度：默认并发为 global 4、provider/model 2、Agent 1、conversation 1；Chat 将 conversation 设为 Space。仅新增一个 Router 不会自动让同 Space、同 Agent 的任务并发，需把独立工作事项与仍需有序的同话题运行区分清楚。[并发层配置](../../packages/core/src/engine.ts)
- 中途追问需要明确接入能力：当前 Provider 运行接口包含一次性输入、取消及可选原生会话 start/fork，没有通用的运行中消息投递接口。因此完整的中途介入需实现任务收件箱，并按 Provider 能力处理续接；不能把异步启动任务直接称为已具备完整全双工交互。[Provider 接口](../../packages/llm/src/providers.ts)

建议把新增路由和 Worker 归属绑定到 Space 与 WorkItem，继续沿用现有授权检索范围；飞书群话题的 Provider 原生会话仍遵守其 Team Space 和话题绑定。原型的全局 Router 上下文不能直接汇总所有个人与团队 Space。工作结果也应通过现有验收与 Raw 准入流程进入知识，外部 Agent 不直接改运行中的 Raw journal 或 Wiki。

## 已核实的原型能力

| 核验项 | 官方实现与边界 |
| --- | --- |
| 产品形态 | README 明确称其为研究原型、非正式产品；公开代码与内部版本及文章实现不完全一致，文章中的部分方向尚未落地。当前版本为 `0.1.0`，MIT 许可。 |
| 直接服务对象 | 面向一个 GitHub 仓库的编码 Agent，可选接入飞书。接收请求、创建 Ticket、在独立 Session 和目录中工作，再向原会话交付结果，例如 PR。 |
| 事件与任务 | Source 将外部事件变成 Trigger；先进入已有 Ticket 的订阅，再由 Eval 判断是否创建新 Ticket；Assignment 把 Ticket 绑定到 Executor。Thread 可以关联多个 Ticket，后续消息可继续送达对应执行者。 |
| 并发与交互 | Worker 有并发槽；长 shell 命令转后台，Worker 可在下一步收到补充信息；人的追问有额外槽位和优先级。问题、待评审、失败等状态能移交给人。 |
| 持久状态 | Engine 在事务中更新领域状态，外部效果在提交后执行；Outbox 管理消息回执，Source 记录读位置。持久任务状态与模型 Session 分离。 |
| 运维检查 | 部署文档提供状态脚本，以及放在另一个 Harness profile 中的每小时检查示例。原型因此有具体的独立检查路径，但不能由此推定文章所有云端存算分离和跨设备设想均已实现。 |

来源：[README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/README.md)、[package.json](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/package.json)、[领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/001-domain.md)、[执行流程](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/003-execution.md)、[架构](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/007-architecture.md)、[部署](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/006-deployment.md)。

## 知识接入：有现成接口，但要区分 Harness 与原型 Worker

HomeAgent 已提供 MCP stdio 和 JSON CLI，代理运行中服务的固定本地查询端点；六个读取工具按单一显式 Space 查询 Knowledge page，另有可选知识反馈。反馈进入治理队列，并不创建 Raw、改写 Wiki 或触发 Dream cycle。[本地 Agent 知识复用与反馈](../../README.md#本地-agent-知识复用与反馈)

DeepSeek Harness 官方 `@deepseek-ai/dsh-mcp-client` 支持 stdio 和 Streamable HTTP，stdio 配置有 `command / args / cwd / env`。因此，**普通 Harness Session 通过 MCP 读取 HomeAgent 知识在协议和配置上可行**；应先验证六工具发现及单 Space 检索，不需要复制 HomeAgent 数据目录。[Harness MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)

**原型受管 Worker 不能由上述事实直接推出即插即用。** `src/app/sessions.ts` 的 `WORK_TOOLS` 列表只包含文件、shell、web、Skill、todo 和 subagent 等工具，没有 `mcp__*`；`workOnly()` 据此限制继承工具，Router 也有自己的较小工具集。因此，仅把 MCP client 加入 profile，不能保证这些受管会话能看见并调用 HomeAgent MCP。需要对工具注册做适配，或先使用其现有 shell 执行 HomeAgent JSON CLI。[工具列表](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/sessions.ts#L51-L58)、[Router 限制](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/sessions.ts#L257-L262)、[Worker 限制](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/sessions.ts#L278-L291)

最小查询试验可复用 HomeAgent 文档中的命令，例如在仓库工作目录执行 `bun run knowledge list_spaces`，再执行带 `--space` 的 `search_knowledge`、`get_page`。这是待实测的集成路径，本次没有启动服务或 Provider。当前知识 read token 是本机操作者级、可读全部 Space 的凭据；显式 `--space` 是查询归属，不是按 Worker 身份划分的 ACL。应按既有 HomeAgent 授权契约选择暴露的接口，不把提示词当作数据隔离。[HomeAgent 查询接口契约](../../README.md#本地-agent-知识复用与反馈)

## 任务接入：需要适配，现有管理 API 不等于通用任务 API

原型管理 `Api` 有 Ticket 列表、详情、retry、stop、执行暂停与设置接口；当前列表中没有通用的创建 Ticket 或提交外部 Job 接口。不能虚构一个 `POST /tickets` 并声称 HomeAgent 可直接调用。[管理 API 类型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/api.ts#L17-L42)

官方提供新增 Source 的开发范例：把外部事件转换成 Trigger，定义接收范围、上下文读取、回复 Channel 和游标。`SourceContext.receive()` 是实际入站 seam，Channel/Outbox 是回传路径。**推断：** 若将原型作为外置研发执行服务，可新增 HomeAgent Source，把 HomeAgent 工作请求映射到 Trigger/Thread/Ticket，并把结果、等待输入和失败状态映射回 HomeAgent。仍需实现稳定 ID、去重、取消、结果归属和恢复语义，不能让两个系统各自认定同一任务已完成。[扩展 Cookbook](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/008-cookbook.md)、[SourceContext](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/sources/host.ts#L28-L61)

另一个可选方向是用 HomeAgent Task 执行能力实现原型 `Executor` 接口。该接口提供 `start / deliver / stop`，但目前生产实现是 `DshExecutor`；替换实现意味着同时对接持续 Session 的中途输入和生命周期，工作量高于知识查询。它是源码级扩展设想，不是现成插件开关。[Executor port](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/ports.ts#L47-L61)

## 不能直接沿用的执行语义

| 原型行为 | 与 HomeAgent 结合时的含义 |
| --- | --- |
| Router/Worker 以操作者 OS 用户、`danger-full-access` 执行 | 不能被包装成 HomeAgent 已隔离的 Provider，也不能绕过现有 `write/full` Task 的持久审批与本地执行授权。目录和命令包装本身不是隔离。 |
| 忙碌中断的 Assignment 可带 recovery note 重启 | HomeAgent 允许恢复排队计划，但禁止自动重放停机时已运行的进程；需要明确由哪一层负责恢复。 |
| 每次模型请求读取当前 prompt revision，并更新 Skills | HomeAgent Run 冻结 Agent revision、instruction、Provider、model、Skill 等证据；若接入为其执行后端，需保证该冻结契约。 |
| Worker 一轮结束后的后台工作最多等待 30 分钟，届时杀死 shell jobs；subagent 可以继续 | 这不是可直接搬入 HomeAgent 的通用 AI 超时。HomeAgent 的集中稳定性上限默认 6 小时；适配应区分前台转后台、后台作业生命周期和模型超时，不附带缩短现有长任务能力。 |
| 原型可按规则主动接任务，且有 PR 交付/合并提示词 | 规则是否允许执行与 HomeAgent Run 是否已获授权是两个系统的事实，不能互相冒充；也不应把研发 PR 的交付策略直接套用到个人助理的所有动作。 |

来源：[执行和恢复](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/003-execution.md)、[部署权限说明](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/006-deployment.md)、[promptFor 当前版本绑定](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/sessions.ts#L323-L333)、[HomeAgent AI 限额](../../packages/shared/src/ai-limits.ts)、[HomeAgent 不变量](../../AGENTS.md#non-negotiable-domain-invariants)。这些是现有契约的兼容性问题，不是为本次研究新设产品限制。

## 场景判断（工程推断）

| 场景 | 适配判断 | 最小可行路线 |
| --- | --- | --- |
| HomeAgent 仓库的问题复现、修复、PR 评审跟进 | 最贴近原型现有实现 | 单仓库研发试点；读取 HomeAgent 中项目约定与历史经验，交付 PR/测试证据。 |
| 同一飞书群同时跟进多个长任务，补充消息找到正确工作项 | 很有价值，适合吸收设计 | 在 HomeAgent 现有工作项和调度之上增加任务路由、订阅和中途输入；不能把现有后台并发能力说成不存在。 |
| 资料研究、报告撰写、跨日项目跟进 | 架构适用，原型需业务适配 | 保留 HomeAgent 的 Space、来源与验收；Worker 做检索分析与产物生成，结果经过现有准入再进入 Dream cycle。 |
| 普通知识问答、每日带读、简单提醒 | 原型增益有限 | 继续使用 HomeAgent 已有流程；避免为单步操作再引入完整 Router/Ticket 系统。 |
| 全自动购物、支付、家庭设备控制或任意跨应用操作 | 不能由这次发布推定支持 | 需要相应工具与业务流程；现有单仓库原型没有给出这些能力的交付证据。 |

## 建议的首个验证场景

个人助理方向，优先在现有 HomeAgent 上验证：同一飞书对话并行发起“研究一个技术方案”和“整理项目周报”，期间追问进度、给其中一个事项补充要求。验收重点是新消息能及时被接收、补充要求找到正确事项、结果回到正确话题、工作证据只归入对应 Space，以及重复事件和恢复不会重复执行已发生的动作。这是建议的实验负载，不是新增产品上限。

研发方向，可选一个仓库验证“飞书问题反馈 → 读取既有项目知识 → 复现与修复 → PR/测试证据 → 后续评审反馈”。先验证知识查询，再验证任务输入与结果回传；按照已存在的授权和验收要求执行。两步分别成功后，才可宣称形成了 HomeAgent 与原型的完整任务闭环。

对于单步问答、提醒和按时带读，继续复用已有路径；只有确实涉及并行目标、事件跟进或跨日工作，才增加 Router/Worker 调度。采用这一架构思路可以继续使用 HomeAgent 已有 Codex/Claude Provider；是否引入 Harness 是另一个独立的实现选择。

## 运行依赖、费用与未验证项

原型部署需要专用 Harness profile，Node.js 22.19+ 或 24+、pnpm、git、Python、tmux；需要可写 GitHub 用户账号，当前不支持 GitHub App 作为 Agent，也不支持 GitHub Enterprise Server。可选飞书连接依赖 `lark-cli` 与机器人。部署脚本和准备目录流程使用 tmux/sh；虽然 bundle 中有 Windows 的 pwsh 工具分支，这不足以证明原型在当前 Windows 主机已端到端可用。[部署前置条件](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/006-deployment.md)、[平台工具配置](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/cordis.patch.yml)

Harness 支持 DeepSeek、其他厂商以及自定义模型 API；自定义协议有 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages。因此 Super-agent 架构并不要求所有步骤绑定 DeepSeek 模型。Harness 自身仍是开发者预览，文档明确会发生兼容性变更。[模型配置](https://deepseek-harness.github.io/deepseek-harness/en/guide/providers)、[Harness README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.zh.md)

MIT 许可不代表模型调用免费。实际成本应分别统计候选评估/路由、Worker、subagent、知识读取后增加的上下文与重试；本次没有核验价格、跑基准或估算固定月费。也没有验证 MCP 受管会话适配、跨进程双向交付、取消、崩溃恢复、真实飞书或实际任务质量。先以一个真实且可验收的研发场景测出收益，再决定是否引入第二套常驻任务系统。
