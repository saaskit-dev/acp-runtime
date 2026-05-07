import type { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  connectAcpRemoteClientRelay,
  type ConnectedAcpRemoteClientRelay,
  type ConnectAcpRemoteClientRelayOptions,
} from "./relay-client.js";
import {
  ensureAcpRemoteTraceContext,
  readAcpRemoteTraceContextFromJsonRpcMessage,
  type AcpRemoteTraceContext,
} from "../shared/trace-context.js";

export type AcpRemoteStdioBridgeOptions = Omit<
  ConnectAcpRemoteClientRelayOptions,
  "onMessage" | "transport"
> & {
  autoAuthorize?: {
    accountSession: string;
    daemonId?: string;
  };
  input?: Readable;
  debugLog?: (
    message: string,
    context?: AcpRemoteBridgeDebugContext,
  ) => void;
  openAuthUrl?: (url: string) => void;
  output?: Writable;
  reconnect?: {
    maxDelayMs?: number;
    maxQueuedMessages?: number;
    minDelayMs?: number;
  };
};

export type AcpRemoteBridgeDebugContext = {
  connectionId?: string;
  direction?: "client_to_relay" | "relay_to_client";
  eventName?: string;
  jsonRpcId?: string | number;
  method?: string;
  sessionId?: string;
  spanId?: string;
  severityText?: "ERROR" | "INFO";
  traceId?: string;
  traceparent?: string;
};

export type AcpRemoteStdioBridgeHandle = {
  close(): void;
  connection: ConnectedAcpRemoteClientRelay;
};

