import { describe, expect, it, vi } from "vitest";

import {
  AcpRemoteChannelKind,
  AcpRemoteEndpointKind,
  AcpRemoteFrameType,
  createAcpRemoteDeviceKeyPair,
  createAcpRemoteDeviceRenewalSignature,
  createAcpRemoteSignedConnectionTicket,
  type AcpRemoteDataFrame,
} from "../../../src/runtime/remote/protocol/index.js";
import { createMemoryWebSocketPair } from "../../../src/runtime/remote/shared/test-helpers.js";
import { createAcpRelayAccountSessionToken } from "./account-session.js";
import {
  AcpRelayD1ControlPlaneStore,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1Value,
} from "./control-plane-store.js";
import {
  createDaemonRegistrationKeyPair,
  createDaemonRegistrationKeySignature,
} from "./daemon-auth.js";
import worker, { AcpRelayShard, type Env } from "./index.js";

describe("relay worker control-plane endpoints", () => {
  it("requires a control-plane secret", async () => {
    const response = await worker.fetch(
      new Request("https://relay.test/control-plane/accounts", {
        body: JSON.stringify({ accountId: "acct-1" }),
        method: "POST",
      }),
      createEnv(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Unauthorized.",
    });
  });

  it("writes account, device, host, and grant metadata to D1", async () => {
    const database = new FakeD1Database({
      accounts: [],
      clientDevices: [],
      grants: [],
      hosts: [],
    });
    const env = createEnv({ ACP_RELAY_DB: database as unknown as D1Database });

    for (const [path, body] of [
      ["/control-plane/accounts", { accountId: "acct-1" }],
      [
        "/control-plane/client-devices",
        {
          accountId: "acct-1",
          clientId: "client-1",
          publicKey: "client-public-key",
        },
      ],
      [
        "/control-plane/hosts",
        {
          accountId: "acct-1",
          daemonId: "host-1",
          publicKey: "host-public-key",
        },
      ],
      [
        "/control-plane/grants",
        {
          accountId: "acct-1",
          clientId: "client-1",
          grantId: "grant-1",
          daemonId: "host-1",
          policyVersion: 3,
          scopes: ["acp:connect", "acp:session:list"],
          workspaceRoots: ["/work/project"],
        },
      ],
    ] as const) {
      const response = await worker.fetch(
        new Request(`https://relay.test${path}`, {
          body: JSON.stringify(body),
          headers: { authorization: "Bearer control-plane-secret" },
          method: "POST",
        }),
        env,
      );
      expect(response.status).toBe(200);
    }

    const store = new AcpRelayD1ControlPlaneStore(database);
    await expect(
      store.resolveGrant({
        accountId: "acct-1",
        clientId: "client-1",
        daemonId: "host-1",
        requiredScopes: ["acp:session:list"],
      }),
    ).resolves.toMatchObject({
      grant: {
        daemonId: "host-1",
        policyVersion: 3,
        workspaceRoots: ["/work/project"],
      },
      ok: true,
    });
  });

  it("triggers shard reconcile after control-plane mutations", async () => {
    const database = new FakeD1Database({
      accounts: [],
      clientDevices: [],
      grants: [],
      hosts: [],
    });
    const routedRequests: Request[] = [];
    const env = createEnv({
      ACP_RELAY_DB: database as unknown as D1Database,
      ACP_RELAY_SHARDS: {
        get() {
          return {
            async fetch(request: Request) {
              routedRequests.push(request);
              return new Response(
                JSON.stringify({
                  closedConnectionIds: ["conn-1"],
                  ok: true,
                }),
                {
                  headers: {
                    "content-type": "application/json; charset=utf-8",
                  },
                  status: 200,
                },
              );
            },
          };
        },
        idFromName() {
          return {} as DurableObjectId;
        },
      } as DurableObjectNamespace,
    });

    const response = await worker.fetch(
      new Request("https://relay.test/control-plane/grants", {
        body: JSON.stringify({
          accountId: "acct-1",
          clientId: "client-1",
          grantId: "grant-1",
          daemonId: "host-1",
          policyVersion: 3,
          revoked: true,
          scopes: ["acp:connect"],
        }),
        headers: { authorization: "Bearer control-plane-secret" },
        method: "POST",
      }),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      closedConnectionIds: ["conn-1"],
      ok: true,
    });
    expect(routedRequests).toHaveLength(1);
    expect(routedRequests[0].method).toBe("POST");
    expect(new URL(routedRequests[0].url).pathname).toBe(
      "/internal/reconcile-authorizations",
    );
    expect(new URL(routedRequests[0].url).searchParams.get("accountId")).toBe(
      "acct-1",
    );
  });

  it("requires an account session before routing authorization UI", async () => {
    const response = await worker.fetch(
      new Request(
        "https://relay.test/authorize?accountId=acct-1&connectionId=conn-1",
      ),
      createRoutedEnv({
        ACP_RELAY_ACCOUNT_SESSION_SECRET: "account-session-secret",
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toContain("Sign in required");
  });

  it("redirects native authorization UI to the configured login URL", async () => {
    const response = await worker.fetch(
      new Request(
        "https://relay.test/authorize?accountId=acct-1&connectionId=conn-1",
      ),
      createRoutedEnv({
        ACP_RELAY_ACCOUNT_SESSION_SECRET: "account-session-secret",
        ACP_RELAY_LOGIN_URL: "https://app.test/login",
      }),
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toBeTruthy();
    const redirect = new URL(location ?? "https://missing.test");
    expect(redirect.origin).toBe("https://app.test");
    expect(redirect.pathname).toBe("/login");
    expect(redirect.searchParams.get("accountId")).toBe("acct-1");
    expect(redirect.searchParams.get("returnTo")).toBe(
      "https://relay.test/authorize?accountId=acct-1&connectionId=conn-1",
    );
  });

  it("routes authorization UI by the verified account session", async () => {
    const token = await createAcpRelayAccountSessionToken({
      secret: "account-session-secret",
      session: {
        accountId: "acct-1",
        expiresAt: "2099-04-28T00:00:00.000Z",
        sessionId: "session-1",
      },
    });
    const routedRequests: Request[] = [];
    const env = createRoutedEnv({
      ACP_RELAY_ACCOUNT_SESSION_SECRET: "account-session-secret",
      ACP_RELAY_SHARDS: {
        get() {
          return {
            async fetch(request: Request) {
              routedRequests.push(request);
              return new Response("routed", { status: 299 });
            },
          };
        },
        idFromName(name: string) {
          expect(name).toBe("account:acct-1");
          return {} as DurableObjectId;
        },
      } as DurableObjectNamespace,
    });

    const response = await worker.fetch(
      new Request(
        "https://relay.test/authorize?accountId=acct-1&connectionId=conn-1",
        {
          headers: {
            authorization: `Bearer ${token}`,
          },
        },
      ),
      env,
    );

    expect(response.status).toBe(299);
    expect(routedRequests).toHaveLength(1);
    expect(routedRequests[0].headers.get("x-acp-verified-account-id")).toBe(
      "acct-1",
    );
  });

  it("accepts account session token query on localhost OAuth return requests", async () => {
    const token = await createAcpRelayAccountSessionToken({
      secret: "account-session-secret",
      session: {
        accountId: "acct-1",
        expiresAt: "2099-04-28T00:00:00.000Z",
        sessionId: "session-1",
      },
    });
    const routedRequests: Request[] = [];
    const env = createRoutedEnv({
      ACP_RELAY_ACCOUNT_SESSION_SECRET: "account-session-secret",
      ACP_RELAY_SHARDS: {
        get() {
          return {
            async fetch(request: Request) {
              routedRequests.push(request);
              return new Response("routed", { status: 299 });
            },
          };
        },
        idFromName(name: string) {
          expect(name).toBe("account:acct-1");
          return {} as DurableObjectId;
        },
      } as DurableObjectNamespace,
    });

    const response = await worker.fetch(
      new Request(
        `http://localhost:8787/authorize?accountId=acct-1&connectionId=conn-1&token=${encodeURIComponent(token)}`,
      ),
      env,
    );

    expect(response.status).toBe(299);
    expect(routedRequests).toHaveLength(1);
    expect(routedRequests[0].headers.get("x-acp-verified-account-id")).toBe(
      "acct-1",
    );
  });

  it("does not accept account session token query on non-local relay URLs", async () => {
    const token = await createAcpRelayAccountSessionToken({
      secret: "account-session-secret",
      session: {
        accountId: "acct-1",
        expiresAt: "2099-04-28T00:00:00.000Z",
        sessionId: "session-1",
      },
    });

    const response = await worker.fetch(
      new Request(
        `https://relay.test/authorize?accountId=acct-1&connectionId=conn-1&token=${encodeURIComponent(token)}`,
      ),
      createRoutedEnv({
        ACP_RELAY_ACCOUNT_SESSION_SECRET: "account-session-secret",
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toContain("Sign in required");
  });

  it("routes device renewal requests by proof account", async () => {
    const keyPair = await createAcpRemoteDeviceKeyPair();
    const proofInput = {
      accountId: "acct-1",
      clientId: "client-1",
      connectionId: "conn-1",
      daemonId: "host-1",
      nonce: "nonce-1",
      ticketJti: "ticket-1",
      timestamp: Date.now().toString(),
    };
    const proof = {
      ...proofInput,
      signature: await createAcpRemoteDeviceRenewalSignature({
        ...proofInput,
        privateKey: keyPair.privateKey,
      }),
    };
    const routedRequests: Request[] = [];
    const env = createEnv({
      ACP_RELAY_SHARDS: {
        get() {
          return {
            async fetch(request: Request) {
              routedRequests.push(request);
              return new Response(JSON.stringify({ ok: true }), {
                headers: {
                  "content-type": "application/json; charset=utf-8",
                },
                status: 200,
              });
            },
          };
        },
        idFromName(name: string) {
          expect(name).toBe("account:acct-1");
          return {} as DurableObjectId;
        },
      } as DurableObjectNamespace,
    });

    const response = await worker.fetch(
      new Request("https://relay.test/renew", {
        body: JSON.stringify(proof),
        method: "POST",
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(routedRequests).toHaveLength(1);
    await expect(routedRequests[0].json()).resolves.toMatchObject({
      accountId: "acct-1",
      connectionId: "conn-1",
    });
  });

  it("restores hibernated relay sockets from Durable Object attachments", async () => {
    const database = new FakeD1Database({
      accounts: [{ account_id: "acct-1", disabled: 0 }],
      clientDevices: [
        {
          account_id: "acct-1",
          client_device_id: "native-acp-client",
          disabled: 0,
          public_key: "native-client-key-not-used",
        },
      ],
      grants: [
        {
          account_id: "acct-1",
          client_device_id: null,
          grant_id: "grant-1",
          host_id: "host-1",
          policy_version: 1,
          revoked: 0,
          scopes_json: JSON.stringify(["acp:connect", "acp:session:list"]),
          workspace_id: null,
        },
      ],
      hosts: [
        {
          account_id: "acct-1",
          disabled: 0,
          host_id: "host-1",
          public_key: "host-public-key",
        },
      ],
    });
    const connectionId = "conn-hibernated";
    const [daemonPeer, daemonSocket] = createMemoryWebSocketPair();
    const [, clientSocket] = createMemoryWebSocketPair();
    const daemonFrames: unknown[] = [];
    daemonPeer.addEventListener("message", (event) => {
      daemonFrames.push(JSON.parse(String(event.data)));
    });
    const ticket = await createAcpRemoteSignedConnectionTicket({
      connectionId,
      grant: {
        accountId: "acct-1",
        clientId: "native-acp-client",
        daemonId: "host-1",
        policyVersion: 1,
        scopes: ["acp:connect", "acp:session:list"],
      },
      jti: "ticket-hibernated",
      key: { kid: "test-key", secret: "relay-ticket-secret" },
      now: new Date("2026-05-07T00:00:00.000Z"),
      ttlMs: 60_000,
    });
    daemonSocket.serializeAttachment({
      connectedAt: Date.now(),
      connectionId: "daemon-hibernated",
      daemonId: "host-1",
      daemonMetadata: { agentTypes: [], workspaceRoots: [] },
      endpoint: AcpRemoteEndpointKind.Daemon,
      version: 1,
    });
    clientSocket.serializeAttachment({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-hibernated",
      bootstrapComplete: true,
      clientId: "native-acp-client",
      connectedAt: Date.now(),
      connectionId,
      daemonId: "host-1",
      endpoint: AcpRemoteEndpointKind.Client,
      nativeClientAck: true,
      ticket,
      transport: "native-acp",
      version: 1,
    });
    const pendingResponseFrame: AcpRemoteDataFrame = {
      channelId: "acp",
      channelKind: AcpRemoteChannelKind.Acp,
      connectionId,
      frameType: AcpRemoteFrameType.Data,
      payload: { id: 2, jsonrpc: "2.0", result: { ok: true } },
      seq: 55,
    };
    const storage = new Map<string, unknown>([
      [
        `client-state:${connectionId}`,
        {
          bootstrapComplete: true,
          bufferedClientPayloads: [],
          clientPendingFrames: [pendingResponseFrame],
          connectionId,
          daemonId: "host-1",
          daemonPendingFrames: [],
          daemonQueuedFrames: [],
          daemonRequests: [],
          seq: 0,
          ticket,
        },
      ],
    ]);

    const shard = new AcpRelayShard(
      {
        getWebSockets() {
          return [daemonSocket, clientSocket] as unknown as WebSocket[];
        },
        storage: {
          async delete(key: string) {
            return storage.delete(key);
          },
          async get(key: string) {
            return storage.get(key);
          },
          async put(key: string, value: unknown) {
            storage.set(key, value);
          },
          async setAlarm() {},
        },
      } as DurableObjectState,
      createEnv({
        ACP_RELAY_DB: database as unknown as D1Database,
        ACP_RELAY_TICKET_KID: "test-key",
        ACP_RELAY_TICKET_SECRET: "relay-ticket-secret",
      }),
    );

    await shard.webSocketMessage(
      clientSocket as unknown as WebSocket,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "acp-runtime/remote/client_ack",
        params: { id: 2 },
      }),
    );
    await shard.webSocketMessage(
      clientSocket as unknown as WebSocket,
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "session/list",
        params: {},
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(
      daemonFrames.some((frame) => {
        const candidate = frame as { ack?: unknown; frameType?: unknown };
        return (
          candidate.frameType === AcpRemoteFrameType.Ack &&
          candidate.ack === 55
        );
      }),
    ).toBe(true);
    expect(
      daemonFrames.some((frame) => {
        const candidate = frame as Partial<AcpRemoteDataFrame>;
        return (
          candidate.frameType === AcpRemoteFrameType.Data &&
          candidate.channelKind === AcpRemoteChannelKind.Acp &&
          typeof candidate.payload === "object" &&
          candidate.payload !== null &&
          "method" in candidate.payload &&
          candidate.payload.method === "session/list"
        );
      }),
    ).toBe(true);
  });

  it("applies ticket TTL and renewal window Worker variables", async () => {
    const database = new FakeD1Database({
      accounts: [{ account_id: "acct-1", disabled: 0 }],
      clientDevices: [
        {
          account_id: "acct-1",
          client_device_id: "native-acp-client",
          disabled: 0,
          public_key: "native-client-key-not-used",
        },
      ],
      grants: [
        {
          account_id: "acct-1",
          client_device_id: null,
          grant_id: "grant-1",
          host_id: "host-1",
          policy_version: 1,
          revoked: 0,
          scopes_json: JSON.stringify(["acp:connect", "acp:session:list"]),
          workspace_id: null,
        },
      ],
      hosts: [
        {
          account_id: "acct-1",
          disabled: 0,
          host_id: "host-1",
          public_key: "host-public-key",
        },
      ],
    });
    const connectionId = "conn-env-ticket";
    const [daemonPeer, daemonSocket] = createMemoryWebSocketPair();
    const [clientPeer, clientSocket] = createMemoryWebSocketPair();
    const daemonFrames: unknown[] = [];
    const clientMessages: unknown[] = [];
    daemonPeer.addEventListener("message", (event) => {
      daemonFrames.push(JSON.parse(String(event.data)));
    });
    clientPeer.addEventListener("message", (event) => {
      clientMessages.push(JSON.parse(String(event.data)));
    });
    daemonSocket.serializeAttachment({
      connectedAt: Date.now(),
      connectionId: "daemon-env-ticket",
      daemonId: "host-1",
      daemonMetadata: { agentTypes: [], workspaceRoots: [] },
      endpoint: AcpRemoteEndpointKind.Daemon,
      version: 1,
    });
    clientSocket.serializeAttachment({
      accountId: "acct-1",
      authUrl: `https://relay.test/authorize?connectionId=${connectionId}`,
      clientId: "native-acp-client",
      connectedAt: Date.now(),
      connectionId,
      endpoint: AcpRemoteEndpointKind.Client,
      nativeClientAck: false,
      transport: "native-acp",
      version: 1,
    });
    const storage = new Map<string, unknown>();
    const shard = new AcpRelayShard(
      {
        getWebSockets() {
          return [daemonSocket, clientSocket] as unknown as WebSocket[];
        },
        storage: {
          async delete(key: string) {
            return storage.delete(key);
          },
          async get(key: string) {
            return storage.get(key);
          },
          async put(key: string, value: unknown) {
            storage.set(key, value);
          },
          async setAlarm() {},
        },
      } as DurableObjectState,
      createEnv({
        ACP_RELAY_DB: database as unknown as D1Database,
        ACP_RELAY_TICKET_KID: "test-key",
        ACP_RELAY_TICKET_RENEW_BEFORE_MS: "180000",
        ACP_RELAY_TICKET_SECRET: "relay-ticket-secret",
        ACP_RELAY_TICKET_TTL_MS: "120000",
      }),
    );

    const response = await shard.fetch(
      new Request(`https://relay.test/authorize?connectionId=${connectionId}`, {
        body: JSON.stringify({ daemonId: "host-1" }),
        headers: {
          "content-type": "application/json",
          "x-acp-verified-account-id": "acct-1",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      ok?: boolean;
      ticket?: {
        payload?: {
          expiresAt?: string;
          issuedAt?: string;
        };
      };
    };
    expect(result.ok).toBe(true);
    expect(
      Date.parse(result.ticket?.payload?.expiresAt ?? "") -
        Date.parse(result.ticket?.payload?.issuedAt ?? ""),
    ).toBe(120_000);

    await shard.webSocketMessage(
      clientSocket as unknown as WebSocket,
      JSON.stringify({
        id: "auth",
        jsonrpc: "2.0",
        method: "authenticate",
        params: { methodId: "acp-runtime-browser" },
      }),
    );
    daemonFrames.length = 0;
    clientMessages.length = 0;
    await shard.webSocketMessage(
      clientSocket as unknown as WebSocket,
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "session/list",
        params: {},
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    const renewFrame = daemonFrames.find((frame) => {
      const candidate = frame as { frameType?: unknown };
      return candidate.frameType === AcpRemoteFrameType.Renew;
    }) as
      | {
          ticket?: {
            payload?: {
              expiresAt?: string;
              issuedAt?: string;
            };
          };
        }
      | undefined;
    expect(renewFrame).toBeTruthy();
    expect(
      Date.parse(renewFrame?.ticket?.payload?.expiresAt ?? "") -
        Date.parse(renewFrame?.ticket?.payload?.issuedAt ?? ""),
    ).toBe(120_000);
  });

  it("accepts account-session log uploads without D1 and emits Cloudflare log records", async () => {
    const token = await createAcpRelayAccountSessionToken({
      secret: "account-session-secret",
      session: {
        accountId: "acct-1",
        expiresAt: "2099-04-28T00:00:00.000Z",
        sessionId: "session-1",
      },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const response = await worker.fetch(
        new Request("https://relay.test/api/logs", {
          body: JSON.stringify({
            context: {
              "acp.remote.daemon_id": "host-1",
            },
            records: [
              {
                body: "Daemon connected.",
                kind: "text",
                observedAt: "2026-05-06T00:00:00.000Z",
                spanId: "span-1",
                traceId: "trace-1",
              },
            ],
            source: "daemon",
            version: 1,
          }),
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          method: "POST",
        }),
        createEnv({
          ACP_RELAY_ACCOUNT_SESSION_SECRET: "account-session-secret",
        }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        accepted: 1,
        ok: true,
      });
      expect(logSpy).toHaveBeenCalledTimes(1);
      const line = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as Record<
        string,
        unknown
      >;
      expect(line).toMatchObject({
        accountId: "acct-1",
        accountSessionId: "session-1",
        eventName: "acp.relay.log",
        spanId: "span-1",
        source: "daemon",
        traceId: "trace-1",
      });
      expect(line.context).toMatchObject({
        "acp.remote.daemon_id": "host-1",
      });
      expect(line.record).toMatchObject({
        body: "Daemon connected.",
        kind: "text",
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("rejects unauthenticated log uploads", async () => {
    const response = await worker.fetch(
      new Request("https://relay.test/api/logs", {
        body: JSON.stringify({
          records: [],
          source: "daemon",
          version: 1,
        }),
        method: "POST",
      }),
      createEnv({
        ACP_RELAY_ACCOUNT_SESSION_SECRET: "account-session-secret",
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "ACP relay account session is required.",
    });
  });

  it("accepts daemon registration signed by a registered host key", async () => {
    const keyPair = await createDaemonRegistrationKeyPair();
    const database = new FakeD1Database({
      accounts: [],
      clientDevices: [],
      grants: [],
      hosts: [
        {
          account_id: "acct-1",
          disabled: 0,
          host_id: "host-1",
          public_key: keyPair.publicKey,
        },
      ],
    });
    const timestamp = Date.now().toString();
    const signature = await createDaemonRegistrationKeySignature({
      accountId: "acct-1",
      daemonId: "host-1",
      nonce: "nonce-1",
      privateKey: keyPair.privateKey,
      timestamp,
    });

    const response = await worker.fetch(
      new Request("https://relay.test/daemon?accountId=acct-1&daemonId=host-1", {
        headers: {
          Upgrade: "websocket",
          "x-acp-daemon-nonce": "nonce-1",
          "x-acp-daemon-signature": signature,
          "x-acp-daemon-timestamp": timestamp,
        },
      }),
      createRoutedEnv({ ACP_RELAY_DB: database as unknown as D1Database }),
    );

    expect(response.status).toBe(299);
    await expect(response.text()).resolves.toBe("routed");
  });

  it("auto-registers a daemon and default grant from an account session", async () => {
    const keyPair = await createDaemonRegistrationKeyPair();
    const token = await createAcpRelayAccountSessionToken({
      secret: "account-session-secret",
      session: {
        accountId: "acct-1",
        expiresAt: "2099-04-28T00:00:00.000Z",
        sessionId: "session-1",
      },
    });
    const database = new FakeD1Database({
      accounts: [],
      clientDevices: [],
      grants: [],
      hosts: [],
    });
    const timestamp = Date.now().toString();
    const signature = await createDaemonRegistrationKeySignature({
      accountId: "acct-1",
      daemonId: "host-1",
      nonce: "nonce-1",
      privateKey: keyPair.privateKey,
      timestamp,
    });

    const response = await worker.fetch(
      new Request("https://relay.test/daemon?daemonId=host-1", {
        headers: {
          authorization: `Bearer ${token}`,
          Upgrade: "websocket",
          "x-acp-daemon-nonce": "nonce-1",
          "x-acp-daemon-public-key": keyPair.publicKey,
          "x-acp-daemon-signature": signature,
          "x-acp-daemon-timestamp": timestamp,
        },
      }),
      createRoutedEnv({
        ACP_RELAY_ACCOUNT_SESSION_SECRET: "account-session-secret",
        ACP_RELAY_DB: database as unknown as D1Database,
      }),
    );

    expect(response.status).toBe(299);
    expect(database.rows.accounts).toMatchObject([{ account_id: "acct-1" }]);
    expect(database.rows.hosts).toMatchObject([
      {
        account_id: "acct-1",
        host_id: "host-1",
        public_key: keyPair.publicKey,
      },
    ]);
    expect(database.rows.grants).toMatchObject([
      {
        account_id: "acct-1",
        client_device_id: null,
        host_id: "host-1",
        revoked: 0,
      },
    ]);
    expect(JSON.parse(database.rows.grants[0].scopes_json)).toContain(
      "acp:connect",
    );
  });

  it("rejects daemon registration with an invalid host key signature", async () => {
    const keyPair = await createDaemonRegistrationKeyPair();
    const database = new FakeD1Database({
      accounts: [],
      clientDevices: [],
      grants: [],
      hosts: [
        {
          account_id: "acct-1",
          disabled: 0,
          host_id: "host-1",
          public_key: keyPair.publicKey,
        },
      ],
    });

    const response = await worker.fetch(
      new Request("https://relay.test/daemon?accountId=acct-1&daemonId=host-1", {
        headers: {
          Upgrade: "websocket",
          "x-acp-daemon-nonce": "nonce-1",
          "x-acp-daemon-signature": "bad-signature",
          "x-acp-daemon-timestamp": Date.now().toString(),
        },
      }),
      createRoutedEnv({ ACP_RELAY_DB: database as unknown as D1Database }),
    );

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe(
      "Invalid daemon registration signature.",
    );
  });

  it("auto-recovers a registered daemon key when account session is valid", async () => {
    const staleKeyPair = await createDaemonRegistrationKeyPair();
    const nextKeyPair = await createDaemonRegistrationKeyPair();
    const token = await createAcpRelayAccountSessionToken({
      secret: "account-session-secret",
      session: {
        accountId: "acct-1",
        expiresAt: "2099-04-28T00:00:00.000Z",
        sessionId: "session-1",
      },
    });
    const database = new FakeD1Database({
      accounts: [{ account_id: "acct-1", disabled: 0 }],
      clientDevices: [],
      grants: [],
      hosts: [
        {
          account_id: "acct-1",
          disabled: 0,
          host_id: "host-1",
          public_key: staleKeyPair.publicKey,
        },
      ],
    });
    const timestamp = Date.now().toString();
    const signature = await createDaemonRegistrationKeySignature({
      accountId: "acct-1",
      daemonId: "host-1",
      nonce: "nonce-1",
      privateKey: nextKeyPair.privateKey,
      timestamp,
    });

    const response = await worker.fetch(
      new Request("https://relay.test/daemon?daemonId=host-1", {
        headers: {
          authorization: `Bearer ${token}`,
          Upgrade: "websocket",
          "x-acp-daemon-nonce": "nonce-1",
          "x-acp-daemon-public-key": nextKeyPair.publicKey,
          "x-acp-daemon-signature": signature,
          "x-acp-daemon-timestamp": timestamp,
        },
      }),
      createRoutedEnv({
        ACP_RELAY_ACCOUNT_SESSION_SECRET: "account-session-secret",
        ACP_RELAY_DB: database as unknown as D1Database,
      }),
    );

    expect(response.status).toBe(299);
    expect(database.rows.hosts[0]).toMatchObject({
      account_id: "acct-1",
      host_id: "host-1",
      public_key: nextKeyPair.publicKey,
    });
  });

  it("accepts daemon registration signed by a previous host key during rotation", async () => {
    const currentKeyPair = await createDaemonRegistrationKeyPair();
    const previousKeyPair = await createDaemonRegistrationKeyPair();
    const database = new FakeD1Database({
      accounts: [],
      clientDevices: [],
      grants: [],
      hosts: [
        {
          account_id: "acct-1",
          disabled: 0,
          host_id: "host-1",
          previous_public_key: previousKeyPair.publicKey,
          public_key: currentKeyPair.publicKey,
        },
      ],
    });
    const timestamp = Date.now().toString();
    const signature = await createDaemonRegistrationKeySignature({
      accountId: "acct-1",
      daemonId: "host-1",
      nonce: "nonce-1",
      privateKey: previousKeyPair.privateKey,
      timestamp,
    });

    const response = await worker.fetch(
      new Request("https://relay.test/daemon?accountId=acct-1&daemonId=host-1", {
        headers: {
          Upgrade: "websocket",
          "x-acp-daemon-nonce": "nonce-1",
          "x-acp-daemon-signature": signature,
          "x-acp-daemon-timestamp": timestamp,
        },
      }),
      createRoutedEnv({ ACP_RELAY_DB: database as unknown as D1Database }),
    );

    expect(response.status).toBe(299);
  });

  it("rejects daemon registration when the host has no registered public key", async () => {
    const database = new FakeD1Database({
      accounts: [],
      clientDevices: [],
      grants: [],
      hosts: [
        {
          account_id: "acct-1",
          disabled: 0,
          host_id: "host-1",
        },
      ],
    });

    const response = await worker.fetch(
      new Request("https://relay.test/daemon?accountId=acct-1&daemonId=host-1", {
        headers: {
          Upgrade: "websocket",
          "x-acp-daemon-nonce": "nonce-1",
          "x-acp-daemon-signature": "bad-signature",
          "x-acp-daemon-timestamp": Date.now().toString(),
        },
      }),
      createRoutedEnv({
        ACP_RELAY_DB: database as unknown as D1Database,
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe(
      "Daemon registration proof key is not configured.",
    );
  });
});

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    ACP_RELAY_CONTROL_PLANE_SECRET: "control-plane-secret",
    ACP_RELAY_SHARDS: {
      get() {
        return {
          async fetch() {
            return new Response(
              JSON.stringify({
                closedConnectionIds: [],
                ok: true,
              }),
              {
                headers: {
                  "content-type": "application/json; charset=utf-8",
                },
                status: 200,
              },
            );
          },
        };
      },
      idFromName() {
        return {} as DurableObjectId;
      },
    } as DurableObjectNamespace,
    ...overrides,
  };
}

function createRoutedEnv(overrides: Partial<Env> = {}): Env {
  return createEnv({
    ACP_RELAY_SHARDS: {
      get() {
        return {
          async fetch() {
            return new Response("routed", { status: 299 });
          },
        };
      },
      idFromName() {
        return {} as DurableObjectId;
      },
    } as DurableObjectNamespace,
    ...overrides,
  });
}

type FakeAccountRow = {
  account_id: string;
  disabled: number;
};

type FakeClientDeviceRow = {
  account_id: string;
  client_device_id: string;
  disabled: number;
  public_key?: string | null;
};

type FakeHostRow = {
  account_id: string;
  disabled: number;
  host_id: string;
  previous_public_key?: string | null;
  public_key?: string | null;
};

type FakeGrantRow = {
  account_id: string;
  client_device_id: string | null;
  grant_id?: string;
  host_id: string;
  policy_version: number;
  revoked: number;
  scopes_json: string;
  workspace_id: string | null;
  workspace_roots_json?: string | null;
};

type FakeD1Rows = {
  accounts: FakeAccountRow[];
  clientDevices: FakeClientDeviceRow[];
  grants: FakeGrantRow[];
  hosts: FakeHostRow[];
};

class FakeD1Database implements D1DatabaseLike {
  constructor(readonly rows: FakeD1Rows) {}

  prepare(query: string): D1PreparedStatementLike {
    return new FakeD1PreparedStatement(this.rows, query);
  }
}

class FakeD1PreparedStatement implements D1PreparedStatementLike {
  private bindings: readonly D1Value[] = [];

  constructor(
    private readonly rows: FakeD1Rows,
    private readonly query: string,
  ) {}

  bind(...values: readonly D1Value[]): D1PreparedStatementLike {
    this.bindings = values;
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.resolveRows()[0] as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<{
    results: T[];
    success: boolean;
  }> {
    return {
      results: this.resolveRows() as T[],
      success: true,
    };
  }

  async run(): Promise<{ success: boolean }> {
    const query = this.query.toLowerCase();
    if (query.includes("insert into acp_accounts")) {
      const row = {
        account_id: this.readStringBinding(0),
        disabled: this.readNumberBinding(1),
      };
      upsertRow(this.rows.accounts, row, (candidate) =>
        candidate.account_id === row.account_id,
      );
      return { success: true };
    }

    if (query.includes("insert into acp_client_devices")) {
      const row = {
        account_id: this.readStringBinding(0),
        client_device_id: this.readStringBinding(1),
        disabled: this.readNumberBinding(3),
        public_key: this.readNullableStringBinding(2),
      };
      upsertRow(this.rows.clientDevices, row, (candidate) =>
        candidate.account_id === row.account_id &&
        candidate.client_device_id === row.client_device_id,
      );
      return { success: true };
    }

    if (query.includes("insert into acp_hosts")) {
      const row = {
        account_id: this.readStringBinding(0),
        disabled: this.readNumberBinding(4),
        host_id: this.readStringBinding(1),
        previous_public_key: this.readNullableStringBinding(3),
        public_key: this.readNullableStringBinding(2),
      };
      upsertRow(this.rows.hosts, row, (candidate) =>
        candidate.account_id === row.account_id &&
        candidate.host_id === row.host_id,
      );
      return { success: true };
    }

    if (query.includes("insert into acp_grants")) {
      const row = {
        account_id: this.readStringBinding(1),
        client_device_id: this.readNullableStringBinding(2),
        grant_id: this.readStringBinding(0),
        host_id: this.readStringBinding(3),
        policy_version: this.readNumberBinding(6),
        revoked: this.readNumberBinding(8),
        scopes_json: this.readStringBinding(7),
        workspace_id: this.readNullableStringBinding(4),
        workspace_roots_json: this.readNullableStringBinding(5),
      };
      upsertRow(this.rows.grants, row, (candidate) =>
        candidate.grant_id === row.grant_id,
      );
      return { success: true };
    }

    return { success: false };
  }

  private resolveRows(): unknown[] {
    const query = this.query.toLowerCase();
    const accountId = this.bindings[0];
    const second = this.bindings[1];
    if (query.includes("from acp_accounts")) {
      return this.rows.accounts.filter((row) => row.account_id === accountId);
    }
    if (query.includes("from acp_client_devices")) {
      return this.rows.clientDevices.filter(
        (row) =>
          row.account_id === accountId && row.client_device_id === second,
      );
    }
    if (query.includes("from acp_hosts") && query.includes("host_id = ?2")) {
      return this.rows.hosts.filter(
        (row) => row.account_id === accountId && row.host_id === second,
      );
    }
    if (query.includes("from acp_hosts")) {
      return this.rows.hosts.filter(
        (row) => row.account_id === accountId && row.disabled === 0,
      );
    }
    if (query.includes("from acp_grants")) {
      return this.rows.grants.filter(
        (row) =>
          row.account_id === accountId &&
          row.revoked === 0 &&
          (row.client_device_id === null || row.client_device_id === second),
      );
    }
    return [];
  }

  private readStringBinding(index: number): string {
    const value = this.bindings[index];
    if (typeof value !== "string") {
      throw new Error(`Expected string binding at ${index}.`);
    }
    return value;
  }

  private readNullableStringBinding(index: number): string | null {
    const value = this.bindings[index];
    if (value === null) {
      return null;
    }
    if (typeof value !== "string") {
      throw new Error(`Expected nullable string binding at ${index}.`);
    }
    return value;
  }

  private readNumberBinding(index: number): number {
    const value = this.bindings[index];
    if (typeof value !== "number") {
      throw new Error(`Expected number binding at ${index}.`);
    }
    return value;
  }
}

function upsertRow<T>(rows: T[], row: T, matches: (candidate: T) => boolean): void {
  const index = rows.findIndex(matches);
  if (index === -1) {
    rows.push(row);
    return;
  }
  rows[index] = row;
}
