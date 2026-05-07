import {
  AgentSideConnection,
  type AnyMessage,
  type Stream,
} from "@agentclientprotocol/sdk";
import { readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

import {
  AcpRemoteEndpointKind,
  AcpRemoteChannelKind,
  AcpRemoteFrameType,
  type AcpRemoteAckFrame,
  type AcpRemoteDataFrame,
  type AcpRemoteConnectionTicket,
  type AcpRemoteFrame,
  type AcpRemotePongFrame,
} from "../protocol/types.js";
import {
  ACP_REMOTE_DEFAULT_TICKET_PUBLIC_KEYS,
  verifyAcpRemoteSignedConnectionTicket,
  type AcpRemoteTicketVerificationKey,
} from "../protocol/tickets.js";
import {
  hasAcpRemoteScope,
  isConnectionTicketExpired,
} from "../protocol/validation.js";
import {
  normalizeWebSocketMessageData,
  type AcpWebSocketLike,
} from "../protocol/websocket-stream.js";
import {
  parseFrame,
  requiredScopeForAcpPayload,
  isJsonRpcRequest,
} from "../shared/frame-handler.js";
import {
  readAcpRemoteTraceContextFromJsonRpcMessage,
  type AcpRemoteTraceContext,
} from "../shared/trace-context.js";
import {
  AcpRemoteRuntimeAgent,
  type AcpRemoteRuntimeAgentOptions,
} from "./runtime-agent.js";
import { AcpRemoteProxyAgent } from "./proxy-agent.js";
import type { AcpRuntimeAgentInput } from "../../core/types.js";
import type { AcpConnectionFactory } from "../../acp/connection-types.js";

export type AcpRemoteDaemonConnectionOptions =
  Omit<AcpRemoteRuntimeAgentOptions, "runtime"> & {
    connectionFactory?: AcpConnectionFactory;
    daemonId: string;
    debugLog?: (
      message: string,
      context?: AcpRemoteDaemonDebugContext,
    ) => void;
    maxBufferedFramesPerConnection?: number;
    now?: () => Date;
    requiredPolicyVersion?: number;
    runtime?: AcpRemoteRuntimeAgentOptions["runtime"];
    socket: AcpWebSocketLike;
    ticketVerificationKeys?: readonly [
      AcpRemoteTicketVerificationKey,
      ...AcpRemoteTicketVerificationKey[],
    ];
  };

export type AcpRemoteDaemonDebugContext = {
  connectionId?: string;
  direction?: "relay_to_daemon" | "daemon_to_relay";
  jsonRpcId?: string | number;
  method?: string;
  sessionId?: string;
  spanId?: string;
  severityText?: "ERROR" | "INFO";
  traceId?: string;
  traceparent?: string;
};

export type AcpRemoteDaemonConnectionHandle = {
  close(): void;
};

type ActiveRelayAcpConnection = {
  channel: RelayAcpChannel;
  connection: AgentSideConnection;
  lastInboundSeq?: number;
  outboundQueue: AcpRemoteDataFrame[];
  pendingOutboundFrames: Map<number, AcpRemoteDataFrame>;
};

type AcpDaemonRequestDebugContext = {
  method?: string;
  sessionId?: string;
  traceContext?: AcpRemoteTraceContext;
};

const DEFAULT_MAX_BUFFERED_FRAMES_PER_CONNECTION = 64;

export function createAcpRemoteDaemonConnection(
  options: AcpRemoteDaemonConnectionOptions,
): AcpRemoteDaemonConnectionHandle {
  const active = new Map<string, ActiveRelayAcpConnection>();
  const daemonRequestContexts = new Map<
    string,
    Map<string | number, AcpDaemonRequestDebugContext>
  >();
  const outboundSeq = new Map<string, number>();
  const relayRequestContexts = new Map<
    string,
    Map<string | number, AcpDaemonRequestDebugContext>
  >();
  const tickets = new Map<string, AcpRemoteConnectionTicket>();
  const ticketChecks = new Map<string, Promise<boolean>>();
  const ticketVerificationKeys = new Map<
    string,
    AcpRemoteTicketVerificationKey
  >();
  for (const key of
    options.ticketVerificationKeys ?? ACP_REMOTE_DEFAULT_TICKET_PUBLIC_KEYS) {
    ticketVerificationKeys.set(key.kid, key);
  }
  const maxBufferedFramesPerConnection =
    options.maxBufferedFramesPerConnection ??
    DEFAULT_MAX_BUFFERED_FRAMES_PER_CONNECTION;
  const debugLog = options.debugLog ?? (() => {});

  const onMessage = (event: { data: unknown }) => {
    void handleMessage(event);
  };

  const handleMessage = async (event: { data: unknown }) => {
    const text = normalizeWebSocketMessageData(event.data);
    if (!text) {
      return;
    }

    const frame = parseFrame(text);
    if (!frame) {
      return;
    }

    if (frame.frameType === AcpRemoteFrameType.Ping) {
      const pong: AcpRemotePongFrame = {
        connectionId: frame.connectionId,
        frameType: AcpRemoteFrameType.Pong,
        nonce: frame.nonce,
      };
      options.socket.send(JSON.stringify(pong));
      return;
    }

    if (frame.frameType === AcpRemoteFrameType.Pong) {
      return;
    }

    if (frame.frameType === AcpRemoteFrameType.Ack) {
      handleRelayAck(frame);
      return;
    }

    if (frame.frameType === AcpRemoteFrameType.Hello) {
      if (frame.endpoint !== AcpRemoteEndpointKind.Client) {
        return;
      }
      const check = validateTicketFrame(frame);
      ticketChecks.set(frame.connectionId, check);
      void check.finally(() => {
        ticketChecks.delete(frame.connectionId);
      });
      return;
    }

    if (frame.frameType === AcpRemoteFrameType.Renew) {
      const check = validateTicketFrame(frame);
      ticketChecks.set(frame.connectionId, check);
      void check.finally(() => {
        ticketChecks.delete(frame.connectionId);
      });
      return;
    }

    if (frame.frameType === AcpRemoteFrameType.Close) {
      const entry = active.get(frame.connectionId);
      entry?.channel.close();
      active.delete(frame.connectionId);
      daemonRequestContexts.delete(frame.connectionId);
      relayRequestContexts.delete(frame.connectionId);
      tickets.delete(frame.connectionId);
      ticketChecks.delete(frame.connectionId);
      return;
    }

    if (
      frame.frameType !== AcpRemoteFrameType.Data ||
      (frame.channelKind !== AcpRemoteChannelKind.Acp &&
        frame.channelKind !== AcpRemoteChannelKind.Filesystem)
    ) {
      return;
    }

    if (frame.channelKind === AcpRemoteChannelKind.Filesystem) {
      sendRelayAck(frame.connectionId, frame.seq);
      void handleFilesystemControlFrame(frame);
      return;
    }

    const pendingTicketCheck = ticketChecks.get(frame.connectionId);
    if (pendingTicketCheck && !(await pendingTicketCheck)) {
      return;
    }
    if (!tickets.has(frame.connectionId)) {
      closeRemoteConnection(
        frame.connectionId,
        "missing_ticket",
        "ACP remote connection has no valid ticket.",
      );
      return;
    }
    const ticket = tickets.get(frame.connectionId);
    let entry = active.get(frame.connectionId);
    if (
      entry?.lastInboundSeq !== undefined &&
      frame.seq <= entry.lastInboundSeq
    ) {
      sendRelayAck(frame.connectionId, frame.seq);
      return;
    }
    logRelayAcpPayload(frame.connectionId, frame.payload);
    if (!ticket || !authorizeAcpPayload(frame.connectionId, ticket, frame.payload)) {
      return;
    }

    if (!entry) {
      const agent = resolveTicketAgent(ticket.agent);
      const runtimeOptions = {
        ...options,
        agent: agent ?? options.agent,
        remoteDaemonId: ticket.daemonId,
        sessionAgent: agent ?? options.agent,
        workspaceRoots: ticket.workspaceRoots ?? options.workspaceRoots,
      };
      const channel = new RelayAcpChannel(frame.connectionId, sendAcpPayload);
      let proxyAgent: AcpRemoteProxyAgent | undefined;
      const connection = new AgentSideConnection(
        (agentConnection) => {
          if (options.connectionFactory) {
            proxyAgent = new AcpRemoteProxyAgent(agentConnection, {
              ...runtimeOptions,
              connectionFactory: options.connectionFactory,
            });
            return proxyAgent;
          }
          if (!options.runtime) {
            throw new Error(
              "ACP remote daemon requires connectionFactory for proxy mode or runtime for facade mode.",
            );
          }
          return new AcpRemoteRuntimeAgent(agentConnection, {
            ...runtimeOptions,
            runtime: options.runtime,
          });
        },
        channel.stream,
      );
      if (proxyAgent) {
        void connection.closed.finally(() => {
          void proxyAgent?.close();
        });
      }
      entry = {
        channel,
        connection,
        lastInboundSeq: undefined,
        outboundQueue: [],
        pendingOutboundFrames: new Map(),
      };
      active.set(frame.connectionId, entry);
      void connection.closed.finally(() => {
        active.delete(frame.connectionId);
        channel.close();
      });
    }

    sendRelayAck(frame.connectionId, frame.seq);
    entry.lastInboundSeq = frame.seq;
    entry.channel.enqueue(frame.payload as AnyMessage);
  };

  const validateTicketFrame = async (
    frame: Extract<
      AcpRemoteFrame,
      {
        frameType:
          | typeof AcpRemoteFrameType.Hello
          | typeof AcpRemoteFrameType.Renew;
      }
    >,
  ): Promise<boolean> => {
    if (!frame.ticket) {
      closeRemoteConnection(
        frame.connectionId,
        "missing_ticket",
        "ACP remote connection ticket is missing.",
      );
      return false;
    }

    const keys =
      ticketVerificationKeys.size > 0
        ? [...ticketVerificationKeys.values()]
        : undefined;

    if (!keys) {
      closeRemoteConnection(
        frame.connectionId,
        "invalid_ticket",
        "ACP remote ticket verification keys are not configured.",
      );
      return false;
    }

    try {
      const ticket = await verifyAcpRemoteSignedConnectionTicket(
        frame.ticket,
        keys,
        {
          connectionId: frame.connectionId,
          daemonId: options.daemonId,
          now: options.now?.(),
          policyVersion: options.requiredPolicyVersion,
          requiredScopes: ["acp:connect"],
        },
      );
      tickets.set(frame.connectionId, ticket);
      return true;
    } catch (error) {
      closeRemoteConnection(
        frame.connectionId,
        "invalid_ticket",
        error instanceof Error
          ? error.message
          : "ACP remote ticket verification failed.",
      );
      return false;
    }
  };

  const closeRemoteConnection = (
    connectionId: string,
    code: string,
    reason: string,
  ) => {
    const entry = active.get(connectionId);
    entry?.channel.close();
    active.delete(connectionId);
    daemonRequestContexts.delete(connectionId);
    relayRequestContexts.delete(connectionId);
    tickets.delete(connectionId);
    outboundSeq.delete(connectionId);
    options.socket.send(
      JSON.stringify({
        code,
        connectionId,
        frameType: AcpRemoteFrameType.Close,
        reason,
      }),
    );
  };

  const handleRelayAck = (frame: AcpRemoteAckFrame) => {
    const entry = active.get(frame.connectionId);
    if (!entry) {
      return;
    }
    for (const seq of [...entry.pendingOutboundFrames.keys()].sort(
      (left, right) => left - right,
    )) {
      if (seq > frame.ack) {
        break;
      }
      entry.pendingOutboundFrames.delete(seq);
    }
    flushAcpOutboundQueue(frame.connectionId, entry);
  };

  const sendRelayAck = (connectionId: string, ack: number) => {
    options.socket.send(
      JSON.stringify({
        ack,
        channelId: "acp",
        connectionId,
        frameType: AcpRemoteFrameType.Ack,
      } satisfies AcpRemoteAckFrame),
    );
  };

  const handleFilesystemControlFrame = async (
    frame: AcpRemoteDataFrame,
  ): Promise<void> => {
    const request = parseWorkspaceListRequest(frame.payload);
    if (!request) {
      return;
    }
    const result = await listWorkspaceDirectory({
      path: request.path,
      root: request.root,
      workspaceRoots: options.workspaceRoots,
    });
    options.socket.send(
      JSON.stringify({
        channelId: "workspace",
        channelKind: AcpRemoteChannelKind.Filesystem,
        connectionId: frame.connectionId,
        frameType: AcpRemoteFrameType.Data,
        payload: {
          ...result,
          kind: "workspace/list/result",
          requestId: request.requestId,
        },
        seq: 1,
      } satisfies AcpRemoteDataFrame),
    );
  };

  const authorizeAcpPayload = (
    connectionId: string,
    ticket: AcpRemoteConnectionTicket,
    payload: unknown,
  ): boolean => {
    if (isConnectionTicketExpired(ticket, options.now?.())) {
      closeRemoteConnection(
        connectionId,
        "expired_ticket",
        "ACP remote connection ticket expired.",
      );
      return false;
    }

    const requiredScope = requiredScopeForAcpPayload(payload);
    if (!requiredScope || hasAcpRemoteScope(ticket, requiredScope)) {
      return true;
    }

    if (isJsonRpcRequest(payload)) {
      sendAcpPayload(connectionId, {
        error: {
          code: -32000,
          data: {
            requiredScope,
          },
          message: `Authentication required: missing ACP remote scope ${requiredScope}.`,
        },
        id: payload.id,
        jsonrpc: "2.0",
      });
    } else {
      closeRemoteConnection(
        connectionId,
        "missing_scope",
        `ACP remote ticket missing scope: ${requiredScope}.`,
      );
    }
    return false;
  };

  const sendAcpPayload = (connectionId: string, payload: AnyMessage) => {
    const entry = active.get(connectionId);
    if (!entry) {
      return;
    }
    logDaemonAcpPayload(connectionId, payload);
    const seq = (outboundSeq.get(connectionId) ?? 0) + 1;
    outboundSeq.set(connectionId, seq);
    const frame: AcpRemoteDataFrame = {
      channelId: "acp",
      channelKind: AcpRemoteChannelKind.Acp,
      connectionId,
      frameType: AcpRemoteFrameType.Data,
      payload,
      seq,
    };
    if (entry.pendingOutboundFrames.size >= maxBufferedFramesPerConnection) {
      entry.outboundQueue.push(frame);
      return;
    }
    sendQueuedAcpFrame(entry, frame);
  };

  const sendQueuedAcpFrame = (
    entry: ActiveRelayAcpConnection,
    frame: AcpRemoteDataFrame,
  ) => {
    entry.pendingOutboundFrames.set(frame.seq, frame);
    options.socket.send(JSON.stringify(frame));
  };

  const flushAcpOutboundQueue = (
    connectionId: string,
    entry: ActiveRelayAcpConnection,
  ) => {
    while (
      active.get(connectionId) === entry &&
      entry.outboundQueue.length > 0 &&
      entry.pendingOutboundFrames.size < maxBufferedFramesPerConnection
    ) {
      const next = entry.outboundQueue.shift();
      if (!next) {
        return;
      }
      sendQueuedAcpFrame(entry, next);
    }
  };

  const onClose = () => {
    for (const entry of active.values()) {
      entry.channel.close();
    }
    active.clear();
    daemonRequestContexts.clear();
    outboundSeq.clear();
    relayRequestContexts.clear();
    tickets.clear();
    ticketChecks.clear();
  };

  function logRelayAcpPayload(connectionId: string, payload: unknown): void {
    const details = readAcpPayloadDebugDetails(payload);
    const responseContext =
      details.id !== undefined && details.isResponse
        ? daemonRequestContexts.get(connectionId)?.get(details.id)
        : undefined;
    const method = details.method ?? responseContext?.method;
    const sessionId = details.sessionId ?? responseContext?.sessionId;
    const traceContext = details.traceContext ?? responseContext?.traceContext;
    if (details.id !== undefined && details.isResponse) {
      daemonRequestContexts.get(connectionId)?.delete(details.id);
    } else if (details.id !== undefined && details.method) {
      requestContextMap(relayRequestContexts, connectionId).set(details.id, {
        method: details.method,
        sessionId: details.sessionId,
        traceContext: details.traceContext,
      });
    }
    debugLog(
      `relay -> daemon id=${formatJsonRpcId(details.id)} method=${
        method ?? "-"
      } error=${details.hasError ? "yes" : "no"}${
        sessionId ? ` sessionId=${sessionId}` : ""
      }${traceContext ? ` traceId=${traceContext.traceId}` : ""}`,
      compactDaemonDebugContext({
        connectionId,
        direction: "relay_to_daemon",
        jsonRpcId: details.id,
        method,
        sessionId,
        ...traceContextToDebugFields(traceContext),
        severityText: details.hasError ? "ERROR" : "INFO",
      }),
    );
  }

  function logDaemonAcpPayload(connectionId: string, payload: unknown): void {
    const details = readAcpPayloadDebugDetails(payload);
    const responseContext =
      details.id !== undefined && details.isResponse
        ? relayRequestContexts.get(connectionId)?.get(details.id)
        : undefined;
    const method = details.method ?? responseContext?.method;
    const sessionId = details.sessionId ?? responseContext?.sessionId;
    const traceContext = details.traceContext ?? responseContext?.traceContext;
    if (details.id !== undefined && details.isResponse) {
      relayRequestContexts.get(connectionId)?.delete(details.id);
    } else if (details.id !== undefined && details.method) {
      requestContextMap(daemonRequestContexts, connectionId).set(details.id, {
        method: details.method,
        sessionId: details.sessionId,
        traceContext: details.traceContext,
      });
    }
    debugLog(
      `daemon -> relay id=${formatJsonRpcId(details.id)} method=${
        method ?? "-"
      } error=${details.hasError ? "yes" : "no"}${
        sessionId ? ` sessionId=${sessionId}` : ""
      }${traceContext ? ` traceId=${traceContext.traceId}` : ""}`,
      compactDaemonDebugContext({
        connectionId,
        direction: "daemon_to_relay",
        jsonRpcId: details.id,
        method,
        sessionId,
        ...traceContextToDebugFields(traceContext),
        severityText: details.hasError ? "ERROR" : "INFO",
      }),
    );
  }

  options.socket.addEventListener("message", onMessage);
  options.socket.addEventListener("close", onClose);
  options.socket.addEventListener("error", onClose);

  return {
    close() {
      options.socket.removeEventListener?.("message", onMessage);
      options.socket.removeEventListener?.("close", onClose);
      options.socket.removeEventListener?.("error", onClose);
      onClose();
      options.socket.close(1000, "ACP remote daemon connection closed.");
    },
  };
}

function readAcpPayloadDebugDetails(payload: unknown): {
  hasError: boolean;
  id?: string | number;
  isResponse: boolean;
  method?: string;
  sessionId?: string;
  traceContext?: AcpRemoteTraceContext;
} {
  if (!isRecord(payload)) {
    return {
      hasError: false,
      isResponse: false,
    };
  }
  const id = isJsonRpcId(payload.id) ? payload.id : undefined;
  const hasError = Object.prototype.hasOwnProperty.call(payload, "error");
  const isResponse =
    hasError || Object.prototype.hasOwnProperty.call(payload, "result");
  const method = typeof payload.method === "string" ? payload.method : undefined;
  return {
    hasError,
    id,
    isResponse,
    method,
    sessionId: readPayloadSessionId(payload),
    traceContext: readAcpRemoteTraceContextFromJsonRpcMessage(payload),
  };
}

function readPayloadSessionId(payload: Record<string, unknown>): string | undefined {
  const params = isRecord(payload.params) ? payload.params : undefined;
  const result = isRecord(payload.result) ? payload.result : undefined;
  return readString(params?.sessionId) ?? readString(result?.sessionId);
}

function requestContextMap(
  maps: Map<string, Map<string | number, AcpDaemonRequestDebugContext>>,
  connectionId: string,
): Map<string | number, AcpDaemonRequestDebugContext> {
  const existing = maps.get(connectionId);
  if (existing) {
    return existing;
  }
  const next = new Map<string | number, AcpDaemonRequestDebugContext>();
  maps.set(connectionId, next);
  return next;
}

function compactDaemonDebugContext(
  context: AcpRemoteDaemonDebugContext,
): AcpRemoteDaemonDebugContext | undefined {
  const compacted = Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  ) as AcpRemoteDaemonDebugContext;
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function traceContextToDebugFields(
  traceContext: AcpRemoteTraceContext | undefined,
): Pick<
  AcpRemoteDaemonDebugContext,
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

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveTicketAgent(
  agent: AcpRemoteConnectionTicket["agent"],
): AcpRuntimeAgentInput | undefined {
  if (!agent) {
    return undefined;
  }
  if ("id" in agent) {
    return agent.id;
  }
  return {
    args: agent.args as string[] | undefined,
    command: agent.command,
    env: agent.env,
    type: agent.type,
  };
}

type WorkspaceListRequest = {
  kind: "workspace/list";
  path?: string;
  requestId: string;
  root: string;
};

function parseWorkspaceListRequest(value: unknown): WorkspaceListRequest | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.kind !== "workspace/list" ||
    typeof record.requestId !== "string" ||
    typeof record.root !== "string"
  ) {
    return undefined;
  }
  return {
    kind: "workspace/list",
    path: typeof record.path === "string" ? record.path : undefined,
    requestId: record.requestId,
    root: record.root,
  };
}

