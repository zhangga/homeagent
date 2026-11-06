# 已有事项首次聊天规划：真实测试排查与修复

日期：2026-11-06，时间均为 Asia/Shanghai。

后续状态：本文记录的 Codex 收尾阻塞已在同日后续工作中修复，并完成服务重启与两步真实飞书规划/续作验收，
见 [Codex 收尾与聊天自动续作验收](2026-11-06-codex-completion-verification.md)。下文保留修复前的观察与当时验证边界。

## 真实测试发现

用户在飞书直接发送「整理本周项目进展，找出阻塞项，生成周报。」。
服务已在当天 09:38:17 启动；这条消息 09:38:53.439 进入 Chat Run 队列，09:38:53.609 开始执行，排队 170 ms。
消息没有父消息或话题标识，现有标题路由将它关联到活动中的项目周报事项，操作为 `followup`。

持久记录显示本轮响应类别是 `answer`，事项仍没有 `chatPlanRunId`、runbook、下一步或关联 Task Run。
因此这次实际走了普通聊天执行，不能算作自动计划与续作的验收通过。
任务执行期间 `/work` 返回 HTTP 200（一次观测 134 ms），事项详情返回 HTTP 200（一次观测 96 ms）；这些是现场观测，不是性能保证。

## 本次真实运行的另一处阻塞

09:53:55.639 公开事件流记录了 Codex `turn.completed` 对应的轮次完成事件。
09:53:57.057 最终输出文件已生成：2,678 字节，为合法 JSON，包含 `answer`、`grounded`、`usedSlugs`、`gaps`，回答正文 1,172 字符。
随后数分钟观察到 Codex exec 及其启动进程仍存活，Chat Run 仍是 `running`，最终 `delivery=pending`。

这说明最终结果已经产生，但进程退出等待尚未完成。当前 Provider 调用同时等待 stdout、stderr 和进程退出，
所以轮次完成事件本身不会提交 Run 成功或投递最终回复。Codex 为什么未退出尚未确定，本次规划入口修复不改变这个生命周期。
不能把结果文件存在或轮次完成事件当成飞书最终回复已送达，也不能据此标记真实端到端验收通过。

## 根因与修复

自动规划入口原本只接受 `operation=new`。同一句多步骤目标归到已有事项后，即使该事项从未有过计划，也直接走普通回答。

本次修复保持事项归属，允许 `new` 或 `followup` 对尚无 runbook、下一步和 Task 执行记录的事项生成首次计划。
已有手工或自动计划继续保留，不重置已经验收的步骤。普通问答、仅要方案、现有执行审批和结果验收沿用原有行为。

同时修正规划来源在 Chat Run 历史裁剪后的查找：使用实际规划输入，不能退回创建事项的普通输入。
较早的失败规划也不能覆盖后来成功规划的回复位置。没有新增持久化格式或修改实际运行数据。

## 复现与回归

```powershell
bun test packages/app/src/chat-work-planning.test.ts -t 'an existing unplanned item'
```

修复前：2 失败，预期 `work-plan`，实际 `answer`；覆盖直接发消息和回复旧消息。
仅修复入口后：计划与续作断言通过，但历史裁剪后的规划来源断言失败。
完成修复后：2 通过，后续成果仍回复本次规划消息。

新增 5 个回归用例覆盖：上述两种消息入口、手工 runbook 保留、已验收自动计划不重置，以及较早失败规划之后成功规划的来源保留。

已完成的验证：

- 聊天规划测试文件：23 通过，0 失败。
- Windows 相关回归：214 通过，0 失败，9 个测试文件。
- Windows `bun run typecheck`：通过。
- Ubuntu 类型检查：通过，使用 Bun 运行同一 TypeScript 编译器与 tsconfig。
- Ubuntu `bun run evaluate:quality`：14/14 通过。
- Ubuntu `bun run verify:crash-recovery`：通过。
- Ubuntu 非 Core 全量分组：1,370 通过、8 跳过、0 失败，107 个测试文件。
- Ubuntu Core 全量分组：1,171 通过、2 跳过、0 失败，73 个测试文件。
- Ubuntu 全量合计：2,541 通过、10 跳过、0 失败，180 个测试文件。跳过项为真实模型测试及 macOS Swift 检查。
- 本次两处生产源码与测试文件的 SHA-256 和 Ubuntu 验收副本一致。

Ubuntu 分组覆盖命令：

```sh
bun test --timeout 30000 packages/core
bun test --timeout 30000 packages/app packages/web packages/llm packages/connectors packages/orchestrator packages/shared scripts
```

本次没有执行签名、公证、发布、macOS 实机或长时间运行门禁，修复后的真实飞书完整流程也尚未复验。

## 部署与实际复验边界

本轮只读取实际服务和测试消息的记录，代码回归使用隔离数据与替身 Provider / 传输。
修复没有热加载到正在运行的进程，也没有改写或重放这条已接受的真实消息。
重启加载修复后，发送同一个多步骤目标，确认同一事项出现工作计划与下一步，并进入原有续作审批/验收流程。
已有消息的最终状态和修复后的真实飞书复验结果应分别记录，不能用普通聊天成果代替续作验收。
