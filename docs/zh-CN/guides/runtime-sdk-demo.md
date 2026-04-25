# Runtime SDK Demo

[English](../../guides/runtime-sdk-demo.md)

这份文档定义了 `acp-runtime` 顶层 Public SDK 的宿主调用方式。
全文只使用 runtime 自己的概念：

- `AcpRuntime`
- `AcpRuntimeSession`
- `Policy`
- `Operation`
- `PermissionRequest`
- `Snapshot`
- typed runtime errors

不直接使用 ACP 原始方法，也不使用厂商私有协议细节。

## 示例源码

- [runtime-sdk-demo.ts](../../../examples/runtime-sdk-demo.ts)

建议配合阅读：
- [Runtime SDK 分阶段接入](runtime-sdk-by-scenario.md)
- [Runtime SDK API 覆盖矩阵](runtime-sdk-api-coverage.md)

这个统一示例默认通过 `runtime.sessions.registry.start({ agentId })` 进入 runtime，并通过 agent id 切换行为。

## 覆盖的场景

- 新建 session，并注入 authority handlers
- 读取 session 的 capabilities、metadata 与 diagnostics
- 执行简单文本 turn
- 发送结构化 prompt，并接收结构化 output
- 用 `session.turn.stream()` 感知 operation 与 permission 生命周期
- 显式 `runtime.sessions.load()` 旧 session
- `session.lifecycle.snapshot()` 后 `runtime.sessions.resume()`
- 取消进行中的 turn
- 统一处理顶层 typed runtime errors
- 跑一条完整宿主工作流

## 在阅读顺序中的位置

建议先看完分阶段示例，再回到这个完整 demo。
它更适合一次性查看完整用户宿主流程：

- startup
- session 选择
- interactive turn 渲染
- 权限
- 认证
- load / resume
- snapshot 保存
- 本地 CLI 命令

## 设计说明

- 示例里的 `runtime` 代表宿主拿到的顶层 SDK 实例
- agent 启动通过 runtime 的 registry 入口解析，而不是手写 launch 参数
- 原生 agent 控制通过 `session.agent.setMode()` 与 `session.agent.setConfigOption()` 表达
- 权限处理通过 `permission` handler 表达，而不是 raw ACP message
- 工具执行通过 `Operation` 事件表达，而不是 `tool_call` / `tool_call_update`
- 恢复通过 `session.lifecycle.snapshot()` / `runtime.sessions.resume()` 表达
- 宿主控制流通过 typed runtime errors 表达，而不是 vendor `stopReason`
