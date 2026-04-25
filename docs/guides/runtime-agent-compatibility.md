# Runtime Agent Compatibility

This guide defines how `acp-runtime` should handle behavioral differences across
ACP agents without turning the runtime core into a collection of vendor-specific
UI hacks.

## Goal

`acp-runtime` should normalize **semantic differences** that would otherwise
cause the host to misinterpret agent behavior.

It should not absorb host-only product choices such as:
- how a CLI performs login
- how a UI detects that a login command “looks complete”
- product warnings and environment hints

## Compatibility Layers

### 1. Runtime Core

Runtime core compatibility is allowed when it preserves stable host semantics.

Examples:
- richer auth method modeling instead of flattening to `{ id, title }`
- legacy auth metadata parsing such as `_meta["terminal-auth"]`
- profile-driven normalization of malformed or missing initialize data
- prompt error normalization when an agent reports a user cancellation as an
  internal/process error

Rule:
- keep data normalization and semantic correction in core
- keep the result product-agnostic

### 2. Host / Adapter Layer

Host adapters own execution strategy and UX policy.

Examples:
- interactive selection between multiple auth methods
- spawning a terminal login command
- matching login success text such as `Login successful`
- local product warnings, prompts, and formatting

Rule:
- if the behavior depends on host UX or product workflow, keep it out of core

### 3. Explicit Profile Policy

Some agents need a compatibility fallback that is broader than pure parsing but
still belongs closer to the ACP profile than to the host.

Examples:
- Gemini historically omitting initialize auth methods, requiring a synthetic
  fallback auth method so the host can still authenticate

Rule:
- allow this only when needed for interoperability
- mark it explicitly as profile policy
- do not present it as generic ACP behavior

## Current Repository Examples

### Core-compatible

- `src/runtime/acp/auth-methods.ts`
  - maps richer auth methods
  - resolves terminal-auth requests from runtime data
- `src/runtime/acp/profiles/gemini.ts`
  - normalizes Gemini abort/internal-error mismatch to `cancelled`
- `src/runtime/acp/session-service.ts`
  - applies profile-driven initialize normalization before host auth selection

### Host / adapter-only

- `examples/runtime-demo-auth-adapter.ts`
  - auth method selection
  - terminal login execution
  - success-pattern based login completion detection
- `examples/runtime-sdk-demo.ts`
  - CLI prompts and platform warnings

### Explicit profile policy

- `src/runtime/acp/profiles/gemini.ts`
  - synthetic auth method fallback is tagged with
    `_meta["acp-runtime/profile-policy"]`

## Review Checklist

Before adding new agent-specific behavior, ask:

1. Does this fix a semantic mismatch that would otherwise mislead the host?
2. Can it be expressed as normalized runtime data instead of host-specific
   execution logic?
3. If not, does it belong in a host adapter instead?
4. If it must stay near the profile, is it clearly marked as explicit policy?

If the answer is “this is just how our CLI or UI wants to behave”, it should
not go into runtime core.
