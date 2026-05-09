import {
  ACP_REMOTE_PROTOCOL_VERSION,
  AcpRemoteChannelKind,
  AcpRemoteEndpointKind,
  AcpRemoteFrameType,
  type AcpRemoteDataFrame,
  type AcpRemoteScope,
  type AcpRemoteSignedConnectionTicket,
  type AcpRemoteSignedDeviceRenewalProof,
} from "../../../src/runtime/remote/protocol/index.js";
import {
  verifyAcpRelayAccountSessionToken,
  createAcpRelayAccountSessionToken,
  type AcpRelayAccountSession,
} from "./account-session.js";
import {
  AcpRelayD1ControlPlaneStore,
  type AcpRelayAccountRecord,
  type AcpRelayClientDeviceRecord,
  type AcpRelayGrantRecord,
  type AcpRelayHostRecord,
} from "./control-plane-store.js";
import { verifyDaemonRegistrationProof } from "./daemon-auth.js";
import {
  D1GitHubAccountStore,
  createGitHubAuthorizationUrl,
  exchangeGitHubCodeForAccessToken,
  fetchGitHubUser,
  resolveOrCreateGithubAccount,
} from "./github-auth.js";
import {
  AcpRelayBroker,
  createRelayAuthorizationPage,
  createRelayAuthorizationResultPage,
  type AcpRelayClientStateSnapshot,
  type AcpRelayClientTransport,
  type DaemonMetadata,
} from "./relay-core.js";

export type Env = {
  ACP_RELAY_ACCOUNT_SESSION_SECRET?: string;
  ACP_RELAY_CONTROL_PLANE_SECRET?: string;
  ACP_RELAY_CLIENT_RECONNECT_GRACE_MS?: string;
  ACP_RELAY_DAEMON_RECONNECT_GRACE_MS?: string;
  ACP_RELAY_DB?: D1Database;
  ACP_RELAY_GITHUB_CLIENT_ID?: string;
  ACP_RELAY_GITHUB_CLIENT_SECRET?: string;
  ACP_RELAY_HEARTBEAT_INTERVAL_MS?: string;
  ACP_RELAY_HEARTBEAT_TIMEOUT_MS?: string;
  ACP_RELAY_LOGIN_URL?: string;
  ACP_RELAY_MAX_BUFFERED_FRAMES_PER_CONNECTION?: string;
  ACP_RELAY_MAX_CONNECTIONS_PER_ACCOUNT?: string;
  ACP_RELAY_SHARDS: DurableObjectNamespace;
  ACP_RELAY_TICKET_KID?: string;
  ACP_RELAY_TICKET_PRIVATE_KEY?: string;
  ACP_RELAY_TICKET_RENEW_BEFORE_MS?: string;
  ACP_RELAY_TICKET_SECRET?: string;
  ACP_RELAY_TICKET_TTL_MS?: string;
};

const UPGRADE_REQUIRED = "Expected WebSocket upgrade.";
const MAX_LOG_UPLOAD_RECORDS = 100;
const MAX_LOG_UPLOAD_BYTES = 512 * 1024;
const RELAY_SOCKET_ATTACHMENT_VERSION = 1;
const RELAY_CLIENT_STATE_STORAGE_PREFIX = "client-state:";
const DEFAULT_AUTOMATIC_GRANT_SCOPES = [
  "acp:connect",
  "acp:session:create",
  "acp:session:list",
  "acp:session:resume",
  "acp:turn:send",
  "acp:turn:cancel",
] as const satisfies readonly AcpRemoteScope[];

type RelayWebSocketAttachment = {
  accountId?: string;
  authUrl?: string;
  bootstrapComplete?: boolean;
  clientId?: string;
  connectedAt: number;
  connectionId: string;
  daemonId?: string;
  daemonMetadata?: DaemonMetadata;
  endpoint: AcpRemoteEndpointKind;
  nativeClientAck?: boolean;
  ticket?: AcpRemoteSignedConnectionTicket;
  transport?: AcpRelayClientTransport;
  version: typeof RELAY_SOCKET_ATTACHMENT_VERSION;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (url.pathname === "/login" || url.pathname === "/login/callback") {
      return handleGitHubAuthRequest(request, env, url);
    }

    if (url.pathname.startsWith("/control-plane/")) {
      return handleControlPlaneRequest(request, env, url);
    }

    if (url.pathname === "/renew") {
      return routeDeviceRenewalRequest(request, env);
    }

    if (
      url.pathname !== "/acp" &&
      url.pathname !== "/api/daemons" &&
      url.pathname !== "/api/logs" &&
      url.pathname !== "/api/session" &&
      url.pathname !== "/client" &&
      url.pathname !== "/daemon" &&
      !url.pathname.startsWith("/api/daemons/") &&
      url.pathname !== "/authorize"
    ) {
      return new Response("Not found.", { status: 404 });
    }

    // OAuth and API endpoints that persist data require D1
    if (url.pathname.startsWith("/login") && !env.ACP_RELAY_DB) {
      return new Response("GitHub OAuth requires a database (D1).", { status: 503 });
    }
    if (url.pathname === "/api/logs") {
      return handleRelayLogUploadRequest(request, env);
    }
    if (url.pathname.startsWith("/api/") && !env.ACP_RELAY_DB) {
      return new Response("API endpoints require a database (D1).", { status: 503 });
    }

    if (url.pathname === "/api/session") {
      const accountSession = await verifyAccountSessionRequest({
        env,
        request,
      });
      if (!accountSession.ok) {
        return json({ error: accountSession.reason }, {
          status: accountSession.status,
        });
      }
      const secret = env.ACP_RELAY_ACCOUNT_SESSION_SECRET;
      if (!secret) {
        return json({ error: "Session secret not configured." }, { status: 503 });
      }
      const token = await createAcpRelayAccountSessionToken({
        secret,
        session: accountSession.session,
      });
      return json({
        accountId: accountSession.session.accountId,
        token,
      });
    }

    if (url.pathname === "/api/daemons" || url.pathname.startsWith("/api/daemons/")) {
      const accountSession = await verifyAccountSessionRequest({
        env,
        request,
        requestedAccountId: resolveRequestedAccountId(request, url),
      });
      if (!accountSession.ok) {
        return new Response(accountSession.reason, {
          status: accountSession.status,
        });
      }
      const shardId = env.ACP_RELAY_SHARDS.idFromName(
        `account:${accountSession.session.accountId}`,
      );
      return env.ACP_RELAY_SHARDS
        .get(shardId)
        .fetch(withVerifiedAccountSession(request, accountSession.session));
    }

    if (url.pathname === "/authorize") {
      const accountSession = await verifyAccountSessionRequest({
        env,
        request,
        requestedAccountId: resolveRequestedAccountId(request, url),
      });
      if (!accountSession.ok) {
        return createAuthorizationSessionFailureResponse({
          env,
          failure: accountSession,
          request,
          url,
        });
      }

      const shardId = env.ACP_RELAY_SHARDS.idFromName(
        `account:${accountSession.session.accountId}`,
      );
      return env.ACP_RELAY_SHARDS
        .get(shardId)
        .fetch(withVerifiedAccountSession(request, accountSession.session));
    }

    if (url.pathname === "/client") {
      const accountSession = await verifyAccountSessionRequest({
        env,
        request,
        requestedAccountId: resolveRequestedAccountId(request, url),
      });
      if (!accountSession.ok) {
        return new Response(accountSession.reason, {
          status: accountSession.status,
        });
      }
      const clientId =
        resolveClientId(request, url) ??
        accountSession.session.clientId;
      if (!clientId) {
        return new Response("Missing client id.", { status: 400 });
      }
      if (
        accountSession.session.clientId &&
        accountSession.session.clientId !== clientId
      ) {
        return new Response(
          "ACP relay account session does not match requested client device.",
          { status: 403 },
        );
      }
      if (!resolveDaemonId(request, url)) {
        return new Response("Missing daemon id.", { status: 400 });
      }

      const shardId = env.ACP_RELAY_SHARDS.idFromName(
        `account:${accountSession.session.accountId}`,
      );
      return env.ACP_RELAY_SHARDS
        .get(shardId)
        .fetch(withVerifiedAccountSession(request, accountSession.session));
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response(UPGRADE_REQUIRED, { status: 426 });
    }

    if (url.pathname === "/daemon" && !resolveDaemonId(request, url)) {
      return new Response("Missing daemon id.", { status: 400 });
    }

    const accountId = await resolveAuthenticatedAccountId(request, url, env);
    if (url.pathname === "/daemon") {
      const daemonId = resolveDaemonId(request, url);
      if (!daemonId) {
        return new Response("Missing daemon id.", { status: 400 });
      }
      const proof = await verifyDaemonRegistrationRequest({
        accountId,
        env,
        daemonId,
        request,
      });
      if (!proof.ok) {
        return new Response(proof.reason, { status: 401 });
      }
    }

    const shardId = env.ACP_RELAY_SHARDS.idFromName(`account:${accountId}`);
    return env.ACP_RELAY_SHARDS.get(shardId).fetch(request);
  },
};

