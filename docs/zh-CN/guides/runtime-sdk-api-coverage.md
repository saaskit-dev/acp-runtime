# Runtime SDK API 覆盖矩阵

[English](../../guides/runtime-sdk-api-coverage.md)

这份文档把 `acp-runtime` 的 Public SDK 映射到分阶段示例与说明文档。

如果你想先按推荐顺序学习，先看
[Runtime SDK 分阶段接入](runtime-sdk-by-scenario.md)。
如果你想更深入理解 `thread`、keyed object store 和 live projection，再看
[Runtime SDK 读模型说明](runtime-sdk-read-models.md)。

## Runtime 启动值

| API | 覆盖位置 |
| --- | --- |
| `AcpRuntime` | 阶段 1 |
| `AcpRuntimeSessionRegistry` | 阶段 1 |
| `AcpRuntimeJsonSessionRegistryStore` | 阶段 1 |
| `createStdioAcpConnectionFactory()` | 阶段 1 |
| `resolveRuntimeAgentFromRegistry(...)` | 阶段 3 |
| `resolveRuntimeTerminalAuthenticationRequest(...)` | 阶段 7 |

## Runtime Session 管理

| API | 覆盖位置 |
| --- | --- |
| `runtime.sessions.start(...)` | 阶段 1 显式 agent 路径 |
| `runtime.sessions.registry.start(...)` | 阶段 1 默认路径 |
| `runtime.sessions.load(...)` | 阶段 3 |
| `runtime.sessions.registry.load(...)` | 阶段 3 |
| `runtime.sessions.resume(...)` | 阶段 3 |
| `runtime.sessions.remote.list(...)` | 阶段 3 |
| `runtime.sessions.registry.remote.list(...)` | 阶段 3 |
| `runtime.sessions.stored.list(...)` | 阶段 6 |
| `runtime.sessions.stored.delete(...)` | 阶段 6 |
| `runtime.sessions.stored.deleteMany(...)` | 阶段 6 |
| `runtime.sessions.stored.watch(...)` | 阶段 6 |
| `runtime.sessions.stored.refresh()` | 阶段 6 |

## Session Getter

| API | 覆盖位置 |
| --- | --- |
| `session.capabilities` | 阶段 1 |
| `session.diagnostics` | 阶段 1 |
| `session.metadata` | 阶段 1 与阶段 4 |
| `session.status` | 阶段 1 与阶段 3 |

## Session Agent 控制

| API | 覆盖位置 |
| --- | --- |
| `session.agent.listModes()` | 阶段 4 |
| `session.agent.listConfigOptions()` | 阶段 4 |
| `session.agent.setMode()` | 阶段 4 |
| `session.agent.setConfigOption()` | 阶段 4 |

## Session Turn 执行

| API | 覆盖位置 |
| --- | --- |
| `session.turn.run(...)` | 阶段 1 与阶段 5 |
| `session.turn.send(...)` | 阶段 2 |
| `session.turn.stream(...)` | 阶段 2 |

## Session 读模型

| API | 覆盖位置 |
| --- | --- |
| `session.model.history.drain()` | 阶段 3 与阶段 5 |
| `session.model.thread.entries()` | 阶段 5 |
| `session.model.diffs.keys()/get()/list()/watch()` | 阶段 5 |
| `session.model.terminals.ids()/get()/list()/watch()/refresh()/wait()/kill()/release()` | 阶段 5 |
| `session.model.toolCalls.ids()/get()/list()/bundle()/bundles()/diffs()/terminals()/watch()/watchObjects()` | 阶段 5 |
| `session.model.operations.ids()/get()/list()/bundle()/bundles()/permissions()/watch()/watchBundle()` | 阶段 5 |
| `session.model.permissions.ids()/get()/list()/watch()` | 阶段 5 |
| `session.model.watch(...)` | 阶段 5 |

## Session Live Projection

| API | 覆盖位置 |
| --- | --- |
| `session.live.metadata()` | 阶段 2 与阶段 5 |
| `session.live.usage()` | 阶段 2 与阶段 5 |
| `session.live.watch(...)` | 阶段 2 与阶段 5 |

## Session Lifecycle

| API | 覆盖位置 |
| --- | --- |
| `session.lifecycle.snapshot()` | 阶段 1 与阶段 3 |
| `session.lifecycle.cancel()` | 阶段 2 |
| `session.lifecycle.close()` | 所有阶段 |

## Authority 与宿主接入

| API | 覆盖位置 |
| --- | --- |
| `AcpRuntimeAuthorityHandlers` | 阶段 7 |
| `AcpRuntimeAuthenticationHandler` | 阶段 7 |
| `AcpRuntimeFilesystemHandler` | 阶段 7 |
| `AcpRuntimePermissionHandler` | 阶段 7 |
| `AcpRuntimeTerminalHandler` | 阶段 7 |

## Agent 启动 helper

| API | 覆盖位置 |
| --- | --- |
| `createSimulatorAgentAcpAgent(...)` | 阶段 1 显式 agent 路径 |
| `createClaudeCodeAcpAgent(...)` | 与阶段 1 显式 agent 路径同模式 |
| `createCodexAcpAgent(...)` | 与阶段 1 显式 agent 路径同模式 |
| `createGeminiCliAcpAgent(...)` | 与阶段 1 显式 agent 路径同模式 |
| `*_COMMAND` / `*_PACKAGE` / `*_REGISTRY_ID` 常量 | 显式启动与工具集成元数据 |

## Typed Runtime Errors

| API | 覆盖位置 |
| --- | --- |
| `AcpError` | 阶段 3 |
| `AcpAuthenticationError` | 阶段 3 |
| `AcpCreateError` | 阶段 3 |
| `AcpListError` | 阶段 3 |
| `AcpLoadError` | 阶段 3 |
| `AcpProcessError` | 阶段 3 |
| `AcpResumeError` | 阶段 3 |
| `AcpPermissionDeniedError` | 阶段 2 |
| `AcpProtocolError` | 阶段 2 |
| `AcpTurnCancelledError` | 阶段 2 |
| `AcpTurnTimeoutError` | 阶段 2 |

## Public Type 家族

package root 还导出了这些 runtime-facing type 家族，分阶段示例都会用到：

- prompt / output：`AcpRuntimePrompt`、`AcpRuntimeContentPart`、`AcpRuntimeTurnEvent`、`AcpRuntimeTurnCompletion`
- agent control：`AcpRuntimeAgentMode`、`AcpRuntimeAgentConfigOption`、`AcpRuntimeAvailableCommand`
- read model：`AcpRuntimeThreadEntry`、`AcpRuntimeDiffSnapshot`、`AcpRuntimeTerminalSnapshot`、`AcpRuntimeToolCallBundle`、`AcpRuntimeOperationBundle`、`AcpRuntimePermissionRequest`
- live projection：`AcpRuntimeProjectionUpdate`、`AcpRuntimeUsage`
- authority：`AcpRuntimeAuthorityHandlers` 及各 handler specialization
- registry / recovery：`AcpRuntimeSnapshot`、`AcpRuntimeSessionReference`、`AcpRuntimeSessionList`、`AcpRuntimeRegistryListOptions`

完整类型目录和语义说明见
[Runtime SDK API](runtime-sdk-api.md)。
