import {
  context,
  isSpanContextValid,
  propagation,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type SpanOptions,
} from "@opentelemetry/api";

import type {
  AcpRuntimeAgent,
  AcpRuntimeOperation,
  AcpRuntimeObservabilityOptions,
  AcpRuntimeObservabilityRedactionContext,
  AcpRuntimePermissionRequest,
  AcpRuntimePrompt,
  AcpRuntimeUsage,
} from "../core/types.js";

export const ACP_RUNTIME_TRACER_NAME = "@saaskit-dev/acp-runtime";

const tracer = trace.getTracer(ACP_RUNTIME_TRACER_NAME);

export const DEFAULT_OBSERVABILITY_OPTIONS = {
  captureContent: "full",
} as const satisfies Required<Pick<AcpRuntimeObservabilityOptions, "captureContent">>;

type MetaCarrierParams = {
  _meta?: Record<string, unknown> | null;
};

function compactAttributes(
  attributes: Attributes | undefined,
): Attributes | undefined {
  if (!attributes) {
    return undefined;
  }

  const compacted = Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined),
  );
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

export function createSpanContext(
  span: Span,
  parentContext: Context = context.active(),
): Context {
  return trace.setSpan(parentContext, span);
}

export function resolveObservabilityOptions(
  options: AcpRuntimeObservabilityOptions | undefined,
): Required<Pick<AcpRuntimeObservabilityOptions, "captureContent">> &
  Pick<AcpRuntimeObservabilityOptions, "redact"> {
  return {
    captureContent:
      options?.captureContent ?? DEFAULT_OBSERVABILITY_OPTIONS.captureContent,
    redact: options?.redact,
  };
}

export async function withSpan<T>(
  name: string,
  options: {
    attributes?: Attributes;
    parentContext?: Context;
    spanOptions?: SpanOptions;
  },
  callback: (span: Span, spanContext: Context) => Promise<T>,
): Promise<T> {
  const parentContext = options.parentContext ?? context.active();
  const span = tracer.startSpan(
    name,
    {
      ...options.spanOptions,
      attributes: compactAttributes(options.attributes),
    },
    parentContext,
  );
  const spanContext = createSpanContext(span, parentContext);

  try {
    const result = await callback(span, spanContext);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    recordException(span, error);
    throw error;
  } finally {
    span.end();
  }
}

export function buildTraceMeta(
  spanOrContext: Context | Span = context.active(),
): Record<string, unknown> | undefined {
  const spanContext =
    typeof (spanOrContext as Span).spanContext === "function"
      ? createSpanContext(spanOrContext as Span)
      : (spanOrContext as Context);
  const carrier: Record<string, string> = {};
  const span = trace.getSpan(spanContext);
  const state = span?.spanContext();
  if (state && isSpanContextValid(state)) {
    carrier.traceparent = [
      "00",
      state.traceId,
      state.spanId,
      state.traceFlags.toString(16).padStart(2, "0"),
    ].join("-");
    const traceState = state.traceState?.serialize();
    if (traceState) {
      carrier.tracestate = traceState;
    }
  }
  const baggage = propagation.getBaggage(spanContext);
  if (baggage) {
    const entries = baggage.getAllEntries();
    if (entries.length > 0) {
      carrier.baggage = entries
        .map(([key, entry]) => `${encodeURIComponent(key)}=${encodeURIComponent(entry.value)}`)
        .join(",");
    }
  }
  return Object.keys(carrier).length > 0 ? carrier : undefined;
}

export function mergeTraceMeta<T extends Record<string, unknown>>(
  params: T & MetaCarrierParams,
  spanOrContext: Context | Span = context.active(),
): T & MetaCarrierParams {
  const traceMeta = buildTraceMeta(spanOrContext);
  if (!traceMeta) {
    return params;
  }

  return {
    ...params,
    _meta: {
      ...(params._meta ?? {}),
      ...traceMeta,
    },
  };
}

export function recordException(span: Span, error: unknown): void {
  if (!span.isRecording()) {
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  span.recordException(
    error instanceof Error ? error : new Error(message),
  );
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message,
  });
}

export function sessionAttributes(input: {
  action: "fork" | "list" | "load" | "resume" | "start";
  agent: AcpRuntimeAgent;
  cwd: string;
  sessionId?: string;
  reused?: boolean;
}): Attributes {
  return compactAttributes({
    "acp.agent.command": input.agent.command,
    "acp.agent.type": input.agent.type,
    "acp.session.action": input.action,
    "acp.session.cwd": input.cwd,
    "acp.session.id": input.sessionId,
    "acp.session.reused": input.reused,
  })!;
}

