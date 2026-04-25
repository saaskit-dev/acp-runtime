[English](../../../rfcs/0003-runtime-snapshot-policy-and-recovery.md)

# RFC-0003：Runtime Snapshot、Policy 与 Recovery

## 1. 背景

在新的 public abstraction 下，原来的 `AcpState` 已不足以准确表达 runtime 的目标。

核心原因是：

- 顶层恢复对象不应该只是“state blob”
- runtime 需要区分 `Snapshot` 与 `Policy`
- 恢复流程不仅是把 `sessionId` 接回来，还要把 runtime 自己的期望状态重新建立起来

因此，本 RFC 将状态、policy 和恢复逻辑统一收敛。

## 2. 目标

本 RFC 定义：

- `Snapshot` 的边界
- `Policy` 的语义
- `resume` 的恢复流程
- desired replay 的约束
- snapshot 所有权与兼容策略

## 3. Snapshot 的定义

`Snapshot` 是一个可持久化恢复点。

它只保存恢复所必需的最小信息，例如：

- agent 定义
- cwd
- runtime session 标识
- policy 相关配置
- mcp server 配置
- snapshot version

当前最终代码里，snapshot 以 `session.id` 为唯一恢复键，不再单独维护 `agentId`。
`agent.type` 已经内嵌在 `snapshot.agent` 里，用于恢复时选择 agent profile。

当前代码里的直接对应关系是：

- `session.lifecycle.snapshot()`：公共 snapshot 生成入口
- `session-registry.ts`：维护 `session.id -> snapshot`
- `session-registry-store.ts`：JSON 持久化存储
- `runtime.sessions.resume()`：接收 runtime snapshot，而不是协议碎片
- `acp/profiles/`：把 runtime policy 投影到具体 agent 的 ACP mode/config 操作

`Snapshot` 不是：

- transcript
- 运行时内存快照
- 当前 active turn 状态
- vendor raw event 缓存

## 4. Policy 的定义

`Policy` 是宿主对 runtime 的期望运行约束。

它表达：

- 权限策略
- authority 约束
- 模型 / 模式 / 配置的 runtime 期望

关键约束：

- `Policy` 是 runtime 语义
- vendor mode / config 只是 adapter 内部映射目标

`configure(policy)` 的公共语义应保持简单并显式：

- `configure()` 采用 replace 语义
- 不做 deep merge
- 调用方应传入“下一份完整 policy snapshot”

顶层 SDK 不应直接把 vendor 的 mode 名字当成自己的主语义。

## 5. Snapshot 与 Policy 的关系

恢复时，runtime 需要两样东西：

- 一个 snapshot：告诉 runtime 恢复哪个 session
- 一份 policy：告诉 runtime 恢复后应维持什么期望配置

因此：

- snapshot 负责“恢复点”
- policy 负责“恢复后的期望状态”

两者既相关，又不应混成一个概念。

## 6. Resume 语义

`runtime.sessions.resume()` 是 runtime 动作，不是简单协议动作。

建议流程：

1. 校验 snapshot schema
2. 重新建立连接
3. 恢复既有 ACP session
4. 重放 runtime policy
5. session 进入 ready

约束：

- 任一环节失败直接报错
- 不允许 silent heal 成新 session
- 不允许“看起来恢复了，其实上下文换了”

语义上应明确区分：

- `load = reconnect existing session`
- `resume = continue from runtime snapshot`

## 7. Replay 语义

policy replay 是 runtime 恢复的一部分，但不等于上下文本身恢复。

要区分：

- session context recovery
- runtime policy replay

如果 replay 失败，必须显式失败，而不是偷偷忽略。

## 8. Snapshot 所有权

snapshot 归宿主所有。

runtime 负责：

- 生成 snapshot
- 校验 snapshot
- 使用 snapshot 恢复

runtime 不负责：

- 维护产品级 session 注册表
- 替宿主决定恢复哪个记录

## 9. 兼容策略

当前原则保持简单：

- 只接受当前支持的 snapshot schema
- 不预先设计 migration 体系
- 真正出现历史兼容需求时，再根据真实数据设计 migration

这意味着：

- 版本号必须显式
- 不支持的版本必须直接拒绝

## 10. 对 Public SDK 的约束

从 Public SDK 的视角：

- 应暴露 `session.lifecycle.snapshot()` 或等价 API
- `runtime.sessions.resume()` 的输入应是 runtime snapshot，而不是协议碎片
- 顶层不应把 raw vendor state 当作恢复对象

## 11. 最终结论

`Snapshot` 负责“恢复点”，`Policy` 负责“恢复意图”，`runtime.sessions.resume()` 负责把两者重新组装成一个 runtime session。

以后如果实现把这三者重新混成一个协议化 JSON blob，应视为偏离本 RFC。

[English](../../rfcs/0003-runtime-snapshot-policy-and-recovery.md)
