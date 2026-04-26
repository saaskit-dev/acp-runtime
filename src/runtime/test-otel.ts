import { trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

type OTelHarness = {
  logExporter: InMemoryLogRecordExporter;
  loggerProvider: LoggerProvider;
  exporter: InMemorySpanExporter;
  provider: BasicTracerProvider;
};

const globalHarness = globalThis as typeof globalThis & {
  __acpRuntimeTestOtelHarness?: OTelHarness;
};

if (!globalHarness.__acpRuntimeTestOtelHarness) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  trace.setGlobalTracerProvider(provider);
  const logExporter = new InMemoryLogRecordExporter();
  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor(logExporter)],
  });
  logs.setGlobalLoggerProvider(loggerProvider);
  globalHarness.__acpRuntimeTestOtelHarness = {
    exporter,
    logExporter,
    loggerProvider,
    provider,
  };
}

export const testSpanExporter = globalHarness.__acpRuntimeTestOtelHarness.exporter;
export const testTracerProvider = globalHarness.__acpRuntimeTestOtelHarness.provider;
export const testLogExporter = globalHarness.__acpRuntimeTestOtelHarness.logExporter;
export const testLoggerProvider = globalHarness.__acpRuntimeTestOtelHarness.loggerProvider;
