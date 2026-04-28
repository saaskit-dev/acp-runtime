import {
  ACP_REMOTE_PROTOCOL_VERSION,
  AcpRemoteChannelKind,
  AcpRemoteEndpointKind,
  AcpRemoteFrameType,
  assertAcpRemoteFrame,
  createAcpRemoteSignedConnectionTicket,
  verifyAcpRemoteDeviceRenewalProof,
  type AcpRemoteAckFrame,
  type AcpRemoteDataFrame,
  type AcpRemoteGrant,
  type AcpRemoteScope,
  type AcpRemoteFrame,
  type AcpRemotePingFrame,
  type AcpRemoteSignedDeviceRenewalProof,
  type AcpRemoteSignedConnectionTicket,
  type AcpRemoteTicketSigningKey,
} from "../../../src/runtime/remote/protocol/index.js";
import {
  AcpRelayInMemoryControlPlaneStore,
  type AcpRelayControlPlaneStore,
} from "./control-plane-store.js";

export type RelaySocket = {
  close(code?: number, reason?: string): void;
  send(data: string): void;
};

export type AcpRelayBrokerOptions = {
  authWaitMs?: number;
  clientReconnectGraceMs?: number;
  controlPlaneStore?: AcpRelayControlPlaneStore;
  daemonReconnectGraceMs?: number;
  defaultScopes?: readonly AcpRemoteScope[];
  heartbeatTimeoutMs?: number;
  maxBufferedFramesPerConnection?: number;
  maxConnectionsPerAccount?: number;
  now?: () => Date;
  policyVersion?: number;
  ticketRenewBeforeMs?: number;
  ticketSigningKey?: AcpRemoteTicketSigningKey;
  ticketTtlMs?: number;
};

export type AcpRelayClientTransport = "native-acp" | "remote-frame";

export type AcpRelayClientRegistration = {
  accountId: string;
  authUrl: string;
  clientDeviceId?: string;
  connectionId: string;
  hostId?: string;
  socket: RelaySocket;
  transport?: AcpRelayClientTransport;
};

export type AcpRelayAuthorizationResult =
  | {
      ok: true;
      connectionId: string;
      hostId: string;
      ticket: AcpRemoteSignedConnectionTicket;
    }
  | {
      ok: false;
      reason: string;
    };

export type AcpRelayDeviceRenewalResult =
  | {
      ok: true;
      connectionId: string;
      hostId: string;
      ticket: AcpRemoteSignedConnectionTicket;
    }
  | {
      ok: false;
      reason: string;
    };

const ACP_BOOTSTRAP_AUTH_METHOD_ID = "acp-runtime-browser";
const ACP_REMOTE_CONNECTION_ID_META = "acp-runtime/remote/connectionId";
const ACP_REMOTE_HOST_ID_META = "acp-runtime/remote/hostId";
const ACP_REMOTE_AUTH_URL_META = "acp-runtime/remote/authUrl";
const DEFAULT_CLIENT_DEVICE_ID = "native-acp-client";
const DEFAULT_AUTH_WAIT_MS = 5 * 60 * 1000;
const DEFAULT_CLIENT_RECONNECT_GRACE_MS = 30 * 1000;
const DEFAULT_DAEMON_RECONNECT_GRACE_MS = 30 * 1000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45 * 1000;
const DEFAULT_MAX_BUFFERED_FRAMES_PER_CONNECTION = 64;
const DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT = 64;
const DEFAULT_POLICY_VERSION = 1;
const DEFAULT_TICKET_RENEW_BEFORE_MS = 60 * 1000;
const DEFAULT_TICKET_SCOPES = [
  "acp:connect",
  "acp:session:create",
  "acp:session:list",
  "acp:session:resume",
  "acp:turn:send",
  "acp:turn:cancel",
] as const satisfies readonly AcpRemoteScope[];

type RelayClient = {
  accountId: string;
  authUrl: string;
  bootstrapComplete: boolean;
  bufferedClientPayloads: string[];
  clientDeviceId: string;
  clientPendingFrames: Map<number, AcpRemoteDataFrame>;
  daemonBootstrapRequestIds: Set<string>;
  daemonPendingFrames: Map<number, AcpRemoteDataFrame>;
  disconnectedAtMs?: number;
  hostId?: string;
  initializeParams?: unknown;
  lastDaemonSeq?: number;
  seq: number;
  socket?: RelaySocket;
  ticket?: AcpRemoteSignedConnectionTicket;
  transport: AcpRelayClientTransport;
  waiters: Set<(hostId: string) => void>;
};

type ConnectedRelayClient = RelayClient & {
  socket: RelaySocket;
};

