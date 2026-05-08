export type MemoryWebSocketCloseListener = (event?: {
  code?: number;
  reason?: string;
}) => void;
export type MemoryWebSocketMessageListener = (event: { data: unknown }) => void;

export class MemoryWebSocket {
  private readonly closeListeners = new Set<MemoryWebSocketCloseListener>();
  private readonly errorListeners = new Set<MemoryWebSocketCloseListener>();
  private readonly messageListeners = new Set<MemoryWebSocketMessageListener>();
  private attachment: unknown;
  private closed = false;
  peer?: MemoryWebSocket;

  accept(): void {}

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  serializeAttachment(attachment: unknown): void {
    this.attachment = attachment;
  }

  addEventListener(
    type: "close",
    listener: MemoryWebSocketCloseListener,
  ): void;
  addEventListener(
    type: "error",
    listener: MemoryWebSocketCloseListener,
  ): void;
  addEventListener(
    type: "message",
    listener: MemoryWebSocketMessageListener,
  ): void;
  addEventListener(
    type: "close" | "error" | "message",
    listener:
      | MemoryWebSocketCloseListener
      | MemoryWebSocketMessageListener,
  ): void {
    if (type === "message") {
      this.messageListeners.add(
        listener as MemoryWebSocketMessageListener,
      );
    } else if (type === "close") {
      this.closeListeners.add(listener as MemoryWebSocketCloseListener);
    } else {
      this.errorListeners.add(listener as MemoryWebSocketCloseListener);
    }
  }

  removeEventListener(
    type: "close",
    listener: MemoryWebSocketCloseListener,
  ): void;
  removeEventListener(
    type: "error",
    listener: MemoryWebSocketCloseListener,
  ): void;
  removeEventListener(
    type: "message",
    listener: MemoryWebSocketMessageListener,
  ): void;
  removeEventListener(
    type: "close" | "error" | "message",
    listener:
      | MemoryWebSocketCloseListener
      | MemoryWebSocketMessageListener,
  ): void {
    if (type === "message") {
      this.messageListeners.delete(
        listener as MemoryWebSocketMessageListener,
      );
    } else if (type === "close") {
      this.closeListeners.delete(listener as MemoryWebSocketCloseListener);
    } else {
      this.errorListeners.delete(listener as MemoryWebSocketCloseListener);
    }
  }

  close(code?: number, reason?: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const event = { code, reason };
    for (const listener of this.closeListeners) {
      listener(event);
    }
    this.peer?.close(code, reason);
  }

  send(data: string): void {
    if (this.closed) {
      return;
    }
    queueMicrotask(() => {
      this.peer?.receive(data);
    });
  }

  private receive(data: string): void {
    if (this.closed) {
      return;
    }
    for (const listener of this.messageListeners) {
      listener({ data });
    }
  }
}

export function createMemoryWebSocketPair(): [MemoryWebSocket, MemoryWebSocket] {
  const left = new MemoryWebSocket();
  const right = new MemoryWebSocket();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

export async function waitFor(
  predicate: () => boolean,
  maxAttempts?: number,
): Promise<void> {
  const limit = maxAttempts ?? 20;
  for (let attempt = 0; attempt < limit; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}