export class AcpRelayShard {
  private readonly broker: AcpRelayBroker;
  private readonly heartbeatIntervalMs: number | undefined;
  private readonly restorePromise: Promise<void>;
  private readonly createdAt: number;
  private instanceId: string;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.createdAt = Date.now();
    this.instanceId = crypto.randomUUID();
    console.log(
      `[relay-do] instance created id=${this.instanceId} time=${new Date().toISOString()}`,
    );
    this.heartbeatIntervalMs = readOptionalPositiveInteger(
      this.env.ACP_RELAY_HEARTBEAT_INTERVAL_MS,
    );
    this.broker = new AcpRelayBroker({
      controlPlaneStore: this.env.ACP_RELAY_DB
        ? new AcpRelayD1ControlPlaneStore(this.env.ACP_RELAY_DB)
        : undefined,
      clientReconnectGraceMs: readOptionalPositiveInteger(
        this.env.ACP_RELAY_CLIENT_RECONNECT_GRACE_MS,
      ),
      daemonReconnectGraceMs: readOptionalPositiveInteger(
        this.env.ACP_RELAY_DAEMON_RECONNECT_GRACE_MS,
      ),
      heartbeatTimeoutMs: readOptionalPositiveInteger(
        this.env.ACP_RELAY_HEARTBEAT_TIMEOUT_MS,
      ),
      maxBufferedFramesPerConnection: readOptionalPositiveInteger(
        this.env.ACP_RELAY_MAX_BUFFERED_FRAMES_PER_CONNECTION,
      ),
      maxConnectionsPerAccount: readOptionalPositiveInteger(
        this.env.ACP_RELAY_MAX_CONNECTIONS_PER_ACCOUNT,
      ),
      ticketRenewBeforeMs: readOptionalPositiveInteger(
        this.env.ACP_RELAY_TICKET_RENEW_BEFORE_MS,
      ),
      ticketSigningKey: this.env.ACP_RELAY_TICKET_PRIVATE_KEY
        ? {
            kid: this.env.ACP_RELAY_TICKET_KID ?? "relay-production",
            privateKey: this.env.ACP_RELAY_TICKET_PRIVATE_KEY,
          }
        : this.env.ACP_RELAY_TICKET_SECRET
        ? {
            kid: this.env.ACP_RELAY_TICKET_KID ?? "relay-local",
            secret: this.env.ACP_RELAY_TICKET_SECRET,
          }
        : undefined,
      ticketTtlMs: readOptionalPositiveInteger(
        this.env.ACP_RELAY_TICKET_TTL_MS,
      ),
      onClientRouteAuthorized: ({ connectionId, daemonId, ticket }) => {
        this.updateClientSocketAttachmentByConnectionId(connectionId, {
          bootstrapComplete: true,
          daemonId,
          ticket,
        });
      },
    });
    this.restorePromise = this.restoreHibernatedWebSockets();
  }

  async alarm(): Promise<void> {
    await this.restorePromise;
    const now = Date.now();
    const ageMs = now - this.createdAt;
    console.log(
      `[relay-do] alarm fired instance=${this.instanceId} age_ms=${ageMs} daemons=${this.broker.onlineHostIds().length}`,
    );
    this.broker.closeUnresponsiveDaemons();
    this.broker.closeExpiredDisconnectedDaemons();
    const expiredClientIds = this.broker.closeExpiredDisconnectedClients();
    await Promise.all(
      expiredClientIds.map((connectionId) =>
        this.deleteClientStateSnapshot(connectionId),
      ),
    );
    await this.writeAllClientStateSnapshots();
    this.broker.pingDaemons();
    await this.scheduleHeartbeat();
  }

  async fetch(request: Request): Promise<Response> {
    await this.restorePromise;
    const url = new URL(request.url);
    if (url.pathname === "/internal/reconcile-authorizations") {
      return this.reconcileAuthorizations(request);
    }
    if (url.pathname === "/renew") {
      return this.renew(request);
    }
    if (url.pathname === "/authorize") {
      return this.authorize(request, url);
    }

    if (url.pathname === "/api/daemons" || url.pathname.startsWith("/api/daemons/")) {
      return this.handleDaemonApi(request, url);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response(UPGRADE_REQUIRED, { status: 426 });
    }

    const endpoint =
      url.pathname === "/daemon"
        ? AcpRemoteEndpointKind.Daemon
        : AcpRemoteEndpointKind.Client;
    const clientTransport =
      url.pathname === "/client" ? "remote-frame" : "native-acp";
    const connectionId =
      url.searchParams.get("connectionId") ?? crypto.randomUUID();
    const daemonId = resolveDaemonId(request, url);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const connectedAt = Date.now();
    this.acceptRelayWebSocket(server, {
      connectedAt,
      connectionId,
      daemonId,
      endpoint,
      version: RELAY_SOCKET_ATTACHMENT_VERSION,
    });

    console.log(
      `[relay-do] ws connected endpoint=${endpoint} connectionId=${connectionId} daemonId=${daemonId ?? "none"} instance=${this.instanceId}`,
    );

    if (endpoint === AcpRemoteEndpointKind.Daemon) {
      if (!daemonId) {
        server.close(1008, "Missing daemon id.");
      } else {
        const daemonMetadata = parseDaemonMetadataHeaders(request);
        this.updateSocketAttachment(server, {
          daemonMetadata,
        });
        void (async () => {
          try {
            await this.broker.registerDaemon(daemonId, server, daemonMetadata);
            await this.writeAllClientStateSnapshots();
            await this.scheduleHeartbeat();
          } catch (error) {
            console.error("Failed to register ACP relay daemon route", error);
            server.close(1011, "Failed to register daemon route.");
          }
        })();
      }
    } else {
      const agentCommand = url.searchParams.get("agentCommand");
      const agentId = url.searchParams.get("agentId");
      const agentType = url.searchParams.get("agentType");
      const accountId =
        clientTransport === "remote-frame"
          ? (resolveVerifiedAccountId(request) ?? resolveAccountId(request, url, "default")!)
          : await resolveAuthenticatedAccountId(request, url, this.env);
      const clientId = resolveClientId(request, url);
      const authUrl = createAuthorizationUrl(request, connectionId).toString();
      const nativeClientAck = url.searchParams.get("nativeClientAck") === "1";
      const stateSnapshot = await this.readClientStateSnapshot(connectionId);
      this.updateSocketAttachment(server, {
        accountId,
        authUrl,
        clientId,
        nativeClientAck,
        transport: clientTransport,
      });
      this.broker.registerClient({
        accountId,
        authUrl,
        clientId,
        connectionId,
        daemonId,
        nativeClientAck,
        socket: server,
        stateSnapshot,
        transport: clientTransport,
      });
      await this.writeOrDeleteClientStateSnapshot(connectionId);
      if (clientTransport === "remote-frame") {
        if (!daemonId) {
          server.close(1008, "Missing daemon id.");
        } else {
          const clientAgent = agentCommand
            ? { command: agentCommand, type: agentType ?? undefined }
            : agentId
              ? { id: agentId }
            : undefined;
          const result = await this.broker.authorizeClient({
            clientAgent,
            connectionId,
            daemonId,
          });
          if (!result.ok) {
            server.close(1008, result.reason);
          } else {
            this.updateSocketAttachment(server, {
              bootstrapComplete: true,
              daemonId,
              ticket: result.ticket,
            });
            await this.writeOrDeleteClientStateSnapshot(connectionId);
            server.send(
              JSON.stringify({
                connectionId,
                endpoint: AcpRemoteEndpointKind.Daemon,
                frameType: AcpRemoteFrameType.Hello,
                daemonId,
                protocolVersion: ACP_REMOTE_PROTOCOL_VERSION,
                ticket: result.ticket,
              }),
            );
          }
        }
      }
    }

    if (!this.usesWebSocketHibernation()) {
      server.addEventListener("message", (event) => {
        void this.webSocketMessage(server, event.data);
      });
      server.addEventListener("close", (event) => {
        const closeEvent = event as { code?: unknown; reason?: unknown } | undefined;
        this.webSocketClose(
          server,
          typeof closeEvent?.code === "number" ? closeEvent.code : undefined,
          typeof closeEvent?.reason === "string" ? closeEvent.reason : undefined,
        );
      });
      server.addEventListener("error", (event) => {
        this.webSocketError(server, event);
      });
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket });
  }

  async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    await this.restorePromise;
    const attachment = this.readSocketAttachment(socket);
    if (!attachment) {
      socket.close(1008, "Missing relay socket attachment.");
      return;
    }
    const text = normalizeMessageData(message);
    if (!text) {
      return;
    }
    if (attachment.endpoint === AcpRemoteEndpointKind.Daemon) {
      const connectionId = this.broker.handleDaemonText(text);
      if (connectionId) {
        await this.writeOrDeleteClientStateSnapshot(connectionId);
      }
      return;
    }
    await this.broker.handleClientText(attachment.connectionId, text);
    await this.writeOrDeleteClientStateSnapshot(attachment.connectionId);
  }

  async webSocketClose(
    socket: WebSocket,
    code?: number,
    reason?: string,
  ): Promise<void> {
    await this.restorePromise;
    const attachment = this.readSocketAttachment(socket);
    if (!attachment) {
      return;
    }
    const durationMs = Date.now() - attachment.connectedAt;
    console.log(
      `[relay-do] ws close endpoint=${attachment.endpoint} connectionId=${attachment.connectionId} daemonId=${attachment.daemonId ?? "none"} code=${code ?? "-"} reason="${reason ?? ""}" duration_ms=${durationMs} instance=${this.instanceId}`,
    );
    this.removeSocket(
      attachment.endpoint,
      attachment.connectionId,
      attachment.daemonId,
      socket,
      { code, reason },
    );
    if (attachment.endpoint === AcpRemoteEndpointKind.Client) {
      await this.writeOrDeleteClientStateSnapshot(attachment.connectionId);
    } else {
      await this.writeAllClientStateSnapshots();
    }
  }

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    await this.restorePromise;
    const attachment = this.readSocketAttachment(socket);
    if (!attachment) {
      return;
    }
    const durationMs = Date.now() - attachment.connectedAt;
    const message =
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
        ? error.message
        : "";
    console.log(
      `[relay-do] ws error endpoint=${attachment.endpoint} connectionId=${attachment.connectionId} daemonId=${attachment.daemonId ?? "none"} message="${message}" duration_ms=${durationMs} instance=${this.instanceId}`,
    );
    this.removeSocket(
      attachment.endpoint,
      attachment.connectionId,
      attachment.daemonId,
      socket,
      { final: false },
    );
    if (attachment.endpoint === AcpRemoteEndpointKind.Client) {
      await this.writeOrDeleteClientStateSnapshot(attachment.connectionId);
    } else {
      await this.writeAllClientStateSnapshots();
    }
  }

  private async restoreHibernatedWebSockets(): Promise<void> {
    const sockets = this.state.getWebSockets?.() ?? [];
    const restored = sockets
      .map((socket) => ({
        attachment: this.readSocketAttachment(socket),
        socket,
      }))
      .filter(
        (
          entry,
        ): entry is {
          attachment: RelayWebSocketAttachment;
          socket: WebSocket;
        } => entry.attachment !== undefined,
      );
    for (const { attachment, socket } of restored) {
      if (attachment.endpoint !== AcpRemoteEndpointKind.Daemon) {
        continue;
      }
      if (!attachment.daemonId) {
        socket.close(1008, "Missing daemon id.");
        continue;
      }
      await this.broker.registerDaemon(
        attachment.daemonId,
        socket,
        attachment.daemonMetadata,
      );
    }
    for (const { attachment, socket } of restored) {
      if (attachment.endpoint !== AcpRemoteEndpointKind.Client) {
        continue;
      }
      if (!attachment.accountId || !attachment.authUrl) {
        socket.close(1008, "Missing client route metadata.");
        continue;
      }
      const stateSnapshot = await this.readClientStateSnapshot(
        attachment.connectionId,
      );
      this.broker.registerClient({
        accountId: attachment.accountId,
        authUrl: attachment.authUrl,
        bootstrapComplete:
          attachment.bootstrapComplete ?? attachment.ticket !== undefined,
        clientId: attachment.clientId,
        connectionId: attachment.connectionId,
        daemonId: attachment.daemonId,
        nativeClientAck: attachment.nativeClientAck,
        restoredHibernatedSocket: true,
        socket,
        stateSnapshot,
        ticket: attachment.ticket,
        transport: attachment.transport,
      });
    }
    if (restored.some((entry) => entry.attachment.endpoint === AcpRemoteEndpointKind.Daemon)) {
      await this.scheduleHeartbeat();
    }
  }

  private acceptRelayWebSocket(
    socket: WebSocket,
    attachment: RelayWebSocketAttachment,
  ): void {
    if (this.usesWebSocketHibernation()) {
      const tags = [
        `endpoint:${attachment.endpoint}`,
        `connection:${attachment.connectionId}`,
        ...(attachment.daemonId ? [`daemon:${attachment.daemonId}`] : []),
      ];
      this.state.acceptWebSocket?.(socket, tags);
    } else {
      socket.accept();
    }
    socket.serializeAttachment?.(attachment);
  }

  private usesWebSocketHibernation(): boolean {
    return typeof this.state.acceptWebSocket === "function";
  }

  private readSocketAttachment(
    socket: WebSocket,
  ): RelayWebSocketAttachment | undefined {
    const value = asRecord(socket.deserializeAttachment?.());
    if (!value) {
      return undefined;
    }
    if (value.version !== RELAY_SOCKET_ATTACHMENT_VERSION) {
      return undefined;
    }
    if (
      value.endpoint !== AcpRemoteEndpointKind.Client &&
      value.endpoint !== AcpRemoteEndpointKind.Daemon
    ) {
      return undefined;
    }
    const connectionId =
      typeof value.connectionId === "string" ? value.connectionId : undefined;
    const connectedAt =
      typeof value.connectedAt === "number" ? value.connectedAt : undefined;
    if (!connectionId || connectedAt === undefined) {
      return undefined;
    }
    return {
      accountId: readAttachmentString(value.accountId),
      authUrl: readAttachmentString(value.authUrl),
      bootstrapComplete:
        typeof value.bootstrapComplete === "boolean"
          ? value.bootstrapComplete
          : undefined,
      clientId: readAttachmentString(value.clientId),
      connectedAt,
      connectionId,
      daemonId: readAttachmentString(value.daemonId),
      daemonMetadata: isDaemonMetadata(value.daemonMetadata)
        ? value.daemonMetadata
        : undefined,
      endpoint: value.endpoint,
      nativeClientAck:
        typeof value.nativeClientAck === "boolean"
          ? value.nativeClientAck
          : undefined,
      ticket: isSignedConnectionTicket(value.ticket) ? value.ticket : undefined,
      transport: isRelayClientTransport(value.transport)
        ? value.transport
        : undefined,
      version: RELAY_SOCKET_ATTACHMENT_VERSION,
    };
  }

  private updateSocketAttachment(
    socket: WebSocket,
    updates: Partial<RelayWebSocketAttachment>,
  ): void {
    const attachment = this.readSocketAttachment(socket);
    if (!attachment) {
      return;
    }
    socket.serializeAttachment?.({
      ...attachment,
      ...updates,
      version: RELAY_SOCKET_ATTACHMENT_VERSION,
    } satisfies RelayWebSocketAttachment);
  }

  private updateClientSocketAttachmentByConnectionId(
    connectionId: string,
    updates: Partial<RelayWebSocketAttachment>,
  ): void {
    for (const socket of this.state.getWebSockets?.() ?? []) {
      const attachment = this.readSocketAttachment(socket);
      if (
        attachment?.endpoint !== AcpRemoteEndpointKind.Client ||
        attachment.connectionId !== connectionId
      ) {
        continue;
      }
      this.updateSocketAttachment(socket, updates);
    }
  }

  private async readClientStateSnapshot(
    connectionId: string,
  ): Promise<AcpRelayClientStateSnapshot | undefined> {
    const storage = this.state.storage as DurableObjectStorage & {
      get?<T = unknown>(key: string): Promise<T | undefined>;
    };
    if (typeof storage.get !== "function") {
      return undefined;
    }
    const value = await storage.get(
      clientStateStorageKey(connectionId),
    );
    return isClientStateSnapshot(value, connectionId) ? value : undefined;
  }

  private async writeOrDeleteClientStateSnapshot(
    connectionId: string,
  ): Promise<void> {
    const snapshot = this.broker.clientStateSnapshot(connectionId);
    if (!snapshot) {
      await this.deleteClientStateSnapshot(connectionId);
      return;
    }
    await this.writeClientStateSnapshot(snapshot);
  }

  private async writeAllClientStateSnapshots(): Promise<void> {
    await Promise.all(
      this.broker
        .clientConnectionIds()
        .map((connectionId) =>
          this.writeOrDeleteClientStateSnapshot(connectionId),
        ),
    );
  }

  private async writeClientStateSnapshot(
    snapshot: AcpRelayClientStateSnapshot,
  ): Promise<void> {
    const storage = this.state.storage as DurableObjectStorage & {
      put?<T = unknown>(key: string, value: T): Promise<void>;
    };
    if (typeof storage.put !== "function") {
      return;
    }
    await storage.put(clientStateStorageKey(snapshot.connectionId), snapshot);
  }

  private async deleteClientStateSnapshot(connectionId: string): Promise<void> {
    const storage = this.state.storage as DurableObjectStorage & {
      delete?(key: string): Promise<boolean>;
    };
    if (typeof storage.delete !== "function") {
      return;
    }
    await storage.delete(clientStateStorageKey(connectionId));
  }

  private async authorize(request: Request, url: URL): Promise<Response> {
    const accountId = resolveVerifiedAccountId(request);
    if (!accountId) {
      return new Response("ACP relay account session is required.", {
        status: 401,
      });
    }
    const connectionId = url.searchParams.get("connectionId");
    if (!connectionId) {
      return new Response("Missing connection id.", { status: 400 });
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request);
      if (!body.ok) {
        return json({ error: body.reason }, { status: 400 });
      }
      const record = asRecord(body.value);
      if (!record) {
        return json({ error: "Request body must be an object." }, { status: 400 });
      }
      const daemonIdResult = readRequiredString(record, "daemonId");
      if (!daemonIdResult.ok) {
        return json({ error: daemonIdResult.reason }, { status: 400 });
      }
      const daemonId = daemonIdResult.value;
      const agentCommandResult = readOptionalString(record, "agentCommand");
      const agentIdResult = readOptionalString(record, "agentId");
      const agentTypeResult = readOptionalString(record, "agentType");
      const sessionSelectionIdResult = readOptionalString(
        record,
        "sessionSelectionId",
      );
      const workspaceRootsResult = readOptionalStringArray(record, "workspaceRoots");
      const agentCommand = agentCommandResult.ok ? agentCommandResult.value : undefined;
      const agentId = agentIdResult.ok ? agentIdResult.value : undefined;
      const agentType = agentTypeResult.ok ? agentTypeResult.value : undefined;
      const sessionSelectionId =
        (sessionSelectionIdResult.ok ? sessionSelectionIdResult.value : undefined) ??
        url.searchParams.get("sessionSelectionId") ??
        undefined;
      const workspaceRoots = workspaceRootsResult.ok ? workspaceRootsResult.value : undefined;
      const clientAgent = agentCommand
        ? { command: agentCommand, type: agentType ?? undefined }
        : agentId
          ? { id: agentId }
        : undefined;
      const result = await this.broker.authorizeClient({
        clientAgent,
        connectionId,
        daemonId,
        sessionSelectionId,
        workspaceRoots,
      });
      if (result.ok) {
        this.updateClientSocketAttachmentByConnectionId(connectionId, {
          bootstrapComplete: true,
          daemonId: result.daemonId,
          ticket: result.ticket,
        });
        await this.writeOrDeleteClientStateSnapshot(connectionId);
      }
      return json(result, { status: result.ok ? 200 : 404 });
    }

    const daemonId = resolveDaemonId(request, url);
    if (!daemonId) {
      const hostsResult = await this.broker.authorizableHosts(connectionId);
      return html(
        createRelayAuthorizationPage({
          accountId,
          connectionId,
          hosts: hostsResult.ok ? hostsResult.hosts : [],
          requestUrl: request.url,
          unavailableReason: hostsResult.ok ? undefined : hostsResult.reason,
        }),
        { status: hostsResult.ok ? 200 : 410 },
      );
    }

    const result = await this.broker.authorizeClient({ connectionId, daemonId });
    if (result.ok) {
      this.updateClientSocketAttachmentByConnectionId(connectionId, {
        bootstrapComplete: true,
        daemonId: result.daemonId,
        ticket: result.ticket,
      });
      await this.writeOrDeleteClientStateSnapshot(connectionId);
    }
    return html(createRelayAuthorizationResultPage(result), {
      status: result.ok ? 200 : 404,
    });
  }

  private async handleDaemonApi(_request: Request, url: URL): Promise<Response> {
    const workspaceMatch = url.pathname.match(/^\/api\/daemons\/([^/]+)\/workspaces$/);
    if (workspaceMatch) {
      const connectionId = url.searchParams.get("connectionId");
      const root = url.searchParams.get("root");
      if (!connectionId || !root) {
        return json({ ok: false, reason: "Missing connectionId or root." }, { status: 400 });
      }
      const result = await this.broker.listDaemonWorkspaceDirectory({
        connectionId,
        daemonId: decodeURIComponent(workspaceMatch[1]),
        path: url.searchParams.get("path") ?? undefined,
        root,
      });
      return json(result, { status: result.ok ? 200 : 404 });
    }

    const match = url.pathname.match(/^\/api\/daemons\/(.+)$/);
    if (!match) {
      return json({
        daemons: this.broker.onlineHostIds().map((daemonId) => ({
          daemonId,
          metadata: this.broker.getDaemonMetadata(daemonId),
        })),
      });
    }
    const daemonId = decodeURIComponent(match[1]);
    const metadata = this.broker.getDaemonMetadata(daemonId);
    if (!metadata) {
      return json({ error: "Daemon not found or has no metadata." }, { status: 404 });
    }
    return json(metadata);
  }

  private async renew(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed.", {
        headers: { allow: "POST" },
        status: 405,
      });
    }

    const parsedBody = await readJsonBody(request);
    if (!parsedBody.ok) {
      return json({ error: parsedBody.reason }, { status: 400 });
    }

    const proof = parseDeviceRenewalProof(parsedBody.value);
    if (!proof.ok) {
      return json({ error: proof.reason }, { status: 400 });
    }

    const result = await this.broker.renewClientTicketWithDeviceProof(
      proof.value,
    );
    if (result.ok) {
      this.updateClientSocketAttachmentByConnectionId(result.connectionId, {
        daemonId: result.daemonId,
        ticket: result.ticket,
      });
      await this.writeOrDeleteClientStateSnapshot(result.connectionId);
    }
    return json(result, { status: result.ok ? 200 : 401 });
  }

  private removeSocket(
    endpoint: AcpRemoteEndpointKind,
    connectionId: string,
    daemonId: string | undefined,
    socket: WebSocket,
    close?: { code?: number; final?: boolean; reason?: string },
  ): void {
    if (endpoint === AcpRemoteEndpointKind.Daemon) {
      if (daemonId) {
        this.broker.removeDaemon(daemonId, socket);
      }
      return;
    }

    this.broker.removeClient(connectionId, socket, {
      final:
        close?.final ??
        (close?.code === 1000 &&
          close.reason === "ACP client connection closed."),
    });
  }

  private async scheduleHeartbeat(): Promise<void> {
    if (
      !this.heartbeatIntervalMs ||
      (this.broker.onlineHostIds().length === 0 &&
        !this.broker.hasPendingDaemonReconnects() &&
        !this.broker.hasPendingClientReconnects())
    ) {
      return;
    }

    await this.state.storage.setAlarm(Date.now() + this.heartbeatIntervalMs);
  }

  private async reconcileAuthorizations(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed.", {
        headers: { allow: "POST" },
        status: 405,
      });
    }

    const closedConnectionIds = await this.broker.reconcileAuthorizedRoutes();
    await Promise.all(
      closedConnectionIds.map((connectionId) =>
        this.deleteClientStateSnapshot(connectionId),
      ),
    );
    return json({
      closedConnectionIds,
      ok: true,
    });
  }
}

