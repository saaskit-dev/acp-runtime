import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type AnyMessage,
  type Client,
} from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { createStdioAcpConnectionFactory } from "../../acp/stdio-connection.js";
import { AcpRuntime } from "../../core/runtime.js";
import { SIMULATOR_AGENT_ACP_REGISTRY_ID } from "../../agents/simulator-agent-acp.js";
import { resolveBuiltSimulatorWorkspaceCliPath } from "../../registry/simulator-workspace.js";
import {
  AcpRuntimeTurnEventType,
  type AcpRuntimePrompt,
} from "../../core/types.js";
import type { AcpRuntimeSession } from "../../core/session.js";
import {
  AcpRemoteChannelKind,
  AcpRemoteEndpointKind,
  AcpRemoteFrameType,
  assertAcpRemoteFrame,
  ACP_REMOTE_PROTOCOL_VERSION,
  createAcpRemoteSignedConnectionTicket,
  createAcpJsonRpcWebSocketStream,
  type AcpRemoteDataFrame,
  type AcpRemoteSignedConnectionTicket,
} from "../protocol/index.js";
import { createAcpRemoteDaemonConnection } from "./relay-connection.js";

const tempDirs: string[] = [];
const relayTicketKey = {
  kid: "test-key",
  secret: "relay-ticket-secret",
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("ACP remote daemon relay connection", () => {
  it("responds to relay ping frames with pong frames", async () => {
    const [daemonSocket, relaySocket] = createMemoryWebSocketPair();
    const pongFrames: unknown[] = [];
    relaySocket.addEventListener("message", (event) => {
      const frame = assertAcpRemoteFrame(JSON.parse(String(event.data)));
      if (frame.frameType === AcpRemoteFrameType.Pong) {
        pongFrames.push(frame);
      }
    });

    const daemon = createAcpRemoteDaemonConnection({
      agent: {
        command: process.execPath,
        type: SIMULATOR_AGENT_ACP_REGISTRY_ID,
      },
      hostId: "host-smoke",
      runtime: createUnusedRuntime(),
      socket: daemonSocket,
      ticketVerificationKeys: [relayTicketKey],
    });

    relaySocket.send(
      JSON.stringify({
        connectionId: "daemon:host-smoke",
        frameType: AcpRemoteFrameType.Ping,
        nonce: "ping-1",
      }),
    );

    await waitFor(() => pongFrames.length > 0);
    expect(pongFrames[0]).toMatchObject({
      connectionId: "daemon:host-smoke",
      frameType: AcpRemoteFrameType.Pong,
      nonce: "ping-1",
    });
    daemon.close();
  });

  it("rejects ACP data before a valid connection ticket", async () => {
    const [daemonSocket, relaySocket] = createMemoryWebSocketPair();
    const closeFrames: unknown[] = [];
    relaySocket.addEventListener("message", (event) => {
      const frame = assertAcpRemoteFrame(JSON.parse(String(event.data)));
      if (frame.frameType === AcpRemoteFrameType.Close) {
        closeFrames.push(frame);
      }
    });

    const daemon = createAcpRemoteDaemonConnection({
      agent: {
        command: process.execPath,
        type: SIMULATOR_AGENT_ACP_REGISTRY_ID,
      },
      hostId: "host-smoke",
      runtime: createUnusedRuntime(),
      socket: daemonSocket,
      ticketVerificationKeys: [relayTicketKey],
    });

    relaySocket.send(
      JSON.stringify({
        channelId: "acp",
        channelKind: AcpRemoteChannelKind.Acp,
        connectionId: "conn-without-ticket",
        frameType: AcpRemoteFrameType.Data,
        payload: {
          id: 1,
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
          },
        },
        seq: 1,
      } satisfies AcpRemoteDataFrame),
    );

    await waitFor(() => closeFrames.length > 0);
    expect(closeFrames[0]).toMatchObject({
      code: "missing_ticket",
      connectionId: "conn-without-ticket",
      frameType: AcpRemoteFrameType.Close,
    });
    daemon.close();
  });

  it("rejects scoped ACP methods missing from the connection ticket", async () => {
    const [nativeClientSocket, nativeRelaySocket] = createMemoryWebSocketPair();
    const [daemonSocket, daemonRelaySocket] = createMemoryWebSocketPair();
    const ticket = await createAcpRemoteSignedConnectionTicket({
      connectionId: "conn-limited",
      grant: {
        accountId: "acct-smoke",
        clientDeviceId: "client-smoke",
        hostId: "host-smoke",
        policyVersion: 1,
        scopes: ["acp:connect"],
      },
      jti: "ticket-limited",
      key: relayTicketKey,
      now: new Date("2026-04-27T00:00:00.000Z"),
      ttlMs: 60_000,
    });
    bindNativeRelaySockets({
      connectionId: "conn-limited",
      daemonRelaySocket,
      nativeRelaySocket,
      ticket,
    });

    const daemon = createAcpRemoteDaemonConnection({
      agent: {
        command: process.execPath,
        type: SIMULATOR_AGENT_ACP_REGISTRY_ID,
      },
      hostId: "host-smoke",
      now: () => new Date("2026-04-27T00:00:30.000Z"),
      runtime: createUnusedRuntime(),
      socket: daemonSocket,
      ticketVerificationKeys: [relayTicketKey],
    });

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return {
              outcome: {
                optionId: "allow_once",
                outcome: "selected",
              },
            };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      createAcpJsonRpcWebSocketStream(nativeClientSocket),
    );

    await expect(
      clientConnection.initialize({
        clientCapabilities: {},
        protocolVersion: PROTOCOL_VERSION,
      }),
    ).resolves.toMatchObject({
      agentInfo: {
        name: "acp-runtime-remote",
      },
    });
    await expect(
      clientConnection.newSession({
        cwd: "/tmp/project",
        mcpServers: [],
      }),
    ).rejects.toMatchObject({
      code: -32000,
      data: {
        requiredScope: "acp:session:create",
      },
    });
    await expect(
      clientConnection.setSessionMode({
        modeId: "plan",
        sessionId: "session-1",
      }),
    ).rejects.toMatchObject({
      code: -32000,
      data: {
        requiredScope: "acp:session:resume",
      },
    });

    nativeClientSocket.close();
    daemon.close();
  });

  it("uses workspace roots from the connection ticket", async () => {
    const [nativeClientSocket, nativeRelaySocket] = createMemoryWebSocketPair();
    const [daemonSocket, daemonRelaySocket] = createMemoryWebSocketPair();
    const ticket = await createAcpRemoteSignedConnectionTicket({
      connectionId: "conn-workspace-policy",
      grant: {
        accountId: "acct-smoke",
        clientDeviceId: "client-smoke",
        hostId: "host-smoke",
        policyVersion: 1,
        scopes: ["acp:connect", "acp:session:create"],
        workspaceRoots: ["/ticket-allowed"],
      },
      jti: "ticket-workspace-policy",
      key: relayTicketKey,
      now: new Date("2026-04-27T00:00:00.000Z"),
      ttlMs: 60_000,
    });
    bindNativeRelaySockets({
      connectionId: "conn-workspace-policy",
      daemonRelaySocket,
      nativeRelaySocket,
      ticket,
    });
    const startCwds: string[] = [];

    const daemon = createAcpRemoteDaemonConnection({
      agent: {
        command: "fake-agent",
        type: "fake",
      },
      hostId: "host-smoke",
      now: () => new Date("2026-04-27T00:00:30.000Z"),
      runtime: {
        sessions: {
          async list() {
            return { sessions: [] };
          },
          async load() {
            throw new Error("Unexpected remote load.");
          },
          async resume() {
            throw new Error("Unexpected remote resume.");
          },
          async start(options) {
            startCwds.push(options.cwd);
            return createFakeRuntimeSession();
          },
        },
      },
      socket: daemonSocket,
      ticketVerificationKeys: [relayTicketKey],
      workspaceRoots: ["/option-allowed"],
    });

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return {
              outcome: {
                optionId: "allow_once",
                outcome: "selected",
              },
            };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      createAcpJsonRpcWebSocketStream(nativeClientSocket),
    );
    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    await expect(
      clientConnection.newSession({
        cwd: "/ticket-allowed/project",
        mcpServers: [],
      }),
    ).resolves.toMatchObject({
      sessionId: "runtime-session-1",
    });
    await expect(
      clientConnection.newSession({
        cwd: "/option-allowed/project",
        mcpServers: [],
      }),
    ).rejects.toMatchObject({
      code: -32602,
    });
    expect(startCwds).toEqual(["/ticket-allowed/project"]);

    nativeClientSocket.close();
    daemon.close();
  });

  it("acks inbound ACP frames and ignores duplicate seq replays", async () => {
    const [daemonSocket, relaySocket] = createMemoryWebSocketPair();
    let startCalls = 0;
    const outboundFrames: AcpRemoteFrame[] = [];
    const ticket = await createAcpRemoteSignedConnectionTicket({
      connectionId: "conn-dup",
      grant: {
        accountId: "acct-smoke",
        clientDeviceId: "client-smoke",
        hostId: "host-smoke",
        policyVersion: 1,
        scopes: ["acp:connect", "acp:session:create"],
      },
      jti: "ticket-dup",
      key: relayTicketKey,
      now: new Date("2026-04-27T00:00:00.000Z"),
      ttlMs: 60_000,
    });
    relaySocket.addEventListener("message", (event) => {
      outboundFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });

    const daemon = createAcpRemoteDaemonConnection({
      agent: {
        command: "fake-agent",
        type: "fake",
      },
      hostId: "host-smoke",
      now: () => new Date("2026-04-27T00:00:30.000Z"),
      runtime: {
        sessions: {
          async list() {
            return { sessions: [] };
          },
          async load() {
            throw new Error("Unexpected remote load.");
          },
          async resume() {
            throw new Error("Unexpected remote resume.");
          },
          async start() {
            startCalls += 1;
            return createFakeRuntimeSession();
          },
        },
      },
      socket: daemonSocket,
      ticketVerificationKeys: [relayTicketKey],
    });

    relaySocket.send(
      JSON.stringify({
        connectionId: "conn-dup",
        endpoint: AcpRemoteEndpointKind.Client,
        frameType: AcpRemoteFrameType.Hello,
        hostId: "host-smoke",
        protocolVersion: ACP_REMOTE_PROTOCOL_VERSION,
        ticket,
      }),
    );
    relaySocket.send(
      JSON.stringify({
        channelId: "acp",
        channelKind: AcpRemoteChannelKind.Acp,
        connectionId: "conn-dup",
        frameType: AcpRemoteFrameType.Data,
        payload: {
          id: 1,
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            clientCapabilities: {},
            protocolVersion: PROTOCOL_VERSION,
          },
        },
        seq: 1,
      } satisfies AcpRemoteDataFrame),
    );
    await waitFor(() =>
      outboundFrames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          isJsonRpcResultPayload(frame.payload, 1),
      ),
    );
    outboundFrames.length = 0;

    relaySocket.send(
      JSON.stringify({
        channelId: "acp",
        channelKind: AcpRemoteChannelKind.Acp,
        connectionId: "conn-dup",
        frameType: AcpRemoteFrameType.Data,
        payload: {
          id: 2,
          jsonrpc: "2.0",
          method: "session/new",
          params: {
            cwd: "/tmp/project",
            mcpServers: [],
          },
        },
        seq: 2,
      } satisfies AcpRemoteDataFrame),
    );
    relaySocket.send(
      JSON.stringify({
        channelId: "acp",
        channelKind: AcpRemoteChannelKind.Acp,
        connectionId: "conn-dup",
        frameType: AcpRemoteFrameType.Data,
        payload: {
          id: 2,
          jsonrpc: "2.0",
          method: "session/new",
          params: {
            cwd: "/tmp/project",
            mcpServers: [],
          },
        },
        seq: 2,
      } satisfies AcpRemoteDataFrame),
    );

    await waitFor(
      () =>
        outboundFrames.filter((frame) => frame.frameType === AcpRemoteFrameType.Ack)
          .length >= 2 &&
        outboundFrames.filter(
          (frame) =>
            frame.frameType === AcpRemoteFrameType.Data &&
            isJsonRpcResultPayload(frame.payload, 2),
        ).length >= 1,
    );
    expect(startCalls).toBe(1);
    expect(
      outboundFrames.filter(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          isJsonRpcResultPayload(frame.payload, 2),
      ),
    ).toHaveLength(1);

    daemon.close();
  });

  it("runs a native ACP client prompt through relay frames into simulator-backed runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-remote-smoke-"));
    const projectDir = join(root, "project");
    const storageDir = join(root, "simulator-storage");
    await mkdir(projectDir, { recursive: true });
    await mkdir(storageDir, { recursive: true });
    tempDirs.push(root);

    const [nativeClientSocket, nativeRelaySocket] = createMemoryWebSocketPair();
    const [daemonSocket, daemonRelaySocket] = createMemoryWebSocketPair();
    const ticket = await createAcpRemoteSignedConnectionTicket({
      connectionId: "conn-smoke",
      grant: {
        accountId: "acct-smoke",
        clientDeviceId: "client-smoke",
        hostId: "host-smoke",
        policyVersion: 1,
        scopes: [
          "acp:connect",
          "acp:session:create",
          "acp:session:resume",
          "acp:turn:send",
        ],
      },
      jti: "ticket-smoke",
      key: relayTicketKey,
      now: new Date("2026-04-27T00:00:00.000Z"),
      ttlMs: 60_000,
    });
    bindNativeRelaySockets({
      connectionId: "conn-smoke",
      daemonRelaySocket,
      nativeRelaySocket,
      ticket,
    });

    const runtime = new AcpRuntime(createStdioAcpConnectionFactory());
    const daemon = createAcpRemoteDaemonConnection({
      agent: {
        args: [resolveBuiltSimulatorWorkspaceCliPath(), "--storage-dir", storageDir],
        command: process.execPath,
        type: SIMULATOR_AGENT_ACP_REGISTRY_ID,
      },
      hostId: "host-smoke",
      now: () => new Date("2026-04-27T00:00:30.000Z"),
      runtime,
      socket: daemonSocket,
      ticketVerificationKeys: [relayTicketKey],
    });

    const notifications: unknown[] = [];
    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return {
              outcome: {
                optionId: "allow_once",
                outcome: "selected",
              },
            };
          },
          async sessionUpdate(params) {
            notifications.push(params);
          },
        }) satisfies Client,
      createAcpJsonRpcWebSocketStream(nativeClientSocket),
    );

    const initialize = await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(initialize.agentInfo?.name).toBe("acp-runtime-remote");

    const session = await clientConnection.newSession({
      cwd: projectDir,
      mcpServers: [],
    });
    expect(session.sessionId).toBeTruthy();

    const response = await clientConnection.prompt({
      prompt: [{ text: "/help", type: "text" }],
      sessionId: session.sessionId,
    });
    expect(response.stopReason).toBe("end_turn");
    expect(
      notifications.some(
        (notification) =>
          isAcpTextNotification(notification) &&
          notification.update.content.text.includes("Simulator Agent ACP"),
      ),
    ).toBe(true);

    await clientConnection.closeSession({ sessionId: session.sessionId });
    daemon.close();
  });
});

