# Runtime SDK Demo

Language:
- English (default)
- [简体中文](../zh-CN/guides/runtime-sdk-demo.md)

This page defines the host-side usage of the `acp-runtime` public SDK.
It is intentionally written only in runtime concepts:

- `AcpRuntime`
- `AcpRuntimeSession`
- `Policy`
- `Operation`
- `PermissionRequest`
- `Snapshot`
- typed runtime errors

It does not use raw ACP methods or vendor-specific protocol details.

## Source Demo

- [runtime-sdk-demo.ts](../../examples/runtime-sdk-demo.ts)

Recommended companions:
- [Runtime SDK By Scenario](runtime-sdk-by-scenario.md)
- [Runtime SDK API Coverage](runtime-sdk-api-coverage.md)

This unified example uses `runtime.sessions.start({ agent })` as the default host entry point and switches behavior by agent id.

## Covered Scenarios

- create a new session with authority handlers
- inspect session capabilities, metadata, and diagnostics
- run a simple text turn
- send a structured prompt and receive structured output
- stream a turn and react to operations and permission requests
- load an existing session
- snapshot and resume a session
- cancel an in-flight turn
- handle all top-level typed runtime errors
- run a full end-to-end host workflow

## Position In The Reading Order

Use this file after the staged examples when you want the entire user-facing host flow in one place:

- startup
- session selection
- interactive turn rendering
- permissions
- authentication
- load / resume
- local CLI commands

## Design Notes

- The demo treats `runtime` as the host-facing SDK instance.
- Agent startup is resolved by passing a registry agent id to `runtime.sessions.start(...)` instead of hard-coded launch arguments.
- Raw agent control happens through `session.agent.setMode()` and `session.agent.setConfigOption()`.
- Permission decisions are modeled through `permission` handlers, not raw ACP messages.
- Tool execution is modeled through `Operation` events, not `tool_call` or `tool_call_update`.
- Recovery is modeled through `session.snapshot()` and `runtime.sessions.resume()`.
- Host control flow is modeled through typed runtime errors, not vendor `stopReason` values.
