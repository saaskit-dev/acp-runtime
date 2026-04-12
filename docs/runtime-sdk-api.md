# Runtime SDK API

Language:
- English (default)
- [简体中文](zh-CN/runtime-sdk-api.md)

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
- `listAgentSessions(options)`
- `load(options)`
- `resume(options)`

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
- `cancel()`
- `close()`

## Agent Identity

`AcpRuntimeAgent` may include:
- `command`
- `args`
- `env`
- `type`

`type` is the stable runtime-facing agent family identifier used for profile selection and host-side filtering.

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

The registry no longer keeps a separate agent-descriptor table.
The minimal persistence unit is `session.id -> snapshot`.

`AcpRuntimeJsonSessionRegistryStore` is the built-in persisted store.
It reads and writes the registry state as JSON on local disk.

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

### Permissions

`AcpRuntimePermissionRequest` links permission to action through:
- `id`
- `turnId`
- `operationId`

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
