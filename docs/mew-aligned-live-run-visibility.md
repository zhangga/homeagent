# HomeAgent 对齐 Mew：实时输出、飞书状态卡片与平台执行轨迹技术方案

- 状态：设计提案，待评审
- 目标仓库：`C:\work\github\homeagent`
- 交付范围：技术设计，不修改生产代码
- 核心目标：同一个 Chat Run 的进度、可公开执行步骤和最终结果，在飞书机器人消息与 HomeAgent 管理平台中实时一致地呈现

## 1. 结论

HomeAgent 不需要重建执行系统。现有代码已经具备以下关键基础：

1. `ChatRun` 持久化状态机：`queued → running → succeeded / failed / cancelled / timed_out`。
2. 飞书投递状态：`pending / sent / failed`，以及幂等回复与重试。
3. Provider 执行证据：Codex JSONL 中已完成的工具事件、进程/模型验证状态。
4. Chat Run 详情页、取消和重试入口。
5. Codex `--json` 事件输出；本机 Claude CLI 也支持 `stream-json` 与 partial messages。
6. 飞书支持发送 interactive 卡片，并以 Bot 身份 `messages.patch` 更新已发送卡片。

真正缺少的是一条贯穿 Provider、Core、Feishu 和 Web 的统一增量通道。推荐新增 **Run Event Journal**，把它作为“可展示执行轨迹”的唯一来源；飞书卡片与平台页面都是这个事件流的投影。

不要把模型隐藏推理或原始命令直接展示给用户。所谓“详细执行步骤”限定为：排队、准备环境、调用 Provider、工具类型、工具状态、阶段结果、交付状态、错误类别和最终答案增量。

## 2. 当前实现与差距

### 2.1 当前链路

```text
Feishu event
  → FeishuConnector.normalize
  → Orchestrator.startChatRun
  → ChatRunStore.start / begin
  → KnowledgeEngine.askWithExecutionPlan
  → runProviderDetailed
  → 等待 Provider 进程全部结束并一次性读取 stdout
  → ChatRunStore.succeed / fail
  → FeishuConnector.reply（一次性 markdown 回复）
  → ChatRunStore.deliverySent / deliveryFailed
```

### 2.2 已有可复用能力

| 能力 | 当前位置 | 复用方式 |
|---|---|---|
| Chat Run 状态与冻结执行计划 | `packages/core/src/chat-runs.ts` | 继续作为运行摘要和业务状态权威 |
| 排队、超时、取消 | `packages/orchestrator/src/runtime.ts` | 状态变化时同时追加规范化 RunEvent |
| Codex JSONL | `packages/llm/src/providers.ts` | 改为逐行解析，不再等完整 stdout |
| 执行证据脱敏 | `packages/llm/src/execution-evidence.ts` | 抽取器复用到增量事件，终态仍保存现有证据摘要 |
| 飞书幂等回复 | `packages/connectors/src/feishu.ts` | 扩展成 interactive 卡片的 create/patch/finalize |
| Chat Run 详情页 | `packages/web/src/app.ts`、`views.ts` | 增加 SSE 订阅和时间线渲染 |
| 取消/重试 | Web + Orchestrator | 同时暴露为飞书卡片动作 |

### 2.3 核心差距

1. `runCmd()` 通过 `new Response(proc.stdout).text()` 等进程结束后才返回，无法实时消费事件。
2. `ProviderRunResult` 只有最终文本、用量和会话 ID，没有增量事件回调。
3. `executionEvidence` 只在调用结束后写入 Chat Run，无法驱动实时 UI。
4. `Connector` 只有 `reply/notice`，没有“创建可更新消息、更新消息、结束消息”的能力。
5. Chat Run 详情页是服务端静态渲染，没有 SSE/WebSocket 增量订阅。
6. 没有卡片消息 ID、卡片版本、最后投递序号、限流状态等持久化字段。

## 3. 设计原则

### 3.1 单一事件源，两个投影

所有实时展示均从同一条规范化事件流读取：

```text
Provider stdout/stderr
       │
       ▼
Provider Stream Adapter
       │ 规范化、脱敏、排序
       ▼
Run Event Journal ───────────────┐
       │                         │
       ▼                         ▼
Web SSE Projection        Feishu Live Card Projection
       │                         │
       ▼                         ▼
平台执行详情页             原消息下的实时状态卡片
```

