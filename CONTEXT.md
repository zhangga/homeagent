# HomeAgent domain context

## Space

一个个人或团队知识隔离域。每条 Raw、每个知识页以及相关工作记录只属于一个 Space。

## Provider topic conversation

飞书群里的一个话题由 `chatId + rootMessageId` 唯一定位。冻结 Provider 为 Codex 的普通话题问答会把
该话题绑定到一条 Provider 原生会话链：首轮新建，后续每轮从最近一次已提交的会话 fork。链中只包含
真正进入回答阶段的用户 turn 和 Provider 回答；未触发回答的群消息、路由/分类调用以及 HomeAgent 的
静态回复不会被伪造成 Provider 历史。当前消息显式回复的正文或图片仍可作为本 turn 的不可信来源上下文
传入，这不属于历史重放。Claude、TRAE、Dream、学习、质量重评、私聊和非话题调用仍是互相隔离的
一次性 Provider 调用。

HomeAgent 只在本机 `config/chat-runs.json` 保存有界的话题路由、兼容摘要和最近一次成功的 Provider
会话 ID。新回答产生的 child 与 Chat Run 成功状态必须在同一次原子提交中暂存；只有外发
`delivery.status=sent` 也持久化后，该 child 才能成为下一轮 parent。外发失败、送达状态不确定、回答失败、
取消、超时或进程中断都不得推进可复用路由，避免未确认送达或未提交的 Provider turn 污染下一轮。无法恢复 Provider 父会话时废弃旧路由，下一轮
重新开始；产生未进入 Provider 历史的静态产品回复时也废弃旧路由，避免后续 turn 错认上下文。
Agent revision、Instruction、Provider、Model、Permission、Workdir 或 Skill 证据变化时兼容摘要变化，
下一轮必须新建会话。应用使用同一数据目录重启时可以继续；映射不属于 Raw、Knowledge page 或 SQLite
projection，也不进入 `homeagent.space` 归档，因为 Provider 的本机状态不可移植，归档恢复后的下一轮
会重新开始。

同一群话题可能由多人参与，因此绑定原生会话的回答只读取对应 Team Space，不能把任一发送者的 Personal
Space 内容写入共享 Provider 历史。消息撤回、Space 删除或其他会使历史内容失去授权的治理操作必须废弃
相关路由；这只阻止 HomeAgent 再次引用该会话，Provider 自己在机器账户下保留的数据仍由对应 CLI 管理。

双模式的工程契约区分应用层 Space 路由与操作系统文件隔离：`isolated` 原生话题要求文件隔离证明；
`local-full-access` 仅可由冻结发布版本与持久化本机确认授权，且每次模型进程启动前重验。后者仍不得
主动注入其他 Space，但 Provider 工具可以访问进程账户有权读取的文件和网络，Workdir 不是访问控制。
当前已落地 Provider 策略、AgentStore 本机确认、真实范围摘要、冻结计划、逐进程门禁及管理页确认/撤销。
管理表单不直接提供确认来源或范围：独立 POST 校验同实例表单令牌、来源与版本，可信 Core 重算真实范围并原子发布；GET/草稿不授权。
默认 CLI 检测不执行隔离探针；显式机器隔离诊断不等于具体 Agent 的准备状态或实际调用通过，后两者不能由 CLI 可连接推断。
`AgentReadiness` 是内存中的诊断缓存，不属于 Raw 或持久化执行授权，不进入 Space 归档。显式无模型检查使用当前发布配置及完整 Skill，检查前后比对版本、范围、路径身份和内容。
缓存最多 256 项/60 秒，最多并发两个检查；身份/配置变化和取消后的迟到结果不能覆盖当前状态。相同 Skill 内容/路径的刷新可保留其他 Agent 的旧结果，但不延长原有效期。
健康接口不触发 Agent 检查。所需原生群聊、个人完全访问或启用的完全访问 Task 有已知配置失败时阻止就绪；未知/过期只降级提示，不被称为准备通过。后台/Provider 运行健康独立判断。
Core 在异步准备后、每次模型启动前同步复验确认/范围、Task 正向审批、冻结 Workdir 和 Skill；校验到进程取消句柄注册不让出事件循环。
授权相关 Store 只有在持久化提交成功后通知在途调用。撤销、解绑、策略变化或关闭 Engine 会取消相关调用，返回的迟到结果不被接受；已发生的外部效果不能回滚。
旧 full 和确认失效的 queued/awaiting_approval Run 在恢复/执行入口明确失败或取消；手动重试保留原计划及执行时限，高权限审批不复用。
Task 后 Dream 使用冻结 Provider/model 的独立无工具调用，完全访问历史质量重评首版固定拒绝。