function resolveDaemonId(request: Request, url: URL): string | undefined {
  return (
    url.searchParams.get("daemonId") ??
    request.headers.get("x-acp-daemon-id") ??
    undefined
  );
}

function resolveClientId(
  request: Request,
  url: URL,
): string | undefined {
  return (
    url.searchParams.get("clientId") ??
    request.headers.get("x-acp-client-id") ??
    request.headers.get("x-acp-verified-client-id") ??
    undefined
  );
}

function resolveAccountId(request: Request, url: URL, fallback?: string): string | undefined {
  return (
    url.searchParams.get("accountId") ??
    request.headers.get("x-acp-account-id") ??
    fallback
  );
}

async function resolveAuthenticatedAccountId(
  request: Request,
  url: URL,
  env: Env,
): Promise<string> {
  const verifiedAccountId = resolveVerifiedAccountId(request);
  if (verifiedAccountId) {
    return verifiedAccountId;
  }
  const secret = env.ACP_RELAY_ACCOUNT_SESSION_SECRET;
  const token = readAccountSessionToken(request);
  if (secret && token) {
    const verification = await verifyAcpRelayAccountSessionToken({ secret, token });
    if (verification.ok) {
      return verification.session.accountId;
    }
  }
  return resolveAccountId(request, url, "default")!;
}

