[English](../../../rfcs/0004-state-and-recovery.md)

# RFC-0004：状态模型与恢复

- 状态：Proposed
- 日期：2026-04-03

## 1. 目标

定义 runtime 的状态对象、持久化边界、恢复输入与恢复规则。

## 2. 设计原则

- 状态必须透明
- 状态必须足够恢复
- 状态归调用方所有
- runtime 不维护产品级 session 注册表
- 只保留单一 `session.id` 作为 ACP session 标识

## 3. 核心状态对象

### 3.1 `AcpState`

可持久化、可恢复的状态对象。

```ts
type AcpState = {
  version: 1;
  agent: AcpAgentDef | string;
  cwd: string;
  session: {
    id: string;
  };
  desired: {
    modeId?: string;
    modelId?: string;
    permissionPolicy?: AcpPermissionPolicy;
    config?: Record<string, unknown>;
  };
  createdAt: string;
  lastUsedAt: string;
  lastConnectedAt?: string;
  process?: {
    pid?: number;
    startedAt?: string;
    exitCode?: number | null;
    exitSignal?: string | null;
  };
  mcpServers?: AcpMcpServer[];
  timeouts?: AcpTimeouts;
  retry?: AcpRetryPolicy;
  queue?: AcpQueuePolicy;
};
```

注意：`runtime.status` 不在 `AcpState` 中。状态（idle/connecting/ready/running 等）是运行时瞬态，
通过 `agent.status` 属性和可观测性体系（hooks/events/logger）表达，不持久化。

### 3.2 `AcpDesiredState`

表达用户意图，而不是“当前看起来像什么”。

```ts
type AcpDesiredState = {
  modeId?: string;
  modelId?: string;
  permissionPolicy?: AcpPermissionPolicy;
  config?: Record<string, unknown>;
};
```

## 4. 持久化边界

调用方应持久化 `AcpState`。

runtime 不应：

- 自动写全局 session 注册表
- 自动决定状态放磁盘、数据库还是远端

调用方应：

- 在合适时机保存 `AcpState`
- 在启动时自行决定要恢复哪个 session

## 5. 恢复输入

`resume()` 的输入应是：

- `state`
- 可选 `overrides`

典型场景：

- 覆盖 `cwd`
- 覆盖 `mcpServers`
- 覆盖 timeout / retry / queue 策略

## 6. 恢复规则

恢复流程应遵循：

1. merge `state` 与 `overrides`
2. 启动 agent
3. 初始化 ACP
4. 执行恢复动作
5. replay `desired`
6. 更新新 state

## 7. replay 规则

恢复后的 replay 只针对用户意图：

- mode
- model
- config

不应把 replay 等同于上下文恢复。

上下文恢复由 `load` 或 `resume` 协议动作负责。

## 8. 失败规则

恢复流程任一步失败都应抛错。

特别是：

- session 标识失效
- agent 不支持所需恢复能力
- replay desired state 失败

这些都不允许 silently heal 成新 session。

## 9. 为什么不做内建 session 注册表

因为“有哪些 session、恢复哪个 session、何时丢弃旧 session”属于产品状态，不属于 runtime 原语。

runtime 只负责：

- 提供足够恢复的状态
- 接受状态并尝试恢复

## 10. 版本化

`AcpState` 应带 `version` 字段。

这样未来可以：

- 平滑升级 state schema
- 支持 migration
- 避免调用方在不兼容 schema 上直接 resume

## 11. 为什么 `env` 不放进 `AcpState`

`env` 属于运行时启动输入，而不是核心持久化恢复状态。

原因：

- 很容易包含敏感信息
- 大多数恢复场景并不需要把完整环境变量持久化
- 它更适合作为 `create / load / resume` 的 options 输入

因此建议：

- `AcpState` 不保存 `env`
- `env` 仅作为运行时 options 传入

## 12. 运行态信息表达

本设计中：

- `AcpState` 负责恢复与持久化
- 运行中的连接状态、turn 进度、重连过程、权限处理、异常退出等信息，统一通过可观测性体系表达

因此调用方应把“实时状态查看”和“问题排查”建立在 hooks、事件、日志与 tracing 之上，而不是混入持久化状态对象。

[English](../../rfcs/0004-state-and-recovery.md)
