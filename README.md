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

- [Client Integration Guide](docs/guides/client-integration-guide.md)
- [Runtime SDK By Scenario](docs/guides/runtime-sdk-by-scenario.md)
- [Runtime SDK Read Models](docs/guides/runtime-sdk-read-models.md)
- [Runtime SDK API Coverage](docs/guides/runtime-sdk-api-coverage.md)
- [RFC-0001: Runtime Public Abstraction](docs/rfcs/0001-runtime-public-abstraction.md)
- [RFC-0002: Runtime Execution and Authority](docs/rfcs/0002-runtime-execution-and-authority.md)
- [RFC-0003: Runtime Snapshot, Policy, and Recovery](docs/rfcs/0003-runtime-snapshot-policy-and-recovery.md)
- [RFC-0004: Runtime Diagnostics and Host Integration](docs/rfcs/0004-runtime-diagnostics-and-host-integration.md)
- [RFC-0005: Simulator Agent ACP](docs/rfcs/0005-simulator-agent.md)
- [Protocol Coverage Matrix](docs/research/protocol-coverage-matrix.md)
- [Documentation Index](docs/README.md)

## Quick Start

If you are integrating `acp-runtime` into a product host, start here:

```ts
import {
  AcpRuntime,
  createStdioAcpConnectionFactory,
} from "@saaskit-dev/acp-runtime";

const runtime = new AcpRuntime(createStdioAcpConnectionFactory());

const session = await runtime.sessions.start({
  agent: "claude-acp",
  cwd: process.cwd(),
  handlers: {
    permission: () => ({ decision: "allow", scope: "session" }),
  },
});

const text = await session.turn.run("Summarize the current workspace.");
const snapshot = session.snapshot();

await session.close();
```

Runtime-owned state is enabled by default and stored under
`~/.acp-runtime/state/runtime-session-registry.json`. Override it with
`new AcpRuntime(factory, { state: { sessionRegistryPath } })`, or disable local
state with `{ state: false }`.

Then read in this order:
- [Runtime SDK By Scenario](docs/guides/runtime-sdk-by-scenario.md)
- [Runtime SDK Read Models](docs/guides/runtime-sdk-read-models.md)
- [Runtime SDK API Coverage](docs/guides/runtime-sdk-api-coverage.md)

## Open Source Conventions

This repository now follows a cleaner open source documentation layout:

- English is the default language for entry-point documents
- Simplified Chinese lives in dedicated translation files
- package and install instructions use the published scoped package name
- contributor and security policy files live at the repository root

## Repository Layout