- `ChatRun`：继续保存业务状态、最终输出、冻结计划、最终执行证据和最终投递结果。
- `RunEvent Journal`：保存可展示时间线；不替代 Raw、Knowledge page 或 Provider 原生会话。
- 先持久化，再广播。Web 或飞书消费者故障不能回滚 Provider 执行。
- 两个投影均以 `runId + seq` 去重和追赶，不各自解释 Provider 原始输出。

### 3.2 安全展示边界

允许展示：

- 生命周期：排队、准备、运行、等待确认、完成、失败、取消、超时。
- 阶段：解析上下文、准备 Skills、检查权限、启动 Provider、工具执行、生成回答、投递。
- 工具：类型、开始/结束时间、成功/失败、耗时、脱敏摘要。
- 飞书只读操作：现有 `execution-evidence.ts` 已识别的操作类型、身份类型、结果数量和分页状态。
- 最终答案的文本增量。

禁止展示或落入 RunEvent：

- 模型 chain-of-thought、reasoning/thinking 原文。
- 完整 shell 命令、完整工具参数和工具原始输出。
- Token、App Secret、认证码、环境变量值。
- 绝对路径、群名、用户标识等现有证据模型已刻意移除的敏感信息。
- 未经验证的“完成”结论；命令退出 0 仍只表示命令完成。

## 4. 统一 RunEvent 模型

建议在 `packages/shared/src/run-events.ts` 定义跨包只读协议。

```ts
export type RunEventKind =
  | "run.queued"
  | "run.started"
  | "phase.started"
  | "phase.completed"
  | "tool.started"
  | "tool.completed"
  | "assistant.delta"
  | "assistant.snapshot"
  | "artifact.ready"
  | "approval.required"
  | "delivery.started"
  | "delivery.updated"
  | "delivery.failed"
  | "run.succeeded"
  | "run.failed"
  | "run.cancelled"
  | "run.timed_out"
  | "run.recovered";

export interface RunEvent {
  schemaVersion: 1;
  runId: string;
  seq: number;              // 每个 run 严格递增
  at: number;               // epoch ms
  kind: RunEventKind;
  visibility: "public" | "operator";
  phase?: "queue" | "prepare" | "provider" | "tool" | "answer" | "delivery";
  status?: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
  title: string;            // 有界、可直接展示
  detail?: string;          // 已脱敏、有界
  delta?: string;           // 仅 assistant.delta
  tool?: {
    type: "command" | "file-change" | "mcp" | "web-search";
    status: "running" | "completed" | "failed" | "unknown";
    durationMs?: number;
    exitCode?: number;
    lark?: ExistingRedactedLarkEvidence;
  };
}
```

### 4.1 事件约束

- `seq` 在单个 Run 内从 1 开始，严格递增；服务重启后从 journal 尾部恢复。
- 单事件建议最大 16 KiB；`assistant.delta` 单块最大 4 KiB。
- `title` 最大 120 字符，`detail` 最大 2,000 字符。
- 每个 Run 最多保留 2,000 个事件或 2 MiB，先到者触发压缩：连续 delta 合并为 snapshot，工具事件保留首尾。
- `public` 可展示到飞书；`operator` 只在本机管理页展示。
- 所有事件进入 store 前经过 `sanitizeRunEvent()`；拒绝未知字段，避免 Provider 任意 JSON 透传。

## 5. 持久化与一致性

### 5.1 存储布局

建议新增：

```text
<dataDir>/runs/chat-events/YYYY/MM/DD/<runId>.jsonl
```

每行一个完整 `RunEvent`。不放进 `config/chat-runs.json`，避免每个输出块都重写整个运行历史文件。

### 5.2 权威关系

- `chat-runs.json`：运行最终业务状态和发送结果的权威。
- `chat-events/*.jsonl`：用户可见执行时间线的权威。
- Web/UI 根据 `ChatRun + RunEvent[]` 合并显示。
- RunEvent 不进入 Space archive，不进入模型上下文，不成为知识证据。

### 5.3 提交顺序

生命周期事件必须遵守：