type RelayJsonRpcRequest = {
  id: string | number | null;
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type RelayJsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type RelayJsonRpcMessage = RelayJsonRpcNotification | RelayJsonRpcRequest;

type DaemonHeartbeatState = {
  lastPongAt?: string;
  pendingNonce?: string;
  pingedAtMs?: number;
};

type DaemonReconnectState = {
  disconnectedAtMs: number;
};

export class AcpRelayBroker {
  private readonly authWaitMs: number;
  private readonly clientReconnectGraceMs: number;
  private readonly clients = new Map<string, RelayClient>();
  private readonly controlPlaneStore: AcpRelayControlPlaneStore;
  private readonly daemonHeartbeats = new Map<string, DaemonHeartbeatState>();
  private readonly daemonReconnects = new Map<string, DaemonReconnectState>();
  private readonly daemons = new Map<string, RelaySocket>();
  private readonly daemonReconnectGraceMs: number;
  private readonly defaultScopes: readonly AcpRemoteScope[];
  private readonly heartbeatTimeoutMs: number;
  private readonly maxBufferedFramesPerConnection: number;
  private readonly maxConnectionsPerAccount: number;
  private readonly now: () => Date;
  private readonly policyVersion: number;
  private readonly ticketRenewBeforeMs: number;
  private readonly ticketSigningKey: AcpRemoteTicketSigningKey | undefined;
  private readonly ticketTtlMs: number | undefined;

  constructor(options: AcpRelayBrokerOptions = {}) {
    this.authWaitMs = options.authWaitMs ?? DEFAULT_AUTH_WAIT_MS;
    this.clientReconnectGraceMs =
      options.clientReconnectGraceMs ?? DEFAULT_CLIENT_RECONNECT_GRACE_MS;
    this.controlPlaneStore =
      options.controlPlaneStore ?? new AcpRelayInMemoryControlPlaneStore();
    this.daemonReconnectGraceMs =
      options.daemonReconnectGraceMs ?? DEFAULT_DAEMON_RECONNECT_GRACE_MS;
    this.defaultScopes = options.defaultScopes ?? DEFAULT_TICKET_SCOPES;
    this.heartbeatTimeoutMs =
      options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.maxBufferedFramesPerConnection =
      options.maxBufferedFramesPerConnection ??
      DEFAULT_MAX_BUFFERED_FRAMES_PER_CONNECTION;
    this.maxConnectionsPerAccount =
      options.maxConnectionsPerAccount ?? DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT;
    this.now = options.now ?? (() => new Date());
    this.policyVersion = options.policyVersion ?? DEFAULT_POLICY_VERSION;
    this.ticketRenewBeforeMs =
      options.ticketRenewBeforeMs ?? DEFAULT_TICKET_RENEW_BEFORE_MS;
    this.ticketSigningKey = options.ticketSigningKey;
    this.ticketTtlMs = options.ticketTtlMs;
  }

  registerDaemon(hostId: string, socket: RelaySocket): void {
    const previousSocket = this.daemons.get(hostId);
    this.daemons.set(hostId, socket);
    this.daemonReconnects.delete(hostId);
    this.daemonHeartbeats.set(hostId, {
      lastPongAt: this.now().toISOString(),
    });
    previousSocket?.close(1012, "Daemon connection replaced.");
    this.reopenClientRoutesForDaemon(hostId, socket);
  }

  registerClient(input: AcpRelayClientRegistration): void {
    const clientDeviceId = input.clientDeviceId ?? DEFAULT_CLIENT_DEVICE_ID;
    const transport = input.transport ?? "native-acp";
    const existing = this.clients.get(input.connectionId);

    const accountConnectionCount = [...this.clients.values()].filter(
      (c) => c.accountId === input.accountId,
    ).length;
    if (
      accountConnectionCount >= this.maxConnectionsPerAccount &&
      !existing
    ) {
      input.socket.close(
        1008,
        "Connection limit exceeded for this account.",
      );
      return;
    }

    if (
      existing &&
      this.canResumeClient(input, existing, clientDeviceId, transport)
    ) {
      const previousSocket = existing.socket;
      existing.authUrl = input.authUrl;
      existing.disconnectedAtMs = undefined;
      existing.socket = input.socket;
      if (isConnectedClient(existing)) {
        this.flushBufferedClientPayloads(existing);
      }
      previousSocket?.close(1012, "Client connection replaced.");
      return;
    }

    if (existing) {
      this.clients.delete(input.connectionId);
      this.sendDaemonClientClose(
        input.connectionId,
        existing,
        "client_replaced",
        "Native ACP client connection replaced.",
      );
      existing.socket?.close(1012, "Client connection replaced.");
    }

    const hostId = input.hostId;
    this.clients.set(input.connectionId, {
      accountId: input.accountId,
      authUrl: input.authUrl,
      bootstrapComplete: false,
      bufferedClientPayloads: [],
      clientDeviceId,
      clientPendingFrames: new Map(),
      daemonBootstrapRequestIds: new Set(),
      daemonPendingFrames: new Map(),
      hostId,
      lastDaemonSeq: undefined,
      seq: 0,
      socket: input.socket,
      waiters: new Set(),
      transport,
    });

    if (hostId && !this.daemons.has(hostId)) {
      input.socket.close(1013, "No daemon is online for this host.");
    }
  }

  removeDaemon(hostId: string, socket: RelaySocket): void {
    if (this.daemons.get(hostId) === socket) {
      this.daemons.delete(hostId);
      this.daemonHeartbeats.delete(hostId);
      this.markDaemonDisconnected(hostId, "Host daemon disconnected.");
    }
  }

  removeClient(connectionId: string, socket: RelaySocket): void {
    const client = this.clients.get(connectionId);
    if (!client || client.socket !== socket) {
      return;
    }

    if (this.shouldKeepDisconnectedClient(client)) {
      client.disconnectedAtMs = this.now().getTime();
      client.socket = undefined;
      return;
    }

    this.clients.delete(connectionId);
    this.sendDaemonClientClose(
      connectionId,
      client,
      "client_closed",
      "Native ACP client disconnected.",
    );
  }

  closeExpiredDisconnectedClients(): string[] {
    const expiredConnectionIds: string[] = [];
    const nowMs = this.now().getTime();
    for (const [connectionId, client] of this.clients.entries()) {
      if (
        client.disconnectedAtMs === undefined ||
        nowMs - client.disconnectedAtMs < this.clientReconnectGraceMs
      ) {
        continue;
      }

      this.clients.delete(connectionId);
      this.sendDaemonClientClose(
        connectionId,
        client,
        "client_reconnect_timeout",
        "Native ACP client reconnect grace expired.",
      );
      expiredConnectionIds.push(connectionId);
    }
    return expiredConnectionIds.sort();
  }

  closeExpiredDisconnectedDaemons(): string[] {
    const expiredHostIds: string[] = [];
    const nowMs = this.now().getTime();
    for (const [hostId, reconnect] of this.daemonReconnects.entries()) {
      if (nowMs - reconnect.disconnectedAtMs < this.daemonReconnectGraceMs) {
        continue;
      }

      this.daemonReconnects.delete(hostId);
      this.closeClientsForHost(
        hostId,
        1013,
        "Host daemon reconnect grace expired.",
      );
      expiredHostIds.push(hostId);
    }
    return expiredHostIds.sort();
  }

  async reconcileAuthorizedRoutes(): Promise<string[]> {
    const closedConnectionIds: string[] = [];
    for (const [connectionId, client] of this.clients.entries()) {
      if (!client.bootstrapComplete || !client.hostId || !client.ticket) {
        continue;
      }

      const decision = await this.controlPlaneStore.resolveGrant({
        accountId: client.accountId,
        clientDeviceId: client.clientDeviceId,
        hostId: client.hostId,
        requiredScopes: ["acp:connect"],
      });
      if (decision.ok) {
        continue;
      }

      this.revokeClientRoute(
        connectionId,
        client,
        "authorization_revoked",
        decision.reason,
      );
      closedConnectionIds.push(connectionId);
    }
    return closedConnectionIds.sort();
  }

  hasPendingDaemonReconnects(): boolean {
    return this.daemonReconnects.size > 0;
  }

  hasPendingClientReconnects(): boolean {
    for (const client of this.clients.values()) {
      if (client.disconnectedAtMs !== undefined) {
        return true;
      }
    }
    return false;
  }

  onlineHostIds(): string[] {
    return [...this.daemons.keys()].sort();
  }

  pingDaemons(): void {
    for (const [hostId, socket] of this.daemons.entries()) {
      const nonce = crypto.randomUUID();
      const frame: AcpRemotePingFrame = {
        connectionId: daemonHeartbeatConnectionId(hostId),
        frameType: AcpRemoteFrameType.Ping,
        nonce,
      };
      this.daemonHeartbeats.set(hostId, {
        lastPongAt: this.daemonHeartbeats.get(hostId)?.lastPongAt,
        pendingNonce: nonce,
        pingedAtMs: this.now().getTime(),
      });
      socket.send(JSON.stringify(frame));
    }
  }

  closeUnresponsiveDaemons(): string[] {
    const closedHostIds: string[] = [];
    const nowMs = this.now().getTime();
    for (const [hostId, heartbeat] of this.daemonHeartbeats.entries()) {
      if (
        heartbeat.pendingNonce === undefined ||
        heartbeat.pingedAtMs === undefined ||
        nowMs - heartbeat.pingedAtMs < this.heartbeatTimeoutMs
      ) {
        continue;
      }

      const daemon = this.daemons.get(hostId);
      daemon?.close(1011, "Host daemon heartbeat timed out.");
      this.daemons.delete(hostId);
      this.daemonHeartbeats.delete(hostId);
      this.markDaemonDisconnected(hostId, "Host daemon heartbeat timed out.");
      closedHostIds.push(hostId);
    }
    return closedHostIds;
  }

  daemonHeartbeatStatus(hostId: string): DaemonHeartbeatState | undefined {
    const heartbeat = this.daemonHeartbeats.get(hostId);
    return heartbeat ? { ...heartbeat } : undefined;
  }

  async authorizableHostIds(connectionId: string): Promise<string[]> {
    const client = this.clients.get(connectionId);
    if (!client) {
      return [];
    }

    const onlineHosts = new Set(this.onlineHostIds());
    const hosts = await this.controlPlaneStore.listAuthorizableHosts({
      accountId: client.accountId,
      clientDeviceId: client.clientDeviceId,
    });
    return hosts
      .map((host) => host.hostId)
      .filter((hostId) => onlineHosts.has(hostId))
      .sort();
  }

  async authorizeClient(input: {
    connectionId: string;
    hostId: string;
  }): Promise<AcpRelayAuthorizationResult> {
    const client = this.clients.get(input.connectionId);
    if (!client) {
      return { ok: false, reason: "Unknown ACP connection." };
    }
    if (!this.daemons.has(input.hostId)) {
      return { ok: false, reason: "Host daemon is not online." };
    }
    if (!this.ticketSigningKey) {
      return { ok: false, reason: "Relay ticket signing key is not configured." };
    }

    const grantDecision = await this.controlPlaneStore.resolveGrant({
      accountId: client.accountId,
      clientDeviceId: client.clientDeviceId,
      hostId: input.hostId,
      requiredScopes: ["acp:connect"],
    });
    if (!grantDecision.ok) {
      return grantDecision;
    }

    const ticket = await this.createSignedTicket(
      input.connectionId,
      grantDecision.grant,
    );
    client.hostId = input.hostId;
    client.ticket = ticket;
    if (client.transport === "remote-frame") {
      client.bootstrapComplete = true;
    }
    const daemon = this.daemons.get(input.hostId);
    if (daemon) {
      this.sendDaemonClientHello(input.connectionId, client, daemon);
      this.sendDaemonBootstrapInitialize(input.connectionId, client, daemon);
    }
    for (const waiter of client.waiters) {
      waiter(input.hostId);
    }
    client.waiters.clear();
    return {
      connectionId: input.connectionId,
      hostId: input.hostId,
      ok: true,
      ticket,
    };
  }

  async renewClientTicketWithDeviceProof(
    proof: AcpRemoteSignedDeviceRenewalProof,
  ): Promise<AcpRelayDeviceRenewalResult> {
    const client = this.clients.get(proof.connectionId);
    if (!client) {
      return { ok: false, reason: "Unknown ACP connection." };
    }
    if (!client.hostId || !client.ticket) {
      return { ok: false, reason: "ACP remote connection is not authorized." };
    }
    if (client.accountId !== proof.accountId) {
      return { ok: false, reason: "ACP remote account mismatch." };
    }
    if (client.clientDeviceId !== proof.clientDeviceId) {
      return { ok: false, reason: "ACP remote client device mismatch." };
    }
    if (client.hostId !== proof.hostId) {
      return { ok: false, reason: "ACP remote host mismatch." };
    }
    if (client.ticket.payload.jti !== proof.ticketJti) {
      return { ok: false, reason: "ACP remote ticket mismatch." };
    }
    const daemon = this.daemons.get(client.hostId);
    if (!daemon) {
      return { ok: false, reason: "Host daemon is not online." };
    }
    if (!this.ticketSigningKey) {
      return { ok: false, reason: "Relay ticket signing key is not configured." };
    }

    const device = await this.controlPlaneStore.getClientDevice({
      accountId: client.accountId,
      clientDeviceId: client.clientDeviceId,
    });
    if (!device || device.disabled || !device.publicKey) {
      return { ok: false, reason: "Client device is not registered." };
    }

    const proofResult = await verifyAcpRemoteDeviceRenewalProof({
      now: this.now(),
      proof,
      publicKey: device.publicKey,
    });
    if (!proofResult.ok) {
      return proofResult;
    }

    const decision = await this.controlPlaneStore.resolveGrant({
      accountId: client.accountId,
      clientDeviceId: client.clientDeviceId,
      hostId: client.hostId,
      requiredScopes: ["acp:connect"],
    });
    if (!decision.ok) {
      this.revokeClientRoute(
        proof.connectionId,
        client,
        "authorization_revoked",
        decision.reason,
      );
      return decision;
    }

    const ticket = await this.createSignedTicket(
      proof.connectionId,
      decision.grant,
    );
    client.ticket = ticket;
    daemon.send(
      JSON.stringify({
        connectionId: proof.connectionId,
        frameType: AcpRemoteFrameType.Renew,
        ticket,
      }),
    );
    return {
      connectionId: proof.connectionId,
      hostId: client.hostId,
      ok: true,
      ticket,
    };
  }

  async handleClientText(connectionId: string, text: string): Promise<void> {
    const client = this.clients.get(connectionId);
    if (!client || !isConnectedClient(client)) {
      return;
    }

    if (client.transport === "remote-frame") {
      await this.handleRemoteClientText(connectionId, client, text);
      return;
    }

    const message = parseJsonRpcMessage(text);
    if (!message) {
      client.socket.close(1003, "Invalid ACP JSON-RPC payload.");
      return;
    }

    if (!client.bootstrapComplete) {
      await this.handleBootstrapMessage(connectionId, client, message);
      return;
    }

    if (
      isJsonRpcRequest(message) &&
      message.method === "authenticate" &&
      readMethodId(message.params) === ACP_BOOTSTRAP_AUTH_METHOD_ID
    ) {
      await this.renewBoundClientAuthentication(connectionId, client, message);
      return;
    }

    await this.forwardBoundClientMessage(connectionId, client, message);
  }

  private async handleRemoteClientText(
    connectionId: string,
    client: ConnectedRelayClient,
    text: string,
  ): Promise<void> {
    const frame = parseFrame(text);
    if (!frame) {
      client.socket.close(1003, "Invalid ACP remote frame.");
      return;
    }
    if (frame.connectionId !== connectionId) {
      client.socket.close(1008, "ACP remote connection mismatch.");
      return;
    }
    if (frame.frameType === AcpRemoteFrameType.Ack) {
      this.handleClientAck(client, frame.ack);
      return;
    }
    if (frame.frameType === AcpRemoteFrameType.Ping) {
      client.socket.send(
        JSON.stringify({
          connectionId,
          frameType: AcpRemoteFrameType.Pong,
          nonce: frame.nonce,
        }),
      );
      return;
    }
    if (frame.frameType !== AcpRemoteFrameType.Data) {
      return;
    }

    await this.forwardRemoteClientFrame(connectionId, client, frame);
  }

  handleDaemonText(text: string): void {
    const frame = parseFrame(text);
    if (frame?.frameType === AcpRemoteFrameType.Ack) {
      this.handleDaemonAck(frame);
      return;
    }
    if (frame?.frameType === AcpRemoteFrameType.Pong) {
      this.handleDaemonPong(frame.connectionId, frame.nonce);
      return;
    }
    if (frame?.frameType === AcpRemoteFrameType.Ping) {
      this.handleDaemonPing(frame.connectionId, frame.nonce);
      return;
    }
    if (frame?.frameType === AcpRemoteFrameType.Data) {
      const client = this.clients.get(frame.connectionId);
      if (client) {
        this.sendDaemonAck(client, frame);
      }
      if (client && isReplayOrDuplicateDaemonFrame(client, frame)) {
        return;
      }
      if (
        client &&
        frame.channelKind === AcpRemoteChannelKind.Acp &&
        isSuppressedDaemonBootstrapResponse(client, frame.payload)
      ) {
        return;
      }
      if (!client) {
        return;
      }

      if (
        client.transport === "native-acp" &&
        frame.channelKind !== AcpRemoteChannelKind.Acp
      ) {
        client.socket?.close(
          1008,
          "Native ACP clients can only receive ACP channel frames.",
        );
        this.closeClientRoute(
          frame.connectionId,
          client,
          "native_acp_channel_mismatch",
          "Native ACP clients can only receive ACP channel frames.",
        );
        return;
      }

      const payloadText =
        client.transport === "native-acp"
          ? JSON.stringify(frame.payload)
          : JSON.stringify(frame);
      if (client.socket) {
        if (client.transport === "remote-frame") {
          client.clientPendingFrames.set(frame.seq, frame);
          if (
            client.clientPendingFrames.size >
            this.maxBufferedFramesPerConnection
          ) {
            this.closeClientRoute(
              frame.connectionId,
              client,
              "client_backpressure",
              "Buffered client frame limit exceeded.",
            );
            return;
          }
        }
        client.socket.send(payloadText);
        return;
      }
      if (!this.shouldKeepDisconnectedClient(client)) {
        return;
      }
      if (
        client.bufferedClientPayloads.length >=
        this.maxBufferedFramesPerConnection
      ) {
        this.closeClientRoute(
          frame.connectionId,
          client,
          "client_backpressure",
          "Buffered client payload limit exceeded.",
        );
        return;
      }
      client.bufferedClientPayloads.push(payloadText);
      return;
    }
    if (frame?.frameType === AcpRemoteFrameType.Close) {
      this.clients.get(frame.connectionId)?.socket?.close(
        1000,
        frame.reason ?? "Remote ACP connection closed.",
      );
      this.clients.delete(frame.connectionId);
    }
  }

  private async handleBootstrapMessage(
    connectionId: string,
    client: ConnectedRelayClient,
    message: RelayJsonRpcMessage,
  ): Promise<void> {
    if (!isJsonRpcRequest(message)) {
      return;
    }

    if (message.method === "initialize") {
      client.initializeParams = message.params;
      sendJsonRpcResult(client.socket, message, {
        agentCapabilities: {
          auth: {},
          sessionCapabilities: {},
        },
        agentInfo: {
          name: "acp-runtime-relay",
          title: "ACP Runtime Relay",
          version: "0.1.1",
        },
        authMethods: [
          {
            _meta: {
              [ACP_REMOTE_AUTH_URL_META]: client.authUrl,
              [ACP_REMOTE_CONNECTION_ID_META]: connectionId,
            },
            description:
              "Open the authorization URL, sign in, and select a host daemon.",
            id: ACP_BOOTSTRAP_AUTH_METHOD_ID,
            name: "Sign in with ACP Runtime Relay",
          },
        ],
        protocolVersion: readRequestedProtocolVersion(message.params),
      });
      return;
    }

    if (message.method === "authenticate") {
      const methodId = readMethodId(message.params);
      if (methodId !== ACP_BOOTSTRAP_AUTH_METHOD_ID) {
        sendJsonRpcError(client.socket, message, {
          code: -32602,
          data: { methodId },
          message: "Invalid params: unsupported relay authentication method.",
        });
        return;
      }

      const hostId =
        readMetaString(message.params, ACP_REMOTE_HOST_ID_META) ??
        readMetaString(message.params, "hostId") ??
        client.hostId;
      if (hostId && !client.ticket) {
        const result = await this.authorizeClient({ connectionId, hostId });
        if (!result.ok) {
          sendJsonRpcError(client.socket, message, {
            code: -32000,
            data: {
              authUrl: client.authUrl,
              connectionId,
              onlineHosts: this.onlineHostIds(),
            },
            message: `Authentication required: ${result.reason}`,
          });
          return;
        }
      } else if (!client.hostId) {
        const selectedHostId = await this.waitForClientHostSelection(client);
        if (selectedHostId) {
          client.hostId = selectedHostId;
        }
      }

      if (!client.hostId || !client.ticket) {
        sendJsonRpcError(client.socket, message, {
          code: -32000,
          data: {
            authUrl: client.authUrl,
            connectionId,
            onlineHosts: this.onlineHostIds(),
          },
          message: "Authentication required: host selection was not completed.",
        });
        return;
      }

      client.bootstrapComplete = true;
      sendJsonRpcResult(client.socket, message, {
        _meta: {
          [ACP_REMOTE_CONNECTION_ID_META]: connectionId,
          [ACP_REMOTE_HOST_ID_META]: client.hostId,
          "acp-runtime/remote/ticketKid": client.ticket.kid,
          "acp-runtime/remote/ticketExpiresAt": client.ticket.payload.expiresAt,
        },
      });
      return;
    }

    sendJsonRpcError(client.socket, message, {
      code: -32000,
      data: {
        authUrl: client.authUrl,
        connectionId,
        onlineHosts: this.onlineHostIds(),
      },
      message: "Authentication required: select a host before using runtime methods.",
    });
  }

  private async forwardBoundClientMessage(
    connectionId: string,
    client: ConnectedRelayClient,
    payload: RelayJsonRpcMessage,
  ): Promise<void> {
    const hostId = client.hostId;
    const daemon = hostId ? this.daemons.get(hostId) : undefined;
    if (!daemon) {
      if (isJsonRpcRequest(payload)) {
        sendJsonRpcError(client.socket, payload, {
          code: -32002,
          data: { hostId },
          message: this.daemonReconnects.has(hostId ?? "")
            ? "Resource temporarily unavailable: host daemon is reconnecting."
            : "Resource not found: host daemon is not online.",
        });
      }
      return;
    }

    const authorization = await this.revalidateBoundClientMessage(
      client,
      payload,
    );
    if (!authorization.ok) {
      this.rejectBoundClientMessage(connectionId, client, payload, authorization);
      return;
    }
    this.sendDaemonDataFrame(connectionId, client, daemon, payload);
  }

  private async forwardRemoteClientFrame(
    connectionId: string,
    client: ConnectedRelayClient,
    frame: AcpRemoteDataFrame,
  ): Promise<void> {
    const hostId = client.hostId;
    const daemon = hostId ? this.daemons.get(hostId) : undefined;
    if (!daemon) {
      client.socket.close(
        1013,
        this.daemonReconnects.has(hostId ?? "")
          ? "Host daemon is reconnecting."
          : "Host daemon is not online.",
      );
      return;
    }

    const authorization = await this.revalidateBoundClientFrame(client, frame);
    if (!authorization.ok) {
      if (authorization.closeRoute) {
        this.revokeClientRoute(
          connectionId,
          client,
          "authorization_revoked",
          authorization.reason,
        );
      } else {
        client.socket.send(
          JSON.stringify({
            code: "authorization_denied",
            connectionId,
            frameType: AcpRemoteFrameType.Close,
            reason: authorization.reason,
          }),
        );
      }
      return;
    }

    this.sendDaemonDataFrame(connectionId, client, daemon, frame.payload, {
      channelId: frame.channelId,
      channelKind: frame.channelKind,
    });
  }

  private async renewBoundClientAuthentication(
    connectionId: string,
    client: ConnectedRelayClient,
    request: RelayJsonRpcRequest,
  ): Promise<void> {
    const hostId = client.hostId;
    const daemon = hostId ? this.daemons.get(hostId) : undefined;
    if (!hostId || !client.ticket || !daemon) {
      sendJsonRpcError(client.socket, request, {
        code: -32002,
        data: { hostId },
        message: "Resource not found: host daemon is not online.",
      });
      return;
    }

    if (!this.ticketSigningKey) {
      this.revokeClientRoute(
        connectionId,
        client,
        "ticket_signing_key_missing",
        "Relay ticket signing key is not configured.",
      );
      return;
    }

    const decision = await this.controlPlaneStore.resolveGrant({
      accountId: client.accountId,
      clientDeviceId: client.clientDeviceId,
      hostId,
      requiredScopes: ["acp:connect"],
    });
    if (!decision.ok) {
      sendJsonRpcError(client.socket, request, {
        code: -32000,
        message: `Authentication required: ${decision.reason}`,
      });
      this.revokeClientRoute(
        connectionId,
        client,
        "authorization_revoked",
        decision.reason,
      );
      return;
    }

    const ticket = await this.createSignedTicket(connectionId, decision.grant);
    client.ticket = ticket;
    daemon.send(
      JSON.stringify({
        connectionId,
        frameType: AcpRemoteFrameType.Renew,
        ticket,
      }),
    );
    sendJsonRpcResult(client.socket, request, {
      _meta: {
        [ACP_REMOTE_CONNECTION_ID_META]: connectionId,
        [ACP_REMOTE_HOST_ID_META]: hostId,
        "acp-runtime/remote/ticketKid": ticket.kid,
        "acp-runtime/remote/ticketExpiresAt": ticket.payload.expiresAt,
      },
    });
  }

  private async revalidateBoundClientMessage(
    client: RelayClient,
    payload: RelayJsonRpcMessage,
  ): Promise<
    | {
        ok: true;
      }
    | {
        closeRoute: boolean;
        ok: false;
        reason: string;
        requiredScope?: AcpRemoteScope;
      }
  > {
    if (!client.hostId || !client.ticket) {
      return {
        closeRoute: true,
        ok: false,
        reason: "ACP remote connection is not authorized.",
      };
    }

    const connectDecision = await this.controlPlaneStore.resolveGrant({
      accountId: client.accountId,
      clientDeviceId: client.clientDeviceId,
      hostId: client.hostId,
      requiredScopes: ["acp:connect"],
    });
    if (!connectDecision.ok) {
      return {
        closeRoute: true,
        ok: false,
        reason: connectDecision.reason,
      };
    }

    const requiredScope = requiredScopeForAcpPayload(payload);
    const grantDecision = requiredScope
      ? await this.controlPlaneStore.resolveGrant({
          accountId: client.accountId,
          clientDeviceId: client.clientDeviceId,
          hostId: client.hostId,
          requiredScopes: ["acp:connect", requiredScope],
        })
      : connectDecision;
    if (!grantDecision.ok) {
      return {
        closeRoute: false,
        ok: false,
        reason: grantDecision.reason,
        requiredScope,
      };
    }

    if (this.shouldRenewTicket(client.ticket)) {
      return {
        closeRoute: false,
        ok: false,
        reason: "ACP remote ticket renewal required.",
      };
    }
    return { ok: true };
  }

  private async revalidateBoundClientFrame(
    client: RelayClient,
    frame: AcpRemoteDataFrame,
  ): Promise<
    | {
        ok: true;
      }
    | {
        closeRoute: boolean;
        ok: false;
        reason: string;
        requiredScope?: AcpRemoteScope;
      }
  > {
    if (!client.hostId || !client.ticket) {
      return {
        closeRoute: true,
        ok: false,
        reason: "ACP remote connection is not authorized.",
      };
    }

    const connectDecision = await this.controlPlaneStore.resolveGrant({
      accountId: client.accountId,
      clientDeviceId: client.clientDeviceId,
      hostId: client.hostId,
      requiredScopes: ["acp:connect"],
    });
    if (!connectDecision.ok) {
      return {
        closeRoute: true,
        ok: false,
        reason: connectDecision.reason,
      };
    }

    const requiredScope = requiredScopeForRemoteFrame(frame);
    const grantDecision = requiredScope
      ? await this.controlPlaneStore.resolveGrant({
          accountId: client.accountId,
          clientDeviceId: client.clientDeviceId,
          hostId: client.hostId,
          requiredScopes: ["acp:connect", requiredScope],
        })
      : connectDecision;
    if (!grantDecision.ok) {
      return {
        closeRoute: false,
        ok: false,
        reason: grantDecision.reason,
        requiredScope,
      };
    }

    if (this.shouldRenewTicket(client.ticket)) {
      return {
        closeRoute: false,
        ok: false,
        reason: "ACP remote ticket renewal required.",
      };
    }
    return { ok: true };
  }

  private rejectBoundClientMessage(
    connectionId: string,
    client: ConnectedRelayClient,
    payload: RelayJsonRpcMessage,
    authorization: {
      closeRoute: boolean;
      reason: string;
      requiredScope?: AcpRemoteScope;
    },
  ): void {
    if (isJsonRpcRequest(payload)) {
      sendJsonRpcError(client.socket, payload, {
        code: -32000,
        data: {
          requiredScope: authorization.requiredScope,
        },
        message: `Authentication required: ${authorization.reason}`,
      });
    }

    if (authorization.closeRoute || !isJsonRpcRequest(payload)) {
      this.revokeClientRoute(
        connectionId,
        client,
        "authorization_revoked",
        authorization.reason,
      );
    }
  }

  private closeClientRoute(
    connectionId: string,
    client: RelayClient,
    code: string,
    reason: string,
  ): void {
    const hostId = client.hostId;
    if (hostId) {
      this.daemons.get(hostId)?.send(
        JSON.stringify({
          code,
          connectionId,
          frameType: AcpRemoteFrameType.Close,
          reason,
        }),
      );
    }
    client.bootstrapComplete = false;
    client.bufferedClientPayloads = [];
    client.clientPendingFrames.clear();
    client.daemonPendingFrames.clear();
    client.hostId = undefined;
    client.lastDaemonSeq = undefined;
    client.ticket = undefined;
  }

  private revokeClientRoute(
    connectionId: string,
    client: RelayClient,
    code: string,
    reason: string,
  ): void {
    this.closeClientRoute(connectionId, client, code, reason);
    client.socket?.close(1008, reason);
    this.clients.delete(connectionId);
  }

  private closeClientsForHost(
    hostId: string,
    code: number,
    reason: string,
  ): void {
    for (const [connectionId, client] of this.clients.entries()) {
      if (client.hostId !== hostId) {
        continue;
      }
      client.socket?.close(code, reason);
      this.clients.delete(connectionId);
    }
  }

  private markDaemonDisconnected(hostId: string, reason: string): void {
    if (this.daemonReconnectGraceMs > 0 && this.hasClientsForHost(hostId)) {
      this.daemonReconnects.set(hostId, {
        disconnectedAtMs: this.now().getTime(),
      });
      return;
    }

    this.closeClientsForHost(hostId, 1013, reason);
  }

  private hasClientsForHost(hostId: string): boolean {
    for (const client of this.clients.values()) {
      if (client.hostId === hostId) {
        return true;
      }
    }
    return false;
  }

  private reopenClientRoutesForDaemon(hostId: string, socket: RelaySocket): void {
    for (const [connectionId, client] of this.clients.entries()) {
      if (client.hostId !== hostId || !client.ticket) {
        continue;
      }

      this.sendDaemonClientHello(connectionId, client, socket);
      this.sendDaemonBootstrapInitialize(connectionId, client, socket);
      this.replayPendingDaemonFrames(client, socket);
    }
  }

  private sendDaemonClientHello(
    connectionId: string,
    client: RelayClient,
    daemon: RelaySocket,
  ): void {
    if (!client.hostId || !client.ticket) {
      return;
    }

    daemon.send(
      JSON.stringify({
        connectionId,
        endpoint: AcpRemoteEndpointKind.Client,
        frameType: AcpRemoteFrameType.Hello,
        hostId: client.hostId,
        protocolVersion: ACP_REMOTE_PROTOCOL_VERSION,
        ticket: client.ticket,
      }),
    );
  }

  private sendDaemonBootstrapInitialize(
    connectionId: string,
    client: RelayClient,
    daemon: RelaySocket,
  ): void {
    const requestId = `relay:${connectionId}:initialize`;
    client.daemonBootstrapRequestIds.add(requestId);
    this.sendDaemonDataFrame(connectionId, client, daemon, {
      id: requestId,
      jsonrpc: "2.0",
      method: "initialize",
      params: client.initializeParams ?? {
        clientCapabilities: {},
        protocolVersion: 1,
      },
    });
  }

  private sendDaemonDataFrame(
    connectionId: string,
    client: RelayClient,
    daemon: RelaySocket,
    payload: unknown,
    options: {
      channelId?: string;
      channelKind?: AcpRemoteChannelKind;
    } = {},
  ): void {
    const seq = ++client.seq;
    const frame: AcpRemoteDataFrame = {
      channelId: options.channelId ?? "acp",
      channelKind: options.channelKind ?? AcpRemoteChannelKind.Acp,
      connectionId,
      frameType: AcpRemoteFrameType.Data,
      payload,
      seq,
    };
    client.daemonPendingFrames.set(seq, frame);
    if (client.daemonPendingFrames.size > this.maxBufferedFramesPerConnection) {
      this.closeClientRoute(
        connectionId,
        client,
        "daemon_backpressure",
        "Buffered daemon frame limit exceeded.",
      );
      return;
    }
    daemon.send(JSON.stringify(frame));
  }

  private handleDaemonAck(frame: AcpRemoteAckFrame): void {
    const client = this.clients.get(frame.connectionId);
    if (!client) {
      return;
    }
    for (const seq of [...client.daemonPendingFrames.keys()].sort(
      (left, right) => left - right,
    )) {
      if (seq > frame.ack) {
        break;
      }
      client.daemonPendingFrames.delete(seq);
    }
  }

  private handleClientAck(client: RelayClient, ack: number): void {
    for (const seq of [...client.clientPendingFrames.keys()].sort(
      (left, right) => left - right,
    )) {
      if (seq > ack) {
        break;
      }
      client.clientPendingFrames.delete(seq);
    }
  }

  private sendDaemonAck(client: RelayClient, frame: AcpRemoteDataFrame): void {
    const hostId = client.hostId;
    if (!hostId) {
      return;
    }
    this.daemons.get(hostId)?.send(
      JSON.stringify({
        ack: frame.seq,
        channelId: frame.channelId,
        connectionId: frame.connectionId,
        frameType: AcpRemoteFrameType.Ack,
      } satisfies AcpRemoteAckFrame),
    );
  }

  private flushBufferedClientPayloads(client: ConnectedRelayClient): void {
    if (client.bufferedClientPayloads.length === 0) {
      return;
    }
    for (const payload of client.bufferedClientPayloads) {
      if (client.transport === "remote-frame") {
        const frame = parseFrame(payload);
        if (frame?.frameType === AcpRemoteFrameType.Data) {
          client.clientPendingFrames.set(frame.seq, frame);
        }
      }
      client.socket.send(payload);
    }
    client.bufferedClientPayloads = [];
  }

  private replayPendingDaemonFrames(
    client: RelayClient,
    daemon: RelaySocket,
  ): void {
    for (const frame of [...client.daemonPendingFrames.values()].sort(
      (left, right) => left.seq - right.seq,
    )) {
      daemon.send(JSON.stringify(frame));
    }
  }

  private canResumeClient(
    input: AcpRelayClientRegistration,
    existing: RelayClient,
    clientDeviceId: string,
    transport: AcpRelayClientTransport,
  ): boolean {
    if (
      !existing.bootstrapComplete ||
      !existing.hostId ||
      !existing.ticket ||
      existing.accountId !== input.accountId ||
      existing.clientDeviceId !== clientDeviceId ||
      existing.transport !== transport
    ) {
      return false;
    }

    if (input.hostId && input.hostId !== existing.hostId) {
      return false;
    }

    if (existing.disconnectedAtMs === undefined) {
      return true;
    }

    return (
      this.clientReconnectGraceMs > 0 &&
      this.now().getTime() - existing.disconnectedAtMs <=
        this.clientReconnectGraceMs
    );
  }

  private shouldKeepDisconnectedClient(client: RelayClient): boolean {
    return (
      this.clientReconnectGraceMs > 0 &&
      client.bootstrapComplete &&
      client.hostId !== undefined &&
      client.ticket !== undefined &&
      this.daemons.has(client.hostId)
    );
  }

  private sendDaemonClientClose(
    connectionId: string,
    client: RelayClient,
    code: string,
    reason: string,
  ): void {
    const hostId = client.hostId;
    if (!hostId) {
      return;
    }

    this.daemons.get(hostId)?.send(
      JSON.stringify({
        code,
        connectionId,
        frameType: AcpRemoteFrameType.Close,
        reason,
      }),
    );
  }

  private handleDaemonPong(connectionId: string, nonce: string): void {
    const hostId = hostIdFromDaemonHeartbeatConnectionId(connectionId);
    if (!hostId) {
      return;
    }
    const heartbeat = this.daemonHeartbeats.get(hostId);
    if (!heartbeat || heartbeat.pendingNonce !== nonce) {
      return;
    }

    this.daemonHeartbeats.set(hostId, {
      lastPongAt: this.now().toISOString(),
    });
  }

  private handleDaemonPing(connectionId: string, nonce: string): void {
    const hostId = hostIdFromDaemonHeartbeatConnectionId(connectionId);
    const daemon = hostId ? this.daemons.get(hostId) : undefined;
    daemon?.send(
      JSON.stringify({
        connectionId,
        frameType: AcpRemoteFrameType.Pong,
        nonce,
      }),
    );
  }

  private shouldRenewTicket(ticket: AcpRemoteSignedConnectionTicket): boolean {
    const expiresAt = Date.parse(ticket.payload.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      return true;
    }
    return expiresAt - this.now().getTime() <= this.ticketRenewBeforeMs;
  }

  private createSignedTicket(
    connectionId: string,
    grant: AcpRemoteGrant,
  ): Promise<AcpRemoteSignedConnectionTicket> {
    if (!this.ticketSigningKey) {
      throw new Error("Relay ticket signing key is not configured.");
    }

    return createAcpRemoteSignedConnectionTicket({
      connectionId,
      grant: {
        ...grant,
        policyVersion: grant.policyVersion ?? this.policyVersion,
        scopes: grant.scopes.length ? grant.scopes : this.defaultScopes,
      },
      key: this.ticketSigningKey,
      now: this.now(),
      ttlMs: this.ticketTtlMs,
    });
  }

  private waitForClientHostSelection(
    client: RelayClient,
  ): Promise<string | undefined> {
    if (client.hostId) {
      return Promise.resolve(client.hostId);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        client.waiters.delete(resolveSelection);
        resolve(undefined);
      }, this.authWaitMs);
      const resolveSelection = (hostId: string) => {
        clearTimeout(timeout);
        resolve(hostId);
      };
      client.waiters.add(resolveSelection);
    });
  }
}