export function promptAttributes(prompt: AcpRuntimePrompt): Attributes {
  if (typeof prompt === "string") {
    return {
      "acp.prompt.kind": "string",
      "acp.prompt.text_length": prompt.length,
    };
  }

  if (!Array.isArray(prompt)) {
    return {
      "acp.prompt.kind": "unknown",
    };
  }

  const first = prompt[0];
  if (first && typeof first === "object" && "role" in first) {
    return {
      "acp.prompt.kind": "messages",
      "acp.prompt.message_count": prompt.length,
    };
  }

  return {
    "acp.prompt.kind": "parts",
    "acp.prompt.part_count": prompt.length,
  };
}

export function operationAttributes(operation: AcpRuntimeOperation): Attributes {
  return compactAttributes({
    "acp.operation.id": operation.id,
    "acp.operation.kind": operation.kind,
    "acp.operation.phase": operation.phase,
    "acp.operation.target.type": operation.target?.type,
    "acp.operation.target.value": operation.target?.value,
    "acp.operation.title": operation.title,
  })!;
}

export function permissionAttributes(
  request: AcpRuntimePermissionRequest,
): Attributes {
  return compactAttributes({
    "acp.operation.id": request.operationId,
    "acp.permission.id": request.id,
    "acp.permission.kind": request.kind,
    "acp.permission.phase": request.phase,
    "acp.permission.title": request.title,
  })!;
}

export function usageAttributes(usage: AcpRuntimeUsage): Attributes {
  return compactAttributes({
    "acp.usage.cached_read_tokens": usage.cachedReadTokens,
    "acp.usage.cached_write_tokens": usage.cachedWriteTokens,
    "acp.usage.context_used_tokens": usage.contextUsedTokens,
    "acp.usage.context_window_tokens": usage.contextWindowTokens,
    "acp.usage.cost_usd": usage.costUsd,
    "acp.usage.input_tokens": usage.inputTokens,
    "acp.usage.output_tokens": usage.outputTokens,
    "acp.usage.thought_tokens": usage.thoughtTokens,
    "acp.usage.total_tokens": usage.totalTokens,
  })!;
}

export function childSpan(
  name: string,
  parentContext: Context,
  attributes?: Attributes,
): { context: Context; span: Span } {
  const span = tracer.startSpan(
    name,
    {
      attributes: compactAttributes(attributes),
    },
    parentContext,
  );
  return {
    context: createSpanContext(span, parentContext),
    span,
  };
}

function summarizeText(value: string): string {
  return value.length <= 240 ? value : `${value.slice(0, 240)}…`;
}

function serializeObservedValue(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function prepareObservedValue(
  value: unknown,
  options: ReturnType<typeof resolveObservabilityOptions>,
  redactContext: AcpRuntimeObservabilityRedactionContext,
): string | undefined {
  if (options.captureContent === "none") {
    return undefined;
  }

  const redacted = options.redact ? options.redact(value, redactContext) : value;
  const serialized = serializeObservedValue(redacted);
  if (serialized === undefined) {
    return undefined;
  }

  return options.captureContent === "summary"
    ? summarizeText(serialized)
    : serialized;
}

export function captureContentAttribute(input: {
  key: string;
  options: ReturnType<typeof resolveObservabilityOptions>;
  redactContext: AcpRuntimeObservabilityRedactionContext;
  span: Span;
  value: unknown;
}): void {
  const prepared = prepareObservedValue(
    input.value,
    input.options,
    input.redactContext,
  );
  if (prepared !== undefined) {
    input.span.setAttribute(input.key, prepared);
  }
}

export function captureContentEvent(input: {
  eventName: string;
  extraAttributes?: Attributes;
  options: ReturnType<typeof resolveObservabilityOptions>;
  redactContext: AcpRuntimeObservabilityRedactionContext;
  span: Span;
  value: unknown;
}): void {
  const prepared = prepareObservedValue(
    input.value,
    input.options,
    input.redactContext,
  );
  if (prepared === undefined) {
    return;
  }

  input.span.addEvent(input.eventName, compactAttributes({
    ...input.extraAttributes,
    "acp.content.kind": input.redactContext.kind,
    "acp.content.value": prepared,
  }));
}
