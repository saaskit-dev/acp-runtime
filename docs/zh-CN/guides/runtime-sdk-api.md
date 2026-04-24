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
- `load(options)`
- `loadFromRegistry(options)`
- `resume(options)`

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

registry 现在不再单独维护 agent 描述表。
最小持久化单元就是 `session.id -> snapshot`。

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
