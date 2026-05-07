import {
  AcpRemoteChannelKind,
  AcpRemoteFrameType,
  type AcpRemoteAckFrame,
  type AcpRemoteDataFrame,
  type AcpRemoteFrame,
  type AcpRemotePongFrame,
} from "../protocol/types.js";
import { normalizeWebSocketMessageData, type AcpWebSocketLike } from "../protocol/websocket-stream.js";
import { parseFrame, createOutboundFrameTracker } from "../shared/frame-handler.js";

export type AcpRemoteClientConnectionOptions = {
  connectionId: string;
  socket: AcpWebSocketLike;
  transport: "native-acp" | "remote-frame";
  onMessage: (message: string) => void;
  onClose?: (event?: AcpRemoteClientCloseEvent) => void;
  onError?: (error: Error) => void;
};

export type AcpRemoteClientCloseEvent = {
  code?: number;
  reason?: string;
};

export type AcpRemoteClientConnectionHandle = {
  close(): void;
  send(message: string): void;
};

export function createAcpRemoteClientConnection(
  options: AcpRemoteClientConnectionOptions,
): AcpRemoteClientConnectionHandle {
  const { socket, connectionId, transport, onMessage, onClose, onError } = options;

  if (transport === "native-acp") {
    return createNativeAcpConnection({ socket, onMessage, onClose, onError });
  }

  return createRemoteFrameConnection({ connectionId, socket, onMessage, onClose, onError });
}

function createNativeAcpConnection(input: {
  socket: AcpWebSocketLike;
  onMessage: (message: string) => void;
  onClose?: (event?: AcpRemoteClientCloseEvent) => void;
  onError?: (error: Error) => void;
}): AcpRemoteClientConnectionHandle {
  const { socket, onMessage, onClose, onError } = input;
  let closed = false;
  const sender = createBufferedSocketSender(socket, () => closed);

  const onMessageHandler = (event: { data: unknown }) => {
    const text = normalizeWebSocketMessageData(event.data);
    if (text) {
      onMessage(text);
    }
  };

  const onCloseHandler = (event?: unknown) => {
    if (!closed) {
      closed = true;
      sender.dispose();
      onClose?.(normalizeCloseEvent(event));
    }
  };

  const onErrorHandler = () => {
    onError?.(new Error("WebSocket error."));
  };

  socket.addEventListener("message", onMessageHandler);
  socket.addEventListener("close", onCloseHandler);
  socket.addEventListener("error", onErrorHandler);

  return {
    send(message: string) {
      if (closed) return;
      sender.send(message);
    },
    close() {
      if (closed) return;
      closed = true;
      sender.dispose();
      socket.removeEventListener?.("message", onMessageHandler);
      socket.removeEventListener?.("close", onCloseHandler);
      socket.removeEventListener?.("error", onErrorHandler);
      socket.close(1000, "ACP client connection closed.");
    },
  };
}