export function createAcpRemoteStdioBridge(
  options: AcpRemoteStdioBridgeOptions,
): AcpRemoteStdioBridgeHandle {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const openAuthUrl = options.openAuthUrl ?? openUrl;
  const connectionId = options.connectionId ?? crypto.randomUUID();
  const maxQueuedMessages = options.reconnect?.maxQueuedMessages ?? 128;
  const pendingOutbound: PendingOutboundMessage[] = [];
  const deliveredResponseIds = new Set<string | number>();
  let authorizePromise: Promise<void> | undefined;
  let authUrl: string | undefined;
  let closed = false;
  let reconnectDelayMs = options.reconnect?.minDelayMs ?? 1_000;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connection: ConnectedAcpRemoteClientRelay | undefined;
  let lineBuffer = "";
  const requestMethods = new Map<string | number, string>();
  const requestSessionIds = new Map<string | number, string>();
  const requestTraceContexts = new Map<string | number, AcpRemoteTraceContext>();
  const debugLog = options.debugLog ?? (() => {});
  const sessionBindings = createSessionBindingStore({
    debugLog,
    relayUrl: String(options.relayUrl),
  });

  const connect = () => {
    if (closed) {
      return;
    }
    connection = connectAcpRemoteClientRelay({
      ...options,
      connectionId,
      nativeClientAck: true,
      transport: "native-acp",
      onClose(event) {
        if (closed) {
          options.onClose?.(event);
          return;
        }
        connection = undefined;
        debugLog(
          `relay connection closed code=${event?.code ?? "-"} reason=${
            event?.reason ?? "-"
          }`,
          {
            connectionId,
            eventName: "acp.remote.bridge.relay_closed",
            severityText: "ERROR",
          },
        );
        scheduleReconnect();
      },
      onError(error) {
        options.onError?.(error);
      },
      onMessage(message) {
        const responseId = readJsonRpcResponseId(message);
        if (isDuplicateDeliveredResponse(responseId)) {
          if (responseId !== undefined) {
            sendNativeClientAck(responseId);
          }
          return;
        }
        sessionBindings.storeFromResponse(message, requestMethods);
        logRelayMessage(
          message,
          requestMethods,
          requestSessionIds,
          requestTraceContexts,
          connectionId,
          debugLog,
        );
        authUrl = readRelayAuthUrl(message) ?? authUrl;
        if (authUrl && options.autoAuthorize && !authorizePromise) {
          debugLog("auto-authorize relay browser authentication");
          authorizePromise = authorizeRelay({
            authUrl,
            ...options.autoAuthorize,
          });
        }
        writeOutput(output, `${message}\n`, () => close(), () => {
          if (responseId !== undefined) {
            deliveredResponseIds.add(responseId);
            sendNativeClientAck(responseId);
          }
        });
      },
    });
    debugLog(`relay connection active connectionId=${connectionId}`, {
      connectionId,
      eventName: "acp.remote.bridge.relay_connected",
      severityText: "INFO",
    });
    flushPendingOutbound();
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) {
      return;
    }
    const delayMs = reconnectDelayMs;
    const maxDelayMs = options.reconnect?.maxDelayMs ?? 30_000;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, maxDelayMs);
    debugLog(
      `relay connection closed; reconnecting in ${Math.round(delayMs / 1000)}s`,
      {
        connectionId,
        eventName: "acp.remote.bridge.reconnect_scheduled",
        severityText: "INFO",
      },
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delayMs);
  };

  const flushPendingOutbound = () => {
    if (!connection) {
      return;
    }
    const flushed = pendingOutbound.length;
    while (pendingOutbound.length > 0) {
      const next = pendingOutbound.shift();
      if (next !== undefined) {
        connection.send(next.message);
      }
    }
    if (flushed > 0) {
      debugLog(`flushed ${flushed} queued relay message(s)`, {
        connectionId,
        eventName: "acp.remote.bridge.reconnect_queue_flushed",
        severityText: "INFO",
      });
    }
  };

  const sendToRelay = (message: string) => {
    if (!connection) {
      queueOutbound(message);
      return;
    }
    reconnectDelayMs = options.reconnect?.minDelayMs ?? 1_000;
    connection.send(message);
  };

  const queueOutbound = (message: string) => {
    if (pendingOutbound.length >= maxQueuedMessages) {
      const id = readJsonRpcRequestId(message);
      debugLog(
        "relay unavailable; dropping outbound message because reconnect queue is full",
        {
          connectionId,
          eventName: "acp.remote.bridge.reconnect_queue_full",
          jsonRpcId: id,
          severityText: "ERROR",
        },
      );
      if (id !== undefined) {
        writeJsonRpcError(output, id, {
          code: -32002,
          data: { connectionId },
          message: "ACP relay is temporarily unavailable: reconnect queue is full.",
        }, () => close());
      }
      return;
    }
    const id = readJsonRpcRequestId(message);
    const queued: PendingOutboundMessage = {
      id,
      message,
    };
    pendingOutbound.push(queued);
    debugLog(`queued relay message while reconnecting id=${formatJsonRpcId(id)}`, {
      connectionId,
      eventName: "acp.remote.bridge.reconnect_queue_enqueued",
      jsonRpcId: id,
      severityText: "INFO",
    });
  };

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    connection?.close();
    pendingOutbound.splice(0);
    requestMethods.clear();
    requestSessionIds.clear();
    requestTraceContexts.clear();
    options.onClose?.();
  };

  const isDuplicateDeliveredResponse = (id?: string | number): boolean => {
    if (id === undefined) {
      return false;
    }
    if (deliveredResponseIds.has(id)) {
      debugLog(`relay duplicate response suppressed id=${formatJsonRpcId(id)}`, {
        connectionId,
        eventName: "acp.remote.bridge.duplicate_response_suppressed",
        jsonRpcId: id,
        severityText: "ERROR",
      });
      return true;
    }
    return false;
  };

  const sendNativeClientAck = (id: string | number) => {
    connection?.send(JSON.stringify({
      jsonrpc: "2.0",
      method: NATIVE_CLIENT_ACK_METHOD,
      params: { id },
    }));
    debugLog(`relay response acknowledged id=${formatJsonRpcId(id)}`, {
      connectionId,
      eventName: "acp.remote.bridge.client_ack_sent",
      jsonRpcId: id,
      severityText: "INFO",
    });
  };

  connect();

  const onData = (chunk: Buffer | string) => {
    lineBuffer += String(chunk);
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    void forwardLines(lines).catch(() => close());
  };

  const forwardLines = async (lines: string[]) => {
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        let outbound = sessionBindings.applyToRequest(trimmed);
        const sessionSelection = isRelaySessionNewRequest(outbound)
          ? addSessionSelectionId(outbound, connectionId)
          : undefined;
        outbound = sessionSelection?.message ?? outbound;
        outbound = ensureAcpRemoteTraceContext(outbound).message;
        logClientMessage(
          outbound,
          requestMethods,
          requestSessionIds,
          requestTraceContexts,
          connectionId,
          debugLog,
        );
        const isAuthenticate = isRelayAuthenticateRequest(outbound);
        const isSessionNew = isRelaySessionNewRequest(outbound);
        if (isAuthenticate || isSessionNew) {
          if (authorizePromise) {
            await authorizePromise;
          } else if (authUrl) {
            debugLog(
              `open authorization url trigger=${
                isSessionNew ? "session/new" : "authenticate"
              }`,
            );
            openAuthUrl(
              sessionSelection?.selectionId
                ? addSessionSelectionIdToAuthUrl(
                    authUrl,
                    sessionSelection.selectionId,
                  )
                : authUrl,
            );
          }
        }
        sendToRelay(outbound);
      }
    }
  };

  const onEnd = () => {
    close();
  };

  input.setEncoding?.("utf8");
  input.on("data", onData);
  input.on("end", onEnd);
  input.on("error", onEnd);
  output.on?.("error", onEnd);

  return {
    close() {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
      output.off?.("error", onEnd);
      close();
    },
    connection: connection!,
  };
}

