# RFC-0007：宿主接入模型

- 状态：Proposed
- 日期：2026-04-03

## 1. 目标

定义外部宿主系统如何接入 `acp-runtime`。

这里的宿主可以是：

- CLI
- GUI / Desktop App
- Daemon / Server
- 自动化编排器

本 RFC 不针对任何单一产品。

## 2. 核心边界

接入 `acp-runtime` 时，必须先把“宿主职责”和“runtime 职责”分清。

### 2.1 runtime 负责

- ACP 连接与协议交互
- agent 进程生命周期
- session 生命周期
- turn 执行与队列
- 恢复流程
- 权限策略落地
- client-authority 编排
- 可观测性输出

### 2.2 宿主负责

- 产品 session 列表
- UI
- 宿主自己的持久化结构
- 产品消息模型
- 业务 fallback 决策
- 业务编排逻辑

## 3. 接入总原则

宿主不应该重复实现 ACP runtime 主逻辑。

宿主应该：

- 通过 `acp-runtime` 管理 ACP session 与 turn
- 把自己的产品状态和 `AcpState` 组合存储
- 把 runtime 输出投影成自己的消息或 UI 状态

## 4. 宿主与 runtime 的接口关系

### 4.1 宿主输入给 runtime 的内容

通过 `create` / `load` / `resume` 的 options 传入：

- `agent`（字符串名或 `AcpAgentDef`）
- `cwd`
- `env`（环境变量，不持久化到 `AcpState`）
- `permissionPolicy`
- `authenticationHandler`（认证回调——agent 需要认证时由宿主决定如何完成）
- `logger`
- `hooks`
- `eventSink`
- `permissionHandler`（自定义权限处理器）
- `filesystemHandler`（覆盖默认文件系统，可选）
- `terminalHandler`（覆盖默认终端，可选）
- `mcpServers`
- `timeouts` / `retry` / `queue`
- 已保存的 `AcpState`（仅 `resume` 场景）
- `sessionId`（仅 `load` 场景）
- `signal`（`AbortSignal`，支持取消创建/连接过程）

### 4.2 runtime 输出给宿主的内容

- `AcpAgent`
- `AcpState`
- `AcpTurn`
- 结构化错误
- hooks / event sink 事件

## 5. 典型接入模式

### 5.1 CLI 宿主

特点：

- 直接驱动 runtime
- 日志和事件主要用于终端输出与调试
- 一般不需要复杂持久化模型

典型做法：

- CLI 解析参数
- 调用 `AcpAgent.create/load/resume`
- 消费 `AcpTurn.events`
- 根据 `completion` 输出最终结果

### 5.2 GUI / Desktop 宿主

特点：

- 有 UI
- 需要实时展示 turn 进度
- 需要调试面板或状态视图

典型做法：

- UI 订阅 `events`
- completion 驱动结果区
- hooks / event sink 驱动调试视图
- 宿主把 `AcpState` 持久化到自己的 session 记录里

### 5.3 Daemon / Server 宿主

特点：

- 有长期运行进程
- 有自己的产品 session registry
- 可能同时管理多个 ACP session

典型做法：

- 宿主维护产品 session 列表
- runtime 只管理单个 ACP session
- 宿主把 `AcpState` 作为自己持久化结构的一个字段
- 恢复时由宿主决定恢复哪个 session

## 6. 推荐的宿主持久化模型

宿主不需要照搬 runtime 的内部结构，但应至少给 `AcpState` 留一个位置。

例如：

```ts
type HostSessionRecord = {
  hostSessionId: string;
  title?: string;
  acpState?: AcpState;
  messages: HostMessage[];
  metadata?: Record<string, unknown>;
};
```

关键点：

- `hostSessionId` 是宿主自己的标识
- `AcpState` 是 runtime 恢复状态
- 两者不是同一个概念

## 7. 恢复与 fallback 的边界

runtime 负责：

- 按 `AcpState` 尝试恢复
- 失败时抛出结构化错误

宿主负责：

- 决定要不要 fallback 到新 session
- 决定是否提示用户
- 决定是否保留旧 session 记录

典型模式：

```ts
try {
  return await AcpAgent.resume({ state: savedState });
} catch (error) {
  // 宿主在这里决定后续行为
}
```

## 8. 消息投影边界

runtime 输出的是 runtime 原语：

- `AcpTurnEvent`
- `AcpTurnCompletion`
- `AcpState`

宿主负责把这些投影成自己的产品模型：

- 聊天消息
- UI 状态
- 服务端同步 payload
- 审计记录

这个投影层不应放进 `acp-runtime`。

## 9. 权限接入方式

宿主应提供：

- `permissionPolicy`
- 可选 `permissionHandler`
- 可选 `filesystemHandler`
- 可选 `terminalHandler`

runtime 负责根据 agent adapter 和 policy 决定：

- 用 agent mode 落地
- 用 runtime handler 落地
- 或混合落地

## 9.1 认证接入方式

如果 agent 在 `initialize` 中返回 `authMethods`，宿主应能接收这些方法并决定如何完成认证。

建议宿主提供：

- `authenticationHandler`

宿主可以：

- 弹出登录 UI
- 指导用户执行外部登录命令
- 在无交互环境中显式取消

runtime 负责：

- 读取 `authMethods`
- 调用宿主认证处理器
- 执行认证请求
- 将认证成功或失败纳入可观测性

## 10. 可观测性接入方式

宿主应按自己的需要选择接入：

- `logger`
- `hooks`
- `eventSink`

不同宿主可有不同取舍：

- CLI 更依赖 logger
- GUI 更依赖 hooks 和 events
- Daemon / Server 更依赖 event sink 和结构化日志

宿主如果关心计划与命令能力，也应从事件中消费：

- `plan-update`
- `available-commands-update`

## 11. 当前结论

`acp-runtime` 的接入模型应始终围绕“宿主 / runtime 边界”来设计，而不是围绕某一个产品来设计。

这样做的收益：

- 包边界稳定
- 不被单一产品反向绑架
- CLI / GUI / Daemon 都能复用同一套 runtime 内核
