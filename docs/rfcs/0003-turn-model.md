# RFC-0003: Turn Execution Model

Language:
- English (default)
- [简体中文](#简体中文)

## Summary

This RFC defines the runtime turn model for a single session.

Key conclusions:

- only one active turn is allowed per session
- turns are serialized through a thin FIFO queue
- cancellation and timeout are structured completion outcomes
- transport, protocol, and runtime failures are represented as errors
- control operations share the same serialized execution flow as prompts

## Simplified Chinese

[Back to English](#rfc-0003-turn-execution-model)

# RFC-0003：Turn 执行模型

- 状态：Proposed
- 日期：2026-04-03

## 1. 目标

定义单个 session 内一次 turn 的执行边界、并发约束、队列行为、取消语义、完成语义和超时语义。

## 2. 核心结论

v1 建议直接定死以下规则：

- 单个 session 同一时刻只允许一个 active turn
- runtime 提供薄的 FIFO 队列
- `send()` 返回双通道 turn 对象：`events + completion`
- `cancel()` 返回结构化结果，而不是 `boolean`
- `cancelled` 和 `timeout` 属于结构化完成结果，不属于异常
- transport / protocol / runtime 故障才通过异常表达
- control 操作与 turn 共用同一条 session 串行执行流

## 3. 为什么要单独定义 turn 模型

如果 turn 模型不提前定清楚，后续实现会出现这些问题：

- 同一 session 内 prompt 并发写入
- UI 不知道 turn 是排队中还是执行中
- `cancel()` 语义混乱
- `timeout` 和真正错误混在一起
- `setMode()` / `setModel()` 与 prompt 竞争执行顺序

所以 turn 模型必须作为 runtime 的核心语义，而不是实现细节。

## 4. 单 session 并发模型

建议直接定义为硬约束：

- 一个 session 同时只能有一个 active turn
- 不允许多个 turn 并发写入同一个 session

原因：

- ACP session 本质上承载连续上下文
- 并发 prompt 会导致上下文归属不清
- 事件归属、取消语义、history replay 都会变复杂

如果调用方需要真正并行，应通过多个 session 实现，而不是在同一 session 内并发 turn。

## 5. 队列模型

runtime 提供一个薄的 FIFO 队列。

### 5.1 目标

- 避免每个接入方自己重复实现排队
- 避免 runtime 演化成复杂调度器

### 5.2 规则

- 当前已有 active turn 时，新 turn 进入队列
- 队列顺序为 FIFO
- active turn 完成后，队首 turn 开始执行

### 5.3 配置

```ts
type AcpQueuePolicy = {
  enabled?: boolean;
  maxDepth?: number;
};
```

建议默认：

- `enabled: true`
- `maxDepth` 为较小值

当队列满时，直接抛 `AcpQueueOverflowError`。

v1 不建议支持：

- 优先级队列
- 抢占
- `drop-oldest`
- `drop-newest`

## 6. 三层 Turn API

不使用双通道 `AcpTurn` 对象（属性 API 不友好、消费方不知道该读哪个）。

改为三个方法，每层基于下层实现：

```ts
// Layer 3（最简）— 基于 Layer 2
async run(prompt: AcpPrompt): Promise<string>;

// Layer 2（带 handlers）— 基于 Layer 1
async send(prompt: AcpPrompt, handlers?: AcpTurnHandlers): Promise<string>;

// Layer 1（原始事件流）— 唯一碰协议的地方
stream(prompt: AcpPrompt, options?: AcpStreamOptions): AsyncIterable<AcpTurnEvent>;
```

## 7. 为什么是三层而非双通道

双通道问题：消费方拿到 `AcpTurn` 对象后要自己决定读 `events` 还是 `completion`，心智负担大。

三层的好处：

- `run()` 的源码就是 `send()` 的使用教程
- `send()` 的源码就是 `stream()` 的使用教程
- 用户从简到复杂逐步升级，每一步有源码示范
- 每个方法返回一种东西——`string` 或 `AsyncIterable`——没有属性要记

## 8. 事件模型

建议至少包含以下事件：

```ts
type AcpTurnEvent =
  | { type: "queued"; turnId: string; position: number }
  | { type: "dequeued"; turnId: string }
  | { type: "started"; turnId: string }
  | { type: "text-delta"; turnId: string; text: string }
  | { type: "plan-update"; turnId?: string; entries: AcpPlanEntry[] }
  | { type: "available-commands-update"; turnId?: string; commands: AcpAvailableCommand[] }
  | { type: "tool-call"; turnId: string; toolName: string; input: unknown }
  | { type: "tool-result"; turnId: string; toolName: string; result: unknown }
  | { type: "permission-request"; turnId: string; request: AcpPermissionRequest }
  | { type: "status"; turnId: string; message: string }
  | { type: "completed"; turnId: string; result: AcpTurnCompletion }
  | { type: "failed"; turnId: string; error: Error };
```

说明：

- `queued` / `dequeued` 是因为 runtime 明确提供了队列
- `plan-update` 对应协议中的 `sessionUpdate: "plan"`
- `available-commands-update` 对应协议中的 `sessionUpdate: "available_commands_update"`
- `completed` 用于结构化完成
- `failed` 只用于真正错误

### 8.1 `plan` 与 `available_commands_update`

这两个都不应被建模成独立 API 方法，而应作为标准 `session/update` 事件的一部分进入 turn 事件流。

建议核心类型：

```ts
type AcpPlanEntry = {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
};

type AcpAvailableCommand = {
  name: string;
  description: string;
  input?: {
    hint?: string;
  };
};
```

规则：

- `plan` 更新时，agent 发送完整条目列表
- runtime 每次收到 `plan` 时整体替换当前 plan
- `available_commands_update` 表示当前可执行 slash commands 已可用或发生变化
- runtime 应将这些更新暴露给宿主，而不是只保留在内部状态中

### 8.2 Slash Commands 的执行语义

slash commands 不是单独的协议调用。

执行方式仍然是普通 `session/prompt`，只是 prompt 文本以 `/` 开头，例如：

```ts
send([{ type: "text", text: "/web agent client protocol" }])
```

因此 runtime 需要做的不是增加 `executeSlashCommand()`，而是：

- 暴露 `available_commands_update`
- 保持 `send()` 对 slash command prompt 透明

## 9. 完成语义

`run()` 和 `send()` 返回 `string`。三种结果：

- 正常完成：返回 agent 文本回复
- 被取消：抛 `AcpTurnCancelledError`
- 超时：抛 `AcpTurnTimeoutError`
- 真正故障：抛对应类型化异常

### 9.1 为什么取消和超时走异常

因为 `run()` 和 `send()` 返回 `string`，无法通过返回值表达非正常终止。

- 返回空 string？消费方无法区分"agent 回了空"和"被取消了"
- 返回 `TurnCompletion` 对象？违背了"零复杂返回值"原则

`stream()` 层的行为不同：取消和超时会发出 `{ type: "failed", error }` 事件，
高级用户可以不用 try/catch 而是在事件流中处理。

### 9.2 使用模式

```ts
// run/send：try/catch
try {
  const answer = await agent.run('Long task');
} catch (err) {
  if (err instanceof AcpTurnCancelledError) { /* 被取消 */ }
  if (err instanceof AcpTurnTimeoutError) { /* 超时 */ }
}

// stream：事件流
for await (const event of agent.stream(prompt)) {
  if (event.type === 'failed') { /* 包含取消和超时 */ }
}
```

## 10. `cancel()` 语义

### 10.1 两种取消方式

**方式 A：`cancel()` 无参——取消当前活跃 turn**

```ts
await agent.cancel();
```

- 有活跃 turn → 调 ACP `session/cancel`，活跃 turn 抛 `AcpTurnCancelledError`
- 无活跃 turn → no-op
- cancel 请求本身失败 → 抛异常

**方式 B：`AbortSignal`——取消特定 turn（包括排队中的）**

```ts
const controller = new AbortController();
const promise = agent.run('Task', { signal: controller.signal });

controller.abort();  // 排队中 → 直接移除并 reject；执行中 → 调 session/cancel
```

标准 Web API，消费方不需要学新概念。

### 10.2 行为规则

AbortSignal 触发时：

- 如果对应 turn 在队列中：直接移除，`promise` reject `AcpTurnCancelledError`
- 如果对应 turn 正在执行：调 `session/cancel`，`promise` reject `AcpTurnCancelledError`
- 如果 signal 在 `run/send/stream` 调用前已 aborted：立即 reject，不入队

### 10.3 一个 signal 取消多个 turn

```ts
const controller = new AbortController();
const p1 = agent.run('Task 1', { signal: controller.signal });
const p2 = agent.run('Task 2', { signal: controller.signal });
controller.abort();  // 全部取消
```

## 11. timeout 语义

turn 超时后：

1. runtime 尝试取消当前 turn
2. `completion` 返回 `stopReason: "timeout"`
3. session 默认继续存活

也就是说，turn timeout 不等于 session death。

只有在 timeout 之后协议或连接状态已经损坏时，才应把 session 视为不可继续使用。

## 12. control 操作与 turn 的关系

`setMode()`、`setModel()`、`setConfig()` 不应在 active turn 运行中直接抢占执行。

建议规则：

- control 操作与 `send()` 共用同一条 session 串行执行流
- 如果当前有 active turn，control 操作排队等待
- 当前 turn 结束后，再执行 control

这样可以避免：

- turn 中途上下文被改写
- mode/model 与 prompt 竞争
- 行为不可推理

## 13. 实现建议

### 13.1 内部结构

建议 runtime 内部至少有：

- active turn controller
- FIFO queue
- event channel
- completion resolver
- control operation queue

### 13.2 协议桥接

ACP wire event 通过 callback 推入内部 channel，`events` 从 channel 中消费。

`completion` 由 turn controller 独立结算，不依赖调用方是否把 `events` 全部读完。

## 14. v1 最终建议

v1 建议采用以下最小但完整的模型：

- 单 session 单 active turn
- 薄 FIFO 队列
- 三层 turn API（`run` / `send` / `stream`，上层基于下层实现）
- 取消通过 `cancel()` 无参 + `AbortSignal`
- cancel/timeout 在 `run`/`send` 中抛类型化异常
- timeout 不自动销毁 session
- control 操作和 turn 共用同一串行执行流

这套规则足够稳定，也足够容易实现和验证。