1. 先完成现有 ChatRun 持久化提交。
2. 再追加对应 RunEvent。
3. journal `fsync` 成功后通知订阅者。
4. 事件通知失败不回滚已经提交的 Run。

若第 1 步成功、第 2 步失败，平台仍以 ChatRun 摘要为准，并显示“详细时间线不完整”；启动恢复时追加 `run.recovered` 快照，不伪造中间步骤。

Provider 增量事件没有对应 ChatRun 状态提交，可直接“append → fsync → publish”。

### 5.4 清理

- Chat Run 被现有历史保留策略裁剪后，同步删除其 event journal。
- 删除失败只记运维告警，不影响主状态提交。
- 启动时清理没有对应 Chat Run 且超过宽限期的孤儿 journal。

## 6. Provider 流式接入

### 6.1 公共接口

在 `packages/llm` 扩展 `RunInput`：

```ts
export interface ProviderProgressEvent {
  kind: "phase" | "tool" | "assistant_delta" | "assistant_snapshot";
  at: number;
  payload: unknown; // 进入 Core 前必须由 provider adapter 校验成具体联合类型
}

onProgress?: (event: ProviderProgressEvent) => void | Promise<void>;
```

回调只观察，不参与 Provider 授权，不允许改变执行计划；回调失败应记录并继续 Provider，不能中止任务。

### 6.2 流读取改造

把当前一次性 `runCmd()` 拆为：

- `runCmdBuffered()`：保留探针、短命令和兼容路径。
- `runCmdStreaming()`：并发逐块消费 stdout/stderr，执行增量 UTF-8 解码、按行组帧、总量限制和最终聚合。

要求：

- 使用增量 UTF-8 解码（`TextDecoder` 的 `stream: true` 选项），不能假设 chunk 与 UTF-8 字符或 JSONL 行对齐。
- stdout 必须边读边解析且继续保留有界原始结果，供现有最终解析、usage 和 native session 校验使用。
- stderr 始终排空，但只保留有界尾部；不能发送到前端。
- 取消和超时沿用现有 AbortSignal 与进程终止语义。
- observer 慢时不阻塞 stdout：进入每 Run 有界异步队列；队列满时合并文本 delta，不能丢失终态。

### 6.3 Provider 分阶段策略

#### Codex：第一优先级

当前已使用 `codex exec --json`，可直接按 JSONL 行解析：

- `thread.started` → Provider 会话已建立，仅 operator 可见。
- `item.started` → `tool.started` 或阶段事件。
- `item.completed`：
  - `agent_message` → `assistant.snapshot`；若 Provider 没有 token delta，则以消息块级更新。
  - `command_execution / file_change / mcp_tool_call / web_search` → `tool.completed`。
- `turn.completed` → usage/阶段完成。
- reasoning 类事件直接丢弃，不进入 RunEvent。

现有 `collectCodexExecutionEvidence(stdout)` 改成可复用的单行 reducer；结束时仍生成完全相同的 `ExecutionEvidence`，避免现有持久化和页面回归。

#### Claude：第二阶段

本机 CLI 已支持：

```text
--output-format stream-json
--include-partial-messages
```

改造 `buildRun`，仅在调用方提供 `onProgress` 时启用 `stream-json`；否则保留当前 `json`，降低首轮风险。

- 只从 assistant content block 的 text delta 生成 `assistant.delta`。
- thinking/reasoning block 不持久化、不广播。
- tool lifecycle 统一映射为脱敏事件。
- 最终 result 事件仍负责 usage、错误分类与最终文本校验。

#### TRAE：状态级降级

若 CLI 没有稳定机器可读的流格式，只发：`run.started → phase.started(provider) → run.succeeded/failed`，最终文本一次性呈现。不得通过抓取终端装饰文本冒充结构化步骤。

## 7. Orchestrator 改造

新增 `RunEventStore` 和 `RunEventBus`，由 `packages/app` 注入 Orchestrator：

```ts
interface RunProgressPort {
  append(event: NewRunEvent): RunEvent;
  subscribe(runId: string, afterSeq: number, listener: (event: RunEvent) => void): () => void;
  list(runId: string, afterSeq?: number): RunEvent[];
}
```

在以下节点发事件：

