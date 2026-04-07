# RFC-0001: Runtime Architecture

Language:
- English (default)
- [简体中文](zh-CN/rfcs/0001-runtime-architecture.md)

## Summary

This RFC defines `acp-runtime` as a host-facing ACP runtime rather than a thin SDK wrapper.

Key points:

- the runtime owns ACP connections, agent process lifecycle, sessions, turns, recovery, and observability
- the host owns product state, UI, storage, and business decisions
- the runtime should present a stable abstraction over ACP rather than leaking protocol details into every product
## Translation

- [简体中文](zh-CN/rfcs/0001-runtime-architecture.md)
