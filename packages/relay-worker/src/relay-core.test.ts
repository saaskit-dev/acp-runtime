import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type AnyMessage,
  type Client,
  type RequestError,
} from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { MemoryWebSocket, createMemoryWebSocketPair, waitFor } from "../../../src/runtime/remote/shared/test-helpers.js";

import {
  AcpRemoteChannelKind,
  AcpRemoteFrameType,
  assertAcpRemoteFrame,
  createAcpRemoteDeviceKeyPair,
  createAcpRemoteDeviceRenewalSignature,
  createAcpRemoteSignedConnectionTicket,
  createAcpJsonRpcWebSocketStream,
  type AcpRemoteAckFrame,
  type AcpRemoteDataFrame,
  type AcpRemoteFrame,
  type AcpRemoteScope,
} from "../../../src/runtime/remote/protocol/index.js";
import { AcpRelayInMemoryControlPlaneStore } from "./control-plane-store.js";
import { AcpRelayBroker, createRelayAuthorizationPage } from "./relay-core.js";

describe("AcpRelayBroker", () => {
  it("embeds authorization host data as valid script JSON", () => {
    const page = createRelayAuthorizationPage({
      accountId: "acct-1",
      connectionId: "conn-1",
      hosts: [
        {
          daemonId: "host-1",
          metadata: {
            agentTypes: [{ command: "node", label: "Node", type: "sim" }],
            machine: "dev-mac",
            workspaceRoots: [{ label: "Project", path: "/tmp/<project>" }],
          },
        },
      ],
      requestUrl: 'https://relay.example.com/authorize?next="done"',
    });

    expect(page).toContain('const hosts = [{"daemonId":"host-1"');
    expect(page).toContain("Machine / Agent");
    expect(page).toContain("workspaceSummary");
    expect(page).toContain('value.id === "codex-acp"');
    expect(page).toContain("Default daemon agent");
    expect(page).toContain("dev-mac");
    expect(page).toContain(
      'const authorizeUrl = "https://relay.example.com/authorize?next=\\"done\\"";',
    );
    expect(page).not.toContain("&quot;");
    expect(page).not.toContain("/tmp/<project>");
  });

  it("renders expired authorization connections explicitly", () => {
    const page = createRelayAuthorizationPage({
      accountId: "acct-1",
      connectionId: "conn-expired",
      hosts: [],
      requestUrl: "https://relay.example.com/authorize?connectionId=conn-expired",
      unavailableReason:
        "Client connection is no longer active. Restart the remote session from the ACP client.",
    });

    expect(page).toContain("Remote session expired");
    expect(page).toContain("Client disconnected");
    expect(page).toContain("Restart the remote session from the ACP client.");
    expect(page).toContain("const hosts = [];");
  });

  it("requests workspace tree entries from an authorizable daemon", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      ticketSigningKey,
    });
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const [, relayClientSocket] = createMemoryWebSocketPair();
    let requestFrame: AcpRemoteDataFrame | undefined;

    daemonSocket.addEventListener("message", (event) => {
      const frame = assertAcpRemoteFrame(JSON.parse(String(event.data)));
      if (frame.frameType === AcpRemoteFrameType.Data) {
        requestFrame = frame;
      }
    });
    bindBrokerDaemonSocket(broker, relayDaemonSocket);
    broker.registerDaemon("host-a", relayDaemonSocket, {
      agentTypes: [],
      workspaceRoots: [{ path: "/Users/dev" }],
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-workspace-tree",
      connectionId: "conn-workspace-tree",
      socket: relayClientSocket,
    });

    const resultPromise = broker.listDaemonWorkspaceDirectory({
      connectionId: "conn-workspace-tree",
      daemonId: "host-a",
      path: "/Users/dev",
      root: "/Users/dev",
    });
    await waitFor(() => requestFrame !== undefined);
    expect(requestFrame).toMatchObject({
      channelKind: AcpRemoteChannelKind.Filesystem,
      payload: {
        kind: "workspace/list",
        path: "/Users/dev",
        root: "/Users/dev",
      },
    });

    daemonSocket.send(JSON.stringify({
      channelId: "workspace",
      channelKind: AcpRemoteChannelKind.Filesystem,
      connectionId: requestFrame!.connectionId,
      frameType: AcpRemoteFrameType.Data,
      payload: {
        entries: [{ name: "acp-runtime", path: "/Users/dev/acp-runtime", type: "directory" }],
        kind: "workspace/list/result",
        ok: true,
        path: "/Users/dev",
        requestId: "unused",
      },
      seq: 1,
    } satisfies AcpRemoteDataFrame));

    await expect(resultPromise).resolves.toEqual({
      entries: [{ name: "acp-runtime", path: "/Users/dev/acp-runtime", type: "directory" }],
      ok: true,
      path: "/Users/dev",
    });
  });

  it("stores registry agent ids in authorization tickets", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      ticketSigningKey,
    });
    const connectionId = "conn-agent-id";
    const [, relayClientSocket] = createMemoryWebSocketPair();
    const [, relayDaemonSocket] = createMemoryWebSocketPair();

    broker.registerDaemon("host-a", relayDaemonSocket, {
      agentTypes: [{ id: "codex-acp", label: "Codex" }],
      workspaceRoots: [],
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });

    const result = await broker.authorizeClient({
      clientAgent: { id: "codex-acp" },
      connectionId,
      daemonId: "host-a",
    });

    expect(result).toMatchObject({
      ok: true,
      ticket: {
        payload: {
          agent: { id: "codex-acp" },
        },
      },
    });
  });

  it("auto-registers the native client device before grant resolution", async () => {
    const store = new AcpRelayInMemoryControlPlaneStore({
      accounts: [{ accountId: "acct-1" }],
      clientDevices: [],
      grants: [
        {
          accountId: "acct-1",
          daemonId: "host-a",
          policyVersion: 1,
          scopes: ["acp:connect"],
        },
      ],
      hosts: [{ accountId: "acct-1", daemonId: "host-a" }],
    });
    const broker = new AcpRelayBroker({
      controlPlaneStore: store,
      ticketSigningKey,
    });
    const connectionId = "conn-auto-client";
    const [, relayClientSocket] = createMemoryWebSocketPair();
    const [, relayDaemonSocket] = createMemoryWebSocketPair();

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      clientId: "editor-bridge",
      connectionId,
      socket: relayClientSocket,
    });

    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      store.getClientDevice({
        accountId: "acct-1",
        clientId: "editor-bridge",
      }),
    ).resolves.toMatchObject({
      accountId: "acct-1",
      clientId: "editor-bridge",
    });
  });

  it("rejects unadvertised authorization agent and workspace selections", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      ticketSigningKey,
    });
    const connectionId = "conn-selection-validation";
    const [, relayClientSocket] = createMemoryWebSocketPair();
    const [, relayDaemonSocket] = createMemoryWebSocketPair();

    broker.registerDaemon("host-a", relayDaemonSocket, {
      agentTypes: [{ id: "codex-acp", label: "Codex" }],
      workspaceRoots: [{ path: "/Users/dev" }],
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });

    await expect(
      broker.authorizeClient({
        clientAgent: { command: "/bin/sh" },
        connectionId,
        daemonId: "host-a",
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "Selected agent is not advertised by this daemon.",
    });
    await expect(
      broker.authorizeClient({
        connectionId,
        daemonId: "host-a",
        workspaceRoots: ["/etc"],
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "Selected workspace is not advertised by this daemon.",
    });
    await expect(
      broker.authorizeClient({
        clientAgent: { id: "codex-acp" },
        connectionId,
        daemonId: "host-a",
        workspaceRoots: ["/Users/dev/acp-runtime"],
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("reuses bootstrap authorization session selection for the first native session", async () => {
    const broker = new AcpRelayBroker({
      authWaitMs: 50,
      controlPlaneStore: createControlPlaneStore(),
      ticketSigningKey,
    });
    const connectionId = "conn-bootstrap-session-selection";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    let sessionNewPayload: AnyMessage | undefined;

    bindBrokerClientSocket(broker, connectionId, relayClientSocket);
    bindBrokerDaemonSocket(broker, relayDaemonSocket);
    daemonSocket.addEventListener("message", (event) => {
      const frame = assertAcpRemoteFrame(JSON.parse(String(event.data)));
      if (frame.frameType !== AcpRemoteFrameType.Data) {
        return;
      }
      const payload = frame.payload as AnyMessage;
      if (
        "id" in payload &&
        "method" in payload &&
        payload.method === "session/new"
      ) {
        sessionNewPayload = payload;
        daemonSocket.send(
          JSON.stringify({
            channelId: "acp",
            channelKind: AcpRemoteChannelKind.Acp,
            connectionId,
            frameType: AcpRemoteFrameType.Data,
            payload: {
              id: payload.id,
              jsonrpc: "2.0",
              result: { sessionId: "session-selected" },
            },
            seq: 1,
          } satisfies AcpRemoteDataFrame),
        );
      }
    });

    broker.registerDaemon("host-a", relayDaemonSocket, {
      agentTypes: [{ id: "codex-acp", label: "Codex" }],
      workspaceRoots: [{ path: "/tmp" }],
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });

    const clientConnection = createClientConnection(nativeClientSocket);
    const initialize = await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(initialize.agentCapabilities).toMatchObject({
      loadSession: true,
      sessionCapabilities: {
        close: {},
        list: {},
        resume: {},
      },
    });
    const authentication = clientConnection.authenticate({
      methodId: "acp-runtime-browser",
    });
    await expect(
      broker.authorizeClient({
        clientAgent: { id: "codex-acp" },
        connectionId,
        daemonId: "host-a",
        workspaceRoots: ["/tmp/selected-project"],
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(authentication).resolves.toMatchObject({
      _meta: {
        "acp-runtime/remote/daemonId": "host-a",
      },
    });

    await expect(
      clientConnection.newSession({ cwd: "/tmp/project", mcpServers: [] }),
    ).resolves.toMatchObject({ sessionId: "session-selected" });

    expect(sessionNewPayload).toMatchObject({
      params: {
        cwd: "/tmp/selected-project",
        _meta: {
          "acp-runtime/remote/sessionAgent": { id: "codex-acp" },
          "acp-runtime/remote/sessionWorkspaceRoots": [
            "/tmp/selected-project",
          ],
        },
      },
    });

    nativeClientSocket.close();
    daemonSocket.close();
  });

  it("allows native session/new to drive bootstrap authorization when client skips authenticate", async () => {
    const broker = new AcpRelayBroker({
      authWaitMs: 1_000,
      controlPlaneStore: createControlPlaneStore({
        scopes: [
          "acp:connect",
          "acp:session:create",
          "acp:session:resume",
          "acp:turn:send",
        ],
      }),
      ticketSigningKey,
    });
    const connectionId = "conn-session-new-bootstrap";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    let forwardedSessionNew: AnyMessage | undefined;

    bindBrokerClientSocket(broker, connectionId, relayClientSocket);
    bindBrokerDaemonSocket(broker, relayDaemonSocket);
    daemonSocket.addEventListener("message", (event) => {
      const frame = assertAcpRemoteFrame(JSON.parse(String(event.data)));
      if (frame.frameType !== AcpRemoteFrameType.Data) {
        return;
      }
      const payload = frame.payload as AnyMessage;
      if (
        "id" in payload &&
        "method" in payload &&
        payload.method === "session/new"
      ) {
        forwardedSessionNew = payload;
        daemonSocket.send(
          JSON.stringify({
            channelId: "acp",
            channelKind: AcpRemoteChannelKind.Acp,
            connectionId,
            frameType: AcpRemoteFrameType.Data,
            payload: {
              id: payload.id,
              jsonrpc: "2.0",
              result: { sessionId: "session-from-session-new" },
            },
            seq: 1,
          } satisfies AcpRemoteDataFrame),
        );
      }
    });

    broker.registerDaemon("host-a", relayDaemonSocket, {
      agentTypes: [{ id: "codex-acp", label: "Codex" }],
      workspaceRoots: [{ path: "/tmp" }],
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });

    const clientConnection = createClientConnection(nativeClientSocket);
    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const newSession = clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });
    await expect(
      broker.authorizeClient({
        clientAgent: { id: "codex-acp" },
        connectionId,
        daemonId: "host-a",
        workspaceRoots: ["/tmp/selected-project"],
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(newSession).resolves.toMatchObject({
      sessionId: "session-from-session-new",
    });
    expect(forwardedSessionNew).toMatchObject({
      params: {
        cwd: "/tmp/selected-project",
        _meta: {
          "acp-runtime/remote/sessionAgent": { id: "codex-acp" },
          "acp-runtime/remote/sessionWorkspaceRoots": [
            "/tmp/selected-project",
          ],
        },
      },
    });

    nativeClientSocket.close();
    daemonSocket.close();
  });

  it("routes concurrent session/new selections by request scoped selection id", async () => {
    const broker = new AcpRelayBroker({
      authWaitMs: 1_000,
      controlPlaneStore: createControlPlaneStore({
        scopes: [
          "acp:connect",
          "acp:session:create",
          "acp:session:resume",
          "acp:turn:send",
        ],
      }),
      ticketSigningKey,
    });
    const connectionId = "conn-concurrent-session-new";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const forwarded: AnyMessage[] = [];
    let seq = 1;

    bindBrokerClientSocket(broker, connectionId, relayClientSocket);
    bindBrokerDaemonSocket(broker, relayDaemonSocket);
    daemonSocket.addEventListener("message", (event) => {
      const frame = assertAcpRemoteFrame(JSON.parse(String(event.data)));
      if (frame.frameType !== AcpRemoteFrameType.Data) {
        return;
      }
      const payload = frame.payload as AnyMessage;
      if (
        "id" in payload &&
        "method" in payload &&
        payload.method === "session/new"
      ) {
        forwarded.push(payload);
        const cwd =
          "params" in payload &&
          typeof payload.params === "object" &&
          payload.params !== null &&
          "cwd" in payload.params &&
          typeof payload.params.cwd === "string"
            ? payload.params.cwd
            : "unknown";
        daemonSocket.send(
          JSON.stringify({
            channelId: "acp",
            channelKind: AcpRemoteChannelKind.Acp,
            connectionId,
            frameType: AcpRemoteFrameType.Data,
            payload: {
              id: payload.id,
              jsonrpc: "2.0",
              result: { sessionId: `session:${cwd}` },
            },
            seq: seq++,
          } satisfies AcpRemoteDataFrame),
        );
      }
    });

    broker.registerDaemon("host-a", relayDaemonSocket, {
      agentTypes: [{ id: "codex-acp", label: "Codex" }],
      workspaceRoots: [{ path: "/tmp" }],
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });

    const clientConnection = createClientConnection(nativeClientSocket);
    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const sessionA = clientConnection.newSession({
      _meta: {
        "acp-runtime/remote/sessionSelectionId": "selection-a",
      },
      cwd: "/tmp/request-a",
      mcpServers: [],
    } as Parameters<typeof clientConnection.newSession>[0]);
    const sessionB = clientConnection.newSession({
      _meta: {
        "acp-runtime/remote/sessionSelectionId": "selection-b",
      },
      cwd: "/tmp/request-b",
      mcpServers: [],
    } as Parameters<typeof clientConnection.newSession>[0]);

    await expect(
      broker.authorizeClient({
        clientAgent: { id: "codex-acp" },
        connectionId,
        daemonId: "host-a",
        sessionSelectionId: "selection-b",
        workspaceRoots: ["/tmp/selected-b"],
      }),
    ).resolves.toMatchObject({ ok: true });
    await waitFor(() =>
      forwarded.some((payload) =>
        JSON.stringify(payload).includes("/tmp/selected-b"),
      ),
    );
    expect(forwarded).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({ cwd: "/tmp/selected-a" }),
        }),
      ]),
    );

    await expect(
      broker.authorizeClient({
        clientAgent: { id: "codex-acp" },
        connectionId,
        daemonId: "host-a",
        sessionSelectionId: "selection-a",
        workspaceRoots: ["/tmp/selected-a"],
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(sessionA).resolves.toMatchObject({
      sessionId: "session:/tmp/selected-a",
    });
    await expect(sessionB).resolves.toMatchObject({
      sessionId: "session:/tmp/selected-b",
    });
    expect(forwarded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({ cwd: "/tmp/selected-a" }),
        }),
        expect.objectContaining({
          params: expect.objectContaining({ cwd: "/tmp/selected-b" }),
        }),
      ]),
    );

    nativeClientSocket.close();
    daemonSocket.close();
  });

  it("restores native session/load from remote binding metadata when client skips authenticate", async () => {
    const broker = new AcpRelayBroker({
      authWaitMs: 1_000,
      controlPlaneStore: createControlPlaneStore({
        scopes: [
          "acp:connect",
          "acp:session:create",
          "acp:session:resume",
          "acp:turn:send",
        ],
      }),
      ticketSigningKey,
    });
    const connectionId = "conn-session-load-bootstrap";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    let forwardedSessionLoad: AnyMessage | undefined;

    bindBrokerClientSocket(broker, connectionId, relayClientSocket);
    bindBrokerDaemonSocket(broker, relayDaemonSocket);
    daemonSocket.addEventListener("message", (event) => {
      const frame = assertAcpRemoteFrame(JSON.parse(String(event.data)));
      if (frame.frameType !== AcpRemoteFrameType.Data) {
        return;
      }
      const payload = frame.payload as AnyMessage;
      if (
        "id" in payload &&
        "method" in payload &&
        payload.method === "session/load"
      ) {
        forwardedSessionLoad = payload;
        daemonSocket.send(
          JSON.stringify({
            channelId: "acp",
            channelKind: AcpRemoteChannelKind.Acp,
            connectionId,
            frameType: AcpRemoteFrameType.Data,
            payload: {
              id: payload.id,
              jsonrpc: "2.0",
              result: { sessionId: "session-loaded" },
            },
            seq: 1,
          } satisfies AcpRemoteDataFrame),
        );
      }
    });

    broker.registerDaemon("host-a", relayDaemonSocket, {
      agentTypes: [{ id: "codex-acp", label: "Codex" }],
      workspaceRoots: [{ path: "/tmp" }],
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });

    const clientConnection = createClientConnection(nativeClientSocket);
    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const loadSession = clientConnection.loadSession({
      cwd: "/tmp/project",
      mcpServers: [],
      sessionId: "session-existing",
      _meta: {
        "acp-runtime/remote/daemonId": "host-a",
        "acp-runtime/remote/sessionAgent": { id: "codex-acp" },
        "acp-runtime/remote/sessionWorkspaceRoots": ["/tmp/selected-project"],
      },
    } as Parameters<typeof clientConnection.loadSession>[0]);

    await expect(loadSession).resolves.toMatchObject({
      sessionId: "session-loaded",
    });
    expect(forwardedSessionLoad).toMatchObject({
      params: {
        cwd: "/tmp/selected-project",
        sessionId: "session-existing",
        _meta: {
          "acp-runtime/remote/sessionAgent": { id: "codex-acp" },
          "acp-runtime/remote/sessionWorkspaceRoots": [
            "/tmp/selected-project",
          ],
        },
      },
    });

    nativeClientSocket.close();
    daemonSocket.close();
  });

  it("restores bound session traffic from stored binding before authenticate", async () => {
    const harness = createSessionBindingRestoreHarness({
      connectionId: "conn-session-bound-before-auth",
    });

    await harness.sendPrompt("turn-before-auth");

    await waitForSessionPromptForward(harness.daemonFrames);
    expect(harness.clientMessages).not.toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          message: expect.stringContaining("Authentication required"),
        }),
      }),
    );
  });

  it("restores bound session traffic after bootstrap state was restored without a ticket", async () => {
    const harness = createSessionBindingRestoreHarness({
      bootstrapComplete: true,
      connectionId: "conn-session-bound-restored-bootstrap",
    });

    await harness.sendPrompt("turn-restored-before-auth");

    await waitForSessionPromptForward(harness.daemonFrames);
    expect(harness.clientMessages).not.toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          message: expect.stringContaining("Authentication required"),
        }),
      }),
    );
  });

  it("queues restored session/load while the daemon is reconnecting", async () => {
    const store = new AcpRelayInMemoryControlPlaneStore({
      accounts: [{ accountId: "acct-1" }],
      clientDevices: [{ accountId: "acct-1", clientId: "native-acp-client" }],
      grants: [
        {
          accountId: "acct-1",
          daemonId: "host-a",
          policyVersion: 7,
          scopes: ["acp:connect", "acp:session:resume"],
          workspaceRoots: ["/tmp/persisted-project"],
        },
      ],
      hosts: [{ accountId: "acct-1", daemonId: "host-a" }],
      sessionBindings: [
        {
          accountId: "acct-1",
          agent: { id: "codex-acp" },
          clientId: "native-acp-client",
          daemonId: "host-a",
          sessionId: "session-existing",
          workspaceRoots: ["/tmp/persisted-project"],
        },
      ],
    });
    const broker = new AcpRelayBroker({
      controlPlaneStore: store,
      daemonReconnectGraceMs: 1_000,
      ticketSigningKey,
    });
    const connectionId = "conn-session-load-daemon-reconnect";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [firstDaemonSocket, firstRelayDaemonSocket] =
      createMemoryWebSocketPair();
    const [secondDaemonSocket, secondRelayDaemonSocket] =
      createMemoryWebSocketPair();
    const clientMessages: unknown[] = [];
    const secondDaemonFrames: AcpRemoteFrame[] = [];

    nativeClientSocket.addEventListener("message", (event) => {
      clientMessages.push(JSON.parse(String(event.data)));
    });
    secondDaemonSocket.addEventListener("message", (event) => {
      secondDaemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    bindBrokerDaemonSocket(broker, firstRelayDaemonSocket);
    bindBrokerDaemonSocket(broker, secondRelayDaemonSocket);

    await broker.registerDaemon("host-a", firstRelayDaemonSocket, {
      agentTypes: [{ id: "codex-acp", label: "Codex" }],
      workspaceRoots: [{ path: "/tmp" }],
    });
    broker.removeDaemon("host-a", firstRelayDaemonSocket);
    firstDaemonSocket.close();
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });

    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "load-during-reconnect",
        jsonrpc: "2.0",
        method: "session/load",
        params: {
          cwd: "/tmp/project",
          mcpServers: [],
          sessionId: "session-existing",
        },
      }),
    );

    expect(clientMessages).not.toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          message: expect.stringContaining("Authentication required"),
        }),
      }),
    );
    expect(
      broker
        .clientStateSnapshot(connectionId)
        ?.daemonQueuedFrames.some(
          (frame) =>
            isJsonRpcPayload(frame.payload) &&
            frame.payload.method === "session/load",
        ),
    ).toBe(true);

    await broker.registerDaemon("host-a", secondRelayDaemonSocket, {
      agentTypes: [{ id: "codex-acp", label: "Codex" }],
      workspaceRoots: [{ path: "/tmp" }],
    });
    await waitFor(() =>
      secondDaemonFrames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          isJsonRpcPayload(frame.payload) &&
          frame.payload.method === "session/load",
      ),
    );
  });

  it("queues restored session/load when a bound daemon is offline without reconnect state", async () => {
    const store = new AcpRelayInMemoryControlPlaneStore({
      accounts: [{ accountId: "acct-1" }],
      clientDevices: [{ accountId: "acct-1", clientId: "native-acp-client" }],
      grants: [
        {
          accountId: "acct-1",
          daemonId: "host-a",
          policyVersion: 7,
          scopes: ["acp:connect", "acp:session:resume"],
          workspaceRoots: ["/tmp/persisted-project"],
        },
      ],
      hosts: [{ accountId: "acct-1", daemonId: "host-a" }],
      sessionBindings: [
        {
          accountId: "acct-1",
          agent: { id: "codex-acp" },
          clientId: "native-acp-client",
          daemonId: "host-a",
          sessionId: "session-existing",
          workspaceRoots: ["/tmp/persisted-project"],
        },
      ],
    });
    const broker = new AcpRelayBroker({
      controlPlaneStore: store,
      daemonReconnectGraceMs: 1_000,
      ticketSigningKey,
    });
    const connectionId = "conn-session-load-daemon-offline";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const clientMessages: unknown[] = [];
    const daemonFrames: AcpRemoteFrame[] = [];

    nativeClientSocket.addEventListener("message", (event) => {
      clientMessages.push(JSON.parse(String(event.data)));
    });
    daemonSocket.addEventListener("message", (event) => {
      daemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    bindBrokerDaemonSocket(broker, relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });

    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "load-while-offline",
        jsonrpc: "2.0",
        method: "session/load",
        params: {
          cwd: "/tmp/project",
          mcpServers: [],
          sessionId: "session-existing",
        },
      }),
    );

    expect(clientMessages).not.toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          message: expect.stringContaining("Authentication required"),
        }),
      }),
    );
    expect(
      broker
        .clientStateSnapshot(connectionId)
        ?.daemonQueuedFrames.some(
          (frame) =>
            isJsonRpcPayload(frame.payload) &&
            frame.payload.method === "session/load",
        ),
    ).toBe(true);

    await broker.registerDaemon("host-a", relayDaemonSocket, {
      agentTypes: [{ id: "codex-acp", label: "Codex" }],
      workspaceRoots: [{ path: "/tmp" }],
    });
    await waitFor(() =>
      daemonFrames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          isJsonRpcPayload(frame.payload) &&
          frame.payload.method === "session/load",
      ),
    );
  });

  it("restores bound session traffic when bootstrap is incomplete but a stale ticket exists without a daemon route", async () => {
    const connectionId = "conn-session-bound-stale-ticket";
    const ticket = await createAcpRemoteSignedConnectionTicket({
      connectionId,
      grant: {
        accountId: "acct-1",
        agent: { id: "codex-acp" },
        clientId: "native-acp-client",
        daemonId: "host-a",
        policyVersion: 7,
        scopes: ["acp:connect", "acp:turn:send"],
        workspaceRoots: ["/tmp/persisted-project"],
      },
      key: ticketSigningKey,
    });
    const harness = createSessionBindingRestoreHarness({
      bootstrapComplete: false,
      connectionId,
      ticket,
    });

    await harness.sendPrompt("turn-stale-ticket-before-route");

    await waitForSessionPromptForward(harness.daemonFrames);
    expect(harness.clientMessages).not.toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          message: expect.stringContaining("select a host"),
        }),
      }),
    );
  });

  it("persists remote session bindings and restores later loads without client metadata", async () => {
    const store = createControlPlaneStore({
      scopes: [
        "acp:connect",
        "acp:session:create",
        "acp:session:resume",
      ],
    });
    const broker = new AcpRelayBroker({
      authWaitMs: 1_000,
      controlPlaneStore: store,
      ticketSigningKey,
    });
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const firstConnectionId = "conn-persist-binding-new";
    const secondConnectionId = "conn-persist-binding-load";
    const [firstNativeSocket, firstRelayClientSocket] = createMemoryWebSocketPair();
    const [secondNativeSocket, secondRelayClientSocket] =
      createMemoryWebSocketPair();
    let restoredLoadPayload: AnyMessage | undefined;

    bindBrokerDaemonSocket(broker, relayDaemonSocket);
    daemonSocket.addEventListener("message", (event) => {
      const frame = assertAcpRemoteFrame(JSON.parse(String(event.data)));
      if (frame.frameType !== AcpRemoteFrameType.Data) {
        return;
      }
      const payload = frame.payload as AnyMessage;
      if (!("id" in payload) || !("method" in payload)) {
        return;
      }
      if (payload.method === "session/new") {
        daemonSocket.send(
          JSON.stringify({
            channelId: "acp",
            channelKind: AcpRemoteChannelKind.Acp,
            connectionId: frame.connectionId,
            frameType: AcpRemoteFrameType.Data,
            payload: {
              id: payload.id,
              jsonrpc: "2.0",
              result: {
                _meta: {
                  "acp-runtime/remote/daemonId": "host-a",
                  "acp-runtime/remote/sessionAgent": { id: "codex-acp" },
                  "acp-runtime/remote/sessionWorkspaceRoots": [
                    "/tmp/persisted-project",
                  ],
                },
                sessionId: "persisted-session",
              },
            },
            seq: frame.seq + 100,
          } satisfies AcpRemoteDataFrame),
        );
      }
      if (payload.method === "session/load") {
        restoredLoadPayload = payload;
        daemonSocket.send(
          JSON.stringify({
            channelId: "acp",
            channelKind: AcpRemoteChannelKind.Acp,
            connectionId: frame.connectionId,
            frameType: AcpRemoteFrameType.Data,
            payload: {
              id: payload.id,
              jsonrpc: "2.0",
              result: { sessionId: "persisted-session" },
            },
            seq: frame.seq + 200,
          } satisfies AcpRemoteDataFrame),
        );
      }
    });

    broker.registerDaemon("host-a", relayDaemonSocket, {
      agentTypes: [{ id: "codex-acp", label: "Codex" }],
      workspaceRoots: [{ path: "/tmp" }],
    });
    bindBrokerClientSocket(broker, firstConnectionId, firstRelayClientSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${firstConnectionId}`,
      connectionId: firstConnectionId,
      socket: firstRelayClientSocket,
    });

    const firstClient = createClientConnection(firstNativeSocket);
    const firstSession = firstClient.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });
    await broker.authorizeClient({
      clientAgent: { id: "codex-acp" },
      connectionId: firstConnectionId,
      daemonId: "host-a",
      workspaceRoots: ["/tmp/persisted-project"],
    });
    await expect(firstSession).resolves.toMatchObject({
      sessionId: "persisted-session",
    });
    await waitForSessionBinding(store, "persisted-session");

    bindBrokerClientSocket(broker, secondConnectionId, secondRelayClientSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${secondConnectionId}`,
      connectionId: secondConnectionId,
      socket: secondRelayClientSocket,
    });
    const secondClient = createClientConnection(secondNativeSocket);

    await expect(
      secondClient.loadSession({
        cwd: "/tmp/project",
        mcpServers: [],
        sessionId: "persisted-session",
      }),
    ).resolves.toMatchObject({ sessionId: "persisted-session" });
    expect(restoredLoadPayload).toMatchObject({
      params: {
        _meta: {
          "acp-runtime/remote/sessionAgent": { id: "codex-acp" },
          "acp-runtime/remote/sessionWorkspaceRoots": [
            "/tmp/persisted-project",
          ],
        },
        cwd: "/tmp/persisted-project",
        sessionId: "persisted-session",
      },
    });

    firstNativeSocket.close();
    secondNativeSocket.close();
    daemonSocket.close();
  });

  it("allows native session/new bootstrap to resume after a pre-authorization client reconnect", async () => {
    let now = new Date("2026-04-27T00:00:00.000Z");
    const broker = new AcpRelayBroker({
      authWaitMs: 1_000,
      clientReconnectGraceMs: 100,
      controlPlaneStore: createControlPlaneStore(),
      now: () => now,
      ticketSigningKey,
    });
    const connectionId = "conn-session-new-preauth-reconnect";
    const [, firstRelayClientSocket] = createMemoryWebSocketPair();
    const [, secondRelayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    let forwardedSessionNew: AnyMessage | undefined;

    bindBrokerDaemonSocket(broker, relayDaemonSocket);
    daemonSocket.addEventListener("message", (event) => {
      const frame = assertAcpRemoteFrame(JSON.parse(String(event.data)));
      if (frame.frameType !== AcpRemoteFrameType.Data) {
        return;
      }
      const payload = frame.payload as AnyMessage;
      if (
        "id" in payload &&
        "method" in payload &&
        payload.method === "session/new"
      ) {
        forwardedSessionNew = payload;
      }
    });

    broker.registerDaemon("host-a", relayDaemonSocket, {
      agentTypes: [{ id: "codex-acp", label: "Codex" }],
      workspaceRoots: [{ path: "/tmp" }],
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      nativeClientAck: true,
      socket: firstRelayClientSocket,
    });

    const sessionNew = broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "session/new",
        params: {
          cwd: "/tmp/project",
          mcpServers: [],
        },
      }),
    );

    broker.removeClient(connectionId, firstRelayClientSocket);
    expect(broker.hasPendingClientReconnects()).toBe(true);

    now = new Date("2026-04-27T00:00:00.050Z");
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: secondRelayClientSocket,
    });
    expect(broker.hasPendingClientReconnects()).toBe(false);

    await expect(
      broker.authorizeClient({
        clientAgent: { id: "codex-acp" },
        connectionId,
        daemonId: "host-a",
        workspaceRoots: ["/tmp/selected-project"],
      }),
    ).resolves.toMatchObject({ ok: true });
    await sessionNew;

    expect(forwardedSessionNew).toMatchObject({
      params: {
        cwd: "/tmp/selected-project",
        _meta: {
          "acp-runtime/remote/sessionAgent": { id: "codex-acp" },
          "acp-runtime/remote/sessionWorkspaceRoots": [
            "/tmp/selected-project",
          ],
        },
      },
    });

    daemonSocket.close();
  });

  it("bootstraps a native ACP client, authorizes a host, then forwards ACP frames", async () => {
    const broker = new AcpRelayBroker({
      authWaitMs: 1_000,
      controlPlaneStore: createControlPlaneStore(),
      ticketSigningKey,
    });
    const connectionId = "conn-1";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    bindBrokerClientSocket(broker, connectionId, relayClientSocket);
    bindBrokerDaemonSocket(broker, relayDaemonSocket);

    let observedTicketKid: string | undefined;
    daemonSocket.addEventListener("message", (event) => {
      const frame = assertAcpRemoteFrame(JSON.parse(String(event.data)));
      if (frame.frameType === AcpRemoteFrameType.Hello) {
        observedTicketKid = frame.ticket?.kid;
        return;
      }
      if (frame.frameType !== AcpRemoteFrameType.Data) {
        return;
      }
      expect(frame.connectionId).toBe(connectionId);
      expect(frame.channelKind).toBe(AcpRemoteChannelKind.Acp);
      const payload = frame.payload as AnyMessage;
      if (
        "id" in payload &&
        "method" in payload &&
        payload.method === "session/new"
      ) {
        daemonSocket.send(
          JSON.stringify({
            channelId: "acp",
            channelKind: AcpRemoteChannelKind.Acp,
            connectionId,
            frameType: AcpRemoteFrameType.Data,
            payload: {
              id: payload.id,
              jsonrpc: "2.0",
              result: {
                sessionId: "session-1",
              },
            },
            seq: 1,
          } satisfies AcpRemoteDataFrame),
        );
      }
    });

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });

    const clientConnection = createClientConnection(nativeClientSocket);
    const initialize = await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(initialize.agentInfo?.name).toBe("acp-runtime-relay");
    expect(initialize.authMethods?.[0]?.id).toBe("acp-runtime-browser");

    const authentication = clientConnection.authenticate({
      methodId: "acp-runtime-browser",
    });
    await expect(broker.authorizableHostIds(connectionId)).resolves.toEqual([
      "host-a",
    ]);
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({
      ok: true,
    });
    await expect(authentication).resolves.toMatchObject({
      _meta: {
        "acp-runtime/remote/daemonId": "host-a",
        "acp-runtime/remote/ticketKid": "test-key",
      },
    });
    expect(observedTicketKid).toBe("test-key");

    const newSession = clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(newSession).resolves.toMatchObject({
      sessionId: "session-1",
    });

    nativeClientSocket.close();
    daemonSocket.close();
  });

  it("rejects runtime methods before host authorization", async () => {
    const broker = new AcpRelayBroker({
      authWaitMs: 10,
      controlPlaneStore: createControlPlaneStore(),
      ticketSigningKey,
    });
    const connectionId = "conn-2";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    bindBrokerClientSocket(broker, connectionId, relayClientSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });

    const clientConnection = createClientConnection(nativeClientSocket);
    await expect(
      clientConnection.newSession({
        cwd: "/tmp/project",
        mcpServers: [],
      }),
    ).rejects.toMatchObject({
      code: -32000,
    } satisfies Partial<RequestError>);

    nativeClientSocket.close();
  });

  it("rejects host authorization without an active grant", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        clientDevices: [
          { accountId: "acct-1", clientId: "native-acp-client" },
        ],
        hosts: [{ accountId: "acct-1", daemonId: "host-a" }],
      }),
      ticketSigningKey,
    });
    const [, relayClientSocket] = createMemoryWebSocketPair();
    const [, relayDaemonSocket] = createMemoryWebSocketPair();

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-no-grant",
      connectionId: "conn-no-grant",
      socket: relayClientSocket,
    });

    await expect(
      broker.authorizeClient({
        connectionId: "conn-no-grant",
        daemonId: "host-a",
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "No active grant allows this host.",
    });
    await expect(broker.authorizableHostIds("conn-no-grant")).resolves.toEqual(
      [],
    );
  });

  it("uses one-hour tickets and a five-minute renewal window by default", async () => {
    let now = new Date("2026-04-27T00:00:00.000Z");
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore({
        scopes: ["acp:connect", "acp:session:list"],
      }),
      now: () => now,
      ticketSigningKey,
    });
    const connectionId = "conn-default-ticket-renew";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const frames: AcpRemoteFrame[] = [];
    const clientMessages: unknown[] = [];
    daemonSocket.addEventListener("message", (event) => {
      frames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    nativeClientSocket.addEventListener("message", (event) => {
      clientMessages.push(JSON.parse(String(event.data)));
    });

    await broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await waitFor(() =>
      frames.some((frame) => frame.frameType === AcpRemoteFrameType.Hello),
    );
    const helloFrame = frames.find(
      (frame) => frame.frameType === AcpRemoteFrameType.Hello,
    );
    if (
      !helloFrame ||
      helloFrame.frameType !== AcpRemoteFrameType.Hello ||
      !helloFrame.ticket
    ) {
      throw new Error("Expected hello frame with ticket.");
    }
    expect(helloFrame.ticket.payload.expiresAt).toBe(
      "2026-04-27T01:00:00.000Z",
    );
    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "auth",
        jsonrpc: "2.0",
        method: "authenticate",
        params: {
          methodId: "acp-runtime-browser",
        },
      }),
    );
    frames.length = 0;
    clientMessages.length = 0;

    now = new Date("2026-04-27T00:56:00.000Z");
    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "session/list",
      }),
    );

    await waitFor(
      () => frames.some((frame) => frame.frameType === AcpRemoteFrameType.Renew),
    );
    const renewFrame = frames.find(
      (frame) => frame.frameType === AcpRemoteFrameType.Renew,
    );
    if (renewFrame?.frameType !== AcpRemoteFrameType.Renew) {
      throw new Error("Expected renew frame.");
    }
    expect(renewFrame.ticket.payload.issuedAt).toBe(
      "2026-04-27T00:56:00.000Z",
    );
    expect(renewFrame.ticket.payload.expiresAt).toBe(
      "2026-04-27T01:56:00.000Z",
    );
    expect(
      frames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          (frame.payload as { id?: unknown }).id === 1,
      ),
    ).toBe(true);
    expect(clientMessages).toEqual([]);
  });

  it("renews near-expiry tickets before forwarding bound ACP traffic", async () => {
    let now = new Date("2026-04-27T00:00:00.000Z");
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        clientDevices: [
          { accountId: "acct-1", clientId: "native-acp-client" },
        ],
        grants: [
          {
            accountId: "acct-1",
            daemonId: "host-a",
            policyVersion: 7,
            scopes: ["acp:connect", "acp:session:list"],
          },
        ],
        hosts: [{ accountId: "acct-1", daemonId: "host-a" }],
      }),
      now: () => now,
      ticketRenewBeforeMs: 900,
      ticketSigningKey,
      ticketTtlMs: 1_000,
    });
    const connectionId = "conn-renew";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const frames: AcpRemoteFrame[] = [];
    const clientMessages: unknown[] = [];
    daemonSocket.addEventListener("message", (event) => {
      frames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    nativeClientSocket.addEventListener("message", (event) => {
      clientMessages.push(JSON.parse(String(event.data)));
    });

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await waitFor(() =>
      frames.some((frame) => frame.frameType === AcpRemoteFrameType.Hello),
    );
    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "auth",
        jsonrpc: "2.0",
        method: "authenticate",
        params: {
          methodId: "acp-runtime-browser",
        },
      }),
    );
    frames.length = 0;
    clientMessages.length = 0;

    now = new Date("2026-04-27T00:00:00.200Z");
    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "session/list",
      }),
    );

    await waitFor(
      () => frames.some((frame) => frame.frameType === AcpRemoteFrameType.Renew),
    );
    const renewFrame = frames.find(
      (frame) => frame.frameType === AcpRemoteFrameType.Renew,
    );
    expect(renewFrame).toMatchObject({
      connectionId,
      frameType: AcpRemoteFrameType.Renew,
    });
    if (renewFrame?.frameType !== AcpRemoteFrameType.Renew) {
      throw new Error("Expected renew frame.");
    }
    expect(renewFrame.ticket.payload.issuedAt).toBe(
      "2026-04-27T00:00:00.200Z",
    );
    expect(
      frames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          (frame.payload as { id?: unknown }).id === 1,
      ),
    ).toBe(true);
    expect(clientMessages).toEqual([]);
  });

  it("renews near-expiry tickets through explicit ACP authenticate", async () => {
    let now = new Date("2026-04-27T00:00:00.000Z");
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        clientDevices: [
          { accountId: "acct-1", clientId: "native-acp-client" },
        ],
        grants: [
          {
            accountId: "acct-1",
            daemonId: "host-a",
            policyVersion: 7,
            scopes: ["acp:connect"],
          },
        ],
        hosts: [{ accountId: "acct-1", daemonId: "host-a" }],
      }),
      now: () => now,
      ticketRenewBeforeMs: 900,
      ticketSigningKey,
      ticketTtlMs: 1_000,
    });
    const connectionId = "conn-explicit-renew";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const frames: AcpRemoteFrame[] = [];
    const clientMessages: unknown[] = [];
    daemonSocket.addEventListener("message", (event) => {
      frames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    nativeClientSocket.addEventListener("message", (event) => {
      clientMessages.push(JSON.parse(String(event.data)));
    });

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "auth",
        jsonrpc: "2.0",
        method: "authenticate",
        params: {
          methodId: "acp-runtime-browser",
        },
      }),
    );
    frames.length = 0;
    clientMessages.length = 0;

    now = new Date("2026-04-27T00:00:00.200Z");
    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "renew",
        jsonrpc: "2.0",
        method: "authenticate",
        params: {
          methodId: "acp-runtime-browser",
        },
      }),
    );
    await waitFor(() =>
      frames.some((frame) => frame.frameType === AcpRemoteFrameType.Renew),
    );
    await waitFor(() => clientMessages.length > 0);
    expect(clientMessages[0]).toMatchObject({
      id: "renew",
      jsonrpc: "2.0",
      result: {
        _meta: {
          "acp-runtime/remote/daemonId": "host-a",
        },
      },
    });
  });

  it("renews near-expiry tickets before forwarding native session/new selections", async () => {
    let now = new Date("2026-04-27T00:00:00.000Z");
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        clientDevices: [
          { accountId: "acct-1", clientId: "native-acp-client" },
        ],
        grants: [
          {
            accountId: "acct-1",
            daemonId: "host-a",
            policyVersion: 7,
            scopes: ["acp:connect", "acp:session:create"],
          },
        ],
        hosts: [{ accountId: "acct-1", daemonId: "host-a" }],
      }),
      now: () => now,
      ticketRenewBeforeMs: 900,
      ticketSigningKey,
      ticketTtlMs: 1_000,
    });
    const connectionId = "conn-session-open-renew";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const frames: AcpRemoteFrame[] = [];
    let sessionNewPayload: AnyMessage | undefined;

    bindBrokerClientSocket(broker, connectionId, relayClientSocket);
    bindBrokerDaemonSocket(broker, relayDaemonSocket);
    daemonSocket.addEventListener("message", (event) => {
      const frame = assertAcpRemoteFrame(JSON.parse(String(event.data)));
      frames.push(frame);
      if (frame.frameType !== AcpRemoteFrameType.Data) {
        return;
      }
      const payload = frame.payload as AnyMessage;
      if (
        "id" in payload &&
        "method" in payload &&
        payload.method === "session/new"
      ) {
        sessionNewPayload = payload;
        daemonSocket.send(
          JSON.stringify({
            channelId: "acp",
            channelKind: AcpRemoteChannelKind.Acp,
            connectionId,
            frameType: AcpRemoteFrameType.Data,
            payload: {
              id: payload.id,
              jsonrpc: "2.0",
              result: { sessionId: "renewed-session" },
            },
            seq: 1,
          } satisfies AcpRemoteDataFrame),
        );
      }
    });

    broker.registerDaemon("host-a", relayDaemonSocket, {
      agentTypes: [{ id: "codex-acp", label: "Codex" }],
      workspaceRoots: [{ path: "/tmp" }],
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });

    const clientConnection = createClientConnection(nativeClientSocket);
    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    await clientConnection.authenticate({
      methodId: "acp-runtime-browser",
    });
    frames.length = 0;

    now = new Date("2026-04-27T00:00:00.200Z");
    const newSession = clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });
    await expect(
      broker.authorizeClient({
        clientAgent: { id: "codex-acp" },
        connectionId,
        daemonId: "host-a",
        workspaceRoots: ["/tmp/project"],
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(newSession).resolves.toMatchObject({
      sessionId: "renewed-session",
    });
    expect(
      frames.some((frame) => frame.frameType === AcpRemoteFrameType.Renew),
    ).toBe(true);
    expect(sessionNewPayload).toMatchObject({
      params: {
        cwd: "/tmp/project",
        _meta: {
          "acp-runtime/remote/sessionAgent": { id: "codex-acp" },
          "acp-runtime/remote/sessionWorkspaceRoots": ["/tmp/project"],
        },
      },
    });

    nativeClientSocket.close();
    daemonSocket.close();
  });

  it("renews first-party client tickets with a device-signed proof", async () => {
    let now = new Date("2026-04-27T00:00:00.000Z");
    const deviceKeyPair = await createAcpRemoteDeviceKeyPair();
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        clientDevices: [
          {
            accountId: "acct-1",
            clientId: "client-1",
            publicKey: deviceKeyPair.publicKey,
          },
        ],
        grants: [
          {
            accountId: "acct-1",
            clientId: "client-1",
            daemonId: "host-a",
            policyVersion: 7,
            scopes: ["acp:connect", "acp:session:list"],
          },
        ],
        hosts: [{ accountId: "acct-1", daemonId: "host-a" }],
      }),
      now: () => now,
      ticketSigningKey,
      ticketTtlMs: 1_000,
    });
    const connectionId = "conn-device-renew";
    const [, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const frames: AcpRemoteFrame[] = [];
    daemonSocket.addEventListener("message", (event) => {
      frames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      clientId: "client-1",
      connectionId,
      socket: relayClientSocket,
    });
    const authorization = await broker.authorizeClient({
      connectionId,
      daemonId: "host-a",
    });
    expect(authorization).toMatchObject({ ok: true });
    if (!authorization.ok) {
      throw new Error("Expected authorization.");
    }

    now = new Date("2026-04-27T00:00:00.500Z");
    const proofInput = {
      accountId: "acct-1",
      clientId: "client-1",
      connectionId,
      daemonId: "host-a",
      nonce: "nonce-device-renew",
      ticketJti: authorization.ticket.payload.jti,
      timestamp: String(now.getTime()),
    };
    const result = await broker.renewClientTicketWithDeviceProof({
      ...proofInput,
      signature: await createAcpRemoteDeviceRenewalSignature({
        ...proofInput,
        privateKey: deviceKeyPair.privateKey,
      }),
    });

    expect(result).toMatchObject({
      connectionId,
      daemonId: "host-a",
      ok: true,
    });
    if (!result.ok) {
      throw new Error("Expected renewal.");
    }
    expect(result.ticket.payload.jti).not.toBe(authorization.ticket.payload.jti);
    await waitFor(() =>
      frames.some((frame) => frame.frameType === AcpRemoteFrameType.Renew),
    );

    await expect(
      broker.renewClientTicketWithDeviceProof({
        ...proofInput,
        ticketJti: authorization.ticket.payload.jti,
        signature: "bad-signature",
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "ACP remote ticket mismatch.",
    });
  });

  it("queues and acknowledges non-ACP remote channel frames", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        clientDevices: [{ accountId: "acct-1", clientId: "client-1" }],
        grants: [
          {
            accountId: "acct-1",
            clientId: "client-1",
            daemonId: "host-a",
            policyVersion: 7,
            scopes: ["acp:connect", "fs:read", "terminal:start"],
          },
        ],
        hosts: [{ accountId: "acct-1", daemonId: "host-a" }],
      }),
      ticketSigningKey,
    });
    const connectionId = "conn-remote-frame";
    const [remoteClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const daemonFrames: AcpRemoteFrame[] = [];
    const clientFrames: AcpRemoteFrame[] = [];
    daemonSocket.addEventListener("message", (event) => {
      daemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    remoteClientSocket.addEventListener("message", (event) => {
      clientFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    bindBrokerClientSocket(broker, connectionId, relayClientSocket);
    bindBrokerDaemonSocket(broker, relayDaemonSocket);

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      clientId: "client-1",
      connectionId,
      daemonId: "host-a",
      socket: relayClientSocket,
      transport: "remote-frame",
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });

    remoteClientSocket.send(
      JSON.stringify({
        channelId: "fs:1",
        channelKind: AcpRemoteChannelKind.Filesystem,
        connectionId,
        frameType: AcpRemoteFrameType.Data,
        payload: {
          operation: "read",
          path: "/tmp/project/README.md",
        },
        seq: 1,
      } satisfies AcpRemoteDataFrame),
    );
    await waitFor(() =>
      daemonFrames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          frame.channelKind === AcpRemoteChannelKind.Filesystem,
      ),
    );
    const filesystemFrame = daemonFrames.find(
      (frame) =>
        frame.frameType === AcpRemoteFrameType.Data &&
        frame.channelKind === AcpRemoteChannelKind.Filesystem,
    );
    expect(filesystemFrame).toMatchObject({
      channelId: "fs:1",
      channelKind: AcpRemoteChannelKind.Filesystem,
      connectionId,
    });
    if (filesystemFrame?.frameType !== AcpRemoteFrameType.Data) {
      throw new Error("Expected filesystem data frame.");
    }
    daemonSocket.send(
      JSON.stringify({
        ack: filesystemFrame.seq,
        channelId: filesystemFrame.channelId,
        connectionId,
        frameType: AcpRemoteFrameType.Ack,
      }),
    );

    daemonSocket.send(
      JSON.stringify({
        channelId: "terminal:1",
        channelKind: AcpRemoteChannelKind.Terminal,
        connectionId,
        frameType: AcpRemoteFrameType.Data,
        payload: {
          operation: "start",
          terminalId: "term-1",
        },
        seq: 44,
      } satisfies AcpRemoteDataFrame),
    );
    await waitFor(() =>
      clientFrames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          frame.channelKind === AcpRemoteChannelKind.Terminal,
      ),
    );
    expect(clientFrames).toContainEqual(
      expect.objectContaining({
        channelId: "terminal:1",
        channelKind: AcpRemoteChannelKind.Terminal,
        connectionId,
      }),
    );
    await waitFor(() =>
      daemonFrames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Ack &&
          frame.channelId === "terminal:1" &&
          frame.ack === 44,
      ),
    );
  });

  it("queues remote-frame daemon payloads instead of closing when the client ack window is full", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        clientDevices: [{ accountId: "acct-1", clientId: "client-1" }],
        grants: [
          {
            accountId: "acct-1",
            clientId: "client-1",
            daemonId: "host-a",
            policyVersion: 7,
            scopes: ["acp:connect"],
          },
        ],
        hosts: [{ accountId: "acct-1", daemonId: "host-a" }],
      }),
      maxBufferedFramesPerConnection: 2,
      ticketSigningKey,
    });
    const connectionId = "conn-client-window-queue";
    const [remoteClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const daemonFrames: AcpRemoteFrame[] = [];
    const clientFrames: AcpRemoteFrame[] = [];
    daemonSocket.addEventListener("message", (event) => {
      daemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    remoteClientSocket.addEventListener("message", (event) => {
      clientFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    bindBrokerClientSocket(broker, connectionId, relayClientSocket);
    bindBrokerDaemonSocket(broker, relayDaemonSocket);

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      clientId: "client-1",
      connectionId,
      daemonId: "host-a",
      socket: relayClientSocket,
      transport: "remote-frame",
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await waitFor(() =>
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Data),
    );
    for (const frame of daemonFrames) {
      if (frame.frameType === AcpRemoteFrameType.Data) {
        daemonSocket.send(
          JSON.stringify({
            ack: frame.seq,
            channelId: frame.channelId,
            connectionId,
            frameType: AcpRemoteFrameType.Ack,
          }),
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    daemonFrames.length = 0;

    for (const seq of [41, 42, 43]) {
      daemonSocket.send(
        JSON.stringify({
          channelId: "terminal:1",
          channelKind: AcpRemoteChannelKind.Terminal,
          connectionId,
          frameType: AcpRemoteFrameType.Data,
          payload: {
            operation: "start",
            seq,
            terminalId: "term-1",
          },
          seq,
        } satisfies AcpRemoteDataFrame),
      );
    }

    await waitFor(
      () =>
        clientFrames.filter((frame) => frame.frameType === AcpRemoteFrameType.Data)
          .length === 2,
    );
    expect(
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Close),
    ).toBe(false);
    expect(
      daemonFrames
        .filter((frame): frame is AcpRemoteAckFrame =>
          frame.frameType === AcpRemoteFrameType.Ack,
        )
        .map((frame) => frame.ack),
    ).toEqual([41, 42]);

    const firstClientFrame = clientFrames.find(
      (frame): frame is AcpRemoteDataFrame =>
        frame.frameType === AcpRemoteFrameType.Data,
    );
    if (!firstClientFrame) {
      throw new Error("Expected first client data frame.");
    }
    remoteClientSocket.send(
      JSON.stringify({
        ack: firstClientFrame.seq,
        channelId: firstClientFrame.channelId,
        connectionId,
        frameType: AcpRemoteFrameType.Ack,
      } satisfies AcpRemoteAckFrame),
    );

    await waitFor(() =>
      clientFrames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data && frame.seq === 43,
      ),
    );
    await waitFor(() =>
      daemonFrames.some(
        (frame) => frame.frameType === AcpRemoteFrameType.Ack && frame.ack === 43,
      ),
    );
    expect(
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Close),
    ).toBe(false);
  });

  it("queues remote-frame client payloads while the daemon is reconnecting", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        clientDevices: [{ accountId: "acct-1", clientId: "client-1" }],
        grants: [
          {
            accountId: "acct-1",
            clientId: "client-1",
            daemonId: "host-a",
            policyVersion: 7,
            scopes: ["acp:connect", "fs:read"],
          },
        ],
        hosts: [{ accountId: "acct-1", daemonId: "host-a" }],
      }),
      daemonReconnectGraceMs: 100,
      ticketSigningKey,
    });
    const connectionId = "conn-remote-frame-daemon-reconnect";
    const [remoteClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [, firstRelayDaemonSocket] = createMemoryWebSocketPair();
    const [secondDaemonSocket, secondRelayDaemonSocket] =
      createMemoryWebSocketPair();
    const daemonFrames: AcpRemoteFrame[] = [];
    let remoteClosed = false;
    remoteClientSocket.addEventListener("close", () => {
      remoteClosed = true;
    });
    secondDaemonSocket.addEventListener("message", (event) => {
      daemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    bindBrokerClientSocket(broker, connectionId, relayClientSocket);

    await broker.registerDaemon("host-a", firstRelayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      clientId: "client-1",
      connectionId,
      daemonId: "host-a",
      socket: relayClientSocket,
      transport: "remote-frame",
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });

    broker.removeDaemon("host-a", firstRelayDaemonSocket);
    remoteClientSocket.send(
      JSON.stringify({
        channelId: "fs:reconnect",
        channelKind: AcpRemoteChannelKind.Filesystem,
        connectionId,
        frameType: AcpRemoteFrameType.Data,
        payload: {
          operation: "read",
          path: "/tmp/project/README.md",
        },
        seq: 1,
      } satisfies AcpRemoteDataFrame),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(remoteClosed).toBe(false);
    expect(
      broker
        .clientStateSnapshot(connectionId)
        ?.daemonQueuedFrames.some(
          (frame) => frame.channelId === "fs:reconnect",
        ),
    ).toBe(true);

    await broker.registerDaemon("host-a", secondRelayDaemonSocket);
    await waitFor(() =>
      daemonFrames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          frame.channelId === "fs:reconnect",
      ),
    );
    expect(remoteClosed).toBe(false);
  });

  it("rechecks grants before forwarding bound ACP traffic", async () => {
    const store = createControlPlaneStore();
    const broker = new AcpRelayBroker({
      controlPlaneStore: store,
      ticketSigningKey,
    });
    const connectionId = "conn-revoked";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const clientMessages: unknown[] = [];
    const daemonFrames: AcpRemoteFrame[] = [];
    let nativeClosed = false;
    nativeClientSocket.addEventListener("message", (event) => {
      clientMessages.push(JSON.parse(String(event.data)));
    });
    nativeClientSocket.addEventListener("close", () => {
      nativeClosed = true;
    });
    daemonSocket.addEventListener("message", (event) => {
      daemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await waitFor(() =>
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Hello),
    );
    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "auth",
        jsonrpc: "2.0",
        method: "authenticate",
        params: {
          methodId: "acp-runtime-browser",
        },
      }),
    );
    clientMessages.length = 0;
    daemonFrames.length = 0;

    store.upsertGrant({
      accountId: "acct-1",
      daemonId: "host-a",
      policyVersion: 8,
      revoked: true,
      scopes: ["acp:connect", "acp:session:create", "acp:turn:send"],
    });
    const turnMessage = broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "session/prompt",
        params: {
          prompt: [{ text: "hello", type: "text" }],
          sessionId: "session-1",
        },
      }),
    );
    await turnMessage;

    await waitFor(
      () =>
        nativeClosed &&
        daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Close),
    );
    if (clientMessages.length > 0) {
      expect(clientMessages[0]).toMatchObject({
        error: {
          code: -32000,
          message: "Authentication required: No active grant allows this host.",
        },
        id: 1,
        jsonrpc: "2.0",
      });
    }
    expect(
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Data),
    ).toBe(false);
  });

  it("proactively closes authorized routes after grant revocation reconcile", async () => {
    const store = createControlPlaneStore();
    const broker = new AcpRelayBroker({
      controlPlaneStore: store,
      ticketSigningKey,
    });
    const connectionId = "conn-reconcile-revoked";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const daemonFrames: AcpRemoteFrame[] = [];
    let nativeClosed = false;
    nativeClientSocket.addEventListener("close", () => {
      nativeClosed = true;
    });
    daemonSocket.addEventListener("message", (event) => {
      daemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "auth",
        jsonrpc: "2.0",
        method: "authenticate",
        params: {
          methodId: "acp-runtime-browser",
        },
      }),
    );
    daemonFrames.length = 0;

    store.upsertGrant({
      accountId: "acct-1",
      daemonId: "host-a",
      policyVersion: 8,
      revoked: true,
      scopes: ["acp:connect", "acp:session:create", "acp:turn:send"],
    });

    await expect(broker.reconcileAuthorizedRoutes()).resolves.toEqual([
      connectionId,
    ]);
    await waitFor(
      () =>
        nativeClosed &&
        daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Close),
    );
    expect(daemonFrames).toContainEqual(
      expect.objectContaining({
        code: "authorization_revoked",
        connectionId,
        frameType: AcpRemoteFrameType.Close,
        reason: "No active grant allows this host.",
      }),
    );
  });

  it("rejects bound ACP methods missing method scopes", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      ticketSigningKey,
    });
    const connectionId = "conn-missing-method-scope";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const clientMessages: unknown[] = [];
    const daemonFrames: AcpRemoteFrame[] = [];
    nativeClientSocket.addEventListener("message", (event) => {
      clientMessages.push(JSON.parse(String(event.data)));
    });
    daemonSocket.addEventListener("message", (event) => {
      daemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await waitFor(() =>
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Hello),
    );
    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "auth",
        jsonrpc: "2.0",
        method: "authenticate",
        params: {
          methodId: "acp-runtime-browser",
        },
      }),
    );
    clientMessages.length = 0;
    daemonFrames.length = 0;

    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "session/set_mode",
        params: {
          modeId: "plan",
          sessionId: "session-1",
        },
      }),
    );

    await waitFor(() => clientMessages.length > 0);
    expect(clientMessages[0]).toMatchObject({
      error: {
        code: -32000,
        data: {
          requiredScope: "acp:session:resume",
        },
        message: "Authentication required: No active grant allows this host.",
      },
      id: 1,
      jsonrpc: "2.0",
    });
    expect(
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Data),
    ).toBe(false);
  });

  it("closes bound clients when daemon reconnect grace is disabled", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      daemonReconnectGraceMs: 0,
      ticketSigningKey,
    });
    const connectionId = "conn-daemon-disconnect";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [, relayDaemonSocket] = createMemoryWebSocketPair();
    let nativeClosed = false;
    nativeClientSocket.addEventListener("close", () => {
      nativeClosed = true;
    });

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });

    broker.removeDaemon("host-a", relayDaemonSocket);

    await waitFor(() => nativeClosed);
  });

  it("keeps bound clients during short daemon reconnects", async () => {
    let now = new Date("2026-04-27T00:00:00.000Z");
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      daemonReconnectGraceMs: 100,
      now: () => now,
      ticketSigningKey,
    });
    const connectionId = "conn-daemon-reconnect";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [, firstRelayDaemonSocket] = createMemoryWebSocketPair();
    const [secondDaemonSocket, secondRelayDaemonSocket] =
      createMemoryWebSocketPair();
    const daemonFrames: AcpRemoteFrame[] = [];
    secondDaemonSocket.addEventListener("message", (event) => {
      daemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    let nativeClosed = false;
    nativeClientSocket.addEventListener("close", () => {
      nativeClosed = true;
    });

    await broker.registerDaemon("host-a", firstRelayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "auth",
        jsonrpc: "2.0",
        method: "authenticate",
        params: {
          methodId: "acp-runtime-browser",
        },
      }),
    );

    broker.removeDaemon("host-a", firstRelayDaemonSocket);
    expect(nativeClosed).toBe(false);
    expect(broker.onlineHostIds()).toEqual([]);
    expect(broker.hasPendingDaemonReconnects()).toBe(true);

    now = new Date("2026-04-27T00:00:00.050Z");
    broker.registerDaemon("host-a", secondRelayDaemonSocket);
    await waitFor(() =>
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Hello),
    );
    expect(broker.hasPendingDaemonReconnects()).toBe(false);
    daemonFrames.length = 0;

    const sessionMessage = broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "session/new",
        params: {
          cwd: "/tmp/project",
          mcpServers: [],
        },
      }),
    );
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await sessionMessage;

    await waitFor(() =>
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Data),
    );
    expect(nativeClosed).toBe(false);
  });

  it("queues bound ACP requests while the daemon is reconnecting", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore({
        scopes: [
          "acp:connect",
          "acp:session:create",
          "acp:session:resume",
          "acp:turn:send",
        ],
      }),
      daemonReconnectGraceMs: 100,
      ticketSigningKey,
    });
    const connectionId = "conn-daemon-reconnect-queue";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [firstDaemonSocket, firstRelayDaemonSocket] =
      createMemoryWebSocketPair();
    const [secondDaemonSocket, secondRelayDaemonSocket] =
      createMemoryWebSocketPair();
    const clientMessages: unknown[] = [];
    const firstDaemonFrames: AcpRemoteFrame[] = [];
    const daemonFrames: AcpRemoteFrame[] = [];
    let nativeClosed = false;
    nativeClientSocket.addEventListener("message", (event) => {
      clientMessages.push(JSON.parse(String(event.data)));
    });
    nativeClientSocket.addEventListener("close", () => {
      nativeClosed = true;
    });
    secondDaemonSocket.addEventListener("message", (event) => {
      daemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    firstDaemonSocket.addEventListener("message", (event) => {
      firstDaemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    bindBrokerDaemonSocket(broker, firstRelayDaemonSocket);

    await broker.registerDaemon("host-a", firstRelayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "auth",
        jsonrpc: "2.0",
        method: "authenticate",
        params: {
          methodId: "acp-runtime-browser",
        },
      }),
    );

    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "set-bypass",
        jsonrpc: "2.0",
        method: "session/set_config_option",
        params: {
          configId: "approval-policy",
          sessionId: "session-1",
          value: "yolo",
        },
      }),
    );
    await waitFor(() =>
      firstDaemonFrames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          isJsonRpcPayload(frame.payload) &&
          frame.payload.method === "session/set_config_option",
      ),
    );
    const setConfigFrame = firstDaemonFrames.find(
      (frame): frame is AcpRemoteDataFrame =>
        frame.frameType === AcpRemoteFrameType.Data &&
        isJsonRpcPayload(frame.payload) &&
        frame.payload.method === "session/set_config_option",
    );
    if (!setConfigFrame) {
      throw new Error("Expected set config frame.");
    }
    firstDaemonSocket.send(
      JSON.stringify({
        ack: setConfigFrame.seq,
        channelId: setConfigFrame.channelId,
        connectionId,
        frameType: AcpRemoteFrameType.Ack,
      } satisfies AcpRemoteAckFrame),
    );
    firstDaemonSocket.send(
      JSON.stringify({
        channelId: "acp",
        channelKind: AcpRemoteChannelKind.Acp,
        connectionId,
        frameType: AcpRemoteFrameType.Data,
        payload: {
          id: "set-bypass",
          jsonrpc: "2.0",
          result: { configOptions: [] },
        },
        seq: 50,
      } satisfies AcpRemoteDataFrame),
    );
    await waitFor(() =>
      clientMessages.some(
        (message) => isJsonRpcResponse(message) && message.id === "set-bypass",
      ),
    );
    expect(
      broker
        .clientStateSnapshot(connectionId)
        ?.sessionControlRequests?.some(
          (request) => request.method === "session/set_config_option",
        ),
    ).toBe(true);
    clientMessages.length = 0;

    broker.removeDaemon("host-a", firstRelayDaemonSocket);
    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "queued-turn",
        jsonrpc: "2.0",
        method: "session/prompt",
        params: {
          prompt: [{ content: "keep going", type: "text" }],
          sessionId: "session-1",
        },
      }),
    );

    expect(nativeClosed).toBe(false);
    expect(
      clientMessages.some(
        (message) =>
          isJsonRpcResponse(message) &&
          message.id === "queued-turn" &&
          "error" in message,
      ),
    ).toBe(false);
    expect(
      broker
        .clientStateSnapshot(connectionId)
        ?.daemonQueuedFrames.some(
          (frame) =>
            isJsonRpcPayload(frame.payload) &&
            frame.payload.method === "session/prompt",
        ),
    ).toBe(true);

    await broker.registerDaemon("host-a", secondRelayDaemonSocket);
    await waitFor(() =>
      daemonFrames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          isJsonRpcPayload(frame.payload) &&
          frame.payload.method === "session/prompt",
      ),
    );
    const replayedMethods = daemonFrames.flatMap((frame) =>
      frame.frameType === AcpRemoteFrameType.Data &&
      isJsonRpcPayload(frame.payload)
        ? [frame.payload.method]
        : [],
    );
    expect(replayedMethods).toContain("session/set_config_option");
    expect(replayedMethods.indexOf("session/set_config_option")).toBeLessThan(
      replayedMethods.indexOf("session/prompt"),
    );
    expect(nativeClosed).toBe(false);
  });

  it("expires bound clients after daemon reconnect grace", async () => {
    let now = new Date("2026-04-27T00:00:00.000Z");
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      daemonReconnectGraceMs: 100,
      now: () => now,
      ticketSigningKey,
    });
    const connectionId = "conn-daemon-reconnect-expired";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [, relayDaemonSocket] = createMemoryWebSocketPair();
    let nativeClosed = false;
    nativeClientSocket.addEventListener("close", () => {
      nativeClosed = true;
    });

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });

    broker.removeDaemon("host-a", relayDaemonSocket);
    now = new Date("2026-04-27T00:00:00.101Z");

    expect(broker.closeExpiredDisconnectedDaemons()).toEqual(["host-a"]);
    await waitFor(() => nativeClosed);
    expect(broker.hasPendingDaemonReconnects()).toBe(false);
  });

  it("keeps bound client routes during short reconnects", async () => {
    let now = new Date("2026-04-27T00:00:00.000Z");
    const broker = new AcpRelayBroker({
      clientReconnectGraceMs: 100,
      controlPlaneStore: createControlPlaneStore(),
      now: () => now,
      ticketSigningKey,
    });
    const connectionId = "conn-client-reconnect";
    const [, firstRelayClientSocket] = createMemoryWebSocketPair();
    const [, secondRelayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const daemonFrames: AcpRemoteFrame[] = [];
    daemonSocket.addEventListener("message", (event) => {
      daemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      nativeClientAck: true,
      socket: firstRelayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "auth",
        jsonrpc: "2.0",
        method: "authenticate",
        params: {
          methodId: "acp-runtime-browser",
        },
      }),
    );
    await waitFor(() =>
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Hello),
    );
    daemonFrames.length = 0;

    broker.removeClient(connectionId, firstRelayClientSocket);
    expect(broker.hasPendingClientReconnects()).toBe(true);
    expect(
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Close),
    ).toBe(false);

    now = new Date("2026-04-27T00:00:00.050Z");
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: secondRelayClientSocket,
    });
    expect(broker.hasPendingClientReconnects()).toBe(false);

    const sessionMessage = broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "session/new",
        params: {
          cwd: "/tmp/project",
          mcpServers: [],
        },
      }),
    );
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await sessionMessage;

    await waitFor(() =>
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Data),
    );
    expect(
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Close),
    ).toBe(false);
  });

  it("buffers daemon payloads during client reconnect grace and flushes on resume", async () => {
    let now = new Date("2026-04-27T00:00:00.000Z");
    const broker = new AcpRelayBroker({
      clientReconnectGraceMs: 100,
      controlPlaneStore: createControlPlaneStore(),
      now: () => now,
      ticketSigningKey,
    });
    const connectionId = "conn-client-buffered";
    const [, relayClientSocket] = createMemoryWebSocketPair();
    const [resumedNativeSocket, resumedRelaySocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const resumedMessages: unknown[] = [];
    resumedNativeSocket.addEventListener("message", (event) => {
      resumedMessages.push(JSON.parse(String(event.data)));
    });

    bindBrokerClientSocket(broker, connectionId, relayClientSocket);
    bindBrokerClientSocket(broker, connectionId, resumedRelaySocket);
    bindBrokerDaemonSocket(broker, relayDaemonSocket);

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "auth",
        jsonrpc: "2.0",
        method: "authenticate",
        params: {
          methodId: "acp-runtime-browser",
        },
      }),
    );

    broker.removeClient(connectionId, relayClientSocket);
    daemonSocket.send(
      JSON.stringify({
        channelId: "acp",
        channelKind: AcpRemoteChannelKind.Acp,
        connectionId,
        frameType: AcpRemoteFrameType.Data,
        payload: {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
          },
        },
        seq: 1,
      } satisfies AcpRemoteDataFrame),
    );

    now = new Date("2026-04-27T00:00:00.050Z");
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: resumedRelaySocket,
    });

    await waitFor(() => resumedMessages.length > 0);
    expect(resumedMessages[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "session/update",
    });
  });

  it("replays unacknowledged native ACP responses after client reconnect", async () => {
    let now = new Date("2026-04-27T00:00:00.000Z");
    const broker = new AcpRelayBroker({
      clientReconnectGraceMs: 100,
      controlPlaneStore: createControlPlaneStore(),
      now: () => now,
      ticketSigningKey,
    });
    const connectionId = "conn-native-response-replay";
    const [firstNativeSocket, firstRelayClientSocket] = createMemoryWebSocketPair();
    const [resumedNativeSocket, resumedRelayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const firstMessages: unknown[] = [];
    const resumedMessages: unknown[] = [];
    const daemonFrames: AcpRemoteFrame[] = [];

    firstNativeSocket.addEventListener("message", (event) => {
      firstMessages.push(JSON.parse(String(event.data)));
    });
    resumedNativeSocket.addEventListener("message", (event) => {
      resumedMessages.push(JSON.parse(String(event.data)));
    });
    daemonSocket.addEventListener("message", (event) => {
      daemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    bindBrokerClientSocket(broker, connectionId, firstRelayClientSocket);
    bindBrokerClientSocket(broker, connectionId, resumedRelayClientSocket);
    bindBrokerDaemonSocket(broker, relayDaemonSocket);

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      nativeClientAck: true,
      socket: firstRelayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    daemonFrames.length = 0;

    daemonSocket.send(
      JSON.stringify({
        channelId: "acp",
        channelKind: AcpRemoteChannelKind.Acp,
        connectionId,
        frameType: AcpRemoteFrameType.Data,
        payload: {
          id: 1,
          jsonrpc: "2.0",
          result: { sessionId: "session-1" },
        },
        seq: 41,
      } satisfies AcpRemoteDataFrame),
    );

    await waitFor(() => firstMessages.length > 0);
    expect(firstMessages[0]).toMatchObject({ id: 1, jsonrpc: "2.0" });
    expect(
      daemonFrames.some(
        (frame) => frame.frameType === AcpRemoteFrameType.Ack && frame.ack === 41,
      ),
    ).toBe(false);

    broker.removeClient(connectionId, firstRelayClientSocket);
    now = new Date("2026-04-27T00:00:00.050Z");
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      nativeClientAck: true,
      socket: resumedRelayClientSocket,
    });

    await waitFor(() => resumedMessages.length > 0);
    expect(resumedMessages[0]).toMatchObject({ id: 1, jsonrpc: "2.0" });

    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "acp-runtime/remote/client_ack",
        params: { id: 1 },
      }),
    );
    await waitFor(() =>
      daemonFrames.some(
        (frame) => frame.frameType === AcpRemoteFrameType.Ack && frame.ack === 41,
      ),
    );
  });

  it("suppresses duplicate native ACP prompts while the daemon response is pending", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      ticketSigningKey,
    });
    const connectionId = "conn-native-prompt-dedupe-pending";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const daemonFrames: AcpRemoteFrame[] = [];
    nativeClientSocket.addEventListener("message", () => {});
    daemonSocket.addEventListener("message", (event) => {
      daemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    bindBrokerClientSocket(broker, connectionId, relayClientSocket);
    bindBrokerDaemonSocket(broker, relayDaemonSocket);

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      bootstrapComplete: true,
      connectionId,
      nativeClientAck: true,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    daemonFrames.length = 0;

    const prompt = {
      id: "prompt-1",
      jsonrpc: "2.0",
      method: "session/prompt",
      params: {
        prompt: [{ text: "hi", type: "text" }],
        sessionId: "session-1",
      },
    };
    await broker.handleClientText(connectionId, JSON.stringify(prompt));
    await broker.handleClientText(connectionId, JSON.stringify(prompt));

    await waitFor(() =>
      daemonFrames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          isJsonRpcPayload(frame.payload) &&
          frame.payload.method === "session/prompt",
      ),
    );
    const promptFrames = daemonFrames.filter(
      (frame) =>
        frame.frameType === AcpRemoteFrameType.Data &&
        isJsonRpcPayload(frame.payload) &&
        frame.payload.method === "session/prompt",
    );
    expect(promptFrames).toHaveLength(1);
  });

  it("replays a pending native ACP response for duplicate prompt ids", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      ticketSigningKey,
    });
    const connectionId = "conn-native-prompt-dedupe-response";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const clientMessages: unknown[] = [];
    const daemonFrames: AcpRemoteFrame[] = [];
    nativeClientSocket.addEventListener("message", (event) => {
      clientMessages.push(JSON.parse(String(event.data)));
    });
    daemonSocket.addEventListener("message", (event) => {
      daemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    bindBrokerClientSocket(broker, connectionId, relayClientSocket);
    bindBrokerDaemonSocket(broker, relayDaemonSocket);

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      bootstrapComplete: true,
      connectionId,
      nativeClientAck: true,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    daemonFrames.length = 0;

    const prompt = {
      id: "prompt-1",
      jsonrpc: "2.0",
      method: "session/prompt",
      params: {
        prompt: [{ text: "hi", type: "text" }],
        sessionId: "session-1",
      },
    };
    await broker.handleClientText(connectionId, JSON.stringify(prompt));
    await waitFor(() =>
      daemonFrames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          isJsonRpcPayload(frame.payload) &&
          frame.payload.method === "session/prompt",
      ),
    );
    const promptFrame = daemonFrames.find(
      (frame): frame is AcpRemoteDataFrame =>
        frame.frameType === AcpRemoteFrameType.Data &&
        isJsonRpcPayload(frame.payload) &&
        frame.payload.method === "session/prompt",
    );
    if (!promptFrame) {
      throw new Error("Expected forwarded prompt frame.");
    }
    daemonSocket.send(
      JSON.stringify({
        channelId: "acp",
        channelKind: AcpRemoteChannelKind.Acp,
        connectionId,
        frameType: AcpRemoteFrameType.Data,
        payload: {
          id: "prompt-1",
          jsonrpc: "2.0",
          result: { stopReason: "end_turn" },
        },
        seq: 42,
      } satisfies AcpRemoteDataFrame),
    );
    await waitFor(() =>
      clientMessages.some(
        (message) => isJsonRpcResponse(message) && message.id === "prompt-1",
      ),
    );

    await broker.handleClientText(connectionId, JSON.stringify(prompt));
    await waitFor(() =>
      clientMessages.filter(
        (message) => isJsonRpcResponse(message) && message.id === "prompt-1",
      ).length === 2,
    );
    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "acp-runtime/remote/client_ack",
        params: { id: "prompt-1" },
      }),
    );
    await broker.handleClientText(connectionId, JSON.stringify(prompt));
    await waitFor(() =>
      clientMessages.filter(
        (message) => isJsonRpcResponse(message) && message.id === "prompt-1",
      ).length === 3,
    );
    const promptFrames = daemonFrames.filter(
      (frame) =>
        frame.frameType === AcpRemoteFrameType.Data &&
        isJsonRpcPayload(frame.payload) &&
        frame.payload.method === "session/prompt",
    );
    expect(promptFrames).toHaveLength(1);
  });

  it("expires disconnected client routes after reconnect grace", async () => {
    let now = new Date("2026-04-27T00:00:00.000Z");
    const broker = new AcpRelayBroker({
      clientReconnectGraceMs: 100,
      controlPlaneStore: createControlPlaneStore(),
      now: () => now,
      ticketSigningKey,
    });
    const connectionId = "conn-client-reconnect-expired";
    const [, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const daemonFrames: AcpRemoteFrame[] = [];
    daemonSocket.addEventListener("message", (event) => {
      daemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "auth",
        jsonrpc: "2.0",
        method: "authenticate",
        params: {
          methodId: "acp-runtime-browser",
        },
      }),
    );
    await waitFor(() =>
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Hello),
    );
    daemonFrames.length = 0;

    broker.removeClient(connectionId, relayClientSocket);
    now = new Date("2026-04-27T00:00:00.101Z");

    expect(broker.closeExpiredDisconnectedClients()).toEqual([connectionId]);
    await waitFor(() =>
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Close),
    );
    expect(daemonFrames).toContainEqual(
      expect.objectContaining({
        code: "client_reconnect_timeout",
        connectionId,
        frameType: AcpRemoteFrameType.Close,
      }),
    );
    expect(broker.hasPendingClientReconnects()).toBe(false);
  });

  it("keeps default disconnected client routes resumable beyond five minutes", async () => {
    let now = new Date("2026-04-27T00:00:00.000Z");
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore({
        scopes: ["acp:connect", "acp:session:list"],
      }),
      now: () => now,
      ticketSigningKey,
    });
    const connectionId = "conn-client-default-reconnect-grace";
    const [, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const daemonFrames: AcpRemoteFrame[] = [];
    daemonSocket.addEventListener("message", (event) => {
      daemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });

    await broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "auth",
        jsonrpc: "2.0",
        method: "authenticate",
        params: {
          methodId: "acp-runtime-browser",
        },
      }),
    );
    await waitFor(() =>
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Hello),
    );
    daemonFrames.length = 0;

    broker.removeClient(connectionId, relayClientSocket);
    now = new Date("2026-04-27T00:10:00.000Z");

    expect(broker.closeExpiredDisconnectedClients()).toEqual([]);
    expect(broker.hasPendingClientReconnects()).toBe(true);

    const [, resumedRelayClientSocket] = createMemoryWebSocketPair();
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: resumedRelayClientSocket,
    });
    expect(broker.hasPendingClientReconnects()).toBe(false);

    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "session/list",
      }),
    );
    await waitFor(() =>
      daemonFrames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          (frame.payload as { id?: unknown }).id === 1,
      ),
    );
    daemonFrames.length = 0;

    broker.removeClient(connectionId, resumedRelayClientSocket);
    now = new Date("2026-04-28T00:10:00.001Z");

    expect(broker.closeExpiredDisconnectedClients()).toEqual([connectionId]);
    await waitFor(() =>
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Close),
    );
    expect(daemonFrames).toContainEqual(
      expect.objectContaining({
        code: "client_reconnect_timeout",
        connectionId,
        frameType: AcpRemoteFrameType.Close,
      }),
    );
  });

  it("replays unacked daemon frames after daemon reconnect", async () => {
    let now = new Date("2026-04-27T00:00:00.000Z");
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      daemonReconnectGraceMs: 100,
      now: () => now,
      ticketSigningKey,
    });
    const connectionId = "conn-daemon-replay";
    const [, relayClientSocket] = createMemoryWebSocketPair();
    const [, firstRelayDaemonSocket] = createMemoryWebSocketPair();
    const [secondDaemonSocket, secondRelayDaemonSocket] =
      createMemoryWebSocketPair();
    const replayedFrames: AcpRemoteFrame[] = [];
    secondDaemonSocket.addEventListener("message", (event) => {
      replayedFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });

    await broker.registerDaemon("host-a", firstRelayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "auth",
        jsonrpc: "2.0",
        method: "authenticate",
        params: {
          methodId: "acp-runtime-browser",
        },
      }),
    );
    const sessionMessage = broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "session/new",
        params: {
          cwd: "/tmp/project",
          mcpServers: [],
        },
      }),
    );
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await sessionMessage;

    broker.removeDaemon("host-a", firstRelayDaemonSocket);
    now = new Date("2026-04-27T00:00:00.050Z");
    broker.registerDaemon("host-a", secondRelayDaemonSocket);

    await waitFor(() =>
      replayedFrames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          isJsonRpcPayload(frame.payload) &&
          frame.payload.method === "session/new",
      ),
    );
  });

  it("fails acked daemon requests with unknown status after daemon runtime restart", async () => {
    let now = new Date("2026-04-27T00:00:00.000Z");
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      daemonReconnectGraceMs: 100,
      now: () => now,
      ticketSigningKey,
    });
    const connectionId = "conn-daemon-acked-request-replay";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [firstDaemonSocket, firstRelayDaemonSocket] =
      createMemoryWebSocketPair();
    const [secondDaemonSocket, secondRelayDaemonSocket] =
      createMemoryWebSocketPair();
    const clientMessages: unknown[] = [];
    const firstDaemonFrames: AcpRemoteFrame[] = [];
    const secondDaemonFrames: AcpRemoteFrame[] = [];
    nativeClientSocket.addEventListener("message", (event) => {
      clientMessages.push(JSON.parse(String(event.data)));
    });
    firstDaemonSocket.addEventListener("message", (event) => {
      firstDaemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    secondDaemonSocket.addEventListener("message", (event) => {
      secondDaemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    bindBrokerDaemonSocket(broker, firstRelayDaemonSocket);
    bindBrokerDaemonSocket(broker, secondRelayDaemonSocket);

    await broker.registerDaemon("host-a", firstRelayDaemonSocket, {
      agentTypes: [],
      runtimeInstanceId: "runtime-run-1",
      workspaceRoots: [],
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      bootstrapComplete: true,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });

    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "turn-after-ack",
        jsonrpc: "2.0",
        method: "session/prompt",
        params: {
          prompt: [{ content: "continue after reconnect", type: "text" }],
          sessionId: "session-1",
        },
      }),
    );

    await waitFor(() =>
      firstDaemonFrames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          isJsonRpcPayload(frame.payload) &&
          frame.payload.method === "session/prompt",
      ),
    );
    const promptFrame = firstDaemonFrames.find(
      (frame): frame is AcpRemoteDataFrame =>
        frame.frameType === AcpRemoteFrameType.Data &&
        isJsonRpcPayload(frame.payload) &&
        frame.payload.method === "session/prompt",
    );
    if (!promptFrame) {
      throw new Error("Expected daemon prompt frame.");
    }
    firstDaemonSocket.send(
      JSON.stringify({
        ack: promptFrame.seq,
        channelId: promptFrame.channelId,
        connectionId,
        frameType: AcpRemoteFrameType.Ack,
      } satisfies AcpRemoteAckFrame),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      broker
        .clientStateSnapshot(connectionId)
        ?.daemonPendingFrames.some(
          (frame) =>
            isJsonRpcPayload(frame.payload) &&
            frame.payload.method === "session/prompt",
        ),
    ).toBe(false);

    broker.removeDaemon("host-a", firstRelayDaemonSocket);
    now = new Date("2026-04-27T00:00:00.050Z");
    await broker.registerDaemon("host-a", secondRelayDaemonSocket, {
      agentTypes: [],
      runtimeInstanceId: "runtime-run-2",
      workspaceRoots: [],
    });
    await waitFor(() =>
      secondDaemonFrames.some(
        (frame) => frame.frameType === AcpRemoteFrameType.Hello,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      secondDaemonFrames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          isJsonRpcPayload(frame.payload) &&
          frame.payload.method === "session/prompt" &&
          "id" in frame.payload &&
          frame.payload.id === "turn-after-ack",
      ),
    ).toBe(false);
    expect(clientMessages).toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          data: expect.objectContaining({
            reason: "daemon_restarted",
          }),
          message: expect.stringContaining("status is unknown"),
        }),
        id: "turn-after-ack",
        jsonrpc: "2.0",
      }),
    );
  });

  it("replays acked session/load after daemon runtime restart", async () => {
    let now = new Date("2026-04-27T00:00:00.000Z");
    const store = new AcpRelayInMemoryControlPlaneStore({
      accounts: [{ accountId: "acct-1" }],
      clientDevices: [{ accountId: "acct-1", clientId: "native-acp-client" }],
      grants: [
        {
          accountId: "acct-1",
          daemonId: "host-a",
          policyVersion: 7,
          scopes: ["acp:connect", "acp:session:resume"],
          workspaceRoots: ["/tmp"],
        },
      ],
      hosts: [{ accountId: "acct-1", daemonId: "host-a" }],
      sessionBindings: [
        {
          accountId: "acct-1",
          agent: { id: "codex-acp" },
          clientId: "native-acp-client",
          daemonId: "host-a",
          sessionId: "session-existing",
          workspaceRoots: ["/tmp"],
        },
      ],
    });
    const broker = new AcpRelayBroker({
      controlPlaneStore: store,
      daemonReconnectGraceMs: 100,
      now: () => now,
      ticketSigningKey,
    });
    const connectionId = "conn-daemon-acked-load-replay";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [firstDaemonSocket, firstRelayDaemonSocket] =
      createMemoryWebSocketPair();
    const [secondDaemonSocket, secondRelayDaemonSocket] =
      createMemoryWebSocketPair();
    const clientMessages: unknown[] = [];
    const firstDaemonFrames: AcpRemoteFrame[] = [];
    const secondDaemonFrames: AcpRemoteFrame[] = [];
    nativeClientSocket.addEventListener("message", (event) => {
      clientMessages.push(JSON.parse(String(event.data)));
    });
    firstDaemonSocket.addEventListener("message", (event) => {
      firstDaemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    secondDaemonSocket.addEventListener("message", (event) => {
      secondDaemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    bindBrokerDaemonSocket(broker, firstRelayDaemonSocket);
    bindBrokerDaemonSocket(broker, secondRelayDaemonSocket);

    await broker.registerDaemon("host-a", firstRelayDaemonSocket, {
      agentTypes: [],
      runtimeInstanceId: "runtime-run-1",
      workspaceRoots: [],
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      bootstrapComplete: true,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    expect(
      broker.clientStateSnapshot(connectionId)?.daemonRuntimeInstanceId,
    ).toBe("runtime-run-1");

    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "load-after-ack",
        jsonrpc: "2.0",
        method: "session/load",
        params: {
          cwd: "/tmp/project",
          mcpServers: [],
          sessionId: "session-existing",
        },
      }),
    );

    await waitFor(() =>
      firstDaemonFrames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          isJsonRpcPayload(frame.payload) &&
          frame.payload.method === "session/load",
      ),
    );
    const loadFrame = firstDaemonFrames.find(
      (frame): frame is AcpRemoteDataFrame =>
        frame.frameType === AcpRemoteFrameType.Data &&
        isJsonRpcPayload(frame.payload) &&
        frame.payload.method === "session/load",
    );
    if (!loadFrame) {
      throw new Error("Expected daemon load frame.");
    }
    firstDaemonSocket.send(
      JSON.stringify({
        ack: loadFrame.seq,
        channelId: loadFrame.channelId,
        connectionId,
        frameType: AcpRemoteFrameType.Ack,
      } satisfies AcpRemoteAckFrame),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      broker.clientStateSnapshot(connectionId)?.daemonRequests.some(
        (request) => request.id === "load-after-ack",
      ),
    ).toBe(true);
    expect(
      broker
        .clientStateSnapshot(connectionId)
        ?.daemonPendingFrames.some(
          (frame) =>
            isJsonRpcPayload(frame.payload) &&
            frame.payload.method === "session/load",
        ),
    ).toBe(false);

    broker.removeDaemon("host-a", firstRelayDaemonSocket);
    now = new Date("2026-04-27T00:00:00.050Z");
    await broker.registerDaemon("host-a", secondRelayDaemonSocket, {
      agentTypes: [],
      runtimeInstanceId: "runtime-run-2",
      workspaceRoots: [],
    });

    await waitFor(() =>
      secondDaemonFrames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          isJsonRpcPayload(frame.payload) &&
          frame.payload.method === "session/load" &&
          "id" in frame.payload &&
          frame.payload.id === "load-after-ack",
      ),
    );
    expect(clientMessages).not.toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          data: expect.objectContaining({
            reason: "daemon_restarted",
          }),
        }),
        id: "load-after-ack",
        jsonrpc: "2.0",
      }),
    );
  });

  it("renews expired tickets before reopening routes after daemon reconnect", async () => {
    let now = new Date("2026-04-27T00:00:00.000Z");
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      daemonReconnectGraceMs: 60_000,
      now: () => now,
      ticketRenewBeforeMs: 1_000,
      ticketSigningKey,
      ticketTtlMs: 5_000,
    });
    const connectionId = "conn-daemon-reconnect-ticket-renew";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [firstDaemonSocket, firstRelayDaemonSocket] =
      createMemoryWebSocketPair();
    const [secondDaemonSocket, secondRelayDaemonSocket] =
      createMemoryWebSocketPair();
    const firstDaemonFrames: AcpRemoteFrame[] = [];
    const secondDaemonFrames: AcpRemoteFrame[] = [];
    let clientClosed = false;

    nativeClientSocket.addEventListener("close", () => {
      clientClosed = true;
    });
    firstDaemonSocket.addEventListener("message", (event) => {
      firstDaemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    secondDaemonSocket.addEventListener("message", (event) => {
      secondDaemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    bindBrokerDaemonSocket(broker, firstRelayDaemonSocket);
    bindBrokerDaemonSocket(broker, secondRelayDaemonSocket);

    await broker.registerDaemon("host-a", firstRelayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      nativeClientAck: true,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });

    await waitFor(() =>
      firstDaemonFrames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          isJsonRpcPayload(frame.payload) &&
          frame.payload.method === "initialize",
      ),
    );
    const bootstrapFrame = firstDaemonFrames.find(
      (frame): frame is AcpRemoteDataFrame =>
        frame.frameType === AcpRemoteFrameType.Data,
    );
    if (!bootstrapFrame) {
      throw new Error("Expected daemon bootstrap frame.");
    }
    firstDaemonSocket.send(
      JSON.stringify({
        ack: bootstrapFrame.seq,
        channelId: bootstrapFrame.channelId,
        connectionId,
        frameType: AcpRemoteFrameType.Ack,
      } satisfies AcpRemoteAckFrame),
    );

    broker.removeDaemon("host-a", firstRelayDaemonSocket);
    now = new Date("2026-04-27T00:00:06.000Z");
    await broker.registerDaemon("host-a", secondRelayDaemonSocket);

    await waitFor(() =>
      secondDaemonFrames.some(
        (frame) => frame.frameType === AcpRemoteFrameType.Hello,
      ),
    );
    const helloFrame = secondDaemonFrames.find(
      (frame) => frame.frameType === AcpRemoteFrameType.Hello,
    );
    if (
      !helloFrame ||
      helloFrame.frameType !== AcpRemoteFrameType.Hello ||
      !helloFrame.ticket
    ) {
      throw new Error("Expected renewed daemon hello frame.");
    }
    expect(Date.parse(helloFrame.ticket.payload.expiresAt)).toBeGreaterThan(
      now.getTime(),
    );
    expect(clientClosed).toBe(false);
    expect(
      secondDaemonFrames.filter(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          isJsonRpcPayload(frame.payload) &&
          frame.payload.method === "initialize",
      ),
    ).toHaveLength(1);
  });

  it("queues client-to-daemon frames instead of closing when the daemon ack window is full", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore({
        scopes: [
          "acp:connect",
          "acp:session:create",
          "acp:session:list",
          "acp:turn:send",
        ],
      }),
      maxBufferedFramesPerConnection: 2,
      ticketSigningKey,
    });
    const connectionId = "conn-daemon-window-queue";
    const [, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const daemonFrames: AcpRemoteFrame[] = [];
    daemonSocket.addEventListener("message", (event) => {
      daemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });

    bindBrokerDaemonSocket(broker, relayDaemonSocket);
    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "auth",
        jsonrpc: "2.0",
        method: "authenticate",
        params: {
          methodId: "acp-runtime-browser",
        },
      }),
    );

    await waitFor(() =>
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Data),
    );
    for (const frame of daemonFrames) {
      if (frame.frameType === AcpRemoteFrameType.Data) {
        daemonSocket.send(
          JSON.stringify({
            ack: frame.seq,
            channelId: frame.channelId,
            connectionId,
            frameType: AcpRemoteFrameType.Ack,
          }),
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    daemonFrames.length = 0;

    for (let id = 1; id <= 3; id++) {
      await broker.handleClientText(
        connectionId,
        JSON.stringify({
          id,
          jsonrpc: "2.0",
          method: "session/list",
          params: {},
        }),
      );
    }

    await waitFor(
      () =>
        daemonFrames.filter((frame) => frame.frameType === AcpRemoteFrameType.Data)
          .length === 2,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Close),
    ).toBe(false);
    expect(
      daemonFrames
        .filter((frame): frame is AcpRemoteDataFrame =>
          frame.frameType === AcpRemoteFrameType.Data,
        )
        .map((frame) =>
          isJsonRpcPayload(frame.payload) && "id" in frame.payload
            ? frame.payload.id
            : undefined,
        ),
    ).toEqual([1, 2]);

    const firstDataFrame = daemonFrames.find(
      (frame): frame is AcpRemoteDataFrame =>
        frame.frameType === AcpRemoteFrameType.Data,
    );
    if (!firstDataFrame) {
      throw new Error("Expected first daemon data frame.");
    }
    daemonSocket.send(
      JSON.stringify({
        ack: firstDataFrame.seq,
        channelId: firstDataFrame.channelId,
        connectionId,
        frameType: AcpRemoteFrameType.Ack,
      }),
    );

    await waitFor(() =>
      daemonFrames.some(
        (frame) =>
          frame.frameType === AcpRemoteFrameType.Data &&
          isJsonRpcPayload(frame.payload) &&
          "id" in frame.payload &&
          frame.payload.id === 3,
      ),
    );
    expect(
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Close),
    ).toBe(false);
  });

  it("removes client routes when a daemon sends a close frame", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      ticketSigningKey,
    });
    const connectionId = "conn-daemon-close";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [, relayDaemonSocket] = createMemoryWebSocketPair();
    let nativeClosed = false;
    nativeClientSocket.addEventListener("close", () => {
      nativeClosed = true;
    });

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "bootstrap",
        jsonrpc: "2.0",
        method: "session/prompt",
        params: { sessionId: "session-1" },
      }),
    );

    broker.handleDaemonText(
      JSON.stringify({
        code: "daemon_closed",
        connectionId,
        frameType: AcpRemoteFrameType.Close,
        reason: "daemon closed route",
      }),
    );

    await waitFor(() => nativeClosed);
  });

  it("accepts low daemon seq numbers after daemon reconnect", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      ticketSigningKey,
    });
    const connectionId = "conn-daemon-seq-reset";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [, firstRelayDaemonSocket] = createMemoryWebSocketPair();
    const [, secondRelayDaemonSocket] = createMemoryWebSocketPair();
    const clientMessages: unknown[] = [];
    nativeClientSocket.addEventListener("message", (event) => {
      clientMessages.push(JSON.parse(String(event.data)));
    });

    broker.registerDaemon("host-a", firstRelayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });

    broker.handleDaemonText(
      JSON.stringify({
        channelId: "acp",
        channelKind: AcpRemoteChannelKind.Acp,
        connectionId,
        frameType: AcpRemoteFrameType.Data,
        payload: {
          id: "before",
          jsonrpc: "2.0",
          result: {},
        },
        seq: 30,
      } satisfies AcpRemoteDataFrame),
    );
    await waitFor(() =>
      clientMessages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "id" in message &&
          message.id === "before",
      ),
    );
    clientMessages.length = 0;

    broker.removeDaemon("host-a", firstRelayDaemonSocket);
    await broker.registerDaemon("host-a", secondRelayDaemonSocket);
    broker.handleDaemonText(
      JSON.stringify({
        channelId: "acp",
        channelKind: AcpRemoteChannelKind.Acp,
        connectionId,
        frameType: AcpRemoteFrameType.Data,
        payload: {
          error: {
            code: -32602,
            message: "Invalid params: Unknown remote runtime session.",
          },
          id: "after",
          jsonrpc: "2.0",
        },
        seq: 1,
      } satisfies AcpRemoteDataFrame),
    );

    await waitFor(() =>
      clientMessages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "id" in message &&
          message.id === "after",
      ),
    );
    expect(clientMessages[0]).toMatchObject({
      error: {
        code: -32602,
      },
      id: "after",
      jsonrpc: "2.0",
    });
  });

  it("pings daemons and records matching pong frames", async () => {
    let now = new Date("2026-04-27T00:00:00.000Z");
    const broker = new AcpRelayBroker({
      now: () => now,
      ticketSigningKey,
    });
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const observedFrames: AcpRemoteFrame[] = [];
    daemonSocket.addEventListener("message", (event) => {
      observedFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.pingDaemons();
    await waitFor(() =>
      observedFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Ping),
    );
    const ping = observedFrames.find(
      (frame) => frame.frameType === AcpRemoteFrameType.Ping,
    );
    if (ping?.frameType !== AcpRemoteFrameType.Ping) {
      throw new Error("Expected ping frame.");
    }

    now = new Date("2026-04-27T00:00:00.050Z");
    broker.handleDaemonText(
      JSON.stringify({
        connectionId: ping.connectionId,
        frameType: AcpRemoteFrameType.Pong,
        nonce: ping.nonce,
      }),
    );

    expect(broker.daemonHeartbeatStatus("host-a")).toEqual({
      lastPongAt: "2026-04-27T00:00:00.050Z",
    });
  });

  it("closes heartbeat-stale daemons and their bound clients", async () => {
    let now = new Date("2026-04-27T00:00:00.000Z");
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      daemonReconnectGraceMs: 0,
      heartbeatTimeoutMs: 100,
      now: () => now,
      ticketSigningKey,
    });
    const connectionId = "conn-stale-heartbeat";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [, relayDaemonSocket] = createMemoryWebSocketPair();
    let nativeClosed = false;
    nativeClientSocket.addEventListener("close", () => {
      nativeClosed = true;
    });

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });

    broker.pingDaemons();
    now = new Date("2026-04-27T00:00:00.101Z");

    expect(broker.closeUnresponsiveDaemons()).toEqual(["host-a"]);
    await waitFor(() => nativeClosed);
    expect(broker.onlineHostIds()).toEqual([]);
  });

  it("rejects new connections when account limit is reached", () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      maxConnectionsPerAccount: 2,
      ticketSigningKey,
    });
    const [, relayDaemonSocket] = createMemoryWebSocketPair();
    broker.registerDaemon("host-a", relayDaemonSocket);

    const accepted: MemoryWebSocket[] = [];
    for (let i = 0; i < 2; i++) {
      const [, relayClientSocket] = createMemoryWebSocketPair();
      broker.registerClient({
        accountId: "acct-1",
        authUrl: `https://relay.test/authorize?connectionId=conn-limit-${i}`,
        connectionId: `conn-limit-${i}`,
        socket: relayClientSocket,
      });
      accepted.push(relayClientSocket);
    }

    const [rejectedNative, rejectedRelay] = createMemoryWebSocketPair();
    let rejectedClosed = false;
    rejectedNative.addEventListener("close", () => {
      rejectedClosed = true;
    });

    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-limit-rejected",
      connectionId: "conn-limit-rejected",
      socket: rejectedRelay,
    });

    expect(rejectedClosed).toBe(true);
  });

  it("handles many concurrent client registrations without deadlock", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      ticketSigningKey,
    });
    const [, relayDaemonSocket] = createMemoryWebSocketPair();
    broker.registerDaemon("host-a", relayDaemonSocket);

    const count = 32;
    const registrations = Array.from({ length: count }, (_, i) => {
      const [, relayClientSocket] = createMemoryWebSocketPair();
      return { connectionId: `conn-concurrent-${i}`, socket: relayClientSocket };
    });

    for (const { connectionId, socket } of registrations) {
      broker.registerClient({
        accountId: "acct-1",
        authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
        connectionId,
        socket,
      });
    }

    for (const { connectionId } of registrations) {
      const result = await broker.authorizeClient({
        connectionId,
        daemonId: "host-a",
      });
      expect(result).toMatchObject({ ok: true });
    }

    expect(broker.onlineHostIds()).toEqual(["host-a"]);
  });

  it("rejects messages on all bound connections after grant revocation reconcile", async () => {
    const store = createControlPlaneStore();
    const broker = new AcpRelayBroker({
      controlPlaneStore: store,
      ticketSigningKey,
    });
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const daemonFrames: AcpRemoteFrame[] = [];
    daemonSocket.addEventListener("message", (event) => {
      daemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });
    broker.registerDaemon("host-a", relayDaemonSocket);

    const clientMessages: unknown[][] = [];
    for (let i = 0; i < 4; i++) {
      const [nativeSocket, relayClientSocket] = createMemoryWebSocketPair();
      const messages: unknown[] = [];
      nativeSocket.addEventListener("message", (event) => {
        messages.push(JSON.parse(String(event.data)));
      });
      clientMessages.push(messages);
      bindBrokerClientSocket(broker, `conn-bulk-${i}`, relayClientSocket);
      broker.registerClient({
        accountId: "acct-1",
        authUrl: `https://relay.test/authorize?connectionId=conn-bulk-${i}`,
        connectionId: `conn-bulk-${i}`,
        socket: relayClientSocket,
      });
      const auth = await broker.authorizeClient({
        connectionId: `conn-bulk-${i}`,
        daemonId: "host-a",
      });
      expect(auth).toMatchObject({ ok: true });
    }
    await waitFor(() =>
      daemonFrames.filter((f) => f.frameType === AcpRemoteFrameType.Hello).length === 4,
    );

    for (let i = 0; i < 4; i++) {
      await broker.handleClientText(
        `conn-bulk-${i}`,
        JSON.stringify({
          id: "auth",
          jsonrpc: "2.0",
          method: "authenticate",
          params: { methodId: "acp-runtime-browser" },
        }),
      );
    }

    store.upsertGrant({
      accountId: "acct-1",
      daemonId: "host-a",
      policyVersion: 8,
      revoked: true,
      scopes: ["acp:connect"],
    });
    const closedIds = await broker.reconcileAuthorizedRoutes();
    expect(closedIds).toHaveLength(4);
  });
  it("rejects authorization without ticket signing key", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
    });
    const connectionId = "conn-no-key";
    const [, relayClientSocket] = createMemoryWebSocketPair();
    const [, relayDaemonSocket] = createMemoryWebSocketPair();
    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });

    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "Relay ticket signing key is not configured.",
    });
  });

  it("rejects authorization for unknown connection", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      ticketSigningKey,
    });

    await expect(
      broker.authorizeClient({ connectionId: "nonexistent", daemonId: "host-a" }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "Unknown ACP connection.",
    });
  });

  it("rejects authorization when host is offline", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      ticketSigningKey,
    });
    const connectionId = "conn-offline-host";
    const [, relayClientSocket] = createMemoryWebSocketPair();
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });

    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "Host daemon is not online.",
    });
  });

  it("closes native ACP client receiving non-ACP channel frame", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      ticketSigningKey,
    });
    const connectionId = "conn-channel-mismatch";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [, relayDaemonSocket] = createMemoryWebSocketPair();
    let nativeClosed = false;
    nativeClientSocket.addEventListener("close", () => {
      nativeClosed = true;
    });

    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });

    broker.handleDaemonText(
      JSON.stringify({
        channelId: "fs:1",
        channelKind: AcpRemoteChannelKind.Filesystem,
        connectionId,
        frameType: AcpRemoteFrameType.Data,
        payload: { operation: "read", path: "/etc/passwd" },
        seq: 1,
      } satisfies AcpRemoteDataFrame),
    );

    await waitFor(() => nativeClosed);
  });

  it("closes native ACP client sending invalid JSON-RPC", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      ticketSigningKey,
    });
    const connectionId = "conn-invalid-jsonrpc";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [, relayDaemonSocket] = createMemoryWebSocketPair();
    let nativeClosed = false;
    nativeClientSocket.addEventListener("close", () => {
      nativeClosed = true;
    });

    bindBrokerClientSocket(broker, connectionId, relayClientSocket);
    bindBrokerDaemonSocket(broker, relayDaemonSocket);
    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });

    await broker.handleClientText(connectionId, "not valid json rpc");

    await waitFor(() => nativeClosed);
  });

  it("forwards native ACP client JSON-RPC responses to daemon requests", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      ticketSigningKey,
    });
    const connectionId = "conn-native-jsonrpc-response";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    let nativeClosed = false;
    let forwardedResponse: AcpRemoteDataFrame | undefined;
    nativeClientSocket.addEventListener("close", () => {
      nativeClosed = true;
    });
    daemonSocket.addEventListener("message", (event) => {
      const frame = assertAcpRemoteFrame(JSON.parse(String(event.data)));
      if (
        frame.frameType === AcpRemoteFrameType.Data &&
        isJsonRpcResponse(frame.payload) &&
        frame.payload.id === 0
      ) {
        forwardedResponse = frame;
      }
    });

    bindBrokerClientSocket(broker, connectionId, relayClientSocket);
    bindBrokerDaemonSocket(broker, relayDaemonSocket);
    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    const clientConnection = createClientConnection(nativeClientSocket);
    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    const authentication = clientConnection.authenticate({
      methodId: "acp-runtime-browser",
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(authentication).resolves.toMatchObject({
      _meta: {
        "acp-runtime/remote/daemonId": "host-a",
      },
    });

    broker.handleDaemonText(
      JSON.stringify({
        channelId: "acp",
        channelKind: AcpRemoteChannelKind.Acp,
        connectionId,
        frameType: AcpRemoteFrameType.Data,
        payload: {
          id: 0,
          jsonrpc: "2.0",
          method: "session/request_permission",
          params: {
            options: [
              {
                kind: "allow_once",
                name: "Allow once",
                optionId: "allow_once",
              },
              {
                kind: "reject_once",
                name: "Reject",
                optionId: "reject_once",
              },
            ],
            sessionId: "session-1",
            toolCall: {
              kind: "execute",
              status: "pending",
              title: "Inspect auth proxy",
              toolCallId: "tool-1",
            },
          },
        },
        seq: 1,
      } satisfies AcpRemoteDataFrame),
    );

    await waitFor(() => forwardedResponse !== undefined);
    expect(nativeClosed).toBe(false);
    expect(forwardedResponse?.payload).toMatchObject({
      id: 0,
      jsonrpc: "2.0",
      result: {
        outcome: {
          optionId: "allow_once",
          outcome: "selected",
        },
      },
    });
  });

  it("forwards native ACP client JSON-RPC responses with null ids", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      ticketSigningKey,
    });
    const connectionId = "conn-native-jsonrpc-null-response";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    let nativeClosed = false;
    let forwardedResponse: AcpRemoteDataFrame | undefined;
    nativeClientSocket.addEventListener("close", () => {
      nativeClosed = true;
    });
    daemonSocket.addEventListener("message", (event) => {
      const frame = assertAcpRemoteFrame(JSON.parse(String(event.data)));
      if (
        frame.frameType === AcpRemoteFrameType.Data &&
        isJsonRpcResponse(frame.payload) &&
        frame.payload.id === null
      ) {
        forwardedResponse = frame;
      }
    });

    bindBrokerClientSocket(broker, connectionId, relayClientSocket);
    bindBrokerDaemonSocket(broker, relayDaemonSocket);
    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });
    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: "auth",
        jsonrpc: "2.0",
        method: "authenticate",
        params: {
          methodId: "acp-runtime-browser",
        },
      }),
    );

    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        error: {
          code: -32600,
          message: "Invalid request",
        },
        id: null,
        jsonrpc: "2.0",
      }),
    );

    await waitFor(() => forwardedResponse !== undefined);
    expect(nativeClosed).toBe(false);
    expect(forwardedResponse?.payload).toMatchObject({
      error: {
        code: -32600,
        message: "Invalid request",
      },
      id: null,
      jsonrpc: "2.0",
    });
  });

  it("closes remote-frame client sending mismatched connectionId", async () => {
    const store = createControlPlaneStore();
    const broker = new AcpRelayBroker({
      controlPlaneStore: store,
      ticketSigningKey,
    });
    const connectionId = "conn-mismatch";
    const [remoteClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [, relayDaemonSocket] = createMemoryWebSocketPair();
    let clientClosed = false;
    remoteClientSocket.addEventListener("close", () => {
      clientClosed = true;
    });

    bindBrokerClientSocket(broker, connectionId, relayClientSocket);
    bindBrokerDaemonSocket(broker, relayDaemonSocket);
    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      clientId: "client-1",
      connectionId,
      daemonId: "host-a",
      socket: relayClientSocket,
      transport: "remote-frame",
    });

    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        channelId: "acp",
        channelKind: AcpRemoteChannelKind.Acp,
        connectionId: "wrong-connection-id",
        frameType: AcpRemoteFrameType.Data,
        payload: { jsonrpc: "2.0", method: "test" },
        seq: 1,
      }),
    );

    await waitFor(() => clientClosed);
  });

  it("ignores daemon data frames for non-existent connections", () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      ticketSigningKey,
    });
    const [, relayDaemonSocket] = createMemoryWebSocketPair();
    broker.registerDaemon("host-a", relayDaemonSocket);

    expect(() =>
      broker.handleDaemonText(
        JSON.stringify({
          channelId: "acp",
          channelKind: AcpRemoteChannelKind.Acp,
          connectionId: "nonexistent-conn",
          frameType: AcpRemoteFrameType.Data,
          payload: { jsonrpc: "2.0", method: "test" },
          seq: 1,
        }),
      ),
    ).not.toThrow();
  });

  it("replaces daemon socket on re-registration for same host", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      ticketSigningKey,
    });
    const [, firstRelayDaemonSocket] = createMemoryWebSocketPair();
    const [secondDaemonSocket, secondRelayDaemonSocket] =
      createMemoryWebSocketPair();
    const daemonFrames: AcpRemoteFrame[] = [];
    secondDaemonSocket.addEventListener("message", (event) => {
      daemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });

    broker.registerDaemon("host-a", firstRelayDaemonSocket);
    broker.registerDaemon("host-a", secondRelayDaemonSocket);

    const connectionId = "conn-reregister";
    const [, relayClientSocket] = createMemoryWebSocketPair();
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });

    await waitFor(() =>
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Hello),
    );
    expect(daemonFrames[0].frameType).toBe(AcpRemoteFrameType.Hello);
  });

  it("queues disconnected client payloads instead of closing when buffer limit is reached", async () => {
    let now = new Date("2026-04-27T00:00:00.000Z");
    const broker = new AcpRelayBroker({
      clientReconnectGraceMs: 100,
      controlPlaneStore: createControlPlaneStore(),
      maxBufferedFramesPerConnection: 2,
      now: () => now,
      ticketSigningKey,
    });
    const connectionId = "conn-backpressure";
    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [resumedNativeSocket, resumedRelayClientSocket] =
      createMemoryWebSocketPair();
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const rawDaemonMessages: unknown[] = [];
    const resumedMessages: unknown[] = [];
    daemonSocket.addEventListener("message", (event) => {
      rawDaemonMessages.push(JSON.parse(String(event.data)));
    });
    resumedNativeSocket.addEventListener("message", (event) => {
      resumedMessages.push(JSON.parse(String(event.data)));
    });

    bindBrokerClientSocket(broker, connectionId, relayClientSocket);
    bindBrokerClientSocket(broker, connectionId, resumedRelayClientSocket);
    bindBrokerDaemonSocket(broker, relayDaemonSocket);
    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, daemonId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });

    const clientConnection = createClientConnection(nativeClientSocket);
    void clientConnection.closed.catch(() => {});
    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    const auth = clientConnection.authenticate({ methodId: "acp-runtime-browser" });
    await waitFor(() =>
      rawDaemonMessages.some((msg) => (msg as { frameType?: string }).frameType === AcpRemoteFrameType.Hello),
    );
    await auth;
    rawDaemonMessages.length = 0;

    broker.removeClient(connectionId, relayClientSocket);

    for (let i = 0; i < 3; i++) {
      broker.handleDaemonText(
        JSON.stringify({
          channelId: "acp",
          channelKind: AcpRemoteChannelKind.Acp,
          connectionId,
          frameType: AcpRemoteFrameType.Data,
          payload: { jsonrpc: "2.0", method: "notification", params: { i } },
          seq: i + 1,
        } satisfies AcpRemoteDataFrame),
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(rawDaemonMessages).toMatchObject(
      expect.not.arrayContaining([
        expect.objectContaining({ frameType: AcpRemoteFrameType.Close }),
      ]),
    );
    expect(rawDaemonMessages).toHaveLength(0);

    now = new Date("2026-04-27T00:00:00.050Z");
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      nativeClientAck: true,
      socket: resumedRelayClientSocket,
    });

    await waitFor(() => resumedMessages.length === 3);
    expect(resumedMessages.map((message) => (message as { params?: { i?: number } }).params?.i))
      .toEqual([0, 1, 2]);
    await waitFor(() =>
      rawDaemonMessages.filter(
        (message) =>
          (message as { frameType?: string }).frameType === AcpRemoteFrameType.Ack,
      ).length === 3,
    );
  });

  it("handles ping from client with pong response", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: createControlPlaneStore(),
      ticketSigningKey,
    });
    const connectionId = "conn-client-ping";
    const [remoteClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const [, relayDaemonSocket] = createMemoryWebSocketPair();
    const clientFrames: AcpRemoteFrame[] = [];
    remoteClientSocket.addEventListener("message", (event) => {
      clientFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
    });

    bindBrokerClientSocket(broker, connectionId, relayClientSocket);
    bindBrokerDaemonSocket(broker, relayDaemonSocket);
    broker.registerDaemon("host-a", relayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      clientId: "client-1",
      connectionId,
      daemonId: "host-a",
      socket: relayClientSocket,
      transport: "remote-frame",
    });

    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        connectionId,
        frameType: AcpRemoteFrameType.Ping,
        nonce: "client-ping-nonce-1234",
      }),
    );

    await waitFor(() =>
      clientFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Pong),
    );
    const pong = clientFrames.find(
      (frame) => frame.frameType === AcpRemoteFrameType.Pong,
    );
    expect(pong).toMatchObject({
      frameType: AcpRemoteFrameType.Pong,
      nonce: "client-ping-nonce-1234",
    });
  });
});

