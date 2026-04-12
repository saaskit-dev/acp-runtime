# RFC-0001: Runtime Public Abstraction

Language:
- English (default)
- [简体中文](zh-CN/rfcs/0001-runtime-public-abstraction.md)

## Summary

This RFC defines the public abstraction of `acp-runtime` and the boundary between:

- the host-facing SDK
- the runtime core
- the ACP adapter
- diagnostics

Key points:

- the public SDK must expose runtime concepts, not raw ACP or vendor concepts
- the public runtime surface is centered on `AcpRuntime` and `AcpRuntimeSession`
- ACP-specific orchestration lives behind `AcpSessionDriver`, `acp/session-service.ts`, and `acp/profiles/`
- operations are the public abstraction over tool execution
- permission requests must be linked to operations through runtime ids
- outcomes and errors must be normalized across vendors
- implementation must follow the public model, not the other way around

## Current Code Mapping

The current `src/runtime` layout corresponding to this RFC is:

- `runtime.ts`: host-facing runtime facade
- `session.ts`: host-facing session object
- `session-driver.ts`: internal driver boundary
- `session-registry.ts`: host-owned snapshot index
- `acp/session-service.ts`: ACP session orchestration
- `acp/profiles/`: agent-specific normalization strategy selection
- `acp/driver.ts`: ACP SDK-backed session driver

The intended object relationship is:

`AcpRuntime -> AcpRuntimeSession -> AcpSessionDriver`

The host depends only on the first two objects. The driver remains an internal normalization boundary.

## Translation

- [简体中文](zh-CN/rfcs/0001-runtime-public-abstraction.md)
