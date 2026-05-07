import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type {
  AcpWebSocketEventListener,
  AcpWebSocketLike,
  AcpWebSocketMessageListener,
} from "../protocol/websocket-stream.js";
import { createAcpRemoteStdioBridge } from "./stdio-bridge.js";

describe("createAcpRemoteStdioBridge", () => {
  it("injects trace metadata and reuses it for response debug context", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const debugContexts: {
      direction?: string;
      traceId?: string;
    }[] = [];
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      debugLog(_message, context) {
        if (context) {
          debugContexts.push(context);
        }
      },
      input,
      output,
      relayUrl: "ws://relay.test",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      input.write(
        `${JSON.stringify({
          id: 4,
          jsonrpc: "2.0",
          method: "session/load",
          params: { sessionId: "session-1" },
        })}\n`,
      );
      await waitFor(() => sockets[0]?.sent.length === 1);

      const outbound = JSON.parse(sockets[0]!.sent[0]) as {
        params?: { _meta?: { traceparent?: unknown } };
      };
      const traceparent = outbound.params?._meta?.traceparent;
      expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      const traceId = String(traceparent).split("-")[1];

      sockets[0]?.emitMessage(
        JSON.stringify({
          id: 4,
          jsonrpc: "2.0",
          result: { sessionId: "session-1" },
        }),
      );

      await waitFor(() =>
        debugContexts.some(
          (context) =>
            context.direction === "relay_to_client" &&
            context.traceId === traceId,
        ),
      );
    } finally {
      bridge.close();
    }
  });

  it("bounds outbound requests while the relay is reconnecting", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      input,
      output,
      reconnect: {
	        maxDelayMs: 1_000,
	        maxQueuedMessages: 1,
	        minDelayMs: 1_000,
	      },
      relayUrl: "ws://relay.test",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      input.write(
        `${JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "initialize",
          params: {},
        })}\n`,
      );
      await waitFor(() => sockets[0]?.sent.length === 1);

      sockets[0]?.emitClose();
      input.write(
        `${JSON.stringify({
          id: 2,
          jsonrpc: "2.0",
          method: "session/list",
          params: {},
        })}\n`,
      );
      input.write(
        `${JSON.stringify({
          id: 3,
          jsonrpc: "2.0",
          method: "session/list",
          params: {},
        })}\n`,
      );

      await waitFor(() => outputText.includes("reconnect queue is full"));

      const response = JSON.parse(outputText.trim()) as {
        error?: { code?: unknown; message?: unknown };
        id?: unknown;
      };
      expect(response).toMatchObject({
        error: {
          code: -32002,
          message: "ACP relay is temporarily unavailable: reconnect queue is full.",
        },
        id: 3,
      });
    } finally {
      bridge.close();
    }
  });

	  it("acknowledges relay responses after writing them to stdio", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      input,
      output,
      relayUrl: "ws://relay.test",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      input.write(
        `${JSON.stringify({
          id: 9,
          jsonrpc: "2.0",
          method: "session/load",
          params: { sessionId: "session-1" },
        })}\n`,
      );
      await waitFor(() => sockets[0]?.sent.length === 1);

      sockets[0]?.emitMessage(
        JSON.stringify({
          id: 9,
          jsonrpc: "2.0",
          result: { sessionId: "session-1" },
        }),
      );

      await waitFor(() =>
        sockets[0]?.sent.some((message) =>
          message.includes("acp-runtime/remote/client_ack"),
        ) ?? false,
      );
      expect(outputText).toContain('"id":9');
      expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toMatchObject({
        jsonrpc: "2.0",
        method: "acp-runtime/remote/client_ack",
        params: { id: 9 },
      });

      sockets[0]?.emitMessage(
        JSON.stringify({
          id: 9,
          jsonrpc: "2.0",
          result: { sessionId: "session-1" },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(outputText.trim().split("\n")).toHaveLength(1);
    } finally {
      bridge.close();
    }
  });
});

class TestSocket implements AcpWebSocketLike {
  readonly sent: string[] = [];
  private readonly closeListeners = new Set<AcpWebSocketEventListener>();
  private readonly errorListeners = new Set<AcpWebSocketEventListener>();
  private readonly messageListeners = new Set<AcpWebSocketMessageListener>();

  addEventListener(
    type: "close" | "error",
    listener: AcpWebSocketEventListener,
  ): void;
  addEventListener(
    type: "message",
    listener: AcpWebSocketMessageListener,
  ): void;
  addEventListener(
    type: "close" | "error" | "message",
    listener: AcpWebSocketEventListener | AcpWebSocketMessageListener,
  ): void {
    if (type === "close") {
      this.closeListeners.add(listener as AcpWebSocketEventListener);
    } else if (type === "error") {
      this.errorListeners.add(listener as AcpWebSocketEventListener);
    } else {
      this.messageListeners.add(listener as AcpWebSocketMessageListener);
    }
  }

  close(): void {
    this.emitClose();
  }

  emitClose(): void {
    for (const listener of this.closeListeners) {
      listener();
    }
  }

  emitMessage(data: string): void {
    for (const listener of this.messageListeners) {
      listener({ data });
    }
  }

  removeEventListener(
    type: "close" | "error",
    listener: AcpWebSocketEventListener,
  ): void;
  removeEventListener(
    type: "message",
    listener: AcpWebSocketMessageListener,
  ): void;
  removeEventListener(
    type: "close" | "error" | "message",
    listener: AcpWebSocketEventListener | AcpWebSocketMessageListener,
  ): void {
    if (type === "close") {
      this.closeListeners.delete(listener as AcpWebSocketEventListener);
    } else if (type === "error") {
      this.errorListeners.delete(listener as AcpWebSocketEventListener);
    } else {
      this.messageListeners.delete(listener as AcpWebSocketMessageListener);
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}