type PendingOutboundMessage = {
  id?: string | number;
  message: string;
};

const REMOTE_DAEMON_ID_META = "acp-runtime/remote/daemonId";
const REMOTE_SESSION_AGENT_META = "acp-runtime/remote/sessionAgent";
const REMOTE_SESSION_SELECTION_ID_META =
  "acp-runtime/remote/sessionSelectionId";
const REMOTE_SESSION_WORKSPACE_ROOTS_META =
  "acp-runtime/remote/sessionWorkspaceRoots";
const NATIVE_CLIENT_ACK_METHOD = "acp-runtime/remote/client_ack";

function openUrl(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

function writeOutput(
  output: Writable,
  data: string,
  onClosed: () => void,
  onFlushed?: () => void,
): void {
  try {
    output.write(data, (error) => {
      if (error) {
        onClosed();
        return;
      }
      onFlushed?.();
    });
  } catch {
    onClosed();
  }
}

type SessionBindingStore = {
  applyToRequest(message: string): string;
  storeFromResponse(
    message: string,
    requestMethods: Map<string | number, string>,
  ): void;
};

function createSessionBindingStore(input: {
  debugLog: (message: string) => void;
  relayUrl: string;
}): SessionBindingStore {
  const path = sessionBindingStorePath();
  let cache = readSessionBindingFile(path);

  const writeCache = () => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, {
        mode: 0o600,
      });
    } catch (error) {
      input.debugLog(
        `remote session binding cache write failed: ${formatError(error)}`,
      );
    }
  };

  return {
    applyToRequest(message) {
      const parsed = parseJson(message);
      if (!parsed || !isSessionBindingMethod(parsed.method)) {
        return message;
      }
      const params = isRecord(parsed.params) ? parsed.params : {};
      if (hasRemoteBindingMetadata(params._meta)) {
        return message;
      }
      const sessionId =
        typeof params.sessionId === "string" ? params.sessionId : undefined;
      if (!sessionId) {
        return message;
      }
      const binding = cache.sessions[sessionBindingKey(input.relayUrl, sessionId)];
      if (!binding) {
        return message;
      }
      return JSON.stringify({
        ...parsed,
        params: {
          ...params,
          _meta: {
            ...(isRecord(params._meta) ? params._meta : {}),
            ...binding,
          },
        },
      });
    },
    storeFromResponse(message, requestMethods) {
      const parsed = parseJson(message);
      if (!parsed || !isJsonRpcId(parsed.id)) {
        return;
      }
      const method = requestMethods.get(parsed.id);
      if (
        method !== "session/new" &&
        method !== "session/load" &&
        method !== "session/resume"
      ) {
        return;
      }
      const result = isRecord(parsed.result) ? parsed.result : undefined;
      const sessionId =
        typeof result?.sessionId === "string" ? result.sessionId : undefined;
      const binding = readRemoteBindingMetadata(result?._meta);
      if (!sessionId || !binding) {
        return;
      }
      cache = {
        sessions: {
          ...cache.sessions,
          [sessionBindingKey(input.relayUrl, sessionId)]: binding,
        },
        version: 1,
      };
      writeCache();
    },
  };
}

