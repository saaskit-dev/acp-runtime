# RFC-0000：术语与核心类型索引

- 状态：Proposed
- 日期：2026-04-03

## 1. 目的

这份文档用于统一 `acp-runtime` 中反复出现的术语和核心类型。

目标：

- 统一词汇
- 统一对象边界
- 给后续实现提供单一索引入口

它不是新的功能 RFC，而是全套 RFC 的共用基础。

## 2. 核心术语

### 2.1 宿主（Host）

宿主是使用 `acp-runtime` 的外部系统。

例如：

- CLI
- GUI / Desktop App
- Daemon / Server
- 自动化编排器

宿主负责产品状态、UI、持久化和业务决策。

### 2.2 Runtime

runtime 指 `acp-runtime` 本身。

它负责 ACP 连接、session 生命周期、turn 执行、恢复、权限编排和可观测性输出。

### 2.3 Agent

agent 指被 runtime 启动并通过 ACP 交互的外部 agent 进程。

例如：

- Claude ACP adapter
- Codex ACP adapter
- OpenCode ACP adapter

### 2.4 Session

session 指 ACP 协议中的会话上下文。

在本设计中：

- 每个 session 只有一个标准标识：`session.id`
- `session.id` 对应 ACP `sessionId`

### 2.5 Turn

turn 指在单个 session 中的一次 prompt 执行。

一个 turn 具有：

- 生命周期
- 事件流
- 最终 completion

### 2.6 Desired State

`desired state` 指用户希望 runtime 维持或恢复的意图。

例如：

- 想使用哪个 mode
- 想使用哪个 model
- 想应用哪种 permission policy

### 2.7 Permission Policy

`permissionPolicy` 是 runtime 自己的统一权限抽象，不等于 agent mode。

它表达的是调用方希望的权限边界。

### 2.8 Mode

`modeId` 是 agent-specific 原语。

它的语义由具体 agent 决定，不是 runtime 的统一抽象。

### 2.9 Event Sink

`event sink` 是 runtime 输出结构化事件的扩展点。

用于：

- transcript
- 审计
- 研究 harness
- 事件采集

### 2.10 Hook

hook 是 runtime 对宿主暴露的观察型回调。

它是 observer，不是 interceptor。

### 2.11 Authentication

authentication 指 ACP 连接在 `initialize` 后可能进入的认证流程。

如果 agent 在 `initialize` 中返回 `authMethods`，runtime 应把这些方法暴露给宿主，并在需要时驱动认证。

### 2.12 Agent Plan

agent plan 是 `session/update` 的一种标准更新类型，`sessionUpdate` 为 `"plan"`。

它表达 agent 当前的执行计划，客户端每次收到更新时应整体替换当前 plan。

### 2.13 Slash Commands

slash commands 不是独立 ACP 方法。

它们由两部分组成：

- `available_commands_update`：agent 广播当前可用命令
- 普通 `session/prompt`：宿主发送以 `/` 开头的 prompt 文本执行命令

## 3. 核心对象一览

### 3.1 `AcpAgent`

高层 facade，对宿主暴露：

- 静态工厂：`create` / `load` / `resume`
- turn 执行：`run` / `send` / `stream`（三层堆叠，上层基于下层实现）
- 控制：`cancel` / `setMode` / `setModel` / `setConfig` / `close`
- 状态：`state` / `status` / `capabilities`

### 3.2 `AcpClient`

协议 / 连接层接口。

负责：

- 启动 agent 进程
- 建立 ACP 连接
- 调用 ACP 原语（`session/new`、`session/load`、`session/prompt`、`session/cancel` 等）
- 可注入：生产用 `AcpProcessClient`，测试用 `AcpMockClient`

### 3.3 `AcpSessionContext`

session 运行时内部核心对象（不直接暴露给宿主）。

负责：

- 管理单个 session 生命周期
- 串行化 turn（通过 `TurnController`）
- 协调恢复与 desired state replay
- 管理 `AcpCapabilities` 状态机

## 4. 核心状态类型

### 4.1 `AcpState`

可持久化、可恢复状态。

**设计原则**：
- `AcpState` 只包含恢复所需的信息，不包含运行时瞬态（status、turn 进度等）
- 运行中的连接状态、turn 进度通过 `agent.status` 属性和可观测性体系表达
- `env` 不在 state 里——它可能包含敏感信息，且恢复时不一定需要
- `env` 作为 `create / load / resume` 的 options 输入

