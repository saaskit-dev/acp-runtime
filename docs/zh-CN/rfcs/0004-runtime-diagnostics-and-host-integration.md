[English](../../../rfcs/0004-runtime-diagnostics-and-host-integration.md)

# RFC-0004：Runtime Diagnostics 与 Host Integration

## 1. 背景

在新的 runtime 模型下，可观测性和宿主接入边界已经不能再分开设计。

原因是：

- Public SDK 必须屏蔽 raw ACP 细节
- 但 runtime 仍然需要保留 raw 证据用于调试、审计和 harness
- 宿主需要消费的是 runtime 语义，而不是 raw protocol

因此，host integration 和 diagnostics 必须放在同一份 RFC 下统一定义。

## 2. 目标

本 RFC 定义：

- runtime 与 host 的职责边界
- diagnostics 层的存在理由与边界
- logger / hooks / event sink 的定位
- raw 数据为什么不应进入 Public SDK

## 3. Host 与 Runtime 的职责边界

runtime 负责：

- agent 生命周期
- ACP 连接
- session / turn / operation / permission 语义
- authority mediation
- snapshot / resume
- 语义事件与统一错误

host 负责：

- 产品 session 列表
- UI
- 持久化记录结构
- 业务 fallback
- 产品消息模型

host 不应重写 runtime 的状态机。

## 4. Diagnostics 层

diagnostics 是与 Public SDK 平行的一层，而不是 Public SDK 的附属字段集合。

它负责：

- transcript
- raw ACP event sink
- vendor metadata
- debug logger
- harness / research 证据输出

关键约束：

- diagnostics 可以保留 raw 细节
- Public SDK 不可以泄漏 raw 细节

## 5. 三层观测接口

建议继续使用三层模型：

- `logger`
- `hooks`
- `event sink`

语义分别是：

- `logger` 给人看
- `hooks` 给宿主编排
- `event sink` 给 transcript、审计、研究和测试

## 6. Error 模型与 Diagnostics 的关系

Public SDK 抛的是 runtime 统一错误。

Diagnostics 保留的是：

- 原始 wire 证据
- vendor-specific metadata
- 原始 stop reason
- 原始 tool update

换句话说：

- 错误控制流属于 Public SDK
- 原始证据属于 Diagnostics

当前代码里的一个直接体现是：像 `usage_update.used === null` 这类 agent 兼容差异，会优先在 ACP 边界做归一化，而不是泄漏进 Public SDK 主抽象。

对应到当前代码边界：

- 宿主通过 `AcpRuntime` / `AcpRuntimeSession` 接入
- authority 通过 `authentication` / `filesystem` / `permission` / `terminal` handlers 提供
- ACP 协议形状兼容处理放在 `acp/stdio-connection.ts`
- runtime 统一错误定义在 `errors.ts`

这样可以把协议噪音留在 transport / adapter 边界，而不是把它们提升成 Public SDK 的一等概念。

因此，下列内容应优先保留在 research 或 diagnostics，而不是主规范顶层语义中：

- 不同 vendor 的权限拒绝终态差异
- 不同 agent 对 client authority 的实际采用程度
- 某个具体 agent 是否在某个场景下走 `readTextFile()` / `writeTextFile()` / `terminal/*`

## 7. 对宿主的集成约束

宿主默认应通过 Public SDK 接入，而不是自己拼 ACP。

宿主应该：

- 订阅 runtime 语义事件
- 处理 runtime 统一错误
- 提供 authority handlers
- 保存 snapshot

宿主不应该：

- 把 raw `session/update` 当成自己的业务主语义
- 把 vendor `stopReason` 直接写进业务控制流
- 重写 session / turn / permission 状态机
- 在 Public SDK 主抽象中继续引入 raw ACP 名词作为一等概念

## 8. 最终结论

`acp-runtime` 的一个关键边界是：

**raw 数据必须存在，但只能存在于 diagnostics；宿主的主接入面必须始终是 runtime 语义。**

这也是 host integration 和 observability 必须一起定义的原因。

[English](../../rfcs/0004-runtime-diagnostics-and-host-integration.md)
