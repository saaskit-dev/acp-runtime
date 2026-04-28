import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

export type AcpWebSocketMessageEvent = {
  data: unknown;
};

export type AcpWebSocketEventListener = () => void;

export type AcpWebSocketMessageListener = (
  event: AcpWebSocketMessageEvent,
) => void;

export type AcpWebSocketLike = {
  addEventListener(type: "close" | "error", listener: AcpWebSocketEventListener): void;
  addEventListener(type: "message", listener: AcpWebSocketMessageListener): void;
  close(code?: number, reason?: string): void;
  removeEventListener?(
    type: "close" | "error",
    listener: AcpWebSocketEventListener,
  ): void;
  removeEventListener?(
    type: "message",
    listener: AcpWebSocketMessageListener,
  ): void;
  send(data: string): void;
};

export function createAcpJsonRpcWebSocketStream(
  socket: AcpWebSocketLike,
): Stream {
  return {
    readable: createJsonRpcReadable(socket),
    writable: createJsonRpcWritable(socket),
  };
}

export function normalizeWebSocketMessageData(data: unknown): string | undefined {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data as unknown as Uint8Array);
  }
  return undefined;
}

function createJsonRpcReadable(
  socket: AcpWebSocketLike,
): ReadableStream<AnyMessage> {
  return new ReadableStream<AnyMessage>({
    start(controller) {
      let closed = false;
      const cleanup = () => {
        socket.removeEventListener?.("message", onMessage);
        socket.removeEventListener?.("close", onClose);
        socket.removeEventListener?.("error", onError);
      };
      const onMessage = (event: AcpWebSocketMessageEvent) => {
        if (closed) {
          return;
        }
        const text = normalizeWebSocketMessageData(event.data);
        if (!text) {
          return;
        }
        try {
          controller.enqueue(JSON.parse(text) as AnyMessage);
        } catch (error) {
          closed = true;
          cleanup();
          controller.error(error);
        }
      };
      const onClose = () => {
        if (closed) {
          return;
        }
        closed = true;
        cleanup();
        controller.close();
      };
      const onError = () => {
        if (closed) {
          return;
        }
        closed = true;
        cleanup();
        controller.error(new Error("ACP WebSocket stream failed."));
      };

      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onError);
    },
    cancel() {
      socket.close(1000, "ACP WebSocket stream cancelled.");
    },
  });
}

function createJsonRpcWritable(
  socket: AcpWebSocketLike,
): WritableStream<AnyMessage> {
  return new WritableStream<AnyMessage>({
    abort() {
      socket.close(1011, "ACP WebSocket stream aborted.");
    },
    close() {
      socket.close(1000, "ACP WebSocket stream closed.");
    },
    write(message) {
      socket.send(JSON.stringify(message));
    },
  });
}
