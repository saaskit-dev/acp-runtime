# RFC-0006: Observability and Error Model

Language:
- English (default)
- [简体中文](#简体中文)

## Summary

This RFC defines the observability layers and error model for `acp-runtime`.

It recommends:

- a three-layer model of `logger`, `hooks`, and `event sink`
- structured classification of runtime, protocol, transport, and agent failures
- enough observability to support debugging and testing before introducing full tracing

## Simplified Chinese

[Back to English](#rfc-0006-observability-and-error-model)

# RFC-0006：可观测性与错误模型

- 状态：Proposed
- 日期：2026-04-03

## 1. 目标

定义 `acp-runtime` 的可观测性设计与错误模型。

v1 的目标不是一口气接入完整 tracing 体系，而是先把：

- 主流程可观测
- 错误可归类
- 结构化事件可采集
- 日志足够支撑调试与测试

做扎实。

## 2. 核心结论

v1 建议明确采用三层可观测性模型：

- `logger`
- `hooks`
- `event sink`

同时：

- OpenTelemetry 进入设计边界
- 但不进入 v1 首批实现
- 待主流程稳定、测试完善后再接入

## 3. 三层可观测性模型

### 3.1 `AcpLogger`

用于：

- 面向人类的日志
- 本地调试
- CI / 测试时快速定位问题

建议接口：

```ts
type AcpLogger = {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};
```

### 3.2 `AcpAgentHooks`

用于：

- 宿主应用联动
- UI 或外部逻辑同步
- 非核心副作用

建议接口：

```ts
type AcpAgentHooks = {
  onWireEvent?(event: unknown): void | Promise<void>;
  onStateChanged?(state: AcpState): void | Promise<void>;
  onTurnQueued?(turnId: string, position: number): void | Promise<void>;
  onTurnStarted?(turnId: string): void | Promise<void>;
  onTurnCompleted?(turnId: string, result: AcpTurnCompletion): void | Promise<void>;
  onTurnFailed?(turnId: string, error: Error): void | Promise<void>;
  onPermissionRequest?(request: AcpPermissionRequest): void | Promise<void>;
  onPermissionResolved?(
    request: AcpPermissionRequest,
    decision: AcpPermissionDecision,
  ): void | Promise<void>;
};
```

### 3.3 `AcpEventSink`

用于：

- 结构化事件采集
- transcript
- 审计
- 研究 harness
- 后续回放 / 分析

建议接口：

```ts
type AcpEventSink = {
  append(event: AcpObservedEvent): void | Promise<void>;
};
```

## 4. Hook 语义

hooks 是 observer，不是 interceptor。

这意味着：

- hook 可以是 sync
- hook 也可以是 async
- hook 失败不能改变 runtime 主流程语义

### 4.1 为什么 hook 不能影响主流程

例如：

- `onTurnCompleted` 抛错，不能把成功 turn 变成失败
- `onStateChanged` 抛错，不能让 `resume()` 失败
- `onPermissionRequest` 抛错，不能把本来健康的运行时打崩

因为 hooks 属于观测与联动层，不属于核心执行层。

### 4.2 实现约束

建议 runtime：

- 捕获 hook 错误
- 将 hook 错误写入 logger / event sink
- 不因为 hook 错误改变主执行结果

## 5. 结构化事件

建议定义统一事件类型：

```ts
type AcpObservedEvent = {
  timestamp: string;
  scope: "runtime" | "session" | "turn" | "permission" | "process" | "control";
  type: string;
  sessionId?: string;
  turnId?: string;
  fields?: Record<string, unknown>;
};
```

## 6. v1 最小观测事件集

v1 至少应保证以下事件可被结构化观测：

### 6.1 runtime / session

- runtime init started / succeeded / failed
- `session/new` started / succeeded / failed
- `session/load` started / succeeded / failed
- `session/resume` started / succeeded / failed
- desired state replay started / succeeded / failed

### 6.2 turn

- turn queued
- turn dequeued
- turn started
- turn completed
- turn failed
- turn cancelled
- turn timed out

### 6.3 permission

- permission request emitted
- permission decision resolved
- permission denied / cancelled

### 6.4 control

- `setMode` queued / started / succeeded / failed
- `setModel` queued / started / succeeded / failed
- `setConfig` queued / started / succeeded / failed

### 6.5 process

- agent process started
- agent process exited
- reconnect started
- reconnect succeeded
- reconnect failed

## 7. transcript 与采集

虽然 v1 不要求内建文件落盘实现，但 event sink 必须足够支撑：

- transcript 采集
- 研究 harness
- 调试工具
- 审计扩展

也就是说，event sink 是 v1 的正式扩展点。

## 8. 错误模型

建议同时保留：

- typed error class
- stable error code

## 9. 错误类

所有错误继承 `AcpError` 基类，带 `code` 字面量属性。

```ts
abstract class AcpError extends Error {
  abstract readonly code: string;
  constructor(message: string, readonly cause?: unknown) { ... }
}

// 连接/协议
class AcpTransportError extends AcpError { code = 'TRANSPORT_ERROR' }
class AcpProtocolError extends AcpError { code = 'PROTOCOL_ERROR' }

// Session 生命周期
class AcpCreateError extends AcpError { code = 'CREATE_ERROR' }
class AcpLoadError extends AcpError { code = 'LOAD_ERROR' }
class AcpResumeError extends AcpError { code = 'RESUME_ERROR' }
class AcpResumeUnsupportedError extends AcpResumeError { code = 'RESUME_UNSUPPORTED' }
class AcpReplayError extends AcpError { code = 'REPLAY_ERROR' }

// Turn
class AcpTurnCancelledError extends AcpError { code = 'TURN_CANCELLED' }
class AcpTurnTimeoutError extends AcpError { code = 'TURN_TIMEOUT' }
class AcpQueueOverflowError extends AcpError { code = 'QUEUE_OVERFLOW' }

// 进程
class AcpProcessError extends AcpError { code = 'PROCESS_ERROR' }
class AcpProcessExitError extends AcpProcessError { code = 'PROCESS_EXIT' }

// 权限
class AcpPermissionError extends AcpError { code = 'PERMISSION_ERROR' }
```

注意：没有 `AcpHookError`。Hook 失败不影响主流程，错误只写入 logger / event sink，
不暴露给消费方。消费方永远不会 catch 到 hook 错误。

## 10. 错误码

每个错误类的 `code` 是字面量类型，可用于 `switch`：

```ts
catch (err) {
  if (err instanceof AcpError) {
    switch (err.code) {
      case 'TURN_CANCELLED': ...
      case 'TURN_TIMEOUT': ...
      case 'PROCESS_EXIT': ...
    }
  }
}
```

同时 `instanceof` 也可用：

```ts
if (err instanceof AcpTurnCancelledError) { ... }
if (err instanceof AcpProcessError) { ... }  // 匹配所有进程级错误
```

### 10.1 为什么 class 和 code 都要有

- 运行时代码内部更适合用 `instanceof`（支持继承层级匹配）
- transcript / logs / event sink 更适合用稳定 `code` 字符串（可序列化）

两者并存最实用。

## 11. OpenTelemetry 的定位

OpenTelemetry 应进入设计边界，但不进入 v1 首批实现。

### 11.1 为什么先不实现

当前优先级更高的是：

- 主流程稳定
- turn / session / permission / recovery 测试完整
- 日志和结构化事件足够支撑调试

在这些基础还没稳定前，过早接入 OTel 会增加实现复杂度和测试负担。

### 11.2 设计要求

虽然不在 v1 首批实现，但当前设计不应阻塞未来接入 OTel。

因此建议：

- `AcpObservedEvent` 预留 trace 相关字段扩展能力
- logger / event sink / hooks 的设计不要和未来 tracing 冲突
- 后续可在不破坏主接口的情况下追加 span / trace 支持

## 12. v1 最终建议

v1 的可观测性实现建议是：

- `AcpLogger` 进入核心实现
- `AcpAgentHooks` 进入核心实现
- `AcpEventSink` 进入核心扩展点
- 结构化事件集进入核心设计
- typed error class + stable error code 并存
- OpenTelemetry 暂不实现，但明确预留后续接入空间