## Local execution grant

本机完全访问确认与 Agent 发布版本在 `config/agents.json` v5 的同一次原子提交中保存，但使用独立的
`localExecutionGrants` 集合，不属于可导出的 Agent 或 revision snapshot，也不是 Raw、Knowledge page 或 SQLite projection。
确认绑定唯一的 release/rollback revision，包含有界的来源、条款版本、确认时间、Chat scope 摘要、Task 开关和撤销状态。
草稿、普通 update 和 Space 恢复不产生确认；回滚完全访问必须生成新 revision 并重新确认。切回隔离撤销该 Agent 全部旧确认，删除 Agent 移除其确认。
正常读取主文件保留有效确认；仅从备份恢复时，先原子保存有效确认的撤销结果，再开放 Store，以免旧备份复活已撤销授权。
新发布触及每 Agent 100 条、集合 10,000 条或紧凑 UTF-8 JSON 16 MiB 上限时，AgentStore 在同一候选提交中清理最旧的无引用确认。
Core 从完整的非终态 Chat/Task Run 元数据读取引用，并对原生预检、整轮普通问答和独立客户端调用临时计数；当前/候选发布版本与新确认也不能被清理。
引用读取未知、Engine 已关闭或全部记录受保护时拒绝超限发布，失败落盘不替换内存、不发送提交通知。临时引用只阻止淘汰，不产生授权，也不阻止显式撤销。
终态 Run 与 Agent revision 不因清理而改写，旧历史不能用已淘汰确认恢复执行；没有可信引用读取器的独立 AgentStore 保持超限拒绝，不自行猜测引用。
空间归档 v20 保留执行模式意图与版本历史，但不携带本机确认、确认 ID 或范围。整份数据目录复制不等于 Space 归档，首版不能识别所有跨机复制或目录回退，应重新确认。

`config/spaces.json` v1 的 `agentBindingEpoch` 与 Space 的 Agent/回复策略绑定一起原子保存；
`config/feishu-group-bindings.json` v3 的 `executionScopeEpoch` 与 Bot、群、连接状态和响应策略一起原子保存。
策略改回原值也生成新 epoch；正常重启保留，名称/健康检测不轮换，Space 导入重新生成。epoch 不进入 Space 归档。
Core 从这些真实持久化状态生成最多 256 个 scope，并在确认发布时重新比较摘要；客户端不能指定授权范围。
新执行计划 v2 使用 `localExecution` 固定确认 ID 和调用类别（Chat 包含 scope，Task 不含 Chat scope）。
这只是引用，不是执行许可；仍须在每次启动前读取实际确认并检查 Task 审批。旧计划 v1 保持原形，不补默认模式。
归档使用单独的 `ArchivedExecutionPlan`（`version=2, archiveVersion=1`）保存历史意图，剥离本机授权关联；
只能作为终态历史存储，执行、重试和重评入口不接受它。它不是 Raw，也不改变知识内容的权威归属。

## Run event journal and live projections

Chat Run 的实时展示以本机 `runs/chat-events/<runId>.jsonl` 为权威事件流。每个事件在单个 Run 内按
`seq` 单调递增，先 fsync 再通知订阅者；管理后台使用 snapshot + SSE 按 `after/Last-Event-ID` 重放。
公开事件只包含生命周期、阶段、公开工具类型/状态、回答增量与投递状态，不记录模型 reasoning/thinking、
完整命令、工具输出、文件路径或凭据。最终回答仍以 ChatRun.output 为校准源。

飞书实时过程是同一事件流的可失败投影：Connector 先创建 CardKit Card 2.0 实体并回复到原话题，随后以
Bot 身份按序、合并和节流地更新同一实体；运行态开启 streaming mode，终态关闭。过程卡展示公开步骤、
阶段性说明和工具调用计数，但不展示隐藏推理、完整命令或工具输出。过程卡与最终 Markdown 回答是两个独立投影；
过程投影失败会记录 operator 事件并回退，但不能吞掉最终回答。`delivery.liveReply` 保存 provider、messageId、
可选 cardId、revision 与 lastAppliedSeq，旧 ChatRun 记录缺失 cardId 仍可按旧 message patch 路径收尾；
该字段不参与 Provider 原生会话提交条件。只有最终回答成功投递且 `delivery.status=sent` 持久化后，Provider
child 才能成为下一轮 parent。管理后台默认仅本机可达，因此未配置受认证的公开 HTTPS 地址时，过程卡不生成
详情跳转；当前也不暴露未经验证的卡片 callback 取消/重试入口。
## Provider execution evidence