| 现有节点 | 新事件 |
|---|---|
| `ChatRunStore.start()` 成功后 | `run.queued` |
| `ChatRunStore.begin()` 成功后 | `run.started` |
| 构建上下文/准备附件 | `phase.started/completed` |
| Provider 预检与启动 | `phase.started/completed` |
| `onProgress` | `tool.*`、`assistant.delta/snapshot` |
| `ChatRunStore.succeed()` 后 | `run.succeeded` |
| fail/cancel/timeout 后 | 对应终态事件 |
| 飞书 create/patch/finalize | `delivery.*` |

`answer()` 内只负责把 Provider progress 转为规范化 RunEvent，不直接调用飞书。这样 Provider 速度不会受飞书 API 延迟影响。

## 8. 飞书 Live Card Delivery

### 8.1 Connector 扩展

不要污染现有 `reply()` 语义；新增可选能力：

```ts
export interface LiveReplyHandle {
  messageId: string;
  revision: number;
}

export interface LiveReplySnapshot {
  runId: string;
  seq: number;
  state: "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "timed_out";
  phase?: string;
  steps: PublicRunStep[];
  answerPreview?: string;
  startedAt: number;
  detailUrl?: string;
  canCancel: boolean;
  canRetry: boolean;
}

interface Connector {
  createLiveReply?(target: OutboundReplyTarget, snapshot: LiveReplySnapshot): Promise<LiveReplyHandle>;
  updateLiveReply?(handle: LiveReplyHandle, snapshot: LiveReplySnapshot): Promise<LiveReplyHandle>;
  finalizeLiveReply?(handle: LiveReplyHandle, snapshot: LiveReplySnapshot): Promise<void>;
}
```

非飞书 Connector 或能力探针不通过时，继续使用现有 reaction + 最终 markdown reply。

### 8.2 卡片布局

采用 Card 2.0，默认宽度，最多五个视觉块：

1. Header：`HomeAgent · 排队中/执行中/等待确认/完成/失败`。
2. 当前阶段：一句话描述，例如“正在检索团队知识”。
3. 最近步骤：最多显示最近 4 条公开步骤，旧步骤折叠为计数。
4. 回答预览：只显示最终回答文本增量，设置字符上限；工具原始输出不进入此区。
5. 操作区：
   - 运行中：`取消运行`。
   - 失败：`重试`。
   - 始终可选：`查看详细执行`（仅配置了可访问的管理页 base URL 时显示）。

### 8.3 创建与更新

创建：

```text
lark-cli im +messages-reply
  --as bot
  --message-id <source>
  --reply-in-thread（按绑定策略）
  --msg-type interactive
  --content @<temporary-card-file>
  --json
```

必须解析并持久化返回的消息 ID，不能只判断退出码。

更新：

```text
lark-cli im messages patch
  --as bot
  --message-id <card-message>
  --data @<temporary-request-file>
  --json
```

本机 schema 已确认 `messages.patch` 支持 bot/user 身份、只允许更新 interactive 消息、消息需在 14 天内且 content 不超过 30 KB。实现时仍需启动探针验证实际已安装 CLI 与应用 scope `im:message:update` / `im:message:send_as_bot`。

所有卡片 JSON 使用确定性的 renderer 构造函数，不能把 Provider 返回内容当卡片 JSON。

### 8.4 节流与背压

建议默认策略：

- 首个 `run.queued` 立即创建卡片。
- 状态切换立即更新。
- 文本 delta 合并后最多每 800 ms 更新一次。
- 工具步骤变化最多每 500 ms 更新一次。
- 内容无变化不调用 patch。
- 同一 Run 的 patch 串行，携带本地 `revision`，旧快照不得覆盖新快照。
- 遇到限流使用服务端返回的重试时间；指数退避，上限 10 秒。
- 最终状态绕过普通节流，但必须排在此前 patch 之后。

### 8.5 Delivery 状态扩展

现有 `delivery` 建议升级为：

```ts
interface ChatRunDelivery {
  status: "pending" | "streaming" | "sent" | "failed";
  mode?: "markdown" | "interactive";
  messageId?: string;
  lastAppliedSeq?: number;
  revision?: number;
  attempts: number;
  lastAttemptAt?: number;
  sentAt?: number;
  error?: string;
}
```

