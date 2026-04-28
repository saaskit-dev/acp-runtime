import { describe, expect, it } from "vitest";

import {
  createAcpRemoteDeviceKeyPair,
  createAcpRemoteDeviceRenewalSignature,
} from "../../../src/runtime/remote/protocol/index.js";
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
import worker, { type Env } from "./index.js";

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
          clientDeviceId: "client-1",
          publicKey: "client-public-key",
        },
      ],
      [
        "/control-plane/hosts",
        {
          accountId: "acct-1",
          hostId: "host-1",
          publicKey: "host-public-key",
        },
      ],
      [
        "/control-plane/grants",
        {
          accountId: "acct-1",
          clientDeviceId: "client-1",
          grantId: "grant-1",
          hostId: "host-1",
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
        clientDeviceId: "client-1",
        hostId: "host-1",
        requiredScopes: ["acp:session:list"],
      }),
    ).resolves.toMatchObject({
      grant: {
        hostId: "host-1",
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
          clientDeviceId: "client-1",
          grantId: "grant-1",
          hostId: "host-1",
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

  it("routes device renewal requests by proof account", async () => {
    const keyPair = await createAcpRemoteDeviceKeyPair();
    const proofInput = {
      accountId: "acct-1",
      clientDeviceId: "client-1",
      connectionId: "conn-1",
      hostId: "host-1",
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
      hostId: "host-1",
      nonce: "nonce-1",
      privateKey: keyPair.privateKey,
      timestamp,
    });

    const response = await worker.fetch(
      new Request("https://relay.test/daemon?accountId=acct-1&hostId=host-1", {
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
      new Request("https://relay.test/daemon?accountId=acct-1&hostId=host-1", {
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
      hostId: "host-1",
      nonce: "nonce-1",
      privateKey: previousKeyPair.privateKey,
      timestamp,
    });

    const response = await worker.fetch(
      new Request("https://relay.test/daemon?accountId=acct-1&hostId=host-1", {
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
      new Request("https://relay.test/daemon?accountId=acct-1&hostId=host-1", {
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
      "Host key is not provisioned for this daemon.",
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
  constructor(private readonly rows: FakeD1Rows) {}

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
