# Runtime SDK Demo

Language:
- English (default)
- [简体中文](zh-CN/runtime-sdk-demo.md)

This page defines the recommended host-side usage of the `acp-runtime` public SDK.
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

- [runtime-sdk-demo.ts](../src/examples/runtime-sdk-demo.ts)

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

## Demo Shape

The demo is split into focused functions:

- `createSessionDemo()`
- `inspectSessionStateDemo()`
- `runSimpleTurnDemo()`
- `sendStructuredTurnDemo()`
- `streamInteractiveTurnDemo()`
- `loadAndResumeDemo()`
- `cancelTurnDemo()`
- `errorHandlingDemo()`
- `fullScenarioDemo()`

## Design Notes

- The demo treats `runtime` as the host-facing SDK instance.
- Raw agent control happens through `setAgentMode()` and `setAgentConfigOption()`.
- Permission decisions are modeled through `permission` handlers, not raw ACP messages.
- Tool execution is modeled through `Operation` events, not `tool_call` or `tool_call_update`.
- Recovery is modeled through `snapshot()` and `resume()`.
- Host control flow is modeled through typed runtime errors, not vendor `stopReason` values.