Chat Run 可在本机 `config/chat-runs.json` 附带有界、脱敏的 Provider 工具执行证据；这不是 Raw、
Knowledge page 或话题历史。证据仅保留工具类型、状态和可明确识别的飞书只读操作元数据，不保存命令或
输出正文，不进入 Space 归档或模型上下文。缺少、截断或未识别的证据不能被解释成未调用工具或没有权限。
Codex 话题隔离预检失败必须停止；不得自动替换为无状态调用或改变冻结权限。
新运行还可记录已识别的运行准备失败：固定原因码与隔离测试退出码，或 Skill 副本总预算超限时的请求数/已准备数。
这仍属于本机运行证据，不是可移植 Space 内容；旧记录缺少该字段时保持未知。副本准备必须完整符合冻结 Skill 目录，不能因总预算不足而静默删减目录并继续调用。
新证据还可记录选定的 executionMode、sandboxCheck、effectiveSandbox，以及进程是否启动、是否收到可验证的
模型回答事件。`not-applicable` 表示未使用沙箱，不是隔离通过；只有 CLI 启动或普通文本输出时，不推断模型调用已验证。
Chat 文件新写入 v8，读取 v1–v8；Task 文件新写入 v13，读取 v2–v13。新格式无效记录、损坏文件与未来版本拒绝启动，不能按空历史覆盖。
旧 v1 计划仍使用 topic compatibility v1，v6/v7 已送达会话可继续；新 v2 计划使用 compatibility v2，模式、确认引用及 scope 都参与摘要。
当前 Space 归档为 v20，仍不包含本机执行证据；历史 v1 计划按其原形保留。

## Raw

未经提炼的原始输入，包括消息、文档、手动导入、任务结果和学习记录。Raw 保留来源、作者、时间、
准入状态、提炼状态及 Agent 处理信息，是知识页 provenance 的根。

## Raw journal

显式要求保存飞书群聊天原文的 Chat Run 可在冻结的可写 Workdir 中生成 `homeagent-chat-raw-<随机 ID>.json`
交接文件。Core 只接受仍在运行、授权和发起请求群绑定均有效的 Team Space 交接；按完整 schema 和有界文件验证后，
把消息正文、作者、来源时间、线程与附件引用存为 `source=manual` 的 Agent 来源快照，不能声称是 Connector
独立验证的事件。附件二进制不下载，原文不由模型摘要替代。来源 metadata 使用正文内 `homeagent.chat-source` v1，
不改变 Raw journal 或 Space archive schema；外部消息 ID 保存在 Raw 的 messageId，便于现有撤回治理。
Raw.space 始终是发起请求的 Space，Raw.chatId 是实际来源群，可以不同。显式跨群收录的授权规则是：当前或同话题此前的用户输入
明确要求保存原始记录且声明单一来源群名或 ID；Core 从已保存的用户请求解析保存意图和来源，交接 ID 或 chatName 必须匹配该范围。
同话题由既有路由计划的 Space、chatId、rootMessageId 确定；只使用截至当前 Run 的保留输入，当前改群或取消保存覆盖此前要求。
在群消息查询语境中，“记录相关信息”“保存相关数据”等保存动作同样构成保存要求，不以用户是否说出“原始／原文”为条件；普通查询以及明确只保存总结不触发群原文收录。
该解析仅恢复应用的入库流程，不重建 Provider 对话历史，不继承旧交接文件路径或模型回答中的基线；无需新增持久化格式。
未声明外部来源时仅接受当前群。查询时不以回答所在群替换目标群，不读取或合并其他 Space 的既有知识，也不写来源群 Space。
来源名称和内容匹配属于 Agent 提交证据，不等于 Connector 独立验证。导入记录对发起群知识库的成员可见。
未编辑消息的入库 id 由 Space、群和消息 ID 确定；来源返回有效 updatedAt 时再加入编辑时间生成独立版本 id。
重试只修复已提交记录缺失的 SQLite projection，不覆盖旧正文或准入状态；旧版本可继续被历史知识页引用。
Dream 将这类来源标为 chat-source-snapshot，按同消息编辑时间区分新旧，不赋予管理员纠错优先级。
校验失败不写入；跨多条的持久化失败允许已有原子提交保留并明确报告未完成。成功消息进入现有 Dream queue；
未取得正文的失败 ID 不会单独伪造成正常消息。交接文件保留覆盖声明与失败清单，第一条正常 Raw 也保留失败 ID；
每条 Raw 都保留窗口、覆盖标志和失败数量。可选 updatedAt 属于来源 metadata，不改变 journal/archive schema。

