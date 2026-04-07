# RFC-0008: Simulator Agent ACP

Language:
- English (default)
- [简体中文](zh-CN/rfcs/0008-simulator-agent.md)

## Summary

This RFC defines `simulator-agent-acp` as a deterministic ACP agent, client-integration fixture, and harness baseline.

Protocol alignment:

- ACP protocol version: `1`
- ACP source repo: `https://github.com/agentclientprotocol/agent-client-protocol`
- ACP source ref: `v0.11.4`
- Last verified against upstream docs: `2026-04-08`
- Reference pages:
  - `https://agentclientprotocol.com/protocol/overview`
  - `https://agentclientprotocol.com/protocol/draft/schema`

Current command surface:

- `/help`
- `/read`
- `/write`
- `/bash`
- `/plan`
- `/rename`
- `/scenario`
- `/simulate`

Current behavior highlights:

- plain chat does not auto-trigger tool flows
- `/plan` publishes a plan instead of pretending to execute it
- execution flows emit step-aligned output and finish plan state cleanly
- permission memory supports one-shot and session-level allow/deny behavior
- MCP server config is accepted, validated, and persisted for `stdio` / `http` / `sse`
- the simulator advertises `mcpCapabilities.http/sse` but does not manage real remote MCP connections
## Translation

- [简体中文](zh-CN/rfcs/0008-simulator-agent.md)