function sessionBindingStorePath(): string {
  const home =
    process.env.ACP_RUNTIME_HOME_DIR ??
    process.env.ACP_RUNTIME_CACHE_DIR ??
    join(homedir(), ".acp-runtime");
  return join(home, "remote-session-bindings.json");
}

function readSessionBindingFile(path: string): {
  sessions: Record<string, Record<string, unknown>>;
  version: 1;
} {
  if (!existsSync(path)) {
    return { sessions: {}, version: 1 };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.sessions)) {
      return { sessions: {}, version: 1 };
    }
    return {
      sessions: Object.fromEntries(
        Object.entries(parsed.sessions).flatMap(([key, value]) => {
          const binding = readRemoteBindingMetadata(value);
          return binding ? [[key, binding]] : [];
        }),
      ),
      version: 1,
    };
  } catch {
    return { sessions: {}, version: 1 };
  }
}

function addSessionSelectionId(
  message: string,
  connectionId: string,
): { message: string; selectionId: string } | undefined {
  const parsed = parseJson(message);
  if (!parsed || parsed.method !== "session/new") {
    return undefined;
  }
  const params = isRecord(parsed.params) ? parsed.params : {};
  const existingMeta = isRecord(params._meta) ? params._meta : {};
  const existingSelectionId = readString(
    existingMeta[REMOTE_SESSION_SELECTION_ID_META],
  );
  const selectionId =
    existingSelectionId ??
    `${connectionId}:${formatJsonRpcId(parsed.id ?? crypto.randomUUID())}:${
      crypto.randomUUID()
    }`;
  return {
    message: JSON.stringify({
      ...parsed,
      params: {
        ...params,
        _meta: {
          ...existingMeta,
          [REMOTE_SESSION_SELECTION_ID_META]: selectionId,
        },
      },
    }),
    selectionId,
  };
}

function addSessionSelectionIdToAuthUrl(
  authUrl: string,
  selectionId: string,
): string {
  try {
    const url = new URL(authUrl);
    url.searchParams.set("sessionSelectionId", selectionId);
    return url.toString();
  } catch {
    return authUrl;
  }
}

function sessionBindingKey(relayUrl: string, sessionId: string): string {
  return `${relayUrl}#${sessionId}`;
}

function isSessionBindingMethod(method: unknown): boolean {
  return (
    method === "session/load" ||
    method === "session/resume" ||
    method === "session/close" ||
    method === "session/set_config_option" ||
    method === "session/set_mode" ||
    method === "session/cancel" ||
    method === "session/prompt"
  );
}

function hasRemoteBindingMetadata(value: unknown): boolean {
  return Boolean(readRemoteBindingMetadata(value));
}

function readRemoteBindingMetadata(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const daemonId = readString(value[REMOTE_DAEMON_ID_META]);
  if (!daemonId) {
    return undefined;
  }
  const metadata: Record<string, unknown> = {
    [REMOTE_DAEMON_ID_META]: daemonId,
  };
  const agent = readSessionAgent(value[REMOTE_SESSION_AGENT_META]);
  if (agent) {
    metadata[REMOTE_SESSION_AGENT_META] = agent;
  }
  const workspaceRoots = readStringArray(value[REMOTE_SESSION_WORKSPACE_ROOTS_META]);
  if (workspaceRoots) {
    metadata[REMOTE_SESSION_WORKSPACE_ROOTS_META] = workspaceRoots;
  }
  return metadata;
}

