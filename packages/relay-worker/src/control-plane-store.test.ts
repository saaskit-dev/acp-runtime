import { describe, expect, it } from "vitest";

import {
  AcpRelayD1ControlPlaneStore,
  AcpRelayInMemoryControlPlaneStore,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1Value,
} from "./control-plane-store.js";

describe("AcpRelayInMemoryControlPlaneStore", () => {
  it("resolves device-specific grants before account-wide grants", async () => {
    const store = new AcpRelayInMemoryControlPlaneStore({
      accounts: [{ accountId: "acct-1" }],
      clientDevices: [{ accountId: "acct-1", clientId: "client-1" }],
      grants: [
        {
          accountId: "acct-1",
          daemonId: "host-1",
          policyVersion: 1,
          scopes: ["acp:connect"],
        },
        {
          accountId: "acct-1",
          clientId: "client-1",
          daemonId: "host-1",
          policyVersion: 2,
          scopes: ["acp:connect", "acp:turn:send"],
        },
      ],
      hosts: [{ accountId: "acct-1", daemonId: "host-1" }],
    });

    await expect(
      store.resolveGrant({
        accountId: "acct-1",
        clientId: "client-1",
        daemonId: "host-1",
        requiredScopes: ["acp:turn:send"],
      }),
    ).resolves.toMatchObject({
      grant: {
        clientId: "client-1",
        policyVersion: 2,
      },
      ok: true,
    });
  });

  it("rejects disabled devices and revoked grants", async () => {
    const store = new AcpRelayInMemoryControlPlaneStore({
      accounts: [{ accountId: "acct-1" }],
      clientDevices: [
        { accountId: "acct-1", clientId: "client-1", disabled: true },
      ],
      grants: [
        {
          accountId: "acct-1",
          daemonId: "host-1",
          policyVersion: 1,
          revoked: true,
          scopes: ["acp:connect"],
        },
      ],
      hosts: [{ accountId: "acct-1", daemonId: "host-1" }],
    });

    await expect(
      store.resolveGrant({
        accountId: "acct-1",
        clientId: "client-1",
        daemonId: "host-1",
        requiredScopes: ["acp:connect"],
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "Client device is not registered.",
    });
  });
});

describe("AcpRelayD1ControlPlaneStore", () => {
  it("resolves grants from D1-compatible tables", async () => {
    const store = new AcpRelayD1ControlPlaneStore(
      new FakeD1Database({
        accounts: [{ account_id: "acct-1", disabled: 0 }],
        clientDevices: [
          {
            account_id: "acct-1",
            client_device_id: "client-1",
            disabled: 0,
          },
        ],
        grants: [
          {
            account_id: "acct-1",
            client_device_id: null,
            host_id: "host-1",
            policy_version: 3,
            revoked: 0,
            scopes_json: JSON.stringify(["acp:connect", "acp:turn:send"]),
            workspace_id: null,
          },
        ],
        hosts: [{ account_id: "acct-1", disabled: 0, host_id: "host-1" }],
      }),
    );

    await expect(
      store.listAuthorizableHosts({
        accountId: "acct-1",
        clientId: "client-1",
      }),
    ).resolves.toEqual([
      {
        accountId: "acct-1",
        disabled: false,
        daemonId: "host-1",
      },
    ]);
    await expect(
      store.resolveGrant({
        accountId: "acct-1",
        clientId: "client-1",
        daemonId: "host-1",
        requiredScopes: ["acp:turn:send"],
      }),
    ).resolves.toMatchObject({
      grant: {
        daemonId: "host-1",
        policyVersion: 3,
      },
      ok: true,
    });
  });

  it("upserts registrations into D1-compatible tables", async () => {
    const database = new FakeD1Database({
      accounts: [],
      clientDevices: [],
      grants: [],
      hosts: [],
      sessionBindings: [],
    });
    const store = new AcpRelayD1ControlPlaneStore(database);

    await store.upsertAccount({ accountId: "acct-2" });
    await store.upsertClientDevice({
      accountId: "acct-2",
      clientId: "client-2",
    });
    await store.upsertHost({ accountId: "acct-2", daemonId: "host-2" });
    await store.upsertGrant({
      accountId: "acct-2",
      clientId: "client-2",
      grantId: "grant-2",
      daemonId: "host-2",
      policyVersion: 4,
      scopes: ["acp:connect", "acp:session:create"],
      workspaceRoots: ["/work/project"],
    });
    await store.upsertSessionBinding({
      accountId: "acct-2",
      agent: { id: "codex-acp" },
      clientId: "client-2",
      daemonId: "host-2",
      sessionId: "session-2",
      workspaceRoots: ["/work/project"],
    });

    await expect(
      store.getSessionBinding({
        accountId: "acct-2",
        clientId: "client-2",
        sessionId: "session-2",
      }),
    ).resolves.toEqual({
      accountId: "acct-2",
      agent: { id: "codex-acp" },
      clientId: "client-2",
      daemonId: "host-2",
      sessionId: "session-2",
      workspaceRoots: ["/work/project"],
    });

    await expect(
      store.resolveGrant({
        accountId: "acct-2",
        clientId: "client-2",
        daemonId: "host-2",
        requiredScopes: ["acp:session:create"],
      }),
    ).resolves.toMatchObject({
      grant: {
        clientId: "client-2",
        daemonId: "host-2",
        policyVersion: 4,
        workspaceRoots: ["/work/project"],
      },
      ok: true,
    });

    await store.upsertGrant({
      accountId: "acct-2",
      clientId: "client-2",
      grantId: "grant-2",
      daemonId: "host-2",
      policyVersion: 5,
      revoked: true,
      scopes: ["acp:connect", "acp:session:create"],
    });

    await expect(
      store.resolveGrant({
        accountId: "acct-2",
        clientId: "client-2",
        daemonId: "host-2",
        requiredScopes: ["acp:connect"],
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "No active grant allows this host.",
    });
  });
});

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
  sessionBindings?: FakeSessionBindingRow[];
};

type FakeSessionBindingRow = {
  account_id: string;
  agent_json: string | null;
  client_device_id: string;
  host_id: string;
  session_id: string;
  workspace_roots_json: string | null;
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

    if (query.includes("insert into acp_remote_session_bindings")) {
      const row = {
        account_id: this.readStringBinding(0),
        agent_json: this.readNullableStringBinding(4),
        client_device_id: this.readStringBinding(1),
        host_id: this.readStringBinding(3),
        session_id: this.readStringBinding(2),
        workspace_roots_json: this.readNullableStringBinding(5),
      };
      this.rows.sessionBindings ??= [];
      upsertRow(this.rows.sessionBindings, row, (candidate) =>
        candidate.account_id === row.account_id &&
        candidate.client_device_id === row.client_device_id &&
        candidate.session_id === row.session_id,
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
    if (query.includes("from acp_remote_session_bindings")) {
      return (this.rows.sessionBindings ?? []).filter(
        (row) =>
          row.account_id === accountId &&
          row.client_device_id === second &&
          row.session_id === this.bindings[2],
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
