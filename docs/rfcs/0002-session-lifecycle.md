# RFC-0002：Session 生命周期

- 状态：Proposed
- 日期：2026-04-03

## 1. 目标

定义 `create / load / resume / close` 的精确语义，避免混淆协议动作与运行时动作。

## 2. 基本概念

### 2.1 `create`

运行时动作。

语义：

- 新建 agent 连接
- 调用 ACP `session/new`
- 建立一个全新的 session

### 2.2 `load`

协议动作。

语义：

- 调用 ACP `session/load`
- 恢复指定 session
- 接受协议定义的历史 replay 行为

### 2.3 `resume`

运行时动作。

语义：

- 根据之前保存的 `AcpState` 恢复可继续使用的运行时会话
- 它不是 ACP 原语本身
- 它内部可以选择 `session/resume` 或 `session/load`

`resume !== load`

## 3. 公共 API

```ts
class AcpAgent {
  // 三种创建方式：显式意图，不靠 SDK 猜
  static async create(options: AcpAgentCreateOptions): Promise<AcpAgent>;
  static async load(options: AcpAgentLoadOptions): Promise<AcpAgent>;
  static async resume(options: AcpAgentResumeOptions): Promise<AcpAgent>;

  // 三层 turn API（上层基于下层实现）
  async run(prompt: AcpPrompt): Promise<string>;
  async send(prompt: AcpPrompt, handlers?: AcpTurnHandlers): Promise<string>;
  stream(prompt: AcpPrompt, options?: AcpStreamOptions): AsyncIterable<AcpTurnEvent>;

  // 控制
  async cancel(): Promise<void>;
  async setMode(modeId: string): Promise<void>;
  async setModel(modelId: string): Promise<void>;
  async setConfig(optionId: string, value: string): Promise<void>;
  async close(): Promise<void>;

  // 只读状态
  get state(): Readonly<AcpState>;
  get status(): AcpRuntimeStatus;
  get capabilities(): Readonly<AcpCapabilities> | null;
}
```

每种创建方式对应明确意图：
- `create`：全新 session，明确知道不需要恢复
- `load`：明确有 sessionId，要求恢复，失败即抛错
- `resume`：有完整 `AcpState`，要求恢复，失败即抛错

## 4. `create()` 语义

流程：

1. spawn agent
2. initialize ACP connection
3. 读取 `initialize` 返回的 `authMethods`
4. 若需要认证，则执行认证流程
5. 调用 `session/new`
6. 应用初始化 desired state
7. 进入 `ready`

失败即抛错，不做恢复补偿。

## 5. `load()` 语义

流程：

1. spawn agent
2. initialize ACP connection
3. 读取 `initialize` 返回的 `authMethods`
4. 若需要认证，则执行认证流程
5. 调用 `session/load(sessionId)`
6. 处理协议 replay
7. 发出结构化观测事件并更新运行态
8. 进入 `ready`

约束：

- `load()` 失败直接抛错
- 不允许隐式 fallback 到 `session/new`

原因：

如果调用方明确表达“我要 load 某个 session”，runtime 不能把失败偷偷解释成“那我给你新建一个”。

## 6. `resume()` 语义

流程：

1. 读取调用方提供的 `AcpState`
2. merge overrides
3. spawn agent
4. initialize ACP connection
5. 读取 `initialize` 返回的 `authMethods`
6. 若需要认证，则执行认证流程
7. 按能力选择恢复路径
8. 恢复后 replay desired state
9. 进入 `ready`

推荐的恢复路径：

1. 如果 agent 支持 `session/resume`，优先使用
2. 否则如果 agent 支持 `session/load`，使用 `session/load`
3. 否则抛出 `AcpResumeUnsupportedError`

约束：

- `resume()` 失败直接抛错
- 不允许隐式 fallback 到 `session/new`

## 6.1 认证语义

如果 agent 在 `initialize` 中返回 `authMethods`，runtime 应进入认证判定流程。

建议抽象：

```ts
type AcpAuthMethod = {
  id: string;
  name: string;
  description?: string;
};

type AcpAuthenticationHandler = (
  methods: AcpAuthMethod[],
  context: { agent: string },
) => Promise<{ methodId: string } | { cancel: true }>;
```

规则：

- `authMethods` 是协议能力发现结果，不是纯展示字段
- runtime 应把可用认证方法暴露给宿主
- 宿主决定如何完成登录或取消
- 认证失败应作为结构化错误处理，而不是静默跳过

## 7. close 语义

`close()` 的语义：

- 停止接收后续 turn
- 关闭或释放当前 ACP 连接
- 标记 runtime 状态为 `closed`

`closed` 是终态。

关闭后的实例不能再次发送 turn。

## 8. 状态迁移

```text
idle → connecting → ready ⇄ running → ready → closed
                      ↓                  ↑
               disconnected → connecting →
```

`AcpRuntimeStatus` 类型：

```ts
type AcpRuntimeStatus = "idle" | "connecting" | "ready" | "running" | "disconnected" | "closed";
```

约束：

- `idle` 是初始状态，尚未连接
- 只有 `ready` 才允许开始新 turn
- `running` 中新的 turn 进入队列（交由 turn 模型定义）
- `disconnected` 可通过 `resume()` 或新 `load()` 重新进入 `connecting`
- `closed` 是终态，任何执行动作都抛错

注意：`status` 是 `AcpAgent` 实例的运行时属性，不写入 `AcpState`。

## 9. 显式 fallback

如果产品层想做“恢复失败后新建”，必须自己写：

```ts
try {
  return await AcpAgent.resume({ state });
} catch {
  return await AcpAgent.create({
    agent: state.agent,
    cwd: state.cwd,
  });
}
```

runtime 内核不能替业务层做这个决策。
