import {
  ACP_REMOTE_PROTOCOL_VERSION,
  AcpRemoteChannelKind,
  AcpRemoteEndpointKind,
  AcpRemoteFrameType,
  assertAcpRemoteFrame,
  createAcpRemoteSignedConnectionTicket,
  verifyAcpRemoteDeviceRenewalProof,
  type AcpRemoteAckFrame,
  type AcpRemoteAgentGrant,
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
  type AcpRelayWritableControlPlaneStore,
} from "./control-plane-store.js";
import {
  readAcpRemoteTraceContextFromJsonRpcMessage,
  type AcpRemoteTraceContext,
} from "../../../src/runtime/remote/shared/trace-context.js";

export type RelaySocket = {
  close(code?: number, reason?: string): void;
  send(data: string): void;
};

export type AcpRelayBrokerOptions = {
  authWaitMs?: number;
  clientReconnectGraceMs?: number;
  controlPlaneStore?: AcpRelayWritableControlPlaneStore;
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
  onClientRouteAuthorized?: (input: {
    connectionId: string;
    daemonId: string;
    ticket: AcpRemoteSignedConnectionTicket;
  }) => void;
};

export type AcpRelayClientTransport = "native-acp" | "remote-frame";

export type DaemonMetadata = {
  agentTypes: readonly {
    command?: string;
    id?: string;
    type?: string;
    label: string;
  }[];
  machine?: string;
  runtimeInstanceId?: string;
  workspaceRoots: readonly { path: string; label?: string }[];
};

export type AcpRelayClientRegistration = {
  accountId: string;
  authUrl: string;
  bootstrapComplete?: boolean;
  clientId?: string;
  connectionId: string;
  daemonId?: string;
  nativeClientAck?: boolean;
  restoredHibernatedSocket?: boolean;
  socket: RelaySocket;
  stateSnapshot?: AcpRelayClientStateSnapshot;
  ticket?: AcpRemoteSignedConnectionTicket;
  transport?: AcpRelayClientTransport;
};

export type AcpRelayClientStateSnapshot = {
  bootstrapComplete: boolean;
  bufferedClientPayloads: readonly AcpRemoteDataFrame[];
  clientPendingFrames: readonly AcpRemoteDataFrame[];
  completedClientResponses?: readonly RelayJsonRpcResponse[];
  connectionId: string;
  daemonId?: string;
  daemonPendingFrames: readonly AcpRemoteDataFrame[];
  daemonQueuedFrames: readonly AcpRemoteDataFrame[];
  daemonRequests: readonly RelayJsonRpcRequest[];
  daemonRuntimeInstanceId?: string;
  initializeParams?: unknown;
  lastAuthorization?: RelayAuthorizationSelection;
  lastDaemonSeq?: number;
  seq: number;
  sessionControlRequests?: readonly RelayJsonRpcRequest[];
  ticket?: AcpRemoteSignedConnectionTicket;
};

export type AcpRelayAuthorizationResult =
  | {
      ok: true;
      connectionId: string;
      daemonId: string;
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
      daemonId: string;
      ticket: AcpRemoteSignedConnectionTicket;
    }
  | {
      ok: false;
      reason: string;
    };

const ACP_BOOTSTRAP_AUTH_METHOD_ID = "acp-runtime-browser";
const ACP_REMOTE_CONNECTION_ID_META = "acp-runtime/remote/connectionId";
const ACP_REMOTE_DAEMON_ID_META = "acp-runtime/remote/daemonId";
const ACP_REMOTE_AUTH_URL_META = "acp-runtime/remote/authUrl";
const ACP_REMOTE_SESSION_SELECTION_ID_META =
  "acp-runtime/remote/sessionSelectionId";
const DEFAULT_SESSION_SELECTION_ID = "__default__";
const DEFAULT_CLIENT_ID = "native-acp-client";
const DEFAULT_AUTH_WAIT_MS = 5 * 60 * 1000;
const DEFAULT_RECONNECT_GRACE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLIENT_RECONNECT_GRACE_MS = DEFAULT_RECONNECT_GRACE_MS;
const DEFAULT_DAEMON_RECONNECT_GRACE_MS = DEFAULT_RECONNECT_GRACE_MS;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45 * 1000;
const DEFAULT_MAX_BUFFERED_FRAMES_PER_CONNECTION = 64;
const DEFAULT_COMPLETED_RESPONSE_CACHE_LIMIT = 256;
const DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT = 64;
const DEFAULT_POLICY_VERSION = 1;
const DEFAULT_TICKET_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TICKET_RENEW_BEFORE_MS = 5 * 60 * 1000;
const NATIVE_CLIENT_ACK_METHOD = "acp-runtime/remote/client_ack";
const NATIVE_CLIENT_ACK_SEQ_META = "acp-runtime/remote/clientAckSeq";
const DEFAULT_TICKET_SCOPES = [
  "acp:connect",
  "acp:session:create",
  "acp:session:list",
  "acp:session:resume",
  "acp:turn:send",
  "acp:turn:cancel",
] as const satisfies readonly AcpRemoteScope[];
const DEFAULT_AGENT_ID = "codex-acp";

type RelayClient = {
  accountId: string;
  authUrl: string;
  bootstrapComplete: boolean;
  bufferedClientPayloads: AcpRemoteDataFrame[];
  clientId: string;
  clientPendingFrames: Map<number, AcpRemoteDataFrame>;
  completedClientResponses: Map<string | number, RelayJsonRpcResponse>;
  daemonBootstrapRequestIds: Set<string>;
  daemonQueuedFrames: AcpRemoteDataFrame[];
  daemonPendingFrames: Map<number, AcpRemoteDataFrame>;
  disconnectedAtMs?: number;
  daemonId?: string;
  daemonRuntimeInstanceId?: string;
  initializeParams?: unknown;
  daemonRequests: Map<string | number, RelayJsonRpcRequest>;
  lastDaemonSeq?: number;
  nativeClientAck: boolean;
  seq: number;
  sessionControlRequests: Map<string, RelayJsonRpcRequest>;
  socket?: RelaySocket;
  ticket?: AcpRemoteSignedConnectionTicket;
  transport: AcpRelayClientTransport;
  lastAuthorization?: RelayAuthorizationSelection;
  pendingSessionSelections: Map<string, RelayAuthorizationSelection>;
  sessionSelectionWaiters: Map<
    string,
    (selection: RelayAuthorizationSelection | undefined) => void
  >;
  waiters: Set<(daemonId: string | undefined) => void>;
};

type ConnectedRelayClient = RelayClient & {
  socket: RelaySocket;
};

type BoundClientRevalidationResult =
  | {
      ok: true;
    }
  | {
      closeRoute: boolean;
      ok: false;
      reason: string;
      requiredScope?: AcpRemoteScope;
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

type RelayJsonRpcResponse = {
  error?: unknown;
  id: string | number | null;
  jsonrpc: "2.0";
  result?: unknown;
};

type RelayJsonRpcMessage =
  | RelayJsonRpcNotification
  | RelayJsonRpcRequest
  | RelayJsonRpcResponse;

type DaemonHeartbeatState = {
  lastPongAt?: string;
  pendingNonce?: string;
  pingedAtMs?: number;
};

type DaemonReconnectState = {
  disconnectedAtMs: number;
};

type DaemonRouteState = {
  daemon?: RelaySocket;
  metadata?: DaemonMetadata;
  pendingReconnect: boolean;
};

export type DaemonWorkspaceEntry = {
  name: string;
  path: string;
  type: "directory";
};

export type DaemonWorkspaceListResult =
  | {
      ok: true;
      path: string;
      entries: readonly DaemonWorkspaceEntry[];
    }
  | {
      ok: false;
      reason: string;
    };

export type AcpRelayAuthorizableHostsResult =
  | {
      ok: true;
      hosts: { daemonId: string; metadata?: DaemonMetadata }[];
    }
  | {
      ok: false;
      reason: string;
    };

type DaemonWorkspaceListRequestPayload = {
  kind: "workspace/list";
  path?: string;
  requestId: string;
  root: string;
};

type PendingDaemonWorkspaceListRequest = {
  reject(error: Error): void;
  resolve(result: DaemonWorkspaceListResult): void;
  timeout: ReturnType<typeof setTimeout>;
};

const WORKSPACE_LIST_TIMEOUT_MS = 5 * 1000;
const REMOTE_SESSION_AGENT_META = "acp-runtime/remote/sessionAgent";
const REMOTE_SESSION_WORKSPACE_ROOTS_META =
  "acp-runtime/remote/sessionWorkspaceRoots";

type RelayAuthorizationSelection = {
  agent?: AcpRemoteAgentGrant;
  daemonId: string;
  workspaceRoots?: readonly string[];
};

function hasSessionSelection(input: {
  clientAgent?: AcpRemoteAgentGrant;
  workspaceRoots?: readonly string[];
}): boolean {
  return Boolean(input.clientAgent || input.workspaceRoots?.length);
}

function validateAuthorizationSelection(input: {
  agent?: AcpRemoteAgentGrant;
  grant: AcpRemoteGrant;
  metadata?: DaemonMetadata;
  requireAdvertisedSelection?: boolean;
  workspaceRoots?: readonly string[];
}): { ok: true } | { ok: false; reason: string } {
  const requireAdvertisedSelection = input.requireAdvertisedSelection ?? true;
  if (
    requireAdvertisedSelection &&
    input.agent &&
    !isAdvertisedAgent(input.agent, input.metadata)
  ) {
    return {
      ok: false,
      reason: "Selected agent is not advertised by this daemon.",
    };
  }
  if (input.workspaceRoots?.length) {
    if (
      requireAdvertisedSelection &&
      !input.metadata?.workspaceRoots.length
    ) {
      return {
        ok: false,
        reason: "Selected workspace is not advertised by this daemon.",
      };
    }
    for (const workspaceRoot of input.workspaceRoots) {
      if (
        requireAdvertisedSelection &&
        input.metadata &&
        !isWithinAnyPath(workspaceRoot, input.metadata.workspaceRoots.map((root) => root.path))
      ) {
        return {
          ok: false,
          reason: "Selected workspace is not advertised by this daemon.",
        };
      }
      if (
        input.grant.workspaceRoots?.length &&
        !isWithinAnyPath(workspaceRoot, input.grant.workspaceRoots)
      ) {
        return {
          ok: false,
          reason: "Selected workspace is outside the granted workspace roots.",
        };
      }
    }
  }
  return { ok: true };
}

function isAdvertisedAgent(
  agent: AcpRemoteAgentGrant,
  metadata: DaemonMetadata | undefined,
): boolean {
  if (!metadata?.agentTypes.length) {
    return false;
  }
  return metadata.agentTypes.some((advertised) => {
    if ("id" in agent) {
      return advertised.id === agent.id;
    }
    return (
      advertised.command === agent.command &&
      (agent.type === undefined || advertised.type === agent.type)
    );
  });
}

function isWithinAnyPath(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => normalizedPathContains(root, path));
}

