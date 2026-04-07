# RFC-0003: Turn Execution Model

Language:
- English (default)
- [简体中文](zh-CN/rfcs/0003-turn-model.md)

## Summary

This RFC defines the runtime turn model for a single session.

Key conclusions:

- only one active turn is allowed per session
- turns are serialized through a thin FIFO queue
- cancellation and timeout are structured completion outcomes
- transport, protocol, and runtime failures are represented as errors
- control operations share the same serialized execution flow as prompts
## Translation

- [简体中文](zh-CN/rfcs/0003-turn-model.md)