function readSessionAgent(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = readString(value.id);
  if (id) {
    return { id };
  }
  const command = readString(value.command);
  if (!command) {
    return undefined;
  }
  const agent: Record<string, unknown> = { command };
  const args = readStringArray(value.args);
  if (args) {
    agent.args = args;
  }
  const env = readStringRecord(value.env);
  if (env) {
    agent.env = env;
  }
  const type = readString(value.type);
  if (type) {
    agent.type = type;
  }
  return agent;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
  );
  return strings.length ? strings : undefined;
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.some((entry) => typeof entry[1] !== "string")) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function authorizeRelay(input: {
  accountSession: string;
  authUrl: string;
  daemonId?: string;
}): Promise<void> {
  const daemonId = input.daemonId ?? await resolveSingleDaemonId(input);
  const response = await fetch(input.authUrl, {
    body: JSON.stringify({ daemonId }),
    headers: {
      Authorization: `Bearer ${input.accountSession}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    redirect: "manual",
  });
  if (!response.ok) {
    throw new Error(
      `ACP relay authorization failed: ${response.status} ${response.statusText}`,
    );
  }
  const body = await readOptionalJsonResponse(response);
  if (body?.ok !== true) {
    throw new Error(
      `ACP relay authorization failed: ${
        typeof body?.reason === "string" ? body.reason : "unexpected response"
      }`,
    );
  }
}

async function resolveSingleDaemonId(input: {
  accountSession: string;
  authUrl: string;
}): Promise<string> {
  const authUrl = new URL(input.authUrl);
  const daemonsUrl = new URL("/api/daemons", authUrl);
  const response = await fetch(daemonsUrl, {
    headers: {
      Authorization: `Bearer ${input.accountSession}`,
    },
  });
  if (!response.ok) {
    throw new Error(
      `ACP relay daemon discovery failed: ${response.status} ${response.statusText}`,
    );
  }
  const body = await readOptionalJsonResponse(response);
  const daemons = Array.isArray(body?.daemons)
    ? body.daemons.filter(
        (entry): entry is { daemonId: string } =>
          typeof entry?.daemonId === "string" && entry.daemonId.trim() !== "",
      )
    : [];
  if (daemons.length !== 1) {
    throw new Error(
      `ACP relay daemon discovery expected exactly one online daemon, found ${daemons.length}. Set ACP_DAEMON_ID explicitly.`,
    );
  }
  return daemons[0].daemonId;
}

function readRelayAuthUrl(message: string): string | undefined {
  const parsed = parseJson(message);
  const methods = parsed?.result?.authMethods;
  if (!Array.isArray(methods)) {
    return undefined;
  }
  for (const method of methods) {
    const value = method?._meta?.["acp-runtime/remote/authUrl"];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

async function readOptionalJsonResponse(
  response: Response,
): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await response.json() as unknown;
    return isRecord(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

function isRelayAuthenticateRequest(message: string): boolean {
  const parsed = parseJson(message);
  return parsed?.method === "authenticate";
}

function isRelaySessionNewRequest(message: string): boolean {
  const parsed = parseJson(message);
  return parsed?.method === "session/new";
}

function readJsonRpcRequestId(message: string): string | number | undefined {
  const parsed = parseJson(message);
  const id = parsed?.id;
  return isJsonRpcId(id) ? id : undefined;
}

function readJsonRpcResponseId(message: string): string | number | undefined {
  const parsed = parseJson(message);
  if (
    !parsed ||
    (!Object.prototype.hasOwnProperty.call(parsed, "result") &&
      !Object.prototype.hasOwnProperty.call(parsed, "error"))
  ) {
    return undefined;
  }
  const id = parsed.id;
  return isJsonRpcId(id) ? id : undefined;
}

function writeJsonRpcError(
  output: Writable,
  id: string | number,
  error: {
    code: number;
    data?: Record<string, unknown>;
    message: string;
  },
  onClosed: () => void,
): void {
  writeOutput(
    output,
    `${JSON.stringify({
      error,
      id,
      jsonrpc: "2.0",
    })}\n`,
    onClosed,
  );
}

function logClientMessage(
  message: string,
  requestMethods: Map<string | number, string>,
  requestSessionIds: Map<string | number, string>,
  requestTraceContexts: Map<string | number, AcpRemoteTraceContext>,
  connectionId: string,
  debugLog: (
    message: string,
    context?: AcpRemoteBridgeDebugContext,
  ) => void,
): void {
  const parsed = parseJson(message);
  if (!parsed) {
    debugLog("client -> relay invalid json", {
      connectionId,
      direction: "client_to_relay",
      eventName: "acp.remote.bridge.transport",
      severityText: "ERROR",
    });
    return;
  }
  const method = parsed.method;
  const id = parsed.id;
  const sessionId = readMessageSessionId(parsed);
  const traceContext = readAcpRemoteTraceContextFromJsonRpcMessage(parsed);
  if (typeof method === "string" && isJsonRpcId(id)) {
    requestMethods.set(id, method);
    if (sessionId) {
      requestSessionIds.set(id, sessionId);
    }
    if (traceContext) {
      requestTraceContexts.set(id, traceContext);
    }
  }
  debugLog(
    `client -> relay id=${formatJsonRpcId(id)} method=${
      typeof method === "string" ? method : "-"
    }${sessionId ? ` sessionId=${sessionId}` : ""}${
      traceContext ? ` traceId=${traceContext.traceId}` : ""
    }`,
    compactBridgeDebugContext({
      connectionId,
      direction: "client_to_relay",
      eventName: "acp.remote.bridge.transport",
      jsonRpcId: isJsonRpcId(id) ? id : undefined,
      method: typeof method === "string" ? method : undefined,
      sessionId,
      ...traceContextToDebugFields(traceContext),
      severityText: "INFO",
    }),
  );
}

function logRelayMessage(
  message: string,
  requestMethods: Map<string | number, string>,
  requestSessionIds: Map<string | number, string>,
  requestTraceContexts: Map<string | number, AcpRemoteTraceContext>,
  connectionId: string,
  debugLog: (
    message: string,
    context?: AcpRemoteBridgeDebugContext,
  ) => void,
): void {
  const parsed = parseJson(message);
  if (!parsed) {
    debugLog("relay -> client invalid json", {
      connectionId,
      direction: "relay_to_client",
      eventName: "acp.remote.bridge.transport",
      severityText: "ERROR",
    });
    return;
  }
  const id = parsed.id;
  const method = isJsonRpcId(id) ? requestMethods.get(id) : undefined;
  const sessionId =
    readMessageSessionId(parsed) ??
    (isJsonRpcId(id) ? requestSessionIds.get(id) : undefined);
  const traceContext =
    readAcpRemoteTraceContextFromJsonRpcMessage(parsed) ??
    (isJsonRpcId(id) ? requestTraceContexts.get(id) : undefined);
  if (isJsonRpcId(id)) {
    requestMethods.delete(id);
    requestSessionIds.delete(id);
    requestTraceContexts.delete(id);
  }
  const hasError = Object.prototype.hasOwnProperty.call(parsed, "error");
  const errorMessage =
    hasError && typeof parsed.error?.message === "string"
      ? ` message=${parsed.error.message}`
      : "";
  const notificationMethod = typeof parsed.method === "string" ? parsed.method : "-";
  debugLog(
    `relay -> client id=${formatJsonRpcId(id)} method=${
      method ?? notificationMethod
    } error=${hasError ? "yes" : "no"}${
      sessionId ? ` sessionId=${sessionId}` : ""
    }${traceContext ? ` traceId=${traceContext.traceId}` : ""}${
      errorMessage
    }`,
    compactBridgeDebugContext({
      connectionId,
      direction: "relay_to_client",
      eventName: "acp.remote.bridge.transport",
      jsonRpcId: isJsonRpcId(id) ? id : undefined,
      method: method ?? (notificationMethod !== "-" ? notificationMethod : undefined),
      sessionId,
      ...traceContextToDebugFields(traceContext),
      severityText: hasError ? "ERROR" : "INFO",
    }),
  );
}

function readMessageSessionId(message: Record<string, any>): string | undefined {
  const params = isRecord(message.params) ? message.params : undefined;
  const result = isRecord(message.result) ? message.result : undefined;
  return readString(params?.sessionId) ?? readString(result?.sessionId);
}

function compactBridgeDebugContext(
  context: AcpRemoteBridgeDebugContext,
): AcpRemoteBridgeDebugContext | undefined {
  const compacted = Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  ) as AcpRemoteBridgeDebugContext;
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function traceContextToDebugFields(
  traceContext: AcpRemoteTraceContext | undefined,
): Pick<
  AcpRemoteBridgeDebugContext,
  "spanId" | "traceId" | "traceparent"
> {
  return traceContext
    ? {
        spanId: traceContext.spanId,
        traceId: traceContext.traceId,
        traceparent: traceContext.traceparent,
      }
    : {};
}

function formatJsonRpcId(id: unknown): string {
  return isJsonRpcId(id) ? String(id) : "-";
}

function isJsonRpcId(id: unknown): id is string | number {
  return typeof id === "string" || typeof id === "number";
}

function parseJson(message: string): Record<string, any> | undefined {
  try {
    const parsed = JSON.parse(message) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, any>
      : undefined;
  } catch {
    return undefined;
  }
}
