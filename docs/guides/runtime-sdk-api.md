# Runtime SDK API

Language:
- English (default)
- [简体中文](../zh-CN/guides/runtime-sdk-api.md)

This page documents the current public SDK surface of `acp-runtime`.
It describes only host-facing runtime concepts, not raw ACP protocol messages.

Recommended reading order:
- [Runtime SDK By Scenario](runtime-sdk-by-scenario.md)
- [Runtime SDK Observability](runtime-sdk-observability.md)
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
- protocol alignment metadata, registry helpers, and default path helpers

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
- `runtime.sessions.load(options)`
- `runtime.sessions.resume(options)`
- `runtime.sessions.list(options?)`

Registry-backed helper:
- `resolveRuntimeAgentFromRegistry(agentId)`
- `resolveRuntimeHomePath(...segments)`
- `resolveRuntimeCachePath(...segments)`

Default runtime-owned state now lives under `~/.acp-runtime/`.

- `resolveRuntimeHomePath(...)` resolves paths under the runtime home root
- `resolveRuntimeCachePath(...)` resolves cache paths under `~/.acp-runtime/cache/`
- `ACP_RUNTIME_HOME_DIR` overrides the home root
- `ACP_RUNTIME_CACHE_DIR` overrides the cache root only

For most host integrations, `runtime.sessions.start({ agent: "claude-acp", ... })` should be the default path.
Passing an agent id keeps launch resolution inside the runtime instead of repeating `command` / `args` rules in every host.
Runtime-owned local state is enabled by default and stored at `~/.acp-runtime/state/runtime-session-registry.json`.
Use `new AcpRuntime(factory, { state: { sessionRegistryPath } })` to override that path, or `{ state: false }` to disable local state.

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
  - `cancel(turnId)`
  - `start()`
  - `run()`
  - `send()`
  - `stream()`
  - `queue.clear()/sendNow()/get()/list()/remove()`
- `session.queue.*`
  - `policy()`
  - `setPolicy({ delivery })`
- `session.state.*`
  - `history.drain()`
  - `thread.entries()`
  - `diffs.keys()/get()/list()/watch()`
  - `terminals.ids()/get()/list()/watch()/refresh()/wait()/kill()/release()`
  - `toolCalls.ids()/get()/list()/bundle()/bundles()/diffs()/terminals()/watch()/watchObjects()`
  - `operations.ids()/get()/list()/bundle()/bundles()/permissions()/watch()/watchBundle()`
  - `permissions.ids()/get()/list()/watch()`
  - `metadata()`
  - `usage()`
  - `watch()`
- `session.snapshot()`
- `session.close()`

Turn submission is queue-first. `start()`, `send()`, `run()`, and `stream()` create a queued turn and mark it ready automatically. Hosts that need explicit scheduling should keep the returned `turnId`, then call `session.turn.queue.sendNow(turnId)` to move that not-yet-started queued turn to the front and cancel the active turn, `remove(turnId)` to withdraw one queued turn before it starts, or `clear()` to withdraw all queued turns before they start.
`AcpRuntimeQueuedTurn.status` is `queued` before dispatch and `ready` after dispatch while waiting for execution.

Queue drain policy is session-level. Pass `queue: { delivery: "sequential" | "coalesce" }` to `runtime.sessions.start/load/resume`, or update future drains with `session.queue.setPolicy(...)`.
`sequential` sends ready queued turns one by one. `coalesce` drains all ready queued prompts into one agent prompt; the first turn becomes the actual turn, and later merged turns receive a terminal `coalesced` event with `intoTurnId`.

## Session Handle Semantics

`AcpRuntimeSession` is a host-facing handle over an underlying runtime-managed session driver.

Current handle rules:

- repeated `runtime.sessions.load()` calls for the same `sessionId` share one underlying driver while returning distinct handles
- repeated `runtime.sessions.resume()` calls for the same `sessionId` share one underlying driver while returning distinct handles
- closing one handle does not close sibling handles that still reference the same underlying session
- the underlying driver closes only after the final live handle closes
- once a specific handle is closed, that handle rejects `session.turn.start`, `session.turn.run`, `session.turn.send`, `session.turn.stream`, `session.turn.cancel(turnId)`, `session.agent.setMode`, and `session.agent.setConfigOption`
- snapshot and read-model getters remain readable from a closed handle, but they no longer represent an active control surface

## Read-Model Watcher Semantics

The runtime exposes state watchers at two granularities:

- broad state watchers such as `session.state.watch`, which receive read-model and projection updates
- targeted watchers such as `session.state.diffs.watch`, `session.state.terminals.watch`, `session.state.toolCalls.watch`, `session.state.toolCalls.watchObjects`, `session.state.operations.watch`, `session.state.operations.watchBundle`, and `session.state.permissions.watch`

Current `tool_call` read-model behavior is incremental rather than batch-coalesced:

- when a tool call update contains derived objects like diffs or terminals, the runtime emits those derived object updates first
- the corresponding `tool_call` thread entry is emitted after the derived object updates for that same write
- `session.state.toolCalls.watch(toolCallId, watcher)` can therefore fire multiple times for one ACP `tool_call` or `tool_call_update`
- each callback receives the latest bundle snapshot visible at that step, not a deferred final-only bundle

