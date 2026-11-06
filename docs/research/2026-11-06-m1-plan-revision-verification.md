# M1 计划修订开发与验收记录

日期：2026-11-06（Asia/Shanghai）。开发基线 `71f0c87`，分支 `codex/m1-plan-revisions`。
范围为 [演进方案的 M1](../superpowers/specs/2026-11-06-homeagent-super-agent-evolution-design.md)：用户补充要求修订剩余计划，保留已验收成果，同事项顺序执行。M2 自动遇阻重规划、M3 Worker 与 M4 Harness 不在本轮范围。

## 实现与恢复契约

- 新增不可变 WorkPlanRevision 文件及稳定步骤 ID，WorkItem 原子切换当前引用和兼容投影；WorkAction 冻结原版本、步骤摘要和计划摘要。
- 首次规划和修订使用同一提交路径。补充在运行中或待验收时持久排队，当前边界结束后按序规划；迟到模型结果不能覆盖新的人工计划。
- 待审批步骤未变则保留 Run；变化则正常取消旧 Run，新步骤单独审批。已验收动作保持不变；新版本回执送达后才领取下一步，首次规划来源继续决定成果投递话题。
- 暂停、关闭自动续作、取消、人工 runbook 和原有单次聊天路径保留。工作台展示版本、变更来源、完成标准及最近 20 次修订；人工编辑按空行分隔步骤，保留多行完成标准，旧表单不能恢复已消费步骤。
- WorkItems v3 读取 v1/v2，WorkContinuation v2 读取 v1；Space archive v22 携带已提交版本链，兼容旧版归档，剥离本机投递门禁和执行权限。定义孤立、指针写入失败、恢复/删除及错误图校验均有回归覆盖。

## 离线测试

固定源码先复制到 Ubuntu 24.04，再开始分组测试，测试期间未修改该源码。Windows 与 Ubuntu 对 17 个变更 TypeScript 文件逐一核对 SHA-256 一致。
源文件快照 SHA-256：`3c6acda847e64e339ba546904edb82d205ad4d4168f17b06450c2151ec047942`。

- Windows 重点回归：153 通过、0 失败（7 个文件）；随后补充的结构化步骤投影失败恢复与归档来源检查分别通过。
- Windows 工作台/治理重点回归：8 通过、0 失败。
- Windows 与 Ubuntu `bun run typecheck`：通过。
- Ubuntu `bun run evaluate:quality`：14/14 通过。
- Ubuntu `bun run verify:crash-recovery`：通过，SIGKILL 后运行中 Task 标为 failed，Raw、提醒和学习状态保持正确。

| Ubuntu 固定源码分组 | 通过 | 跳过 | 失败 | 文件数 |
| --- | ---: | ---: | ---: | ---: |
| `packages/core` | 1174 | 2 | 0 | 74 |
| `packages/app packages/orchestrator` | 513 | 5 | 0 | 41 |
| `packages/web` | 393 | 0 | 0 | 22 |
| `packages/llm packages/shared packages/connectors scripts` | 493 | 3 | 0 | 45 |
| 合计 | **2573** | **10** | **0** | **182** |

各组命令为 `bun test <上述路径> --timeout 30000`。新增用例覆盖执行中补充、连续两条补充、相同文字不同步骤、审批期间修订、待验收重启、末步验收时仍有补充、并发人工修改、人工修改运行中的后续步骤、旧表单、暂停/关闭续作、完成后新增工作、回执失败重试、投影失败恢复和完整版本链归档。

中间失败保留说明：归档升级初跑有两处旧 v21 断言，已改为当前 v22 并通过；暂停用例起初缺少假 transport 的管理员身份，已按真实入口补齐；新增故障注入测试使用 Bun 的异步 `.rejects.toThrow` 时等待超时，改为直接捕获异步失败后通过，没有修改生产恢复逻辑或缩短模型时限。

## 升级和真实飞书闭环

