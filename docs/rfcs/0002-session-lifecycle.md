# RFC-0002: Session Lifecycle

Language:
- English (default)
- [简体中文](zh-CN/rfcs/0002-session-lifecycle.md)

## Summary

This RFC defines precise semantics for `create`, `load`, `resume`, and `close`.

The core distinction is:

- `create` is a runtime action that starts a new ACP session
- `load` is a protocol action that restores a specific ACP session
- `resume` is a runtime recovery action that may map to `session/resume` or `session/load`
- `close` is an explicit lifecycle boundary rather than an implicit disconnect
## Translation

- [简体中文](zh-CN/rfcs/0002-session-lifecycle.md)
