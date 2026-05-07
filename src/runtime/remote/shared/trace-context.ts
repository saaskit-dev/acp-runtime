export type AcpRemoteTraceContext = {
  spanId: string;
  traceFlags: string;
  traceId: string;
  traceparent: string;
};

const TRACEPARENT_PATTERN =
  /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export function ensureAcpRemoteTraceContext(
  message: string,
): { message: string; traceContext?: AcpRemoteTraceContext } {
  const parsed = parseJsonObject(message);
  if (!parsed || typeof parsed.method !== "string") {
    return { message };
  }

  const existing = readAcpRemoteTraceContextFromJsonRpcMessage(parsed);
  if (existing) {
    return { message, traceContext: existing };
  }

  const params =
    parsed.params === undefined
      ? {}
      : isRecord(parsed.params)
        ? parsed.params
        : undefined;
  if (!params) {
    return { message };
  }

  const traceContext = createAcpRemoteTraceContext();
  return {
    message: JSON.stringify({
      ...parsed,
      params: {
        ...params,
        _meta: {
          ...(isRecord(params._meta) ? params._meta : {}),
          traceparent: traceContext.traceparent,
        },
      },
    }),
    traceContext,
  };
}

export function readAcpRemoteTraceContextFromJsonRpcMessage(
  message: Record<string, unknown>,
): AcpRemoteTraceContext | undefined {
  const params = isRecord(message.params) ? message.params : undefined;
  const result = isRecord(message.result) ? message.result : undefined;
  return readAcpRemoteTraceContextFromMeta(params?._meta) ??
    readAcpRemoteTraceContextFromMeta(result?._meta);
}

export function readAcpRemoteTraceContextFromMeta(
  meta: unknown,
): AcpRemoteTraceContext | undefined {
  if (!isRecord(meta)) {
    return undefined;
  }
  return parseAcpRemoteTraceparent(meta.traceparent);
}

export function parseAcpRemoteTraceparent(
  value: unknown,
): AcpRemoteTraceContext | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = TRACEPARENT_PATTERN.exec(value.trim());
  if (!match || isAllZeroHex(match[1]) || isAllZeroHex(match[2])) {
    return undefined;
  }
  const traceId = match[1].toLowerCase();
  const spanId = match[2].toLowerCase();
  const traceFlags = match[3].toLowerCase();
  return {
    spanId,
    traceFlags,
    traceId,
    traceparent: `00-${traceId}-${spanId}-${traceFlags}`,
  };
}

export function createAcpRemoteTraceContext(): AcpRemoteTraceContext {
  const traceId = randomHex(16);
  const spanId = randomHex(8);
  const traceFlags = "01";
  return {
    spanId,
    traceFlags,
    traceId,
    traceparent: `00-${traceId}-${spanId}-${traceFlags}`,
  };
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return isAllZeroHex(hex) ? randomHex(byteLength) : hex;
}

function isAllZeroHex(value: string): boolean {
  return /^0+$/.test(value);
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