Space 目录下 `.chat-source-progress.json` v1 是本机查询工作流状态，不是 Raw 或 SQLite projection，不进入 Space 归档。
显式来源选择器（规范化群名或群 ID）使用 `.chat-source-progress/<选择器 SHA-256>.json` 独立进度；scope 同时绑定选择器。
可选 sourceChatId 保存实际来源群 ID；解析结果变化时重建进度，不能合并不同来源的窗口。别名重新查询不影响 Raw 按实际来源 ID 去重。
其 scope 绑定 Space、群绑定 epoch 与 Agent 绑定 epoch；绑定变化不复用旧进度。每群有界保存 retryStartAt、pendingThrough、
可选 coveredThrough 和最多 1,000 个 failedMessageIds，文件上限 512 KiB；读取拒绝损坏、未来版本、超限和链接。
在 Space serializer 内先原子登记未完成窗口，再写 Raw，最后只有全部 Raw 提交且查询声明完整时才提交新基线。
失败保留原基线和待补查区间；并发完成时重新读取合并，新局部窗口不能跳过旧缺口。进度文件缺失时从用户指定范围重新查询，
不从聊天回答中的截止时间推导游标。删除 Space 一并删除该状态；归档导入后从新绑定与明确请求重新建立基线。
覆盖声明仍由 Agent 提供，不能视为独立验证的飞书完整性水位。补查通过后续显式请求内的 Skill 查询执行，不创建后台任务。

Raw 的权威、可读存储 module。当前状态按 UTC 创建日期写入
`raw/records/YYYY/MM/DD.jsonl`，撤回标记写入 `raw/retractions.jsonl`。修改使用同目录临时文件、
fsync 与原子替换；首次升级从旧 SQLite Raw 回填，之后负责恢复 SQLite projection。
SQLite projection 的 `raw_fts` 使用与知识页一致的中文双字分词，供显式 Raw 原文查询预筛选；只返回 `ready` 且未撤回的记录。
原文查询不需要已生成的 Knowledge page。现有数据库首次创建该 FTS 时回填 Raw；重开有 journal 的 Space 或重建 SQLite 后，从 Raw journal 恢复索引。
Raw 和 FTS 的 SQL 写入在同一事务中；权威 journal 已提交而 SQL 投影失败时，沿用重开恢复路径。查询结果的原文摘录需通过逐字匹配，来源字段由 Raw 生成，不把 Raw 引用伪装成知识页 slug。

手动上传或对话收录的原文件按 SHA-256 内容寻址，不可变地保存在同一 Space 的 `raw/sources/`；
Raw attachment 保存摘要、字节数和文件名。提炼文本可以有独立的模型输入上限，但不得截断或替代原文件。
原文件随 `homeagent.space v20` 归档导出和恢复，Wiki 只保留指向 Raw 的 provenance，不复制文件正文。

## Knowledge page

Dream cycle 从已准入 Raw 提炼出的 Obsidian-compatible Markdown。知识页保留 Raw id 作为 provenance，
并以 `wiki/**/*.md` 为权威数据。

## Knowledge evidence trace

Knowledge page 的 `sources` 指向同一 Space 的 Raw journal，运行时由此派生只读、只含元数据的证据链；
不会在知识页、归档或质量 Trace 中复制 Raw 正文，也不会形成新的权威状态。证据链只有在每个来源 Raw
都存在且保持 `ready` 时才完整；缺失、`held` 或 `excluded` 来源一律 fail closed，并把证据时效标为
`unknown`。完整证据链按最新 Raw 的 `createdAt` 分为 `recent`（不超过 90 天）、`aging`（91–365 天）
和 `stale`（超过 365 天）。这是 provenance 的年龄，不是事实有效期；陈旧证据触发复核提示，不自动让
Knowledge page 失效。问答综合在页面冲突时优先采用证据更新且证据链完整的页面，引用只暴露最新证据时间、
分级、来源数量与完整性，Raw id 和正文仍留在本地追溯界面。系统生成的 Knowledge map 不参与证据链。

## Knowledge map