- 卡片创建成功后写入 `messageId` 和 `streaming`。
- 每次 patch 成功更新 `lastAppliedSeq/revision`。
- 最终卡片成功后才写 `sent`。
- `delivery.status=sent` 继续作为 Provider 原生话题 head 可复用的门槛，不能因为“卡片已创建”提前推进会话。

### 8.6 回调交互

卡片按钮 action value 只携带：`action`、`runId`、一次性/有界防重放 nonce；不携带权限、路径或用户资料。

服务端处理顺序：

1. 验证回调签名、来源应用、时间窗和 nonce。
2. 读取当前 ChatRun；不相信客户端提交的状态。
3. 根据原消息/运行归属核验操作者是否允许取消或重试。
4. 调用现有 `orchestrator.cancelChatRun()` 或 `retryChatRun()`。
5. 追加 RunEvent，并刷新卡片。

回调事件接入方式必须通过实际安装的 lark-cli/SDK schema 验证后确定；在该验证完成前，`取消/重试`按钮不能进入生产，只保留平台跳转。

## 9. Web 平台实时详情

### 9.1 保留现有页面

继续使用：

```text
GET /chats/runs/:runId
```

服务端首屏渲染当前 `ChatRun + 最近 RunEvent`，保证 JavaScript 或 SSE 失败时仍可读。

### 9.2 新增接口

```text
GET /api/chats/runs/:runId/snapshot
GET /api/chats/runs/:runId/events?after=<seq>    # text/event-stream
```

SSE 协议：

- `id` = event.seq。
- `event` = event.kind。
- `data` = 经过 Web DTO 再脱敏的 JSON。
- 支持 `Last-Event-ID` 和 `after` 补发。
- 每 15 秒 heartbeat。
- Run 终态并且客户端追平后关闭连接。
- 单进程首版用内存订阅；事件先落 journal，因此重连/重启可追赶。

选择 SSE 而非 WebSocket：当前是服务端单向状态流，SSE 自带断线重连和 Last-Event-ID，Hono/Bun 实现更简单；取消、重试等操作仍走现有 POST。

### 9.3 页面信息结构

1. 顶部：状态、排队时间、运行耗时、Provider、模型、权限、投递状态。
2. 实时答案：只拼接 `assistant.delta/snapshot`；终态以 `ChatRun.output` 校准。
3. 执行时间线：按 seq 显示阶段和工具事件。
4. 执行证据：保留现有终态证据区，用于审计，不与实时事件重复解释。
5. 操作：取消、重试回答、重试投递、按冻结快照重评。

## 10. 状态机

```text
                       ┌──────────────┐
                       │   queued     │
                       └──────┬───────┘
                              │ begin
                              ▼
                       ┌──────────────┐
               ┌───────│   running    │────────┐
               │       └──────┬───────┘        │
          cancel/timeout       │ provider done  │ failure
               │              ▼                 │
               │       ┌──────────────┐          │
               │       │  succeeded   │          │
               │       │delivery=pending         │
               │       └──────┬───────┘          │
               │              │ create/patch/final
               │       ┌──────┴───────┐          │
               │       ▼              ▼          │
               │   sent          delivery failed │
               ▼                              ▼
        cancelled/timed_out                 failed
```

飞书卡片状态是上述状态的投影，不产生新的运行事实。按钮动作只请求状态迁移，最终结果以 Core 提交为准。

## 11. 包与文件级改造清单

### `packages/shared`

- 新增 `src/run-events.ts`：事件联合类型、DTO 限制、脱敏后展示结构。
- `src/index.ts` 导出公共类型。

### `packages/llm`

- `src/providers.ts`
  - 新增 `onProgress`。
  - 引入 `runCmdStreaming()`。
  - Codex JSONL 单行 reducer。
  - Claude 可选 `stream-json + include-partial-messages`。
- `src/execution-evidence.ts`
  - 把整段 stdout 解析器拆成 `reduceCodexEvent()`。
  - 保持最终 `ExecutionEvidence` 兼容。
- 增加针对 chunk 切分、非法 JSONL、reasoning 过滤、慢 observer、取消的单测。

