# RFC-0004: State and Recovery

Language:
- English (default)
- [简体中文](zh-CN/rfcs/0004-state-and-recovery.md)

## Summary

This RFC defines the runtime state model, persistence boundary, and recovery rules.

It focuses on:

- a transparent and durable `AcpState`
- enough state to reconnect and recover sessions safely
- clear ownership of product state versus runtime state
- deterministic recovery instead of implicit fallback behavior
## Translation

- [简体中文](zh-CN/rfcs/0004-state-and-recovery.md)
