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

  it("queues outbound requests while the relay is reconnecting", async () => {
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
        maxDelayMs: 1,
        maxQueuedMessages: 1,
        minDelayMs: 1,
      },
      relayUrl: "ws://relay.test",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      await waitFor(() => sockets.length === 1);
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

      await waitFor(() => sockets.length === 2);
      await waitFor(() => sockets[1]!.sent.length === 2);
      expect(outputText).not.toContain("reconnect queue is full");
      expect(
        sockets[1]!.sent.map((message) => JSON.parse(message).id),
      ).toEqual([2, 3]);
    } finally {
      bridge.close();
    }
  });

  it("replays replayable in-flight requests after relay reconnect", async () => {
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
        maxDelayMs: 1,
        minDelayMs: 1,
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
          id: 4,
          jsonrpc: "2.0",
          method: "session/load",
          params: { sessionId: "session-1" },
        })}\n`,
      );
      await waitFor(() => sockets[0]?.sent.length === 1);
      sockets[0]?.emitClose();

      await waitFor(() => sockets.length === 2);
      await waitFor(() => sockets[1]!.sent.length === 1);
      expect(JSON.parse(sockets[1]!.sent[0])).toMatchObject({
        id: 4,
        method: "session/load",
      });

      sockets[1]?.emitMessage(
        JSON.stringify({
          id: 4,
          jsonrpc: "2.0",
          result: { sessionId: "session-1" },
        }),
      );

      await waitFor(() => outputText.includes('"id":4'));
      expect(JSON.parse(outputText.trim().split("\n")[0]!)).toMatchObject({
        id: 4,
        result: { sessionId: "session-1" },
      });
    } finally {
      bridge.close();
    }
  });

  it("replays session/prompt after relay reconnect", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      input,
      output,
      reconnect: {
        maxDelayMs: 1,
        minDelayMs: 1,
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
          id: 5,
          jsonrpc: "2.0",
          method: "session/prompt",
          params: {
            prompt: [{ content: "hi", type: "text" }],
            sessionId: "session-1",
          },
        })}\n`,
      );
      await waitFor(() => sockets[0]?.sent.length === 1);
      sockets[0]?.emitClose();

      await waitFor(() => sockets.length === 2);
      await waitFor(() => sockets[1]!.sent.length === 1);
      expect(JSON.parse(sockets[1]!.sent[0])).toMatchObject({
        id: 5,
        method: "session/prompt",
      });
    } finally {
      bridge.close();
    }
  });

  it("fails non-replayable in-flight requests when relay disconnects", async () => {
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
        maxDelayMs: 1,
        minDelayMs: 1,
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
          id: 6,
          jsonrpc: "2.0",
          method: "session/cancel",
          params: {
            sessionId: "session-1",
          },
        })}\n`,
      );
      await waitFor(() => sockets[0]?.sent.length === 1);
      sockets[0]?.emitClose();

      await waitFor(() => outputText.includes('"id":6'));
      expect(JSON.parse(outputText.trim().split("\n")[0]!)).toMatchObject({
        error: {
          code: -32001,
        },
        id: 6,
        jsonrpc: "2.0",
      });
      await waitFor(() => sockets.length === 2);
      expect(sockets[1]!.sent).toHaveLength(0);
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

  it("injects stable remote display config locally and intercepts its updates", async () => {
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
          id: 10,
          jsonrpc: "2.0",
          method: "session/new",
          params: { cwd: "/tmp/project", mcpServers: [] },
        })}\n`,
      );
      await waitFor(() => sockets[0]?.sent.length === 1);

      sockets[0]?.emitMessage(
        JSON.stringify({
          id: 10,
          jsonrpc: "2.0",
          result: {
            _meta: {
              "acp-runtime/remote/daemonId": "host-a",
              "acp-runtime/remote/sessionAgent": { id: "claude-acp" },
              "acp-runtime/remote/sessionMachine": "dev.local",
              "acp-runtime/remote/sessionWorkspaceRoots": ["/Users/dev/07"],
            },
            configOptions: [
              {
                currentValue: "real",
                id: "real-option",
                name: "Real Option",
                type: "string",
              },
            ],
            sessionId: "session-1",
          },
        }),
      );

      await waitFor(() => outputText.includes('"id":10'));
      const firstResponse = JSON.parse(outputText.trim().split("\n")[0]!) as {
        result: {
          configOptions: {
            currentValue?: string;
            id: string;
            options?: { name: string; value: string }[];
          }[];
        };
      };
      expect(firstResponse.result.configOptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "real-option" }),
          expect.objectContaining({
            currentValue: "dev.local",
            id: "acp-runtime.remote.context",
            options: [
              { name: "dev.local", value: "dev.local" },
              { name: "claude-acp", value: "claude-acp" },
              { name: "/Users/dev/07", value: "/Users/dev/07" },
              { name: "session-1", value: "session-1" },
            ],
          }),
        ]),
      );

      input.write(
        `${JSON.stringify({
          id: 11,
          jsonrpc: "2.0",
          method: "session/set_config_option",
          params: {
            configId: "acp-runtime.remote.context",
            sessionId: "session-1",
            value: "changed",
          },
        })}\n`,
      );

      await waitFor(() => outputText.includes('"id":11'));
      expect(
        sockets[0]!.sent.some((message) => {
          try {
            return JSON.parse(message).method === "session/set_config_option";
          } catch {
            return false;
          }
        }),
      ).toBe(false);
      const secondResponse = JSON.parse(outputText.trim().split("\n")[1]!) as {
        result: {
          configOptions: {
            currentValue?: string;
            id: string;
            options?: { name: string; value: string }[];
          }[];
        };
      };
      expect(secondResponse.result.configOptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            currentValue: "dev.local",
            id: "acp-runtime.remote.context",
            options: expect.arrayContaining([
              { name: "session-1", value: "session-1" },
            ]),
          }),
        ]),
      );
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
