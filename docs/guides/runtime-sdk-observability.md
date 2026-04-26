# Runtime SDK Observability

Language:
- English (default)
- [简体中文](../zh-CN/guides/runtime-sdk-observability.md)

`acp-runtime` is now **OpenTelemetry-instrumented by default**.

That means:

- the SDK emits spans for session lifecycle, turn execution, tool operations, and permission flows
- the SDK emits log records for the same runtime lifecycle
- the SDK does **not** configure exporters or backends
- if the host application already installs an OpenTelemetry tracer provider and logger provider, `acp-runtime` telemetry automatically joins that pipeline
- if the host does nothing, tracing and logging become no-op and runtime behavior stays unchanged

## Boundary

`acp-runtime` owns:
- span creation
- log record creation
- ACP/runtime-specific attributes
- trace propagation into ACP request `_meta`

The host application owns:
- tracer provider installation
- context manager installation
- exporters
- collector / backend routing

This boundary is intentional.
`acp-runtime` is an instrumented SDK, not an observability backend SDK.

## What Gets Traced

Current first-party spans:

- `acp.session.start`
- `acp.session.load`
- `acp.session.resume`
- `acp.session.list`
- `acp.session.initialize`
- `acp.session.authenticate`
- `acp.turn`
- `acp.tool`
- `acp.permission`

Current first-party log events:

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

Representative attributes:

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

By default, the current implementation captures **full content** when content is available.
That includes prompt payloads, assistant output, thoughts, tool raw input/output, terminal output, and diff text.

This default is intentionally aggressive for host-side debugging, but it has privacy and storage implications.
Hosts that do not want full capture should explicitly lower it.

## Content Capture Policy

Runtime options support:

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

Available modes:

- `full`: capture full serialized content
- `summary`: capture a truncated summary
- `none`: capture only structural metadata

The `redact(...)` hook runs before content is attached to spans and log records.
Use it for host-specific privacy policies, secrets masking, or content normalization.

## Host Setup

If the host already configures OpenTelemetry, nothing extra is required inside `acp-runtime`.

Minimal host example:

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

After that, normal runtime usage automatically emits spans and log records:

```ts
const runtime = new AcpRuntime(createStdioAcpConnectionFactory());

const session = await runtime.sessions.start({
  agent: "claude-acp",
  cwd: process.cwd(),
});

const result = await session.turn.run("hello");
```

## Demo CLI Raw Logs

The `./run runtime ...` demo CLI writes logs by default under
`~/.acp-runtime/logs/runtime.log`. Use `--log-file <path>` to override the
location, or `--no-log-file` to disable file logging for that run.

For the default `runtime.log` path, each process starts a fresh "latest" log.
After the ACP session is created, the demo also mirrors the same content into
`~/.acp-runtime/logs/sessions/<sessionId>/`. Startup records emitted before the
session id exists are backfilled into that session directory.

It writes these outputs:

- `<path>`: human-readable terminal transcript
- `<path>.jsonl`: OpenTelemetry-shaped log records
- `sessions/<sessionId>/runtime.log`: per-session human transcript for the default path
- `sessions/<sessionId>/runtime.log.jsonl`: per-session raw log records for the default path

The raw `.jsonl` file is no longer a custom `recordType` event stream.
It now mirrors the same log signal model used by the SDK core, including fields such as:

- `eventName`
- `body`
- `attributes`
- `severityNumber`
- `severityText`
- `instrumentationScope`
- `spanContext`

## ACP Trace Propagation

When `acp-runtime` issues ACP requests such as:

- `initialize`
- `newSession`
- `loadSession`
- `resumeSession`
- `listSessions`
- `prompt`

it injects trace context into ACP `_meta` using:

- `traceparent`
- `tracestate`
- `baggage` when available

This lets compatible agents continue the trace instead of starting an unrelated one.

## Read Model vs Tracing

Tracing is not a replacement for the runtime read model.

Use:

- `session.turn.*` for execution
- `session.state.*` for stable thread/object-store state and lightweight projection state
- OpenTelemetry spans and log records for cross-system observability

Tracing answers:
- how long did this turn take?
- which tool stalled?
- where did permission gating happen?
- which session/load/resume path failed?

The read model answers:
- what diffs exist?
- which terminals are active?
- what does the thread currently contain?

## Recommended Host Strategy

Recommended default:

- let `acp-runtime` emit spans
- let the host install OpenTelemetry SDK once
- route traces to any backend the host already uses

Examples:

- Jaeger / Tempo / OTLP collectors
- Langfuse through the host's existing OTel pipeline
- Phoenix / OpenInference through the host's existing OTel pipeline
- general APM backends such as New Relic or Datadog

The runtime should remain backend-neutral.

## JavaScript Logs Status

OpenTelemetry JavaScript logs currently rely on the experimental
`@opentelemetry/api-logs` and `@opentelemetry/sdk-logs` packages.
Hosts should treat the logs API surface as more change-prone than tracing.
