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

## SQLite projection

从 Raw journal 与知识 Markdown 派生的本地查询结构，提供结构化过滤和 FTS。`.index.db*` 可以删除后重建，
不再承担唯一的数据所有权。

## Dream cycle

把待处理且已准入的 Raw 批量判断、提炼或跳过，并更新知识页与 Raw 的提炼状态。
