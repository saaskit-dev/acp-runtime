# Runtime Agent Compatibility

This guide defines how `acp-runtime` should handle behavioral differences across
ACP agents without turning the runtime core into a collection of vendor-specific
UI hacks.

## Goal

`acp-runtime` should normalize **agent implementation differences** that would
otherwise force every host to learn per-agent behavior.

It should not absorb host-only product choices such as:
- how a UI renders prompts
- whether a host auto-selects or asks the user
- product warnings and environment hints

It should absorb agent compatibility rules such as:
- registry ids and short aliases
- malformed, missing, or misleading auth methods
- protocol-only auth methods for agents whose terminal auth opens a full
  interactive product CLI
- default auth method hints when an agent exposes multiple equivalent choices
- terminal auth completion hints needed by a generic host executor
- readable mode id/name/URI-fragment resolution

## Compatibility Layers

### 1. Runtime Core

Runtime core compatibility is allowed when it preserves stable host semantics.

Examples:
- richer auth method modeling instead of flattening to `{ id, title }`
- legacy auth metadata parsing such as `_meta["terminal-auth"]`
- profile-driven normalization of malformed or missing initialize data
- profile-driven runtime auth method normalization before host auth selection
- resolving readable mode keys in `session.agent.setMode(...)` while preserving
  raw id passthrough
- prompt error normalization when an agent reports a user cancellation as an
  internal/process error

Rule:
- keep data normalization and semantic correction in core
- keep the result product-agnostic

### 2. Profile / Adapter Policy

Profiles own agent-specific compatibility policy. They may attach normalized
runtime metadata that generic hosts can consume without checking agent ids.

Examples:
- Gemini historically omitting initialize auth methods, requiring a synthetic
  fallback auth method
- Claude/Gemini terminal login completion strings exposed as normalized metadata
- Codex preferred login method marked as the default auth method
- GitHub Copilot terminal login metadata removed when the user is already logged
  in locally
- Pi terminal login adapted to protocol-only auth so hosts do not launch the full
  Pi interactive CLI

Rule:
- if external hosts would otherwise need `if agent.type === ...`, put the rule
  in a profile or shared SDK helper instead
- mark non-obvious compatibility fallbacks explicitly in metadata

### 3. Host / Demo Layer

Host adapters own execution strategy and UX policy, not agent-specific
compatibility.

Examples:
- interactive selection between multiple auth methods
- spawning a terminal login command from generic runtime terminal-auth data
- consuming generic login success metadata
- local product warnings, prompts, and formatting

Rule:
- demo/host code should not branch on concrete agent ids for compatibility
- if a branch is needed to make an agent work, move it to runtime/profile first

## Current Repository Examples

### Core-compatible

- `src/runtime/acp/auth-methods.ts`
  - maps richer auth methods
  - resolves terminal-auth requests from runtime data
- `src/runtime/acp/profiles/gemini.ts`
  - normalizes Gemini abort/internal-error mismatch to `cancelled`
- `src/runtime/acp/session-service.ts`
  - applies profile-driven initialize/runtime auth normalization before host
    auth selection
- `src/runtime/core/session.ts`
  - accepts readable mode names such as `Agent` and still preserves raw id
    passthrough for unknown modes

### Profile policy

- `src/runtime/acp/profiles/gemini.ts`
  - synthetic auth method fallback is tagged with
    `_meta["acp-runtime/profile-policy"]`
- `src/runtime/acp/profiles/codex.ts`
  - marks the preferred auth method with
    `acp-runtime/default-auth-method`
- `src/runtime/acp/profiles/claude-code.ts` and
  `src/runtime/acp/profiles/gemini.ts`
  - expose terminal login success patterns through
    `acp-runtime/terminal-success-patterns`
- `src/runtime/acp/profiles/github-copilot.ts` and
  `src/runtime/acp/profiles/pi.ts`
  - hide local auth/CLI differences from generic hosts

### Host / adapter-only

- `examples/runtime-demo-auth-adapter.ts`
  - auth method prompting
  - terminal login process execution
  - generic metadata consumption
- `examples/runtime-sdk-demo.ts`
  - CLI prompts and platform warnings

## Review Checklist

Before adding new agent-specific behavior, ask:

1. Would every external host otherwise need to know this agent-specific rule?
2. Can it be expressed as normalized runtime data instead of host-specific
   execution logic?
3. If it is compatibility behavior, does it belong in a profile or shared SDK
   helper instead of a demo?
4. If it is pure UI/product behavior, is it kept in the host?
5. If it must stay near the profile, is it clearly marked as explicit policy?

If the answer is “this is just how our CLI or UI wants to behave”, it should
not go into runtime core.
