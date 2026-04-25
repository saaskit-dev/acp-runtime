# Runtime SDK API Coverage

Language:
- English (default)
- [简体中文](../zh-CN/guides/runtime-sdk-api-coverage.md)

This page maps the public `acp-runtime` SDK to the staged examples and guides.

If you want the recommended learning order first, start with
[Runtime SDK By Scenario](runtime-sdk-by-scenario.md).
If you want a deeper explanation of `thread`, keyed object stores, and live projections,
also read [Runtime SDK Read Models](runtime-sdk-read-models.md).

## Runtime Bootstrap Values

| API | Coverage |
| --- | --- |
| `AcpRuntime` | Stage 1, [runtime-sdk-stage-1-minimal.ts](../../examples/runtime-sdk-stage-1-minimal.ts) |
| `AcpRuntimeSessionRegistry` | Stage 1, [runtime-sdk-stage-1-minimal.ts](../../examples/runtime-sdk-stage-1-minimal.ts) |
| `AcpRuntimeJsonSessionRegistryStore` | Stage 1, [runtime-sdk-stage-1-minimal.ts](../../examples/runtime-sdk-stage-1-minimal.ts) |
| `createStdioAcpConnectionFactory()` | Stage 1, [runtime-sdk-stage-1-minimal.ts](../../examples/runtime-sdk-stage-1-minimal.ts) |
| `resolveRuntimeAgentFromRegistry(...)` | Stage 3, [runtime-sdk-stage-3-session-recovery.ts](../../examples/runtime-sdk-stage-3-session-recovery.ts) |
| `resolveRuntimeTerminalAuthenticationRequest(...)` | Stage 7, [runtime-sdk-stage-7-host-authority.ts](../../examples/runtime-sdk-stage-7-host-authority.ts) |

## Runtime Session Management

| API | Coverage |
| --- | --- |
| `runtime.sessions.start(...)` | Stage 1 explicit path, [runtime-sdk-stage-1-minimal.ts](../../examples/runtime-sdk-stage-1-minimal.ts) |
| `runtime.sessions.registry.start(...)` | Stage 1 default path, [runtime-sdk-stage-1-minimal.ts](../../examples/runtime-sdk-stage-1-minimal.ts) |
| `runtime.sessions.load(...)` | Stage 3, [runtime-sdk-stage-3-session-recovery.ts](../../examples/runtime-sdk-stage-3-session-recovery.ts) |
| `runtime.sessions.registry.load(...)` | Stage 3, [runtime-sdk-stage-3-session-recovery.ts](../../examples/runtime-sdk-stage-3-session-recovery.ts) |
| `runtime.sessions.resume(...)` | Stage 3, [runtime-sdk-stage-3-session-recovery.ts](../../examples/runtime-sdk-stage-3-session-recovery.ts) |
| `runtime.sessions.remote.list(...)` | Stage 3, [runtime-sdk-stage-3-session-recovery.ts](../../examples/runtime-sdk-stage-3-session-recovery.ts) |
| `runtime.sessions.registry.remote.list(...)` | Stage 3, [runtime-sdk-stage-3-session-recovery.ts](../../examples/runtime-sdk-stage-3-session-recovery.ts) |
| `runtime.sessions.stored.list(...)` | Stage 6, [runtime-sdk-stage-6-stored-sessions.ts](../../examples/runtime-sdk-stage-6-stored-sessions.ts) |
| `runtime.sessions.stored.delete(...)` | Stage 6, [runtime-sdk-stage-6-stored-sessions.ts](../../examples/runtime-sdk-stage-6-stored-sessions.ts) |
| `runtime.sessions.stored.deleteMany(...)` | Stage 6, [runtime-sdk-stage-6-stored-sessions.ts](../../examples/runtime-sdk-stage-6-stored-sessions.ts) |
| `runtime.sessions.stored.watch(...)` | Stage 6, [runtime-sdk-stage-6-stored-sessions.ts](../../examples/runtime-sdk-stage-6-stored-sessions.ts) |
| `runtime.sessions.stored.refresh()` | Stage 6, [runtime-sdk-stage-6-stored-sessions.ts](../../examples/runtime-sdk-stage-6-stored-sessions.ts) |

