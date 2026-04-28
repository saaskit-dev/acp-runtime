import {
  AgentSideConnection,
  type AnyMessage,
  type Stream,
} from "@agentclientprotocol/sdk";

import {
  AcpRemoteEndpointKind,
  AcpRemoteChannelKind,
  AcpRemoteFrameType,
  type AcpRemoteAckFrame,
  type AcpRemoteDataFrame,
  type AcpRemoteConnectionTicket,
  type AcpRemoteFrame,
  type AcpRemotePongFrame,
  type AcpRemoteScope,
} from "../protocol/types.js";
import {
  verifyAcpRemoteSignedConnectionTicket,
  type AcpRemoteTicketSigningKey,
} from "../protocol/tickets.js";
import {
  assertAcpRemoteFrame,
  hasAcpRemoteScope,
  isConnectionTicketExpired,
} from "../protocol/validation.js";
import {
  normalizeWebSocketMessageData,
  type AcpWebSocketLike,
} from "../protocol/websocket-stream.js";
import {
  AcpRemoteRuntimeAgent,
  type AcpRemoteRuntimeAgentOptions,
} from "./runtime-agent.js";

export type AcpRemoteDaemonConnectionOptions =
  AcpRemoteRuntimeAgentOptions & {
    hostId: string;
    maxBufferedFramesPerConnection?: number;
    now?: () => Date;
    requiredPolicyVersion?: number;
    socket: AcpWebSocketLike;
    ticketVerificationKeys: readonly [
      AcpRemoteTicketSigningKey,
      ...AcpRemoteTicketSigningKey[],
    ];
  };

export type AcpRemoteDaemonConnectionHandle = {
  close(): void;
};

type ActiveRelayAcpConnection = {
  channel: RelayAcpChannel;
  connection: AgentSideConnection;
  lastInboundSeq?: number;
  pendingOutboundFrames: Map<number, AcpRemoteDataFrame>;
};

const DEFAULT_MAX_BUFFERED_FRAMES_PER_CONNECTION = 64;

export function createAcpRemoteDaemonConnection(
  options: AcpRemoteDaemonConnectionOptions,
): AcpRemoteDaemonConnectionHandle {
  const active = new Map<string, ActiveRelayAcpConnection>();
  const outboundSeq = new Map<string, number>();
  const tickets = new Map<string, AcpRemoteConnectionTicket>();
  const ticketChecks = new Map<string, Promise<boolean>>();
  const maxBufferedFramesPerConnection =
    options.maxBufferedFramesPerConnection ??
    DEFAULT_MAX_BUFFERED_FRAMES_PER_CONNECTION;

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
      tickets.delete(frame.connectionId);
      ticketChecks.delete(frame.connectionId);
      return;
    }

    if (
      frame.frameType !== AcpRemoteFrameType.Data ||
      frame.channelKind !== AcpRemoteChannelKind.Acp
    ) {
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
    if (!ticket || !authorizeAcpPayload(frame.connectionId, ticket, frame.payload)) {
      return;
    }

    let entry = active.get(frame.connectionId);
    if (!entry) {
      const runtimeOptions = {
        ...options,
        workspaceRoots: ticket.workspaceRoots ?? options.workspaceRoots,
      };
      const channel = new RelayAcpChannel(frame.connectionId, sendAcpPayload);
      const connection = new AgentSideConnection(
        (agentConnection) =>
          new AcpRemoteRuntimeAgent(agentConnection, runtimeOptions),
        channel.stream,
      );
      entry = {
        channel,
        connection,
        lastInboundSeq: undefined,
        pendingOutboundFrames: new Map(),
      };
      active.set(frame.connectionId, entry);
      void connection.closed.finally(() => {
        active.delete(frame.connectionId);
        channel.close();
      });
    }

    sendRelayAck(frame.connectionId, frame.seq);
    if (
      entry.lastInboundSeq !== undefined &&
      frame.seq <= entry.lastInboundSeq
    ) {
      return;
    }
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

    try {
      const ticket = await verifyAcpRemoteSignedConnectionTicket(
        frame.ticket,
        options.ticketVerificationKeys,
        {
          connectionId: frame.connectionId,
          hostId: options.hostId,
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
    entry.pendingOutboundFrames.set(seq, frame);
    if (entry.pendingOutboundFrames.size > maxBufferedFramesPerConnection) {
      closeRemoteConnection(
        connectionId,
        "daemon_backpressure",
        "Buffered daemon outbound frame limit exceeded.",
      );
      return;
    }
    options.socket.send(JSON.stringify(frame));
  };

  const onClose = () => {
    for (const entry of active.values()) {
      entry.channel.close();
    }
    active.clear();
    outboundSeq.clear();
    tickets.clear();
    ticketChecks.clear();
  };

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

function parseFrame(text: string): AcpRemoteFrame | undefined {
  try {
    return assertAcpRemoteFrame(JSON.parse(text));
  } catch {
    return undefined;
  }
}

const ACP_METHOD_SCOPE_BY_METHOD = {
  "session/close": "acp:session:resume",
  "session/set_config_option": "acp:session:resume",
  "session/set_mode": "acp:session:resume",
  "session/fork": "acp:session:resume",
  "session/list": "acp:session:list",
  "session/load": "acp:session:resume",
  "session/new": "acp:session:create",
  "session/prompt": "acp:turn:send",
  "session/resume": "acp:session:resume",
} as const satisfies Record<string, AcpRemoteScope>;

const ACP_NOTIFICATION_SCOPE_BY_METHOD = {
  "session/cancel": "acp:turn:cancel",
} as const satisfies Record<string, AcpRemoteScope>;

function requiredScopeForAcpPayload(payload: unknown): AcpRemoteScope | undefined {
  if (!isJsonRpcMessage(payload)) {
    return undefined;
  }
  if (isJsonRpcRequest(payload)) {
    return readScope(ACP_METHOD_SCOPE_BY_METHOD, payload.method);
  }
  return readScope(ACP_NOTIFICATION_SCOPE_BY_METHOD, payload.method);
}

type JsonRpcMessage = JsonRpcNotification | JsonRpcRequest;

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
};

type JsonRpcRequest = JsonRpcNotification & {
  id: number | string | null;
};

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "jsonrpc" in value &&
    value.jsonrpc === "2.0" &&
    "method" in value &&
    typeof value.method === "string"
  );
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    isJsonRpcMessage(value) &&
    "id" in value &&
    (typeof value.id === "string" ||
      typeof value.id === "number" ||
      value.id === null)
  );
}

function readScope<const T extends Record<string, AcpRemoteScope>>(
  scopes: T,
  method: string,
): AcpRemoteScope | undefined {
  return Object.hasOwn(scopes, method)
    ? scopes[method as keyof T]
    : undefined;
}