function resolveRequestedAccountId(
  request: Request,
  url: URL,
): string | undefined {
  return resolveAccountId(request, url);
}

function resolveVerifiedAccountId(request: Request): string | undefined {
  return request.headers.get("x-acp-verified-account-id") ?? undefined;
}

function parseDaemonMetadataHeaders(request: Request): DaemonMetadata | undefined {
  const raw = request.headers.get("x-acp-daemon-metadata");
  if (!raw) {
    return undefined;
  }
  try {
    const value = JSON.parse(raw);
    if (!asRecord(value)) {
      return undefined;
    }
    const agentTypes = Array.isArray(value.agentTypes)
      ? value.agentTypes.filter(
          (a: unknown) =>
            asRecord(a) &&
            (typeof (a as Record<string, unknown>).command === "string" ||
              typeof (a as Record<string, unknown>).id === "string") &&
            typeof (a as Record<string, unknown>).label === "string",
        )
      : [];
    const workspaceRoots = Array.isArray(value.workspaceRoots)
      ? value.workspaceRoots.filter(
          (w: unknown) =>
            asRecord(w) && typeof (w as Record<string, unknown>).path === "string",
        )
      : [];
    const machine =
      typeof value.machine === "string" && value.machine.trim()
        ? value.machine
        : undefined;
    const runtimeInstanceId =
      typeof value.runtimeInstanceId === "string" &&
      value.runtimeInstanceId.trim()
        ? value.runtimeInstanceId
        : undefined;
    if (
      agentTypes.length === 0 &&
      workspaceRoots.length === 0 &&
      !runtimeInstanceId
    ) {
      return undefined;
    }
    return {
      agentTypes,
      ...(machine ? { machine } : {}),
      ...(runtimeInstanceId ? { runtimeInstanceId } : {}),
      workspaceRoots,
    };
  } catch {
    return undefined;
  }
}