## Session Getters

| API | Coverage |
| --- | --- |
| `session.capabilities` | Stage 1, [runtime-sdk-stage-1-minimal.ts](../../examples/runtime-sdk-stage-1-minimal.ts) |
| `session.diagnostics` | Stage 1, [runtime-sdk-stage-1-minimal.ts](../../examples/runtime-sdk-stage-1-minimal.ts) |
| `session.metadata` | Stage 1 and Stage 4 |
| `session.status` | Stage 1 and Stage 3 |

## Session Agent Controls

| API | Coverage |
| --- | --- |
| `session.agent.listModes()` | Stage 4, [runtime-sdk-stage-4-agent-control.ts](../../examples/runtime-sdk-stage-4-agent-control.ts) |
| `session.agent.listConfigOptions()` | Stage 4, [runtime-sdk-stage-4-agent-control.ts](../../examples/runtime-sdk-stage-4-agent-control.ts) |
| `session.agent.setMode()` | Stage 4, [runtime-sdk-stage-4-agent-control.ts](../../examples/runtime-sdk-stage-4-agent-control.ts) |
| `session.agent.setConfigOption()` | Stage 4, [runtime-sdk-stage-4-agent-control.ts](../../examples/runtime-sdk-stage-4-agent-control.ts) |

## Session Turn Execution

| API | Coverage |
| --- | --- |
| `session.turn.run(...)` | Stage 1 and Stage 5 |
| `session.turn.send(...)` | Stage 2, [runtime-sdk-stage-2-interactive.ts](../../examples/runtime-sdk-stage-2-interactive.ts) |
| `session.turn.stream(...)` | Stage 2, [runtime-sdk-stage-2-interactive.ts](../../examples/runtime-sdk-stage-2-interactive.ts) |

## Session Read Model

| API | Coverage |
| --- | --- |
| `session.model.history.drain()` | Stage 3 and Stage 5 |
| `session.model.thread.entries()` | Stage 5, [runtime-sdk-stage-5-read-model.ts](../../examples/runtime-sdk-stage-5-read-model.ts) |
| `session.model.diffs.keys()` | Stage 5 |
| `session.model.diffs.get()` | Stage 5 |
| `session.model.diffs.list()` | Stage 5 |
| `session.model.diffs.watch()` | Stage 5 |
| `session.model.terminals.ids()` | Stage 5 |
| `session.model.terminals.get()` | Stage 5 |
| `session.model.terminals.list()` | Stage 5 |
| `session.model.terminals.watch()` | Stage 5 |
| `session.model.terminals.refresh()` | Stage 5 |
| `session.model.terminals.wait()` | Stage 5 |
| `session.model.terminals.kill()` | Stage 5 |
| `session.model.terminals.release()` | Stage 5 |
| `session.model.toolCalls.ids()` | Stage 5 |
| `session.model.toolCalls.get()` | Stage 5 |
| `session.model.toolCalls.list()` | Stage 5 |
| `session.model.toolCalls.bundle()` | Stage 5 |
| `session.model.toolCalls.bundles()` | Stage 5 |
| `session.model.toolCalls.diffs()` | Stage 5 |
| `session.model.toolCalls.terminals()` | Stage 5 |
| `session.model.toolCalls.watch()` | Stage 5 |
| `session.model.toolCalls.watchObjects()` | Stage 5 |
| `session.model.operations.ids()` | Stage 5 |
| `session.model.operations.get()` | Stage 5 |
| `session.model.operations.list()` | Stage 5 |
| `session.model.operations.bundle()` | Stage 5 |
| `session.model.operations.bundles()` | Stage 5 |
| `session.model.operations.permissions()` | Stage 5 |
| `session.model.operations.watch()` | Stage 5 |
| `session.model.operations.watchBundle()` | Stage 5 |
| `session.model.permissions.ids()` | Stage 5 |
| `session.model.permissions.get()` | Stage 5 |
| `session.model.permissions.list()` | Stage 5 |
| `session.model.permissions.watch()` | Stage 5 |
| `session.model.watch(...)` | Stage 5 |