```ts
type AcpState = {
  version: 1;
  agent: AcpAgentDef | string;
  cwd: string;
  session: {
    id: string;
  };
  desired: {
    modeId?: string;
    modelId?: string;
    permissionPolicy?: AcpPermissionPolicy;
    config?: Record<string, unknown>;
  };
  createdAt: string;
  lastUsedAt: string;
  lastConnectedAt?: string;
  process?: {
    pid?: number;
    startedAt?: string;
    exitCode?: number | null;
    exitSignal?: string | null;
  };
  mcpServers?: AcpMcpServer[];
  timeouts?: AcpTimeouts;
  retry?: AcpRetryPolicy;
  queue?: AcpQueuePolicy;
};
```

运行时状态（非持久化）通过 `AcpAgent` 实例属性暴露：

```ts
agent.status;        // 'idle' | 'connecting' | 'ready' | 'running' | 'disconnected' | 'closed'
agent.capabilities;  // Readonly<AcpCapabilities> | null
agent.state;         // Readonly<AcpState>（当前快照，随时可读）
```

### 4.2 `AcpDesiredState`

```ts
type AcpDesiredState = {
  modeId?: string;
  modelId?: string;
  permissionPolicy?: AcpPermissionPolicy;
  config?: Record<string, unknown>;
};
```

### 4.3 `AcpAuthState`

```ts
type AcpAuthMethod = {
  id: string;
  name: string;
  description?: string;
};

type AcpAuthState =
  | { status: "not-required" }
  | { status: "available"; methods: AcpAuthMethod[] }
  | { status: "authenticated"; methodId?: string }
  | { status: "failed"; error: string };
```

## 5. Turn 相关类型

### 5.1 三层 Turn API

`AcpAgent` 提供三层 turn 方法，每层基于下层实现：

```ts
// Layer 3（最简）：基于 send() 实现
async run(prompt: AcpPrompt): Promise<string>;

// Layer 2（带 handlers）：基于 stream() 实现
async send(prompt: AcpPrompt, handlers?: AcpTurnHandlers): Promise<string>;

// Layer 1（原始流）：唯一碰协议的地方
stream(prompt: AcpPrompt, options?: AcpStreamOptions): AsyncIterable<AcpTurnEvent>;
```

`run()` 和 `send()` 返回 `string`（agent 文本回复）。成功即返回，失败抛类型化异常。

### 5.2 `AcpTurnHandlers`

```ts
type AcpTurnHandlers = {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolUse?: (tool: { id: string; name: string; input: unknown }) => void;
  onToolResult?: (result: { toolUseId: string; content: string; isError: boolean }) => void;
  onPermission?: (request: AcpPermissionRequest) => void | AcpPermissionDecision | Promise<AcpPermissionDecision>;
  onPlan?: (entries: AcpPlanEntry[]) => void;
  onAvailableCommands?: (commands: AcpAvailableCommand[]) => void;
  onStatus?: (message: string) => void;
  onError?: (error: Error) => void;
};
```

### 5.3 `AcpStreamOptions`

```ts
type AcpStreamOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  meta?: Record<string, string>;
};
```

### 5.4 取消

```ts
// 取消当前活跃 turn（无参）
cancel(): Promise<void>;

// 取消排队中或活跃的 turn（通过 AbortSignal）
const controller = new AbortController();
agent.stream(prompt, { signal: controller.signal });
controller.abort();  // 排队中 → 直接移除；执行中 → 调 session/cancel
```

取消和超时都抛类型化异常（`AcpTurnCancelledError` / `AcpTurnTimeoutError`），
因为 `run()` 和 `send()` 返回 `string`，无法通过返回值表达非正常终止。

### 5.5 `AcpPlanEntry`

```ts
type AcpPlanEntry = {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
};
```

### 5.6 `AcpAvailableCommand`

```ts
type AcpAvailableCommand = {
  name: string;
  description: string;
  input?: {
    hint?: string;
  };
};
```

### 5.7 `AcpTurnEvent`

