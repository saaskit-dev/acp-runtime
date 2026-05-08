import { isSpanContextValid, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
  type LogRecordExporter,
} from "@opentelemetry/sdk-logs";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";

export const ACP_RELAY_LOG_UPLOAD_ENV_VAR = "ACP_RELAY_LOG_UPLOAD" as const;
export const ACP_RELAY_LOG_UPLOAD_URL_ENV_VAR =
  "ACP_RELAY_LOG_UPLOAD_URL" as const;
export const ACP_RELAY_LOG_UPLOAD_TOKEN_ENV_VAR =
  "ACP_RELAY_LOG_UPLOAD_TOKEN" as const;
export const ACP_RELAY_LOG_UPLOAD_BATCH_SIZE_ENV_VAR =
  "ACP_RELAY_LOG_UPLOAD_BATCH_SIZE" as const;
export const ACP_RELAY_LOG_UPLOAD_FLUSH_INTERVAL_MS_ENV_VAR =
  "ACP_RELAY_LOG_UPLOAD_FLUSH_INTERVAL_MS" as const;

const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_MAX_PAYLOAD_BYTES = 512 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 64 * 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const MAX_SAFE_JSON_DEPTH = 8;
const MAX_SAFE_STRING_LENGTH = 16 * 1024;

export type AcpRelayLogUploadRecordKind =
  | "otel_log"
  | "otel_span"
  | "text";

export type AcpRelayLogUploadRecord = {
  attributes?: Record<string, unknown>;
  body?: unknown;
  eventName?: string;
  kind: AcpRelayLogUploadRecordKind;
  observedAt: string;
  record?: unknown;
  severityNumber?: number;
  severityText?: string;
  spanId?: string;
  spanContext?: unknown;
  traceId?: string;
};

export type AcpRelayLogUploadPayload = {
  context?: Record<string, unknown>;
  records: readonly AcpRelayLogUploadRecord[];
  source: string;
  version: 1;
};

export type AcpRelayLogUploader = {
  close(): Promise<void>;
  emit(record: AcpRelayLogUploadRecord): void;
  flush(): Promise<void>;
  writeText(
    message: string,
    attributes?: Record<string, unknown>,
    options?: AcpRelayLogTextOptions,
  ): void;
};

export type AcpRelayLogTextOptions = {
  severityText?: string;
  spanId?: string;
  traceId?: string;
};

export type AcpRelayLogUploaderOptions = {
  accountSession: string;
  batchSize?: number;
  context?: Record<string, unknown>;
  endpointUrl: string | URL;
  fetch?: typeof fetch;
  flushIntervalMs?: number;
  onError?: (error: unknown) => void;
  source: string;
};

export type AcpRelayLogUploaderEnvOptions = {
  accountSession?: string;
  context?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  onError?: (error: unknown) => void;
  relayUrl?: string;
  source: string;
};

export type AcpRelayTelemetry = {
  close(): Promise<void>;
  loggerProvider: LoggerProvider;
  tracerProvider: BasicTracerProvider;
  uploader: AcpRelayLogUploader;
};

export function createAcpRelayLogUploadUrl(relayUrl: string | URL): string {
  const url = new URL(relayUrl);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }
  url.pathname = "/api/logs";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function createAcpRelayLogUploader(
  options: AcpRelayLogUploaderOptions,
): AcpRelayLogUploader {
  return new RelayLogUploader(options);
}

