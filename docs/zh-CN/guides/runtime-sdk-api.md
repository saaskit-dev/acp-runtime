# Runtime SDK API

[English](../../guides/runtime-sdk-api.md)

这份文档描述 `acp-runtime` 当前的顶层 Public SDK。
它只描述宿主侧 runtime 概念，不描述 raw ACP protocol message。

## 顶层入口

- `AcpRuntime`
- `AcpRuntimeSession`

当前内部实现分层已经收敛为：

- `AcpRuntime`
- `AcpRuntimeSession`
- `AcpSessionDriver`
- `acp/session-service.ts`
- `acp/profiles/`
- `acp/driver.ts`

## Runtime 构造

`AcpRuntime` 是宿主拿到的顶层 SDK 对象。

宿主公开方法：
- `create(options)`
- `createFromRegistry(options)`
- `listAgentSessions(options)`
- `listAgentSessionsFromRegistry(options)`
- `listStoredSessions(options?)`
- `load(options)`
- `loadFromRegistry(options)`
- `resume(options)`
- `deleteStoredSession(sessionId)`
- `deleteStoredSessions(options?)`
- `watchStoredSessions(watcher)`
- `refreshStoredSessions()`

registry 辅助入口：
- `resolveRuntimeAgentFromRegistry(agentId)`

对于大多数宿主接入，`createFromRegistry` 应该成为默认路径。
它把 agent 启动解析收口在 runtime 内，而不是要求每个宿主重复维护 `command` / `args` 规则。

## Session 公共面

`AcpRuntimeSession` 当前暴露：

- `capabilities`
- `metadata`
- `diagnostics`
- `status`
- `listAgentModes()`
- `listAgentConfigOptions()`
- `setAgentMode(modeId)`
- `setAgentConfigOption(id, value)`
- `run(prompt, options?)`
- `send(prompt, handlers?, options?)`
- `stream(prompt, options?)`
- `snapshot()`
- `diffPaths()`
- `diff(path)`
- `diffs()`
- `operationIds()`
- `operation(operationId)`
- `operationBundle(operationId)`
- `operationBundles()`
- `operationPermissionRequests(operationId)`
- `operations()`
- `permissionRequestIds()`
- `permissionRequest(requestId)`
- `permissionRequests()`
- `projectionMetadata()`
- `projectionUsage()`
- `terminalIds()`
- `terminal(terminalId)`
- `terminals()`
- `refreshTerminal(terminalId)`
- `waitForTerminal(terminalId)`
- `killTerminal(terminalId)`
- `releaseTerminal(terminalId)`
- `toolCallIds()`
- `toolCalls()`
- `toolCallBundles()`
- `toolCall(toolCallId)`
- `toolCallBundle(toolCallId)`
- `toolCallDiffs(toolCallId)`
- `toolCallTerminals(toolCallId)`
- `threadEntries()`
- `watchToolCall(toolCallId, watcher)`
- `watchDiff(path, watcher)`
- `watchOperation(operationId, watcher)`
- `watchOperationBundle(operationId, watcher)`
- `watchPermissionRequest(requestId, watcher)`
- `watchReadModel(watcher)`
- `watchProjection(watcher)`
- `watchTerminal(terminalId, watcher)`
- `watchToolCallObjects(toolCallId, watcher)`
- `cancel()`
- `close()`

## Agent Identity

`AcpRuntimeAgent` 可以包含：
- `command`
- `args`
- `env`
- `type`

其中：

- `type` 是 runtime 层稳定的 agent 家族标识，用于 profile 选择和 host 侧过滤

对于基于 registry 的启动，宿主可以跳过手动构造 `AcpRuntimeAgent`：

```ts
const runtime = new AcpRuntime(createStdioAcpConnectionFactory());
const session = await runtime.createFromRegistry({
  agentId: "claude-acp",
  cwd: process.cwd(),
});
```

手动 `create({ agent })` 仍然支持，但现在更适合作为需要精确覆盖启动参数时的 override 路径。

## 原生 Agent 状态

runtime session 控制现在以 agent 原生 mode 和 config options 为中心。

也就是说：
- `currentModeId` 和 `config` 是主要恢复状态
- 可以通过 `listAgentModes()` 与 `listAgentConfigOptions()` 查看 agent 支持的原生控制项
- 可以通过 `setAgentMode()` 与 `setAgentConfigOption()` 直接更新原生状态

## Session Listing 语义

`listAgentSessions(options)` 是 **单 agent 作用域**，不是全局列举。

它表示：
- 连到某一个具体 ACP agent 进程
- 询问这个 agent 自己知道哪些 session

它不负责跨多个 agent 聚合。