function withVerifiedAccountSession(
  request: Request,
  session: AcpRelayAccountSession,
): Request {
  const headers = new Headers(request.headers);
  headers.set("x-acp-verified-account-id", session.accountId);
  headers.set("x-acp-account-session-id", session.sessionId);
  if (session.clientId) {
    headers.set("x-acp-verified-client-id", session.clientId);
  }
  return new Request(request, {
    headers,
  });
}

function createAuthorizationUrl(request: Request, connectionId: string): URL {
  const requestUrl = new URL(request.url);
  const authUrl = new URL("/authorize", request.url);
  const accountId =
    requestUrl.searchParams.get("accountId") ??
    request.headers.get("x-acp-account-id");
  if (accountId) {
    authUrl.searchParams.set("accountId", accountId);
  }
  authUrl.searchParams.set("connectionId", connectionId);
  return authUrl;
}

function normalizeMessageData(data: unknown): string | undefined {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  return undefined;
}

function readOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      ...init.headers,
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function html(value: string, init: ResponseInit = {}): Response {
  return new Response(value, {
    ...init,
    headers: {
      ...init.headers,
      "content-type": "text/html; charset=utf-8",
    },
  });
}

function createAuthorizationSessionFailureResponse(input: {
  env: Env;
  failure: {
    reason: string;
    status: number;
  };
  request: Request;
  url: URL;
}): Response {
  if (input.failure.status === 401 && input.env.ACP_RELAY_GITHUB_CLIENT_ID) {
    const loginUrl = new URL("/login", input.request.url);
    loginUrl.searchParams.set("returnTo", input.request.url);
    return Response.redirect(loginUrl.toString(), 302);
  }

  if (input.failure.status === 401 && input.env.ACP_RELAY_LOGIN_URL) {
    const loginUrl = new URL(input.env.ACP_RELAY_LOGIN_URL);
    loginUrl.searchParams.set("returnTo", input.request.url);
    const accountId = resolveRequestedAccountId(input.request, input.url);
    if (accountId) {
      loginUrl.searchParams.set("accountId", accountId);
    }
    return Response.redirect(loginUrl.toString(), 302);
  }

  return html(
    createRelayAccountSessionRequiredPage({
      loginUrl: input.env.ACP_RELAY_LOGIN_URL,
      reason: input.failure.reason,
      requestUrl: input.request.url,
    }),
    { status: input.failure.status },
  );
}

function createRelayAccountSessionRequiredPage(input: {
  loginUrl?: string;
  reason: string;
  requestUrl: string;
}): string {
  const loginLink = input.loginUrl
    ? `<p><a href="${escapeHtml(createLoginUrl(input.loginUrl, input.requestUrl))}">Sign in to continue</a></p>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>ACP Runtime Relay</title></head>
  <body>
    <h1>Sign in required</h1>
    <p>${escapeHtml(input.reason)}</p>
    ${loginLink}
  </body>
</html>`;
}

function createLoginUrl(loginUrl: string, returnTo: string): string {
  const url = new URL(loginUrl);
  url.searchParams.set("returnTo", returnTo);
  return url.toString();
}

const SESSION_COOKIE_NAME = "acp_relay_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

async function handleGitHubAuthRequest(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const clientId = env.ACP_RELAY_GITHUB_CLIENT_ID;
  const clientSecret = env.ACP_RELAY_GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return new Response("GitHub OAuth is not configured.", { status: 503 });
  }
  const secret = env.ACP_RELAY_ACCOUNT_SESSION_SECRET;
  if (!secret) {
    return new Response("Account session secret is not configured.", {
      status: 503,
    });
  }
  const db = env.ACP_RELAY_DB;
  if (!db) {
    return new Response("GitHub OAuth requires a database (D1).", {
      status: 503,
    });
  }

  if (url.pathname === "/login/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return new Response("Missing code or state parameter.", { status: 400 });
    }

    const returnTo = await getOAuthStateReturnTo(state, env);
    if (returnTo === undefined) {
      return new Response("Invalid or expired OAuth state.", { status: 400 });
    }

    let user;
    try {
      const accessToken = await exchangeGitHubCodeForAccessToken(
        { clientId, clientSecret },
        code,
      );
      user = await fetchGitHubUser(accessToken);
    } catch (error) {
      return new Response(
        error instanceof Error ? error.message : "GitHub OAuth failed.",
        { status: 502 },
      );
    }

    const githubStore = new D1GitHubAccountStore(db);
    const githubAccount = await resolveOrCreateGithubAccount(githubStore, user);
    const accountId = githubAccount.accountId;
    await new AcpRelayD1ControlPlaneStore(db).upsertAccount({ accountId });
    const session: AcpRelayAccountSession = {
      accountId,
      clientId: undefined,
      expiresAt: new Date(
        Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
      ).toISOString(),
      sessionId: crypto.randomUUID(),
    };
    const token = await createAcpRelayAccountSessionToken({ secret, session });

    const redirectUrl = returnTo
      ? new URL(returnTo, request.url)
      : new URL("/authorize", request.url);
    // Local daemon OAuth listeners cannot receive Secure cookies over HTTP.
    if (isLocalhostUrl(redirectUrl)) {
      redirectUrl.searchParams.set("token", token);
      redirectUrl.searchParams.set("accountId", accountId);
    }
    return new Response(null, {
      status: 302,
      headers: {
        Location: redirectUrl.toString(),
        "Set-Cookie": `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax; Secure`,
      },
    });
  }

  // GET /login
  const returnTo = url.searchParams.get("returnTo") ?? "/authorize";
  const state = crypto.randomUUID();
  const stateStore = await openOAuthStateStore(env);
  await stateStore.put(state, returnTo);

  const githubUrl = createGitHubAuthorizationUrl(
    { clientId, clientSecret },
    state,
    new URL("/login/callback", request.url).origin,
  );
  return Response.redirect(githubUrl, 302);
}