export function createAcpRelayLogUploaderFromEnv(
  options: AcpRelayLogUploaderEnvOptions,
): AcpRelayLogUploader | undefined {
  const env = options.env ?? process.env;
  if (isDisabled(env[ACP_RELAY_LOG_UPLOAD_ENV_VAR])) {
    return undefined;
  }

  const relayUrl =
    options.relayUrl ??
    env.ACP_RELAY_URL ??
    env.ACP_REMOTE_DAEMON_RELAY_URL;
  const endpointUrl =
    env[ACP_RELAY_LOG_UPLOAD_URL_ENV_VAR] ??
    (relayUrl ? createAcpRelayLogUploadUrl(relayUrl) : undefined);
  const accountSession =
    options.accountSession ??
    env[ACP_RELAY_LOG_UPLOAD_TOKEN_ENV_VAR] ??
    env.ACP_ACCOUNT_SESSION ??
    env.ACP_REMOTE_DAEMON_ACCOUNT_SESSION;

  if (!endpointUrl || !accountSession) {
    return undefined;
  }

  return createAcpRelayLogUploader({
    accountSession,
    batchSize: readPositiveInteger(
      env[ACP_RELAY_LOG_UPLOAD_BATCH_SIZE_ENV_VAR],
    ),
    context: options.context,
    endpointUrl,
    flushIntervalMs: readPositiveInteger(
      env[ACP_RELAY_LOG_UPLOAD_FLUSH_INTERVAL_MS_ENV_VAR],
    ),
    onError: options.onError,
    source: options.source,
  });
}

export function configureAcpRelayTelemetryFromEnv(
  options: AcpRelayLogUploaderEnvOptions,
): AcpRelayTelemetry | undefined {
  const uploader = createAcpRelayLogUploaderFromEnv(options);
  if (!uploader) {
    return undefined;
  }
  return configureAcpRelayTelemetry({ uploader });
}

export function configureAcpRelayTelemetry(input: {
  uploader: AcpRelayLogUploader;
}): AcpRelayTelemetry {
  const loggerProvider = new LoggerProvider({
    processors: [
      new SimpleLogRecordProcessor(
        createAcpRelayLogRecordExporter(input.uploader),
      ),
    ],
  });
  logs.setGlobalLoggerProvider(loggerProvider);

  const tracerProvider = new BasicTracerProvider();
  tracerProvider.addSpanProcessor(
    new SimpleSpanProcessor(createAcpRelaySpanExporter(input.uploader)),
  );
  trace.setGlobalTracerProvider(tracerProvider);

  return {
    async close() {
      await Promise.allSettled([
        loggerProvider.forceFlush(),
        tracerProvider.forceFlush(),
      ]);
      await Promise.allSettled([
        loggerProvider.shutdown(),
        tracerProvider.shutdown(),
      ]);
      await input.uploader.close();
    },
    loggerProvider,
    tracerProvider,
    uploader: input.uploader,
  };
}

export function createAcpRelayLogRecordExporter(
  uploader: AcpRelayLogUploader,
): LogRecordExporter {
  return {
    export(logRecords, callback) {
      for (const record of logRecords) {
        uploader.emit(serializeLogRecord(record));
      }
      callback({ code: 0 } as never);
    },
    async forceFlush() {
      await uploader.flush();
    },
    async shutdown() {
      await uploader.flush();
    },
  };
}

export function createAcpRelaySpanExporter(
  uploader: AcpRelayLogUploader,
): SpanExporter {
  return {
    export(spans, callback) {
      for (const span of spans) {
        uploader.emit(serializeSpan(span));
      }
      callback({ code: 0 } as never);
    },
    async forceFlush() {
      await uploader.flush();
    },
    async shutdown() {
      await uploader.flush();
    },
  };
}

