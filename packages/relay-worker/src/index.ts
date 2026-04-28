import {
  ACP_REMOTE_PROTOCOL_VERSION,
  AcpRemoteEndpointKind,
  AcpRemoteFrameType,
  type AcpRemoteScope,
  type AcpRemoteSignedDeviceRenewalProof,
} from "../../../src/runtime/remote/protocol/index.js";
import {
  verifyAcpRelayAccountSessionToken,
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
  AcpRelayBroker,
  createRelayAuthorizationPage,
  createRelayAuthorizationResultPage,
} from "./relay-core.js";

export type Env = {
  ACP_RELAY_ACCOUNT_SESSION_SECRET?: string;
  ACP_RELAY_CONTROL_PLANE_SECRET?: string;
  ACP_RELAY_CLIENT_RECONNECT_GRACE_MS?: string;
  ACP_RELAY_DAEMON_RECONNECT_GRACE_MS?: string;
  ACP_RELAY_DB?: D1Database;
  ACP_RELAY_HEARTBEAT_INTERVAL_MS?: string;
  ACP_RELAY_HEARTBEAT_TIMEOUT_MS?: string;
  ACP_RELAY_LOGIN_URL?: string;
  ACP_RELAY_MAX_BUFFERED_FRAMES_PER_CONNECTION?: string;
  ACP_RELAY_MAX_CONNECTIONS_PER_ACCOUNT?: string;
  ACP_RELAY_SHARDS: DurableObjectNamespace;
  ACP_RELAY_TICKET_KID?: string;
  ACP_RELAY_TICKET_SECRET?: string;
};