Hosts should treat these watchers as live incremental state updates rather than assuming one callback per ACP update.

## Public String Constants

Public discriminant strings remain wire-stable, but callers should prefer the exported constants instead of hard-coded string literals:

```ts
import {
  AcpRuntimeOperationKind,
  AcpRuntimeReadModelUpdateType,
  AcpRuntimeThreadEntryKind,
  AcpRuntimeTurnEventType,
} from "@saaskit-dev/acp-runtime";

if (event.type === AcpRuntimeTurnEventType.UsageUpdated) {
  console.log(event.usage.totalTokens);
}

if (entry.kind === AcpRuntimeThreadEntryKind.AssistantMessage) {
  console.log(entry.text);
}
```

The same pattern exists for operation kinds/phases, projection update types, read-model update types, content part types, prompt roles, permission kinds/scopes, queue delivery, session status, terminal status, and observability redaction kinds.

## Agent Identity

`AcpRuntimeAgent` may include:
- `command`
- `args`
- `env`
- `type`

`type` is the stable runtime-facing agent family identifier used for profile selection and host-side filtering.

For registry-id startup, hosts can skip manual `AcpRuntimeAgent` construction by passing a registry agent id:

```ts
const runtime = new AcpRuntime(createStdioAcpConnectionFactory());
const session = await runtime.sessions.start({
  agent: "claude-acp",
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

`runtime.sessions.list({ source: "remote", agent, cwd })` is **agent-scoped**, not global.

It asks one concrete ACP agent process to return the sessions it knows about.
It does not aggregate across multiple agents.

For a local recent-session view, use `runtime.sessions.list({ source: "local" })`.
For a merged view, use `runtime.sessions.list({ source: "all", agent, cwd })`.
Returned references include `source: "local" | "remote" | "both"` when the source is known.

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

`runtime.sessions.list(options)` returns:
- `sessions`
- `nextCursor`

Each session reference currently includes:
- `agentType`
- `id`
- `cwd`
- `title`
- `updatedAt`

### Runtime State

The local session index is runtime-owned implementation detail.
Hosts interact with it through `runtime.sessions.list({ source: "local" })`,
`runtime.sessions.load({ sessionId, ... })`, and `runtime.sessions.resume({ sessionId, ... })`.

### Thread Entries

`session.state.thread.entries()` exposes the runtime's thread-first read model.

This is additive. It does not replace:
- `AcpRuntimeTurnEvent`
- `AcpRuntimeOperation`

`session.state.diffs.get(path)` and `session.state.terminals.get(terminalId)` expose direct lookup helpers
for runtime-owned tool objects.

`session.state.diffs.list()` and `session.state.terminals.list()` expose runtime-owned object views derived
from that same thread-first model.

`session.state.diffs.keys()` and `session.state.terminals.ids()` expose the current object-store indexes.

`session.state.toolCalls.diffs(toolCallId)` and `session.state.toolCalls.terminals(toolCallId)`
expose the object-store view grouped by source tool call.

`session.state.toolCalls.ids()`, `session.state.toolCalls.list()`, `session.state.toolCalls.bundles()`,
`session.state.toolCalls.get(toolCallId)`, and `session.state.toolCalls.bundle(toolCallId)`
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

`session.state.watch(watcher)` lets hosts subscribe to read-model changes:
- `thread_entry_added`
- `thread_entry_updated`
- `diff_updated`
- `terminal_updated`

It also exposes the runtime-owned projection layer for:
- `operation_projection_updated`
- `permission_projection_updated`
- `metadata_projection_updated`
- `usage_projection_updated`

That projection layer exists so hosts can consume stable live operation/permission/session-summary state
without treating raw `AcpRuntimeTurnEvent` delivery as the source of truth.

Operation and permission state now also expose narrower runtime-owned inspection views:
- `session.state.operations.get(operationId)`
- `session.state.operations.list()`
- `session.state.operations.permissions(operationId)`
- `session.state.operations.bundle(operationId)`
- `session.state.operations.bundles()`
- `session.state.permissions.get(requestId)`
- `session.state.permissions.list()`

And targeted watchers:
- `session.state.operations.watch(operationId, watcher)`
- `session.state.operations.watchBundle(operationId, watcher)`
- `session.state.permissions.watch(requestId, watcher)`

`session.state.diffs.watch(path, watcher)` and `session.state.terminals.watch(terminalId, watcher)`
provide targeted subscriptions for one diff or one terminal object.

`session.state.toolCalls.watchObjects(toolCallId, watcher)` provides a targeted subscription
for all diff/terminal objects associated with one tool call.

`session.state.toolCalls.watch(toolCallId, watcher)` provides a targeted subscription for the
full tool-call bundle, including the tool call entry plus grouped diff/terminal objects.

The event layer remains the stable host-facing streaming abstraction.
`session.state.thread.entries()` is the richer structured view used for history, tool-call inspection, and future thread-oriented UIs.

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
- `session.state.diffs.list()`
- `session.state.terminals.list()`

These are derived stores built from the same underlying thread-first model.
They exist so hosts can consume richer diff/terminal state without re-scanning `session.state.thread.entries()`.

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
- `cancelled`
- `coalesced`
- `withdrawn`
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
