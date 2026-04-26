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
| `createStdioAcpConnectionFactory()` | Stage 1, [runtime-sdk-stage-1-minimal.ts](../../examples/runtime-sdk-stage-1-minimal.ts) |
| `resolveRuntimeHomePath(...)` | Stage 1, [runtime-sdk-stage-1-minimal.ts](../../examples/runtime-sdk-stage-1-minimal.ts) |
| `resolveRuntimeCachePath(...)` | API guide default-path section |
| `resolveRuntimeAgentFromRegistry(...)` | Stage 3, [runtime-sdk-stage-3-session-recovery.ts](../../examples/runtime-sdk-stage-3-session-recovery.ts) |
| `resolveRuntimeTerminalAuthenticationRequest(...)` | Stage 7, [runtime-sdk-stage-7-host-authority.ts](../../examples/runtime-sdk-stage-7-host-authority.ts) |

## Runtime Session Management

| API | Coverage |
| --- | --- |
| `runtime.sessions.start(...)` | Stage 1, [runtime-sdk-stage-1-minimal.ts](../../examples/runtime-sdk-stage-1-minimal.ts) |
| `runtime.sessions.load(...)` | Stage 3, [runtime-sdk-stage-3-session-recovery.ts](../../examples/runtime-sdk-stage-3-session-recovery.ts) |
| `runtime.sessions.resume(...)` | Stage 3, [runtime-sdk-stage-3-session-recovery.ts](../../examples/runtime-sdk-stage-3-session-recovery.ts) |
| `runtime.sessions.list(...)` | Stage 3 and Stage 6, [runtime-sdk-stage-6-stored-sessions.ts](../../examples/runtime-sdk-stage-6-stored-sessions.ts) |

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
| `session.turn.queue.clear()/sendNow()/get()/list()/remove()` | Interactive smoke CLI, [runtime-sdk-demo.ts](../../examples/runtime-sdk-demo.ts) |
| `session.queue.policy()/setPolicy(...)` | Interactive smoke CLI, [runtime-sdk-demo.ts](../../examples/runtime-sdk-demo.ts) |

## Session Read Model

| API | Coverage |
| --- | --- |
| `session.state.history.drain()` | Stage 3 and Stage 5 |
| `session.state.thread.entries()` | Stage 5, [runtime-sdk-stage-5-read-model.ts](../../examples/runtime-sdk-stage-5-read-model.ts) |
| `session.state.diffs.keys()` | Stage 5 |
| `session.state.diffs.get()` | Stage 5 |
| `session.state.diffs.list()` | Stage 5 |
| `session.state.diffs.watch()` | Stage 5 |
| `session.state.terminals.ids()` | Stage 5 |
| `session.state.terminals.get()` | Stage 5 |
| `session.state.terminals.list()` | Stage 5 |
| `session.state.terminals.watch()` | Stage 5 |
| `session.state.terminals.refresh()` | Stage 5 |
| `session.state.terminals.wait()` | Stage 5 |
| `session.state.terminals.kill()` | Stage 5 |
| `session.state.terminals.release()` | Stage 5 |
| `session.state.toolCalls.ids()` | Stage 5 |
| `session.state.toolCalls.get()` | Stage 5 |
| `session.state.toolCalls.list()` | Stage 5 |
| `session.state.toolCalls.bundle()` | Stage 5 |
| `session.state.toolCalls.bundles()` | Stage 5 |
| `session.state.toolCalls.diffs()` | Stage 5 |
| `session.state.toolCalls.terminals()` | Stage 5 |
| `session.state.toolCalls.watch()` | Stage 5 |
| `session.state.toolCalls.watchObjects()` | Stage 5 |
| `session.state.operations.ids()` | Stage 5 |
| `session.state.operations.get()` | Stage 5 |
| `session.state.operations.list()` | Stage 5 |
| `session.state.operations.bundle()` | Stage 5 |
| `session.state.operations.bundles()` | Stage 5 |
| `session.state.operations.permissions()` | Stage 5 |
| `session.state.operations.watch()` | Stage 5 |
| `session.state.operations.watchBundle()` | Stage 5 |
| `session.state.permissions.ids()` | Stage 5 |
| `session.state.permissions.get()` | Stage 5 |
| `session.state.permissions.list()` | Stage 5 |
| `session.state.permissions.watch()` | Stage 5 |
| `session.state.watch(...)` | Stage 5 |

## Session State Projection

| API | Coverage |
| --- | --- |
| `session.state.metadata()` | Stage 2 and Stage 5 |
| `session.state.usage()` | Stage 2 and Stage 5 |
| `session.state.watch(...)` | Stage 2 and Stage 5 |

## Session Handle

| API | Coverage |
| --- | --- |
| `session.snapshot()` | Stage 1 and Stage 3 |
| `session.turn.start()` | Stage 2, [runtime-sdk-stage-2-interactive.ts](../../examples/runtime-sdk-stage-2-interactive.ts) |
| `session.turn.cancel(turnId)` | Stage 2, [runtime-sdk-stage-2-interactive.ts](../../examples/runtime-sdk-stage-2-interactive.ts) |
| `session.close()` | Stage 1 and all later stages |

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
- recovery types such as `AcpRuntimeSnapshot`, `AcpRuntimeSessionReference`, and `AcpRuntimeSessionList`

See [Runtime SDK API](runtime-sdk-api.md) for the grouped type catalog and semantic notes.
