# RFC-0005: Permissions and Client Authority

Language:
- English (default)
- [简体中文](zh-CN/rfcs/0005-permissions-and-client-authority.md)

## Summary

This RFC defines how `acp-runtime` models permissions and client-authority methods.

Key conclusions:

- `modeId` remains agent-specific
- `permissionPolicy` is a runtime-level abstraction
- adapters map runtime permission intent onto each agent's real capabilities
- the runtime must coordinate ACP client-authority methods such as permission prompts and tool-side effects

Note:

- this RFC still uses `balanced` as a runtime abstraction
- that is separate from the simulator's current command surface and profile names
## Translation

- [简体中文](zh-CN/rfcs/0005-permissions-and-client-authority.md)