class MemoryWebSocket {
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<() => void>();
  private readonly messageListeners = new Set<(event: { data: unknown }) => void>();
  private closed = false;
  peer?: MemoryWebSocket;

  addEventListener(type: "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: "close" | "error" | "message",
    listener: (() => void) | ((event: { data: unknown }) => void),
  ): void {
    if (type === "message") {
      this.messageListeners.add(listener as (event: { data: unknown }) => void);
    } else if (type === "close") {
      this.closeListeners.add(listener as () => void);
    } else {
      this.errorListeners.add(listener as () => void);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const listener of this.closeListeners) {
      listener();
    }
    this.peer?.close();
  }

  removeEventListener(type: "close" | "error", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(
    type: "close" | "error" | "message",
    listener: (() => void) | ((event: { data: unknown }) => void),
  ): void {
    if (type === "message") {
      this.messageListeners.delete(listener as (event: { data: unknown }) => void);
    } else if (type === "close") {
      this.closeListeners.delete(listener as () => void);
    } else {
      this.errorListeners.delete(listener as () => void);
    }
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

function createUnusedRuntime(): Parameters<
  typeof createAcpRemoteDaemonConnection
>[0]["runtime"] {
  return {
    sessions: {
      async list() {
        return { sessions: [] };
      },
      async load() {
        throw new Error("Unexpected remote load.");
      },
      async resume() {
        throw new Error("Unexpected remote resume.");
      },
      async start() {
        throw new Error("Unexpected remote start.");
      },
    },
  };
}

function createFakeRuntimeSession(): AcpRuntimeSession {
  return {
    agent: {
      listConfigOptions: () => [],
      listModes: () => [],
      setConfigOption: async () => {},
      setMode: async () => {},
    },
    capabilities: {
      agent: {
        prompt: true,
      },
      client: {},
    },
    close: async () => {},
    diagnostics: {},
    initialConfigReport: undefined,
    metadata: {
      id: "runtime-session-1",
      title: "Runtime Session",
    },
    queue: {
      policy: () => ({ delivery: "sequential" }),
      setPolicy: () => ({ delivery: "sequential" }),
    },
    snapshot: () => ({
      agent: {
        command: "fake-agent",
        type: "fake",
      },
      cwd: "/tmp/project",
      session: {
        id: "runtime-session-1",
      },
      version: 1,
    }),
    state: {} as AcpRuntimeSession["state"],
    status: "ready",
    turn: {
      cancel: async () => true,
      queue: {
        clear: () => 0,
        get: () => undefined,
        list: () => [],
        remove: () => false,
        sendNow: async () => false,
      },
      run: async () => "hello from runtime",
      send: async () => ({
        output: [{ text: "hello from runtime", type: "text" }],
        outputText: "hello from runtime",
        turnId: "turn-1",
      }),
      start: (_prompt: AcpRuntimePrompt) => ({
        completion: Promise.resolve({
          output: [{ text: "hello from runtime", type: "text" }],
          outputText: "hello from runtime",
          turnId: "turn-1",
        }),
        events: createTurnEvents(),
        turnId: "turn-1",
      }),
      stream: () => createTurnEvents(),
    },
  } as unknown as AcpRuntimeSession;
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

function createMemoryWebSocketPair(): [MemoryWebSocket, MemoryWebSocket] {
  const left = new MemoryWebSocket();
  const right = new MemoryWebSocket();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

function bindNativeRelaySockets(input: {
  connectionId: string;
  daemonRelaySocket: MemoryWebSocket;
  nativeRelaySocket: MemoryWebSocket;
  ticket: AcpRemoteSignedConnectionTicket;
}): void {
  let seq = 0;
  let helloSent = false;
  input.nativeRelaySocket.addEventListener("message", (event) => {
    if (!helloSent) {
      helloSent = true;
      input.daemonRelaySocket.send(
        JSON.stringify({
          connectionId: input.connectionId,
          endpoint: AcpRemoteEndpointKind.Client,
          frameType: AcpRemoteFrameType.Hello,
          hostId: input.ticket.payload.hostId,
          protocolVersion: ACP_REMOTE_PROTOCOL_VERSION,
          ticket: input.ticket,
        }),
      );
    }
    const payload = JSON.parse(String(event.data)) as AnyMessage;
    input.daemonRelaySocket.send(
      JSON.stringify({
        channelId: "acp",
        channelKind: AcpRemoteChannelKind.Acp,
        connectionId: input.connectionId,
        frameType: AcpRemoteFrameType.Data,
        payload,
        seq: ++seq,
      } satisfies AcpRemoteDataFrame),
    );
  });

  input.daemonRelaySocket.addEventListener("message", (event) => {
    const frame = assertAcpRemoteFrame(JSON.parse(String(event.data)));
    if (frame.frameType === AcpRemoteFrameType.Data) {
      input.nativeRelaySocket.send(JSON.stringify(frame.payload));
    }
  });
}

async function* createTurnEvents() {
  yield {
    turnId: "turn-1",
    type: AcpRuntimeTurnEventType.Started,
  };
  yield {
    output: [{ text: "hello from runtime", type: "text" }],
    outputText: "hello from runtime",
    turnId: "turn-1",
    type: AcpRuntimeTurnEventType.Completed,
  };
}

function isJsonRpcResultPayload(
  value: unknown,
  id: number,
): value is {
  id: number;
  jsonrpc: "2.0";
  result: unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    value.id === id &&
    "jsonrpc" in value &&
    value.jsonrpc === "2.0" &&
    "result" in value
  );
}

function isAcpTextNotification(value: unknown): value is {
  update: {
    content: {
      text: string;
      type: "text";
    };
    sessionUpdate: "agent_message_chunk";
  };
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "update" in value &&
    typeof value.update === "object" &&
    value.update !== null &&
    "sessionUpdate" in value.update &&
    value.update.sessionUpdate === "agent_message_chunk" &&
    "content" in value.update &&
    typeof value.update.content === "object" &&
    value.update.content !== null &&
    "text" in value.update.content &&
    typeof value.update.content.text === "string"
  );
}
