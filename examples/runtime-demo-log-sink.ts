import { mkdir } from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import { basename, dirname, join } from "node:path";
import { format } from "node:util";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";

export type DemoLogSink = {
  rawLogFile?: string;
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

export async function configureDemoLogSink(
  logFile: string | undefined,
): Promise<DemoLogSink> {
  if (!logFile) {
    return {
      async attachSession() {},
      writeLine() {},
      emit() {},
      async close() {},
    };
  }

  const target = createDemoLogTarget(logFile);
  await mkdir(dirname(target.logFile), { recursive: true });
  await mkdir(dirname(target.rawLogFile), { recursive: true });
  if (target.sessionRoot) {
    await mkdir(target.sessionRoot, { recursive: true });
  }
  const stream = createWriteStream(target.logFile, { flags: "w" });
  const rawStream = createWriteStream(target.rawLogFile, { flags: "w" });
  let sessionLogFile: string | undefined;
  let sessionRawLogFile: string | undefined;
  let sessionStream: WriteStream | undefined;
  let sessionRawStream: WriteStream | undefined;
  let pendingHumanChunks: string[] = [];
  let pendingRawChunks: string[] = [];
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  const writeHumanChunk = (chunk: string): void => {
    stream.write(chunk);
    if (sessionStream) {
      sessionStream.write(chunk);
      return;
    }
    if (target.sessionRoot) {
      pendingHumanChunks.push(chunk);
    }
  };
  const writeRawChunk = (chunk: string): void => {
    rawStream.write(chunk);
    if (sessionRawStream) {
      sessionRawStream.write(chunk);
      return;
    }
    if (target.sessionRoot) {
      pendingRawChunks.push(chunk);
    }
  };
  const loggerProvider = new LoggerProvider({
    processors: [
      new SimpleLogRecordProcessor({
        export(logRecords, callback) {
          for (const record of logRecords) {
            writeRawChunk(`${JSON.stringify(serializeReadableLogRecord(record))}\n`);
          }
          callback({ code: 0 } as never);
        },
        async forceFlush() {},
        async shutdown() {},
      }),
    ],
  });
  logs.setGlobalLoggerProvider(loggerProvider);
  const demoLogger = loggerProvider.getLogger("@saaskit-dev/acp-runtime/demo");

  const writeToLog = (line: string): void => {
    writeHumanChunk(`${stripAnsiCodes(line)}\n`);
  };

  console.log = (...args: unknown[]) => {
    originalLog(...args);
    writeToLog(format(...args));
  };

  console.error = (...args: unknown[]) => {
    originalError(...args);
    writeToLog(format(...args));
  };

  const startupLines = [
    `[runtime] log file: ${target.logFile}`,
    `[runtime] raw log file: ${target.rawLogFile}`,
  ].filter((line): line is string => Boolean(line));
  for (const line of startupLines) {
    originalLog(line);
    writeToLog(line);
  }

  return {
    rawLogFile: target.rawLogFile,
    get sessionLogFile() {
      return sessionLogFile;
    },
    get sessionRawLogFile() {
      return sessionRawLogFile;
    },
    async attachSession(sessionId: string) {
      if (!target.sessionRoot || sessionStream || sessionRawStream) {
        return;
      }

      const sessionDir = join(target.sessionRoot, sanitizePathSegment(sessionId));
      await mkdir(sessionDir, { recursive: true });
      sessionLogFile = join(sessionDir, "runtime.log");
      sessionRawLogFile = join(sessionDir, "runtime.log.jsonl");
      sessionStream = createWriteStream(sessionLogFile, { flags: "w" });
      sessionRawStream = createWriteStream(sessionRawLogFile, { flags: "w" });

      for (const chunk of pendingHumanChunks) {
        sessionStream.write(chunk);
      }
      for (const chunk of pendingRawChunks) {
        sessionRawStream.write(chunk);
      }
      pendingHumanChunks = [];
      pendingRawChunks = [];

      for (const line of [
        `[runtime] session log file: ${sessionLogFile}`,
        `[runtime] session raw log file: ${sessionRawLogFile}`,
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
      await loggerProvider.shutdown();
      await Promise.all([
        ...uniqueStreams([
          stream,
          rawStream,
          sessionStream,
          sessionRawStream,
        ]).map(endStream),
      ]);
    },
  };
}

function createDemoLogTarget(logFile: string): {
  logFile: string;
  rawLogFile: string;
  sessionRoot?: string;
} {
  const rawLogFile = `${logFile}.jsonl`;
  if (basename(logFile) !== "runtime.log") {
    return {
      logFile,
      rawLogFile,
    };
  }

  return {
    logFile,
    rawLogFile,
    sessionRoot: join(dirname(logFile), "sessions"),
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
  };
}