async function getOAuthStateReturnTo(
  state: string,
  env: Env,
): Promise<string | undefined> {
  const stateStore = await openOAuthStateStore(env);
  return stateStore.get(state);
}

interface OAuthStateStore {
  put(state: string, returnTo: string): Promise<void>;
  get(state: string): Promise<string | undefined>;
}

async function openOAuthStateStore(env: Env): Promise<OAuthStateStore> {
  if (env.ACP_RELAY_DB) {
    return new D1OAuthStateStore(env.ACP_RELAY_DB);
  }
  throw new Error("OAuth requires a database (D1).");
}

class D1OAuthStateStore implements OAuthStateStore {
  constructor(private readonly db: D1Database) {}

  async put(state: string, returnTo: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO acp_oauth_states (state, return_to, created_at) VALUES (?, ?, ?) ON CONFLICT(state) DO UPDATE SET return_to = ?, created_at = ?",
      )
      .bind(state, returnTo, Date.now(), returnTo, Date.now())
      .run();
  }

  async get(state: string): Promise<string | undefined> {
    const row = await this.db
      .prepare(
        "SELECT return_to FROM acp_oauth_states WHERE state = ? AND created_at > ?",
      )
      .bind(state, Date.now() - 10 * 60 * 1000)
      .first<{ return_to: string }>();
    if (row) {
      await this.db
        .prepare("DELETE FROM acp_oauth_states WHERE state = ?")
        .bind(state)
        .run();
    }
    return row?.return_to;
  }
}

async function routeDeviceRenewalRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed.", {
      headers: { allow: "POST" },
      status: 405,
    });
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return json({ error: parsedBody.reason }, { status: 400 });
  }

  const proof = parseDeviceRenewalProof(parsedBody.value);
  if (!proof.ok) {
    return json({ error: proof.reason }, { status: 400 });
  }

  const shardId = env.ACP_RELAY_SHARDS.idFromName(
    `account:${proof.value.accountId}`,
  );
  return env.ACP_RELAY_SHARDS.get(shardId).fetch(
    new Request(request.url, {
      body: JSON.stringify(proof.value),
      headers: request.headers,
      method: "POST",
    }),
  );
}

async function handleRelayLogUploadRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed.", {
      headers: { allow: "POST" },
      status: 405,
    });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_LOG_UPLOAD_BYTES) {
    return json({ error: "Log upload body is too large." }, { status: 413 });
  }

  const accountSession = await verifyAccountSessionRequest({
    env,
    request,
  });
  if (!accountSession.ok) {
    return json({ error: accountSession.reason }, {
      status: accountSession.status,
    });
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return json({ error: parsedBody.reason }, { status: 400 });
  }

  const batch = parseRelayLogUploadBatch(parsedBody.value);
  if (!batch.ok) {
    return json({ error: batch.reason }, { status: 400 });
  }

  const uploadId = crypto.randomUUID();
  const receivedAt = new Date().toISOString();
  for (const [index, record] of batch.value.records.entries()) {
    console.log(
      JSON.stringify({
        accountId: accountSession.session.accountId,
        accountSessionId: accountSession.session.sessionId,
        context: batch.value.context,
        eventName: "acp.relay.log",
        index,
        receivedAt,
        record,
        spanId: typeof record.spanId === "string" ? record.spanId : undefined,
        source: batch.value.source,
        traceId: typeof record.traceId === "string" ? record.traceId : undefined,
        uploadId,
      }),
    );
  }

  return json({
    accepted: batch.value.records.length,
    ok: true,
    uploadId,
  });
}

async function verifyAccountSessionRequest(input: {
  env: Env;
  request: Request;
  requestedAccountId?: string;
}): Promise<
  | {
      ok: true;
      session: AcpRelayAccountSession;
    }
  | {
      ok: false;
      reason: string;
      status: number;
    }
> {
  const secret = input.env.ACP_RELAY_ACCOUNT_SESSION_SECRET;
  if (!secret) {
    return {
      ok: false,
      reason: "ACP relay account session secret is not configured.",
      status: 503,
    };
  }

  const token = readAccountSessionToken(input.request);
  if (!token) {
    return {
      ok: false,
      reason: "ACP relay account session is required.",
      status: 401,
    };
  }

  const verification = await verifyAcpRelayAccountSessionToken({
    secret,
    token,
  });
  if (!verification.ok) {
    return {
      ok: false,
      reason: verification.reason,
      status: 401,
    };
  }

  if (
    input.requestedAccountId &&
    input.requestedAccountId !== verification.session.accountId
  ) {
    return {
      ok: false,
      reason: "ACP relay account session does not match requested account.",
      status: 403,
    };
  }

  return {
    ok: true,
    session: verification.session,
  };
}

function readAccountSessionToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }
  const header = request.headers.get("x-acp-account-session");
  if (header) {
    return header;
  }
  const cookie = readCookie(request.headers.get("cookie"), "acp_relay_session");
  if (cookie) {
    return cookie;
  }
  return readLocalhostQueryAccountSessionToken(request);
}

function readLocalhostQueryAccountSessionToken(
  request: Request,
): string | undefined {
  const url = new URL(request.url);
  if (!isLocalhostUrl(url)) {
    return undefined;
  }
  const token = url.searchParams.get("token");
  return token && token.trim() ? token : undefined;
}

function isLocalhostUrl(url: URL): boolean {
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1"
  );
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const [cookieName, ...valueParts] = part.trim().split("=");
    if (cookieName === name && valueParts.length > 0) {
      return valueParts.join("=");
    }
  }
  return undefined;
}

async function verifyDaemonRegistrationRequest(input: {
  accountId: string;
  env: Env;
  daemonId: string;
  request: Request;
}): Promise<
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: string;
    }
> {
  if (!input.env.ACP_RELAY_DB) {
    return { ok: false, reason: "Host registry is not configured." };
  }
  const store = new AcpRelayD1ControlPlaneStore(input.env.ACP_RELAY_DB);
  let host = await store.getHost({
    accountId: input.accountId,
    daemonId: input.daemonId,
  });
  if (!host) {
    const registration = await tryAutoRegisterDaemon({
      accountId: input.accountId,
      daemonId: input.daemonId,
      env: input.env,
      request: input.request,
      store,
    });
    if (!registration.ok) {
      return registration;
    }
    host = registration.host;
  }
  if (!host || host.disabled) {
    return { ok: false, reason: "Host is not registered for this account." };
  }

  const hostPublicKeys = [host?.publicKey, host?.previousPublicKey].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (hostPublicKeys.length === 0) {
    return {
      ok: false,
      reason: "Daemon registration proof key is not configured.",
    };
  }

  const proof = await verifyDaemonRegistrationProof({
    accountId: input.accountId,
    daemonId: input.daemonId,
    nonce: input.request.headers.get("x-acp-daemon-nonce") ?? "",
    publicKeys: hostPublicKeys,
    signature: input.request.headers.get("x-acp-daemon-signature") ?? "",
    timestamp: input.request.headers.get("x-acp-daemon-timestamp") ?? "",
  });
  if (proof.ok) {
    return proof;
  }
  const registration = await tryAutoRegisterDaemon({
    accountId: input.accountId,
    daemonId: input.daemonId,
    env: input.env,
    request: input.request,
    store,
  });
  return registration.ok ? { ok: true } : proof;
}

async function tryAutoRegisterDaemon(input: {
  accountId: string;
  daemonId: string;
  env: Env;
  request: Request;
  store: AcpRelayD1ControlPlaneStore;
}): Promise<
  | {
      ok: true;
      host: AcpRelayHostRecord;
    }
  | {
      ok: false;
      reason: string;
    }
> {
  const session = await verifyAccountSessionRequest({
    env: input.env,
    request: input.request,
    requestedAccountId: input.accountId,
  });
  if (!session.ok) {
    return {
      ok: false,
      reason: "Host is not registered for this account.",
    };
  }
  const publicKey = input.request.headers.get("x-acp-daemon-public-key");
  if (!publicKey) {
    return {
      ok: false,
      reason: "Daemon registration public key is required.",
    };
  }
  const proof = await verifyDaemonRegistrationProof({
    accountId: input.accountId,
    daemonId: input.daemonId,
    nonce: input.request.headers.get("x-acp-daemon-nonce") ?? "",
    publicKey,
    signature: input.request.headers.get("x-acp-daemon-signature") ?? "",
    timestamp: input.request.headers.get("x-acp-daemon-timestamp") ?? "",
  });
  if (!proof.ok) {
    return proof;
  }
  const host: AcpRelayHostRecord = {
    accountId: input.accountId,
    daemonId: input.daemonId,
    publicKey,
  };
  await input.store.upsertAccount({ accountId: input.accountId });
  await input.store.upsertHost(host);
  await input.store.upsertGrant({
    accountId: input.accountId,
    daemonId: input.daemonId,
    grantId: `default:${input.accountId}:${input.daemonId}`,
    policyVersion: 1,
    scopes: DEFAULT_AUTOMATIC_GRANT_SCOPES,
  });
  return { host, ok: true };
}

