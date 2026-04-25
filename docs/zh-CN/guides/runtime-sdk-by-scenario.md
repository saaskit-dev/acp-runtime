# Runtime SDK 分阶段接入

[English](../../guides/runtime-sdk-by-scenario.md)

这份文档按真实宿主场景拆分 `acp-runtime` 的 Public SDK。
建议按顺序阅读，只在当前阶段满足不了你的产品需求时再进入下一阶段。

如果你需要逐个方法的索引表，见
[Runtime SDK API Coverage](runtime-sdk-api-coverage.md)。

## 阶段 1：最小会话接入

适合：
- 创建 runtime
- 启动一个 session
- 跑一个 turn
- 保存一个 snapshot
- 关闭 session

源码：
- [runtime-sdk-stage-1-minimal.ts](../../../examples/runtime-sdk-stage-1-minimal.ts)
- [Runtime SDK Minimal Demo](runtime-sdk-minimal-demo.md)

覆盖：
- `AcpRuntime`
- `AcpRuntimeSessionRegistry`
- `AcpRuntimeJsonSessionRegistryStore`
- `createStdioAcpConnectionFactory()`
- `runtime.sessions.registry.start(...)`
- `runtime.sessions.start(...)`
- `session.turn.run(...)`
- `session.lifecycle.snapshot()`
- `session.lifecycle.close()`
- `session.capabilities`
- `session.diagnostics`
- `session.metadata`
- `session.status`

## 阶段 2：交互式 turn

适合：
- 实时输出
- 结构化 prompt
- 流式事件处理
- 取消与超时

源码：
- [runtime-sdk-stage-2-interactive.ts](../../../examples/runtime-sdk-stage-2-interactive.ts)

覆盖：
- `session.turn.send(...)`
- `session.turn.stream(...)`
- `session.live.watch(...)`
- `session.live.metadata()`
- `session.live.usage()`
- `session.lifecycle.cancel()`

## 阶段 3：恢复与远端 session

适合：
- 查看某个 agent 已知的旧会话
- `load` / `resume`
- registry 路径与显式 agent 路径并存

源码：
- [runtime-sdk-stage-3-session-recovery.ts](../../../examples/runtime-sdk-stage-3-session-recovery.ts)

覆盖：
- `resolveRuntimeAgentFromRegistry(...)`
- `runtime.sessions.remote.list(...)`
- `runtime.sessions.registry.remote.list(...)`
- `runtime.sessions.load(...)`
- `runtime.sessions.registry.load(...)`
- `runtime.sessions.resume(...)`
- `session.model.history.drain()`

## 阶段 4：agent 原生控制

适合：
- 暴露 mode 切换
- 暴露 config option 编辑
- 查看 slash command 列表

源码：
- [runtime-sdk-stage-4-agent-control.ts](../../../examples/runtime-sdk-stage-4-agent-control.ts)

覆盖：
- `session.agent.listModes()`
- `session.agent.listConfigOptions()`
- `session.agent.setMode()`
- `session.agent.setConfigOption()`
- `session.metadata.availableCommands`

## 阶段 5：读模型与 live projection

适合：
- thread 视图
- diff / terminal 视图
- tool call 聚合
- operation / permission 检查
- read-model watcher
- live projection watcher

源码：
- [runtime-sdk-stage-5-read-model.ts](../../../examples/runtime-sdk-stage-5-read-model.ts)

专门说明：
- [Runtime SDK 读模型说明](runtime-sdk-read-models.md)

覆盖：
- `session.model.thread.entries()`
- `session.model.diffs.*`
- `session.model.terminals.*`
- `session.model.toolCalls.*`
- `session.model.operations.*`
- `session.model.permissions.*`
- `session.model.watch(...)`
- `session.live.metadata()`
- `session.live.usage()`
- `session.live.watch(...)`

## 阶段 6：stored session 历史

适合：
- 本地最近会话列表
- 删除 / 批量删除
- refresh
- watcher 驱动的历史面板

源码：
- [runtime-sdk-stage-6-stored-sessions.ts](../../../examples/runtime-sdk-stage-6-stored-sessions.ts)

覆盖：
- `runtime.sessions.stored.list(...)`
- `runtime.sessions.stored.delete(...)`
- `runtime.sessions.stored.deleteMany(...)`
- `runtime.sessions.stored.watch(...)`
- `runtime.sessions.stored.refresh()`

## 阶段 7：宿主 authority 与认证

适合：
- 认证方式选择
- terminal auth 执行
- permission policy
- filesystem authority
- terminal authority

源码：
- [runtime-sdk-stage-7-host-authority.ts](../../../examples/runtime-sdk-stage-7-host-authority.ts)
- [runtime-demo-auth-adapter.ts](../../../examples/runtime-demo-auth-adapter.ts)

覆盖：
- `AcpRuntimeAuthorityHandlers`
- `AcpRuntimeAuthenticationHandler`
- `AcpRuntimeFilesystemHandler`
- `AcpRuntimePermissionHandler`
- `AcpRuntimeTerminalHandler`
- `resolveRuntimeTerminalAuthenticationRequest(...)`

## 完整用户 CLI Demo

如果你想直接看完整宿主链路：
- registry 启动
- 用户交互 CLI
- 日志
- `load` / `resume` 启动参数
- 权限提示
- auth 提示
- timeline 渲染

源码：
- [runtime-sdk-demo.ts](../../../examples/runtime-sdk-demo.ts)

说明：
- [Runtime SDK Demo](runtime-sdk-demo.md)
