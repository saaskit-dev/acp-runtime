# RFC-0004: Runtime Diagnostics and Host Integration

Language:
- English (default)
- [简体中文](zh-CN/rfcs/0004-runtime-diagnostics-and-host-integration.md)

## Summary

This RFC consolidates observability and host integration around one boundary:

- the host consumes runtime semantics
- diagnostics retain raw ACP and vendor evidence

Key points:

- hosts should integrate through the public runtime SDK rather than raw ACP
- diagnostics are a parallel layer for transcripts, raw events, and vendor metadata
- protocol-shape compatibility quirks should be absorbed at the ACP boundary where possible
- logger, hooks, and event sinks remain useful, but must not leak raw protocol details into the public API

## Current Code Mapping

Current host-integration boundaries in code:

- host code calls `AcpRuntime` and `AcpRuntimeSession`
- host authority is provided through `authentication`, `filesystem`, `permission`, and `terminal` handlers
- ACP protocol compatibility shims live in `acp/stdio-connection.ts`
- normalized runtime errors live in `errors.ts`

This keeps protocol quirks and raw ACP concerns at the transport/adapter edge instead of surfacing them as public SDK primitives.

## Translation

- [简体中文](zh-CN/rfcs/0004-runtime-diagnostics-and-host-integration.md)
