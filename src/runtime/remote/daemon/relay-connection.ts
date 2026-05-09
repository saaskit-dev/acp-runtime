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
import type { AcpRuntimeAgentInput } from "../../core/types.js";

export type AcpRemoteDaemonConnectionOptions =
  Omit<AcpRemoteRuntimeAgentOptions, "runtime"> & {
    daemonId: string;
    debugLog?: (
      message: string,
      context?: AcpRemoteDaemonDebugContext,
    ) => void;
    maxBufferedFramesPerConnection?: number;
    now?: () => Date;
    requiredPolicyVersion?: number;
    requestJournal?: AcpRemoteDaemonRequestJournal;
    runtime: AcpRemoteRuntimeAgentOptions["runtime"];
    socket: AcpWebSocketLike;
    state?: AcpRemoteDaemonConnectionState;
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

export type AcpRemoteDaemonRequestJournalEntry = {
  connectionId: string;
  id: string | number;
  method?: string;
  payload?: AnyMessage;
  status: "completed" | "received";
};

export type AcpRemoteDaemonRequestJournal = {
  lookup(
    connectionId: string,
    id: string | number,
  ): Promise<AcpRemoteDaemonRequestJournalEntry | undefined>;
  markCompleted(entry: {
    connectionId: string;
    id: string | number;
    method?: string;
    payload: AnyMessage;
  }): Promise<void>;
  markReceived(entry: {
    connectionId: string;
    id: string | number;
    method?: string;
  }): Promise<void>;
};

type ActiveRelayAcpConnection = {
  channel: RelayAcpChannel;
  closeAfterInFlight?: boolean;
  connection: AgentSideConnection;
  lastInboundSeq?: number;
  outboundQueue: AcpRemoteDataFrame[];
  pendingOutboundFrames: Map<number, AcpRemoteDataFrame>;
};

export type AcpRemoteDaemonConnectionState = {
  active: Map<string, ActiveRelayAcpConnection>;
  daemonRequestContexts: Map<
    string,
    Map<string | number, AcpDaemonRequestDebugContext>
  >;
  inFlightRuntimeRequests: Map<
    string,
    Map<string | number, AcpDaemonRequestDebugContext>
  >;
  outboundSeq: Map<string, number>;
  relayRequestContexts: Map<
    string,
    Map<string | number, AcpDaemonRequestDebugContext>
  >;
  socket?: AcpWebSocketLike;
  ticketChecks: Map<string, Promise<boolean>>;
  tickets: Map<string, AcpRemoteConnectionTicket>;
};

type AcpDaemonRequestDebugContext = {
  method?: string;
  sessionId?: string;
  traceContext?: AcpRemoteTraceContext;
};

const DEFAULT_MAX_BUFFERED_FRAMES_PER_CONNECTION = 64;

export function createAcpRemoteDaemonConnectionState(): AcpRemoteDaemonConnectionState {
  return {
    active: new Map(),
    daemonRequestContexts: new Map(),
    inFlightRuntimeRequests: new Map(),
    outboundSeq: new Map(),
    relayRequestContexts: new Map(),
    ticketChecks: new Map(),
    tickets: new Map(),
  };
}

export function countAcpRemoteDaemonInFlightRuntimeRequests(
  state: Pick<AcpRemoteDaemonConnectionState, "inFlightRuntimeRequests">,
): number {
  let count = 0;
  for (const requests of state.inFlightRuntimeRequests.values()) {
    count += requests.size;
  }
  return count;
}

export function createAcpRemoteDaemonConnection(
  options: AcpRemoteDaemonConnectionOptions,
): AcpRemoteDaemonConnectionHandle {
  const state = options.state ?? createAcpRemoteDaemonConnectionState();
  state.socket = options.socket;
  const {
    active,
    daemonRequestContexts,
    inFlightRuntimeRequests,
    outboundSeq,
    relayRequestContexts,
    ticketChecks,
    tickets,
  } = state;
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
  let disposed = false;

  const sendSocket = (data: string) => {
    state.socket?.send(data);
  };

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
      sendSocket(JSON.stringify(pong));
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
      if (hasInFlightRuntimeRequests(frame.connectionId)) {
        if (entry) {
          entry.closeAfterInFlight = true;
        }
      } else {
        entry?.channel.close();
        active.delete(frame.connectionId);
      }
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
    const request = readJournalableJsonRpcRequest(frame.payload);
    if (request && options.requestJournal) {
      const duplicate = await resolveDaemonRequestDuplicate(
        frame.connectionId,
        request,
      );
      if (duplicate) {
        sendAcpPayloadDirect(frame.connectionId, duplicate);
        sendRelayAck(frame.connectionId, frame.seq);
        return;
      }
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
      const connection = new AgentSideConnection(
        (agentConnection) => {
          if (!options.runtime) {
            throw new Error("ACP remote daemon requires a runtime.");
          }
          return new AcpRemoteRuntimeAgent(agentConnection, {
            ...runtimeOptions,
            runtime: options.runtime,
          });
        },
        channel.stream,
      );
      entry = {
        channel,
        closeAfterInFlight: false,
        connection,
        lastInboundSeq: undefined,
        outboundQueue: [],
        pendingOutboundFrames: new Map(),
      };
      active.set(frame.connectionId, entry);
      void connection.closed.finally(() => {
        if (active.get(frame.connectionId) !== entry) {
          return;
        }
        closeRemoteConnection(
          frame.connectionId,
          "acp_connection_closed",
          "ACP connection closed.",
        );
      }).catch(() => {
        // The relay has been notified by the finalizer above.
      });
    }

    if (request && options.requestJournal) {
      try {
        await options.requestJournal.markReceived({
          connectionId: frame.connectionId,
          id: request.id,
          method: request.method,
        });
      } catch (error) {
        sendAcpPayloadDirect(frame.connectionId, {
          error: {
            code: -32002,
            message:
              "Remote daemon could not persist request receipt before handing it to the runtime.",
          },
          id: request.id,
          jsonrpc: "2.0",
        });
        closeRemoteConnection(
          frame.connectionId,
          "request_journal_failed",
          error instanceof Error ? error.message : "Request journal failed.",
        );
        return;
      }
    }
    if (request) {
      rememberInFlightRuntimeRequest(frame.connectionId, request);
    }
    if (!entry.channel.enqueue(frame.payload as AnyMessage)) {
      forgetInFlightRuntimeRequest(frame.connectionId, request?.id);
      closeRemoteConnection(
        frame.connectionId,
        "acp_connection_closed",
        "ACP connection closed before receiving relay frame.",
      );
      return;
    }
    entry.lastInboundSeq = frame.seq;
    sendRelayAck(frame.connectionId, frame.seq);
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
      replayAcpOutboundFrames(frame.connectionId);
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
    inFlightRuntimeRequests.delete(connectionId);
    relayRequestContexts.delete(connectionId);
    tickets.delete(connectionId);
    outboundSeq.delete(connectionId);
    sendSocket(
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
    sendSocket(
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
    sendSocket(
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
    forgetCompletedInFlightRuntimeRequest(connectionId, payload);
    const entry = active.get(connectionId);
    if (!entry) {
      return;
    }
    rememberDaemonRequestResponse(connectionId, payload);
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
    if (
      !state.socket ||
      entry.pendingOutboundFrames.size >= maxBufferedFramesPerConnection
    ) {
      entry.outboundQueue.push(frame);
      return;
    }
    sendQueuedAcpFrame(entry, frame);
  };

  const sendAcpPayloadDirect = (connectionId: string, payload: AnyMessage) => {
    forgetCompletedInFlightRuntimeRequest(connectionId, payload);
    rememberDaemonRequestResponse(connectionId, payload);
    logDaemonAcpPayload(connectionId, payload);
    const seq = (outboundSeq.get(connectionId) ?? 0) + 1;
    outboundSeq.set(connectionId, seq);
    sendSocket(
      JSON.stringify({
        channelId: "acp",
        channelKind: AcpRemoteChannelKind.Acp,
        connectionId,
        frameType: AcpRemoteFrameType.Data,
        payload,
        seq,
      } satisfies AcpRemoteDataFrame),
    );
  };

  const rememberDaemonRequestResponse = (
    connectionId: string,
    payload: AnyMessage,
  ) => {
    if (!options.requestJournal || !isJsonRpcResponseWithId(payload)) {
      return;
    }
    const context = relayRequestContexts.get(connectionId)?.get(payload.id);
    void options.requestJournal
      .markCompleted({
        connectionId,
        id: payload.id,
        method: context?.method,
        payload,
      })
      .catch((error) => {
        debugLog(
          `Failed to persist remote daemon request response: ${error instanceof Error ? error.message : error}`,
          {
            connectionId,
            jsonRpcId: payload.id,
            method: context?.method,
            severityText: "ERROR",
          },
        );
      });
  };

  const rememberInFlightRuntimeRequest = (
    connectionId: string,
    request: { id: string | number; method: string },
  ) => {
    const context = relayRequestContexts.get(connectionId)?.get(request.id);
    requestContextMap(inFlightRuntimeRequests, connectionId).set(request.id, {
      method: context?.method ?? request.method,
      sessionId: context?.sessionId,
      traceContext: context?.traceContext,
    });
  };

  const forgetCompletedInFlightRuntimeRequest = (
    connectionId: string,
    payload: AnyMessage,
  ) => {
    if (!isJsonRpcResponseWithId(payload)) {
      return;
    }
    forgetInFlightRuntimeRequest(connectionId, payload.id);
  };

  const forgetInFlightRuntimeRequest = (
    connectionId: string,
    id: string | number | undefined,
  ) => {
    if (id === undefined) {
      return;
    }
    const requests = inFlightRuntimeRequests.get(connectionId);
    if (!requests) {
      return;
    }
    requests.delete(id);
    if (requests.size === 0) {
      inFlightRuntimeRequests.delete(connectionId);
      closeDeferredConnectionIfIdle(connectionId);
    }
  };

  const hasInFlightRuntimeRequests = (connectionId: string): boolean =>
    (inFlightRuntimeRequests.get(connectionId)?.size ?? 0) > 0;

  const closeDeferredConnectionIfIdle = (connectionId: string) => {
    const entry = active.get(connectionId);
    if (!entry?.closeAfterInFlight || hasInFlightRuntimeRequests(connectionId)) {
      return;
    }
    entry.channel.close();
    active.delete(connectionId);
  };

  const resolveDaemonRequestDuplicate = async (
    connectionId: string,
    request: { id: string | number; method: string },
  ): Promise<AnyMessage | undefined> => {
    if (!options.requestJournal) {
      return undefined;
    }
    const entry = await options.requestJournal.lookup(connectionId, request.id);
    if (!entry) {
      return undefined;
    }
    if (entry.status === "completed" && entry.payload) {
      return entry.payload;
    }
    return {
      error: {
        code: -32003,
        data: {
          method: entry.method ?? request.method,
          status: entry.status,
        },
        message:
          "Remote daemon already delivered this request to the runtime before restart; the result is unknown and the request was not replayed.",
      },
      id: request.id,
      jsonrpc: "2.0",
    };
  };

  const sendQueuedAcpFrame = (
    entry: ActiveRelayAcpConnection,
    frame: AcpRemoteDataFrame,
  ) => {
    entry.pendingOutboundFrames.set(frame.seq, frame);
    sendSocket(JSON.stringify(frame));
  };

  const replayAcpOutboundFrames = (connectionId: string) => {
    const entry = active.get(connectionId);
    if (!entry || !state.socket) {
      return;
    }
    for (const frame of [...entry.pendingOutboundFrames.values()].sort(
      (left, right) => left.seq - right.seq,
    )) {
      sendSocket(JSON.stringify(frame));
    }
    flushAcpOutboundQueue(connectionId, entry);
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
    if (state.socket === options.socket) {
      state.socket = undefined;
    }
  };

  const disposeState = () => {
    for (const entry of active.values()) {
      entry.channel.close();
    }
    active.clear();
    daemonRequestContexts.clear();
    inFlightRuntimeRequests.clear();
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
      if (disposed) {
        return;
      }
      disposed = true;
      options.socket.removeEventListener?.("message", onMessage);
      options.socket.removeEventListener?.("close", onClose);
      options.socket.removeEventListener?.("error", onClose);
      if (state.socket === options.socket) {
        state.socket = undefined;
      }
      disposeState();
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

function isJsonRpcResponseWithId(
  payload: AnyMessage,
): payload is AnyMessage & { id: string | number } {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const candidate = payload as {
    id?: unknown;
    jsonrpc?: unknown;
    method?: unknown;
  };
  return (
    candidate.jsonrpc === "2.0" &&
    candidate.method === undefined &&
    (typeof candidate.id === "string" || typeof candidate.id === "number")
  );
}

function readJournalableJsonRpcRequest(
  payload: unknown,
): { id: string | number; method: string } | undefined {
  if (!isJsonRpcRequest(payload)) {
    return undefined;
  }
  if (typeof payload.id !== "string" && typeof payload.id !== "number") {
    return undefined;
  }
  return {
    id: payload.id,
    method: payload.method,
  };
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

  enqueue(message: AnyMessage): boolean {
    if (this.closed) {
      return false;
    }
    this.controller?.enqueue(message);
    return true;
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
