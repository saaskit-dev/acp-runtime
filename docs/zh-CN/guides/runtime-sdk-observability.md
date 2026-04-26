# Runtime SDK 可观测性

[English](../../guides/runtime-sdk-observability.md)

`acp-runtime` 现在默认是 **OpenTelemetry 已埋点的 SDK**。

这意味着：

- SDK 会为 session 生命周期、turn 执行、tool 操作、permission 流程产出 span
- SDK 也会为同一套 runtime 生命周期产出 log record
- SDK **不会**替宿主配置 exporter 或 backend
- 如果宿主应用已经安装了 OpenTelemetry tracer provider 和 logger provider，`acp-runtime` 的 telemetry 会自动进入宿主管线
- 如果宿主没有配置，tracing 和 logging 都会退化为 no-op，不影响 runtime 行为

## 边界

`acp-runtime` 负责：
- 创建 span
- 创建 log record
- 定义 ACP/runtime 语义属性
- 把 trace 上下文注入 ACP 请求 `_meta`

宿主应用负责：
- 安装 tracer provider
- 安装 context manager
- 配置 exporter
- 决定 collector / backend

这个边界是刻意设计的。
`acp-runtime` 是一个自带埋点的 SDK，不是一个 observability backend SDK。

## 当前会产出的 Span

当前一方埋点包括：

- `acp.session.start`
- `acp.session.load`
- `acp.session.resume`
- `acp.session.list`
- `acp.session.initialize`
- `acp.session.authenticate`
- `acp.turn`
- `acp.tool`
- `acp.permission`

当前一方日志事件包括：

- `acp.session.start`
- `acp.session.load`
- `acp.session.resume`
- `acp.session.list`
- `acp.session.initialize`
- `acp.session.authenticate`
- `acp.turn.started`
- `acp.turn.thought`
- `acp.turn.output`
- `acp.turn.plan`
- `acp.turn.completed`
- `acp.turn.failed`
- `acp.tool.started`
- `acp.tool.updated`
- `acp.tool.completed`
- `acp.tool.failed`
- `acp.permission.requested`
- `acp.permission.resolved`

代表性属性包括：

- `acp.agent.command`
- `acp.agent.type`
- `acp.session.action`
- `acp.session.cwd`
- `acp.session.id`
- `acp.session.reused`
- `acp.turn.id`
- `acp.prompt.kind`
- `acp.prompt.message_count`
- `acp.prompt.part_count`
- `acp.prompt.text_length`
- `acp.operation.*`
- `acp.permission.*`
- `acp.usage.*`

当前实现默认会做 **全文内容采集**，只要对应内容在 runtime 里可见，就会尽量写进 span。
这包括：

- prompt 内容
- assistant 输出
- thought / reasoning 文本
- tool raw input / raw output
- terminal output
- diff 文本

这个默认值对宿主侧调试很直接，但也意味着更高的隐私、存储和合规成本。
如果宿主不希望默认全文采集，应该显式降级。

## 内容采集策略

Runtime options 支持：

```ts
const runtime = new AcpRuntime(createStdioAcpConnectionFactory(), {
  observability: {
    captureContent: "summary",
    redact(value, context) {
      if (context.kind === "prompt") {
        return "[redacted prompt]";
      }
      return value;
    },
  },
});
```

可选模式：

- `full`：采完整序列化内容
- `summary`：采截断摘要
- `none`：只采结构化元数据

`redact(...)` 会在内容写入 span 和 log record 前执行。
宿主可以用它实现脱敏、机密擦除或自定义内容归一化。

## 宿主如何接入

如果宿主已经配置了 OpenTelemetry，那么 `acp-runtime` 不需要额外配置。

最小宿主示例：

```ts
import { logs } from "@opentelemetry/api-logs";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  ConsoleLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";

const provider = new NodeTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
provider.register();

const loggerProvider = new LoggerProvider({
  processors: [new SimpleLogRecordProcessor(new ConsoleLogRecordExporter())],
});
logs.setGlobalLoggerProvider(loggerProvider);
```

之后正常使用 runtime 就会自动出 trace 和 log：

```ts
const runtime = new AcpRuntime(createStdioAcpConnectionFactory());

const session = await runtime.sessions.start({
  agent: "claude-acp",
  cwd: process.cwd(),
});

const result = await session.turn.run("hello");
```

## Demo CLI Raw 日志

`./run runtime ...` 这个 demo CLI 默认会写到
`~/.acp-runtime/logs/runtime.log`。可以用 `--log-file <path>` 覆盖位置，
或用 `--no-log-file` 关闭本次文件日志。

默认 `runtime.log` 路径每次进程启动都会写一份新的 latest 日志。ACP session 创建后，
demo 会把同样内容镜像到 `~/.acp-runtime/logs/sessions/<sessionId>/`。在拿到
session id 之前产生的启动日志会回填到这个 session 目录里。

它会写这些输出：

- `<path>`：给人看的终端文本日志
- `<path>.jsonl`：OpenTelemetry 形状的 log records
- `sessions/<sessionId>/runtime.log`：默认路径下的单 session 文本日志
- `sessions/<sessionId>/runtime.log.jsonl`：默认路径下的单 session raw log records

raw `.jsonl` 已经不再是旧的自定义 `recordType` 事件流。
现在它和 SDK core 使用的是同一套日志语义，字段会包括：

- `eventName`
- `body`
- `attributes`
- `severityNumber`
- `severityText`
- `instrumentationScope`
- `spanContext`

## ACP Trace 传递

当 `acp-runtime` 发出这些 ACP 请求时：

- `initialize`
- `newSession`
- `loadSession`
- `resumeSession`
- `listSessions`
- `prompt`

它会把 trace 上下文注入到 ACP `_meta` 中：

- `traceparent`
- `tracestate`
- 有的话再带 `baggage`

这样支持 tracing 的 agent 就可以继续这条链路，而不是重新起一条无关 trace。

## Read Model 与 Tracing 的关系

Tracing 不是 runtime read model 的替代品。

建议这样理解：

- `session.turn.*`：执行面
- `session.state.*`：稳定的 thread/object-store 读模型和轻量 projection 状态
- OpenTelemetry spans 和 log records：跨系统可观测性

Tracing 更适合回答：
- 这一轮到底耗时多久？
- 哪个 tool 卡住了？
- permission 卡点出现在什么地方？
- 哪次 session/load/resume 失败了？

Read model 更适合回答：
- 当前有哪些 diff？
- 哪些 terminal 还活着？
- thread 里现在到底有什么？

## 推荐宿主策略

推荐默认做法：

- 让 `acp-runtime` 负责产 span
- 宿主统一安装一次 OpenTelemetry SDK
- traces 路由到宿主已有的 backend

例如：

- Jaeger / Tempo / OTLP collector
- 宿主已有的 Langfuse OTel 管线
- 宿主已有的 Phoenix / OpenInference 管线
- New Relic / Datadog 这类通用 APM

runtime 本身应保持 backend-neutral。

## JavaScript Logs 当前状态

OpenTelemetry JavaScript logs 目前仍依赖实验性的
`@opentelemetry/api-logs` 和 `@opentelemetry/sdk-logs`。
所以宿主应当把 logs API 看成比 tracing 更容易变动的接口面。
