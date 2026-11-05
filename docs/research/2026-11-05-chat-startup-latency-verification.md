# Chat 启动延迟修复与验收（2026-11-05）

> 本页记录较早一轮“启动预热 + 异步表情”的改动。随后真实消息证明：预热未结束时仍会等待约 45 秒。实际冷扫描优化及已取消事项误路由修复见[后续验收记录](2026-11-05-cancelled-work-cold-start.md)。

## 结论与边界

此前把 Skill 扫描移入 Worker，解决了后台页面被同步扫描阻塞的问题，但首次消息仍会触发并等待完整目录校验。上一轮真实目录验收曾记录约 75 秒的首次链路耗时；本轮再次测得首次目录准备 **84.032 秒**，证实温缓存下约 4 秒的测量不能代表冷启动。

本次将这项磁盘工作提前到生产服务启动阶段，在等待飞书连接准备之前启动后台预热。默认 Provider 与已有 Space 的 Provider 去重后复用各自的目录解析结果。预热不调用模型、创建 Run 或授予权限；实际 Run 仍检查目录变化，并冻结自己的完整 Skill 证据与执行配置。

同时移除了另一个可复现的启动阻塞：飞书 THINKING 表情请求原本必须返回后才能开始收录和创建 Run。现在表情异步跟随任务，迟到的表情仍会清理；表情删除也不占用结果送达或下一轮话题的顺序执行位置。停止服务时会等已接受事件结束后再收尾表情。

**这不是免除首次校验。** 如果消息在刚启动、预热尚未结束时到达，仍需等待首次磁盘校验。正常启动后到达的首条消息不再承担首次全目录扫描。历史两条真实消息在进程启动约 89 秒后到达；之前未在这段空闲时间准备目录。

## 实际目录的隔离链路测量

使用 116 个本机 Skill，加 2 个测试 Skill；真实 Engine、Orchestrator、目录 Worker、技能加载器和本地子进程。模型程序与飞书投递使用离线替身，数据目录隔离。独立进程持续请求 `/work` 与 `/healthz`。

| 阶段／消息 | 消息至创建 Run | 消息至 Run 进入执行 |
| --- | ---: | ---: |
| 服务启动时的目录预热 | 84.032 秒，发生在消息之前 | 无模型调用 |
| 预热后的第一条消息 | 231 毫秒 | 286 毫秒 |
| 并行消息 A，包含按需技能加载 | 309 毫秒 | 380 毫秒 |
| 并行消息 B，普通问答 | 395 毫秒 | 464 毫秒 |

- 3 条 Run 全部成功，投递状态均为 `sent`，每条保留 118 个兼容 Skill。
- 目录完整扫描计数在消息到达前为 1，全部执行结束后仍为 1。
- 6 次离线路由／生成调用；预热期间没有模型调用，运行后的技能副本全部清理。
- 11,116 次后台请求，最长响应 231 毫秒，覆盖整个慢预热阶段。
- Run 进入执行不等于真实模型首个 token 到达；上述数据不是模型响应速度承诺。

只读飞书表情列表查询，经 HomeAgent 的实际 CLI 包装调用约 1.59 秒返回，没有重新制造真实表情写入。历史表情事件只能证明服务端添加较早，不能单独证明 CLI 返回耗时，因此不把慢表情认定为那次 64–68 秒的唯一来源。

另一次真实目录探测曾被现有冻结证据校验拒绝，报 Skill 快照变化。本次没有放宽这个检查；后续完整探测成功，自动回归也覆盖预热后修改 Skill 会重新解析。

## 回归入口与诊断

```sh
bun test packages/app/src/skill-warmup.test.ts packages/app/src/skill-preparation.test.ts packages/app/src/main.test.ts
bun test packages/orchestrator/src/runtime-multitask.test.ts packages/orchestrator/src/runtime-full-execution.test.ts
bun test packages/orchestrator/src/runtime.test.ts --test-name-pattern 'thinking|reaction|cancel'
bun run typecheck
bun test --timeout 30000
```

回归覆盖：启动即准备多个 Provider 且相同 Provider 只准备一次、并发 Run 复用已校验目录、Skill 修改后的失效与重新冻结、预热失败不授予执行权限、表情迟迟不返回时独立事项可执行和送达、同事项／话题顺序和送达后的 fork、取消、迟到表情清理、停止服务等待清理。

生产诊断新增固定事件 `startup Skill preparation completed`、`chat input preparation started/completed` 和 `thinking reaction completed`，仅记录 Provider、消息／Run 标识及分段耗时，不记录消息正文、凭据或原始 Provider 诊断。消息准备完成事件区分 `captureMs`、`planMs` 与 `preparationMs`。

## 当前验证状态

- Windows 定向回归：预热／完整消息链路／启动入口 11 项通过；多事项与完全访问并发 15 项通过；表情与取消相关既有用例 6 项通过。
- Windows 与 Ubuntu 类型检查均通过。
- Ubuntu 第一轮默认 5 秒测试超时：2,497 通过、10 跳过、3 个超时失败；未将这一轮记为通过。最终版本使用之前验收采用的 30 秒测试超时重新验证：**2,503 通过、10 跳过、0 失败**，177 个文件，728.17 秒。测试框架超时调整不改变生产 AI 超时。跳过项为真实模型调用和 Linux 不支持的 Swift helper 检查。
- 尝试在确认无活动任务后重启本地服务，自动审批返回 `blocked by policy`，未执行停止／启动。当前进程仍是旧实例，修复需手动重启后生效。
- 未执行新的真实飞书写入或真实模型调用；离线验收不替代加载新版后的真实消息验收，也不代表签名、公证和发布门禁通过。