如果宿主需要全局 session 列表、最近会话面板或跨 agent picker，
应该使用宿主自有的 registry 层。

围绕这个宿主自有层，`AcpRuntime` 现在也暴露了基于 registry 的 stored-session 辅助方法：
- `listStoredSessions(options?)`
- `deleteStoredSession(sessionId)`
- `deleteStoredSessions(options?)`
- `watchStoredSessions(watcher)`
- `refreshStoredSessions()`

这些是 runtime 自己的 history-management helper，不是 ACP 协议方法。

当前 TypeScript SDK 在 session 管理上的覆盖面只到：
- `session/list`
- `session/load`
- `session/resume`
- `session/close`

它 **还没有** 暴露出类似 Zed 更高层 session history 管理里的 watch/delete/refresh 能力。
`acp-runtime` 不会伪造这些 API。宿主如果现在需要删除或刷新语义，应该在自有 registry / UI 层建模。

## Prompt 模型

`AcpRuntimePrompt` 当前支持：
- 纯字符串输入
- 结构化内容块
- 带 role 的结构化消息

内容块当前支持：
- `text`
- `file`
- `image`
- `audio`
- `resource`
- `json`

## Output 模型

turn 完成结果返回：
- `outputText`
- `output`
- `turnId`

其中 `output` 是结构化 output 通道，富 UI 渲染应优先依赖它。

## Authority Handlers

宿主 authority 通过这些 handler 表达：
- `authentication`
- `filesystem`
- `permission`
- `terminal`

它们是 runtime 对 client-side delegation 的统一抽象。

## 核心公共模型

### Capabilities

`AcpRuntimeCapabilities` 包含：
- `agent`
- `agentInfo`
- `authMethods`
- `client`

`authMethods` 只描述 agent 宣告或 runtime 归一化后的登录选项。
宿主侧登录执行策略，例如 terminal success-pattern 匹配，应该放在
host / adapter 层，而不是 runtime core 模型里。

完整边界说明见
[Runtime Agent Compatibility](runtime-agent-compatibility.md)。

### Session Metadata

`AcpRuntimeSessionMetadata` 包含：
- `id`
- `title`
- `currentModeId`
- `config`
- `availableCommands`

### Session Listing

`runtime.listAgentSessions(options)` 当前返回：
- `sessions`
- `nextCursor`

每个 session reference 当前包含：
- `agentType`
- `id`
- `cwd`
- `title`
- `updatedAt`

### Host Registry

`AcpRuntimeSessionRegistry` 是宿主自有的全局索引层。

它可以：
- 按 `session.id` 持久化 runtime snapshot
- 按 `agentType` / `cwd` 列出已存 session
- 按 `session.id` 取回 snapshot
- 删除已存 session
- watch stored-session update
- 发出 refresh 通知

registry 现在不再单独维护 agent 描述表。
最小持久化单元就是 `session.id -> snapshot`。

### Thread Entries

`session.threadEntries()` 暴露 runtime 的 thread-first 只读模型。

这是一个增量读面，不会替代：
- `AcpRuntimeTurnEvent`
- `AcpRuntimeOperation`

`session.diff(path)` 和 `session.terminal(terminalId)` 提供对 runtime-owned
tool object 的直接读取入口。

`session.diffs()` 和 `session.terminals()` 暴露的是基于同一套
thread-first 模型派生出来的 runtime-owned object view。

`session.diffPaths()` 和 `session.terminalIds()` 暴露当前 object-store 的索引视图。

`session.toolCallDiffs(toolCallId)` 和 `session.toolCallTerminals(toolCallId)`
暴露按 source tool call 分组后的 object-store 视图。

`session.toolCallIds()`、`session.toolCalls()`、`session.toolCallBundles()`、
`session.toolCall(toolCallId)` 和 `session.toolCallBundle(toolCallId)`
暴露 tool-call 级别的 inspection 视图。

这些对象现在还带有基础生命周期元数据，例如：
- `revision`
- `createdAt`
- `updatedAt`
- 对已完成 terminal 的 `completedAt`
- 对 kill 请求的 `stopRequestedAt`
- 对 release 行为的 `releasedAt`

同时还暴露派生的 inspection 指标：
- terminal: `outputLength`, `outputLineCount`
- diff: `newLineCount`, `oldLineCount`

`session.watchReadModel(watcher)` 允许宿主订阅读模型更新：
- `thread_entry_added`
- `thread_entry_updated`
- `diff_updated`
- `terminal_updated`

`session.watchProjection(watcher)` 暴露 runtime 自己维护的 projection 层，覆盖：
- `operation_projection_updated`
- `permission_projection_updated`
- `metadata_projection_updated`
- `usage_projection_updated`