const UPGRADE_REQUIRED = "Expected WebSocket upgrade.";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (url.pathname.startsWith("/control-plane/")) {
      return handleControlPlaneRequest(request, env, url);
    }

    if (url.pathname === "/renew") {
      return routeDeviceRenewalRequest(request, env);
    }

    if (
      url.pathname !== "/acp" &&
      url.pathname !== "/client" &&
      url.pathname !== "/daemon" &&
      url.pathname !== "/authorize"
    ) {
      return new Response("Not found.", { status: 404 });
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
      const clientDeviceId =
        resolveClientDeviceId(request, url) ??
        accountSession.session.clientDeviceId;
      if (!clientDeviceId) {
        return new Response("Missing client device id.", { status: 400 });
      }
      if (
        accountSession.session.clientDeviceId &&
        accountSession.session.clientDeviceId !== clientDeviceId
      ) {
        return new Response(
          "ACP relay account session does not match requested client device.",
          { status: 403 },
        );
      }
      if (!resolveHostId(request, url)) {
        return new Response("Missing host id.", { status: 400 });
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

    if (url.pathname === "/daemon" && !resolveHostId(request, url)) {
      return new Response("Missing host id.", { status: 400 });
    }

    const accountId = resolveAccountId(request, url);
    if (url.pathname === "/daemon") {
      const hostId = resolveHostId(request, url);
      if (!hostId) {
        return new Response("Missing host id.", { status: 400 });
      }
      const proof = await verifyDaemonRegistrationRequest({
        accountId,
        env,
        hostId,
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

  constructor(
    private readonly state: DurableObjectState,
    env: Env,
  ) {
    this.heartbeatIntervalMs = readOptionalPositiveInteger(
      env.ACP_RELAY_HEARTBEAT_INTERVAL_MS,
    );
    this.broker = new AcpRelayBroker({
      controlPlaneStore: env.ACP_RELAY_DB
        ? new AcpRelayD1ControlPlaneStore(env.ACP_RELAY_DB)
        : undefined,
      clientReconnectGraceMs: readOptionalPositiveInteger(
        env.ACP_RELAY_CLIENT_RECONNECT_GRACE_MS,
      ),
      daemonReconnectGraceMs: readOptionalPositiveInteger(
        env.ACP_RELAY_DAEMON_RECONNECT_GRACE_MS,
      ),
      heartbeatTimeoutMs: readOptionalPositiveInteger(
        env.ACP_RELAY_HEARTBEAT_TIMEOUT_MS,
      ),
      maxBufferedFramesPerConnection: readOptionalPositiveInteger(
        env.ACP_RELAY_MAX_BUFFERED_FRAMES_PER_CONNECTION,
      ),
      maxConnectionsPerAccount: readOptionalPositiveInteger(
        env.ACP_RELAY_MAX_CONNECTIONS_PER_ACCOUNT,
      ),
      ticketSigningKey: env.ACP_RELAY_TICKET_SECRET
        ? {
            kid: env.ACP_RELAY_TICKET_KID ?? "relay-local",
            secret: env.ACP_RELAY_TICKET_SECRET,
          }
        : undefined,
    });
  }

  async alarm(): Promise<void> {
    this.broker.closeUnresponsiveDaemons();
    this.broker.closeExpiredDisconnectedDaemons();
    this.broker.closeExpiredDisconnectedClients();
    this.broker.pingDaemons();
    await this.scheduleHeartbeat();
  }

  async fetch(request: Request): Promise<Response> {
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
    const hostId = resolveHostId(request, url);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    if (endpoint === AcpRemoteEndpointKind.Daemon) {
      if (!hostId) {
        server.close(1008, "Missing host id.");
      } else {
        this.broker.registerDaemon(hostId, server);
        void this.scheduleHeartbeat();
      }
    } else {
      const accountId =
        clientTransport === "remote-frame"
          ? (resolveVerifiedAccountId(request) ?? resolveAccountId(request, url))
          : resolveAccountId(request, url);
      this.broker.registerClient({
        accountId,
        authUrl: createAuthorizationUrl(request, connectionId).toString(),
        clientDeviceId: resolveClientDeviceId(request, url),
        connectionId,
        hostId,
        socket: server,
        transport: clientTransport,
      });
      if (clientTransport === "remote-frame") {
        if (!hostId) {
          server.close(1008, "Missing host id.");
        } else {
          const result = await this.broker.authorizeClient({
            connectionId,
            hostId,
          });
          if (!result.ok) {
            server.close(1008, result.reason);
          } else {
            server.send(
              JSON.stringify({
                connectionId,
                endpoint: AcpRemoteEndpointKind.Daemon,
                frameType: AcpRemoteFrameType.Hello,
                hostId,
                protocolVersion: ACP_REMOTE_PROTOCOL_VERSION,
                ticket: result.ticket,
              }),
            );
          }
        }
      }
    }

    server.addEventListener("message", (event) => {
      const text = normalizeMessageData(event.data);
      if (!text) {
        return;
      }
      if (endpoint === AcpRemoteEndpointKind.Daemon) {
        this.broker.handleDaemonText(text);
      } else {
        void this.broker.handleClientText(connectionId, text);
      }
    });
    server.addEventListener("close", () => {
      this.removeSocket(endpoint, connectionId, hostId, server);
    });
    server.addEventListener("error", () => {
      this.removeSocket(endpoint, connectionId, hostId, server);
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket });
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

    const hostId = resolveHostId(request, url);
    if (!hostId) {
      return html(
        createRelayAuthorizationPage({
          accountId,
          connectionId,
          hosts: await this.broker.authorizableHostIds(connectionId),
          requestUrl: request.url,
        }),
      );
    }

    const result = await this.broker.authorizeClient({ connectionId, hostId });
    return html(createRelayAuthorizationResultPage(result), {
      status: result.ok ? 200 : 404,
    });
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
    return json(result, { status: result.ok ? 200 : 401 });
  }

  private removeSocket(
    endpoint: AcpRemoteEndpointKind,
    connectionId: string,
    hostId: string | undefined,
    socket: WebSocket,
  ): void {
    if (endpoint === AcpRemoteEndpointKind.Daemon) {
      if (hostId) {
        this.broker.removeDaemon(hostId, socket);
      }
      return;
    }

    this.broker.removeClient(connectionId, socket);
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
    return json({
      closedConnectionIds,
      ok: true,
    });
  }
}

function resolveHostId(request: Request, url: URL): string | undefined {
  return (
    url.searchParams.get("hostId") ??
    request.headers.get("x-acp-host-id") ??
    undefined
  );
}

function resolveClientDeviceId(
  request: Request,
  url: URL,
): string | undefined {
  return (
    url.searchParams.get("clientDeviceId") ??
    request.headers.get("x-acp-client-device-id") ??
    request.headers.get("x-acp-verified-client-device-id") ??
    undefined
  );
}

function resolveAccountId(request: Request, url: URL): string {
  return (
    url.searchParams.get("accountId") ??
    request.headers.get("x-acp-account-id") ??
    "default"
  );
}

function resolveRequestedAccountId(
  request: Request,
  url: URL,
): string | undefined {
  return (
    url.searchParams.get("accountId") ??
    request.headers.get("x-acp-account-id") ??
    undefined
  );
}

function resolveVerifiedAccountId(request: Request): string | undefined {
  return request.headers.get("x-acp-verified-account-id") ?? undefined;
}

function withVerifiedAccountSession(
  request: Request,
  session: AcpRelayAccountSession,
): Request {
  const headers = new Headers(request.headers);
  headers.set("x-acp-verified-account-id", session.accountId);
  headers.set("x-acp-account-session-id", session.sessionId);
  if (session.clientDeviceId) {
    headers.set("x-acp-verified-client-device-id", session.clientDeviceId);
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
  return readCookie(request.headers.get("cookie"), "acp_relay_session");
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
  hostId: string;
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
  const host = input.env.ACP_RELAY_DB
    ? await new AcpRelayD1ControlPlaneStore(input.env.ACP_RELAY_DB).getHost({
        accountId: input.accountId,
        hostId: input.hostId,
      })
    : undefined;
  if (input.env.ACP_RELAY_DB && (!host || host.disabled)) {
    return { ok: false, reason: "Host is not registered for this account." };
  }

  const hostPublicKeys = [host?.publicKey, host?.previousPublicKey].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (hostPublicKeys.length > 0) {
    return verifyDaemonRegistrationProof({
      accountId: input.accountId,
      hostId: input.hostId,
      nonce: input.request.headers.get("x-acp-daemon-nonce") ?? "",
      publicKeys: hostPublicKeys,
      signature: input.request.headers.get("x-acp-daemon-signature") ?? "",
      timestamp: input.request.headers.get("x-acp-daemon-timestamp") ?? "",
    });
  }

  return {
    ok: false,
    reason: "Host key is not provisioned for this daemon.",
  };
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

  const clientDeviceId = readRequiredString(record, "clientDeviceId");
  if (!clientDeviceId.ok) {
    return clientDeviceId;
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
      clientDeviceId: clientDeviceId.value,
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

  const hostId = readRequiredString(record, "hostId");
  if (!hostId.ok) {
    return hostId;
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
      hostId: hostId.value,
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

  const clientDeviceId = readOptionalString(record, "clientDeviceId");
  if (!clientDeviceId.ok) {
    return clientDeviceId;
  }

  const hostId = readRequiredString(record, "hostId");
  if (!hostId.ok) {
    return hostId;
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
      clientDeviceId: clientDeviceId.value,
      grantId: grantId.value,
      hostId: hostId.value,
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

  const clientDeviceId = readRequiredString(record, "clientDeviceId");
  if (!clientDeviceId.ok) {
    return clientDeviceId;
  }

  const connectionId = readRequiredString(record, "connectionId");
  if (!connectionId.ok) {
    return connectionId;
  }

  const hostId = readRequiredString(record, "hostId");
  if (!hostId.ok) {
    return hostId;
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
      clientDeviceId: clientDeviceId.value,
      connectionId: connectionId.value,
      hostId: hostId.value,
      nonce: nonce.value,
      signature: signature.value,
      ticketJti: ticketJti.value,
      timestamp: timestamp.value,
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