```ts
type AcpTurnEvent =
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-use"; id: string; name: string; input: unknown }
  | { type: "tool-result"; toolUseId: string; content: string; isError: boolean }
  | { type: "permission-request"; request: AcpPermissionRequest }
  | { type: "plan-update"; entries: AcpPlanEntry[] }
  | { type: "available-commands-update"; commands: AcpAvailableCommand[] }
  | { type: "current-mode-update"; modeId: string }
  | { type: "config-options-update"; options: AcpConfigOption[] }
  | { type: "status"; message: string }
  | { type: "completed"; outputText: string; usage?: AcpUsage }
  | { type: "failed"; error: Error };
```

注意：`completed` 和 `failed` 只出现在 `stream()` 的事件流中。
`run()` 和 `send()` 不暴露这些事件——成功返回 string，失败抛异常。

## 6. 权限相关类型

### 6.1 `AcpPermissionPolicy`

```ts
type AcpPermissionPolicy =
  | { kind: "agent-default" }
  | { kind: "read-only" }
  | { kind: "balanced" }
  | { kind: "full-access" }
  | { kind: "custom"; handler: AcpPermissionHandler };
```

### 6.2 `AcpPermissionRequest`

```ts
type AcpPermissionRequest = {
  kind: "fs-read" | "fs-write" | "terminal" | "custom";
  resource?: string;
  action: string;
  payload?: unknown;
};
```

### 6.3 `AcpPermissionDecision`

```ts
type AcpPermissionDecision =
  | { allow: true }
  | { allow: false; reason?: string };
```

### 6.4 `ResolvedPermissionPlan`

```ts
type ResolvedPermissionPlan = {
  modeId?: string;
  handlerStrategy: "agent-enforced" | "runtime-enforced" | "mixed";
  supported: boolean;
  notes?: string[];
};
```

### 6.5 `AcpAuthenticationHandler`

```ts
type AcpAuthenticationHandler = (
  methods: AcpAuthMethod[],
  context: { agent: string },
) => Promise<{ methodId: string } | { cancel: true }>;
```

## 7. 可观测性相关类型

### 7.1 `AcpLogger`

```ts
type AcpLogger = {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};
```

### 7.2 `AcpAgentHooks`

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

### 7.3 `AcpEventSink`

```ts
type AcpEventSink = {
  append(event: AcpObservedEvent): void | Promise<void>;
};
```

### 7.4 `AcpObservedEvent`

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

## 8. 错误相关类型

### 8.1 错误类

所有错误继承 `AcpError` 基类，带 `code` 字面量属性：

```ts
abstract class AcpError extends Error {
  abstract readonly code: string;
  constructor(message: string, readonly cause?: unknown);
}

// 连接/协议
class AcpTransportError extends AcpError {}    // code: 'TRANSPORT_ERROR'
class AcpProtocolError extends AcpError {}     // code: 'PROTOCOL_ERROR'

// Session 生命周期
class AcpCreateError extends AcpError {}       // code: 'CREATE_ERROR'
class AcpLoadError extends AcpError {}         // code: 'LOAD_ERROR'
class AcpResumeError extends AcpError {}       // code: 'RESUME_ERROR'
class AcpResumeUnsupportedError extends AcpResumeError {} // code: 'RESUME_UNSUPPORTED'
class AcpReplayError extends AcpError {}       // code: 'REPLAY_ERROR'

// Turn
class AcpTurnCancelledError extends AcpError {} // code: 'TURN_CANCELLED'
class AcpTurnTimeoutError extends AcpError {}   // code: 'TURN_TIMEOUT'
class AcpQueueOverflowError extends AcpError {} // code: 'QUEUE_OVERFLOW'

// 进程
class AcpProcessError extends AcpError {}       // code: 'PROCESS_ERROR'
class AcpProcessExitError extends AcpProcessError {} // code: 'PROCESS_EXIT'

// 权限
class AcpPermissionError extends AcpError {}    // code: 'PERMISSION_ERROR'
```

注意：没有 `AcpHookError`。Hook 失败只写 logger，不影响主流程，不暴露给消费方。

## 9. 使用规则

后续所有 RFC 和实现应遵守：

- 相同术语只表达同一种语义
- 相同类型名只保留一个定义版本
- 新增术语前，优先更新本索引

## 10. 与其他 RFC 的关系

这份索引服务于：

- `0001-runtime-architecture`
- `0002-session-lifecycle`
- `0003-turn-model`
- `0004-state-and-recovery`
- `0005-permissions-and-client-authority`
- `0006-observability-and-errors`
- `0007-host-integration`

它不替代这些 RFC，只负责统一它们的词汇和核心类型。
