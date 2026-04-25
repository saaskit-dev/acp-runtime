# Runtime SDK API

Language:
- English (default)
- [简体中文](../zh-CN/guides/runtime-sdk-api.md)

This page documents the current public SDK surface of `acp-runtime`.
It describes only host-facing runtime concepts, not raw ACP protocol messages.

## Primary Entry Points

- `AcpRuntime`
- `AcpRuntimeSession`

Internal runtime implementation is currently organized around:

- `AcpRuntime`
- `AcpRuntimeSession`
- `AcpSessionDriver`
- `acp/session-service.ts`
- `acp/profiles/`
- `acp/driver.ts`

## Runtime Construction

`AcpRuntime` is the top-level host SDK object.

Public host methods:
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

Registry-backed helper:
- `resolveRuntimeAgentFromRegistry(agentId)`

For most host integrations, `createFromRegistry` should be the default path.
It keeps agent launch resolution inside the runtime instead of repeating `command` / `args` rules in every host.

## Session Surface

`AcpRuntimeSession` exposes:

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

`AcpRuntimeAgent` may include:
- `command`
- `args`
- `env`
- `type`

`type` is the stable runtime-facing agent family identifier used for profile selection and host-side filtering.

For registry-backed startup, hosts can skip manual `AcpRuntimeAgent` construction:

```ts
const runtime = new AcpRuntime(createStdioAcpConnectionFactory());
const session = await runtime.createFromRegistry({
  agentId: "claude-acp",
  cwd: process.cwd(),
});
```

Manual `create({ agent })` remains valid, but it is now the override path for callers that need explicit launch control.

## Raw Agent State

Runtime session control is now centered on the agent's native mode and config options.

That means:
- callers should treat `currentModeId` and `config` as the primary recovery state
- hosts can inspect supported raw controls through `listAgentModes()` and `listAgentConfigOptions()`
- hosts can update raw state through `setAgentMode()` and `setAgentConfigOption()`

## Session Listing Semantics

`listAgentSessions(options)` is **agent-scoped**, not global.

It asks one concrete ACP agent process to return the sessions it knows about.
It does not aggregate across multiple agents.

If a host needs a cross-agent session picker or a global recent-session view,
that should be modeled through a host-owned registry layer.

For that host-owned layer, `AcpRuntime` now also exposes registry-backed stored-session helpers:
- `listStoredSessions(options?)`
- `deleteStoredSession(sessionId)`
- `deleteStoredSessions(options?)`
- `watchStoredSessions(watcher)`
- `refreshStoredSessions()`

These are runtime-owned history-management helpers built on top of the host registry.
They are not ACP protocol methods.

Current TypeScript SDK coverage for session management stops at:
- `session/list`
- `session/load`
- `session/resume`
- `session/close`

It does **not** currently expose a watch/delete/refresh family comparable to Zed's higher-level session-history management.
`acp-runtime` does not fake those APIs. Hosts that need deletion or refresh today should model that in their own registry/UI layer.

## Prompt Model

`AcpRuntimePrompt` supports:
- plain string input
- structured content parts
- structured role-based messages

Content parts currently support:
- `text`
- `file`
- `image`
- `audio`
- `resource`
- `json`

## Output Model

Turn completion returns:
- `outputText`
- `output`
- `turnId`

`output` is the structured runtime output channel and should be preferred for rich host rendering.

## Authority Handlers

Host-provided authority is modeled through:
- `authentication`
- `filesystem`
- `permission`
- `terminal`

These are runtime abstractions over client-side capability delegation.

## Core Public Models

### Capabilities

`AcpRuntimeCapabilities` includes:
- `agent`
- `agentInfo`
- `authMethods`
- `client`

`authMethods` describe agent-advertised or runtime-normalized login options.
Host-side login execution policy, such as terminal success-pattern matching,
belongs in the host or adapter layer rather than the runtime core model.

For the full compatibility boundary, see
[Runtime Agent Compatibility](runtime-agent-compatibility.md).

### Session Metadata

`AcpRuntimeSessionMetadata` includes:
- `id`
- `title`
- `currentModeId`
- `config`
- `availableCommands`

### Session Listing

`runtime.listAgentSessions(options)` returns:
- `sessions`
- `nextCursor`

Each session reference currently includes:
- `agentType`
- `id`
- `cwd`
- `title`
- `updatedAt`

### Host Registry

`AcpRuntimeSessionRegistry` is a host-owned global index.

It can:
- persist runtime snapshots by `session.id`
- list stored sessions by `agentType` and `cwd`
- return the stored snapshot for a given `session.id`
- delete stored sessions
- watch stored-session updates
- emit refresh notifications

The registry no longer keeps a separate agent-descriptor table.
The minimal persistence unit is `session.id -> snapshot`.

`AcpRuntimeJsonSessionRegistryStore` is the built-in persisted store.
It reads and writes the registry state as JSON on local disk.

### Thread Entries

`session.threadEntries()` exposes the runtime's thread-first read model.

This is additive. It does not replace:
- `AcpRuntimeTurnEvent`
- `AcpRuntimeOperation`