function normalizedPathContains(root: string, candidate: string): boolean {
  const normalizedRoot = normalizePathForContainment(root);
  const normalizedCandidate = normalizePathForContainment(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

function normalizePathForContainment(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const normalized = `${absolute ? "/" : ""}${parts.join("/")}`;
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

export class AcpRelayBroker {
  private readonly authWaitMs: number;
  private readonly clientReconnectGraceMs: number;
  private readonly clientBootstrapQueues = new Map<string, Promise<void>>();
  private readonly clients = new Map<string, RelayClient>();
  private readonly controlPlaneStore: AcpRelayWritableControlPlaneStore;
  private readonly daemonHeartbeats = new Map<string, DaemonHeartbeatState>();
  private readonly daemonReconnects = new Map<string, DaemonReconnectState>();
  private readonly daemons = new Map<string, RelaySocket>();
  private readonly daemonMetadataMap = new Map<string, DaemonMetadata>();
  private readonly daemonReconnectGraceMs: number;
  private readonly daemonWorkspaceListRequests =
    new Map<string, PendingDaemonWorkspaceListRequest>();
  private readonly defaultScopes: readonly AcpRemoteScope[];
  private readonly heartbeatTimeoutMs: number;
  private readonly maxBufferedFramesPerConnection: number;
  private readonly maxConnectionsPerAccount: number;
  private readonly now: () => Date;
  private readonly policyVersion: number;
  private readonly ticketRenewBeforeMs: number;
  readonly ticketSigningKey: AcpRemoteTicketSigningKey | undefined;
  private readonly ticketTtlMs: number | undefined;
  private readonly onClientRouteAuthorized:
    | ((input: {
        connectionId: string;
        daemonId: string;
        ticket: AcpRemoteSignedConnectionTicket;
      }) => void)
    | undefined;

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
    this.ticketTtlMs = options.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS;
    this.onClientRouteAuthorized = options.onClientRouteAuthorized;
  }

  async registerDaemon(
    daemonId: string,
    socket: RelaySocket,
    metadata?: DaemonMetadata,
  ): Promise<void> {
    const previousSocket = this.daemons.get(daemonId);
    this.daemons.set(daemonId, socket);
    this.daemonReconnects.delete(daemonId);
    if (metadata) {
      this.daemonMetadataMap.set(daemonId, metadata);
    }
    this.daemonHeartbeats.set(daemonId, {
      lastPongAt: this.now().toISOString(),
    });
    previousSocket?.close(1012, "Daemon connection replaced.");
    this.logRelayLifecycle({
      daemonId,
      eventName: "acp.relay.daemon.connected",
      replaced: previousSocket !== undefined,
    });
    if (metadata?.runtimeInstanceId) {
      this.resolveAckedDaemonRequestsAfterRuntimeRestart(
        daemonId,
        socket,
        metadata.runtimeInstanceId,
      );
    }
    try {
      await this.reopenClientRoutesForDaemon(daemonId, socket);
    } catch (error) {
      console.error("Failed to reopen ACP relay client routes", error);
    }
  }

  registerClient(input: AcpRelayClientRegistration): void {
    const clientId = input.clientId ?? DEFAULT_CLIENT_ID;
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
      this.canResumeClient(input, existing, clientId, transport)
    ) {
      const previousSocket = existing.socket;
      existing.authUrl = input.authUrl;
      existing.disconnectedAtMs = undefined;
      existing.socket = input.socket;
      this.logRelayLifecycle({
        accountId: existing.accountId,
        bufferedClientPayloads: existing.bufferedClientPayloads.length,
        clientId: existing.clientId,
        connectionId: input.connectionId,
        daemonId: existing.daemonId,
        eventName: "acp.relay.client.resumed",
        nativeClientAck: existing.nativeClientAck,
        pendingClientFrames: existing.clientPendingFrames.size,
        pendingDaemonFrames: existing.daemonPendingFrames.size,
        transport: existing.transport,
      });
      if (isConnectedClient(existing)) {
        this.replayPendingClientFrames(existing);
        this.flushBufferedClientPayloads(existing, input.connectionId);
      }
      previousSocket?.close(1012, "Client connection replaced.");
      return;
    }

    if (existing) {
      this.clients.delete(input.connectionId);
      this.clientBootstrapQueues.delete(input.connectionId);
      this.clearDaemonJsonRpcRequests(existing);
      this.clearClientSelectionState(existing);
      this.sendDaemonClientClose(
        input.connectionId,
        existing,
        "client_replaced",
        "Native ACP client connection replaced.",
      );
      existing.socket?.close(1012, "Client connection replaced.");
    }

    const daemonId = input.daemonId;
    const snapshot =
      input.stateSnapshot?.connectionId === input.connectionId
        ? input.stateSnapshot
        : undefined;
    const lastAuthorization =
      snapshot?.lastAuthorization ??
      (input.ticket && input.daemonId
        ? {
            agent: input.ticket.payload.agent,
            daemonId: input.daemonId,
            workspaceRoots: input.ticket.payload.workspaceRoots,
          }
        : undefined);
    this.clients.set(input.connectionId, {
      accountId: input.accountId,
      authUrl: input.authUrl,
      bootstrapComplete:
        input.bootstrapComplete ?? snapshot?.bootstrapComplete ?? false,
      bufferedClientPayloads: [...(snapshot?.bufferedClientPayloads ?? [])],
      clientId,
      clientPendingFrames: framesToSeqMap(snapshot?.clientPendingFrames),
      completedClientResponses: responsesToIdMap(
        snapshot?.completedClientResponses,
      ),
      daemonBootstrapRequestIds: new Set(),
      daemonQueuedFrames: [...(snapshot?.daemonQueuedFrames ?? [])],
      daemonPendingFrames: framesToSeqMap(snapshot?.daemonPendingFrames),
      daemonRequests: requestsToIdMap(snapshot?.daemonRequests),
      daemonId: daemonId ?? snapshot?.daemonId,
      daemonRuntimeInstanceId: snapshot?.daemonRuntimeInstanceId,
      initializeParams: snapshot?.initializeParams,
      lastAuthorization,
      lastDaemonSeq: snapshot?.lastDaemonSeq,
      nativeClientAck: input.nativeClientAck ?? false,
      seq: snapshot?.seq ?? 0,
      sessionControlRequests: sessionControlRequestsToKeyMap(
        snapshot?.sessionControlRequests,
      ),
      socket: input.socket,
      ticket: input.ticket ?? snapshot?.ticket,
      pendingSessionSelections: new Map(),
      sessionSelectionWaiters: new Map(),
      waiters: new Set(),
      transport,
    });
    this.logRelayLifecycle({
      accountId: input.accountId,
      clientId,
      connectionId: input.connectionId,
      daemonId,
      eventName: "acp.relay.client.connected",
      nativeClientAck: input.nativeClientAck ?? false,
      transport,
    });
    const registered = this.clients.get(input.connectionId);
    if (registered && snapshot) {
      if (isConnectedClient(registered)) {
        if (!input.restoredHibernatedSocket) {
          this.replayPendingClientFrames(registered);
        }
        this.flushBufferedClientPayloads(registered, input.connectionId);
      }
      this.flushQueuedDaemonFrames(registered);
    }

    if (
      daemonId &&
      !this.isDaemonRouteAvailable(daemonId, { allowPendingReconnect: true }) &&
      transport === "remote-frame"
    ) {
      input.socket.close(1013, "No daemon is online for this host.");
    }
  }

  clientConnectionIds(): string[] {
    return [...this.clients.keys()].sort();
  }

  clientStateSnapshot(
    connectionId: string,
  ): AcpRelayClientStateSnapshot | undefined {
    const client = this.clients.get(connectionId);
    if (!client) {
      return undefined;
    }
    return createClientStateSnapshot(connectionId, client);
  }

  removeDaemon(daemonId: string, socket: RelaySocket): void {
    if (this.daemons.get(daemonId) === socket) {
      this.logRelayLifecycle({
        daemonId,
        eventName: "acp.relay.daemon.disconnected",
        pendingReconnect: this.daemonReconnectGraceMs > 0,
        severityText: "ERROR",
      });
      this.daemons.delete(daemonId);
      this.daemonHeartbeats.delete(daemonId);
      this.rejectDaemonWorkspaceListRequests(
        daemonId,
        "Host daemon disconnected.",
      );
      this.markDaemonDisconnected(daemonId, "Host daemon disconnected.");
    }
  }

  removeClient(
    connectionId: string,
    socket: RelaySocket,
    options: { final?: boolean } = {},
  ): void {
    const client = this.clients.get(connectionId);
    if (!client || client.socket !== socket) {
      return;
    }

    if (!options.final && this.shouldKeepDisconnectedClient(client)) {
      client.disconnectedAtMs = this.now().getTime();
      client.socket = undefined;
      this.logRelayLifecycle({
        accountId: client.accountId,
        bufferedClientPayloads: client.bufferedClientPayloads.length,
        clientId: client.clientId,
        connectionId,
        daemonId: client.daemonId,
        eventName: "acp.relay.client.disconnected",
        nativeClientAck: client.nativeClientAck,
        pendingClientFrames: client.clientPendingFrames.size,
        pendingDaemonFrames: client.daemonPendingFrames.size,
        transport: client.transport,
      });
      return;
    }

    this.logRelayLifecycle({
      accountId: client.accountId,
      clientId: client.clientId,
      connectionId,
      daemonId: client.daemonId,
      eventName: "acp.relay.client.closed",
      transport: client.transport,
    });
    this.clients.delete(connectionId);
    this.clientBootstrapQueues.delete(connectionId);
    this.clearDaemonJsonRpcRequests(client);
    this.clearClientSelectionState(client);
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
      this.clientBootstrapQueues.delete(connectionId);
      this.clearDaemonJsonRpcRequests(client);
      this.clearClientSelectionState(client);
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
    const expiredDaemonIds: string[] = [];
    const nowMs = this.now().getTime();
    for (const [daemonId, reconnect] of this.daemonReconnects.entries()) {
      if (nowMs - reconnect.disconnectedAtMs < this.daemonReconnectGraceMs) {
        continue;
      }

      this.daemonReconnects.delete(daemonId);
      this.daemonMetadataMap.delete(daemonId);
      this.closeClientsForHost(
        daemonId,
        1013,
        "Host daemon reconnect grace expired.",
      );
      expiredDaemonIds.push(daemonId);
    }
    return expiredDaemonIds.sort();
  }

  async reconcileAuthorizedRoutes(): Promise<string[]> {
    const closedConnectionIds: string[] = [];
    for (const [connectionId, client] of this.clients.entries()) {
      if (!client.bootstrapComplete || !client.daemonId || !client.ticket) {
        continue;
      }

      const decision = await this.controlPlaneStore.resolveGrant({
        accountId: client.accountId,
        clientId: client.clientId,
        daemonId: client.daemonId,
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

  getDaemonMetadata(daemonId: string): DaemonMetadata | undefined {
    return this.daemonMetadataMap.get(daemonId);
  }

  private daemonRouteState(daemonId: string): DaemonRouteState {
    return {
      daemon: this.daemons.get(daemonId),
      metadata: this.daemonMetadataMap.get(daemonId),
      pendingReconnect: this.daemonReconnects.has(daemonId),
    };
  }

  private isDaemonRouteAvailable(
    daemonId: string,
    options: { allowPendingReconnect?: boolean } = {},
  ): boolean {
    const route = this.daemonRouteState(daemonId);
    return Boolean(
      route.daemon || (options.allowPendingReconnect && route.pendingReconnect),
    );
  }

  async listDaemonWorkspaceDirectory(input: {
    connectionId: string;
    daemonId: string;
    path?: string;
    root: string;
  }): Promise<DaemonWorkspaceListResult> {
    const route = this.daemonRouteState(input.daemonId);
    const daemon = route.daemon;
    if (!daemon) {
      return { ok: false, reason: "Host daemon is not online." };
    }
    const hosts = await this.authorizableHosts(input.connectionId);
    if (!hosts.ok || !hosts.hosts.some((host) => host.daemonId === input.daemonId)) {
      return { ok: false, reason: "Host daemon is not authorized for this connection." };
    }
    const metadata = route.metadata;
    const allowedRoot = metadata?.workspaceRoots.some(
      (workspaceRoot) => workspaceRoot.path === input.root,
    );
    if (!allowedRoot) {
      return { ok: false, reason: "Workspace root is not available for this daemon." };
    }

    const requestId = crypto.randomUUID();
    const connectionId = `workspace-list:${input.daemonId}:${requestId}`;
    const payload: DaemonWorkspaceListRequestPayload = {
      kind: "workspace/list",
      path: input.path,
      requestId,
      root: input.root,
    };

    const result = new Promise<DaemonWorkspaceListResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.daemonWorkspaceListRequests.delete(connectionId);
        resolve({ ok: false, reason: "Workspace directory listing timed out." });
      }, WORKSPACE_LIST_TIMEOUT_MS);
      this.daemonWorkspaceListRequests.set(connectionId, {
        reject,
        resolve,
        timeout,
      });
    });

    daemon.send(
      JSON.stringify({
        channelId: "workspace",
        channelKind: AcpRemoteChannelKind.Filesystem,
        connectionId,
        frameType: AcpRemoteFrameType.Data,
        payload,
        seq: 1,
      } satisfies AcpRemoteDataFrame),
    );
    return result;
  }

  async authorizableHosts(
    connectionId: string,
  ): Promise<AcpRelayAuthorizableHostsResult> {
    const client = this.clients.get(connectionId);
    if (!client) {
      return {
        ok: false,
        reason: "Client connection is no longer active. Restart the remote session from the ACP client.",
      };
    }
    const onlineHosts = new Set(this.onlineHostIds());
    const hosts = await this.controlPlaneStore.listAuthorizableHosts({
      accountId: client.accountId,
      clientId: client.clientId,
    });
    return {
      hosts: hosts
        .filter((host) => onlineHosts.has(host.daemonId))
        .map((host) => ({
          daemonId: host.daemonId,
          metadata: this.daemonMetadataMap.get(host.daemonId),
        }))
        .sort((a, b) => a.daemonId.localeCompare(b.daemonId)),
      ok: true,
    };
  }

  pingDaemons(): void {
    for (const [daemonId, socket] of this.daemons.entries()) {
      const nonce = crypto.randomUUID();
      const frame: AcpRemotePingFrame = {
        connectionId: daemonHeartbeatConnectionId(daemonId),
        frameType: AcpRemoteFrameType.Ping,
        nonce,
      };
      this.daemonHeartbeats.set(daemonId, {
        lastPongAt: this.daemonHeartbeats.get(daemonId)?.lastPongAt,
        pendingNonce: nonce,
        pingedAtMs: this.now().getTime(),
      });
      socket.send(JSON.stringify(frame));
    }
  }

  closeUnresponsiveDaemons(): string[] {
    const closedDaemonIds: string[] = [];
    const nowMs = this.now().getTime();
    for (const [daemonId, heartbeat] of this.daemonHeartbeats.entries()) {
      if (
        heartbeat.pendingNonce === undefined ||
        heartbeat.pingedAtMs === undefined ||
        nowMs - heartbeat.pingedAtMs < this.heartbeatTimeoutMs
      ) {
        continue;
      }

      const daemon = this.daemons.get(daemonId);
      daemon?.close(1011, "Host daemon heartbeat timed out.");
      this.daemons.delete(daemonId);
      this.daemonHeartbeats.delete(daemonId);
      this.markDaemonDisconnected(daemonId, "Host daemon heartbeat timed out.");
      closedDaemonIds.push(daemonId);
    }
    return closedDaemonIds;
  }

  daemonHeartbeatStatus(daemonId: string): DaemonHeartbeatState | undefined {
    const heartbeat = this.daemonHeartbeats.get(daemonId);
    return heartbeat ? { ...heartbeat } : undefined;
  }

  async authorizableHostIds(connectionId: string): Promise<string[]> {
    const result = await this.authorizableHosts(connectionId);
    if (!result.ok) {
      return [];
    }
    return result.hosts.map((host) => host.daemonId);
  }

  private async ensureClientDeviceRegistered(client: RelayClient): Promise<void> {
    const [account, device] = await Promise.all([
      this.controlPlaneStore.getAccount(client.accountId),
      this.controlPlaneStore.getClientDevice({
        accountId: client.accountId,
        clientId: client.clientId,
      }),
    ]);
    if (!account) {
      await this.controlPlaneStore.upsertAccount({ accountId: client.accountId });
    }
    if (!device) {
      await this.controlPlaneStore.upsertClientDevice({
        accountId: client.accountId,
        clientId: client.clientId,
      });
    }
  }

  async authorizeClient(input: {
    allowPendingDaemonReconnect?: boolean;
    clientAgent?: AcpRemoteAgentGrant;
    connectionId: string;
    daemonId: string;
    sessionSelectionId?: string;
    workspaceRoots?: readonly string[];
  }): Promise<AcpRelayAuthorizationResult> {
    const client = this.clients.get(input.connectionId);
    if (!client) {
      return { ok: false, reason: "Unknown ACP connection." };
    }
    let route = this.daemonRouteState(input.daemonId);
    if (!route.daemon && !input.allowPendingDaemonReconnect) {
      return { ok: false, reason: "Host daemon is not online." };
    }
    if (!this.ticketSigningKey) {
      return { ok: false, reason: "Relay ticket signing key is not configured." };
    }
    await this.ensureClientDeviceRegistered(client);

    const grantDecision = await this.controlPlaneStore.resolveGrant({
      accountId: client.accountId,
      clientId: client.clientId,
      daemonId: input.daemonId,
      requiredScopes: ["acp:connect"],
    });
    if (!grantDecision.ok) {
      return grantDecision;
    }

    const shouldRestoreOfflineRoute =
      input.allowPendingDaemonReconnect && !route.daemon && !route.pendingReconnect;
    const selectionValidation = validateAuthorizationSelection({
      agent: input.clientAgent,
      grant: grantDecision.grant,
      metadata: route.metadata,
      requireAdvertisedSelection:
        !shouldRestoreOfflineRoute || route.metadata !== undefined,
      workspaceRoots: input.workspaceRoots,
    });
    if (!selectionValidation.ok) {
      return selectionValidation;
    }
    if (shouldRestoreOfflineRoute) {
      this.markDaemonDisconnected(
        input.daemonId,
        "Host daemon is not online.",
      );
      route = this.daemonRouteState(input.daemonId);
    }

    const grant: AcpRemoteGrant = {
      ...grantDecision.grant,
      ...(input.clientAgent && { agent: input.clientAgent }),
      ...(input.workspaceRoots && { workspaceRoots: input.workspaceRoots }),
    };
    const ticket = await this.createSignedTicket(
      input.connectionId,
      grant,
    );
    const wasBootstrapComplete = client.bootstrapComplete;
    const daemon = route.daemon;
    client.daemonId = input.daemonId;
    client.daemonRuntimeInstanceId =
      route.metadata?.runtimeInstanceId ??
      client.daemonRuntimeInstanceId;
    client.lastAuthorization = {
      agent: input.clientAgent,
      daemonId: input.daemonId,
      workspaceRoots: input.workspaceRoots,
    };
    client.ticket = ticket;
    this.onClientRouteAuthorized?.({
      connectionId: input.connectionId,
      daemonId: input.daemonId,
      ticket,
    });
    if (client.transport === "remote-frame") {
      client.bootstrapComplete = true;
    }
    if (daemon && !wasBootstrapComplete) {
      this.sendDaemonClientHello(input.connectionId, client, daemon);
      this.sendDaemonBootstrapInitialize(input.connectionId, client, daemon);
    } else if (daemon) {
      daemon.send(
        JSON.stringify({
          connectionId: input.connectionId,
          frameType: AcpRemoteFrameType.Renew,
          ticket,
        }),
      );
    }
    for (const waiter of client.waiters) {
      waiter(input.daemonId);
    }
    client.waiters.clear();
    const sessionSelectionId = normalizeSessionSelectionId(
      input.sessionSelectionId,
    );
    if (wasBootstrapComplete) {
      const waiter =
        client.sessionSelectionWaiters.get(sessionSelectionId) ??
        (!input.sessionSelectionId && client.sessionSelectionWaiters.size === 1
          ? client.sessionSelectionWaiters.values().next().value
          : undefined);
      if (waiter) {
        for (const [waiterId, candidate] of client.sessionSelectionWaiters) {
          if (candidate === waiter) {
            client.sessionSelectionWaiters.delete(waiterId);
            break;
          }
        }
        waiter(client.lastAuthorization);
      } else if (hasSessionSelection(input)) {
        client.pendingSessionSelections.set(
          sessionSelectionId,
          client.lastAuthorization,
        );
      }
    } else if (hasSessionSelection(input)) {
      client.pendingSessionSelections.set(
        sessionSelectionId,
        client.lastAuthorization,
      );
    }
    return {
      connectionId: input.connectionId,
      daemonId: input.daemonId,
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
    if (!client.daemonId || !client.ticket) {
      return { ok: false, reason: "ACP remote connection is not authorized." };
    }
    if (client.accountId !== proof.accountId) {
      return { ok: false, reason: "ACP remote account mismatch." };
    }
    if (client.clientId !== proof.clientId) {
      return { ok: false, reason: "ACP remote client device mismatch." };
    }
    if (client.daemonId !== proof.daemonId) {
      return { ok: false, reason: "ACP remote host mismatch." };
    }
    if (client.ticket.payload.jti !== proof.ticketJti) {
      return { ok: false, reason: "ACP remote ticket mismatch." };
    }
    const daemon = this.daemonRouteState(client.daemonId).daemon;
    if (!daemon) {
      return { ok: false, reason: "Host daemon is not online." };
    }
    if (!this.ticketSigningKey) {
      return { ok: false, reason: "Relay ticket signing key is not configured." };
    }

    const device = await this.controlPlaneStore.getClientDevice({
      accountId: client.accountId,
      clientId: client.clientId,
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
      clientId: client.clientId,
      daemonId: client.daemonId,
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

    const renewal = await this.renewBoundClientTicket(
      proof.connectionId,
      client,
      daemon,
      decision.grant,
    );
    if (!renewal.ok) {
      if (renewal.closeRoute) {
        this.revokeClientRoute(
          proof.connectionId,
          client,
          "authorization_revoked",
          renewal.reason,
        );
      }
      return { ok: false, reason: renewal.reason };
    }
    return {
      connectionId: proof.connectionId,
      daemonId: client.daemonId,
      ok: true,
      ticket: renewal.ticket,
    };
  }

  async handleClientText(connectionId: string, text: string): Promise<void> {
    const client = this.clients.get(connectionId);
    if (!client || !isConnectedClient(client)) {
      return;
    }

    const message = parseJsonRpcMessage(text);
    if (message && isNativeClientAck(message)) {
      this.handleNativeClientAck(client, message);
      return;
    }
    if (
      client.transport === "native-acp" &&
      !client.bootstrapComplete &&
      message &&
      isSessionRestoreRequest(message)
    ) {
      const previous = this.clientBootstrapQueues.get(connectionId) ?? Promise.resolve();
      const queued = previous
        .catch((error) => {
          this.recordSuppressedError({
            connectionId,
            error,
            eventName: "acp.relay.client_bootstrap_queue_previous_failed",
          });
        })
        .then(() => this.handleClientTextNow(connectionId, text));
      this.clientBootstrapQueues.set(connectionId, queued);
      try {
        await queued;
      } finally {
        if (this.clientBootstrapQueues.get(connectionId) === queued) {
          this.clientBootstrapQueues.delete(connectionId);
        }
      }
      return;
    }

    await this.handleClientTextNow(connectionId, text);
  }

  private async handleClientTextNow(connectionId: string, text: string): Promise<void> {
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

  private recordSuppressedError(input: {
    connectionId: string;
    error: unknown;
    eventName: string;
  }): void {
    console.warn(
      JSON.stringify({
        connectionId: input.connectionId,
        eventName: input.eventName,
        reason: input.error instanceof Error ? input.error.message : String(input.error),
      }),
    );
  }

	  private logRelayTransportFrame(input: {
    channelKind: AcpRemoteChannelKind;
    client: RelayClient;
    connectionId: string;
    direction: "client_to_daemon" | "daemon_to_client";
    payload: unknown;
  }): void {
    if (input.channelKind !== AcpRemoteChannelKind.Acp) {
      return;
    }
    const details = readRelayTransportPayloadDetails(
      input.payload,
      input.client,
    );
    if (!details.traceContext) {
      return;
    }
    console.log(
      JSON.stringify({
        accountId: input.client.accountId,
        channelKind: input.channelKind,
        clientId: input.client.clientId,
        connectionId: input.connectionId,
        daemonId: input.client.daemonId,
        direction: input.direction,
        eventName: "acp.relay.transport",
        hasError: details.hasError,
        jsonRpcId: details.id,
        method: details.method,
        sessionId: details.sessionId,
        source: "relay",
        spanId: details.traceContext.spanId,
        traceId: details.traceContext.traceId,
        traceparent: details.traceContext.traceparent,
        transport: input.client.transport,
      }),
	    );
	  }

  private logRelayLifecycle(input: {
    accountId?: string;
    bufferedClientPayloads?: number;
    clientId?: string;
    code?: string;
    connectionId?: string;
    daemonId?: string;
    eventName: string;
    jsonRpcId?: string | number;
    method?: string;
    nativeClientAck?: boolean;
    pendingClientFrames?: number;
    pendingDaemonFrames?: number;
    pendingReconnect?: boolean;
    reason?: string;
    replaced?: boolean;
    seq?: number;
    sessionId?: string;
    severityText?: "ERROR" | "INFO";
    traceContext?: AcpRemoteTraceContext;
    transport?: AcpRelayClientTransport;
  }): void {
    console.log(
      JSON.stringify({
        accountId: input.accountId,
        bufferedClientPayloads: input.bufferedClientPayloads,
        clientId: input.clientId,
        code: input.code,
        connectionId: input.connectionId,
        daemonId: input.daemonId,
        eventName: input.eventName,
        jsonRpcId: input.jsonRpcId,
        method: input.method,
        nativeClientAck: input.nativeClientAck,
        pendingClientFrames: input.pendingClientFrames,
        pendingDaemonFrames: input.pendingDaemonFrames,
        pendingReconnect: input.pendingReconnect,
        reason: input.reason,
        replaced: input.replaced,
        seq: input.seq,
        sessionId: input.sessionId,
        severityText: input.severityText ?? "INFO",
        source: "relay",
        spanId: input.traceContext?.spanId,
        traceId: input.traceContext?.traceId,
        traceparent: input.traceContext?.traceparent,
        transport: input.transport,
      }),
    );
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
      this.handleClientAck(connectionId, client, frame.ack);
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

  handleDaemonText(text: string): string | undefined {
    const frame = parseFrame(text);
    if (frame?.frameType === AcpRemoteFrameType.Ack) {
      this.handleDaemonAck(frame);
      return frame.connectionId;
    }
    if (frame?.frameType === AcpRemoteFrameType.Pong) {
      this.handleDaemonPong(frame.connectionId, frame.nonce);
      return undefined;
    }
    if (frame?.frameType === AcpRemoteFrameType.Ping) {
      this.handleDaemonPing(frame.connectionId, frame.nonce);
      return undefined;
    }
    if (frame?.frameType === AcpRemoteFrameType.Data) {
      if (
        frame.channelKind === AcpRemoteChannelKind.Filesystem &&
        this.resolveDaemonWorkspaceListRequest(frame)
      ) {
        return frame.connectionId;
      }
      const client = this.clients.get(frame.connectionId);
      if (client && isReplayOrDuplicateDaemonFrame(client, frame)) {
        return frame.connectionId;
      }
      if (
        client &&
        frame.channelKind === AcpRemoteChannelKind.Acp &&
        isSuppressedDaemonBootstrapResponse(client, frame.payload)
      ) {
        return frame.connectionId;
      }
      if (!client) {
        return frame.connectionId;
      }
      const shouldDeferDaemonAck = shouldDeferNativeClientAck(client, frame);
      const shouldHoldDaemonAckForClientReconnect =
        !client.socket && this.shouldKeepDisconnectedClient(client);
      const shouldHoldDaemonAckForClientBackpressure =
        client.socket &&
        client.transport === "remote-frame" &&
        client.clientPendingFrames.size >=
          this.maxBufferedFramesPerConnection;
      if (
        !shouldDeferDaemonAck &&
        !shouldHoldDaemonAckForClientReconnect &&
        !shouldHoldDaemonAckForClientBackpressure
      ) {
        this.sendDaemonAck(client, frame);
      }
      if (frame.channelKind === AcpRemoteChannelKind.Acp) {
        this.logRelayTransportFrame({
          channelKind: frame.channelKind,
          client,
          connectionId: frame.connectionId,
          direction: "daemon_to_client",
          payload: frame.payload,
        });
        void this.persistSessionBindingFromDaemonResponse(client, frame.payload);
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
        return frame.connectionId;
      }

      const payloadText =
        client.transport === "native-acp"
          ? JSON.stringify(nativeAcpPayloadForClient(client, frame))
          : JSON.stringify(frame);
      if (shouldDeferDaemonAck) {
        client.clientPendingFrames.set(frame.seq, frame);
        const details = readRelayTransportPayloadDetails(frame.payload, client);
        this.logRelayLifecycle({
          accountId: client.accountId,
          clientId: client.clientId,
          connectionId: frame.connectionId,
          daemonId: client.daemonId,
          eventName: "acp.relay.client_response.deferred",
          jsonRpcId: details.id,
          method: details.method,
          nativeClientAck: client.nativeClientAck,
          pendingClientFrames: client.clientPendingFrames.size,
          seq: frame.seq,
          sessionId: details.sessionId,
          traceContext: details.traceContext,
          transport: client.transport,
        });
      }
      if (client.socket) {
        if (client.transport === "remote-frame") {
          if (
            client.clientPendingFrames.size >=
            this.maxBufferedFramesPerConnection
          ) {
            client.bufferedClientPayloads.push(frame);
            this.logRelayLifecycle({
              accountId: client.accountId,
              bufferedClientPayloads: client.bufferedClientPayloads.length,
              clientId: client.clientId,
              connectionId: frame.connectionId,
              daemonId: client.daemonId,
              eventName: "acp.relay.client_frame.queued",
              pendingClientFrames: client.clientPendingFrames.size,
              seq: frame.seq,
              transport: client.transport,
            });
            return frame.connectionId;
          }
          client.clientPendingFrames.set(frame.seq, frame);
        }
        client.socket.send(payloadText);
        return frame.connectionId;
      }
      if (!this.shouldKeepDisconnectedClient(client)) {
        return frame.connectionId;
      }
      if (shouldDeferDaemonAck) {
        const details = readRelayTransportPayloadDetails(frame.payload, client);
        this.logRelayLifecycle({
          accountId: client.accountId,
          clientId: client.clientId,
          connectionId: frame.connectionId,
          daemonId: client.daemonId,
          eventName: "acp.relay.client_response.waiting_for_reconnect",
          jsonRpcId: details.id,
          method: details.method,
          nativeClientAck: client.nativeClientAck,
          pendingClientFrames: client.clientPendingFrames.size,
          seq: frame.seq,
          sessionId: details.sessionId,
          traceContext: details.traceContext,
          transport: client.transport,
        });
        return frame.connectionId;
      }
      client.bufferedClientPayloads.push(frame);
      return frame.connectionId;
    }
    if (frame?.frameType === AcpRemoteFrameType.Close) {
      const client = this.clients.get(frame.connectionId);
      client?.socket?.close(
        1000,
        frame.reason ?? "Remote ACP connection closed.",
      );
      if (client) {
        this.clearDaemonJsonRpcRequests(client);
        this.clearClientSelectionState(client);
      }
      this.clients.delete(frame.connectionId);
      this.clientBootstrapQueues.delete(frame.connectionId);
      return frame.connectionId;
    }
    return undefined;
  }

  private resolveDaemonWorkspaceListRequest(frame: AcpRemoteDataFrame): boolean {
    const pending = this.daemonWorkspaceListRequests.get(frame.connectionId);
    if (!pending) {
      return false;
    }
    this.daemonWorkspaceListRequests.delete(frame.connectionId);
    clearTimeout(pending.timeout);
    const payload = asWorkspaceListResponse(frame.payload);
    pending.resolve(
      payload ?? {
        ok: false,
        reason: "Invalid workspace directory listing response.",
      },
    );
    return true;
  }

  private rejectDaemonWorkspaceListRequests(
    daemonId: string,
    reason: string,
  ): void {
    const prefix = `workspace-list:${daemonId}:`;
    for (const [connectionId, pending] of this.daemonWorkspaceListRequests) {
      if (!connectionId.startsWith(prefix)) {
        continue;
      }
      this.daemonWorkspaceListRequests.delete(connectionId);
      clearTimeout(pending.timeout);
      pending.resolve({ ok: false, reason });
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
          loadSession: true,
          sessionCapabilities: {
            close: {},
            list: {},
            resume: {},
          },
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
      const preBoundHostId = client.daemonId;
      if (
        methodId !== undefined &&
        methodId !== ACP_BOOTSTRAP_AUTH_METHOD_ID &&
        !preBoundHostId
      ) {
        sendJsonRpcError(client.socket, message, {
          code: -32602,
          data: { methodId },
          message: "Invalid params: unsupported relay authentication method.",
        });
        return;
      }

      const preboundDaemonId =
        readMetaString(message.params, ACP_REMOTE_DAEMON_ID_META) ??
        readMetaString(message.params, "daemonId") ??
        client.daemonId;
      if (preboundDaemonId && !client.ticket) {
        client.daemonId = preboundDaemonId;
      }
      // Always wait for web /authorize to complete — user must select
      // daemon, agent, and workspace interactively before a ticket is granted.
      if (!client.ticket) {
        const selectedHostId = await this.waitForClientHostSelection(client);
        if (!isConnectedClient(client)) {
          return;
        }
        if (selectedHostId) {
          client.daemonId = selectedHostId;
        }
      }

      if (!client.daemonId || !client.ticket) {
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
          [ACP_REMOTE_DAEMON_ID_META]: client.daemonId,
          "acp-runtime/remote/ticketKid": client.ticket.kid,
          "acp-runtime/remote/ticketExpiresAt": client.ticket.payload.expiresAt,
        },
      });
      return;
    }

    if (isSessionOpenRequest(message)) {
      if (!client.ticket) {
        if (isSessionNewRequest(message)) {
          const selectedHostId = await this.waitForClientHostSelection(client);
          if (!isConnectedClient(client)) {
            return;
          }
          if (selectedHostId) {
            client.daemonId = selectedHostId;
          }
        } else {
          const restored = await this.restoreBoundSessionRoute(
            connectionId,
            client,
            message,
            {
              skipDaemonBootstrapInitialize: !client.initializeParams,
            },
          );
          if (!restored) {
            return;
          }
        }
      }
      if (!client.daemonId || !client.ticket) {
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
      await this.forwardBoundClientMessage(connectionId, client, message);
      return;
    }

    if (
      isSessionBoundRuntimeRequest(message) &&
      (!client.daemonId || !client.ticket)
    ) {
      const restored = await this.restoreBoundSessionRoute(
        connectionId,
        client,
        message,
      );
      if (!restored) {
        return;
      }
      await this.forwardBoundClientMessage(connectionId, client, message);
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
    const payloadToForward = isSessionOpenRequest(payload)
      ? await this.prepareSessionOpenMessage(connectionId, client, payload)
      : payload;
    if (!payloadToForward) {
      return;
    }

    if (
      isSessionBoundRuntimeRequest(payloadToForward) &&
      (!client.daemonId || !client.ticket)
    ) {
      const restored = await this.restoreBoundSessionRoute(
        connectionId,
        client,
        payloadToForward,
      );
      if (!restored) {
        return;
      }
    }

    if (
      isJsonRpcRequest(payloadToForward) &&
      this.handleDuplicateBoundClientRequest(connectionId, client, payloadToForward)
    ) {
      return;
    }

    const daemonId = client.daemonId;
    const route = daemonId ? this.daemonRouteState(daemonId) : undefined;
    const daemon = route?.daemon;
    if (!daemon) {
      if (daemonId && route?.pendingReconnect) {
        const authorization = await this.revalidateQueuedBoundClientMessage(
          connectionId,
          client,
          payloadToForward,
        );
        if (!authorization.ok) {
          this.rejectBoundClientMessage(
            connectionId,
            client,
            payloadToForward,
            authorization,
          );
          return;
        }
        this.queueDaemonDataFrame(connectionId, client, payloadToForward, {
          pendingReconnect: true,
        });
        return;
      }
      if (isJsonRpcRequest(payloadToForward)) {
        sendJsonRpcError(client.socket, payloadToForward, {
          code: -32002,
          data: { daemonId },
          message: "Resource not found: host daemon is not online.",
        });
      }
      return;
    }

    const authorization = await this.revalidateBoundClientMessage(
      connectionId,
      client,
      daemon,
      payloadToForward,
    );
    if (!authorization.ok) {
      this.rejectBoundClientMessage(
        connectionId,
        client,
        payloadToForward,
        authorization,
      );
      return;
    }
    this.sendDaemonDataFrame(connectionId, client, daemon, payloadToForward);
  }

  private handleDuplicateBoundClientRequest(
    connectionId: string,
    client: ConnectedRelayClient,
    request: RelayJsonRpcRequest,
  ): boolean {
    if (!isStoredJsonRpcId(request.id)) {
      return false;
    }
    const pendingResponse = this.findPendingClientResponseForRequestId(
      client,
      request.id,
    );
    if (pendingResponse) {
      const details = readRelayTransportPayloadDetails(
        pendingResponse.payload,
        client,
      );
      this.logRelayLifecycle({
        accountId: client.accountId,
        clientId: client.clientId,
        connectionId,
        daemonId: client.daemonId,
        eventName: "acp.relay.client_request.duplicate_response_replayed",
        jsonRpcId: request.id,
        method: details.method,
        nativeClientAck: client.nativeClientAck,
        pendingClientFrames: client.clientPendingFrames.size,
        seq: pendingResponse.seq,
        sessionId: details.sessionId,
        traceContext: details.traceContext,
        transport: client.transport,
      });
      client.socket.send(JSON.stringify(pendingResponse.payload));
      return true;
    }
    const completedResponse = client.completedClientResponses.get(request.id);
    if (completedResponse) {
      const details = readRelayTransportPayloadDetails(completedResponse, client);
      this.logRelayLifecycle({
        accountId: client.accountId,
        clientId: client.clientId,
        connectionId,
        daemonId: client.daemonId,
        eventName: "acp.relay.client_request.duplicate_completed_replayed",
        jsonRpcId: request.id,
        method: details.method,
        nativeClientAck: client.nativeClientAck,
        sessionId: details.sessionId,
        traceContext: details.traceContext,
        transport: client.transport,
      });
      client.socket.send(JSON.stringify(completedResponse));
      return true;
    }
    if (!client.daemonRequests.has(request.id)) {
      return false;
    }
    const details = readRelayTransportPayloadDetails(request, client);
    this.logRelayLifecycle({
      accountId: client.accountId,
      clientId: client.clientId,
      connectionId,
      daemonId: client.daemonId,
      eventName: "acp.relay.client_request.duplicate_suppressed",
      jsonRpcId: request.id,
      method: details.method,
      pendingDaemonFrames: client.daemonPendingFrames.size,
      sessionId: details.sessionId,
      traceContext: details.traceContext,
      transport: client.transport,
    });
    return true;
  }

  private findPendingClientResponseForRequestId(
    client: RelayClient,
    requestId: string | number,
  ): AcpRemoteDataFrame | undefined {
    for (const frame of [...client.clientPendingFrames.values()].sort(
      (left, right) => left.seq - right.seq,
    )) {
      const response = isJsonRpcResponsePayload(frame.payload)
        ? frame.payload
        : undefined;
      if (response?.id === requestId) {
        return frame;
      }
    }
    return undefined;
  }

  private async prepareSessionOpenMessage(
    connectionId: string,
    client: ConnectedRelayClient,
    payload: RelayJsonRpcRequest,
  ): Promise<RelayJsonRpcRequest | undefined> {
    const sessionSelectionId = readSessionSelectionId(payload);
    const selection = isSessionNewRequest(payload)
      ? await this.waitForNextSessionSelection(client, sessionSelectionId)
      : this.consumePendingSessionSelection(client, sessionSelectionId);
    if (!selection && !isSessionNewRequest(payload)) {
      return payload;
    }
    if (!selection) {
      sendJsonRpcError(client.socket, payload, {
        code: -32000,
        data: {
          authUrl: client.authUrl,
          connectionId,
          onlineHosts: this.onlineHostIds(),
        },
        message: "Authentication required: session selection was not completed.",
      });
      return undefined;
    }
    if (selection.daemonId !== client.daemonId) {
      sendJsonRpcError(client.socket, payload, {
        code: -32000,
        data: { daemonId: selection.daemonId },
        message: "Authentication required: selected host changed; start a new connection.",
      });
      return undefined;
    }
    return applySessionSelection(payload, selection);
  }

  private async restoreBoundSessionRoute(
    connectionId: string,
    client: ConnectedRelayClient,
    request: RelayJsonRpcRequest,
    options: {
      skipDaemonBootstrapInitialize?: boolean;
    } = {},
  ): Promise<boolean> {
    const restore = await this.resolveSessionRestoreSelection(client, request);
    if (!restore) {
      sendJsonRpcError(client.socket, request, {
        code: -32000,
        data: {
          authUrl: client.authUrl,
          connectionId,
          onlineHosts: this.onlineHostIds(),
        },
        message:
          "Authentication required: historical remote session is missing binding metadata.",
      });
      return false;
    }

    const previousBootstrapComplete = client.bootstrapComplete;
    if (options.skipDaemonBootstrapInitialize) {
      client.bootstrapComplete = true;
    }
    const authorization = await this.authorizeClient({
      allowPendingDaemonReconnect: true,
      clientAgent: restore.agent,
      connectionId,
      daemonId: restore.daemonId,
      workspaceRoots: restore.workspaceRoots,
    });
    if (!isConnectedClient(client)) {
      return false;
    }
    if (!authorization.ok) {
      if (options.skipDaemonBootstrapInitialize) {
        client.bootstrapComplete = previousBootstrapComplete;
      }
      sendJsonRpcError(client.socket, request, {
        code: -32000,
        data: {
          authUrl: client.authUrl,
          connectionId,
          daemonId: restore.daemonId,
          onlineHosts: this.onlineHostIds(),
        },
        message: `Authentication required: ${authorization.reason}`,
      });
      return false;
    }

    client.daemonId = restore.daemonId;
    client.bootstrapComplete = true;
    return true;
  }

  private async resolveSessionRestoreSelection(
    client: RelayClient,
    request: RelayJsonRpcRequest,
  ): Promise<RelayAuthorizationSelection | undefined> {
    const explicitSelection = readSessionRestoreSelection(request);
    if (explicitSelection) {
      return explicitSelection;
    }
    const sessionId = readRequestSessionId(request);
    if (!sessionId) {
      return undefined;
    }
    const binding = await this.controlPlaneStore.getSessionBinding({
      accountId: client.accountId,
      clientId: client.clientId,
      sessionId,
    });
    if (!binding) {
      return undefined;
    }
    return {
      agent: binding.agent,
      daemonId: binding.daemonId,
      workspaceRoots: binding.workspaceRoots,
    };
  }

  private async forwardRemoteClientFrame(
    connectionId: string,
    client: ConnectedRelayClient,
    frame: AcpRemoteDataFrame,
  ): Promise<void> {
    const daemonId = client.daemonId;
    const route = daemonId ? this.daemonRouteState(daemonId) : undefined;
    const daemon = route?.daemon;
    if (!daemon) {
      if (daemonId && route?.pendingReconnect) {
        const authorization = await this.revalidateQueuedBoundClientFrame(
          connectionId,
          client,
          frame,
        );
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
        this.queueDaemonDataFrame(connectionId, client, frame.payload, {
          channelId: frame.channelId,
          channelKind: frame.channelKind,
          pendingReconnect: true,
        });
        return;
      }
      client.socket.close(
        1013,
        "Host daemon is not online.",
      );
      return;
    }

    const authorization = await this.revalidateBoundClientFrame(
      connectionId,
      client,
      daemon,
      frame,
    );
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
    const daemonId = client.daemonId;
    const daemon = daemonId ? this.daemons.get(daemonId) : undefined;
    if (!daemonId || !client.ticket || !daemon) {
      sendJsonRpcError(client.socket, request, {
        code: -32002,
        data: { daemonId },
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
      clientId: client.clientId,
      daemonId,
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

    const renewal = await this.renewBoundClientTicket(
      connectionId,
      client,
      daemon,
      decision.grant,
    );
    if (!renewal.ok) {
      sendJsonRpcError(client.socket, request, {
        code: -32000,
        message: `Authentication required: ${renewal.reason}`,
      });
      return;
    }
    sendJsonRpcResult(client.socket, request, {
      _meta: {
        [ACP_REMOTE_CONNECTION_ID_META]: connectionId,
        [ACP_REMOTE_DAEMON_ID_META]: daemonId,
        "acp-runtime/remote/ticketKid": renewal.ticket.kid,
        "acp-runtime/remote/ticketExpiresAt": renewal.ticket.payload.expiresAt,
      },
    });
  }

  private async revalidateBoundClientMessage(
    connectionId: string,
    client: RelayClient,
    daemon: RelaySocket,
    payload: RelayJsonRpcMessage,
  ): Promise<BoundClientRevalidationResult> {
    if (!client.daemonId || !client.ticket) {
      return {
        closeRoute: true,
        ok: false,
        reason: "ACP remote connection is not authorized.",
      };
    }

    const connectDecision = await this.controlPlaneStore.resolveGrant({
      accountId: client.accountId,
      clientId: client.clientId,
      daemonId: client.daemonId,
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
          clientId: client.clientId,
          daemonId: client.daemonId,
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
      return this.renewBoundClientTicket(
        connectionId,
        client,
        daemon,
        grantDecision.grant,
      );
    }
    return { ok: true };
  }

  private async revalidateBoundClientFrame(
    connectionId: string,
    client: RelayClient,
    daemon: RelaySocket,
    frame: AcpRemoteDataFrame,
  ): Promise<BoundClientRevalidationResult> {
    if (!client.daemonId || !client.ticket) {
      return {
        closeRoute: true,
        ok: false,
        reason: "ACP remote connection is not authorized.",
      };
    }

    const connectDecision = await this.controlPlaneStore.resolveGrant({
      accountId: client.accountId,
      clientId: client.clientId,
      daemonId: client.daemonId,
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
          clientId: client.clientId,
          daemonId: client.daemonId,
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
      return this.renewBoundClientTicket(
        connectionId,
        client,
        daemon,
        grantDecision.grant,
      );
    }
    return { ok: true };
  }

  private revalidateQueuedBoundClientMessage(
    connectionId: string,
    client: RelayClient,
    payload: RelayJsonRpcMessage,
  ): Promise<BoundClientRevalidationResult> {
    return this.revalidateQueuedBoundClientPayload(
      connectionId,
      client,
      requiredScopeForAcpPayload(payload),
    );
  }

  private revalidateQueuedBoundClientFrame(
    connectionId: string,
    client: RelayClient,
    frame: AcpRemoteDataFrame,
  ): Promise<BoundClientRevalidationResult> {
    return this.revalidateQueuedBoundClientPayload(
      connectionId,
      client,
      requiredScopeForRemoteFrame(frame),
    );
  }

  private async revalidateQueuedBoundClientPayload(
    connectionId: string,
    client: RelayClient,
    requiredScope: AcpRemoteScope | undefined,
  ): Promise<BoundClientRevalidationResult> {
    if (!client.daemonId || !client.ticket) {
      return {
        closeRoute: true,
        ok: false,
        reason: "ACP remote connection is not authorized.",
      };
    }

    const connectDecision = await this.controlPlaneStore.resolveGrant({
      accountId: client.accountId,
      clientId: client.clientId,
      daemonId: client.daemonId,
      requiredScopes: ["acp:connect"],
    });
    if (!connectDecision.ok) {
      return {
        closeRoute: true,
        ok: false,
        reason: connectDecision.reason,
      };
    }

    const grantDecision = requiredScope
      ? await this.controlPlaneStore.resolveGrant({
          accountId: client.accountId,
          clientId: client.clientId,
          daemonId: client.daemonId,
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
      this.logRelayLifecycle({
        accountId: client.accountId,
        clientId: client.clientId,
        connectionId,
        daemonId: client.daemonId,
        eventName: "acp.relay.ticket.renew_deferred",
        pendingReconnect: true,
        transport: client.transport,
      });
    }
    return { ok: true };
  }

  private async renewBoundClientTicket(
    connectionId: string,
    client: RelayClient,
    daemon: RelaySocket,
    grant: AcpRemoteGrant,
    options: {
      notifyDaemon?: boolean;
    } = {},
  ): Promise<
    | {
        ok: true;
        ticket: AcpRemoteSignedConnectionTicket;
      }
    | {
        closeRoute: boolean;
        ok: false;
        reason: string;
      }
  > {
    if (!this.ticketSigningKey) {
      return {
        closeRoute: true,
        ok: false,
        reason: "Relay ticket signing key is not configured.",
      };
    }

    const selectedAgent = client.ticket?.payload.agent;
    const selectedWorkspaceRoots = client.ticket?.payload.workspaceRoots;
    const validation = validateAuthorizationSelection({
      agent: selectedAgent,
      grant,
      metadata: client.daemonId
        ? this.daemonMetadataMap.get(client.daemonId)
        : undefined,
      workspaceRoots: selectedWorkspaceRoots,
    });
    if (!validation.ok) {
      return {
        closeRoute: true,
        ok: false,
        reason: validation.reason,
      };
    }

    const ticket = await this.createSignedTicket(connectionId, {
      ...grant,
      ...(selectedAgent && { agent: selectedAgent }),
      ...(selectedWorkspaceRoots && { workspaceRoots: selectedWorkspaceRoots }),
    });
    client.ticket = ticket;
    if (client.daemonId) {
      this.onClientRouteAuthorized?.({
        connectionId,
        daemonId: client.daemonId,
        ticket,
      });
    }
    if (options.notifyDaemon ?? true) {
      daemon.send(
        JSON.stringify({
          connectionId,
          frameType: AcpRemoteFrameType.Renew,
          ticket,
        }),
      );
    }
    return { ok: true, ticket };
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
    const daemonId = client.daemonId;
    this.logRelayLifecycle({
      accountId: client.accountId,
      bufferedClientPayloads: client.bufferedClientPayloads.length,
      clientId: client.clientId,
      code,
      connectionId,
      daemonId,
      eventName: "acp.relay.client_route.closed",
      nativeClientAck: client.nativeClientAck,
      pendingClientFrames: client.clientPendingFrames.size,
      pendingDaemonFrames: client.daemonPendingFrames.size,
      reason,
      severityText: "ERROR",
      transport: client.transport,
    });
    if (daemonId) {
      this.daemons.get(daemonId)?.send(
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
    client.daemonQueuedFrames = [];
    client.daemonPendingFrames.clear();
    this.clearDaemonJsonRpcRequests(client);
    this.clearClientSelectionState(client);
    client.daemonId = undefined;
    client.daemonRuntimeInstanceId = undefined;
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
    this.clientBootstrapQueues.delete(connectionId);
  }

  private closeClientsForHost(
    daemonId: string,
    code: number,
    reason: string,
  ): void {
    for (const [connectionId, client] of this.clients.entries()) {
      if (client.daemonId !== daemonId) {
        continue;
      }
      client.socket?.close(code, reason);
      this.clearDaemonJsonRpcRequests(client);
      this.clearClientSelectionState(client);
      this.clients.delete(connectionId);
      this.clientBootstrapQueues.delete(connectionId);
    }
  }

  private clearDaemonJsonRpcRequests(client: RelayClient): void {
    client.daemonRequests.clear();
  }

  private markDaemonDisconnected(daemonId: string, reason: string): void {
    if (this.daemonReconnectGraceMs > 0) {
      this.daemonReconnects.set(daemonId, {
        disconnectedAtMs: this.now().getTime(),
      });
      return;
    }

    this.daemonMetadataMap.delete(daemonId);
    this.closeClientsForHost(daemonId, 1013, reason);
  }

  private resolveAckedDaemonRequestsAfterRuntimeRestart(
    daemonId: string,
    daemon: RelaySocket,
    runtimeInstanceId: string,
  ): void {
    for (const [connectionId, client] of this.clients.entries()) {
      if (client.daemonId !== daemonId) {
        continue;
      }
      const previousRuntimeInstanceId = client.daemonRuntimeInstanceId;
      client.daemonRuntimeInstanceId = runtimeInstanceId;
      if (
        !previousRuntimeInstanceId ||
        previousRuntimeInstanceId === runtimeInstanceId
      ) {
        continue;
      }
      for (const [requestId, request] of [...client.daemonRequests.entries()]) {
        if (this.shouldKeepDaemonRequestAfterRuntimeRestart(client, requestId)) {
          continue;
        }
        if (this.replayDaemonRequestAfterRuntimeRestart(connectionId, client, daemon, request)) {
          continue;
        }
        client.daemonRequests.delete(requestId);
        this.rejectDaemonRequestAfterRuntimeRestart(
          connectionId,
          client,
          request,
        );
      }
    }
  }

  private shouldKeepDaemonRequestAfterRuntimeRestart(
    client: RelayClient,
    requestId: string | number,
  ): boolean {
    if (
      typeof requestId === "string" &&
      client.daemonBootstrapRequestIds.has(requestId)
    ) {
      return true;
    }
    return (
      this.hasDaemonFrameForRequestId(client.daemonPendingFrames.values(), requestId) ||
      this.hasDaemonFrameForRequestId(client.daemonQueuedFrames, requestId)
    );
  }

  private hasDaemonFrameForRequestId(
    frames: Iterable<AcpRemoteDataFrame>,
    requestId: string | number,
  ): boolean {
    for (const frame of frames) {
      if (frame.channelKind !== AcpRemoteChannelKind.Acp) {
        continue;
      }
      const payload = isJsonRpcRequestPayload(frame.payload)
        ? frame.payload
        : undefined;
      if (payload?.id === requestId) {
        return true;
      }
    }
    return false;
  }

  private replayDaemonRequestAfterRuntimeRestart(
    connectionId: string,
    client: RelayClient,
    daemon: RelaySocket,
    request: RelayJsonRpcRequest,
  ): boolean {
    if (!isReplayableDaemonRequestAfterRuntimeRestart(request)) {
      return false;
    }
    const details = readRelayTransportPayloadDetails(request, client);
    this.logRelayLifecycle({
      accountId: client.accountId,
      clientId: client.clientId,
      connectionId,
      daemonId: client.daemonId,
      eventName: "acp.relay.daemon_request.replay_after_restart",
      jsonRpcId: isStoredJsonRpcId(request.id) ? request.id : undefined,
      method: details.method,
      sessionId: details.sessionId,
      traceContext: details.traceContext,
      transport: client.transport,
    });
    this.sendDaemonDataFrame(connectionId, client, daemon, request);
    return true;
  }

  private rejectDaemonRequestAfterRuntimeRestart(
    connectionId: string,
    client: RelayClient,
    request: RelayJsonRpcRequest,
  ): void {
    const error = {
      code: -32003,
      data: {
        daemonId: client.daemonId,
        method: request.method,
        reason: "daemon_restarted",
        sessionId: readRequestSessionId(request),
      },
      message:
        "Remote daemon restarted before this request completed. The request status is unknown; retry if appropriate.",
    };
    this.logRelayLifecycle({
      accountId: client.accountId,
      clientId: client.clientId,
      connectionId,
      daemonId: client.daemonId,
      eventName: "acp.relay.daemon_request.unknown_after_restart",
      jsonRpcId: isStoredJsonRpcId(request.id) ? request.id : undefined,
      method: request.method,
      sessionId: readRequestSessionId(request),
      severityText: "ERROR",
      transport: client.transport,
    });
    if (client.socket) {
      sendJsonRpcError(client.socket, request, error);
      return;
    }
    if (!this.shouldKeepDisconnectedClient(client)) {
      return;
    }
    client.bufferedClientPayloads.push({
      channelId: "acp",
      channelKind: AcpRemoteChannelKind.Acp,
      connectionId,
      frameType: AcpRemoteFrameType.Data,
      payload: {
        error,
        id: request.id,
        jsonrpc: "2.0",
      },
      seq: 0,
    });
  }

  private async reopenClientRoutesForDaemon(
    daemonId: string,
    socket: RelaySocket,
  ): Promise<void> {
    for (const [connectionId, client] of this.clients.entries()) {
      if (client.daemonId !== daemonId || !client.ticket) {
        continue;
      }

      const routeReady = await this.renewClientTicketForDaemonReconnect(
        connectionId,
        client,
        socket,
      );
      if (!routeReady || this.daemons.get(daemonId) !== socket) {
        continue;
      }

      const pendingBeforeBootstrap = [
        ...client.daemonPendingFrames.values(),
      ].sort((left, right) => left.seq - right.seq);
      client.lastDaemonSeq = undefined;
      this.sendDaemonClientHello(connectionId, client, socket);
      this.sendDaemonBootstrapInitialize(connectionId, client, socket);
      this.replaySessionControlRequests(connectionId, client, socket);
      this.replayPendingDaemonFrames(client, socket, pendingBeforeBootstrap);
    }
  }

  private async renewClientTicketForDaemonReconnect(
    connectionId: string,
    client: RelayClient,
    daemon: RelaySocket,
  ): Promise<boolean> {
    if (!client.daemonId || !client.ticket) {
      return false;
    }
    if (!this.shouldRenewTicket(client.ticket)) {
      return true;
    }

    const decision = await this.controlPlaneStore.resolveGrant({
      accountId: client.accountId,
      clientId: client.clientId,
      daemonId: client.daemonId,
      requiredScopes: ["acp:connect"],
    });
    if (!decision.ok) {
      this.revokeClientRoute(
        connectionId,
        client,
        "authorization_revoked",
        decision.reason,
      );
      return false;
    }

    const renewal = await this.renewBoundClientTicket(
      connectionId,
      client,
      daemon,
      decision.grant,
      { notifyDaemon: false },
    );
    if (renewal.ok) {
      return true;
    }
    if (renewal.closeRoute) {
      this.revokeClientRoute(
        connectionId,
        client,
        "authorization_revoked",
        renewal.reason,
      );
    }
    return false;
  }

  private sendDaemonClientHello(
    connectionId: string,
    client: RelayClient,
    daemon: RelaySocket,
  ): void {
    if (!client.daemonId || !client.ticket) {
      return;
    }

    const frame = {
      connectionId,
      endpoint: AcpRemoteEndpointKind.Client,
      frameType: AcpRemoteFrameType.Hello,
      daemonId: client.daemonId,
      protocolVersion: ACP_REMOTE_PROTOCOL_VERSION,
      ticket: client.ticket,
    };
    daemon.send(JSON.stringify(frame));
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

  private replaySessionControlRequests(
    connectionId: string,
    client: RelayClient,
    daemon: RelaySocket,
  ): void {
    const requests = [...client.sessionControlRequests.values()];
    requests.sort((left, right) =>
      sessionControlReplayOrder(left) - sessionControlReplayOrder(right),
    );
    for (const [index, request] of requests.entries()) {
      const requestId = `relay:${connectionId}:session-control:${index}`;
      client.daemonBootstrapRequestIds.add(requestId);
      const payload: RelayJsonRpcRequest = {
        ...request,
        id: requestId,
      };
      const details = readRelayTransportPayloadDetails(payload, client);
      this.logRelayLifecycle({
        accountId: client.accountId,
        clientId: client.clientId,
        connectionId,
        daemonId: client.daemonId,
        eventName: "acp.relay.session_control.replay",
        jsonRpcId: requestId,
        method: details.method,
        pendingReconnect: true,
        sessionId: details.sessionId,
        traceContext: details.traceContext,
        transport: client.transport,
      });
      this.sendDaemonDataFrame(connectionId, client, daemon, payload);
    }
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
    const frame = this.createDaemonDataFrame(connectionId, client, payload, {
      channelId: options.channelId,
      channelKind: options.channelKind,
    });
    this.trackDaemonDataFrameRequest(connectionId, client, payload);
    if (client.daemonPendingFrames.size >= this.maxBufferedFramesPerConnection) {
      this.queueDaemonFrame(connectionId, client, frame, {
        eventName: "acp.relay.daemon_frame.queued",
      });
      return;
    }
    this.sendDaemonFrameNow(connectionId, client, daemon, frame, payload);
  }

  private queueDaemonDataFrame(
    connectionId: string,
    client: RelayClient,
    payload: unknown,
    options: {
      channelId?: string;
      channelKind?: AcpRemoteChannelKind;
      pendingReconnect?: boolean;
    } = {},
  ): void {
    const frame = this.createDaemonDataFrame(connectionId, client, payload, {
      channelId: options.channelId,
      channelKind: options.channelKind,
    });
    this.trackDaemonDataFrameRequest(connectionId, client, payload);
    this.queueDaemonFrame(connectionId, client, frame, {
      eventName: "acp.relay.daemon_frame.queued_for_reconnect",
      pendingReconnect: options.pendingReconnect,
    });
  }

  private createDaemonDataFrame(
    connectionId: string,
    client: RelayClient,
    payload: unknown,
    options: {
      channelId?: string;
      channelKind?: AcpRemoteChannelKind;
    } = {},
  ): AcpRemoteDataFrame {
    const seq = ++client.seq;
    return {
      channelId: options.channelId ?? "acp",
      channelKind: options.channelKind ?? AcpRemoteChannelKind.Acp,
      connectionId,
      frameType: AcpRemoteFrameType.Data,
      payload,
      seq,
    };
  }

  private queueDaemonFrame(
    connectionId: string,
    client: RelayClient,
    frame: AcpRemoteDataFrame,
    input: {
      eventName: string;
      pendingReconnect?: boolean;
    },
  ): void {
    client.daemonQueuedFrames.push(frame);
    const details = readRelayTransportPayloadDetails(frame.payload, client);
    this.logRelayLifecycle({
      accountId: client.accountId,
      clientId: client.clientId,
      connectionId,
      daemonId: client.daemonId,
      eventName: input.eventName,
      jsonRpcId: details.id,
      method: details.method,
      pendingDaemonFrames: client.daemonPendingFrames.size,
      pendingReconnect: input.pendingReconnect,
      seq: frame.seq,
      sessionId: details.sessionId,
      traceContext: details.traceContext,
      transport: client.transport,
    });
  }

  private sendDaemonFrameNow(
    connectionId: string,
    client: RelayClient,
    daemon: RelaySocket,
    frame: AcpRemoteDataFrame,
    payload: unknown,
  ): void {
    client.daemonPendingFrames.set(frame.seq, frame);
    this.logRelayTransportFrame({
      channelKind: frame.channelKind,
      client,
      connectionId,
      direction: "client_to_daemon",
      payload,
    });
    daemon.send(JSON.stringify(frame));
  }

  private trackDaemonDataFrameRequest(
    connectionId: string,
    client: RelayClient,
    payload: unknown,
  ): void {
    if (
      client.transport === "native-acp" &&
      isJsonRpcRequestPayload(payload) &&
      isStoredJsonRpcId(payload.id)
    ) {
      this.trackDaemonJsonRpcRequest(connectionId, client, payload);
    }
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
    this.flushQueuedDaemonFrames(client);
  }

  private async persistSessionBindingFromDaemonResponse(
    client: RelayClient,
    payload: unknown,
  ): Promise<void> {
    const response = isJsonRpcResponsePayload(payload) ? payload : undefined;
    if (!response) {
      return;
    }
    if (!isStoredJsonRpcId(response.id)) {
      return;
    }
    const request = client.daemonRequests.get(response.id);
    if (request) {
      client.daemonRequests.delete(response.id);
    }
    this.rememberCompletedClientResponse(client, response);
    if (request && !response.error) {
      this.rememberSessionControlRequest(client, request);
    }
    if (!request || !isSessionOpenRequest(request) || response.error) {
      return;
    }
    const sessionId =
      readResultSessionId(response.result) ?? readRequestSessionId(request);
    const daemonId =
      client.daemonId ?? readSessionRestoreSelection(request)?.daemonId;
    if (!sessionId || !daemonId) {
      return;
    }
    const resultBinding = readSessionBindingMetadata(response.result);
    const requestSelection = readSessionRestoreSelection(request);
    try {
      await this.controlPlaneStore.upsertSessionBinding({
        accountId: client.accountId,
        agent:
          resultBinding?.agent ??
          requestSelection?.agent ??
          client.lastAuthorization?.agent,
        clientId: client.clientId,
        daemonId: resultBinding?.daemonId ?? daemonId,
        sessionId,
        workspaceRoots:
          resultBinding?.workspaceRoots ??
          requestSelection?.workspaceRoots ??
          client.lastAuthorization?.workspaceRoots,
      });
    } catch (error) {
      console.error("Failed to persist ACP remote session binding", error);
    }
  }

  private trackDaemonJsonRpcRequest(
    _connectionId: string,
    client: RelayClient,
    request: RelayJsonRpcRequest,
  ): void {
    if (!isStoredJsonRpcId(request.id)) {
      return;
    }
    const requestId = request.id;
    client.daemonRequests.set(requestId, request);
  }

  private rememberSessionControlRequest(
    client: RelayClient,
    request: RelayJsonRpcRequest,
  ): void {
    const key = sessionControlRequestKey(request);
    if (!key) {
      return;
    }
    client.sessionControlRequests.set(key, request);
  }

  private rememberCompletedClientResponse(
    client: RelayClient,
    response: RelayJsonRpcResponse,
  ): void {
    if (!isStoredJsonRpcId(response.id)) {
      return;
    }
    client.completedClientResponses.delete(response.id);
    client.completedClientResponses.set(response.id, response);
    while (
      client.completedClientResponses.size >
      DEFAULT_COMPLETED_RESPONSE_CACHE_LIMIT
    ) {
      const oldest = client.completedClientResponses.keys().next();
      if (oldest.done) {
        break;
      }
      client.completedClientResponses.delete(oldest.value);
    }
  }

  private handleClientAck(
    connectionId: string,
    client: RelayClient,
    ack: number,
  ): void {
    for (const seq of [...client.clientPendingFrames.keys()].sort(
      (left, right) => left - right,
    )) {
      if (seq > ack) {
        break;
      }
      client.clientPendingFrames.delete(seq);
    }
    if (isConnectedClient(client)) {
      this.flushBufferedClientPayloads(client, connectionId);
    }
  }

  private handleNativeClientAck(
    client: RelayClient,
    message: RelayJsonRpcNotification,
  ): void {
    const seq = readNativeClientAckSeq(message);
    if (seq !== undefined) {
      const frame = client.clientPendingFrames.get(seq);
      if (!frame) {
        return;
      }
      client.clientPendingFrames.delete(seq);
      const details = readRelayTransportPayloadDetails(frame.payload, client);
      this.logRelayLifecycle({
        accountId: client.accountId,
        clientId: client.clientId,
        connectionId: frame.connectionId,
        daemonId: client.daemonId,
        eventName: "acp.relay.client_ack.received",
        jsonRpcId: details.id,
        method: details.method,
        nativeClientAck: client.nativeClientAck,
        pendingClientFrames: client.clientPendingFrames.size,
        seq: frame.seq,
        sessionId: details.sessionId,
        traceContext: details.traceContext,
        transport: client.transport,
      });
      this.sendDaemonAck(client, frame);
      return;
    }
    const id = readNativeClientAckId(message);
    if (id === undefined) {
      return;
    }
    for (const [seq, frame] of client.clientPendingFrames) {
      const response = isJsonRpcResponsePayload(frame.payload)
        ? frame.payload
        : undefined;
      if (response?.id !== id) {
        continue;
      }
      client.clientPendingFrames.delete(seq);
      const details = readRelayTransportPayloadDetails(frame.payload, client);
      this.logRelayLifecycle({
        accountId: client.accountId,
        clientId: client.clientId,
        connectionId: frame.connectionId,
        daemonId: client.daemonId,
        eventName: "acp.relay.client_ack.received",
        jsonRpcId: details.id,
        method: details.method,
        nativeClientAck: client.nativeClientAck,
        pendingClientFrames: client.clientPendingFrames.size,
        seq: frame.seq,
        sessionId: details.sessionId,
        traceContext: details.traceContext,
        transport: client.transport,
      });
      this.sendDaemonAck(client, frame);
      return;
    }
  }

  private sendDaemonAck(client: RelayClient, frame: AcpRemoteDataFrame): void {
    const daemonId = client.daemonId;
    if (!daemonId) {
      return;
    }
    this.daemons.get(daemonId)?.send(
      JSON.stringify({
        ack: frame.seq,
        channelId: frame.channelId,
        connectionId: frame.connectionId,
        frameType: AcpRemoteFrameType.Ack,
      } satisfies AcpRemoteAckFrame),
    );
  }

  private flushBufferedClientPayloads(
    client: ConnectedRelayClient,
    connectionId: string,
  ): void {
    if (client.bufferedClientPayloads.length === 0) {
      return;
    }
    const bufferedBeforeFlush = client.bufferedClientPayloads.length;
    const remaining: AcpRemoteDataFrame[] = [];
    this.logRelayLifecycle({
      accountId: client.accountId,
      bufferedClientPayloads: bufferedBeforeFlush,
      clientId: client.clientId,
      connectionId,
      daemonId: client.daemonId,
      eventName: "acp.relay.client_buffer.flush",
      transport: client.transport,
    });
    for (const frame of client.bufferedClientPayloads) {
      if (
        client.transport === "remote-frame" &&
        client.clientPendingFrames.size >= this.maxBufferedFramesPerConnection
      ) {
        remaining.push(frame);
        continue;
      }
      const payload =
        client.transport === "native-acp"
          ? nativeAcpPayloadForClient(client, frame)
          : frame;
      if (client.transport === "remote-frame") {
        client.clientPendingFrames.set(frame.seq, frame);
      }
      client.socket.send(JSON.stringify(payload));
      if (frame.seq > 0) {
        this.sendDaemonAck(client, frame);
      }
    }
    client.bufferedClientPayloads = remaining;
    if (remaining.length > 0) {
      this.logRelayLifecycle({
        accountId: client.accountId,
        bufferedClientPayloads: remaining.length,
        clientId: client.clientId,
        connectionId,
        daemonId: client.daemonId,
        eventName: "acp.relay.client_buffer.paused",
        pendingClientFrames: client.clientPendingFrames.size,
        transport: client.transport,
      });
    }
  }

  private replayPendingClientFrames(client: ConnectedRelayClient): void {
    for (const frame of [...client.clientPendingFrames.values()].sort(
      (left, right) => left.seq - right.seq,
    )) {
      const details = readRelayTransportPayloadDetails(frame.payload, client);
      this.logRelayLifecycle({
        accountId: client.accountId,
        clientId: client.clientId,
        connectionId: frame.connectionId,
        daemonId: client.daemonId,
        eventName: "acp.relay.client_frame.replay",
        jsonRpcId: details.id,
        method: details.method,
        nativeClientAck: client.nativeClientAck,
        pendingClientFrames: client.clientPendingFrames.size,
        seq: frame.seq,
        sessionId: details.sessionId,
        traceContext: details.traceContext,
        transport: client.transport,
      });
      const payload =
        client.transport === "native-acp"
          ? nativeAcpPayloadForClient(client, frame)
          : frame;
      client.socket.send(JSON.stringify(payload));
    }
  }

  private replayPendingDaemonFrames(
    client: RelayClient,
    daemon: RelaySocket,
    frames = [...client.daemonPendingFrames.values()].sort(
      (left, right) => left.seq - right.seq,
    ),
  ): void {
    for (const frame of frames) {
      this.logRelayLifecycle({
        accountId: client.accountId,
        clientId: client.clientId,
        connectionId: frame.connectionId,
        daemonId: client.daemonId,
        eventName: "acp.relay.daemon_frame.replay",
        pendingDaemonFrames: client.daemonPendingFrames.size,
        seq: frame.seq,
        transport: client.transport,
      });
      daemon.send(JSON.stringify(frame));
    }
    this.flushQueuedDaemonFrames(client, daemon);
  }

  private flushQueuedDaemonFrames(
    client: RelayClient,
    daemon = client.daemonId ? this.daemons.get(client.daemonId) : undefined,
  ): void {
    if (!daemon) {
      return;
    }
    while (
      client.daemonQueuedFrames.length > 0 &&
      client.daemonPendingFrames.size < this.maxBufferedFramesPerConnection
    ) {
      const frame = client.daemonQueuedFrames.shift();
      if (!frame) {
        return;
      }
      this.sendDaemonFrameNow(
        frame.connectionId,
        client,
        daemon,
        frame,
        frame.payload,
      );
    }
  }

  private canResumeClient(
    input: AcpRelayClientRegistration,
    existing: RelayClient,
    clientId: string,
    transport: AcpRelayClientTransport,
  ): boolean {
    if (
      existing.accountId !== input.accountId ||
      existing.clientId !== clientId ||
      existing.transport !== transport
    ) {
      return false;
    }

    if (
      input.daemonId &&
      existing.daemonId &&
      input.daemonId !== existing.daemonId
    ) {
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
      (!client.bootstrapComplete ||
        (client.daemonId !== undefined &&
          client.ticket !== undefined &&
          this.daemons.has(client.daemonId)))
    );
  }

  private sendDaemonClientClose(
    connectionId: string,
    client: RelayClient,
    code: string,
    reason: string,
  ): void {
    const daemonId = client.daemonId;
    if (!daemonId) {
      return;
    }

    this.daemons.get(daemonId)?.send(
      JSON.stringify({
        code,
        connectionId,
        frameType: AcpRemoteFrameType.Close,
        reason,
      }),
    );
  }

  private handleDaemonPong(connectionId: string, nonce: string): void {
    const daemonId = daemonIdFromDaemonHeartbeatConnectionId(connectionId);
    if (!daemonId) {
      return;
    }
    const heartbeat = this.daemonHeartbeats.get(daemonId);
    if (!heartbeat || heartbeat.pendingNonce !== nonce) {
      return;
    }

    this.daemonHeartbeats.set(daemonId, {
      lastPongAt: this.now().toISOString(),
    });
  }

  private handleDaemonPing(connectionId: string, nonce: string): void {
    const daemonId = daemonIdFromDaemonHeartbeatConnectionId(connectionId);
    const daemon = daemonId ? this.daemons.get(daemonId) : undefined;
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
    if (client.daemonId && client.ticket) {
      return Promise.resolve(client.daemonId);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        client.waiters.delete(resolveSelection);
        resolve(undefined);
      }, this.authWaitMs);
      const resolveSelection = (daemonId: string | undefined) => {
        clearTimeout(timeout);
        resolve(daemonId);
      };
      client.waiters.add(resolveSelection);
    });
  }

  private waitForNextSessionSelection(
    client: RelayClient,
    sessionSelectionId: string,
  ): Promise<RelayAuthorizationSelection | undefined> {
    const pendingSelection = this.consumePendingSessionSelection(
      client,
      sessionSelectionId,
    );
    if (pendingSelection) {
      return Promise.resolve(pendingSelection);
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        client.sessionSelectionWaiters.delete(sessionSelectionId);
        resolve(undefined);
      }, this.authWaitMs);
      const resolveSelection = (
        selection: RelayAuthorizationSelection | undefined,
      ) => {
        clearTimeout(timeout);
        resolve(selection);
      };
      client.sessionSelectionWaiters.set(sessionSelectionId, resolveSelection);
    });
  }

  private consumePendingSessionSelection(
    client: RelayClient,
    sessionSelectionId: string,
  ): RelayAuthorizationSelection | undefined {
    if (client.pendingSessionSelections.has(sessionSelectionId)) {
      const selection = client.pendingSessionSelections.get(sessionSelectionId);
      client.pendingSessionSelections.delete(sessionSelectionId);
      return selection;
    }
    return undefined;
  }

  private clearClientSelectionState(client: RelayClient): void {
    for (const waiter of client.waiters) {
      waiter(undefined);
    }
    client.waiters.clear();
    for (const waiter of client.sessionSelectionWaiters.values()) {
      waiter(undefined);
    }
    client.sessionSelectionWaiters.clear();
    client.pendingSessionSelections.clear();
  }
}

export function createRelayAuthorizationPage(input: {
  accountId: string;
  connectionId: string;
  hosts: readonly { daemonId: string; metadata?: DaemonMetadata }[];
  requestUrl: string;
  unavailableReason?: string;
}): string {
  const hostsJson = scriptJsonLiteral(input.hosts);
  const requestUrlJson = scriptJsonLiteral(input.requestUrl);
  const unavailableReasonJson = scriptJsonLiteral(input.unavailableReason ?? null);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>ACP Runtime Relay — Authorize</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4f1ea;
        --surface: #fbfaf6;
        --surface-2: #f0eee7;
        --ink: #1f2520;
        --muted: #687066;
        --line: #d8d4c8;
        --line-strong: #a9a393;
        --accent: #176b56;
        --accent-ink: #eef8f3;
        --danger: #9f2f2a;
        --focus: #d89b31;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: var(--bg);
        color: var(--ink);
        font: 14px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      button, select { font: inherit; }
      button { cursor: pointer; }
      button:disabled { cursor: not-allowed; opacity: 0.55; }
      .shell {
        display: grid;
        grid-template-rows: auto 1fr auto;
        min-height: 100vh;
      }
      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 18px clamp(18px, 4vw, 40px);
        border-bottom: 1px solid var(--line);
        background: color-mix(in oklch, var(--surface) 88%, var(--bg));
      }
      .title { display: grid; gap: 2px; min-width: 0; }
      h1 { margin: 0; font-size: 1rem; font-weight: 650; letter-spacing: 0; }
      .connection {
        color: var(--muted);
        font-size: 0.82rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: min(64vw, 720px);
      }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.78rem;
      }
      .status-pill {
        border: 1px solid var(--line);
        border-radius: 999px;
        color: var(--muted);
        padding: 6px 10px;
        white-space: nowrap;
      }
      .workspace {
        display: grid;
        grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
        min-height: 0;
      }
      .hosts {
        border-right: 1px solid var(--line);
        padding: 22px clamp(16px, 3vw, 28px);
        background: var(--surface-2);
      }
      .main {
        padding: 22px clamp(18px, 4vw, 44px) 30px;
        min-width: 0;
      }
      .section-head {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 1rem;
        margin-bottom: 12px;
      }
      h2 { margin: 0; font-size: 0.86rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
      .count { color: var(--muted); font-size: 0.82rem; }
      .host-list, .agent-list, .workspace-roots, .workspace-entries {
        display: grid;
        gap: 8px;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .choice {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 7px;
        background: var(--surface);
        color: var(--ink);
        display: grid;
        gap: 4px;
        padding: 11px 12px;
        text-align: left;
        transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
      }
      .choice:hover { border-color: var(--line-strong); background: #fffdf8; transform: translateY(-1px); }
      .choice.selected { border-color: var(--accent); background: #e8f1eb; }
      .choice-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        font-weight: 650;
        min-width: 0;
      }
      .choice-title span:first-child, .path { overflow-wrap: anywhere; }
      .meta { color: var(--muted); font-size: 0.8rem; }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--accent);
        flex: none;
      }
      .config-grid {
        display: grid;
        grid-template-columns: minmax(240px, 360px) minmax(0, 1fr);
        gap: clamp(18px, 4vw, 34px);
        align-items: start;
      }
      .panel {
        display: grid;
        gap: 12px;
        min-width: 0;
      }
      .panel + .panel { margin-top: 24px; }
      .field-label {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        font-size: 0.82rem;
        color: var(--muted);
      }
      select {
        width: 100%;
        min-height: 42px;
        border: 1px solid var(--line);
        border-radius: 7px;
        background: var(--surface);
        color: var(--ink);
        padding: 0 10px;
      }
      .workspace-browser {
        display: grid;
        gap: 12px;
        min-width: 0;
      }
      .workspace-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        border: 1px solid var(--line);
        border-radius: 7px;
        background: var(--surface);
        min-height: 42px;
        padding: 8px 10px;
      }
      .workspace-current { min-width: 0; }
      .workspace-current .path { color: var(--ink); font-size: 0.82rem; }
      .ghost {
        border: 1px solid transparent;
        background: transparent;
        color: var(--accent);
        border-radius: 6px;
        padding: 6px 8px;
        white-space: nowrap;
      }
      .ghost:hover { background: #e8f1eb; }
      .tree {
        border: 1px solid var(--line);
        border-radius: 7px;
        background: var(--surface);
        overflow: hidden;
      }
      .tree-head {
        display: flex;
        gap: 8px;
        align-items: center;
        min-height: 38px;
        padding: 8px 10px;
        border-bottom: 1px solid var(--line);
        color: var(--muted);
        font-size: 0.82rem;
      }
      .workspace-entries { max-height: 330px; overflow: auto; gap: 0; }
      .workspace-entries .choice {
        border: 0;
        border-radius: 0;
        border-bottom: 1px solid var(--line);
        background: transparent;
        transform: none;
      }
      .workspace-entries .choice:last-child { border-bottom: 0; }
      .empty, .error {
        padding: 12px;
        color: var(--muted);
        font-size: 0.86rem;
      }
      .error { color: var(--danger); }
      .notice {
        border: 1px solid var(--line);
        border-radius: 7px;
        background: var(--surface);
        color: var(--muted);
        padding: 12px;
      }
      .notice strong {
        color: var(--ink);
        display: block;
        margin-bottom: 3px;
      }
      .footer {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: stretch;
        justify-content: space-between;
        gap: 1rem;
        padding: 14px clamp(18px, 4vw, 40px);
        border-top: 1px solid var(--line);
        background: color-mix(in oklch, var(--surface) 92%, var(--bg));
      }
      .selection-strip {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
        gap: 10px;
        min-width: 0;
      }
      .selection-card {
        border: 1px solid var(--line);
        border-radius: 7px;
        background: var(--surface);
        min-width: 0;
        padding: 8px 10px;
      }
      .selection-label {
        color: var(--muted);
        font-size: 0.74rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .selection-value {
        color: var(--ink);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin-top: 2px;
      }
      .primary {
        border: 0;
        border-radius: 7px;
        background: var(--accent);
        color: var(--accent-ink);
        min-height: 40px;
        padding: 0 18px;
        font-weight: 650;
        white-space: nowrap;
      }
      .primary:hover { background: #0f604b; }
      .result {
        position: fixed;
        inset: 0;
        display: none;
        place-items: center;
        background: color-mix(in oklch, var(--bg) 82%, transparent);
        padding: 20px;
      }
      .result.active { display: grid; }
      .result-box {
        width: min(440px, 100%);
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        padding: 22px;
      }
      .result-box h2 {
        color: var(--ink);
        font-size: 1rem;
        letter-spacing: 0;
        text-transform: none;
        margin-bottom: 8px;
      }
      @media (max-width: 780px) {
        .workspace { grid-template-columns: 1fr; }
        .hosts { border-right: 0; border-bottom: 1px solid var(--line); }
        .config-grid { grid-template-columns: 1fr; }
        .footer { grid-template-columns: 1fr; }
        .selection-strip { grid-template-columns: 1fr; }
        .selection-value { white-space: normal; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="topbar">
        <div class="title">
          <h1>ACP Relay Authorization</h1>
          <div class="connection">Connection <code>${escapeHtml(input.connectionId)}</code></div>
        </div>
        <div class="status-pill" id="connectionState">Waiting for selection</div>
      </header>

      <main class="workspace">
        <aside class="hosts">
          <div class="section-head">
            <h2>Daemon</h2>
            <span class="count" id="hostCount"></span>
          </div>
          <ul class="host-list" id="hostList"></ul>
        </aside>

        <section class="main">
          <div class="config-grid">
            <div>
              <div class="panel" id="agentSection">
                <div class="section-head">
                  <h2>Agent</h2>
                </div>
                <label class="field-label" for="agentSelect">
                  <span>Runtime launch target</span>
                </label>
                <select id="agentSelect"></select>
              </div>
            </div>

            <div class="panel" id="workspaceSection">
              <div class="section-head">
                <h2>Workspace</h2>
                <span class="count" id="workspaceCount"></span>
              </div>
              <div class="workspace-browser">
                <div id="workspaceRoots" class="workspace-roots"></div>
                <div class="workspace-toolbar">
                  <div class="workspace-current">
                    <div class="meta">Selected path</div>
                    <div id="workspaceCurrent" class="path">No workspace preference</div>
                  </div>
                  <button id="clearWorkspace" class="ghost" type="button">Clear</button>
                </div>
                <div class="tree">
                  <div class="tree-head">
                    <span id="treeLabel">Workspace tree</span>
                  </div>
                  <div id="workspaceEntries" class="workspace-entries">
                    <div class="empty">Select a daemon to browse workspace roots.</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer class="footer">
        <div class="selection-strip" aria-label="Current selection">
          <div class="selection-card">
            <div class="selection-label">Machine / Agent</div>
            <div class="selection-value" id="machineAgentSummary">No daemon selected</div>
          </div>
          <div class="selection-card">
            <div class="selection-label">Workspace</div>
            <div class="selection-value" id="workspaceSummary">No workspace selected</div>
          </div>
        </div>
        <button id="submitAuth" class="primary" disabled>Authorize session</button>
      </footer>
    </div>

    <div id="result" class="result" role="status" aria-live="polite">
      <div class="result-box">
        <h2 id="resultTitle"></h2>
        <p id="resultMessage" class="meta"></p>
      </div>
    </div>

    <script>
    (function() {
      const hosts = ${hostsJson};
      const connectionId = ${scriptJsonLiteral(input.connectionId)};
      const authorizeUrl = ${requestUrlJson};
      const sessionSelectionId = new URL(authorizeUrl, window.location.href).searchParams.get("sessionSelectionId") || "";
      const unavailableReason = ${unavailableReasonJson};
      let selectedHost = null;
      let selectedWorkspaceRoot = "";

      const hostList = document.getElementById("hostList");
      const submitBtn = document.getElementById("submitAuth");
      const agentSelect = document.getElementById("agentSelect");
      const connectionState = document.getElementById("connectionState");
      const machineAgentSummary = document.getElementById("machineAgentSummary");
      const workspaceSummary = document.getElementById("workspaceSummary");
      document.getElementById("hostCount").textContent = hosts.length + (hosts.length === 1 ? " host" : " hosts");

      if (unavailableReason) {
        connectionState.textContent = "Client disconnected";
        hostList.innerHTML = '<li class="notice"><strong>Remote session expired</strong>' + escapeHtml(unavailableReason) + '</li>';
        document.getElementById("workspaceEntries").innerHTML = '<div class="empty">Restart the remote session in your ACP client to create a fresh connection.</div>';
        machineAgentSummary.textContent = "No active client connection";
        workspaceSummary.textContent = "No workspace selected";
        return;
      }

      hosts.forEach(function(host) {
        const li = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "choice";
        let metaText = "No metadata";
        const machineName = displayMachine(host);
        if (host.metadata) {
          var parts = [];
          if (host.metadata.machine) parts.push(host.metadata.machine);
          parts.push(host.metadata.agentTypes.length + (host.metadata.agentTypes.length === 1 ? " agent" : " agents"));
          parts.push(host.metadata.workspaceRoots.length + (host.metadata.workspaceRoots.length === 1 ? " workspace root" : " workspace roots"));
          metaText = parts.join(" · ");
        }
        button.innerHTML = '<div class="choice-title"><span>' + escapeHtml(machineName) + '</span><span class="dot" aria-hidden="true"></span></div><div class="meta">' + escapeHtml(metaText) + '</div>';
        button.onclick = function() {
          selectHost(host, button);
        };
        li.appendChild(button);
        hostList.appendChild(li);
      });

      if (hosts.length === 1) {
        var firstButton = hostList.querySelector("button");
        selectHost(hosts[0], firstButton);
      }

      function selectHost(host, button) {
        selectedHost = host;
        selectedWorkspaceRoot = "";
        hostList.querySelectorAll(".choice").forEach(function(el) { el.classList.remove("selected"); });
        if (button) button.classList.add("selected");
        connectionState.textContent = "Daemon selected";
        submitBtn.disabled = false;
        renderAgentOptions(host.metadata && host.metadata.agentTypes ? host.metadata.agentTypes : []);
        renderWorkspace(host.metadata && host.metadata.workspaceRoots ? host.metadata.workspaceRoots : []);
        updateSummary();
      }

      function renderAgentOptions(agentTypes) {
        agentSelect.innerHTML = "";
        agentTypes.forEach(function(a) {
          var opt = document.createElement("option");
          opt.value = JSON.stringify({
            id: a.id,
            command: a.command,
            type: a.type,
          });
          opt.textContent = a.label || a.id || a.command || "Agent";
          if (a.id) opt.textContent += " · " + a.id;
          if (a.type) opt.textContent += " · " + a.type;
          agentSelect.appendChild(opt);
        });
        var preferredIndex = Array.prototype.findIndex.call(agentSelect.options, function(opt) {
          try {
            var value = JSON.parse(opt.value);
            return value && value.id === ${scriptJsonLiteral(DEFAULT_AGENT_ID)};
          } catch (_) {
            return false;
          }
        });
        if (preferredIndex >= 0) {
          agentSelect.selectedIndex = preferredIndex;
        } else {
          var fallback = document.createElement("option");
          fallback.value = "";
          fallback.textContent = "Default daemon agent";
          agentSelect.insertBefore(fallback, agentSelect.firstChild);
          agentSelect.selectedIndex = 0;
        }
      }

      function renderWorkspace(roots) {
        document.getElementById("workspaceCount").textContent = roots.length + (roots.length === 1 ? " root" : " roots");
        document.getElementById("workspaceCurrent").textContent = "";
        document.getElementById("workspaceEntries").innerHTML = "";
        document.getElementById("workspaceRoots").innerHTML = "";
        document.getElementById("treeLabel").textContent = "Workspace tree";
        if (roots.length === 0) {
          document.getElementById("workspaceCurrent").textContent = "No workspace preference";
          document.getElementById("workspaceEntries").innerHTML = '<div class="empty">This daemon did not advertise workspace roots.</div>';
          return;
        }
        renderWorkspaceRoots(roots);
        selectWorkspacePath(roots[0].path);
        var firstRootButton = document.querySelector("#workspaceRoots .choice");
        if (firstRootButton) firstRootButton.classList.add("selected");
        loadWorkspaceDirectory(roots[0].path, roots[0].path);
      }

      document.getElementById("clearWorkspace").onclick = function() {
        selectedWorkspaceRoot = "";
        document.getElementById("workspaceCurrent").textContent = "No workspace preference";
        document.querySelectorAll(".choice").forEach(function(el) { el.classList.remove("selected"); });
        if (selectedHost) {
          var selectedHostButton = Array.prototype.find.call(hostList.querySelectorAll(".choice"), function(el) {
            return el.textContent.indexOf(displayMachine(selectedHost)) >= 0;
          });
          if (selectedHostButton) selectedHostButton.classList.add("selected");
        }
        updateSummary();
      };
      agentSelect.onchange = updateSummary;

      submitBtn.onclick = function() {
        if (!selectedHost) return;
        submitBtn.disabled = true;
        submitBtn.textContent = "Authorizing...";
        connectionState.textContent = "Authorizing";

        var agentVal = agentSelect.value;
        var agentId = undefined;
        var agentCommand = undefined;
        var agentType = undefined;
        if (agentVal) {
          var selectedAgent = JSON.parse(agentVal);
          agentId = selectedAgent.id;
          agentCommand = selectedAgent.command;
          agentType = selectedAgent.type;
        }
        var workspaceRoots = selectedWorkspaceRoot ? [selectedWorkspaceRoot] : undefined;

        var body = { daemonId: selectedHost.daemonId };
        if (agentId) body.agentId = agentId;
        if (agentCommand) body.agentCommand = agentCommand;
        if (agentType) body.agentType = agentType;
        if (sessionSelectionId) body.sessionSelectionId = sessionSelectionId;
        if (workspaceRoots) body.workspaceRoots = workspaceRoots;

        fetch(authorizeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.ok) {
            document.getElementById("resultTitle").textContent = "Authorized";
            document.getElementById("resultMessage").textContent = "Returning to the client.";
            document.getElementById("result").classList.add("active");
            closeAuthorizationWindow();
          } else {
            showError(data.reason || "Authorization failed.");
            submitBtn.disabled = false;
            submitBtn.textContent = "Authorize session";
            connectionState.textContent = "Authorization failed";
          }
        })
        .catch(function(err) {
          showError("Network error: " + err.message);
          submitBtn.disabled = false;
          submitBtn.textContent = "Authorize session";
          connectionState.textContent = "Network error";
        });
      };

      function renderWorkspaceRoots(roots) {
        var rootsEl = document.getElementById("workspaceRoots");
        rootsEl.innerHTML = "";
        roots.forEach(function(root) {
          var button = document.createElement("button");
          button.type = "button";
          button.className = "choice";
          button.innerHTML = '<div class="choice-title"><span>' + escapeHtml(root.label || root.path) + '</span></div><div class="meta path">' + escapeHtml(root.path) + '</div>';
          button.onclick = function() {
            selectWorkspacePath(root.path);
            button.classList.add("selected");
            loadWorkspaceDirectory(root.path, root.path);
          };
          rootsEl.appendChild(button);
        });
      }

      function selectWorkspacePath(path) {
        selectedWorkspaceRoot = path;
        document.getElementById("workspaceCurrent").textContent = path;
        document.querySelectorAll("#workspaceRoots .choice, #workspaceEntries .choice").forEach(function(el) { el.classList.remove("selected"); });
        updateSummary();
      }

      function loadWorkspaceDirectory(root, path) {
        var entriesEl = document.getElementById("workspaceEntries");
        document.getElementById("treeLabel").textContent = path;
        entriesEl.innerHTML = '<div class="empty">Loading...</div>';
        var url = new URL("/api/daemons/" + encodeURIComponent(selectedHost.daemonId) + "/workspaces", window.location.href);
        url.searchParams.set("connectionId", connectionId);
        url.searchParams.set("root", root);
        url.searchParams.set("path", path);
        fetch(url.toString())
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (!data.ok) {
              entriesEl.innerHTML = '<div class="error">' + escapeHtml(data.reason || "Unable to load workspace tree.") + '</div>';
              return;
            }
            if (!data.entries.length) {
              entriesEl.innerHTML = '<div class="empty">No subdirectories.</div>';
              return;
            }
            entriesEl.innerHTML = "";
            data.entries.forEach(function(entry) {
              var button = document.createElement("button");
              button.type = "button";
              button.className = "choice";
              button.innerHTML = '<div class="choice-title"><span>' + escapeHtml(entry.name) + '</span><span class="meta">Open</span></div><div class="meta path">' + escapeHtml(entry.path) + '</div>';
              button.onclick = function() {
                selectWorkspacePath(entry.path);
                button.classList.add("selected");
                loadWorkspaceDirectory(root, entry.path);
              };
              entriesEl.appendChild(button);
            });
          })
          .catch(function(err) {
            entriesEl.innerHTML = '<div class="error">Network error: ' + escapeHtml(err.message) + '</div>';
          });
      }

      function updateSummary() {
        if (!selectedHost) {
          machineAgentSummary.textContent = "No daemon selected";
          workspaceSummary.textContent = "No workspace selected";
          return;
        }
        var agentLabel = agentSelect.options[agentSelect.selectedIndex] ? agentSelect.options[agentSelect.selectedIndex].textContent : "Default agent";
        machineAgentSummary.textContent = displayMachine(selectedHost) + " · " + agentLabel;
        workspaceSummary.textContent = selectedWorkspaceRoot || "No workspace preference";
      }

      function displayMachine(host) {
        return host && host.metadata && host.metadata.machine
          ? host.metadata.machine
          : host.daemonId;
      }

      function showError(message) {
        document.getElementById("resultTitle").textContent = "Authorization failed";
        document.getElementById("resultMessage").textContent = message;
        document.getElementById("result").classList.add("active");
        window.setTimeout(function() {
          document.getElementById("result").classList.remove("active");
        }, 2600);
      }

      function closeAuthorizationWindow() {
        var closeAttempts = 0;
        var tryClose = function() {
          closeAttempts += 1;
          window.close();
          window.open("", "_self");
          window.close();
          if (closeAttempts < 3) {
            window.setTimeout(tryClose, 180);
          }
        };
        tryClose();
        window.setTimeout(function() {
          document.getElementById("resultMessage").textContent = "Authorized. You can close this window.";
        }, 900);
      }

      function escapeHtml(s) {
        var d = document.createElement("div");
        d.textContent = s;
        return d.innerHTML;
      }
    })();
    </script>
  </body>
</html>`;
}

export function createRelayAuthorizationResultPage(
  result: AcpRelayAuthorizationResult,
): string {
  if (result.ok) {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>ACP Runtime Relay</title>
    <style>
      body {
        display: grid;
        min-height: 100vh;
        margin: 0;
        place-items: center;
        background: #f4f1ea;
        color: #1f2520;
        font: 14px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(420px, calc(100vw - 32px));
        border: 1px solid #d8d4c8;
        border-radius: 8px;
        background: #fbfaf6;
        padding: 22px;
      }
      h1 { margin: 0 0 8px; font-size: 1rem; }
      p { margin: 0; color: #687066; }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.78rem;
      }
    </style>
    <script>
      function closeAuthorizationWindow() {
        var attempts = 0;
        var tryClose = function() {
          attempts += 1;
          window.close();
          window.open("", "_self");
          window.close();
          if (attempts < 3) window.setTimeout(tryClose, 180);
        };
        tryClose();
        window.setTimeout(function() {
          var message = document.getElementById("message");
          if (message) message.textContent = "Authorized. You can close this window.";
        }, 900);
      }
      window.addEventListener("load", closeAuthorizationWindow);
    </script>
  </head>
  <body>
    <main>
      <h1>Authorized</h1>
      <p id="message">Returning to the client.</p>
    </main>
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
    if (!isRecord(value) || value.jsonrpc !== "2.0") {
      return undefined;
    }
    if (isJsonRpcResponsePayload(value)) {
      return value;
    }
    if (typeof value.method !== "string") {
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
  return (
    "method" in message &&
    typeof message.method === "string" &&
    "id" in message
  );
}

function isConnectedClient(client: RelayClient): client is ConnectedRelayClient {
  return client.socket !== undefined;
}

function createClientStateSnapshot(
  connectionId: string,
  client: RelayClient,
): AcpRelayClientStateSnapshot {
  return {
    bootstrapComplete: client.bootstrapComplete,
    bufferedClientPayloads: [...client.bufferedClientPayloads],
    clientPendingFrames: [...client.clientPendingFrames.values()].sort(
      (left, right) => left.seq - right.seq,
    ),
    completedClientResponses: [...client.completedClientResponses.values()],
    connectionId,
    daemonId: client.daemonId,
    daemonPendingFrames: [...client.daemonPendingFrames.values()].sort(
      (left, right) => left.seq - right.seq,
    ),
    daemonQueuedFrames: [...client.daemonQueuedFrames],
    daemonRequests: [...client.daemonRequests.values()],
    daemonRuntimeInstanceId: client.daemonRuntimeInstanceId,
    initializeParams: client.initializeParams,
    lastAuthorization: client.lastAuthorization,
    lastDaemonSeq: client.lastDaemonSeq,
    seq: client.seq,
    sessionControlRequests: [...client.sessionControlRequests.values()],
    ticket: client.ticket,
  };
}

function framesToSeqMap(
  frames: readonly AcpRemoteDataFrame[] | undefined,
): Map<number, AcpRemoteDataFrame> {
  return new Map((frames ?? []).map((frame) => [frame.seq, frame] as const));
}

function requestsToIdMap(
  requests: readonly RelayJsonRpcRequest[] | undefined,
): Map<string | number, RelayJsonRpcRequest> {
  const entries: [string | number, RelayJsonRpcRequest][] = [];
  for (const request of requests ?? []) {
    if (isStoredJsonRpcId(request.id)) {
      entries.push([request.id, request]);
    }
  }
  return new Map(entries);
}

function responsesToIdMap(
  responses: readonly RelayJsonRpcResponse[] | undefined,
): Map<string | number, RelayJsonRpcResponse> {
  const entries: [string | number, RelayJsonRpcResponse][] = [];
  for (const response of responses ?? []) {
    if (isStoredJsonRpcId(response.id)) {
      entries.push([response.id, response]);
    }
  }
  return new Map(entries.slice(-DEFAULT_COMPLETED_RESPONSE_CACHE_LIMIT));
}

function sessionControlRequestsToKeyMap(
  requests: readonly RelayJsonRpcRequest[] | undefined,
): Map<string, RelayJsonRpcRequest> {
  const entries: [string, RelayJsonRpcRequest][] = [];
  for (const request of requests ?? []) {
    const key = sessionControlRequestKey(request);
    if (key) {
      entries.push([key, request]);
    }
  }
  return new Map(entries);
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
  client.daemonRequests.delete(id);
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
  if (isJsonRpcResponsePayload(payload)) {
    return undefined;
  }
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
  if (isJsonRpcResponsePayload(value)) {
    return true;
  }
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

function readRelayTransportPayloadDetails(
  payload: unknown,
  client: RelayClient,
): {
  hasError: boolean;
  id?: string | number;
  method?: string;
  sessionId?: string;
  traceContext?: AcpRemoteTraceContext;
} {
  if (!isRecord(payload)) {
    return {
      hasError: false,
    };
  }
  const response = isJsonRpcResponsePayload(payload) ? payload : undefined;
	  const pendingRequest =
	    response && isStoredJsonRpcId(response.id)
	      ? client.daemonRequests.get(response.id)
	      : undefined;
  const traceContext =
    readAcpRemoteTraceContextFromJsonRpcMessage(payload) ??
    (pendingRequest
      ? readAcpRemoteTraceContextFromJsonRpcMessage(pendingRequest)
      : undefined);
  const method =
    typeof payload.method === "string" ? payload.method : pendingRequest?.method;
  const sessionId =
    readPayloadSessionId(payload) ??
    (pendingRequest ? readRequestSessionId(pendingRequest) : undefined);
  return {
    hasError: Object.prototype.hasOwnProperty.call(payload, "error"),
    id: isStoredJsonRpcId(payload.id) ? payload.id : undefined,
    method,
    sessionId,
    traceContext,
  };
}

function readPayloadSessionId(payload: Record<string, unknown>): string | undefined {
  const params = isRecord(payload.params) ? payload.params : undefined;
  const result = isRecord(payload.result) ? payload.result : undefined;
  return readString(params?.sessionId) ?? readString(result?.sessionId);
}

function isJsonRpcRequestPayload(value: unknown): value is RelayJsonRpcRequest {
  return isRelayJsonRpcMessage(value) && isJsonRpcRequest(value);
}

function isJsonRpcResponsePayload(value: unknown): value is RelayJsonRpcResponse {
  return (
    isRecord(value) &&
    value.jsonrpc === "2.0" &&
    (typeof value.id === "string" ||
      typeof value.id === "number" ||
      value.id === null) &&
    (Object.prototype.hasOwnProperty.call(value, "result") ||
      Object.prototype.hasOwnProperty.call(value, "error"))
  );
}

function isStoredJsonRpcId(id: unknown): id is string | number {
  return typeof id === "string" || typeof id === "number";
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

function isSessionOpenRequest(
  message: RelayJsonRpcMessage,
): message is RelayJsonRpcRequest {
  return (
    isJsonRpcRequest(message) &&
    (message.method === "session/new" ||
      message.method === "session/load" ||
      message.method === "session/resume")
  );
}

function isSessionRestoreRequest(message: RelayJsonRpcMessage): boolean {
  return (
    isJsonRpcRequest(message) &&
    (message.method === "session/load" || message.method === "session/resume")
  );
}

function isReplayableDaemonRequestAfterRuntimeRestart(
  request: RelayJsonRpcRequest,
): boolean {
  return request.method === "session/load" || request.method === "session/resume";
}

function isSessionBoundRuntimeRequest(
  message: RelayJsonRpcMessage,
): message is RelayJsonRpcRequest {
  return (
    isJsonRpcRequest(message) &&
    message.method.startsWith("session/") &&
    message.method !== "session/new" &&
    readRequestSessionId(message) !== undefined
  );
}

function isNativeClientAck(
  message: RelayJsonRpcMessage,
): message is RelayJsonRpcNotification {
  return (
    "method" in message &&
    !isJsonRpcRequest(message) &&
    message.method === NATIVE_CLIENT_ACK_METHOD
  );
}

function shouldDeferNativeClientAck(
  client: RelayClient,
  frame: AcpRemoteDataFrame,
): boolean {
  return (
    client.transport === "native-acp" &&
    client.nativeClientAck &&
    frame.channelKind === AcpRemoteChannelKind.Acp &&
    (isJsonRpcResponsePayload(frame.payload) ||
      isNativeAckableJsonRpcPayload(frame.payload))
  );
}

function nativeAcpPayloadForClient(
  client: RelayClient,
  frame: AcpRemoteDataFrame,
): unknown {
  if (
    client.transport !== "native-acp" ||
    !client.nativeClientAck ||
    frame.channelKind !== AcpRemoteChannelKind.Acp ||
    isJsonRpcResponsePayload(frame.payload) ||
    !isNativeAckableJsonRpcPayload(frame.payload)
  ) {
    return frame.payload;
  }
  const payload = frame.payload;
  const params = isRecord(payload.params) ? { ...payload.params } : {};
  const meta = isRecord(params._meta) ? { ...params._meta } : {};
  return {
    ...payload,
    params: {
      ...params,
      _meta: {
        ...meta,
        [NATIVE_CLIENT_ACK_SEQ_META]: frame.seq,
      },
    },
  };
}

function isNativeAckableJsonRpcPayload(
  value: unknown,
): value is RelayJsonRpcNotification | RelayJsonRpcRequest {
  return isRelayJsonRpcMessage(value) && !isJsonRpcResponsePayload(value);
}

function readNativeClientAckId(
  message: RelayJsonRpcNotification,
): string | number | undefined {
  const params = isRecord(message.params) ? message.params : undefined;
  const id = params?.id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

function readNativeClientAckSeq(
  message: RelayJsonRpcNotification,
): number | undefined {
  const params = isRecord(message.params) ? message.params : undefined;
  const seq = params?.seq;
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0
    ? seq
    : undefined;
}

function isSessionNewRequest(
  message: RelayJsonRpcRequest,
): boolean {
  return message.method === "session/new";
}

function readSessionSelectionId(request: RelayJsonRpcRequest): string {
  const params = isRecord(request.params) ? request.params : undefined;
  const meta = isRecord(params?._meta) ? params._meta : undefined;
  return normalizeSessionSelectionId(
    readString(meta?.[ACP_REMOTE_SESSION_SELECTION_ID_META]),
  );
}

function readRequestSessionId(request: RelayJsonRpcRequest): string | undefined {
  const params = isRecord(request.params) ? request.params : undefined;
  return readString(params?.sessionId);
}

function readRequestConfigId(request: RelayJsonRpcRequest): string | undefined {
  const params = isRecord(request.params) ? request.params : undefined;
  return readString(params?.configId);
}

function sessionControlRequestKey(
  request: RelayJsonRpcRequest,
): string | undefined {
  const sessionId = readRequestSessionId(request);
  if (!sessionId) {
    return undefined;
  }
  if (request.method === "session/set_mode") {
    return `${sessionId}:mode`;
  }
  if (request.method !== "session/set_config_option") {
    return undefined;
  }
  const configId = readRequestConfigId(request);
  return configId ? `${sessionId}:config:${configId}` : undefined;
}

function sessionControlReplayOrder(request: RelayJsonRpcRequest): number {
  return request.method === "session/set_mode" ? 0 : 1;
}

function readResultSessionId(result: unknown): string | undefined {
  return isRecord(result) ? readString(result.sessionId) : undefined;
}

function readSessionBindingMetadata(
  result: unknown,
): RelayAuthorizationSelection | undefined {
  const meta = isRecord(result) && isRecord(result._meta) ? result._meta : undefined;
  if (!meta) {
    return undefined;
  }
  const daemonId = readString(meta[ACP_REMOTE_DAEMON_ID_META]);
  if (!daemonId) {
    return undefined;
  }
  return {
    agent: readSessionAgent(meta[REMOTE_SESSION_AGENT_META]),
    daemonId,
    workspaceRoots: readStringArray(meta[REMOTE_SESSION_WORKSPACE_ROOTS_META]),
  };
}

function normalizeSessionSelectionId(value: string | undefined): string {
  return value && value.trim() ? value : DEFAULT_SESSION_SELECTION_ID;
}

function readSessionRestoreSelection(
  request: RelayJsonRpcRequest,
): RelayAuthorizationSelection | undefined {
  const params = isRecord(request.params) ? request.params : undefined;
  const meta = isRecord(params?._meta) ? params._meta : undefined;
  if (!meta) {
    return undefined;
  }
  const daemonId = readString(meta[ACP_REMOTE_DAEMON_ID_META]);
  if (!daemonId) {
    return undefined;
  }
  return {
    agent: readSessionAgent(meta[REMOTE_SESSION_AGENT_META]),
    daemonId,
    workspaceRoots: readStringArray(meta[REMOTE_SESSION_WORKSPACE_ROOTS_META]),
  };
}

function readSessionAgent(value: unknown): AcpRemoteAgentGrant | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = readString(value.id);
  if (id) {
    return { id };
  }
  const command = readString(value.command);
  if (!command) {
    return undefined;
  }
  const args = readStringArray(value.args);
  const env = readOptionalStringRecord(value.env);
  const type = readString(value.type);
  return {
    command,
    ...(args && { args }),
    ...(env && { env }),
    ...(type && { type }),
  };
}

function applySessionSelection(
  request: RelayJsonRpcRequest,
  selection: RelayAuthorizationSelection,
): RelayJsonRpcRequest {
  const params = isRecord(request.params) ? { ...request.params } : {};
  const meta = isRecord(params._meta) ? { ...params._meta } : {};
  if (selection.agent) {
    meta[REMOTE_SESSION_AGENT_META] = selection.agent;
  }
  if (selection.workspaceRoots?.length) {
    meta[REMOTE_SESSION_WORKSPACE_ROOTS_META] = selection.workspaceRoots;
    params.cwd = selection.workspaceRoots[0];
  }
  return {
    ...request,
    params: {
      ...params,
      _meta: meta,
    },
  };
}

function daemonHeartbeatConnectionId(daemonId: string): string {
  return `daemon:${daemonId}`;
}

function daemonIdFromDaemonHeartbeatConnectionId(
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

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
  );
  return strings.length ? strings : undefined;
}

function readOptionalStringRecord(
  value: unknown,
): Record<string, string | undefined> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string | undefined] =>
      typeof entry[1] === "string" || entry[1] === undefined,
  );
  return entries.length === Object.keys(value).length
    ? Object.fromEntries(entries)
    : undefined;
}

function asWorkspaceListResponse(
  value: unknown,
): DaemonWorkspaceListResult | undefined {
  if (!isRecord(value) || value.kind !== "workspace/list/result") {
    return undefined;
  }
  if (value.ok === false && typeof value.reason === "string") {
    return { ok: false, reason: value.reason };
  }
  if (value.ok !== true || typeof value.path !== "string") {
    return undefined;
  }
  const entries = Array.isArray(value.entries)
    ? value.entries.filter(
        (entry): entry is DaemonWorkspaceEntry =>
          isRecord(entry) &&
          entry.type === "directory" &&
          typeof entry.name === "string" &&
          typeof entry.path === "string",
      )
    : [];
  return {
    entries,
    ok: true,
    path: value.path,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function scriptJsonLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003C")
    .replaceAll(">", "\\u003E")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