## Session Live Projection

| API | Coverage |
| --- | --- |
| `session.live.metadata()` | Stage 2 and Stage 5 |
| `session.live.usage()` | Stage 2 and Stage 5 |
| `session.live.watch(...)` | Stage 2 and Stage 5 |

## Session Lifecycle

| API | Coverage |
| --- | --- |
| `session.lifecycle.snapshot()` | Stage 1 and Stage 3 |
| `session.lifecycle.cancel()` | Stage 2, [runtime-sdk-stage-2-interactive.ts](../../examples/runtime-sdk-stage-2-interactive.ts) |
| `session.lifecycle.close()` | Stage 1 and all later stages |

## Authority and Host Integration

| API | Coverage |
| --- | --- |
| `AcpRuntimeAuthorityHandlers` | Stage 7, [runtime-sdk-stage-7-host-authority.ts](../../examples/runtime-sdk-stage-7-host-authority.ts) |
| `AcpRuntimeAuthenticationHandler` | Stage 7 |
| `AcpRuntimeFilesystemHandler` | Stage 7 |
| `AcpRuntimePermissionHandler` | Stage 7 |
| `AcpRuntimeTerminalHandler` | Stage 7 |

## Agent Launch Helpers

| API | Coverage |
| --- | --- |
| `createSimulatorAgentAcpAgent(...)` | Stage 1 explicit path, [runtime-sdk-stage-1-minimal.ts](../../examples/runtime-sdk-stage-1-minimal.ts) |
| `createClaudeCodeAcpAgent(...)` | Manual-agent override path, same pattern as Stage 1 explicit start |
| `createCodexAcpAgent(...)` | Manual-agent override path, same pattern as Stage 1 explicit start |
| `createGeminiCliAcpAgent(...)` | Manual-agent override path, same pattern as Stage 1 explicit start |
| `*_COMMAND`, `*_PACKAGE`, `*_REGISTRY_ID` constants | agent launch metadata for explicit startup and tooling integration |

## Typed Runtime Errors

| API | Coverage |
| --- | --- |
| `AcpError` | Stage 3 recovery example |
| `AcpAuthenticationError` | Stage 3 recovery example |
| `AcpCreateError` | Stage 3 recovery example |
| `AcpListError` | Stage 3 recovery example |
| `AcpLoadError` | Stage 3 recovery example |
| `AcpProcessError` | Stage 3 recovery example |
| `AcpResumeError` | Stage 3 recovery example |
| `AcpPermissionDeniedError` | Stage 2 interactive example |
| `AcpProtocolError` | Stage 2 interactive example |
| `AcpTurnCancelledError` | Stage 2 interactive example |
| `AcpTurnTimeoutError` | Stage 2 interactive example |

## Public Type Families

The package root also exports the runtime-facing type families used by the staged examples:

- prompt and output types such as `AcpRuntimePrompt`, `AcpRuntimeContentPart`, `AcpRuntimeTurnEvent`, and `AcpRuntimeTurnCompletion`
- agent-control types such as `AcpRuntimeAgentMode`, `AcpRuntimeAgentConfigOption`, and `AcpRuntimeAvailableCommand`
- read-model types such as `AcpRuntimeThreadEntry`, `AcpRuntimeDiffSnapshot`, `AcpRuntimeTerminalSnapshot`, `AcpRuntimeToolCallBundle`, `AcpRuntimeOperationBundle`, and `AcpRuntimePermissionRequest`
- live projection types such as `AcpRuntimeProjectionUpdate` and `AcpRuntimeUsage`
- authority types such as `AcpRuntimeAuthorityHandlers` and the handler specializations
- registry and recovery types such as `AcpRuntimeSnapshot`, `AcpRuntimeSessionReference`, `AcpRuntimeSessionList`, and `AcpRuntimeRegistryListOptions`

See [Runtime SDK API](runtime-sdk-api.md) for the grouped type catalog and semantic notes.