async function handleControlPlaneRequest(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed.", {
      headers: { allow: "POST" },
      status: 405,
    });
  }

  if (!isAuthorizedControlPlaneRequest(request, env)) {
    return json({ error: "Unauthorized." }, { status: 401 });
  }

  if (!env.ACP_RELAY_DB) {
    return json(
      { error: "Control-plane API requires ACP_RELAY_DB." },
      { status: 503 },
    );
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return json({ error: parsedBody.reason }, { status: 400 });
  }

  const store = new AcpRelayD1ControlPlaneStore(env.ACP_RELAY_DB);
  switch (url.pathname) {
    case "/control-plane/accounts": {
      const record = parseAccountRecord(parsedBody.value);
      if (!record.ok) {
        return json({ error: record.reason }, { status: 400 });
      }
      await store.upsertAccount(record.value);
      return reconcileControlPlaneMutation(request, env, record.value.accountId);
    }
    case "/control-plane/client-devices": {
      const record = parseClientDeviceRecord(parsedBody.value);
      if (!record.ok) {
        return json({ error: record.reason }, { status: 400 });
      }
      await store.upsertClientDevice(record.value);
      return reconcileControlPlaneMutation(request, env, record.value.accountId);
    }
    case "/control-plane/hosts": {
      const record = parseHostRecord(parsedBody.value);
      if (!record.ok) {
        return json({ error: record.reason }, { status: 400 });
      }
      await store.upsertHost(record.value);
      return reconcileControlPlaneMutation(request, env, record.value.accountId);
    }
    case "/control-plane/grants": {
      const record = parseGrantRecord(parsedBody.value);
      if (!record.ok) {
        return json({ error: record.reason }, { status: 400 });
      }
      await store.upsertGrant(record.value);
      return reconcileControlPlaneMutation(request, env, record.value.accountId);
    }
    default:
      return json({ error: "Unknown control-plane endpoint." }, { status: 404 });
  }
}

async function reconcileControlPlaneMutation(
  request: Request,
  env: Env,
  accountId: string,
): Promise<Response> {
  const shardId = env.ACP_RELAY_SHARDS.idFromName(`account:${accountId}`);
  const response = await env.ACP_RELAY_SHARDS.get(shardId).fetch(
    new Request(
      new URL(
        `/internal/reconcile-authorizations?accountId=${encodeURIComponent(accountId)}`,
        request.url,
      ),
      {
        headers: {
          authorization: request.headers.get("authorization") ?? "",
          "x-acp-control-plane-secret":
            request.headers.get("x-acp-control-plane-secret") ?? "",
        },
        method: "POST",
      },
    ),
  );

  if (!response.ok) {
    return json(
      { error: "Control-plane mutation applied but reconcile failed." },
      { status: 502 },
    );
  }

  const payload = (await response.json()) as {
    closedConnectionIds?: unknown;
  };
  return json({
    closedConnectionIds: Array.isArray(payload.closedConnectionIds)
      ? payload.closedConnectionIds
      : [],
    ok: true,
  });
}

function isAuthorizedControlPlaneRequest(request: Request, env: Env): boolean {
  const expected = env.ACP_RELAY_CONTROL_PLANE_SECRET;
  if (!expected) {
    return false;
  }

  const authorization = request.headers.get("authorization");
  const bearerToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  return (
    constantTimeEqual(bearerToken ?? "", expected) ||
    constantTimeEqual(
      request.headers.get("x-acp-control-plane-secret") ?? "",
      expected,
    )
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    mismatch |= leftBytes[index] ^ rightBytes[index];
  }
  return mismatch === 0;
}

async function readJsonBody(
  request: Request,
): Promise<
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      reason: string;
    }
> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, reason: "Request body must be valid JSON." };
  }
}

function parseAccountRecord(
  value: unknown,
): ParseResult<AcpRelayAccountRecord> {
  const record = asRecord(value);
  if (!record) {
    return parseError("Account registration body must be an object.");
  }

  const accountId = readRequiredString(record, "accountId");
  if (!accountId.ok) {
    return accountId;
  }

  const disabled = readOptionalBoolean(record, "disabled");
  if (!disabled.ok) {
    return disabled;
  }

  return {
    ok: true,
    value: {
      accountId: accountId.value,
      disabled: disabled.value,
    },
  };
}

function parseClientDeviceRecord(
  value: unknown,
): ParseResult<AcpRelayClientDeviceRecord> {
  const record = asRecord(value);
  if (!record) {
    return parseError("Client device registration body must be an object.");
  }

  const accountId = readRequiredString(record, "accountId");
  if (!accountId.ok) {
    return accountId;
  }

  const clientId = readRequiredString(record, "clientId");
  if (!clientId.ok) {
    return clientId;
  }

  const disabled = readOptionalBoolean(record, "disabled");
  if (!disabled.ok) {
    return disabled;
  }

  const publicKey = readRequiredString(record, "publicKey");
  if (!publicKey.ok) {
    return publicKey;
  }

  return {
    ok: true,
    value: {
      accountId: accountId.value,
      clientId: clientId.value,
      disabled: disabled.value,
      publicKey: publicKey.value,
    },
  };
}

function parseHostRecord(value: unknown): ParseResult<AcpRelayHostRecord> {
  const record = asRecord(value);
  if (!record) {
    return parseError("Host registration body must be an object.");
  }

  const accountId = readRequiredString(record, "accountId");
  if (!accountId.ok) {
    return accountId;
  }

  const daemonId = readRequiredString(record, "daemonId");
  if (!daemonId.ok) {
    return daemonId;
  }

  const disabled = readOptionalBoolean(record, "disabled");
  if (!disabled.ok) {
    return disabled;
  }

  const publicKey = readRequiredString(record, "publicKey");
  if (!publicKey.ok) {
    return publicKey;
  }

  const previousPublicKey = readOptionalString(record, "previousPublicKey");
  if (!previousPublicKey.ok) {
    return previousPublicKey;
  }

  return {
    ok: true,
    value: {
      accountId: accountId.value,
      disabled: disabled.value,
      daemonId: daemonId.value,
      previousPublicKey: previousPublicKey.value,
      publicKey: publicKey.value,
    },
  };
}

function parseGrantRecord(value: unknown): ParseResult<AcpRelayGrantRecord> {
  const record = asRecord(value);
  if (!record) {
    return parseError("Grant registration body must be an object.");
  }

  const grantId = readOptionalString(record, "grantId");
  if (!grantId.ok) {
    return grantId;
  }

  const accountId = readRequiredString(record, "accountId");
  if (!accountId.ok) {
    return accountId;
  }

  const clientId = readOptionalString(record, "clientId");
  if (!clientId.ok) {
    return clientId;
  }

  const daemonId = readRequiredString(record, "daemonId");
  if (!daemonId.ok) {
    return daemonId;
  }

  const workspaceId = readOptionalString(record, "workspaceId");
  if (!workspaceId.ok) {
    return workspaceId;
  }

  const workspaceRoots = readOptionalStringArray(record, "workspaceRoots");
  if (!workspaceRoots.ok) {
    return workspaceRoots;
  }

  const policyVersion = readRequiredPositiveInteger(record, "policyVersion");
  if (!policyVersion.ok) {
    return policyVersion;
  }

  const scopes = readScopes(record);
  if (!scopes.ok) {
    return scopes;
  }

  const revoked = readOptionalBoolean(record, "revoked");
  if (!revoked.ok) {
    return revoked;
  }

  return {
    ok: true,
    value: {
      accountId: accountId.value,
      clientId: clientId.value,
      grantId: grantId.value,
      daemonId: daemonId.value,
      policyVersion: policyVersion.value,
      revoked: revoked.value,
      scopes: scopes.value,
      workspaceId: workspaceId.value,
      workspaceRoots: workspaceRoots.value,
    },
  };
}

