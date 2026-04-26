# Runtime SDK By Scenario

Language:
- English (default)
- [简体中文](../zh-CN/guides/runtime-sdk-by-scenario.md)

This is the recommended way to learn and adopt the public `acp-runtime` SDK.
Read it from top to bottom and move to the next stage only when the current stage matches your product needs.

For a method-by-method lookup table, see
[Runtime SDK API Coverage](runtime-sdk-api-coverage.md).

## Stage 1: Minimal Session Bootstrap

Use this stage when you only need to:
- create a runtime
- start a session
- run one turn
- capture one snapshot
- close the session

Source examples:
- [runtime-sdk-stage-1-minimal.ts](../../examples/runtime-sdk-stage-1-minimal.ts)
- [Runtime SDK Minimal Demo](runtime-sdk-minimal-demo.md)

Primary APIs:
- `AcpRuntime`
- `createStdioAcpConnectionFactory()`
- `runtime.sessions.start(...)`
- `session.turn.run(...)`
- `session.snapshot()`
- `session.close()`
- `session.capabilities`
- `session.diagnostics`
- `session.metadata`
- `session.status`

## Stage 2: Interactive Turns

Use this stage when you need:
- realtime turn output
- structured prompts
- event-by-event streaming
- explicit turn handles
- timeout handling
- host-driven turn cancellation

Source example:
- [runtime-sdk-stage-2-interactive.ts](../../examples/runtime-sdk-stage-2-interactive.ts)

Primary APIs:
- `session.turn.start(...)`
- `session.turn.cancel(turnId)`
- `session.turn.send(...)`
- `session.turn.stream(...)`
- `session.state.watch(...)`
- `session.state.metadata()`
- `session.state.usage()`

Typed runtime errors shown in this stage:
- `AcpPermissionDeniedError`
- `AcpProtocolError`
- `AcpTurnCancelledError`
- `AcpTurnTimeoutError`

## Stage 3: Recovery and Remote Sessions

Use this stage when your product needs:
- recent remote sessions from one agent
- session recovery
- explicit `load` vs `resume`
- registry-id and explicit-agent startup paths

Source example:
- [runtime-sdk-stage-3-session-recovery.ts](../../examples/runtime-sdk-stage-3-session-recovery.ts)

Primary APIs:
- `resolveRuntimeAgentFromRegistry(...)`
- `runtime.sessions.list(...)`
- `runtime.sessions.load(...)`
- `runtime.sessions.resume(...)`
- `session.state.history.drain()`

Typed runtime errors shown in this stage:
- `AcpAuthenticationError`
- `AcpCreateError`
- `AcpError`
- `AcpListError`
- `AcpLoadError`
- `AcpProcessError`
- `AcpResumeError`

## Stage 4: Agent Controls

Use this stage when you want to expose agent-native controls in your host:
- mode switching
- config option editing
- slash-command discovery

Source example:
- [runtime-sdk-stage-4-agent-control.ts](../../examples/runtime-sdk-stage-4-agent-control.ts)

Primary APIs:
- `session.agent.listModes()`
- `session.agent.listConfigOptions()`
- `session.agent.setMode()`
- `session.agent.setConfigOption()`
- `session.metadata.availableCommands`

## Stage 5: Read Model and Live Projections

Use this stage when you are building richer host inspection or UI state:
- thread view
- diff view
- terminal state
- tool-call grouping
- operation and permission inspection
- read-model watchers
- live projection watchers

Source example:
- [runtime-sdk-stage-5-read-model.ts](../../examples/runtime-sdk-stage-5-read-model.ts)

Focused guide:
- [Runtime SDK Read Models](runtime-sdk-read-models.md)

Primary APIs:
- `session.state.thread.entries()`
- `session.state.diffs.*`
- `session.state.terminals.*`
- `session.state.toolCalls.*`
- `session.state.operations.*`
- `session.state.permissions.*`
- `session.state.watch(...)`
- `session.state.metadata()`
- `session.state.usage()`
- `session.state.watch(...)`

## Stage 6: Unified Session Listing

Use this stage when your host owns a local recent-session index:
- local session list
- remote session list
- merged local/remote view

Source example:
- [runtime-sdk-stage-6-stored-sessions.ts](../../examples/runtime-sdk-stage-6-stored-sessions.ts)

Primary APIs:
- `runtime.sessions.list({ source: "local" })`
- `runtime.sessions.list({ source: "remote", agent, cwd })`
- `runtime.sessions.list({ source: "all", agent, cwd })`

## Stage 7: Host Authority and Authentication

Use this stage when you are building a real host integration instead of a simple smoke test:
- authentication method selection
- terminal auth execution
- permission policy
- filesystem authority
- terminal authority

Source examples:
- [runtime-sdk-stage-7-host-authority.ts](../../examples/runtime-sdk-stage-7-host-authority.ts)
- [runtime-demo-auth-adapter.ts](../../examples/runtime-demo-auth-adapter.ts)

Primary APIs:
- `AcpRuntimeAuthorityHandlers`
- `AcpRuntimeAuthenticationHandler`
- `AcpRuntimeFilesystemHandler`
- `AcpRuntimePermissionHandler`
- `AcpRuntimeTerminalHandler`
- `resolveRuntimeTerminalAuthenticationRequest(...)`

## Full User-Facing CLI Demo

Use the full demo when you want the whole host flow in one place:
- registry-id startup
- user-facing interactive CLI
- logging
- load / resume entry flags
- permission prompts
- auth prompts
- timeline rendering

Source example:
- [runtime-sdk-demo.ts](../../examples/runtime-sdk-demo.ts)

Guide:
- [Runtime SDK Demo](runtime-sdk-demo.md)