这一层的作用是让宿主消费稳定的 live operation / permission / session summary 状态，
而不是把 raw `AcpRuntimeTurnEvent` 直接当成状态真相。

operation / permission 状态现在也有更窄的 runtime-owned inspection 视图：
- `session.operation(operationId)`
- `session.operations()`
- `session.operationPermissionRequests(operationId)`
- `session.operationBundle(operationId)`
- `session.operationBundles()`
- `session.permissionRequest(requestId)`
- `session.permissionRequests()`

同时也提供定向 watcher：
- `session.watchOperation(operationId, watcher)`
- `session.watchOperationBundle(operationId, watcher)`
- `session.watchPermissionRequest(requestId, watcher)`

`session.watchDiff(path, watcher)` 和 `session.watchTerminal(terminalId, watcher)`
提供单个 diff 或 terminal 对象的定向订阅。

`session.watchToolCallObjects(toolCallId, watcher)` 提供对某一个 tool call
关联的全部 diff/terminal 对象更新的定向订阅。

`session.watchToolCall(toolCallId, watcher)` 提供对完整 tool-call bundle 的定向订阅，
其中包括 tool call entry 本身以及分组后的 diff/terminal 对象。

事件层仍然是稳定的宿主侧 streaming 抽象。
`threadEntries()` 则是更丰富的结构化视图，面向历史恢复、tool call 检查，以及后续 thread-oriented UI。

当前 thread entry 类型包括：
- `user_message`
- `assistant_message`
- `assistant_thought`
- `plan`
- `tool_call`

`tool_call` 还可能包含：
- `locations`

当前 `tool_call.content` 类型包括：
- `content`
- `diff`
- `terminal`

`diff` 当前包含：
- `path`
- `oldText`
- `newText`
- `changeType`

`terminal` 当前包含：
- `terminalId`
- `status`
- `command`
- `cwd`
- `output`
- `truncated`
- `exitCode`

这些字段是基于 ACP tool-call content 和本地 terminal handler 能力做的 best-effort 快照，不保证所有 agent / host 组合都能填满。

另外还提供两个更窄的 runtime-side object 视图：
- `session.diffs()`
- `session.terminals()`

它们和 `threadEntries()` 共享同一底层 thread-first 模型，
目的是让宿主在不重新扫描整条 thread 的情况下，直接消费 richer diff / terminal 状态。

### Diagnostics

`AcpRuntimeDiagnostics` 当前包含：
- `lastUsage`
- `lastError`

### Operations

`AcpRuntimeOperation` 是对外部动作的统一抽象。

关键字段：
- `id`
- `turnId`
- `kind`
- `phase`
- `title`
- `target`
- `progress`
- `result`
- `failureReason`
- `permission`

`operation.permission` 是 runtime 为权限敏感动作保留的归一化证据。
当前已落地的拒绝 family 有：
- `permission_request_cancelled`
- `permission_request_end_turn`
- `mode_denied`

### Permissions

`AcpRuntimePermissionRequest` 通过这些字段把权限和动作绑定起来：
- `id`
- `turnId`
- `operationId`

顶层 turn 控制流仍保持统一。
即使底层 agent 分别表现为 `cancelled`、`end_turn + failed tool update`，或者 mode 直接拒绝，
最终权限拒绝 turn 仍然统一表现为 `AcpPermissionDeniedError`。

### Snapshot

`AcpRuntimeSnapshot` 是最小恢复模型。
它当前包含：
- `agent`
- `config`
- `currentModeId`
- `cwd`
- `mcpServers`
- `session.id`
- `version`

`agent.type` 已经内嵌在 `agent` 里。
snapshot 模型里没有独立的 runtime `agentId` 字段。

## Turn Events

当前公共 turn event 家族：
- `queued`
- `started`
- `thinking`
- `text`
- `plan_updated`
- `metadata_updated`
- `usage_updated`
- `operation_started`
- `operation_updated`
- `permission_requested`
- `permission_resolved`
- `operation_completed`
- `operation_failed`
- `completed`
- `failed`

## Errors

顶层 typed runtime errors：
- `AcpCreateError`
- `AcpLoadError`
- `AcpResumeError`
- `AcpAuthenticationError`
- `AcpPermissionDeniedError`
- `AcpTurnCancelledError`
- `AcpTurnTimeoutError`
- `AcpProtocolError`
- `AcpProcessError`

## 示例

- [Runtime SDK Minimal Demo](runtime-sdk-minimal-demo.md)
- [Runtime SDK Demo](runtime-sdk-demo.md)