检测时本机 3000 端口未监听。启动前将停止状态的数据目录完整复制到 `C:\work\backups\homeagent\before-m1-20261106-151443`，2,542 个文件逐个 SHA-256 验证一致，源数据未手工修改。
15:15:56 启动新版服务，PID `34908`，数据目录 `C:\work\github\wiki`，显式 `HOMEAGENT_LIVE=1`。
`/healthz` 正常；`/readyz` 的 `ready=true`，飞书消费者与 AI runtime 为 ok。历史知识隔离、Wiki Maintenance 和源码启动方式的降级提示仍保留，不把这些既有状态误报为全部健康。

用户在「工作AI」群亲自发送目标与补充，两步执行审批均记录为飞书用户决定；代理通过正常管理接口检查结果并验收，没有绕过审批或修改持久文件。

| 证据 | 标识或结果 |
| --- | --- |
| 事项 | `work_c25120c3-f503-8c3d-25f5-b7eecfbbc609` |
| 原消息 | `om_x100b61e3bea4b4a0df7cf69a837ceda` |
| 原话题 | `omt_1988f7cfb58f1a5b` |
| 初始规划 Run | `chat_run_c25120c3f5038c3d25f5b7eecfbbc609cb8dbfe962d86b0bc41831957260a8da` |
| 首步 Run | `run_f51c4c22-3564-4325-8554-27e06c615d0d` |
| 首步 Action | `action_0b4c3a30-0a7c-4533-8dfd-22d9f62877e6` |
| 补充消息 | `om_x100b61e3b9629cb0c13c312683d9382` |
| 修订 Run | `chat_run_2d4ea8a451adeca73ae5aa967e1cc0a770da409fd5a0bb84bacdf28a15fd5bc5` |
| 修订回执 | `om_x100b61e3b2565480c45be46e1a5a875`，发送 1 次 |
| 第二步 Run | `run_7e1b7803-7e8c-4172-992f-1369582caa3d` |
| 第二步 Action | `action_2a3b110a-c85b-4b73-8106-f5115009ce5a` |
| 最终成果消息 | `om_x100b61e3b09f6ca0cd3ad31230af74d` |

初版准确生成“汇总”和“摘要”两步。首步得到 12＋5＋3＝20。补充到达时首步正在等待结果验收，输入持久保存为 waiting 并收到排队回执；没有提前运行原第二步。
接受首步后，修订版本 2 只保留“复用汇总、生成 100 字以内摘要、包含完成率和阻塞占比”一步。首步仍关联版本 1，原 Run、checkpoint 与 Raw 不变；第二步使用版本 2 的新步骤 ID。

最终正文：

> 「M1修订复测1106」进展：已完成12项、进行中5项、阻塞3项，总数20项；完成率60%，阻塞占比15%。

正文 54 个字符，3 项结构化检查通过，无 blocker。接受第二步后 `phase=completed`、`active=false`、`nextActions=[]`，恰有两个成功动作和两个验收 checkpoint。
通过 `lark-cli im +threads-messages-list --as bot --no-reactions` 实际读回原话题，9 条消息、`has_more=false`，包含原目标、补充、过程卡、排队回执、两个计划回执及两份成果，确认实际送达。
成果通知发生在执行完成、等待验收时；验收后工作台显示完成，额外的聊天终态通知属于 M2，本轮未新增。
工作台在补充排队阶段采样 HTTP 200、45 毫秒；事项详情显示版本和进展校验字段。该单次采样不作为负载基准。
跨过后续调度周期再次核对，仍为两个成功 Task Run、两个 Action 和两个各发送一次的成果通知，没有重复动作。两份成果的 Raw journal 均已通过验收从 held 正常转为 ready；本机输入队列 pending/waiting/interrupted/receiptFailures 均为 0，服务与飞书消费者继续就绪。

## 验证边界

真实链路覆盖完全访问 Agent、飞书原话题补充、待验收排队、修订、独立执行审批、成果验收与原话题投递；运行中补充、同时补充、异常恢复及人工编辑由确定性集成回归覆盖。
macOS 实机、12 份历史真实归档迁移、长时间 soak、签名、公证和发布门禁未在本轮执行，不据此宣称完整发布就绪。现有 Ubuntu 普通回归中的真实模型和 macOS 专属跳过项不计为通过。