### `packages/core`

- 新增 `src/run-events.ts`：`RunEventStore`，JSONL append、seq 恢复、查询、清理、订阅。
- `src/chat-runs.ts`
  - delivery schema 升级；兼容 v1–v8，写新版本。
  - 暴露 committed-change 或由 Engine 编排生命周期事件。
- `src/engine.ts`
  - 组合 RunEventStore。
  - `askWithExecutionPlan` 透传 progress observer。

### `packages/orchestrator`

- `src/runtime.ts`
  - 生命周期落事件。
  - Provider progress 规范化并写 journal。
  - 启动/结束 `LiveDeliverySession`。
  - 终态仍遵守现有 `delivery.status=sent` 后才提交可续用 Provider head 的约束。
- 新增 `src/run-progress.ts`：事件映射、公开/运维可见性、文本合并。

### `packages/connectors`

- `src/connector.ts`：新增可选 LiveReply 接口。
- `src/feishu.ts`：interactive create/patch/finalize、解析 message ID、Bot 身份能力探针、串行更新。
- 新增 `src/feishu-live-card.ts`：纯函数生成 Card 2.0 JSON。
- 新增 `src/live-delivery.ts`：节流、合并、重试、revision 管理。

### `packages/web`

- `src/app.ts`：snapshot 与 SSE 路由；卡片回调入口（完成真实接入验证后）。
- `src/views.ts`：Chat Run 时间线和实时答案容器。
- 新增 `src/run-events-client.ts`：EventSource、断线重连、seq 去重、终态校准。

### `packages/app`

- `src/main.ts`：组装 RunEventStore/Bus、LiveDelivery、Web 订阅；启动恢复未完成 delivery。

### 文档

- 更新 `README.md`：用户能力和降级行为。
- 更新 `CONTEXT.md`：Run Event Journal、Delivery 投影及权威边界。
- 更新 `docs/beta-release-runbook.md`：真实飞书卡片流式演练与断线恢复门禁。

## 12. 分阶段实施

### Phase 0：能力探针与契约冻结

- 验证真实 Bot 能发送 interactive reply，并取得 message ID。
- 验证真实 Bot 能 `messages.patch` 自己发送的卡片。
- 验证 Card 2.0 更新、30 KB 边界、14 天限制和限流响应。
- 确认卡片动作回调的真实接入模式和事件 schema。

完成条件：有真实测试群中的 create → patch → final 证据；否则只允许状态 reaction + 最终 markdown。

### Phase 1：平台实时轨迹（建议先做）

- RunEventStore + Provider 流读取。
- Codex 事件规范化。
- Web SSE 与实时 Chat Run 页面。
- 终态和重启追赶。

完成条件：不接飞书也能在平台看到排队、准备、工具步骤、回答增量和终态；刷新页面后时间线一致。

### Phase 2：飞书实时卡片

- Live card create/patch/finalize。
- 节流、序号、幂等和失败恢复。
- 仅展示 public 事件。

完成条件：飞书和 Web 对同一 Run 的最终状态、步骤顺序及答案一致；中途断网恢复后不倒退、不重复创建卡片。

### Phase 3：卡片交互

- 取消、重试、查看详情。
- 签名校验、操作者权限、nonce 防重放。
- 动作审计和卡片即时反馈。

完成条件：重复点击幂等；无权限操作不改变 Run；终态 Run 不能再次取消。

### Phase 4：Claude 与兼容降级

- Claude stream-json。
- TRAE 状态级进度。
- Provider capability matrix 与管理页提示。

## 13. 验收标准

### 功能

- 消息到达后 1 秒内出现排队/执行状态卡片。
- Codex 有可解析事件时，飞书和平台能看到相同的公开步骤顺序。
- 回答增量持续更新同一条卡片，不产生消息洪泛。
- 平台页面刷新、SSE 断线重连后从正确 seq 继续。
- 完成、失败、取消、超时均形成明确终态。
- 飞书投递失败不抹掉平台上的 Run 和结果，可重试投递。

### 一致性与恢复

- 相同 `runId + seq` 只应用一次。
- 旧 patch 不得覆盖新 patch。
- 进程重启后，运行中的旧 Run 依现有规则终止或恢复排队；卡片被校准到对应状态。
- Provider 原生会话 head 仍只在最终飞书送达并持久化后推进。

