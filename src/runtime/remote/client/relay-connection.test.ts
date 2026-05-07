import { describe, expect, it } from "vitest";

import {
  AcpRemoteChannelKind,
  AcpRemoteFrameType,
} from "../protocol/types.js";
import { MemoryWebSocket, createMemoryWebSocketPair, waitFor } from "../shared/test-helpers.js";
import { createAcpRemoteClientConnection } from "./relay-connection.js";

describe("createAcpRemoteClientConnection", () => {
  describe("native-acp transport", () => {
    it("passes raw JSON-RPC through to onMessage", async () => {
      const [clientSocket, relaySocket] = createMemoryWebSocketPair();
      const received: string[] = [];

      const conn = createAcpRemoteClientConnection({
        connectionId: "test-conn",
        socket: clientSocket,
        transport: "native-acp",
        onMessage(msg) { received.push(msg); },
      });

      const jsonRpc = JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 });
      relaySocket.send(jsonRpc);

      await waitFor(() => received.length > 0);
      expect(received).toEqual([jsonRpc]);

      conn.close();
    });

    it("sends raw JSON-RPC to the socket", async () => {
      const [clientSocket, relaySocket] = createMemoryWebSocketPair();
      const sent: string[] = [];

      relaySocket.addEventListener("message", (e) => {
        if (typeof e.data === "string") sent.push(e.data);
      });

      const conn = createAcpRemoteClientConnection({
        connectionId: "test-conn",
        socket: clientSocket,
        transport: "native-acp",
        onMessage() {},
      });

      conn.send(JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }));

      await waitFor(() => sent.length > 0);
      expect(sent).toEqual([JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 })]);

      conn.close();
    });

    it("calls onClose when socket closes", async () => {
      const [clientSocket, relaySocket] = createMemoryWebSocketPair();
      let closed = false;

      createAcpRemoteClientConnection({
        connectionId: "test-conn",
        socket: clientSocket,
        transport: "native-acp",
        onMessage() {},
        onClose() { closed = true; },
      });

      relaySocket.close();
      await waitFor(() => closed);
      expect(closed).toBe(true);
    });
  });

  describe("remote-frame transport", () => {
    it("responds to Ping with Pong", async () => {
      const [clientSocket, relaySocket] = createMemoryWebSocketPair();
      const pongs: unknown[] = [];

      relaySocket.addEventListener("message", (e) => {
        if (typeof e.data === "string") {
          const parsed = JSON.parse(e.data);
          if (parsed.frameType === AcpRemoteFrameType.Pong) {
            pongs.push(parsed);
          }
        }
      });

      createAcpRemoteClientConnection({
        connectionId: "test-conn",
        socket: clientSocket,
        transport: "remote-frame",
        onMessage() {},
      });

      relaySocket.send(JSON.stringify({
        connectionId: "test-conn",
        frameType: AcpRemoteFrameType.Ping,
        nonce: "test-nonce",
      }));

      await waitFor(() => pongs.length > 0);
      expect(pongs).toEqual([
        expect.objectContaining({
          connectionId: "test-conn",
          frameType: AcpRemoteFrameType.Pong,
          nonce: "test-nonce",
        }),
      ]);
    });

    it("extracts Data payload and sends Ack", async () => {
      const [clientSocket, relaySocket] = createMemoryWebSocketPair();
      const received: string[] = [];
      const acks: unknown[] = [];

      relaySocket.addEventListener("message", (e) => {
        if (typeof e.data === "string") {
          const parsed = JSON.parse(e.data);
          if (parsed.frameType === AcpRemoteFrameType.Ack) {
            acks.push(parsed);
          }
        }
      });

      createAcpRemoteClientConnection({
        connectionId: "test-conn",
        socket: clientSocket,
        transport: "remote-frame",
        onMessage(msg) { received.push(msg); },
      });

      relaySocket.send(JSON.stringify({
        channelId: "acp",
        channelKind: AcpRemoteChannelKind.Acp,
        connectionId: "test-conn",
        frameType: AcpRemoteFrameType.Data,
        payload: { jsonrpc: "2.0", method: "initialize", id: 1 },
        seq: 1,
      }));

      await waitFor(() => received.length > 0);
      expect(received).toEqual([
        JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
      ]);

      await waitFor(() => acks.length > 0);
      expect(acks[0]).toMatchObject({
        ack: 1,
        channelId: "acp",
        connectionId: "test-conn",
        frameType: AcpRemoteFrameType.Ack,
      });
    });

    it("wraps send messages in Data frames with seq", async () => {
      const [clientSocket, relaySocket] = createMemoryWebSocketPair();
      const frames: unknown[] = [];

      relaySocket.addEventListener("message", (e) => {
        if (typeof e.data === "string") {
          frames.push(JSON.parse(e.data));
        }
      });

      const conn = createAcpRemoteClientConnection({
        connectionId: "test-conn",
        socket: clientSocket,
        transport: "remote-frame",
        onMessage() {},
      });

      conn.send(JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }));
      conn.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", id: 2 }));

      await waitFor(() => frames.length === 2);
      expect(frames[0]).toMatchObject({
        channelId: "acp",
        channelKind: AcpRemoteChannelKind.Acp,
        connectionId: "test-conn",
        frameType: AcpRemoteFrameType.Data,
        payload: { jsonrpc: "2.0", method: "initialize", id: 1 },
        seq: 1,
      });
      expect(frames[1]).toMatchObject({
        channelId: "acp",
        channelKind: AcpRemoteChannelKind.Acp,
        connectionId: "test-conn",
        frameType: AcpRemoteFrameType.Data,
        payload: { jsonrpc: "2.0", method: "initialized", id: 2 },
        seq: 2,
      });

      conn.close();
    });

    it("handles Close frame", async () => {
      const [clientSocket, relaySocket] = createMemoryWebSocketPair();
      let closed = false;

      createAcpRemoteClientConnection({
        connectionId: "test-conn",
        socket: clientSocket,
        transport: "remote-frame",
        onMessage() {},
        onClose() { closed = true; },
      });

      relaySocket.send(JSON.stringify({
        connectionId: "test-conn",
        frameType: AcpRemoteFrameType.Close,
        reason: "test",
      }));

      await waitFor(() => closed);
      expect(closed).toBe(true);
    });
  });
});