const ticketSigningKey = {
  kid: "test-key",
  secret: "relay-ticket-secret",
};

function createControlPlaneStore(input: {
  scopes?: readonly AcpRemoteScope[];
} = {}): AcpRelayInMemoryControlPlaneStore {
  return new AcpRelayInMemoryControlPlaneStore({
    accounts: [{ accountId: "acct-1" }],
    clientDevices: [{ accountId: "acct-1", clientId: "native-acp-client" }],
    grants: [
      {
        accountId: "acct-1",
        daemonId: "host-a",
        policyVersion: 7,
        scopes: input.scopes ?? [
          "acp:connect",
          "acp:session:create",
          "acp:turn:send",
        ],
      },
    ],
    hosts: [{ accountId: "acct-1", daemonId: "host-a" }],
  });
}

function createSessionBindingRestoreHarness(input: {
  bootstrapComplete?: boolean;
  connectionId: string;
  ticket?: Awaited<ReturnType<typeof createAcpRemoteSignedConnectionTicket>>;
}): {
  clientMessages: unknown[];
  daemonFrames: AcpRemoteFrame[];
  sendPrompt(id: string): Promise<void>;
} {
  const store = new AcpRelayInMemoryControlPlaneStore({
    accounts: [{ accountId: "acct-1" }],
    clientDevices: [{ accountId: "acct-1", clientId: "native-acp-client" }],
    grants: [
      {
        accountId: "acct-1",
        daemonId: "host-a",
        policyVersion: 7,
        scopes: ["acp:connect", "acp:turn:send"],
        workspaceRoots: ["/tmp/persisted-project"],
      },
    ],
    hosts: [{ accountId: "acct-1", daemonId: "host-a" }],
    sessionBindings: [
      {
        accountId: "acct-1",
        agent: { id: "codex-acp" },
        clientId: "native-acp-client",
        daemonId: "host-a",
        sessionId: "session-existing",
        workspaceRoots: ["/tmp/persisted-project"],
      },
    ],
  });
  const broker = new AcpRelayBroker({
    authWaitMs: 1_000,
    controlPlaneStore: store,
    ticketSigningKey,
  });
  const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
  const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
  const clientMessages: unknown[] = [];
  const daemonFrames: AcpRemoteFrame[] = [];
  nativeClientSocket.addEventListener("message", (event) => {
    clientMessages.push(JSON.parse(String(event.data)));
  });
  daemonSocket.addEventListener("message", (event) => {
    daemonFrames.push(assertAcpRemoteFrame(JSON.parse(String(event.data))));
  });
  bindBrokerDaemonSocket(broker, relayDaemonSocket);

  broker.registerDaemon("host-a", relayDaemonSocket, {
    agentTypes: [{ id: "codex-acp", label: "Codex" }],
    workspaceRoots: [{ path: "/tmp" }],
  });
  broker.registerClient({
    accountId: "acct-1",
    authUrl: `https://relay.test/authorize?connectionId=${input.connectionId}`,
    bootstrapComplete: input.bootstrapComplete,
    connectionId: input.connectionId,
    socket: relayClientSocket,
    ticket: input.ticket,
  });

  return {
    clientMessages,
    daemonFrames,
    sendPrompt(id: string) {
      return broker.handleClientText(
        input.connectionId,
        JSON.stringify({
          id,
          jsonrpc: "2.0",
          method: "session/prompt",
          params: {
            prompt: [{ text: "continue", type: "text" }],
            sessionId: "session-existing",
          },
        }),
      );
    },
  };
}

