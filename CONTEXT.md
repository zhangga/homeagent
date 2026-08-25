# HomeAgent domain context

## Space

一个个人或团队知识隔离域。每条 Raw、每个知识页以及相关工作记录只属于一个 Space。

## Raw

未经提炼的原始输入，包括消息、文档、手动导入、任务结果和学习记录。Raw 保留来源、作者、时间、
准入状态、提炼状态及 Agent 处理信息，是知识页 provenance 的根。

## Raw journal

Raw 的权威、可读存储 module。当前状态按 UTC 创建日期写入
`raw/records/YYYY/MM/DD.jsonl`，撤回标记写入 `raw/retractions.jsonl`。修改使用同目录临时文件、
fsync 与原子替换；首次升级从旧 SQLite Raw 回填，之后负责恢复 SQLite projection。

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
