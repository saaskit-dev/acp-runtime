import { mkdir } from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import { basename, dirname, join } from "node:path";
import { format } from "node:util";
import { trace } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
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

const RUNTIME_CLI_LOG_CATEGORIES = [
  "errors",
  "events",
  "spans",
  "text",
] as const;

type RuntimeCliLogCategory = (typeof RUNTIME_CLI_LOG_CATEGORIES)[number];

export type RuntimeCliLogSink = {
  categoryLogFiles?: Record<RuntimeCliLogCategory, string>;
  rawLogFile?: string;
  sessionCategoryLogFiles?: Record<RuntimeCliLogCategory, string>;
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

export type ConfigureRuntimeCliLogSinkOptions = {
  capture?: boolean;
};

export async function configureRuntimeCliLogSink(
  logFile: string | undefined,
  options: ConfigureRuntimeCliLogSinkOptions = {},
): Promise<RuntimeCliLogSink> {
  if (!logFile && options.capture !== true) {
    return {
      async attachSession() {},
      writeLine() {},
      emit() {},
      async close() {},
    };
  }

  const target = logFile ? createRuntimeCliLogTarget(logFile) : undefined;
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
  let sessionCategoryLogFiles: Record<RuntimeCliLogCategory, string> | undefined;
  let sessionStream: WriteStream | undefined;
  let sessionRawStream: WriteStream | undefined;
  let sessionCategoryStreams: Record<RuntimeCliLogCategory, WriteStream> | undefined;
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
    category: RuntimeCliLogCategory,
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
  const loggerProvider = new LoggerProvider({
    processors,
  });
  logs.setGlobalLoggerProvider(loggerProvider);
  const tracerProvider = target ? new BasicTracerProvider() : undefined;
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
    trace.setGlobalTracerProvider(tracerProvider);
  }
  const runtimeCliLogger = loggerProvider.getLogger("@saaskit-dev/acp-runtime/runtime-cli");

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
      ? `[runtime] classified log views: ${Object.values(target.categoryLogFiles).join(", ")}`
      : undefined,
    target
      ? "[runtime] note: classified logs are derived views of the raw jsonl stream."
      : undefined,
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
      for (const category of RUNTIME_CLI_LOG_CATEGORIES) {
        for (const chunk of pendingCategoryChunks[category]) {
          sessionCategoryStreams[category].write(chunk);
        }
      }
      pendingHumanChunks = [];
      pendingRawChunks = [];
      pendingCategoryChunks = createCategoryChunkBuffer();

      for (const line of [
        `[runtime] session log mirror: ${sessionLogFile}`,
        `[runtime] session raw log mirror: ${sessionRawLogFile}`,
        `[runtime] session classified log mirrors: ${Object.values(sessionCategoryLogFiles).join(", ")}`,
        "[runtime] note: session logs mirror the global runtime log for this session.",
      ]) {
        originalLog(line);
        writeToLog(line);
      }
    },
    writeLine: writeToLog,
    emit(input) {
      const severityNumber = input.severityNumber ?? SeverityNumber.INFO;
      runtimeCliLogger.emit({
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

function createRuntimeCliLogTarget(logFile: string): {
  categoryLogFiles: Record<RuntimeCliLogCategory, string>;
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
): Record<RuntimeCliLogCategory, string> {
  return Object.fromEntries(
    RUNTIME_CLI_LOG_CATEGORIES.map((category) => [
      category,
      `${logFile}.${category}.jsonl`,
    ]),
  ) as Record<RuntimeCliLogCategory, string>;
}

function createCategoryStreams(
  files: Record<RuntimeCliLogCategory, string>,
): Record<RuntimeCliLogCategory, WriteStream> {
  return Object.fromEntries(
    RUNTIME_CLI_LOG_CATEGORIES.map((category) => [
      category,
      createWriteStream(files[category], { flags: "w" }),
    ]),
  ) as Record<RuntimeCliLogCategory, WriteStream>;
}

function createCategoryChunkBuffer(): Record<RuntimeCliLogCategory, string[]> {
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
