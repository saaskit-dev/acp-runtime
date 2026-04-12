# acp-runtime

Language:
- English (default)
- [简体中文](README.zh-CN.md)

## Overview

`acp-runtime` is a product-facing, product-agnostic ACP runtime and simulator workspace.

## Global Goal

The main goal of this repository is to build `acp-runtime` as the host-side ACP runtime layer for products, so future integrations with real ACP agents can share one consistent model for sessions, turns, permissions, recovery, and observability.

`simulator-agent-acp` exists to occupy the ACP agent position during development and testing. It is a deterministic stand-in for real agents, used to validate the runtime, host integration flows, and regression coverage without depending on live agent behavior.

This repository currently centers on:

- `simulator-agent-acp` as a deterministic ACP agent
- harness-driven protocol and scenario validation
- RFCs that define the runtime model for sessions, turns, permissions, recovery, and host integration

Protocol alignment for the simulator is tracked with explicit metadata:

- ACP protocol version: `1`
- ACP source repo: `https://github.com/agentclientprotocol/agent-client-protocol`
- ACP source ref: `v0.11.4`
- Last verified against upstream docs: `2026-04-08`

## Entry Points

- [Client Integration Guide](docs/client-integration-guide.md)
- [RFC-0001: Runtime Public Abstraction](docs/rfcs/0001-runtime-public-abstraction.md)
- [RFC-0002: Runtime Execution and Authority](docs/rfcs/0002-runtime-execution-and-authority.md)
- [RFC-0003: Runtime Snapshot, Policy, and Recovery](docs/rfcs/0003-runtime-snapshot-policy-and-recovery.md)
- [RFC-0004: Runtime Diagnostics and Host Integration](docs/rfcs/0004-runtime-diagnostics-and-host-integration.md)
- [RFC-0005: Simulator Agent ACP](docs/rfcs/0005-simulator-agent.md)
- [Protocol Coverage Matrix](docs/research/protocol-coverage-matrix.md)
- [Documentation Index](docs/README.md)

## Open Source Conventions

This repository now follows a cleaner open source documentation layout:

- English is the default language for entry-point documents
- Simplified Chinese lives in dedicated translation files
- package and install instructions use the published scoped package name
- contributor and security policy files live at the repository root

## Installation

Run from source:

```bash
git clone <repo>
cd acp-runtime
pnpm install
pnpm build
pnpm simulator-agent-acp
```

Install from npm:

```bash
npm install -g @saaskit-dev/simulator-agent-acp
simulator-agent-acp
```

Or run directly with `npx`:

```bash
npx @saaskit-dev/simulator-agent-acp@latest
```

## Simulator Highlights

- stdio ACP agent process
- deterministic slash-command surface
- permission, file, terminal, and plan flows
- MCP server config validation for `stdio` / `http` / `sse`
- local harness baseline via `simulator-agent-acp-local`

## Development

```bash
pnpm build
pnpm test
pnpm smoke:client-sdk
```

## Runtime SDK Status

The current runtime surface is organized around three public concepts:

- `AcpRuntime`: host-facing entry point for `create`, `load`, `resume`, and agent session listing
- `AcpRuntimeSession`: unified object model for session state, raw agent modes/options, turns, snapshots, and close/cancel operations
- `AcpSessionDriver`: internal driver boundary used to normalize ACP agent differences behind the runtime session API

Internally, ACP-specific behavior is split into:

- `acp/session-service.ts`: ACP session creation/load/resume/list orchestration
- `acp/profiles/`: agent-specific normalization strategy selected by `agent.type`
- `acp/driver.ts`: ACP SDK-backed session driver

This is intentionally not a generic multi-protocol abstraction. The runtime is ACP-focused, but still normalizes behavioral differences across ACP agents.

## Runtime Validation

The repository now has runtime-level validation for both currently integrated ACP agents:

- `simulator-agent-acp`
  - validated by [src/runtime/runtime-simulator.test.ts](src/runtime/runtime-simulator.test.ts)
  - covers `create`, `send`, `configure`, `snapshot`, and `resume`
- `Claude Code ACP`
  - validated by [src/runtime/runtime-claude-code.test.ts](src/runtime/runtime-claude-code.test.ts)
  - covers real stdio startup, session creation, and prompt execution through `npx @agentclientprotocol/claude-agent-acp`

The Claude Code contract test is opt-in because it depends on external package startup and local Claude authentication state:

```bash
ACP_RUNTIME_RUN_CLAUDE_CODE_TEST=1 pnpm test -- --run src/runtime/runtime-claude-code.test.ts
```

The default test suite skips that contract test and still runs the deterministic simulator-backed runtime integration test.

## Additional Docs

- [Chinese README](README.zh-CN.md)
- [Documentation Index](docs/README.md)
- [Chinese Documentation Index](docs/zh-CN/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
