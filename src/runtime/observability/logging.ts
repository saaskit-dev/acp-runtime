import {
  SeverityNumber,
  logs,
  type LogAttributes,
  type LogBody,
} from "@opentelemetry/api-logs";
import type { Context } from "@opentelemetry/api";

import type {
  AcpRuntimeObservabilityOptions,
  AcpRuntimeObservabilityRedactionContext,
} from "../core/types.js";
import {
  ACP_RUNTIME_TRACER_NAME,
  prepareObservedValue,
  resolveObservabilityOptions,
} from "./tracing.js";

export const ACP_RUNTIME_LOGGER_NAME = ACP_RUNTIME_TRACER_NAME;

const logger = logs.getLogger(ACP_RUNTIME_LOGGER_NAME);

function compactAttributes(
  attributes: LogAttributes | undefined,
): LogAttributes | undefined {
  if (!attributes) {
    return undefined;
  }

  const compacted = Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined),
  );
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function severityText(number: SeverityNumber): string {
  switch (number) {
    case SeverityNumber.DEBUG:
    case SeverityNumber.DEBUG2:
    case SeverityNumber.DEBUG3:
    case SeverityNumber.DEBUG4:
      return "DEBUG";
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
    case SeverityNumber.FATAL:
    case SeverityNumber.FATAL2:
    case SeverityNumber.FATAL3:
    case SeverityNumber.FATAL4:
      return "FATAL";
    case SeverityNumber.TRACE:
    case SeverityNumber.TRACE2:
    case SeverityNumber.TRACE3:
    case SeverityNumber.TRACE4:
      return "TRACE";
    default:
      return "INFO";
  }
}

function normalizeLogBody(body: unknown): LogBody | undefined {
  if (body === undefined) {
    return undefined;
  }
  if (
    body === null
    || typeof body === "string"
    || typeof body === "number"
    || typeof body === "boolean"
  ) {
    return body;
  }
  if (Array.isArray(body) || typeof body === "object") {
    return body as LogBody;
  }
  return String(body);
}

export function emitRuntimeLog(input: {
  attributes?: LogAttributes;
  body?: unknown;
  context?: Context;
  eventName: string;
  exception?: unknown;
  severityNumber?: SeverityNumber;
}): void {
  const severityNumber = input.severityNumber ?? SeverityNumber.INFO;
  if (!isRuntimeLogEnabled({
    context: input.context,
    eventName: input.eventName,
    severityNumber,
  })) {
    return;
  }

  logger.emit({
    attributes: compactAttributes(input.attributes),
    body: normalizeLogBody(input.body),
    context: input.context,
    eventName: input.eventName,
    exception: input.exception,
    severityNumber,
    severityText: severityText(severityNumber),
  });
}

export function isRuntimeLogEnabled(input: {
  context?: Context;
  eventName: string;
  severityNumber?: SeverityNumber;
}): boolean {
  return logger.enabled({
    context: input.context,
    eventName: input.eventName,
    severityNumber: input.severityNumber ?? SeverityNumber.INFO,
  });
}

export function observedLogBody(input: {
  options: AcpRuntimeObservabilityOptions | ReturnType<typeof resolveObservabilityOptions> | undefined;
  redactContext: AcpRuntimeObservabilityRedactionContext;
  value: unknown;
}): string | undefined {
  const options = "captureContent" in (input.options ?? {})
    && "redact" in (input.options ?? {})
    ? (input.options as ReturnType<typeof resolveObservabilityOptions>)
    : resolveObservabilityOptions(input.options as AcpRuntimeObservabilityOptions | undefined);
  return prepareObservedValue(input.value, options, input.redactContext);
}