class RelayLogUploader implements AcpRelayLogUploader {
  private readonly accountSession: string;
  private readonly batchSize: number;
  private readonly context: Record<string, unknown> | undefined;
  private readonly endpointUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly flushIntervalMs: number;
  private readonly maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES;
  private readonly onError: (error: unknown) => void;
  private readonly source: string;
  private accepting = true;
  private flushPromise: Promise<void> | undefined;
  private queue: AcpRelayLogUploadRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: AcpRelayLogUploaderOptions) {
    this.accountSession = options.accountSession;
    this.batchSize = positiveOrDefault(options.batchSize, DEFAULT_MAX_BATCH_SIZE);
    this.context = options.context;
    this.endpointUrl = String(options.endpointUrl);
    this.fetchImpl = options.fetch ?? fetch;
    this.flushIntervalMs = positiveOrDefault(
      options.flushIntervalMs,
      DEFAULT_FLUSH_INTERVAL_MS,
    );
    this.onError = options.onError ?? (() => {});
    this.source = options.source;
  }

  emit(record: AcpRelayLogUploadRecord): void {
    if (!this.accepting) {
      return;
    }
    this.queue.push(sanitizeRecord(record));
    if (this.queue.length >= this.batchSize) {
      void this.flush();
      return;
    }
    this.scheduleFlush();
  }

  writeText(
    message: string,
    attributes?: Record<string, unknown>,
    options?: AcpRelayLogTextOptions,
  ): void {
    const spanContext = trace.getActiveSpan()?.spanContext();
    this.emit({
      attributes,
      body: message,
      eventName: "acp.relay.local_log",
      kind: "text",
      observedAt: new Date().toISOString(),
      severityText: options?.severityText ?? "INFO",
      ...(spanContext && isSpanContextValid(spanContext)
        ? {
            spanContext,
            spanId: options?.spanId ?? spanContext.spanId,
            traceId: options?.traceId ?? spanContext.traceId,
          }
        : {
            spanId: options?.spanId,
            traceId: options?.traceId,
          }),
    });
  }

  flush(): Promise<void> {
    if (this.flushPromise) {
      return this.flushPromise;
    }
    this.clearTimer();
    this.flushPromise = this.flushLoop().finally(() => {
      this.flushPromise = undefined;
    });
    return this.flushPromise;
  }

  async close(): Promise<void> {
    this.accepting = false;
    this.clearTimer();
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.timer || !this.accepting) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async flushLoop(): Promise<void> {
    while (this.queue.length > 0) {
      const records = this.queue.splice(0, this.batchSize);
      try {
        await this.post(records);
      } catch (error) {
        this.queue.unshift(...records);
        this.onError(error);
        if (this.accepting) {
          this.scheduleFlush();
        }
        return;
      }
    }
  }

  private async post(records: readonly AcpRelayLogUploadRecord[]): Promise<void> {
    if (records.length > 1 && this.payloadByteLength(records) > this.maxPayloadBytes) {
      const midpoint = Math.ceil(records.length / 2);
      await this.post(records.slice(0, midpoint));
      await this.post(records.slice(midpoint));
      return;
    }
    const payload: AcpRelayLogUploadPayload = {
      context: this.context ? toJsonSafe(this.context) as Record<string, unknown> : undefined,
      records,
      source: this.source,
      version: 1,
    };
    const response = await this.fetchImpl(this.endpointUrl, {
      body: JSON.stringify(payload),
      headers: {
        authorization: `Bearer ${this.accountSession}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(
        `ACP relay log upload failed: ${response.status} ${response.statusText}`,
      );
    }
  }

  private payloadByteLength(
    records: readonly AcpRelayLogUploadRecord[],
  ): number {
    return Buffer.byteLength(
      JSON.stringify({
        context: this.context
          ? toJsonSafe(this.context) as Record<string, unknown>
          : undefined,
        records,
        source: this.source,
        version: 1,
      } satisfies AcpRelayLogUploadPayload),
      "utf8",
    );
  }
}

function serializeLogRecord(record: ReadableLogRecord): AcpRelayLogUploadRecord {
  const traceFields = extractTraceFields(record.spanContext);
  return sanitizeRecord({
    attributes: toJsonSafe(record.attributes) as Record<string, unknown> | undefined,
    body: toJsonSafe(record.body),
    eventName: record.eventName,
    kind: "otel_log",
    observedAt: hrTimeToIso(record.hrTimeObserved ?? record.hrTime),
    record: toJsonSafe({
      hrTime: record.hrTime,
      hrTimeObserved: record.hrTimeObserved,
      instrumentationScope: record.instrumentationScope,
    }),
    severityNumber: record.severityNumber,
    severityText: record.severityText,
    ...traceFields,
    spanContext: toJsonSafe(record.spanContext),
  });
}

function serializeSpan(span: ReadableSpan): AcpRelayLogUploadRecord {
  const spanContext = span.spanContext();
  return sanitizeRecord({
    attributes: toJsonSafe(span.attributes) as Record<string, unknown> | undefined,
    eventName: span.name,
    kind: "otel_span",
    observedAt: hrTimeToIso(span.endTime),
    record: toJsonSafe({
      droppedAttributesCount: span.droppedAttributesCount,
      droppedEventsCount: span.droppedEventsCount,
      droppedLinksCount: span.droppedLinksCount,
      duration: span.duration,
      ended: span.ended,
      events: span.events,
      instrumentationLibrary: span.instrumentationLibrary,
      kind: span.kind,
      links: span.links,
      name: span.name,
      parentSpanId: span.parentSpanId,
      resource: span.resource?.attributes,
      startTime: span.startTime,
      status: span.status,
    }),
    spanContext: toJsonSafe(spanContext),
    spanId: spanContext.spanId,
    traceId: spanContext.traceId,
  });
}

function sanitizeRecord(
  record: AcpRelayLogUploadRecord,
): AcpRelayLogUploadRecord {
  const traceFields = extractTraceFields(record.spanContext);
  const sanitized = {
    ...record,
    attributes: record.attributes
      ? toJsonSafe(record.attributes) as Record<string, unknown>
      : undefined,
    body: toJsonSafe(record.body),
    record: toJsonSafe(record.record),
    spanContext: toJsonSafe(record.spanContext),
    spanId: record.spanId ?? traceFields.spanId,
    traceId: record.traceId ?? traceFields.traceId,
  };
  if (recordByteLength(sanitized) <= DEFAULT_MAX_RECORD_BYTES) {
    return sanitized;
  }
  return {
    attributes: sanitized.attributes,
    body: truncateJsonValue(sanitized.body, DEFAULT_MAX_RECORD_BYTES / 2),
    eventName: sanitized.eventName,
    kind: sanitized.kind,
    observedAt: sanitized.observedAt,
    record: "[Truncated]",
    severityNumber: sanitized.severityNumber,
    severityText: sanitized.severityText,
    spanId: sanitized.spanId,
    traceId: sanitized.traceId,
  };
}

function recordByteLength(record: AcpRelayLogUploadRecord): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8");
}

function truncateJsonValue(value: unknown, maxLength: number): unknown {
  if (typeof value === "string") {
    return truncateString(value, maxLength);
  }
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxLength) {
    return value;
  }
  return `${serialized.slice(0, Math.max(0, maxLength - 15))}[Truncated]`;
}

function extractTraceFields(value: unknown): {
  spanId?: string;
  traceId?: string;
} {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const record = value as Record<string, unknown>;
  return {
    spanId: typeof record.spanId === "string" ? record.spanId : undefined,
    traceId: typeof record.traceId === "string" ? record.traceId : undefined,
  };
}

function hrTimeToIso(hrTime: readonly [number, number] | undefined): string {
  if (!hrTime) {
    return new Date().toISOString();
  }
  const millis = hrTime[0] * 1000 + Math.floor(hrTime[1] / 1_000_000);
  return new Date(millis).toISOString();
}

function isDisabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off";
}

function readPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function toJsonSafe(value: unknown, depth = 0): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return truncateString(value, MAX_SAFE_STRING_LENGTH);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
      stack: value.stack,
    };
  }
  if (depth >= MAX_SAFE_JSON_DEPTH) {
    return "[MaxDepth]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toJsonSafe(entry, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = toJsonSafe(entry, depth + 1);
    }
    return output;
  }
  return String(value);
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 15))}[Truncated]`;
}