function parseDeviceRenewalProof(
  value: unknown,
): ParseResult<AcpRemoteSignedDeviceRenewalProof> {
  const record = asRecord(value);
  if (!record) {
    return parseError("Device renewal proof body must be an object.");
  }

  const accountId = readRequiredString(record, "accountId");
  if (!accountId.ok) {
    return accountId;
  }

  const clientId = readRequiredString(record, "clientId");
  if (!clientId.ok) {
    return clientId;
  }

  const connectionId = readRequiredString(record, "connectionId");
  if (!connectionId.ok) {
    return connectionId;
  }

  const daemonId = readRequiredString(record, "daemonId");
  if (!daemonId.ok) {
    return daemonId;
  }

  const nonce = readRequiredString(record, "nonce");
  if (!nonce.ok) {
    return nonce;
  }

  const ticketJti = readRequiredString(record, "ticketJti");
  if (!ticketJti.ok) {
    return ticketJti;
  }

  const timestamp = readRequiredString(record, "timestamp");
  if (!timestamp.ok) {
    return timestamp;
  }

  const signature = readRequiredString(record, "signature");
  if (!signature.ok) {
    return signature;
  }

  return {
    ok: true,
    value: {
      accountId: accountId.value,
      clientId: clientId.value,
      connectionId: connectionId.value,
      daemonId: daemonId.value,
      nonce: nonce.value,
      signature: signature.value,
      ticketJti: ticketJti.value,
      timestamp: timestamp.value,
    },
  };
}

type RelayLogUploadBatch = {
  context?: Record<string, unknown>;
  records: readonly Record<string, unknown>[];
  source: string;
};

function parseRelayLogUploadBatch(
  value: unknown,
): ParseResult<RelayLogUploadBatch> {
  const record = asRecord(value);
  if (!record) {
    return parseError("Log upload body must be an object.");
  }
  if (record.version !== 1) {
    return parseError("Log upload version must be 1.");
  }
  const source = readRequiredString(record, "source");
  if (!source.ok) {
    return source;
  }
  const records = record.records;
  if (!Array.isArray(records)) {
    return parseError("records must be an array.");
  }
  if (records.length > MAX_LOG_UPLOAD_RECORDS) {
    return parseError(`records must contain at most ${MAX_LOG_UPLOAD_RECORDS} entries.`);
  }
  const parsedRecords: Record<string, unknown>[] = [];
  for (const entry of records) {
    const parsed = asRecord(entry);
    if (!parsed) {
      return parseError("records entries must be objects.");
    }
    parsedRecords.push(parsed);
  }
  const context = record.context === undefined || record.context === null
    ? undefined
    : asRecord(record.context);
  if (record.context !== undefined && record.context !== null && !context) {
    return parseError("context must be an object when provided.");
  }
  return {
    ok: true,
    value: {
      context,
      records: parsedRecords,
      source: source.value,
    },
  };
}

type ParseResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      reason: string;
    };

function parseError(reason: string): ParseResult<never> {
  return { ok: false, reason };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readRequiredString(
  record: Record<string, unknown>,
  key: string,
): ParseResult<string> {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    return parseError(`${key} must be a non-empty string.`);
  }
  return { ok: true, value };
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
): ParseResult<string | undefined> {
  const value = record[key];
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string" || value.trim() === "") {
    return parseError(`${key} must be a non-empty string when provided.`);
  }
  return { ok: true, value };
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
): ParseResult<boolean | undefined> {
  const value = record[key];
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "boolean") {
    return parseError(`${key} must be a boolean when provided.`);
  }
  return { ok: true, value };
}

function readOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
): ParseResult<readonly string[] | undefined> {
  const value = record[key];
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    return parseError(`${key} must be a non-empty string array when provided.`);
  }
  return { ok: true, value };
}

function readRequiredPositiveInteger(
  record: Record<string, unknown>,
  key: string,
): ParseResult<number> {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) <= 0) {
    return parseError(`${key} must be a positive integer.`);
  }
  return { ok: true, value: value as number };
}

function readScopes(
  record: Record<string, unknown>,
): ParseResult<readonly AcpRemoteScope[]> {
  const value = record.scopes;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    return parseError("scopes must be a non-empty string array.");
  }
  return { ok: true, value: value as readonly AcpRemoteScope[] };
}

function readAttachmentString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRelayClientTransport(
  value: unknown,
): value is AcpRelayClientTransport {
  return value === "native-acp" || value === "remote-frame";
}

function isDaemonMetadata(value: unknown): value is DaemonMetadata {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.agentTypes) || !Array.isArray(record.workspaceRoots)) {
    return false;
  }
  return (
    record.agentTypes.every((entry) => {
      const agent = asRecord(entry);
      return (
        agent !== undefined &&
        typeof agent.label === "string" &&
        (agent.command === undefined || typeof agent.command === "string") &&
        (agent.id === undefined || typeof agent.id === "string") &&
        (agent.type === undefined || typeof agent.type === "string")
      );
    }) &&
    record.workspaceRoots.every((entry) => {
      const root = asRecord(entry);
      return (
        root !== undefined &&
        typeof root.path === "string" &&
        (root.label === undefined || typeof root.label === "string")
      );
    }) &&
    (record.machine === undefined || typeof record.machine === "string") &&
    (record.runtimeInstanceId === undefined ||
      typeof record.runtimeInstanceId === "string")
  );
}

function isSignedConnectionTicket(
  value: unknown,
): value is AcpRemoteSignedConnectionTicket {
  const record = asRecord(value);
  const payload = asRecord(record?.payload);
  return (
    record !== undefined &&
    typeof record.alg === "string" &&
    typeof record.kid === "string" &&
    typeof record.signature === "string" &&
    payload !== undefined &&
    typeof payload.accountId === "string" &&
    typeof payload.connectionId === "string" &&
    typeof payload.daemonId === "string" &&
    typeof payload.expiresAt === "string" &&
    typeof payload.issuedAt === "string" &&
    typeof payload.jti === "string" &&
    typeof payload.policyVersion === "number" &&
    Array.isArray(payload.scopes)
  );
}

function clientStateStorageKey(connectionId: string): string {
  return `${RELAY_CLIENT_STATE_STORAGE_PREFIX}${connectionId}`;
}

function isClientStateSnapshot(
  value: unknown,
  connectionId: string,
): value is AcpRelayClientStateSnapshot {
  const record = asRecord(value);
  if (!record || record.connectionId !== connectionId) {
    return false;
  }
  return (
    typeof record.bootstrapComplete === "boolean" &&
    Array.isArray(record.bufferedClientPayloads) &&
    record.bufferedClientPayloads.every(isDataFrame) &&
    Array.isArray(record.clientPendingFrames) &&
    record.clientPendingFrames.every(isDataFrame) &&
    Array.isArray(record.daemonPendingFrames) &&
    record.daemonPendingFrames.every(isDataFrame) &&
    Array.isArray(record.daemonQueuedFrames) &&
    record.daemonQueuedFrames.every(isDataFrame) &&
    Array.isArray(record.daemonRequests) &&
    record.daemonRequests.every(isJsonRpcRequestRecord) &&
    Number.isSafeInteger(record.seq) &&
    (record.daemonId === undefined || typeof record.daemonId === "string") &&
    (record.lastDaemonSeq === undefined ||
      Number.isSafeInteger(record.lastDaemonSeq)) &&
    (record.ticket === undefined || isSignedConnectionTicket(record.ticket)) &&
    (record.lastAuthorization === undefined ||
      isRelayAuthorizationSelection(record.lastAuthorization))
  );
}

function isDataFrame(value: unknown): value is AcpRemoteDataFrame {
  const record = asRecord(value);
  return (
    record !== undefined &&
    record.frameType === AcpRemoteFrameType.Data &&
    typeof record.connectionId === "string" &&
    typeof record.channelId === "string" &&
    Object.values(AcpRemoteChannelKind).includes(
      record.channelKind as AcpRemoteChannelKind,
    ) &&
    Number.isSafeInteger(record.seq)
  );
}

function isJsonRpcRequestRecord(value: unknown): boolean {
  const record = asRecord(value);
  return (
    record !== undefined &&
    record.jsonrpc === "2.0" &&
    typeof record.method === "string" &&
    (typeof record.id === "string" || typeof record.id === "number")
  );
}

function isRelayAuthorizationSelection(value: unknown): boolean {
  const record = asRecord(value);
  return (
    record !== undefined &&
    typeof record.daemonId === "string" &&
    (record.workspaceRoots === undefined ||
      (Array.isArray(record.workspaceRoots) &&
        record.workspaceRoots.every((entry) => typeof entry === "string"))) &&
    (record.agent === undefined || asRecord(record.agent) !== undefined)
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
