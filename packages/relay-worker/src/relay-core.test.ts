import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type AnyMessage,
  type Client,
  type RequestError,
} from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import {
  AcpRemoteChannelKind,
  AcpRemoteFrameType,
  assertAcpRemoteFrame,
  createAcpRemoteDeviceKeyPair,
  createAcpRemoteDeviceRenewalSignature,
  createAcpJsonRpcWebSocketStream,
  type AcpRemoteDataFrame,
  type AcpRemoteFrame,
} from "../../../src/runtime/remote/protocol/index.js";
import { AcpRelayInMemoryControlPlaneStore } from "./control-plane-store.js";
import { AcpRelayBroker } from "./relay-core.js";

describe("AcpRelayBroker", () => {
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
      broker.authorizeClient({ connectionId, hostId: "host-a" }),
    ).resolves.toMatchObject({
      ok: true,
    });
    await expect(authentication).resolves.toMatchObject({
      _meta: {
        "acp-runtime/remote/hostId": "host-a",
        "acp-runtime/remote/ticketKid": "test-key",
      },
    });
    expect(observedTicketKid).toBe("test-key");

    await expect(
      clientConnection.newSession({
        cwd: "/tmp/project",
        mcpServers: [],
      }),
    ).resolves.toMatchObject({
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
          { accountId: "acct-1", clientDeviceId: "native-acp-client" },
        ],
        hosts: [{ accountId: "acct-1", hostId: "host-a" }],
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
        hostId: "host-a",
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "No active grant allows this host.",
    });
    await expect(broker.authorizableHostIds("conn-no-grant")).resolves.toEqual(
      [],
    );
  });

  it("renews near-expiry tickets through explicit ACP authenticate", async () => {
    let now = new Date("2026-04-27T00:00:00.000Z");
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        clientDevices: [
          { accountId: "acct-1", clientDeviceId: "native-acp-client" },
        ],
        grants: [
          {
            accountId: "acct-1",
            hostId: "host-a",
            policyVersion: 7,
            scopes: ["acp:connect", "acp:session:list"],
          },
        ],
        hosts: [{ accountId: "acct-1", hostId: "host-a" }],
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
      broker.authorizeClient({ connectionId, hostId: "host-a" }),
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

    await waitFor(() => clientMessages.length > 0);
    expect(clientMessages[0]).toMatchObject({
      error: {
        code: -32000,
        message: "Authentication required: ACP remote ticket renewal required.",
      },
      id: 1,
      jsonrpc: "2.0",
    });
    expect(
      frames.some((frame) => frame.frameType === AcpRemoteFrameType.Data),
    ).toBe(false);
    clientMessages.length = 0;

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
    await waitFor(() => clientMessages.length > 0);
    expect(clientMessages[0]).toMatchObject({
      id: "renew",
      jsonrpc: "2.0",
      result: {
        _meta: {
          "acp-runtime/remote/hostId": "host-a",
        },
      },
    });
    frames.length = 0;

    await broker.handleClientText(
      connectionId,
      JSON.stringify({
        id: 2,
        jsonrpc: "2.0",
        method: "session/list",
      }),
    );
    await waitFor(() =>
      frames.some((frame) => frame.frameType === AcpRemoteFrameType.Data),
    );
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
            clientDeviceId: "client-1",
            publicKey: deviceKeyPair.publicKey,
          },
        ],
        grants: [
          {
            accountId: "acct-1",
            clientDeviceId: "client-1",
            hostId: "host-a",
            policyVersion: 7,
            scopes: ["acp:connect", "acp:session:list"],
          },
        ],
        hosts: [{ accountId: "acct-1", hostId: "host-a" }],
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
      clientDeviceId: "client-1",
      connectionId,
      socket: relayClientSocket,
    });
    const authorization = await broker.authorizeClient({
      connectionId,
      hostId: "host-a",
    });
    expect(authorization).toMatchObject({ ok: true });
    if (!authorization.ok) {
      throw new Error("Expected authorization.");
    }

    now = new Date("2026-04-27T00:00:00.500Z");
    const proofInput = {
      accountId: "acct-1",
      clientDeviceId: "client-1",
      connectionId,
      hostId: "host-a",
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
      hostId: "host-a",
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
        clientDevices: [{ accountId: "acct-1", clientDeviceId: "client-1" }],
        grants: [
          {
            accountId: "acct-1",
            clientDeviceId: "client-1",
            hostId: "host-a",
            policyVersion: 7,
            scopes: ["acp:connect", "fs:read", "terminal:start"],
          },
        ],
        hosts: [{ accountId: "acct-1", hostId: "host-a" }],
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
      clientDeviceId: "client-1",
      connectionId,
      hostId: "host-a",
      socket: relayClientSocket,
      transport: "remote-frame",
    });
    await expect(
      broker.authorizeClient({ connectionId, hostId: "host-a" }),
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
      broker.authorizeClient({ connectionId, hostId: "host-a" }),
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
      hostId: "host-a",
      policyVersion: 8,
      revoked: true,
      scopes: ["acp:connect", "acp:session:create", "acp:turn:send"],
    });
    await broker.handleClientText(
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
      broker.authorizeClient({ connectionId, hostId: "host-a" }),
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
      hostId: "host-a",
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
      broker.authorizeClient({ connectionId, hostId: "host-a" }),
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
      broker.authorizeClient({ connectionId, hostId: "host-a" }),
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

    broker.registerDaemon("host-a", firstRelayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, hostId: "host-a" }),
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

    await broker.handleClientText(
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

    await waitFor(() =>
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Data),
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
      broker.authorizeClient({ connectionId, hostId: "host-a" }),
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
      socket: firstRelayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, hostId: "host-a" }),
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

    await broker.handleClientText(
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
      broker.authorizeClient({ connectionId, hostId: "host-a" }),
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
      broker.authorizeClient({ connectionId, hostId: "host-a" }),
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

    broker.registerDaemon("host-a", firstRelayDaemonSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      connectionId,
      socket: relayClientSocket,
    });
    await expect(
      broker.authorizeClient({ connectionId, hostId: "host-a" }),
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
        id: 1,
        jsonrpc: "2.0",
        method: "session/new",
        params: {
          cwd: "/tmp/project",
          mcpServers: [],
        },
      }),
    );

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
      broker.authorizeClient({ connectionId, hostId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });

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
      broker.authorizeClient({ connectionId, hostId: "host-a" }),
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
        hostId: "host-a",
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
        hostId: "host-a",
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
      hostId: "host-a",
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
      broker.authorizeClient({ connectionId, hostId: "host-a" }),
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
      broker.authorizeClient({ connectionId: "nonexistent", hostId: "host-a" }),
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
      broker.authorizeClient({ connectionId, hostId: "host-a" }),
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
      broker.authorizeClient({ connectionId, hostId: "host-a" }),
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
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
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
      broker.authorizeClient({ connectionId, hostId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });

    await broker.handleClientText(connectionId, "not valid json rpc");

    await waitFor(() => nativeClosed);
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
      clientDeviceId: "client-1",
      connectionId,
      hostId: "host-a",
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
      broker.authorizeClient({ connectionId, hostId: "host-a" }),
    ).resolves.toMatchObject({ ok: true });

    await waitFor(() =>
      daemonFrames.some((frame) => frame.frameType === AcpRemoteFrameType.Hello),
    );
    expect(daemonFrames[0].frameType).toBe(AcpRemoteFrameType.Hello);
  });

  it("closes client when backpressure exceeds buffer limit for disconnected client", async () => {
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
    const [daemonSocket, relayDaemonSocket] = createMemoryWebSocketPair();
    const rawDaemonMessages: unknown[] = [];
    daemonSocket.addEventListener("message", (event) => {
      rawDaemonMessages.push(JSON.parse(String(event.data)));
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
      broker.authorizeClient({ connectionId, hostId: "host-a" }),
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

    await waitFor(() => rawDaemonMessages.length > 0);
    expect(rawDaemonMessages).toMatchObject(
      expect.arrayContaining([
        expect.objectContaining({
          code: "client_backpressure",
          frameType: AcpRemoteFrameType.Close,
        }),
      ]),
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
      clientDeviceId: "client-1",
      connectionId,
      hostId: "host-a",
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

function createControlPlaneStore(): AcpRelayInMemoryControlPlaneStore {
  return new AcpRelayInMemoryControlPlaneStore({
    accounts: [{ accountId: "acct-1" }],
    clientDevices: [{ accountId: "acct-1", clientDeviceId: "native-acp-client" }],
    grants: [
      {
        accountId: "acct-1",
        hostId: "host-a",
        policyVersion: 7,
        scopes: [
          "acp:connect",
          "acp:session:create",
          "acp:turn:send",
        ],
      },
    ],
    hosts: [{ accountId: "acct-1", hostId: "host-a" }],
  });
}

class MemoryWebSocket {
  private readonly closeListeners = new Set<() => void>();
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
    } else {
      this.closeListeners.add(listener as () => void);
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
    } else {
      this.closeListeners.delete(listener as () => void);
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

function createMemoryWebSocketPair(): [MemoryWebSocket, MemoryWebSocket] {
  const left = new MemoryWebSocket();
  const right = new MemoryWebSocket();
  left.peer = right;
  right.peer = left;
  return [left, right];
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}