function createRemoteFrameConnection(input: {
  connectionId: string;
  socket: AcpWebSocketLike;
  onMessage: (message: string) => void;
  onClose?: (event?: AcpRemoteClientCloseEvent) => void;
  onError?: (error: Error) => void;
}): AcpRemoteClientConnectionHandle {
  const { connectionId, socket, onMessage, onClose, onError } = input;
  let closed = false;
  const tracker = createOutboundFrameTracker();
  const sender = createBufferedSocketSender(socket, () => closed);

  const handleFrame = (frame: AcpRemoteFrame) => {
    if (frame.frameType === AcpRemoteFrameType.Ping) {
      const pong: AcpRemotePongFrame = {
        connectionId: frame.connectionId,
        frameType: AcpRemoteFrameType.Pong,
        nonce: frame.nonce,
      };
      sender.send(JSON.stringify(pong));
      return;
    }

    if (frame.frameType === AcpRemoteFrameType.Pong) {
      return;
    }

    if (frame.frameType === AcpRemoteFrameType.Ack) {
      tracker.handleAck(frame);
      return;
    }

    if (frame.frameType === AcpRemoteFrameType.Close) {
      closed = true;
      sender.dispose();
      socket.removeEventListener?.("message", onMessageHandler);
      socket.removeEventListener?.("close", onCloseHandler);
      socket.removeEventListener?.("error", onErrorHandler);
      onClose?.({
        reason: typeof frame.reason === "string" ? frame.reason : undefined,
      });
      return;
    }

    if (frame.frameType === AcpRemoteFrameType.Data && frame.channelKind === AcpRemoteChannelKind.Acp) {
      const ack: AcpRemoteAckFrame = {
        ack: frame.seq,
        channelId: "acp",
        connectionId,
        frameType: AcpRemoteFrameType.Ack,
      };
      sender.send(JSON.stringify(ack));
      onMessage(JSON.stringify(frame.payload));
    }
  };

  const onMessageHandler = (event: { data: unknown }) => {
    const text = normalizeWebSocketMessageData(event.data);
    if (!text) return;
    const frame = parseFrame(text);
    if (frame) {
      handleFrame(frame);
    }
  };

  const onCloseHandler = (event?: unknown) => {
    if (!closed) {
      closed = true;
      sender.dispose();
      onClose?.(normalizeCloseEvent(event));
    }
  };

  const onErrorHandler = () => {
    onError?.(new Error("WebSocket error."));
  };

  socket.addEventListener("message", onMessageHandler);
  socket.addEventListener("close", onCloseHandler);
  socket.addEventListener("error", onErrorHandler);

  const close = () => {
    if (closed) return;
    closed = true;
    sender.dispose();
    socket.removeEventListener?.("message", onMessageHandler);
    socket.removeEventListener?.("close", onCloseHandler);
    socket.removeEventListener?.("error", onErrorHandler);
    socket.close(1000, "ACP client connection closed.");
  };

  return {
    send(message: string) {
      if (closed) return;
      const seq = tracker.nextSeq(connectionId);
      const frame: AcpRemoteDataFrame = {
        channelId: "acp",
        channelKind: AcpRemoteChannelKind.Acp,
        connectionId,
        frameType: AcpRemoteFrameType.Data,
        payload: JSON.parse(message),
        seq,
      };
      tracker.trackOutbound(connectionId, frame);
      sender.send(JSON.stringify(frame));
    },
    close,
  };
}

function normalizeCloseEvent(event: unknown): AcpRemoteClientCloseEvent | undefined {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }
  const candidate = event as { code?: unknown; reason?: unknown };
  const code = typeof candidate.code === "number" ? candidate.code : undefined;
  let reason: string | undefined;
  if (typeof candidate.reason === "string") {
    reason = candidate.reason;
  } else if (candidate.reason instanceof Uint8Array) {
    reason = new TextDecoder().decode(candidate.reason);
  }
  return code === undefined && reason === undefined ? undefined : { code, reason };
}

function createBufferedSocketSender(
  socket: AcpWebSocketLike,
  isClosed: () => boolean,
): {
  dispose(): void;
  send(data: string): void;
} {
  const queue: string[] = [];
  const candidate = socket as AcpWebSocketLike & {
    addEventListener?(type: "open", listener: () => void): void;
    readyState?: number;
    removeEventListener?(type: "open", listener: () => void): void;
  };

  const isOpen = () =>
    typeof candidate.readyState !== "number" || candidate.readyState === 1;

  const flush = () => {
    if (isClosed() || !isOpen()) {
      return;
    }
    while (queue.length > 0) {
      const next = queue.shift();
      if (next !== undefined) {
        socket.send(next);
      }
    }
  };

  const onOpen = () => {
    flush();
  };
  if (!isOpen()) {
    candidate.addEventListener?.("open", onOpen);
  }

  return {
    dispose() {
      queue.length = 0;
      candidate.removeEventListener?.("open", onOpen);
    },
    send(data: string) {
      if (isClosed()) {
        return;
      }
      if (isOpen()) {
        socket.send(data);
        return;
      }
      queue.push(data);
    },
  };
}
