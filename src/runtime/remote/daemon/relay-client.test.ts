import { describe, expect, it } from "vitest";

import { AcpRemoteFrameType } from "../protocol/types.js";
import {
  connectAcpRemoteDaemonRelay,
  createAcpRemoteDaemonRelayUrl,
  createAcpRemoteDaemonWebSocketFactory,
} from "./relay-client.js";

describe("ACP remote daemon relay client", () => {
  it("builds a daemon relay websocket url", () => {
    expect(
      createAcpRemoteDaemonRelayUrl({
        accountId: "acct-1",
        daemonId: "host-1",
        relayUrl: "https://relay.example.com/acp?foo=bar",
      }),
    ).toBe(
      "https://relay.example.com/daemon?foo=bar&accountId=acct-1&daemonId=host-1",
    );
  });

  it("creates signed registration headers and wires the daemon relay connection", async () => {
    const sent: string[] = [];
    const listeners = new Map<
      string,
      Set<(...args: unknown[]) => void>
    >();
    const socket = {
      addEventListener(type: string, listener: (...args: unknown[]) => void) {
        const bucket = listeners.get(type) ?? new Set();
        bucket.add(listener);
        listeners.set(type, bucket);
      },
      close() {},
      removeEventListener(type: string, listener: (...args: unknown[]) => void) {
        listeners.get(type)?.delete(listener);
      },
      send(data: string) {
        sent.push(data);
      },
    };

    const connected = await connectAcpRemoteDaemonRelay({
      accountId: "acct-1",
      agent: "simulator",
      daemonId: "host-1",
      daemonMetadata: {
        agentTypes: [{ id: "simulator-agent-acp-local", label: "Simulator" }],
        machine: "dev-mac",
        workspaceRoots: [{ path: "/Users/dev/acp-runtime" }],
      },
      relayUrl: "https://relay.example.com/acp",
      runtime: {
        sessions: {
          async list() {
            throw new Error("not used");
          },
          async load() {
            throw new Error("not used");
          },
          async resume() {
            throw new Error("not used");
          },
          async start() {
            throw new Error("not used");
          },
        },
      },
      ticketVerificationKeys: [
        {
          kid: "test-key",
          secret: "relay-ticket-secret",
        },
      ],
      socketFactory(input) {
        expect(input.url).toBe(
          "https://relay.example.com/daemon?accountId=acct-1&daemonId=host-1",
        );
        expect(input.headers["x-acp-account-id"]).toBe("acct-1");
        expect(input.headers["x-acp-daemon-id"]).toBe("host-1");
        expect(typeof input.headers["x-acp-daemon-signature"]).toBe("string");
        expect(typeof input.headers["x-acp-daemon-nonce"]).toBe("string");
        expect(typeof input.headers["x-acp-daemon-timestamp"]).toBe("string");
        expect(
          JSON.parse(input.headers["x-acp-daemon-metadata"] ?? "{}"),
        ).toMatchObject({
          machine: "dev-mac",
          workspaceRoots: [{ path: "/Users/dev/acp-runtime" }],
        });
        return socket;
      },
    });

    const pingListeners = listeners.get("message");
    expect(pingListeners?.size).toBe(1);
    for (const listener of pingListeners ?? []) {
      listener({
        data: JSON.stringify({
          connectionId: "heartbeat:host-1",
          frameType: AcpRemoteFrameType.Ping,
          nonce: "nonce-1",
        }),
      });
    }

    expect(sent).toContain(
      JSON.stringify({
        connectionId: "heartbeat:host-1",
        frameType: AcpRemoteFrameType.Pong,
        nonce: "nonce-1",
      }),
    );

    connected.close();
  });

  it("adapts websocket constructors that accept header options", () => {
    const calls: unknown[] = [];
    class HeaderWebSocket {
      constructor(
        url: string,
        protocols?: readonly string[] | string,
        options?: {
          headers?: Record<string, string>;
        },
      ) {
        calls.push({ options, protocols, url });
      }

      addEventListener(type: "close" | "error", listener: () => void): void;
      addEventListener(
        type: "message",
        listener: (event: { data: unknown }) => void,
      ): void;
      addEventListener(
        _type: "close" | "error" | "message",
        _listener: (() => void) | ((event: { data: unknown }) => void),
      ): void {}
      close() {}
      removeEventListener(type: "close" | "error", listener: () => void): void;
      removeEventListener(
        type: "message",
        listener: (event: { data: unknown }) => void,
      ): void;
      removeEventListener(
        _type: "close" | "error" | "message",
        _listener: (() => void) | ((event: { data: unknown }) => void),
      ): void {}
      send(_data: string) {}
    }

    const socketFactory = createAcpRemoteDaemonWebSocketFactory(HeaderWebSocket);
    socketFactory({
      headers: {
        "x-acp-daemon-signature": "signature",
      },
      url: "wss://relay.example.com/daemon",
    });

    expect(calls).toEqual([
      {
        options: {
          headers: {
            "x-acp-daemon-signature": "signature",
          },
        },
        protocols: undefined,
        url: "wss://relay.example.com/daemon",
      },
    ]);
  });
});