export function createRelayAuthorizationPage(input: {
  accountId: string;
  connectionId: string;
  hosts: readonly string[];
  requestUrl: string;
}): string {
  const links = input.hosts
    .map((hostId) => {
      const url = new URL(input.requestUrl);
      url.searchParams.set("accountId", input.accountId);
      url.searchParams.set("connectionId", input.connectionId);
      url.searchParams.set("hostId", hostId);
      return `<li><a href="${escapeHtml(url.toString())}">${escapeHtml(hostId)}</a></li>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>ACP Runtime Relay</title></head>
  <body>
    <h1>Select a host</h1>
    <p>Connection: <code>${escapeHtml(input.connectionId)}</code></p>
    <ul>${links}</ul>
  </body>
</html>`;
}

export function createRelayAuthorizationResultPage(
  result: AcpRelayAuthorizationResult,
): string {
  if (result.ok) {
    return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>ACP Runtime Relay</title></head>
  <body>
    <h1>Authorized</h1>
    <p>Connection <code>${escapeHtml(result.connectionId)}</code> is bound to host <code>${escapeHtml(result.hostId)}</code>.</p>
  </body>
</html>`;
  }

  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>ACP Runtime Relay</title></head>
  <body>
    <h1>Authorization failed</h1>
    <p>${escapeHtml(result.reason)}</p>
  </body>
</html>`;
}

function parseFrame(text: string): AcpRemoteFrame | undefined {
  try {
    return assertAcpRemoteFrame(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function parseJsonRpcMessage(text: string): RelayJsonRpcMessage | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
      return undefined;
    }
    if ("id" in value) {
      const id = value.id;
      if (typeof id !== "string" && typeof id !== "number" && id !== null) {
        return undefined;
      }
      return {
        id,
        jsonrpc: "2.0",
        method: value.method,
        params: value.params,
      };
    }
    return {
      jsonrpc: "2.0",
      method: value.method,
      params: value.params,
    };
  } catch {
    return undefined;
  }
}

function sendJsonRpcResult(
  socket: RelaySocket,
  request: RelayJsonRpcRequest,
  result: unknown,
): void {
  socket.send(
    JSON.stringify({
      id: request.id,
      jsonrpc: "2.0",
      result,
    }),
  );
}

function sendJsonRpcError(
  socket: RelaySocket,
  request: RelayJsonRpcRequest,
  error: {
    code: number;
    data?: unknown;
    message: string;
  },
): void {
  socket.send(
    JSON.stringify({
      error,
      id: request.id,
      jsonrpc: "2.0",
    }),
  );
}

function readRequestedProtocolVersion(params: unknown): number {
  if (isRecord(params) && typeof params.protocolVersion === "number") {
    return params.protocolVersion;
  }
  return 1;
}

function readMethodId(params: unknown): string | undefined {
  if (isRecord(params) && typeof params.methodId === "string") {
    return params.methodId;
  }
  return undefined;
}

function readMetaString(params: unknown, key: string): string | undefined {
  if (!isRecord(params) || !isRecord(params._meta)) {
    return undefined;
  }
  const value = params._meta[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isJsonRpcRequest(
  message: RelayJsonRpcMessage,
): message is RelayJsonRpcRequest {
  return "id" in message;
}

function isConnectedClient(client: RelayClient): client is ConnectedRelayClient {
  return client.socket !== undefined;
}

function isSuppressedDaemonBootstrapResponse(
  client: RelayClient,
  payload: unknown,
): boolean {
  if (!isRecord(payload) || payload.jsonrpc !== "2.0" || !("id" in payload)) {
    return false;
  }

  const id = payload.id;
  if (typeof id !== "string" || !client.daemonBootstrapRequestIds.has(id)) {
    return false;
  }

  client.daemonBootstrapRequestIds.delete(id);
  return true;
}

function isReplayOrDuplicateDaemonFrame(
  client: RelayClient,
  frame: AcpRemoteDataFrame,
): boolean {
  if (
    client.lastDaemonSeq !== undefined &&
    frame.seq <= client.lastDaemonSeq
  ) {
    return true;
  }
  client.lastDaemonSeq = frame.seq;
  return false;
}

const ACP_METHOD_SCOPE_BY_METHOD = {
  "session/close": "acp:session:resume",
  "session/set_config_option": "acp:session:resume",
  "session/set_mode": "acp:session:resume",
  "session/fork": "acp:session:resume",
  "session/list": "acp:session:list",
  "session/load": "acp:session:resume",
  "session/new": "acp:session:create",
  "session/prompt": "acp:turn:send",
  "session/resume": "acp:session:resume",
} as const satisfies Record<string, AcpRemoteScope>;

const ACP_NOTIFICATION_SCOPE_BY_METHOD = {
  "session/cancel": "acp:turn:cancel",
} as const satisfies Record<string, AcpRemoteScope>;

function requiredScopeForAcpPayload(
  payload: RelayJsonRpcMessage,
): AcpRemoteScope | undefined {
  if (isJsonRpcRequest(payload)) {
    return readScope(ACP_METHOD_SCOPE_BY_METHOD, payload.method);
  }
  return readScope(ACP_NOTIFICATION_SCOPE_BY_METHOD, payload.method);
}

function requiredScopeForRemoteFrame(
  frame: AcpRemoteDataFrame,
): AcpRemoteScope | undefined {
  if (frame.channelKind === AcpRemoteChannelKind.Acp) {
    const message = isRelayJsonRpcMessage(frame.payload)
      ? frame.payload
      : undefined;
    return message ? requiredScopeForAcpPayload(message) : "acp:connect";
  }

  const operation = readOperation(frame.payload);
  switch (frame.channelKind) {
    case AcpRemoteChannelKind.Artifact:
      return isReadOperation(operation) ? "artifact:read" : "artifact:write";
    case AcpRemoteChannelKind.Browser:
      return "browser:control";
    case AcpRemoteChannelKind.Filesystem:
      if (operation === "watch" || operation === "watchFile") {
        return "fs:watch";
      }
      return isReadOperation(operation) ? "fs:read" : "fs:write";
    case AcpRemoteChannelKind.Logs:
      return "logs:read";
    case AcpRemoteChannelKind.Port:
      return "port:forward";
    case AcpRemoteChannelKind.Terminal:
      if (operation === "write" || operation === "writeInput") {
        return "terminal:write";
      }
      if (operation === "kill" || operation === "release") {
        return "terminal:kill";
      }
      return operation === "start" ||
        operation === "create" ||
        operation === "output" ||
        operation === "wait"
        ? "terminal:start"
        : "terminal:kill";
    default:
      return undefined;
  }
}

function isRelayJsonRpcMessage(value: unknown): value is RelayJsonRpcMessage {
  return (
    isRecord(value) &&
    value.jsonrpc === "2.0" &&
    typeof value.method === "string" &&
    (!("id" in value) ||
      typeof value.id === "string" ||
      typeof value.id === "number" ||
      value.id === null)
  );
}

function readOperation(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const operation = payload.operation ?? payload.op ?? payload.type;
  return typeof operation === "string" ? operation : undefined;
}

function isReadOperation(operation: string | undefined): boolean {
  return (
    operation === "read" ||
    operation === "readTextFile" ||
    operation === "list" ||
    operation === "listDirectory" ||
    operation === "stat" ||
    operation === "exists" ||
    operation === "download"
  );
}

function readScope<T extends Record<string, AcpRemoteScope>>(
  scopes: T,
  method: string,
): AcpRemoteScope | undefined {
  return Object.prototype.hasOwnProperty.call(scopes, method)
    ? scopes[method as keyof T]
    : undefined;
}

function daemonHeartbeatConnectionId(hostId: string): string {
  return `daemon:${hostId}`;
}

function hostIdFromDaemonHeartbeatConnectionId(
  connectionId: string,
): string | undefined {
  const prefix = "daemon:";
  return connectionId.startsWith(prefix)
    ? connectionId.slice(prefix.length)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