### 安全

- reasoning/thinking、完整命令、完整工具输出和凭据不出现在事件 journal、SSE 或卡片。
- 所有外部字符串在进入 Card JSON 和 HTML 前做结构化转义。
- 卡片动作不信任客户端传回权限与状态。
- 运行详情继续遵守现有 Web 鉴权与 Space 边界。

### 性能

- 飞书 patch 平均频率不高于配置阈值，状态变化除外。
- 慢卡片投递不阻塞 Provider stdout 消费。
- 每 Run 的内存队列、journal 和展示历史均有硬上限。
- 100 个并发 SSE 客户端不会导致重复 Provider 工作或重复持久化。

## 14. 测试矩阵

| 层 | 重点用例 |
|---|---|
| LLM | JSONL 被任意 chunk 切分；非法行；超长行；delta 合并；reasoning 丢弃；取消/超时 |
| Core | seq 单调；重启恢复；journal 损坏拒绝；上限压缩；Chat Run 与终态快照一致 |
| Orchestrator | queued/running/tool/delta/final 顺序；静态回复；Provider 失败；delivery 失败 |
| Connector | interactive create 解析 ID；patch 使用 bot；30 KB；限流；旧 revision 丢弃；最终更新 |
| Web | 首屏静态可读；SSE replay；Last-Event-ID；断线重连；终态关闭；鉴权 |
| Card action | 签名、权限、nonce、重复点击、终态操作、取消与重试 |
| E2E | 真 Codex + 假飞书；假 Provider + 真测试群；最终再做真 Provider + 真测试群 |

建议新增脚本：

```text
bun run verify:live-runs
bun run soak:live-delivery
```

发布前仍需执行：

```text
bun test
bun run typecheck
bun run verify:beta -- --allow-dirty
```

其中真实飞书 create/patch/callback 与 macOS 发布门禁必须单独报告，不能由离线测试替代。

## 15. 关键产品决策

1. **默认展示“安全执行轨迹”，不展示模型思维链。**
2. **平台详情优先于飞书高频文本流。** 平台可保留更多步骤；飞书只显示当前阶段、最近步骤和答案预览。
3. **Codex 优先。** 当前结构化事件基础最好；Claude 第二阶段；TRAE 不强行伪流式。
4. **卡片失败不影响 Run。** 运行事实由 Core 保存，飞书只是投影。
5. **最终送达仍是 Provider 会话提交门槛。** 保留现有最重要的一致性契约。
6. **首版不引入外部消息队列。** 单机架构下 JSONL journal + 内存 pub/sub 足够；未来多进程再把 RunEventBus 抽换为数据库/消息总线。

## 16. 建议的首个开发切片

首个可独立上线的切片只做：

1. Codex JSONL 增量解析。
2. RunEventStore。
3. Web SSE 实时详情页。
4. 飞书创建“执行中”卡片并在终态更新一次。

先不做 token 级飞书刷新和卡片回调。该切片能验证最难的四个基础契约：事件正确性、持久化、双端同源和 Bot 卡片更新。验证稳定后，再把飞书更新频率提高到阶段级/文本增量级，并加入取消、重试按钮。

## 17. 对齐依据与边界

Mew 的公开内部说明确认：飞书 thread 映射到 Mew chat，执行仍经过 Mew 的 chat/message/run，结果由 Mew 服务回写原飞书讨论；内部讨论也明确 Agent 不直接持有绑定 Bot 的凭据，消息读取和回复由 Mew 服务完成。

参考：

- https://bytedance.larkoffice.com/docx/AkzOdDwr6oChMgxY9V8cHu0Unee?from=lark_search_qa&ccm_open_type=lark_search_qa#doxcnt36jvyLyOYWIKt6bkXnrBe
- https://applink.feishu.cn/client/thread/open?chatid=7646339699598101436&threadid=7682718287733460162&thread_position=-1&mode=sidebar

Mew 的具体内部卡片 API、刷新间隔、事件存储实现没有在已检索资料中公开。本方案对齐的是可观察产品行为与已确认的服务端投递边界，不声称复制 Mew 的内部源码实现。