async function waitForSessionPromptForward(
  daemonFrames: readonly AcpRemoteFrame[],
): Promise<void> {
  await waitFor(() =>
    daemonFrames.some(
      (frame) =>
        frame.frameType === AcpRemoteFrameType.Data &&
        isJsonRpcPayload(frame.payload) &&
        frame.payload.method === "session/prompt",
    ),
  );
}

function createClientConnection(socket: MemoryWebSocket): ClientSideConnection {
  return new ClientSideConnection(
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
    createAcpJsonRpcWebSocketStream(socket),
  );
}

async function waitForSessionBinding(
  store: AcpRelayInMemoryControlPlaneStore,
  sessionId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const binding = await store.getSessionBinding({
      accountId: "acct-1",
      clientId: "native-acp-client",
      sessionId,
    });
    if (binding) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for persisted session binding.");
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

function isJsonRpcPayload(
  value: unknown,
): value is { method: string; jsonrpc: "2.0" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "jsonrpc" in value &&
    value.jsonrpc === "2.0" &&
    "method" in value &&
    typeof value.method === "string"
  );
}

function isJsonRpcResponse(
  value: unknown,
): value is {
  error?: unknown;
  id: string | number | null;
  jsonrpc: "2.0";
  result?: unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "jsonrpc" in value &&
    value.jsonrpc === "2.0" &&
    "id" in value &&
    (typeof value.id === "string" ||
      typeof value.id === "number" ||
      value.id === null) &&
    ("result" in value || "error" in value)
  );
}
