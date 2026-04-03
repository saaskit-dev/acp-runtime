# ACP Research Harness

这个目录用于采集真实 ACP 数据。

目标：

- 用统一矩阵测试不同 agent
- 捕获真实 ACP 协议消息
- 为协议兼容性、项目场景回归、权限映射与 adapter 实现提供证据

## 目录结构

```text
research/harness/
  README.md
  cases/
  outputs/
```

- `cases/`：可执行的 protocol / interaction / scenario case 定义
- `outputs/`：真实采集结果

## 采集目标

每次采集至少应产出：

```text
outputs/<agent>/<timestamp>/
  transcript.jsonl
  summary.json
  notes.md
```

### `transcript.jsonl`

保存原始 ACP 消息与关键运行时事件。

建议字段：

- `timestamp`
- `direction`
- `type`
- `method`
- `sessionId`
- `turnId`
- `payload`

### `summary.json`

保存结构化结论。

例如：

- capabilities
- mode 列表
- 权限请求统计
- 默认行为
- 对各 `permissionPolicy` 的建议映射

### `notes.md`

保存人工结论：

- 例外情况
- 失败实验
- 非预期行为
- 后续需要补测的问题

## 标准矩阵

harness 不只服务权限研究，而是服务三类验证：

- 协议覆盖矩阵
- 项目场景回归矩阵
- 新 agent 接入门禁

对应文档：

- `docs/research/protocol-coverage-matrix.md`
- `docs/research/project-scenario-matrix.md`
- `docs/research/agent-admission-checklist.md`

## 标准场景

建议每个 agent 至少运行以下场景：

- `basic-session-new`
- `basic-session-load`
- `set-mode`
- `read-file`
- `write-file`
- `delete-file`
- `run-command`
- `permission-denied`
- `non-interactive`

后续应把这些场景明确分组为：

- `protocol cases`
- `interaction cases`
- `scenario cases`

第一批可执行 case 已经放在：

- `cases/protocol/`
- `cases/scenario/`

不同 agent 的启动参数统一从 ACP Registry CDN 拉取（`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`），本地缓存 24h，不再本地维护。

也就是说：

- case 定义"测什么"（包含 probes 和 classification，按 agentId 分组）
- ACP Registry 定义"怎么启动谁"
- runner 负责把两者组合执行

## 实施原则

- 不凭文档直接下结论，必须结合真实采集结果
- 不同 agent 尽量运行同一批场景
- 输出物必须可追溯
- adapter mapping 只能建立在采集结果之上
- 新 agent 接入必须基于统一矩阵结果做判断

## 输出清理

开发阶段会频繁重跑 case。为了避免旧结果污染当前结论，harness 提供显式清理命令：

```bash
pnpm harness:clean-outputs --agent opencode
```

默认策略：

- 每个 `outputs/<agent>/<caseId>/` 只保留最新一份结果
- 每个 `outputs/<agent>/matrix/` 只保留最新一份结果

这条规则用于清除因 harness 自身变更、错误断言或旧实现留下的历史结果。

## 后续扩展

后续可补：

- 场景执行器
- transcript 采集器
- summary 汇总器
- 差异对比工具