`session.diff(path)` and `session.terminal(terminalId)` expose direct lookup helpers
for runtime-owned tool objects.

`session.diffs()` and `session.terminals()` expose runtime-owned object views derived
from that same thread-first model.

`session.diffPaths()` and `session.terminalIds()` expose the current object-store indexes.

`session.toolCallDiffs(toolCallId)` and `session.toolCallTerminals(toolCallId)`
expose the object-store view grouped by source tool call.

`session.toolCallIds()`, `session.toolCalls()`, `session.toolCallBundles()`,
`session.toolCall(toolCallId)`, and `session.toolCallBundle(toolCallId)`
expose the tool-call-level inspection view.

Those objects now carry basic lifecycle metadata such as:
- `revision`
- `createdAt`
- `updatedAt`
- `completedAt` for completed terminals
- `stopRequestedAt` for kill requests
- `releasedAt` for released terminals

They also expose derived inspection metrics:
- terminal: `outputLength`, `outputLineCount`
- diff: `newLineCount`, `oldLineCount`

`session.watchReadModel(watcher)` lets hosts subscribe to read-model changes:
- `thread_entry_added`
- `thread_entry_updated`
- `diff_updated`
- `terminal_updated`

`session.watchProjection(watcher)` exposes the runtime-owned projection layer for:
- `operation_projection_updated`
- `permission_projection_updated`
- `metadata_projection_updated`
- `usage_projection_updated`

That projection layer exists so hosts can consume stable live operation/permission/session-summary state
without treating raw `AcpRuntimeTurnEvent` delivery as the source of truth.

Operation and permission state now also expose narrower runtime-owned inspection views:
- `session.operation(operationId)`
- `session.operations()`
- `session.operationPermissionRequests(operationId)`
- `session.operationBundle(operationId)`
- `session.operationBundles()`
- `session.permissionRequest(requestId)`
- `session.permissionRequests()`

And targeted watchers:
- `session.watchOperation(operationId, watcher)`
- `session.watchOperationBundle(operationId, watcher)`
- `session.watchPermissionRequest(requestId, watcher)`

`session.watchDiff(path, watcher)` and `session.watchTerminal(terminalId, watcher)`
provide targeted subscriptions for one diff or one terminal object.

`session.watchToolCallObjects(toolCallId, watcher)` provides a targeted subscription
for all diff/terminal objects associated with one tool call.

`session.watchToolCall(toolCallId, watcher)` provides a targeted subscription for the
full tool-call bundle, including the tool call entry plus grouped diff/terminal objects.

The event layer remains the stable host-facing streaming abstraction.
`threadEntries()` is the richer structured view used for history, tool-call inspection, and future thread-oriented UIs.

Current thread entry families:
- `user_message`
- `assistant_message`
- `assistant_thought`
- `plan`
- `tool_call`

`tool_call` entries may also include:
- `locations`

Current `tool_call.content` families:
- `content`
- `diff`
- `terminal`

`diff` content currently includes:
- `path`
- `oldText`
- `newText`
- `changeType`

`terminal` content currently includes:
- `terminalId`
- `status`
- `command`
- `cwd`
- `output`
- `truncated`
- `exitCode`

These fields are best-effort snapshots derived from ACP tool-call content and local terminal handlers when available.

Two narrower runtime-side object views are also available:
- `session.diffs()`
- `session.terminals()`

These are derived stores built from the same underlying thread-first model.
They exist so hosts can consume richer diff/terminal state without re-scanning `threadEntries()`.

### Diagnostics

`AcpRuntimeDiagnostics` currently includes:
- `lastUsage`
- `lastError`

### Operations

`AcpRuntimeOperation` is the public abstraction over external actions.

Key fields:
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

`operation.permission` is the normalized runtime evidence for permission-sensitive actions.
For denied operations, the current families are:
- `permission_request_cancelled`
- `permission_request_end_turn`
- `mode_denied`

### Permissions

`AcpRuntimePermissionRequest` links permission to action through:
- `id`
- `turnId`
- `operationId`

Top-level turn control flow still stays normalized.
Even when vendors differ between `cancelled`, `end_turn + failed tool update`, or mode-based refusal,
permission-denied turns still surface as `AcpPermissionDeniedError`.

### Snapshot

`AcpRuntimeSnapshot` is the minimal recovery model.
It includes:
- `agent`
- `config`
- `currentModeId`
- `cwd`
- `mcpServers`
- `session.id`
- `version`

Snapshot intentionally stores `agent.type` inside `agent`.
There is no separate runtime `agentId` field in the snapshot model.

## Turn Events

Current public turn event families:
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

Top-level typed runtime errors:
- `AcpCreateError`
- `AcpLoadError`
- `AcpResumeError`
- `AcpAuthenticationError`
- `AcpPermissionDeniedError`
- `AcpTurnCancelledError`
- `AcpTurnTimeoutError`
- `AcpProtocolError`
- `AcpProcessError`

## Examples

- [Runtime SDK Minimal Demo](runtime-sdk-minimal-demo.md)
- [Runtime SDK Demo](runtime-sdk-demo.md)
