# Runtime Agent Compatibility

这份指南定义了 `acp-runtime` 应该如何处理不同 ACP agent 的行为差异，
同时避免把 runtime core 变成一堆 vendor-specific UI hack。

## 目标

`acp-runtime` 应该归一化那些会迫使每个宿主都理解 agent 私有行为的
**agent 实现差异**。

它不应该吸收纯宿主侧的产品选择，例如：
- UI 如何渲染 prompt
- 宿主是自动选择还是询问用户
- 产品提示和环境警告

它应该吸收 agent 兼容规则，例如：
- registry id 和短别名
- 异常、缺失或误导性的 auth method
- 对会打开完整交互式产品 CLI 的 terminal auth，转换成 protocol-only auth
- 当 agent 暴露多个等价选择时，给出默认 auth method hint
- generic host executor 需要的 terminal auth 完成 hint
- 可读 mode id/name/URI fragment 解析

## 兼容分层

### 1. Runtime Core

只有在保持宿主语义稳定时，runtime core 才应该做兼容。

例子：
- richer auth method model，而不是压平成 `{ id, title }`
- 解析 legacy auth metadata，例如 `_meta["terminal-auth"]`
- 用 profile hook 归一化异常或缺失的 initialize 数据
- 在宿主选择 auth 前，用 profile hook 归一化 runtime auth method
- `session.agent.setMode(...)` 支持可读 mode key，同时保留未知原始 id 透传
- 当 agent 把用户取消错误地报告成 internal/process error 时，做 prompt
  error 语义纠偏

规则：
- core 里只保留数据归一化和语义纠偏
- 结果必须保持 product-agnostic

### 2. Profile / Adapter Policy

Profile 负责 agent-specific 兼容策略。Profile 可以挂 normalized runtime
metadata，让 generic host 不需要检查具体 agent id。

例子：
- Gemini 历史上可能不返回 initialize auth methods，需要 synthetic fallback
  auth method
- Claude/Gemini 的 terminal login completion 字符串通过 normalized metadata
  暴露
- Codex 的偏好登录方式通过 default auth method metadata 暴露
- GitHub Copilot 本地已登录时移除 terminal login metadata
- Pi terminal login 转换成 protocol-only auth，避免宿主拉起完整 Pi 交互式 CLI

规则：
- 如果外部宿主否则需要写 `if agent.type === ...`，优先把规则放进
  profile 或共享 SDK helper
- 非显而易见的兼容 fallback 必须用 metadata 明确标记

### 3. Host / Demo 层

宿主 adapter 负责执行策略和 UX policy，不负责 agent-specific 兼容。

例子：
- 多个 auth method 时的交互式选择
- 从通用 runtime terminal-auth 数据拉起 terminal 登录命令
- 消费通用登录成功 metadata
- 本地产品提示、prompt 和格式化

规则：
- demo/host 代码不应该为了兼容性按具体 agent id 分支
- 如果一个分支是为了让某个 agent 能正常工作，先下沉到 runtime/profile

## 当前仓库中的例子

### 适合留在 Core

- `src/runtime/acp/auth-methods.ts`
  - richer auth method 映射
  - 从 runtime 数据中解析 terminal-auth request
- `src/runtime/acp/profiles/gemini.ts`
  - 把 Gemini 的 abort/internal-error 不一致纠偏成 `cancelled`
- `src/runtime/acp/session-service.ts`
  - 在宿主进行 auth 选择前应用 profile 驱动的 initialize/runtime auth 归一化
- `src/runtime/core/session.ts`
  - 接受 `Agent` 这类可读 mode name，同时保留未知 mode 的原始 id 透传

### Profile policy

- `src/runtime/acp/profiles/gemini.ts`
  - synthetic auth method fallback 会打上
    `_meta["acp-runtime/profile-policy"]`
- `src/runtime/acp/profiles/codex.ts`
  - 用 `acp-runtime/default-auth-method` 标记偏好 auth method
- `src/runtime/acp/profiles/claude-code.ts` 和
  `src/runtime/acp/profiles/gemini.ts`
  - 用 `acp-runtime/terminal-success-patterns` 暴露 terminal login 成功模式
- `src/runtime/acp/profiles/github-copilot.ts` 和
  `src/runtime/acp/profiles/pi.ts`
  - 对 generic host 屏蔽本地 auth/CLI 差异

### 只应该在 Host / adapter

- `examples/runtime-demo-auth-adapter.ts`
  - auth method prompt
  - terminal login 进程执行
  - 消费通用 metadata
- `examples/runtime-sdk-demo.ts`
  - CLI prompt 和平台提示

## 评审清单

在新增 agent-specific 行为前，先问：

1. 如果不做这个，是否每个外部宿主都要知道这个 agent-specific 规则？
2. 能不能把它表达成归一化后的 runtime 数据，而不是宿主执行逻辑？
3. 如果这是兼容行为，是否应该放在 profile 或共享 SDK helper，而不是 demo？
4. 如果这是纯 UI/产品行为，是否已经留在 host？
5. 如果它必须靠近 profile，是否已经明确标记为显式 policy？

如果答案是“这只是我们的 CLI/UI 想这么做”，那它就不应该进 runtime core。
