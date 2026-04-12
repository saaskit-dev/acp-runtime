# RFC-0002: Runtime Execution and Authority

Language:
- English (default)
- [简体中文](zh-CN/rfcs/0002-runtime-execution-and-authority.md)

## Summary

This RFC consolidates the runtime execution path across:

- session establishment
- turn execution
- operation lifecycle
- permission and authority mediation

Key points:

- `create/load/resume/close` are runtime lifecycle actions
- ACP session establishment is coordinated by `acp/session-service.ts`
- turn execution flows through `AcpRuntimeSession -> AcpSessionDriver -> ACP SDK connection`
- turns and control operations share one serialized execution flow
- tool execution is normalized into operations
- permission requests must be linked to operations
- turn outcomes must normalize into runtime outcomes, not vendor stop reasons

## Current Code Mapping

In the current implementation:

- `runtime.ts` coordinates registry hydration and session creation
- `session.ts` provides `run`, `send`, `stream`, `configure`, `cancel`, and `close`
- `acp/session-service.ts` performs `initialize`, `newSession`, `loadSession`, `listSessions`, and `resumeSession`
- `acp/driver.ts` owns turn execution, permission mediation, and runtime event emission
- `acp/session-update-mapper.ts` maps ACP updates into runtime events and operations

## Translation

- [简体中文](zh-CN/rfcs/0002-runtime-execution-and-authority.md)
