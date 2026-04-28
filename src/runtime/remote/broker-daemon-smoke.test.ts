import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type Client,
} from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { AcpRelayInMemoryControlPlaneStore } from "../../../packages/relay-worker/src/control-plane-store.js";
import { AcpRelayBroker } from "../../../packages/relay-worker/src/relay-core.js";
import { createStdioAcpConnectionFactory } from "../acp/stdio-connection.js";
import { SIMULATOR_AGENT_ACP_REGISTRY_ID } from "../agents/simulator-agent-acp.js";
import { AcpRuntime } from "../core/runtime.js";
import { resolveBuiltSimulatorWorkspaceCliPath } from "../registry/simulator-workspace.js";
import { createAcpRemoteDaemonConnection } from "./daemon/relay-connection.js";
import { createAcpJsonRpcWebSocketStream } from "./protocol/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("ACP remote relay broker smoke", () => {
  it("runs native ACP through relay broker into a simulator-backed daemon", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-remote-broker-smoke-"));
    const projectDir = join(root, "project");
    const storageDir = join(root, "simulator-storage");
    await mkdir(projectDir, { recursive: true });
    await mkdir(storageDir, { recursive: true });
    tempDirs.push(root);

    const ticketSigningKey = {
      kid: "test-key",
      secret: "relay-ticket-secret",
    };
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-smoke" }],
        clientDevices: [
          {
            accountId: "acct-smoke",
            clientDeviceId: "native-acp-client",
          },
        ],
        grants: [
          {
            accountId: "acct-smoke",
            hostId: "host-smoke",
            policyVersion: 1,
            scopes: [
              "acp:connect",
              "acp:session:create",
              "acp:session:resume",
              "acp:turn:send",
            ],
          },
        ],
        hosts: [{ accountId: "acct-smoke", hostId: "host-smoke" }],
      }),
      ticketSigningKey,
    });

    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    bindBrokerClientSocket(broker, "conn-smoke", relayClientSocket);
    bindBrokerDaemonSocket(broker, relayDaemonSocket);

    const runtime = new AcpRuntime(createStdioAcpConnectionFactory());
    const daemon = createAcpRemoteDaemonConnection({
      agent: {
        args: [resolveBuiltSimulatorWorkspaceCliPath(), "--storage-dir", storageDir],
        command: process.execPath,
        type: SIMULATOR_AGENT_ACP_REGISTRY_ID,
      },
      hostId: "host-smoke",
      runtime,
      socket: daemonSocket,
      ticketVerificationKeys: [ticketSigningKey],
    });

    broker.registerDaemon("host-smoke", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-smoke",
      authUrl: "https://relay.test/authorize?connectionId=conn-smoke",
      connectionId: "conn-smoke",
      socket: relayClientSocket,
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
    void clientConnection.closed.catch(() => {});

    const initialize = await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(initialize.agentInfo?.name).toBe("acp-runtime-relay");

    const authentication = clientConnection.authenticate({
      methodId: "acp-runtime-browser",
    });
    await expect(
      broker.authorizeClient({
        connectionId: "conn-smoke",
        hostId: "host-smoke",
      }),
    ).resolves.toMatchObject({
      ok: true,
    });
    await expect(authentication).resolves.toMatchObject({
      _meta: {
        "acp-runtime/remote/hostId": "host-smoke",
        "acp-runtime/remote/ticketKid": "test-key",
      },
    });

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
    nativeClientSocket.close();
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

function bindBrokerClientSocket(
  broker: AcpRelayBroker,
  connectionId: string,
  socket: MemoryWebSocket,
): void {
  socket.addEventListener("message", (event) => {
    void broker.handleClientText(connectionId, String(event.data));
  });
}

function bindBrokerDaemonSocket(
  broker: AcpRelayBroker,
  socket: MemoryWebSocket,
): void {
  socket.addEventListener("message", (event) => {
    broker.handleDaemonText(String(event.data));
  });
}

function createMemoryWebSocketPair(): [MemoryWebSocket, MemoryWebSocket] {
  const left = new MemoryWebSocket();
  const right = new MemoryWebSocket();
  left.peer = right;
  right.peer = left;
  return [left, right];
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
