# Client Integration Guide

Language:
- English (default)
- [简体中文](../zh-CN/guides/client-integration-guide.md)

## Overview

This guide explains how to integrate `simulator-agent-acp` into an ACP client.

If your product is using `acp-runtime` as the host SDK rather than talking to raw ACP transport directly,
prefer the runtime's registry-backed entry point:

```ts
const runtime = new AcpRuntime(createStdioAcpConnectionFactory());
const session = await runtime.sessions.registry.start({
  agentId: "simulator-agent-acp-local",
  cwd: process.cwd(),
});
```

That keeps launch resolution centralized in the runtime instead of duplicating `command` / `args` logic in each host.

Protocol alignment for this guide:

- ACP protocol version: `1`
- ACP source repo: `https://github.com/agentclientprotocol/agent-client-protocol`
- ACP source ref: `v0.11.4`
- Last verified against upstream docs: `2026-04-08`
- Reference pages:
  - `https://agentclientprotocol.com/protocol/overview`
  - `https://agentclientprotocol.com/protocol/draft/schema`

Audience:

- product teams integrating ACP
- engineers building ACP client SDKs or adapters
- teams running ACP smoke tests in CI

Current simulator scope:

- stdio ACP agent process
- deterministic slash-command surface
- plan, permission, file, terminal, and fault-injection flows
- MCP server config acceptance, validation, and persistence for `stdio` / `http` / `sse`
- explicit `mcpCapabilities.http/sse` advertisement during `initialize`

Boundary:

- MCP support here means protocol-surface support for configuration and capability negotiation
- the simulator does not establish or manage real remote MCP connections
- image, audio, and embedded resources are accepted and summarized deterministically rather than deeply interpreted

## Runtime Host Shortcut

If you are integrating through `acp-runtime`, you usually do not need to launch the agent yourself.
Use `runtime.sessions.registry.start({ agentId })` for the normal host path, and only drop to raw stdio process management when building a lower-level ACP client or transport adapter.
## Translation

- [简体中文](../zh-CN/guides/client-integration-guide.md)
