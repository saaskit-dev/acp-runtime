import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  MemoryWebSocket,
  createMemoryWebSocketPair,
  waitFor,
} from "./shared/test-helpers.js";

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AnyMessage,
  type Client,
} from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AcpRelayInMemoryControlPlaneStore } from "../../../packages/relay-worker/src/control-plane-store.js";
import { AcpRelayBroker } from "../../../packages/relay-worker/src/relay-core.js";
import type { AcpConnectionFactory } from "../acp/connection-types.js";
import {
  createStdioAcpConnectionFactory,
  nodeReadableToWeb,
  nodeWritableToWeb,
} from "../acp/stdio-connection.js";
import { SIMULATOR_AGENT_ACP_REGISTRY_ID } from "../agents/simulator-agent-acp.js";
import { AcpRuntime } from "../core/runtime.js";
import { resolveBuiltSimulatorWorkspaceCliPath } from "../registry/simulator-workspace.js";
import { createAcpRemoteStdioBridge } from "./client/stdio-bridge.js";
import { createAcpRemoteDaemonConnection } from "./daemon/relay-connection.js";
import { createAcpJsonRpcWebSocketStream } from "./protocol/index.js";
import type { AcpRemoteSocketFactory } from "./shared/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("ACP remote relay broker smoke", () => {
  it("reopens the current authorization URL for each explicit stdio authenticate request", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const [bridgeSocket, relaySocket] = createMemoryWebSocketPair();
    const openedUrls: string[] = [];
    const outputLines: string[] = [];
    const authUrl = "https://relay.test/authorize?connectionId=conn-auth-reopen";
    output.on("data", (chunk) => {
      outputLines.push(String(chunk));
    });

    const bridge = createAcpRemoteStdioBridge({
      clientId: "stdio-bridge-client",
      connectionId: "conn-auth-reopen",
      input,
      openAuthUrl(url) {
        openedUrls.push(url);
      },
      output,
      relayUrl: "wss://relay.test/acp",
      socketFactory() {
        return bridgeSocket;
      },
    });

    relaySocket.send(
      JSON.stringify({
        id: 0,
        jsonrpc: "2.0",
        result: {
          authMethods: [
            {
              _meta: {
                "acp-runtime/remote/authUrl": authUrl,
              },
              id: "acp-runtime-browser",
              name: "Authorize",
            },
          ],
        },
      }),
    );
    await waitFor(() => outputLines.join("").includes(authUrl));

    input.write(
      `${JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "authenticate",
        params: { methodId: "acp-runtime-browser" },
      })}\n`,
    );
    await waitFor(() => openedUrls.length === 1);

    input.write(
      `${JSON.stringify({
        id: 2,
        jsonrpc: "2.0",
        method: "authenticate",
        params: { methodId: "acp-runtime-browser" },
      })}\n`,
    );
    await waitFor(() => openedUrls.length === 2);

    expect(openedUrls).toEqual([authUrl, authUrl]);
    bridge.close();
    relaySocket.close();
  });

  it("opens authorization for explicit new sessions but not historical restores", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const [bridgeSocket, relaySocket] = createMemoryWebSocketPair();
    const openedUrls: string[] = [];
    const outputLines: string[] = [];
    const authUrl = "https://relay.test/authorize?connectionId=conn-session-open-reopen";
    output.on("data", (chunk) => {
      outputLines.push(String(chunk));
    });

    const bridge = createAcpRemoteStdioBridge({
      clientId: "stdio-bridge-client",
      connectionId: "conn-session-open-reopen",
      input,
      openAuthUrl(url) {
        openedUrls.push(url);
      },
      output,
      relayUrl: "wss://relay.test/acp",
      socketFactory() {
        return bridgeSocket;
      },
    });

    relaySocket.send(
      JSON.stringify({
        id: 0,
        jsonrpc: "2.0",
        result: {
          authMethods: [
            {
              _meta: {
                "acp-runtime/remote/authUrl": authUrl,
              },
              id: "acp-runtime-browser",
              name: "Authorize",
            },
          ],
        },
      }),
    );
    await waitFor(() => outputLines.join("").includes(authUrl));

    input.write(
      `${JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "session/load",
        params: {
          cwd: "/tmp/project",
          mcpServers: [],
          sessionId: "previous-session",
        },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openedUrls).toEqual([]);
    relaySocket.send(
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        result: { sessionId: "previous-session" },
      }),
    );
    await waitFor(() => outputLines.join("").includes("previous-session"));

    input.write(
      `${JSON.stringify({
        id: 2,
        jsonrpc: "2.0",
        method: "session/resume",
        params: {
          cwd: "/tmp/project",
          mcpServers: [],
          sessionId: "previous-session",
        },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openedUrls).toEqual([]);

    input.write(
      `${JSON.stringify({
        id: 3,
        jsonrpc: "2.0",
        method: "session/new",
        params: { cwd: "/tmp/project", mcpServers: [] },
      })}\n`,
    );
    await waitFor(() => openedUrls.length === 1);

    expect(openedUrls[0]).toContain(authUrl);
    expect(new URL(openedUrls[0]!).searchParams.get("sessionSelectionId")).toContain(
      "conn-session-open-reopen:3:",
    );
    bridge.close();
    relaySocket.close();
  });

  it("does not open authorization for restore requests that already have binding metadata", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const [bridgeSocket, relaySocket] = createMemoryWebSocketPair();
    const openedUrls: string[] = [];
    const outputLines: string[] = [];
    const authUrl = "https://relay.test/authorize?connectionId=conn-bound-restore";
    output.on("data", (chunk) => {
      outputLines.push(String(chunk));
    });

    const bridge = createAcpRemoteStdioBridge({
      clientId: "stdio-bridge-client",
      connectionId: "conn-bound-restore",
      input,
      openAuthUrl(url) {
        openedUrls.push(url);
      },
      output,
      relayUrl: "wss://relay.test/acp",
      socketFactory() {
        return bridgeSocket;
      },
    });

    relaySocket.send(
      JSON.stringify({
        id: 0,
        jsonrpc: "2.0",
        result: {
          authMethods: [
            {
              _meta: {
                "acp-runtime/remote/authUrl": authUrl,
              },
              id: "acp-runtime-browser",
              name: "Authorize",
            },
          ],
        },
      }),
    );
    await waitFor(() => outputLines.join("").includes(authUrl));

    input.write(
      `${JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "session/load",
        params: {
          _meta: {
            "acp-runtime/remote/daemonId": "host-a",
            "acp-runtime/remote/sessionAgent": { id: "codex-acp" },
            "acp-runtime/remote/sessionWorkspaceRoots": ["/tmp/project"],
          },
          cwd: "/tmp/project",
          mcpServers: [],
          sessionId: "previous-session",
        },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openedUrls).toEqual([]);
    bridge.close();
    relaySocket.close();
  });

  it("persists remote session binding metadata for stdio restore requests", async () => {
    const previousHome = process.env.ACP_RUNTIME_HOME_DIR;
    const runtimeHome = await mkdtemp(join(tmpdir(), "acp-runtime-bridge-"));
    tempDirs.push(runtimeHome);
    process.env.ACP_RUNTIME_HOME_DIR = runtimeHome;
    try {
      const firstInput = new PassThrough();
      const firstOutput = new PassThrough();
      const [firstBridgeSocket, firstRelaySocket] = createMemoryWebSocketPair();
      const firstBridge = createAcpRemoteStdioBridge({
        clientId: "stdio-bridge-client",
        connectionId: "conn-store-binding",
        input: firstInput,
        openAuthUrl() {},
        output: firstOutput,
        relayUrl: "wss://relay.test/acp",
        socketFactory() {
          return firstBridgeSocket;
        },
      });

      firstInput.write(
        `${JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "session/new",
          params: { cwd: "/tmp/project", mcpServers: [] },
        })}\n`,
      );
      firstRelaySocket.send(
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          result: {
            _meta: {
              "acp-runtime/remote/daemonId": "host-a",
              "acp-runtime/remote/sessionAgent": { id: "codex-acp" },
              "acp-runtime/remote/sessionWorkspaceRoots": ["/tmp/project"],
            },
            sessionId: "historical-session",
          },
        }),
      );
      await waitFor(() => firstOutput.readableLength > 0);
      firstBridge.close();
      firstRelaySocket.close();

      const secondInput = new PassThrough();
      const secondOutput = new PassThrough();
      const [secondBridgeSocket, secondRelaySocket] = createMemoryWebSocketPair();
      const forwarded: string[] = [];
      secondRelaySocket.addEventListener("message", (event) => {
        forwarded.push(String(event.data));
      });
      const secondBridge = createAcpRemoteStdioBridge({
        clientId: "stdio-bridge-client",
        connectionId: "conn-load-binding",
        input: secondInput,
        openAuthUrl() {},
        output: secondOutput,
        relayUrl: "wss://relay.test/acp",
        socketFactory() {
          return secondBridgeSocket;
        },
      });
      secondInput.write(
        `${JSON.stringify({
          id: 2,
          jsonrpc: "2.0",
          method: "session/load",
          params: {
            cwd: "/tmp/project",
            mcpServers: [],
            sessionId: "historical-session",
          },
        })}\n`,
      );

      await waitFor(() =>
        forwarded.some((line) => line.includes("acp-runtime/remote/daemonId")),
      );
      const loadRequest = forwarded
        .map((line) => JSON.parse(line) as AnyMessage)
        .find((message) => "method" in message && message.method === "session/load");
      expect(loadRequest).toMatchObject({
        params: {
          _meta: {
            "acp-runtime/remote/daemonId": "host-a",
            "acp-runtime/remote/sessionAgent": { id: "codex-acp" },
            "acp-runtime/remote/sessionWorkspaceRoots": ["/tmp/project"],
          },
          sessionId: "historical-session",
        },
      });

      forwarded.length = 0;
      secondInput.write(
        `${JSON.stringify({
          id: 3,
          jsonrpc: "2.0",
          method: "session/prompt",
          params: {
            prompt: [{ text: "continue", type: "text" }],
            sessionId: "historical-session",
          },
        })}\n`,
      );
      await waitFor(() =>
        forwarded.some(
          (line) =>
            line.includes("session/prompt") &&
            line.includes("acp-runtime/remote/daemonId"),
        ),
      );
      const promptRequest = forwarded
        .map((line) => JSON.parse(line) as AnyMessage)
        .find((message) => "method" in message && message.method === "session/prompt");
      expect(promptRequest).toMatchObject({
        params: {
          _meta: {
            "acp-runtime/remote/daemonId": "host-a",
            "acp-runtime/remote/sessionAgent": { id: "codex-acp" },
            "acp-runtime/remote/sessionWorkspaceRoots": ["/tmp/project"],
          },
          sessionId: "historical-session",
        },
      });
      secondBridge.close();
      secondRelaySocket.close();
    } finally {
      if (previousHome === undefined) {
        delete process.env.ACP_RUNTIME_HOME_DIR;
      } else {
        process.env.ACP_RUNTIME_HOME_DIR = previousHome;
      }
    }
  });

  it("keeps stdio bridge alive and bounds reconnect backlog", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const outputLines: string[] = [];
    output.on("data", (chunk) => {
      outputLines.push(String(chunk));
    });
    const bridgeSockets: { emitClose(): void }[] = [];
    const socketFactory: AcpRemoteSocketFactory = () => {
      const closeListeners = new Set<() => void>();
      const socket = {
        addEventListener(type: "close" | "error" | "message", listener: unknown) {
          if (type === "close") {
            closeListeners.add(listener as () => void);
          }
        },
        close() {
          for (const listener of closeListeners) {
            listener();
          }
        },
        removeEventListener(type: "close" | "error" | "message", listener: unknown) {
          if (type === "close") {
            closeListeners.delete(listener as () => void);
          }
        },
        send() {},
      };
      bridgeSockets.push({ emitClose: () => socket.close() });
      return socket as ReturnType<AcpRemoteSocketFactory>;
    };

    const bridge = createAcpRemoteStdioBridge({
      clientId: "stdio-bridge-client",
      connectionId: "conn-stdio-reconnect-backlog",
      input,
      output,
      reconnect: {
        maxQueuedMessages: 1,
      },
      relayUrl: "wss://relay.test/acp",
      socketFactory,
    });

    bridgeSockets[0]?.emitClose();
    input.write(
      `${JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "session/new",
        params: { cwd: "/tmp/project", mcpServers: [] },
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        id: 2,
        jsonrpc: "2.0",
        method: "session/new",
        params: { cwd: "/tmp/project", mcpServers: [] },
      })}\n`,
    );
    await waitFor(() => outputLines.join("").includes("reconnect queue is full"));

    expect(outputLines.join("")).toContain("reconnect queue is full");
    expect(outputLines.join("")).toContain('"id":2');

    bridge.close();
  });

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
            clientId: "native-acp-client",
          },
        ],
        grants: [
          {
            accountId: "acct-smoke",
            daemonId: "host-smoke",
            policyVersion: 1,
            scopes: [
              "acp:connect",
              "acp:session:create",
              "acp:session:resume",
              "acp:turn:send",
            ],
          },
        ],
        hosts: [{ accountId: "acct-smoke", daemonId: "host-smoke" }],
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
      daemonId: "host-smoke",
      runtime,
      socket: daemonSocket,
      ticketVerificationKeys: [ticketSigningKey],
    });

    broker.registerDaemon("host-smoke", relayDaemonSocket, {
      agentTypes: [
        {
          command: process.execPath,
          label: "Simulator Agent",
          type: SIMULATOR_AGENT_ACP_REGISTRY_ID,
        },
      ],
      workspaceRoots: [{ path: projectDir }],
    });
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
        daemonId: "host-smoke",
      }),
    ).resolves.toMatchObject({
      ok: true,
    });
    await expect(authentication).resolves.toMatchObject({
      _meta: {
        "acp-runtime/remote/daemonId": "host-smoke",
        "acp-runtime/remote/ticketKid": "test-key",
      },
    });

    const sessionCreate = clientConnection.newSession({
      cwd: projectDir,
      mcpServers: [],
    });
    await expect(
      broker.authorizeClient({
        connectionId: "conn-smoke",
        daemonId: "host-smoke",
        workspaceRoots: [projectDir],
      }),
    ).resolves.toMatchObject({ ok: true });
    const session = await sessionCreate;
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

  it("forwards inner ACP session/load history notifications through proxy daemon", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-remote-proxy-history-"));
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
            clientId: "native-acp-client",
          },
        ],
        grants: [
          {
            accountId: "acct-smoke",
            daemonId: "host-smoke",
            policyVersion: 1,
            scopes: [
              "acp:connect",
              "acp:session:create",
              "acp:session:resume",
              "acp:turn:send",
            ],
          },
        ],
        hosts: [{ accountId: "acct-smoke", daemonId: "host-smoke" }],
      }),
      ticketSigningKey,
    });

    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    bindBrokerDaemonSocket(broker, relayDaemonSocket);
    const daemon = createAcpRemoteDaemonConnection({
      agent: {
        args: [resolveBuiltSimulatorWorkspaceCliPath(), "--storage-dir", storageDir],
        command: process.execPath,
        type: SIMULATOR_AGENT_ACP_REGISTRY_ID,
      },
      connectionFactory: createStdioAcpConnectionFactory(),
      daemonId: "host-smoke",
      socket: daemonSocket,
      ticketVerificationKeys: [ticketSigningKey],
    });
    broker.registerDaemon("host-smoke", relayDaemonSocket, {
      agentTypes: [
        {
          command: process.execPath,
          label: "Simulator Agent",
          type: SIMULATOR_AGENT_ACP_REGISTRY_ID,
        },
      ],
      workspaceRoots: [{ path: projectDir }],
    });

    const first = createNativeRelayClient({
      accountId: "acct-smoke",
      broker,
      connectionId: "conn-proxy-history-create",
    });
    await first.connection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    const authentication = first.connection.authenticate({
      methodId: "acp-runtime-browser",
    });
    await expect(
      broker.authorizeClient({
        connectionId: "conn-proxy-history-create",
        daemonId: "host-smoke",
      }),
    ).resolves.toMatchObject({ ok: true });
    await authentication;

    const createdSession = first.connection.newSession({
      cwd: projectDir,
      mcpServers: [],
    });
    await expect(
      broker.authorizeClient({
        connectionId: "conn-proxy-history-create",
        daemonId: "host-smoke",
        workspaceRoots: [projectDir],
      }),
    ).resolves.toMatchObject({ ok: true });
    const session = await createdSession;
    await first.connection.prompt({
      prompt: [{ text: "/help", type: "text" }],
      sessionId: session.sessionId,
    });
    await waitFor(() =>
      first.notifications.some(
        (notification) =>
          isAcpTextNotification(notification) &&
          notification.update.content.text.includes("Simulator Agent ACP"),
      ),
    );
    first.socket.close();

    const second = createNativeRelayClient({
      accountId: "acct-smoke",
      broker,
      connectionId: "conn-proxy-history-load",
    });
    await second.connection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    await second.connection.loadSession({
      cwd: projectDir,
      mcpServers: [],
      sessionId: session.sessionId,
    });

    await waitFor(() =>
      second.notifications.some(
        (notification) =>
          isAcpTextNotification(notification) &&
          notification.update.content.text.includes("Simulator Agent ACP"),
      ),
    );
    expect(
      second.notifications.some(
        (notification) =>
          isAcpTextNotification(notification) &&
          notification.update.content.text.includes("Simulator Agent ACP"),
      ),
    ).toBe(true);

    second.socket.close();
    daemon.close();
  });

  it("uses bound workspace cwd when proxy-loading a historical remote session", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-remote-proxy-bound-cwd-"));
    const projectDir = join(root, "project");
    await mkdir(projectDir, { recursive: true });
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
            clientId: "native-acp-client",
          },
        ],
        grants: [
          {
            accountId: "acct-smoke",
            daemonId: "host-smoke",
            policyVersion: 1,
            scopes: [
              "acp:connect",
              "acp:session:create",
              "acp:session:resume",
            ],
          },
        ],
        hosts: [{ accountId: "acct-smoke", daemonId: "host-smoke" }],
      }),
      ticketSigningKey,
    });

    const newCwds: string[] = [];
    const loadCwds: string[] = [];
    const connectionFactory: AcpConnectionFactory = async () => {
      const abort = new AbortController();
      let close: () => void = () => {};
      const closed = new Promise<void>((resolve) => {
        close = resolve;
      });
      return {
        connection: {
          async authenticate() {},
          async cancel() {},
          closed,
          async initialize() {
            return {
              agentCapabilities: { loadSession: true },
              agentInfo: { name: "fake-agent", version: "1.0.0" },
              protocolVersion: PROTOCOL_VERSION,
            };
          },
          async loadSession(params) {
            loadCwds.push(params.cwd);
            return { sessionId: params.sessionId };
          },
          async newSession(params) {
            newCwds.push(params.cwd);
            return { sessionId: "historical-session" };
          },
          async prompt() {
            return { stopReason: "end_turn" };
          },
          signal: abort.signal,
        },
        dispose() {
          abort.abort();
          close();
        },
      };
    };

    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    bindBrokerDaemonSocket(broker, relayDaemonSocket);
    const daemon = createAcpRemoteDaemonConnection({
      agent: {
        command: "fake-agent",
        type: "fake",
      },
      connectionFactory,
      daemonId: "host-smoke",
      socket: daemonSocket,
      ticketVerificationKeys: [ticketSigningKey],
    });
    broker.registerDaemon("host-smoke", relayDaemonSocket, {
      agentTypes: [{ command: "fake-agent", type: "fake" }],
      workspaceRoots: [{ path: projectDir }],
    });

    const first = createNativeRelayClient({
      accountId: "acct-smoke",
      broker,
      connectionId: "conn-proxy-bound-cwd-create",
    });
    await first.connection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    const authentication = first.connection.authenticate({
      methodId: "acp-runtime-browser",
    });
    await expect(
      broker.authorizeClient({
        connectionId: "conn-proxy-bound-cwd-create",
        daemonId: "host-smoke",
      }),
    ).resolves.toMatchObject({ ok: true });
    await authentication;

    const createdSession = first.connection.newSession({
      cwd: projectDir,
      mcpServers: [],
    });
    await expect(
      broker.authorizeClient({
        connectionId: "conn-proxy-bound-cwd-create",
        daemonId: "host-smoke",
        workspaceRoots: [projectDir],
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(createdSession).resolves.toMatchObject({
      sessionId: "historical-session",
    });
    first.socket.close();

    const second = createNativeRelayClient({
      accountId: "acct-smoke",
      broker,
      connectionId: "conn-proxy-bound-cwd-load",
    });
    await second.connection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    await expect(
      second.connection.loadSession({
        cwd: root,
        mcpServers: [],
        sessionId: "historical-session",
      }),
    ).resolves.toMatchObject({
      sessionId: "historical-session",
    });

    expect(newCwds).toHaveLength(1);
    expect(loadCwds).toEqual(newCwds);

    second.socket.close();
    daemon.close();
  });

  it("returns daemon JSON-RPC errors for unknown remote sessions instead of hanging", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-remote-unknown-session-"));
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
            clientId: "native-acp-client",
          },
        ],
        grants: [
          {
            accountId: "acct-smoke",
            daemonId: "host-smoke",
            policyVersion: 1,
            scopes: [
              "acp:connect",
              "acp:session:create",
              "acp:session:resume",
              "acp:turn:send",
            ],
          },
        ],
        hosts: [{ accountId: "acct-smoke", daemonId: "host-smoke" }],
      }),
      ticketSigningKey,
    });

    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    bindBrokerClientSocket(broker, "conn-unknown-session", relayClientSocket);
    bindBrokerDaemonSocket(broker, relayDaemonSocket);

    const runtime = new AcpRuntime(createStdioAcpConnectionFactory());
    const daemon = createAcpRemoteDaemonConnection({
      agent: {
        args: [resolveBuiltSimulatorWorkspaceCliPath(), "--storage-dir", storageDir],
        command: process.execPath,
        type: SIMULATOR_AGENT_ACP_REGISTRY_ID,
      },
      daemonId: "host-smoke",
      runtime,
      socket: daemonSocket,
      ticketVerificationKeys: [ticketSigningKey],
    });

    broker.registerDaemon("host-smoke", relayDaemonSocket, {
      agentTypes: [],
      workspaceRoots: [{ path: projectDir }],
    });
    broker.registerClient({
      accountId: "acct-smoke",
      authUrl: "https://relay.test/authorize?connectionId=conn-unknown-session",
      connectionId: "conn-unknown-session",
      socket: relayClientSocket,
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
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    const authentication = clientConnection.authenticate({
      methodId: "acp-runtime-browser",
    });
    await expect(
      broker.authorizeClient({
        connectionId: "conn-unknown-session",
        daemonId: "host-smoke",
      }),
    ).resolves.toMatchObject({ ok: true });
    await authentication;

    await expect(
      clientConnection.prompt({
        prompt: [{ text: "hello", type: "text" }],
        sessionId: "missing-session",
      }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining("Unknown remote runtime session"),
    });

    daemon.close();
    nativeClientSocket.close();
  });

  it("runs stdio bridge ACP through relay broker into a simulator-backed daemon", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-remote-stdio-bridge-smoke-"));
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
            clientId: "stdio-bridge-client",
          },
        ],
        grants: [
          {
            accountId: "acct-smoke",
            clientId: "stdio-bridge-client",
            daemonId: "host-smoke",
            policyVersion: 1,
            scopes: [
              "acp:connect",
              "acp:session:create",
              "acp:session:resume",
              "acp:turn:send",
            ],
          },
        ],
        hosts: [{ accountId: "acct-smoke", daemonId: "host-smoke" }],
      }),
      ticketSigningKey,
    });

    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    bindBrokerDaemonSocket(broker, relayDaemonSocket);
    const runtime = new AcpRuntime(createStdioAcpConnectionFactory());
    const daemon = createAcpRemoteDaemonConnection({
      agent: {
        args: [resolveBuiltSimulatorWorkspaceCliPath(), "--storage-dir", storageDir],
        command: process.execPath,
        type: SIMULATOR_AGENT_ACP_REGISTRY_ID,
      },
      daemonId: "host-smoke",
      runtime,
      socket: daemonSocket,
      ticketVerificationKeys: [ticketSigningKey],
    });
    broker.registerDaemon("host-smoke", relayDaemonSocket, {
      agentTypes: [],
      workspaceRoots: [{ path: projectDir }],
    });

    const input = new PassThrough();
    const output = new PassThrough();
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
      ndJsonStream(
        nodeWritableToWeb(input, { preferNative: false }),
        nodeReadableToWeb(output, { preferNative: false }),
      ),
    );
    void clientConnection.closed.catch(() => {});
    const socketFactory: AcpRemoteSocketFactory = ({ url }) => {
      const parsed = new URL(url);
      const connectionId = parsed.searchParams.get("connectionId");
      if (!connectionId) {
        throw new Error("Bridge URL is missing connectionId.");
      }
      const [bridgeSocket, relaySocket] = createMemoryWebSocketPair();
      bindBrokerClientSocket(broker, connectionId, relaySocket);
      broker.registerClient({
        accountId: "acct-smoke",
        authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
        clientId: "stdio-bridge-client",
        connectionId,
        socket: relaySocket,
      });
      return bridgeSocket;
    };

    const bridge = createAcpRemoteStdioBridge({
      clientId: "stdio-bridge-client",
      connectionId: "conn-stdio-smoke",
      input,
      openAuthUrl() {},
      output,
      relayUrl: "wss://relay.test/acp",
      socketFactory,
    });

    const initialize = await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(initialize.agentInfo?.name).toBe("acp-runtime-relay");
    expect(initialize.authMethods?.[0]?.id).toBe("acp-runtime-browser");

    const authentication = clientConnection.authenticate({
      methodId: "acp-runtime-browser",
    });
    await expect(
      broker.authorizeClient({
        connectionId: "conn-stdio-smoke",
        daemonId: "host-smoke",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(authentication).resolves.toMatchObject({
      _meta: {
        "acp-runtime/remote/daemonId": "host-smoke",
        "acp-runtime/remote/ticketKid": "test-key",
      },
    });

    const sessionCreate = clientConnection.newSession({
      cwd: projectDir,
      mcpServers: [],
    });
    await expect(
      broker.authorizeClient({
        connectionId: "conn-stdio-smoke",
        daemonId: "host-smoke",
        workspaceRoots: [projectDir],
      }),
    ).resolves.toMatchObject({ ok: true });
    const session = await sessionCreate;
    const sessionId = session.sessionId;
    expect(sessionId).toBeTruthy();

    const prompt = await clientConnection.prompt({
      prompt: [{ text: "/help", type: "text" }],
      sessionId,
    });
    expect(prompt.stopReason).toBe("end_turn");
    expect(
      notifications.some(
        (notification) =>
          isAcpTextNotification(notification) &&
          notification.update.content.text.includes("Simulator Agent ACP"),
      ),
    ).toBe(true);

    await clientConnection.closeSession({ sessionId });
    bridge.close();
    daemon.close();
  });

  it("starts relay ACP as an agent through an outer AcpRuntime", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-remote-runtime-self-smoke-"));
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
            clientId: "outer-runtime-client",
          },
        ],
        grants: [
          {
            accountId: "acct-smoke",
            clientId: "outer-runtime-client",
            daemonId: "host-smoke",
            policyVersion: 1,
            scopes: [
              "acp:connect",
              "acp:session:create",
              "acp:session:resume",
              "acp:turn:send",
            ],
          },
        ],
        hosts: [{ accountId: "acct-smoke", daemonId: "host-smoke" }],
      }),
      ticketSigningKey,
    });

    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    bindBrokerDaemonSocket(broker, relayDaemonSocket);
    const innerRuntime = new AcpRuntime(createStdioAcpConnectionFactory());
    const daemon = createAcpRemoteDaemonConnection({
      agent: {
        args: [resolveBuiltSimulatorWorkspaceCliPath(), "--storage-dir", storageDir],
        command: process.execPath,
        type: SIMULATOR_AGENT_ACP_REGISTRY_ID,
      },
      daemonId: "host-smoke",
      runtime: innerRuntime,
      socket: daemonSocket,
      ticketVerificationKeys: [ticketSigningKey],
    });
    broker.registerDaemon("host-smoke", relayDaemonSocket, {
      agentTypes: [],
      workspaceRoots: [{ path: projectDir }],
    });

    const connectionId = "conn-outer-runtime-smoke";
    const outerRuntime = new AcpRuntime(
      createBrokerRelayAcpConnectionFactory({
        accountId: "acct-smoke",
        broker,
        clientId: "outer-runtime-client",
        connectionId,
      }),
    );

    const sessionAuthorization = setInterval(() => {
      void broker.authorizeClient({
        connectionId,
        daemonId: "host-smoke",
        workspaceRoots: [projectDir],
      });
    }, 10);
    const session = await outerRuntime.sessions.start({
      agent: {
        command: "relay-acp",
        type: "relay-acp",
      },
      cwd: projectDir,
      handlers: {
        async authentication({ methods }) {
          queueMicrotask(() => {
            void broker.authorizeClient({
              connectionId,
              daemonId: "host-smoke",
            });
          });
          return { methodId: methods[0]?.id ?? "acp-runtime-browser" };
        },
        permission: () => ({ decision: "allow", scope: "session" }),
      },
    });
    clearInterval(sessionAuthorization);

    const output = await session.turn.run("/help");
    expect(output).toContain("Simulator Agent ACP");

    await session.close();
    daemon.close();
  });
});

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

function createNativeRelayClient(input: {
  accountId: string;
  broker: AcpRelayBroker;
  connectionId: string;
}): {
  connection: ClientSideConnection;
  notifications: unknown[];
  socket: MemoryWebSocket;
} {
  const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
  bindBrokerClientSocket(input.broker, input.connectionId, relayClientSocket);
  input.broker.registerClient({
    accountId: input.accountId,
    authUrl: `https://relay.test/authorize?connectionId=${input.connectionId}`,
    connectionId: input.connectionId,
    socket: relayClientSocket,
  });
  const notifications: unknown[] = [];
  const connection = new ClientSideConnection(
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
  void connection.closed.catch(() => {});
  return {
    connection,
    notifications,
    socket: nativeClientSocket,
  };
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

function createBrokerRelayAcpConnectionFactory(input: {
  accountId: string;
  broker: AcpRelayBroker;
  clientId: string;
  connectionId: string;
}): AcpConnectionFactory {
  return async (connectionInput) => {
    const [clientSocket, relaySocket] = createMemoryWebSocketPair();
    bindBrokerClientSocket(input.broker, input.connectionId, relaySocket);
    input.broker.registerClient({
      accountId: input.accountId,
      authUrl: `https://relay.test/authorize?connectionId=${input.connectionId}`,
      clientId: input.clientId,
      connectionId: input.connectionId,
      socket: relaySocket,
    });
    const connection = new ClientSideConnection(
      () => connectionInput.client,
      createAcpJsonRpcWebSocketStream(clientSocket),
    );
    void connection.closed.catch(() => {});
    return {
      connection,
      dispose() {
        clientSocket.close();
      },
    };
  };
}
