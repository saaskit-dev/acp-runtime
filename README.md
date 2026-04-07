# acp-runtime

Language:
- English (default)
- [简体中文](README.zh-CN.md)

## Overview

`acp-runtime` is a product-facing, product-agnostic ACP runtime and simulator workspace.

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
- [RFC-0008: Simulator Agent ACP](docs/rfcs/0008-simulator-agent.md)
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

## Additional Docs

- [Chinese README](README.zh-CN.md)
- [Documentation Index](docs/README.md)
- [Chinese Documentation Index](docs/zh-CN/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
