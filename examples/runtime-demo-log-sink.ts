import { mkdir } from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import { basename, dirname, join } from "node:path";
import { format } from "node:util";
import { trace } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import {
  createAcpRelayLogRecordExporter,
  createAcpRelayLogUploaderFromEnv,
  createAcpRelaySpanExporter,
  type AcpRelayLogUploader,
} from "@saaskit-dev/acp-runtime";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import type {
  ReadableSpan,
  SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

const DEMO_LOG_CATEGORIES = [
  "errors",
  "events",
  "spans",
  "text",
] as const;

type DemoLogCategory = (typeof DEMO_LOG_CATEGORIES)[number];

export type DemoLogSink = {
  categoryLogFiles?: Record<DemoLogCategory, string>;
  rawLogFile?: string;
  sessionCategoryLogFiles?: Record<DemoLogCategory, string>;
  sessionLogFile?: string;
  sessionRawLogFile?: string;
  attachSession(sessionId: string): Promise<void>;
  writeLine(line: string): void;
  emit(input: {
    attributes?: Record<string, unknown>;
    body?: unknown;
    eventName: string;
    exception?: unknown;
    severityNumber?: SeverityNumber;
  }): void;
  close(): Promise<void>;
};

export type ConfigureDemoLogSinkOptions = {
  relayContext?: Record<string, unknown>;
  relaySource?: string;
  relayUploader?: AcpRelayLogUploader | false;
};

export async function configureDemoLogSink(
  logFile: string | undefined,
  options: ConfigureDemoLogSinkOptions = {},
): Promise<DemoLogSink> {
  const relayUploader = resolveRelayLogUploader(logFile, options);
  if (!logFile && !relayUploader) {
    return {
      async attachSession() {},
      writeLine() {},
      emit() {},
      async close() {},
    };
  }

  const target = logFile ? createDemoLogTarget(logFile) : undefined;
  if (target) {
    await mkdir(dirname(target.logFile), { recursive: true });
    await mkdir(dirname(target.rawLogFile), { recursive: true });
    if (target.sessionRoot) {
      await mkdir(target.sessionRoot, { recursive: true });
    }
  }
  const stream = target
    ? createWriteStream(target.logFile, { flags: "w" })
    : undefined;
  const rawStream = target
    ? createWriteStream(target.rawLogFile, { flags: "w" })
    : undefined;
  const categoryStreams = target
    ? createCategoryStreams(target.categoryLogFiles)
    : undefined;
  let sessionLogFile: string | undefined;
  let sessionRawLogFile: string | undefined;
  let sessionCategoryLogFiles: Record<DemoLogCategory, string> | undefined;
  let sessionStream: WriteStream | undefined;
  let sessionRawStream: WriteStream | undefined;
  let sessionCategoryStreams: Record<DemoLogCategory, WriteStream> | undefined;
  let pendingHumanChunks: string[] = [];
  let pendingRawChunks: string[] = [];
  let pendingCategoryChunks = createCategoryChunkBuffer();
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  const writeHumanChunk = (chunk: string): void => {
    stream?.write(chunk);
    if (sessionStream) {
      sessionStream.write(chunk);
      return;
    }
    if (target?.sessionRoot) {
      pendingHumanChunks.push(chunk);
    }
  };
  const writeRawChunk = (chunk: string): void => {
    rawStream?.write(chunk);
    if (sessionRawStream) {
      sessionRawStream.write(chunk);
      return;
    }
    if (target?.sessionRoot) {
      pendingRawChunks.push(chunk);
    }
  };
  const writeCategoryChunk = (
    category: DemoLogCategory,
    chunk: string,
  ): void => {
    categoryStreams?.[category].write(chunk);
    if (sessionCategoryStreams) {
      sessionCategoryStreams[category].write(chunk);
      return;
    }
    if (target?.sessionRoot) {
      pendingCategoryChunks[category].push(chunk);
    }
  };
  const processors: SimpleLogRecordProcessor[] = [];
  if (target) {
    processors.push(
      new SimpleLogRecordProcessor({
        export(logRecords, callback) {
          for (const record of logRecords) {
            const serialized = serializeReadableLogRecord(record);
            const chunk = `${JSON.stringify(serialized)}\n`;
            writeRawChunk(chunk);
            writeCategoryChunk("events", chunk);
            if (isErrorLikeLogRecord(record)) {
              writeCategoryChunk("errors", chunk);
            }
          }
          callback({ code: 0 } as never);
        },
        async forceFlush() {},
        async shutdown() {},
      }),
    );
  }
  if (relayUploader) {
    processors.push(
      new SimpleLogRecordProcessor(
        createAcpRelayLogRecordExporter(relayUploader),
      ),
    );
  }
  const loggerProvider = new LoggerProvider({
    processors,
  });
  logs.setGlobalLoggerProvider(loggerProvider);
  const tracerProvider = relayUploader || target
    ? new BasicTracerProvider()
    : undefined;
  if (tracerProvider) {
    if (target) {
      tracerProvider.addSpanProcessor(
        new SimpleSpanProcessor(
          createLocalSpanExporter((span) => {
            writeCategoryChunk(
              "spans",
              `${JSON.stringify(serializeReadableSpan(span))}\n`,
            );
          }),
        ),
      );
    }
    if (relayUploader) {
      tracerProvider.addSpanProcessor(
        new SimpleSpanProcessor(createAcpRelaySpanExporter(relayUploader)),
      );
    }
    trace.setGlobalTracerProvider(tracerProvider);
  }
  const demoLogger = loggerProvider.getLogger("@saaskit-dev/acp-runtime/demo");

  const writeToLog = (
    line: string,
    severityText: "ERROR" | "INFO" = "INFO",
  ): void => {
    const cleanLine = stripAnsiCodes(line);
    writeHumanChunk(`${cleanLine}\n`);
    const chunk = `${JSON.stringify({
      body: cleanLine,
      kind: "text",
      observedAt: new Date().toISOString(),
      severityText,
    })}\n`;
    writeCategoryChunk("text", chunk);
    if (severityText === "ERROR") {
      writeCategoryChunk("errors", chunk);
    }
    relayUploader?.writeText(cleanLine, {
      "acp.runtime.component": "runtime-demo",
    });
  };

  console.log = (...args: unknown[]) => {
    originalLog(...args);
    writeToLog(format(...args));
  };

  console.error = (...args: unknown[]) => {
    originalError(...args);
    writeToLog(format(...args), "ERROR");
  };

  const startupLines = [
    target ? `[runtime] log file: ${target.logFile}` : undefined,
    target ? `[runtime] raw log file: ${target.rawLogFile}` : undefined,
    target
      ? `[runtime] classified logs: ${Object.values(target.categoryLogFiles).join(", ")}`
      : undefined,
    relayUploader ? "[runtime] relay log upload enabled" : undefined,
  ].filter((line): line is string => Boolean(line));
  for (const line of startupLines) {
    originalLog(line);
    writeToLog(line);
  }

  return {
    categoryLogFiles: target?.categoryLogFiles,
    rawLogFile: target?.rawLogFile,
    get sessionCategoryLogFiles() {
      return sessionCategoryLogFiles;
    },
    get sessionLogFile() {
      return sessionLogFile;
    },
    get sessionRawLogFile() {
      return sessionRawLogFile;
    },
    async attachSession(sessionId: string) {
      if (!target?.sessionRoot || sessionStream || sessionRawStream) {
        return;
      }

      const sessionDir = join(target.sessionRoot, sanitizePathSegment(sessionId));
      await mkdir(sessionDir, { recursive: true });
      sessionLogFile = join(sessionDir, "runtime.log");
      sessionRawLogFile = join(sessionDir, "runtime.log.jsonl");
      sessionCategoryLogFiles = createCategoryLogFiles(sessionLogFile);
      sessionStream = createWriteStream(sessionLogFile, { flags: "w" });
      sessionRawStream = createWriteStream(sessionRawLogFile, { flags: "w" });
      sessionCategoryStreams = createCategoryStreams(sessionCategoryLogFiles);

      for (const chunk of pendingHumanChunks) {
        sessionStream.write(chunk);
      }
      for (const chunk of pendingRawChunks) {
        sessionRawStream.write(chunk);
      }
      for (const category of DEMO_LOG_CATEGORIES) {
        for (const chunk of pendingCategoryChunks[category]) {
          sessionCategoryStreams[category].write(chunk);
        }
      }
      pendingHumanChunks = [];
      pendingRawChunks = [];
      pendingCategoryChunks = createCategoryChunkBuffer();

      for (const line of [
        `[runtime] session log file: ${sessionLogFile}`,
        `[runtime] session raw log file: ${sessionRawLogFile}`,
        `[runtime] session classified logs: ${Object.values(sessionCategoryLogFiles).join(", ")}`,
      ]) {
        originalLog(line);
        writeToLog(line);
      }
    },
    writeLine: writeToLog,
    emit(input) {
      const severityNumber = input.severityNumber ?? SeverityNumber.INFO;
      demoLogger.emit({
        attributes: input.attributes as never,
        body: input.body as never,
        eventName: input.eventName,
        exception: input.exception,
        severityNumber,
        severityText: formatSeverityText(severityNumber),
      });
    },
    async close() {
      console.log = originalLog;
      console.error = originalError;
      await loggerProvider.forceFlush();
      await tracerProvider?.forceFlush();
      await loggerProvider.shutdown();
      await tracerProvider?.shutdown();
      await relayUploader?.close();
      await Promise.all([
        ...uniqueStreams([
          stream,
          rawStream,
          sessionStream,
          sessionRawStream,
          ...Object.values(categoryStreams ?? {}),
          ...Object.values(sessionCategoryStreams ?? {}),
        ]).map(endStream),
      ]);
    },
  };
}

function resolveRelayLogUploader(
  logFile: string | undefined,
  options: ConfigureDemoLogSinkOptions,
): AcpRelayLogUploader | undefined {
  if (options.relayUploader === false) {
    return undefined;
  }
  if (options.relayUploader) {
    return options.relayUploader;
  }
  const context = compactRecord({
    ...options.relayContext,
    "acp.runtime.log_file": logFile,
  });
  return createAcpRelayLogUploaderFromEnv({
    context,
    onError(error) {
      process.stderr.write(
        `[runtime] relay log upload failed: ${formatError(error)}\n`,
      );
    },
    source: options.relaySource ?? "runtime-demo",
  });
}

function createDemoLogTarget(logFile: string): {
  categoryLogFiles: Record<DemoLogCategory, string>;
  logFile: string;
  rawLogFile: string;
  sessionRoot?: string;
} {
  const rawLogFile = `${logFile}.jsonl`;
  const categoryLogFiles = createCategoryLogFiles(logFile);
  if (basename(logFile) !== "runtime.log") {
    return {
      categoryLogFiles,
      logFile,
      rawLogFile,
    };
  }

  return {
    categoryLogFiles,
    logFile,
    rawLogFile,
    sessionRoot: join(dirname(logFile), "sessions"),
  };
}

function createCategoryLogFiles(
  logFile: string,
): Record<DemoLogCategory, string> {
  return Object.fromEntries(
    DEMO_LOG_CATEGORIES.map((category) => [
      category,
      `${logFile}.${category}.jsonl`,
    ]),
  ) as Record<DemoLogCategory, string>;
}

function createCategoryStreams(
  files: Record<DemoLogCategory, string>,
): Record<DemoLogCategory, WriteStream> {
  return Object.fromEntries(
    DEMO_LOG_CATEGORIES.map((category) => [
      category,
      createWriteStream(files[category], { flags: "w" }),
    ]),
  ) as Record<DemoLogCategory, WriteStream>;
}

function createCategoryChunkBuffer(): Record<DemoLogCategory, string[]> {
  return {
    errors: [],
    events: [],
    spans: [],
    text: [],
  };
}

function uniqueStreams(
  streams: readonly (WriteStream | undefined)[],
): WriteStream[] {
  return [...new Set(streams.filter((stream): stream is WriteStream => Boolean(stream)))];
}

function endStream(stream: WriteStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stream.end((error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function stripAnsiCodes(input: string): string {
  return input.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function sanitizePathSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown-session";
}

function formatSeverityText(
  severityNumber: SeverityNumber | undefined,
): string | undefined {
  switch (severityNumber) {
    case SeverityNumber.WARN:
    case SeverityNumber.WARN2:
    case SeverityNumber.WARN3:
    case SeverityNumber.WARN4:
      return "WARN";
    case SeverityNumber.ERROR:
    case SeverityNumber.ERROR2:
    case SeverityNumber.ERROR3:
    case SeverityNumber.ERROR4:
      return "ERROR";
    default:
      return severityNumber === undefined ? undefined : "INFO";
  }
}

function compactRecord(
  input: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function serializeReadableLogRecord(record: ReadableLogRecord): unknown {
  const traceFields = readTraceFields(record.spanContext);
  return {
    attributes: record.attributes,
    body: record.body,
    eventName: record.eventName,
    hrTime: record.hrTime,
    hrTimeObserved: record.hrTimeObserved,
    instrumentationScope: record.instrumentationScope,
    severityNumber: record.severityNumber,
    severityText: record.severityText,
    spanContext: record.spanContext,
    ...traceFields,
  };
}

function createLocalSpanExporter(
  writeSpan: (span: ReadableSpan) => void,
): SpanExporter {
  return {
    export(spans, callback) {
      for (const span of spans) {
        writeSpan(span);
      }
      callback({ code: 0 } as never);
    },
    async forceFlush() {},
    async shutdown() {},
  };
}

function serializeReadableSpan(span: ReadableSpan): unknown {
  const spanContext = span.spanContext();
  return {
    attributes: span.attributes,
    duration: span.duration,
    endTime: span.endTime,
    eventName: span.name,
    events: span.events,
    kind: "otel_span",
    links: span.links,
    parentSpanId: span.parentSpanId,
    spanContext,
    spanId: spanContext.spanId,
    startTime: span.startTime,
    status: span.status,
    traceId: spanContext.traceId,
  };
}

function isErrorLikeLogRecord(record: ReadableLogRecord): boolean {
  return (record.severityNumber ?? 0) >= SeverityNumber.WARN;
}

function readTraceFields(value: unknown): {
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