async function listWorkspaceDirectory(input: {
  path?: string;
  root: string;
  workspaceRoots?: readonly string[];
}): Promise<
  | {
      ok: true;
      path: string;
      entries: readonly { name: string; path: string; type: "directory" }[];
    }
  | { ok: false; reason: string }
> {
  const configuredRoots = input.workspaceRoots?.length
    ? input.workspaceRoots
    : [input.root];
  const requestedRoot = await safeRealpath(resolve(input.root));
  const allowedRoots = await Promise.all(
    configuredRoots.map((root) => safeRealpath(resolve(root))),
  );
  if (!allowedRoots.some((root) => pathContains(root, requestedRoot))) {
    return { ok: false, reason: "Workspace root is not allowed." };
  }

  const requestedPath = await safeRealpath(resolve(input.path ?? input.root));
  if (!pathContains(requestedRoot, requestedPath)) {
    return { ok: false, reason: "Workspace path is outside the selected root." };
  }

  try {
    const entries = await readdir(requestedPath, { withFileTypes: true });
    return {
      entries: entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => ({
          name: entry.name,
          path: resolve(requestedPath, entry.name),
          type: "directory" as const,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      ok: true,
      path: requestedPath,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error
        ? error.message
        : `Unable to list workspace directory ${basename(requestedPath)}.`,
    };
  }
}

function pathContains(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

async function safeRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

class RelayAcpChannel {
  private closed = false;
  private controller: ReadableStreamDefaultController<AnyMessage> | undefined;
  readonly stream: Stream;

  constructor(
    private readonly connectionId: string,
    private readonly sendMessage: (connectionId: string, message: AnyMessage) => void,
  ) {
    this.stream = {
      readable: new ReadableStream<AnyMessage>({
        start: (controller) => {
          this.controller = controller;
        },
        cancel: () => {
          this.close();
        },
      }),
      writable: new WritableStream<AnyMessage>({
        abort: () => {
          this.close();
        },
        close: () => {
          this.close();
        },
        write: (message) => {
          this.send(message);
        },
      }),
    };
  }

  enqueue(message: AnyMessage): void {
    if (this.closed) {
      return;
    }
    this.controller?.enqueue(message);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.controller?.close();
  }

  private send(message: AnyMessage): void {
    if (this.closed) {
      return;
    }
    this.sendMessage(this.connectionId, message);
  }
}
