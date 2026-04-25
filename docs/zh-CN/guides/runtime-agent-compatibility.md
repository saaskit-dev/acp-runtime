# Runtime Agent Compatibility

这份指南定义了 `acp-runtime` 应该如何处理不同 ACP agent 的行为差异，
同时避免把 runtime core 变成一堆 vendor-specific UI hack。

## 目标

`acp-runtime` 应该归一化那些会导致宿主**误解语义**的差异。

它不应该吸收纯宿主侧的产品选择，例如：
- CLI 如何执行登录
- UI 如何判断一个登录命令“看起来已经成功”
- 产品提示和环境警告

## 兼容分层

### 1. Runtime Core

只有在保持宿主语义稳定时，runtime core 才应该做兼容。

例子：
- richer auth method model，而不是压平成 `{ id, title }`
- 解析 legacy auth metadata，例如 `_meta["terminal-auth"]`
- 用 profile hook 归一化异常或缺失的 initialize 数据
- 当 agent 把用户取消错误地报告成 internal/process error 时，做 prompt
  error 语义纠偏

规则：
- core 里只保留数据归一化和语义纠偏
- 结果必须保持 product-agnostic

### 2. Host / Adapter 层

宿主 adapter 负责执行策略和 UX policy。

例子：
- 多个 auth method 时的交互式选择
- 拉起 terminal 登录命令
- 匹配 `Login successful` 这类 success text
- 本地产品提示、prompt 和格式化

规则：
- 只要行为依赖宿主 UX 或产品流程，就不要放进 core

### 3. 显式 Profile Policy

有些 agent 需要的兼容超出了纯解析，但又比 host 更靠近 profile。

例子：
- Gemini 历史上可能不返回 initialize auth methods，需要 runtime 提供一个
  synthetic fallback auth method 才能继续认证

规则：
- 只有在互操作性确实需要时才允许
- 必须显式标记为 profile policy
- 不能伪装成通用 ACP 行为

## 当前仓库中的例子

### 适合留在 Core

- `src/runtime/acp/auth-methods.ts`
  - richer auth method 映射
  - 从 runtime 数据中解析 terminal-auth request
- `src/runtime/acp/profiles/gemini.ts`
  - 把 Gemini 的 abort/internal-error 不一致纠偏成 `cancelled`
- `src/runtime/acp/session-service.ts`
  - 在宿主进行 auth 选择前应用 profile 驱动的 initialize 归一化

### 只应该在 Host / adapter

- `examples/runtime-demo-auth-adapter.ts`
  - auth method 选择
  - terminal 登录执行
  - 基于 success-pattern 的登录完成判定
- `examples/runtime-sdk-demo.ts`
  - CLI prompt 和平台提示

### 显式 Profile Policy

- `src/runtime/acp/profiles/gemini.ts`
  - synthetic auth method fallback 会打上
    `_meta["acp-runtime/profile-policy"]`

## 评审清单

在新增 agent-specific 行为前，先问：

1. 这是不是在修复一个会误导宿主的语义偏差？
2. 能不能把它表达成归一化后的 runtime 数据，而不是宿主执行逻辑？
3. 如果不能，它是不是应该放在 host adapter？
4. 如果它必须靠近 profile，是否已经明确标记为显式 policy？

如果答案是“这只是我们的 CLI/UI 想这么做”，那它就不应该进 runtime core。
