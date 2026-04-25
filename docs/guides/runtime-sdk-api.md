# Runtime SDK API

Language:
- English (default)
- [简体中文](../zh-CN/guides/runtime-sdk-api.md)

This page documents the current public SDK surface of `acp-runtime`.
It describes only host-facing runtime concepts, not raw ACP protocol messages.

Recommended reading order:
- [Runtime SDK By Scenario](runtime-sdk-by-scenario.md)
- [Runtime SDK Read Models](runtime-sdk-read-models.md)
- [Runtime SDK API Coverage](runtime-sdk-api-coverage.md)
- this page for grouped semantics and type notes

## Primary Entry Points

- `AcpRuntime`
- `AcpRuntimeSession`

The package root intentionally keeps a narrow value-export surface:

- runtime classes and runtime-facing error types
- ACP agent launch helpers such as `createClaudeCodeAcpAgent()`
- stdio transport construction via `createStdioAcpConnectionFactory()`
- protocol alignment metadata and registry helpers

Internal implementation details such as `AcpSessionDriver`, session-service construction,
and stdio process internals are not part of the package-root public API.
The `./internal/*` subpaths are advanced escape hatches for tooling and diagnostics, not the normal host integration surface.

Internal runtime implementation is currently organized around:

- `AcpRuntime`
- `AcpRuntimeSession`
- `AcpSessionDriver`
- `acp/session-service.ts`
- `acp/profiles/`
- `acp/driver.ts`

## Runtime Construction

`AcpRuntime` is the top-level host SDK object.

Public host surface:
- `runtime.sessions.start(options)`
- `runtime.sessions.registry.start(options)`
- `runtime.sessions.load(options)`
- `runtime.sessions.registry.load(options)`
- `runtime.sessions.resume(options)`
- `runtime.sessions.remote.list(options)`
- `runtime.sessions.registry.remote.list(options)`
- `runtime.sessions.stored.list(options?)`
- `runtime.sessions.stored.delete(sessionId)`
- `runtime.sessions.stored.deleteMany(options?)`
- `runtime.sessions.stored.watch(watcher)`
- `runtime.sessions.stored.refresh()`

Registry-backed helper:
- `resolveRuntimeAgentFromRegistry(agentId)`

For most host integrations, `runtime.sessions.registry.start(...)` should be the default path.
It keeps agent launch resolution inside the runtime instead of repeating `command` / `args` rules in every host.

## Session Surface

`AcpRuntimeSession` exposes:

- `capabilities`
- `metadata`
- `diagnostics`
- `status`
- `session.agent.*`
  - `listModes()`
  - `listConfigOptions()`
  - `setMode()`
  - `setConfigOption()`
- `session.turn.*`
  - `run()`
  - `send()`
  - `stream()`
- `session.model.*`
  - `history.drain()`
  - `thread.entries()`
  - `diffs.keys()/get()/list()/watch()`
  - `terminals.ids()/get()/list()/watch()/refresh()/wait()/kill()/release()`
  - `toolCalls.ids()/get()/list()/bundle()/bundles()/diffs()/terminals()/watch()/watchObjects()`
  - `operations.ids()/get()/list()/bundle()/bundles()/permissions()/watch()/watchBundle()`
  - `permissions.ids()/get()/list()/watch()`
  - `watch(...)`
- `session.live.*`
  - `metadata()`
  - `usage()`
  - `watch()`
- `session.lifecycle.*`
  - `snapshot()`
  - `cancel()`
  - `close()`

## Session Handle Semantics

`AcpRuntimeSession` is a host-facing handle over an underlying runtime-managed session driver.

Current lifecycle rules:

- repeated `runtime.sessions.load()` calls for the same `sessionId` share one underlying driver while returning distinct handles
- repeated `runtime.sessions.resume()` calls for the same `snapshot.session.id` share one underlying driver while returning distinct handles
- closing one handle does not close sibling handles that still reference the same underlying session
- the underlying driver closes only after the final live handle closes
- once a specific handle is closed, that handle rejects `session.turn.run`, `session.turn.send`, `session.turn.stream`, `session.lifecycle.cancel`, `session.agent.setMode`, and `session.agent.setConfigOption`
- snapshot and read-model getters remain readable from a closed handle, but they no longer represent an active control surface

## Read-Model Watcher Semantics

The runtime exposes two watcher layers:

- read-model watchers such as `session.model.watch`, `session.model.diffs.watch`, `session.model.terminals.watch`, `session.model.toolCalls.watch`, and `session.model.toolCalls.watchObjects`
- projection watchers such as `session.live.watch`, `session.model.operations.watch`, `session.model.operations.watchBundle`, and `session.model.permissions.watch`

Current `tool_call` read-model behavior is incremental rather than batch-coalesced:

- when a tool call update contains derived objects like diffs or terminals, the runtime emits those derived object updates first
- the corresponding `tool_call` thread entry is emitted after the derived object updates for that same write
- `session.model.toolCalls.watch(toolCallId, watcher)` can therefore fire multiple times for one ACP `tool_call` or `tool_call_update`
- each callback receives the latest bundle snapshot visible at that step, not a deferred final-only bundle

Hosts should treat these watchers as live incremental state updates rather than assuming one callback per ACP update.

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
const session = await runtime.sessions.registry.start({
  agentId: "claude-acp",
  cwd: process.cwd(),
});
```

Manual `runtime.sessions.start({ agent })` is the override path for callers that need explicit launch control.

## Raw Agent State

Runtime session control is now centered on the agent's native mode and config options.

That means:
- callers should treat `currentModeId` and `config` as the primary recovery state
- hosts can inspect supported raw controls through `session.agent.listModes()` and `session.agent.listConfigOptions()`
- hosts can update raw state through `session.agent.setMode()` and `session.agent.setConfigOption()`

## Session Listing Semantics

`runtime.sessions.remote.list(options)` is **agent-scoped**, not global.

It asks one concrete ACP agent process to return the sessions it knows about.
It does not aggregate across multiple agents.

If a host needs a cross-agent session picker or a global recent-session view,
that should be modeled through a host-owned registry layer.

For that host-owned layer, `AcpRuntime` now also exposes registry-backed stored-session helpers:
- `runtime.sessions.stored.list(options?)`
- `runtime.sessions.stored.delete(sessionId)`
- `runtime.sessions.stored.deleteMany(options?)`
- `runtime.sessions.stored.watch(watcher)`
- `runtime.sessions.stored.refresh()`

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

`runtime.sessions.remote.list(options)` returns:
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

`session.model.thread.entries()` exposes the runtime's thread-first read model.

This is additive. It does not replace:
- `AcpRuntimeTurnEvent`
- `AcpRuntimeOperation`

`session.model.diffs.get(path)` and `session.model.terminals.get(terminalId)` expose direct lookup helpers
for runtime-owned tool objects.

`session.model.diffs.list()` and `session.model.terminals.list()` expose runtime-owned object views derived
from that same thread-first model.

`session.model.diffs.keys()` and `session.model.terminals.ids()` expose the current object-store indexes.

`session.model.toolCalls.diffs(toolCallId)` and `session.model.toolCalls.terminals(toolCallId)`
expose the object-store view grouped by source tool call.

`session.model.toolCalls.ids()`, `session.model.toolCalls.list()`, `session.model.toolCalls.bundles()`,
`session.model.toolCalls.get(toolCallId)`, and `session.model.toolCalls.bundle(toolCallId)`
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

`session.model.watch(watcher)` lets hosts subscribe to read-model changes:
- `thread_entry_added`
- `thread_entry_updated`
- `diff_updated`
- `terminal_updated`

`session.live.watch(watcher)` exposes the runtime-owned projection layer for:
- `operation_projection_updated`
- `permission_projection_updated`
- `metadata_projection_updated`
- `usage_projection_updated`

That projection layer exists so hosts can consume stable live operation/permission/session-summary state
without treating raw `AcpRuntimeTurnEvent` delivery as the source of truth.

Operation and permission state now also expose narrower runtime-owned inspection views:
- `session.model.operations.get(operationId)`
- `session.model.operations.list()`
- `session.model.operations.permissions(operationId)`
- `session.model.operations.bundle(operationId)`
- `session.model.operations.bundles()`
- `session.model.permissions.get(requestId)`
- `session.model.permissions.list()`

And targeted watchers:
- `session.model.operations.watch(operationId, watcher)`
- `session.model.operations.watchBundle(operationId, watcher)`
- `session.model.permissions.watch(requestId, watcher)`

`session.model.diffs.watch(path, watcher)` and `session.model.terminals.watch(terminalId, watcher)`
provide targeted subscriptions for one diff or one terminal object.

`session.model.toolCalls.watchObjects(toolCallId, watcher)` provides a targeted subscription
for all diff/terminal objects associated with one tool call.

`session.model.toolCalls.watch(toolCallId, watcher)` provides a targeted subscription for the
full tool-call bundle, including the tool call entry plus grouped diff/terminal objects.

The event layer remains the stable host-facing streaming abstraction.
`session.model.thread.entries()` is the richer structured view used for history, tool-call inspection, and future thread-oriented UIs.

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
- `session.model.diffs.list()`
- `session.model.terminals.list()`

These are derived stores built from the same underlying thread-first model.
They exist so hosts can consume richer diff/terminal state without re-scanning `session.model.thread.entries()`.

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
