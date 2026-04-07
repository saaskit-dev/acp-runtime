# RFC-0005: Permissions and Client Authority

Language:
- English (default)
- [简体中文](#简体中文)

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

## Simplified Chinese

[Back to English](#rfc-0005-permissions-and-client-authority)

# RFC-0005：权限抽象与 Client-Authority 设计

- 状态：Proposed
- 日期：2026-04-03

## 1. 目标

定义 `acp-runtime` 如何抽象权限策略，并处理 ACP 中由 client 侧负责的方法。

重点不是统一不同 agent 的 mode 名称，而是统一“权限策略意图”。

## 2. 背景问题

不同 agent 在权限和 mode 上的语义差异很大：

- 有的 agent 有明确 mode，并且 mode 带权限含义
- 有的 agent 有 mode，但 mode 不完全等于权限策略
- 有的 agent mode 很少，或者 mode 不承载权限边界
- 有的 agent 默认就是高权限 / yolo 风格

因此不能把“mode 列表”当作 runtime 的统一抽象层。

## 3. 核心结论

本 RFC 的核心结论：

- `modeId` 是 agent-specific 原语
- `permissionPolicy` 是 runtime-specific 抽象
- adapter 负责把 `permissionPolicy` 映射到 agent 的真实能力

也就是说，映射方向应为：

```text
runtime permission policy
  -> agent mode
  -> runtime permission handler
  -> 或两者组合
```

而不是：

```text
agent mode -> 我们的统一 mode
```

## 4. 借鉴 acpx 的地方

`acpx` 当前其实已经把“权限”和“mode”分成两条线：

- `permissionMode`：`approve-all` / `approve-reads` / `deny-all`
- `modeId`：agent 原生 `session/set_mode`

这说明：

- `acpx` 的统一抽象中心是权限模式
- agent mode 没有被它抽象成统一权限模型

这个方向是对的，我们应继续沿着它走，但进一步升级成更通用的 runtime 设计。

## 5. 三层抽象

### 5.1 协议层：原样能力

协议层只暴露 agent 真正具备的能力，不做跨 agent 统一语义假设。

```ts
type AcpCapabilities = {
  sessionLoad: boolean;
  sessionResume?: boolean;
  setMode: boolean;
  setModel: boolean;
  modes?: AcpModeDescriptor[];
};

type AcpModeDescriptor = {
  id: string;
  label?: string;
  description?: string;
  metadata?: Record<string, unknown>;
};
```

注意：

- `modes` 是 agent-specific 的
- 不要求不同 agent 的 mode 同构
- runtime 不应假装它们能一一对齐

### 5.2 Runtime 层：统一权限策略

runtime 统一抽象的是“权限策略意图”。

```ts
type AcpPermissionPolicy =
  | { kind: "agent-default" }
  | { kind: "read-only" }
  | { kind: "balanced" }
  | { kind: "full-access" }
  | { kind: "custom"; handler: AcpPermissionHandler };
```

这些字段表达的是调用方的目标，而不是某个 agent 的 mode 名字。

### 5.3 适配层：映射计划

每个 agent adapter 负责把统一权限策略映射到自己的能力上。

```ts
type ResolvedPermissionPlan = {
  modeId?: string;
  handlerStrategy: "agent-enforced" | "runtime-enforced" | "mixed";
  supported: boolean;
  notes?: string[];
};

type AcpAgentPermissionAdapter = {
  resolvePermissionPolicy(
    policy: AcpPermissionPolicy,
    capabilities: AcpCapabilities,
  ): ResolvedPermissionPlan;
};
```

## 6. `modeId` 与 `permissionPolicy` 的关系

这两个字段不能混成一个。

### `modeId`

- 是 agent 原生 mode
- 是 ACP / agent-specific 的原语
- 由调用方显式指定时，runtime 应尽量原样传递

### `permissionPolicy`

- 是 runtime 自己的抽象
- 表达调用方要的权限边界
- 用于驱动 adapter 选择 mode、handler 或混合方案

建议放在 `desired` 里：

```ts
type AcpDesiredState = {
  modeId?: string;
  modelId?: string;
  permissionPolicy?: AcpPermissionPolicy;
  config?: Record<string, unknown>;
};
```

## 7. 适配策略

### 7.1 Claude / 类似 agent

如果 agent 有明确 mode，且 mode 与权限边界较强相关，则：

- `read-only` -> 映射到受限 mode
- `balanced` -> 映射到中间 mode
- `full-access` -> 映射到高权限 mode

必要时再叠加 runtime handler 兜底。

### 7.2 OpenCode / mode 不足够表达权限的 agent

如果 agent 没有足够清晰的 mode 体系，则：

- `agent-default` -> 不做额外控制
- `read-only` / `balanced` -> 主要靠 runtime handler 执行
- `full-access` -> 可退化为 agent 默认行为

### 7.3 无法满足策略的情况

如果某个 policy 无法被当前 agent 能力满足，应明确报不支持，而不是假装支持。

## 8. Client-Authority 方法

权限策略真正落地的地方，不只是 mode，还包括 client-authority 方法。

主要包括：

- 文件读写
- terminal
- `session/request_permission`

因此 runtime 需要注入 handler：

```ts
type AcpFilesystemHandler = {
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
};

type AcpTerminalHandler = {
  createTerminal(options: unknown): Promise<unknown>;
  writeTerminal(id: string, input: string): Promise<void>;
  killTerminal(id: string): Promise<void>;
};

type AcpPermissionHandler = (
  request: AcpPermissionRequest,
  context: AcpPermissionContext,
) => Promise<AcpPermissionDecision>;
```

## 9. 建议的决策流程

每次启动 session 时：

1. 获取 agent capabilities
2. 读取 `desired.permissionPolicy`
3. 交给 agent adapter 解析
4. 得到 `ResolvedPermissionPlan`
5. 应用 plan：
   - 如果有 `modeId`，尝试设置 mode
   - 如果需要 runtime handler，则启用 handler
   - 如果是 `mixed`，两边同时生效
6. 若 `supported = false`，直接失败

## 10. 为什么这是正确抽象

因为统一的是“权限目标”，而不是“mode 名字”。

这能天然兼容：

- mode 很丰富的 agent
- mode 很弱的 agent
- 几乎没有权限 mode 的 agent
- 未来新增 agent

只要 adapter 能回答“这个 policy 怎么落地”，runtime 核心就不需要知道每个 agent 的 mode 细节。

## 11. v1 建议

v1 可以先做一个偏保守的策略集合：

- `agent-default`
- `read-only`
- `balanced`
- `full-access`

然后要求每个内置 agent adapter 至少回答：

- 哪些 policy 支持
- 映射到哪个 mode（如果有）
- 是否需要 runtime handler 参与

## 12. Client-Authority 默认实现

ACP 协议要求 client 处理 `readTextFile`、`writeTextFile`、`createTerminal` 等请求。
如果 runtime 不处理，agent 会卡住等待。

v1 建议：

- **提供默认的 filesystem 和 terminal handler**（直接执行读写/创建进程）
- 消费方可通过 options 覆盖（注入自己的 handler 实现鉴权、审计、沙箱等）
- 如果消费方既不传 handler 也不想用默认实现，可传 `null` 显式禁用（agent 请求会被拒绝）

```ts
// 默认行为：直接执行
const agent = await AcpAgent.create({ agent: 'claude', cwd: '/project' });
// agent 读文件 → 直接 fs.readFile

// 自定义 handler：注入沙箱
const agent = await AcpAgent.create({
  agent: 'claude',
  cwd: '/project',
  filesystemHandler: mySandboxedFs,
});

// 显式禁用
const agent = await AcpAgent.create({
  agent: 'claude',
  cwd: '/project',
  filesystemHandler: null,   // readTextFile 请求将被拒绝
});
```

这确保 runtime 开箱即用，不强制消费方实现底层 handler。
