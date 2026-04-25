# Runtime SDK Minimal Demo

Language:
- English (default)
- [简体中文](../zh-CN/guides/runtime-sdk-minimal-demo.md)

This page shows the smallest reasonable host integration for the current public SDK.

## Source Demo

- [runtime-sdk-stage-1-minimal.ts](../../examples/runtime-sdk-stage-1-minimal.ts)

Use this together with:
- [Runtime SDK By Scenario](runtime-sdk-by-scenario.md)
- [Runtime SDK API Coverage](runtime-sdk-api-coverage.md)

This stage uses `runtime.sessions.registry.start({ agentId: "simulator-agent-acp-local" })` as the default path and also shows the explicit `runtime.sessions.start({ agent })` override path.

## What It Covers

- create a runtime session
- provide minimal host authority handlers
- run a simple turn
- snapshot the session
- close the session

## When To Use

Use this demo when you want:
- the smallest possible host integration example
- a quick read of the top-level SDK shape
- a starting point before moving to the full scenario demo

## Next Step

For richer session state, streaming, operations, permissions, resume, and typed error handling, see:
- [Runtime SDK By Scenario](runtime-sdk-by-scenario.md)
- [Runtime SDK Demo](runtime-sdk-demo.md)
