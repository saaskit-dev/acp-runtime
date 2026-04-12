# RFC-0003: Runtime Snapshot, Policy, and Recovery

Language:
- English (default)
- [简体中文](zh-CN/rfcs/0003-runtime-snapshot-policy-and-recovery.md)

## Summary

This RFC consolidates runtime persistence and recovery around:

- `Snapshot`
- `Policy`
- explicit `resume` semantics

Key points:

- snapshots hold the minimum data required to recover a runtime session
- snapshots are keyed by `session.id` and no longer maintain a separate `agentId`
- policy expresses runtime intent rather than vendor-native configuration names
- agent-specific policy projection is handled through ACP profile selection by `agent.type`
- `resume` is a runtime action that restores both session context and policy
- unsupported snapshot versions must fail explicitly instead of silently healing

## Current Code Mapping

In the current codebase:

- `session.snapshot()` is the public snapshot emission point
- `session-registry.ts` persists `session.id -> snapshot`
- `session-registry-store.ts` stores the JSON form on disk
- `runtime.resume()` takes a runtime snapshot, not a raw protocol fragment
- `acp/profiles/` projects runtime policy into agent-specific ACP mode/config operations

## Translation

- [简体中文](zh-CN/rfcs/0003-runtime-snapshot-policy-and-recovery.md)