- `src/`: runtime library source only
- `examples/`: runnable smoke and demo entry points
- `harness/`: repository-level validation tooling and case definitions
- `packages/simulator-agent/`: independently published simulator agent package

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
pnpm clean
pnpm build
pnpm test
pnpm demo:client-sdk
pnpm harness:check-admission -- --type codex-acp
pnpm harness:run-agent -- --type codex-acp
```

Generated runtime state now defaults to `~/.acp-runtime/`.
You can override the home root with `ACP_RUNTIME_HOME_DIR`, and override cache-only paths with `ACP_RUNTIME_CACHE_DIR`.

## Runtime SDK Status

The current runtime surface is organized around three public concepts:

- `AcpRuntime`: host-facing entry point for `runtime.sessions.*`
- `AcpRuntimeSession`: unified object model for `session.agent.*`, `session.turn.*`, `session.state.*`, `session.queue.*`, and `session.snapshot()`/`session.close()`
- `AcpSessionDriver`: internal driver boundary used to normalize ACP agent differences behind the runtime session API

Internally, ACP-specific behavior is split into:

- `acp/session-service.ts`: ACP session creation/load/resume/list orchestration
- `acp/profiles/`: agent-specific normalization strategy selected by `agent.type`
- `acp/driver.ts`: ACP SDK-backed session driver

The repository now documents a stricter compatibility boundary:

- runtime core keeps semantic normalization and protocol-shape correction
- host / demo adapters keep login execution strategy and UX policy
- explicit profile fallbacks must be marked as policy, not generic ACP behavior

See [Runtime Agent Compatibility](docs/guides/runtime-agent-compatibility.md).
For the recommended learning order, start with
[Runtime SDK By Scenario](docs/guides/runtime-sdk-by-scenario.md).
For a method-by-method lookup, use
[Runtime SDK API Coverage](docs/guides/runtime-sdk-api-coverage.md).

This is intentionally not a generic multi-protocol abstraction. The runtime is ACP-focused, but still normalizes behavioral differences across ACP agents.

For registry-id startup, pass a registry agent id as `agent`.
The runtime resolves launch config from the ACP registry instead of forcing each host to hard-code `command` / `args`:

```ts
const runtime = new AcpRuntime(createStdioAcpConnectionFactory());
const session = await runtime.sessions.start({
  agent: "claude-acp",
  cwd: process.cwd(),
});
```

If you need the resolved launch config before creating a session, use `resolveRuntimeAgentFromRegistry(agentId)`.

## Runtime Validation

The repository now has runtime-level validation for the currently integrated ACP agents:

- `simulator-agent-acp`
  - validated by [src/runtime/runtime-simulator.test.ts](src/runtime/runtime-simulator.test.ts)
  - covers `create`, `send`, `configure`, `snapshot`, and `resume`
- `Claude Code ACP`
  - validated by [src/runtime/runtime-claude-code.test.ts](src/runtime/runtime-claude-code.test.ts)
  - covers real stdio startup, session creation, and prompt execution against `claude-agent-acp`
- `Codex ACP`
  - validated by [src/runtime/runtime-codex.test.ts](src/runtime/runtime-codex.test.ts)
  - covers real stdio startup, session creation, and prompt execution against `codex-acp`

The Claude Code contract test now resolves launch config from the ACP registry by default.
If `claude-agent-acp` is already on `PATH`, it uses the local binary.
If the local binary is not installed, the default test suite now skips that real-environment contract test rather than forcing a package download through `npx`.

If you want to force the legacy direct `npx` path without consulting the registry first, set:

```bash
ACP_RUNTIME_RUN_CLAUDE_CODE_TEST=1 pnpm test -- --run src/runtime/runtime-claude-code.test.ts
```

If you want to skip the real-environment contract test even when the binary is installed, set:

```bash
ACP_RUNTIME_SKIP_CLAUDE_CODE_TEST=1 pnpm test
```

The Codex contract test also resolves launch config from the ACP registry by default.
If `codex-acp` is already on `PATH`, it uses the local binary.
If the local binary is not installed, the default test suite now skips that real-environment contract test rather than forcing a package download or registry binary fetch.

If you want to force the direct `npx` path for Codex, set:

```bash
ACP_RUNTIME_RUN_CODEX_TEST=1 pnpm test -- --run src/runtime/runtime-codex.test.ts
```

If you want to skip the real-environment Codex contract test, set:

```bash
ACP_RUNTIME_SKIP_CODEX_TEST=1 pnpm test
```

If the registry launch cannot be resolved, the default test suite skips that contract test and still runs the deterministic simulator-backed runtime integration test.

## Session Handle Lifecycle

Runtime session handles are ref-counted wrappers over an underlying runtime-managed session driver.

- repeated `runtime.sessions.load()` calls for the same `sessionId` share one underlying driver
- repeated `runtime.sessions.resume()` calls for the same `sessionId` share one underlying driver
- closing one handle does not invalidate sibling handles for the same runtime session
- the underlying driver closes only after the final live handle closes
- once a specific handle is closed, that handle rejects new turn and mutation calls

## Additional Docs

- [Chinese README](README.zh-CN.md)
- [Documentation Index](docs/README.md)
- [Chinese Documentation Index](docs/zh-CN/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