位于 `wiki/maps/*.md` 的系统生成 Knowledge page，用于在大空间中渐进导航，不作为回答证据，也不持有
Raw provenance。系统按知识页的首个有效标签生成最多 24 个显式主题，其余内容进入按页面类型划分的
兜底主题；单个主题超过 100 个条目时继续递归拆成每页最多 100 项的下级地图。`overview.md` 展示核心主题、最近更新与
结构缺口，`index.md` 只链接一级地图，`glossary.md` 保留完整术语定位。地图由内容元数据确定性、增量地
刷新，过期地图会被删除；SQLite projection 与 LLM 路由仍只负责有界检索，地图不引入 embedding 或
新的数据外发通道。

## SQLite projection

从 Raw journal 与知识 Markdown 派生的本地查询结构，提供结构化过滤和 FTS。`.index.db*` 可以删除后重建，
不再承担唯一的数据所有权。

## Dream cycle

把待处理且已准入的 Raw 批量判断、提炼或跳过，并更新知识页与 Raw 的提炼状态。
生产调度保持单批最多 40 条 Raw，并在一次到期 tick 内最多追赶 4 批；若仍有本轮开始前就已存在的
待提炼 Raw，下一次 15 分钟 tick 会继续处理，不会因当天已经更新 `lastDreamAt` 而等待到次日。
批次失败或没有处理任何 Raw 时立即停止该 Space 的本轮追赶，避免重复消耗 Provider；其他 Space
仍可继续。正常新收录且不属于遗留积压的少量 Raw 继续等待每日提炼窗口。

## Wiki Maintenance cycle

独立于 Dream cycle、待处理 Raw 和 LLM Provider 的只读知识维护检查。它按 Space 确定性扫描知识页，
报告断链、孤立页、重复标题或别名、超大页、没有 Raw 来源的不可追溯页、最新完整证据超过 365 天的
陈旧页，以及缺失或未准入的 Raw provenance；不自动改写知识页。
生产调度器启动时补跑，此后每周运行一次，并持久化最近一次完成时间和有界结果摘要。

## Local Agent read interface

供同一台机器上的其他 Agent 复用已提炼知识的只读应用层 seam。它不是新的权威存储：运行中的
HomeAgent 仍从 Knowledge page 读取正文、从 Raw journal 派生 provenance，并只使用现有 SQLite
projection 做有界 FTS。MCP stdio 与 JSON CLI 是固定本地 HTTP 查询端点的代理，不直接打开、迁移或
修改数据目录，也不调用 LLM Provider、消耗模型 token 或创建运行记录。

读取必须先选择一个显式 Space，再按 `overview → map/search → page → trace` 渐进展开；接口不提供跨
Space 联合查询。普通 page 只附有界证据摘要，只有显式 trace 才返回同一 Space 的 Raw id 与准入、来源、
时间等元数据，永不返回 Raw 正文以及 Raw 的 chatId、messageId 或工作归属字段。显式 SpaceId 仍是每个结果
的隔离标识。所有工具声明为 read-only，输入、输出和结果数量
均有上限；page 正文超过 200,000 字符时显式标记为截断。端点沿用管理服务的回环/鉴权边界，可选的环境变量专属 read token 只能访问该查询路径，不能访问
管理或治理接口。当前 read token 代表本机操作者级的全 Space 读取授权，不是按 Agent 或 Space 细分的 ACL。

## Knowledge consumption feedback

同一台机器上的 Agent 复用 Knowledge page 后，可把 `helpful`、`not_found`、`incorrect`、`stale`、
`conflicting` 或 `hard_to_reuse` 反馈写入所属 Space 的独立治理 module。页面反馈绑定读取接口返回的
`slug + revision`；搜索未命中反馈绑定一个有界 query。每条提交由 consumer 与 idempotency key 去重，
持久化在该 Space 的 `governance/agent-consumption-feedback.json`，并随 `homeagent.space v18` 归档。

该反馈不是 Raw 或 Knowledge page，不进入 SQLite projection，也不能直接触发 Dream cycle、Wiki Maintenance
改写或 Provider 调用。`helpful` 自动确认为正向信号，其余反馈进入本机人工治理队列。处置为“知识页已变更”
时必须验证当前 Knowledge page revision 与 Agent 当时消费的 revision 不同；确认有效、补充覆盖计划、重复或
无需处理都必须保留人工说明。健康摘要只暴露按状态和类型聚合的数量，不包含 query、note 或知识正文。

反馈 HTTP 路径使用独立的环境变量专属 feedback token；它不能调用六个读取工具或管理页面。MCP 只在写入口
可用时额外声明 `submit_knowledge_feedback`，并保持六个知识读取工具的 read-only 契约不变。
