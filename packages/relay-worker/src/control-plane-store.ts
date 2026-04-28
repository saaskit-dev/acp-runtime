import type {
  AcpRemoteGrant,
  AcpRemoteId,
  AcpRemoteScope,
} from "../../../src/runtime/remote/protocol/index.js";

export type AcpRelayAccountRecord = {
  accountId: AcpRemoteId;
  disabled?: boolean;
};

export type AcpRelayClientDeviceRecord = {
  accountId: AcpRemoteId;
  clientDeviceId: AcpRemoteId;
  disabled?: boolean;
  publicKey?: string;
};

export type AcpRelayHostRecord = {
  accountId: AcpRemoteId;
  disabled?: boolean;
  hostId: AcpRemoteId;
  previousPublicKey?: string;
  publicKey?: string;
};

export type AcpRelayGrantRecord = AcpRemoteGrant & {
  grantId?: AcpRemoteId;
  revoked?: boolean;
};

export type AcpRelayGrantDecision =
  | {
      grant: AcpRemoteGrant;
      ok: true;
    }
  | {
      ok: false;
      reason: string;
    };

export type AcpRelayControlPlaneStore = {
  getAccount(accountId: AcpRemoteId): Promise<AcpRelayAccountRecord | undefined>;
  getClientDevice(input: {
    accountId: AcpRemoteId;
    clientDeviceId: AcpRemoteId;
  }): Promise<AcpRelayClientDeviceRecord | undefined>;
  getHost(input: {
    accountId: AcpRemoteId;
    hostId: AcpRemoteId;
  }): Promise<AcpRelayHostRecord | undefined>;
  listAuthorizableHosts(input: {
    accountId: AcpRemoteId;
    clientDeviceId: AcpRemoteId;
  }): Promise<readonly AcpRelayHostRecord[]>;
  resolveGrant(input: {
    accountId: AcpRemoteId;
    clientDeviceId: AcpRemoteId;
    hostId: AcpRemoteId;
    requiredScopes?: readonly AcpRemoteScope[];
  }): Promise<AcpRelayGrantDecision>;
};

export type AcpRelayWritableControlPlaneStore = AcpRelayControlPlaneStore & {
  upsertAccount(record: AcpRelayAccountRecord): Promise<void> | void;
  upsertClientDevice(
    record: AcpRelayClientDeviceRecord,
  ): Promise<void> | void;
  upsertGrant(record: AcpRelayGrantRecord): Promise<void> | void;
  upsertHost(record: AcpRelayHostRecord): Promise<void> | void;
};

export type AcpRelayInMemoryControlPlaneSeed = {
  accounts?: readonly AcpRelayAccountRecord[];
  clientDevices?: readonly AcpRelayClientDeviceRecord[];
  grants?: readonly AcpRelayGrantRecord[];
  hosts?: readonly AcpRelayHostRecord[];
};

export type D1DatabaseLike = {
  prepare(query: string): D1PreparedStatementLike;
};

export type D1PreparedStatementLike = {
  all<T = Record<string, unknown>>(): Promise<{
    results: T[];
    success: boolean;
  }>;
  bind(...values: readonly D1Value[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{
    success: boolean;
  }>;
};

export type D1Value = ArrayBuffer | null | number | string | Uint8Array;

type AccountRow = {
  account_id: string;
  disabled: number | null;
};

type ClientDeviceRow = {
  account_id: string;
  client_device_id: string;
  disabled: number | null;
  public_key: string | null;
};

type HostRow = {
  account_id: string;
  disabled: number | null;
  host_id: string;
  previous_public_key: string | null;
  public_key: string | null;
};

type GrantRow = {
  account_id: string;
  client_device_id: string | null;
  grant_id?: string;
  host_id: string;
  policy_version: number;
  revoked: number | null;
  scopes_json: string;
  workspace_id: string | null;
  workspace_roots_json?: string | null;
};

export class AcpRelayInMemoryControlPlaneStore
  implements AcpRelayWritableControlPlaneStore
{
  private readonly accounts = new Map<string, AcpRelayAccountRecord>();
  private readonly clientDevices = new Map<string, AcpRelayClientDeviceRecord>();
  private readonly grants = new Map<string, AcpRelayGrantRecord>();
  private readonly hosts = new Map<string, AcpRelayHostRecord>();

  constructor(seed: AcpRelayInMemoryControlPlaneSeed = {}) {
    for (const account of seed.accounts ?? []) {
      this.upsertAccount(account);
    }
    for (const device of seed.clientDevices ?? []) {
      this.upsertClientDevice(device);
    }
    for (const host of seed.hosts ?? []) {
      this.upsertHost(host);
    }
    for (const grant of seed.grants ?? []) {
      this.upsertGrant(grant);
    }
  }

  upsertAccount(record: AcpRelayAccountRecord): void {
    this.accounts.set(record.accountId, record);
  }

  upsertClientDevice(record: AcpRelayClientDeviceRecord): void {
    this.clientDevices.set(clientDeviceKey(record), record);
  }

  upsertHost(record: AcpRelayHostRecord): void {
    this.hosts.set(hostKey(record), record);
  }

  upsertGrant(record: AcpRelayGrantRecord): void {
    this.grants.set(grantKey(record), record);
  }

  async getAccount(
    accountId: AcpRemoteId,
  ): Promise<AcpRelayAccountRecord | undefined> {
    return this.accounts.get(accountId);
  }

  async getClientDevice(input: {
    accountId: AcpRemoteId;
    clientDeviceId: AcpRemoteId;
  }): Promise<AcpRelayClientDeviceRecord | undefined> {
    return this.clientDevices.get(clientDeviceKey(input));
  }

  async getHost(input: {
    accountId: AcpRemoteId;
    hostId: AcpRemoteId;
  }): Promise<AcpRelayHostRecord | undefined> {
    return this.hosts.get(hostKey(input));
  }

  async listAuthorizableHosts(input: {
    accountId: AcpRemoteId;
    clientDeviceId: AcpRemoteId;
  }): Promise<readonly AcpRelayHostRecord[]> {
    const allowedHostIds = new Set(
      this.matchingGrantRecords(input)
        .filter((grant) => hasScopes(grant, ["acp:connect"]))
        .map((grant) => grant.hostId),
    );
    return [...this.hosts.values()]
      .filter(
        (host) =>
          host.accountId === input.accountId &&
          !host.disabled &&
          allowedHostIds.has(host.hostId),
      )
      .sort((left, right) => left.hostId.localeCompare(right.hostId));
  }

  async resolveGrant(input: {
    accountId: AcpRemoteId;
    clientDeviceId: AcpRemoteId;
    hostId: AcpRemoteId;
    requiredScopes?: readonly AcpRemoteScope[];
  }): Promise<AcpRelayGrantDecision> {
    const account = await this.getAccount(input.accountId);
    if (!account || account.disabled) {
      return { ok: false, reason: "Account is not active." };
    }

    const device = await this.getClientDevice(input);
    if (!device || device.disabled) {
      return { ok: false, reason: "Client device is not registered." };
    }

    const host = await this.getHost(input);
    if (!host || host.disabled) {
      return { ok: false, reason: "Host is not registered for this account." };
    }

    const grant = this.matchingGrantRecords(input)
      .filter((candidate) => candidate.hostId === input.hostId)
      .filter((candidate) => hasScopes(candidate, input.requiredScopes ?? []))
      .sort(compareGrantSpecificity)[0];
    if (!grant) {
      return { ok: false, reason: "No active grant allows this host." };
    }

    return {
      grant: {
        accountId: grant.accountId,
        clientDeviceId: grant.clientDeviceId ?? input.clientDeviceId,
        hostId: grant.hostId,
        policyVersion: grant.policyVersion,
        scopes: grant.scopes,
        workspaceId: grant.workspaceId,
        workspaceRoots: grant.workspaceRoots,
      },
      ok: true,
    };
  }

  private matchingGrantRecords(input: {
    accountId: AcpRemoteId;
    clientDeviceId: AcpRemoteId;
  }): AcpRelayGrantRecord[] {
    return [...this.grants.values()].filter(
      (grant) =>
        grant.accountId === input.accountId &&
        !grant.revoked &&
        (grant.clientDeviceId === undefined ||
          grant.clientDeviceId === input.clientDeviceId),
    );
  }
}

export class AcpRelayD1ControlPlaneStore
  implements AcpRelayWritableControlPlaneStore
{
  constructor(private readonly database: D1DatabaseLike) {}

  async upsertAccount(record: AcpRelayAccountRecord): Promise<void> {
    await this.database
      .prepare(
        `insert into acp_accounts(account_id, disabled, updated_at)
         values (?1, ?2, current_timestamp)
         on conflict(account_id) do update set
           disabled = excluded.disabled,
           updated_at = current_timestamp`,
      )
      .bind(record.accountId, record.disabled ? 1 : 0)
      .run();
  }

  async upsertClientDevice(
    record: AcpRelayClientDeviceRecord,
  ): Promise<void> {
    await this.database
      .prepare(
        `insert into acp_client_devices(
           account_id, client_device_id, public_key, disabled, updated_at
         )
         values (?1, ?2, ?3, ?4, current_timestamp)
         on conflict(account_id, client_device_id) do update set
           public_key = excluded.public_key,
           disabled = excluded.disabled,
           updated_at = current_timestamp`,
      )
      .bind(
        record.accountId,
        record.clientDeviceId,
        record.publicKey ?? null,
        record.disabled ? 1 : 0,
      )
      .run();
  }

  async upsertHost(record: AcpRelayHostRecord): Promise<void> {
    await this.database
      .prepare(
        `insert into acp_hosts(
           account_id, host_id, public_key, previous_public_key, disabled, updated_at
         )
         values (?1, ?2, ?3, ?4, ?5, current_timestamp)
         on conflict(account_id, host_id) do update set
           public_key = excluded.public_key,
           previous_public_key = excluded.previous_public_key,
           disabled = excluded.disabled,
           updated_at = current_timestamp`,
      )
      .bind(
        record.accountId,
        record.hostId,
        record.publicKey ?? null,
        record.previousPublicKey ?? null,
        record.disabled ? 1 : 0,
      )
      .run();
  }

  async upsertGrant(record: AcpRelayGrantRecord): Promise<void> {
    await this.database
      .prepare(
        `insert into acp_grants(
           grant_id, account_id, client_device_id, host_id, workspace_id,
           workspace_roots_json, policy_version, scopes_json, revoked,
           updated_at
         )
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, current_timestamp)
         on conflict(grant_id) do update set
           account_id = excluded.account_id,
           client_device_id = excluded.client_device_id,
           host_id = excluded.host_id,
           workspace_id = excluded.workspace_id,
           workspace_roots_json = excluded.workspace_roots_json,
           policy_version = excluded.policy_version,
           scopes_json = excluded.scopes_json,
           revoked = excluded.revoked,
           updated_at = current_timestamp`,
      )
      .bind(
        record.grantId ?? stableGrantId(record),
        record.accountId,
        record.clientDeviceId ?? null,
        record.hostId,
        record.workspaceId ?? null,
        record.workspaceRoots ? JSON.stringify(record.workspaceRoots) : null,
        record.policyVersion,
        JSON.stringify(record.scopes),
        record.revoked ? 1 : 0,
      )
      .run();
  }

  async getAccount(
    accountId: AcpRemoteId,
  ): Promise<AcpRelayAccountRecord | undefined> {
    const row = await this.database
      .prepare(
        `select account_id, disabled
         from acp_accounts
         where account_id = ?1
         limit 1`,
      )
      .bind(accountId)
      .first<AccountRow>();
    return row ? mapAccountRow(row) : undefined;
  }

  async getClientDevice(input: {
    accountId: AcpRemoteId;
    clientDeviceId: AcpRemoteId;
  }): Promise<AcpRelayClientDeviceRecord | undefined> {
    const row = await this.database
      .prepare(
        `select account_id, client_device_id, public_key, disabled
         from acp_client_devices
         where account_id = ?1 and client_device_id = ?2
         limit 1`,
      )
      .bind(input.accountId, input.clientDeviceId)
      .first<ClientDeviceRow>();
    return row ? mapClientDeviceRow(row) : undefined;
  }

  async getHost(input: {
    accountId: AcpRemoteId;
    hostId: AcpRemoteId;
  }): Promise<AcpRelayHostRecord | undefined> {
    const row = await this.database
      .prepare(
        `select account_id, host_id, public_key, previous_public_key, disabled
         from acp_hosts
         where account_id = ?1 and host_id = ?2
         limit 1`,
      )
      .bind(input.accountId, input.hostId)
      .first<HostRow>();
    return row ? mapHostRow(row) : undefined;
  }

  async listAuthorizableHosts(input: {
    accountId: AcpRemoteId;
    clientDeviceId: AcpRemoteId;
  }): Promise<readonly AcpRelayHostRecord[]> {
    const grants = await this.matchingGrantRecords(input);
    const allowedHostIds = new Set(
      grants
        .filter((grant) => hasScopes(grant, ["acp:connect"]))
        .map((grant) => grant.hostId),
    );
    if (allowedHostIds.size === 0) {
      return [];
    }

    const hosts = await this.database
      .prepare(
        `select account_id, host_id, public_key, previous_public_key, disabled
         from acp_hosts
         where account_id = ?1 and disabled = 0
         order by host_id asc`,
      )
      .bind(input.accountId)
      .all<HostRow>();
    return hosts.results
      .map(mapHostRow)
      .filter((host) => allowedHostIds.has(host.hostId));
  }

  async resolveGrant(input: {
    accountId: AcpRemoteId;
    clientDeviceId: AcpRemoteId;
    hostId: AcpRemoteId;
    requiredScopes?: readonly AcpRemoteScope[];
  }): Promise<AcpRelayGrantDecision> {
    const account = await this.getAccount(input.accountId);
    if (!account || account.disabled) {
      return { ok: false, reason: "Account is not active." };
    }

    const device = await this.getClientDevice(input);
    if (!device || device.disabled) {
      return { ok: false, reason: "Client device is not registered." };
    }

    const host = await this.getHost(input);
    if (!host || host.disabled) {
      return { ok: false, reason: "Host is not registered for this account." };
    }

    const grant = (await this.matchingGrantRecords(input))
      .filter((candidate) => candidate.hostId === input.hostId)
      .filter((candidate) => hasScopes(candidate, input.requiredScopes ?? []))
      .sort(compareGrantSpecificity)[0];
    if (!grant) {
      return { ok: false, reason: "No active grant allows this host." };
    }

    return {
      grant: {
        accountId: grant.accountId,
        clientDeviceId: grant.clientDeviceId ?? input.clientDeviceId,
        hostId: grant.hostId,
        policyVersion: grant.policyVersion,
        scopes: grant.scopes,
        workspaceId: grant.workspaceId,
        workspaceRoots: grant.workspaceRoots,
      },
      ok: true,
    };
  }

  private async matchingGrantRecords(input: {
    accountId: AcpRemoteId;
    clientDeviceId: AcpRemoteId;
  }): Promise<AcpRelayGrantRecord[]> {
    const rows = await this.database
      .prepare(
        `select account_id, client_device_id, host_id, workspace_id,
                workspace_roots_json, policy_version, scopes_json, revoked
         from acp_grants
         where account_id = ?1
           and revoked = 0
           and (client_device_id is null or client_device_id = ?2)`,
      )
      .bind(input.accountId, input.clientDeviceId)
      .all<GrantRow>();
    return rows.results.map(mapGrantRow);
  }
}

function clientDeviceKey(input: {
  accountId: AcpRemoteId;
  clientDeviceId: AcpRemoteId;
}): string {
  return `${input.accountId}:${input.clientDeviceId}`;
}

function hostKey(input: {
  accountId: AcpRemoteId;
  hostId: AcpRemoteId;
}): string {
  return `${input.accountId}:${input.hostId}`;
}

function grantKey(input: AcpRelayGrantRecord): string {
  if (input.grantId) {
    return input.grantId;
  }
  return [
    input.accountId,
    input.clientDeviceId ?? "*",
    input.hostId,
    input.workspaceId ?? "*",
  ].join(":");
}

function stableGrantId(input: AcpRelayGrantRecord): string {
  return `grant:${grantKey(input)}`;
}

function hasScopes(
  grant: Pick<AcpRelayGrantRecord, "scopes">,
  requiredScopes: readonly AcpRemoteScope[],
): boolean {
  return requiredScopes.every((scope) => grant.scopes.includes(scope));
}

function compareGrantSpecificity(
  left: AcpRelayGrantRecord,
  right: AcpRelayGrantRecord,
): number {
  const leftSpecificity = left.clientDeviceId ? 1 : 0;
  const rightSpecificity = right.clientDeviceId ? 1 : 0;
  if (leftSpecificity !== rightSpecificity) {
    return rightSpecificity - leftSpecificity;
  }
  return right.policyVersion - left.policyVersion;
}

function mapAccountRow(row: AccountRow): AcpRelayAccountRecord {
  return {
    accountId: row.account_id,
    disabled: Boolean(row.disabled),
  };
}

function mapClientDeviceRow(row: ClientDeviceRow): AcpRelayClientDeviceRecord {
  return {
    accountId: row.account_id,
    clientDeviceId: row.client_device_id,
    disabled: Boolean(row.disabled),
    publicKey: row.public_key ?? undefined,
  };
}

function mapHostRow(row: HostRow): AcpRelayHostRecord {
  return {
    accountId: row.account_id,
    disabled: Boolean(row.disabled),
    hostId: row.host_id,
    previousPublicKey: row.previous_public_key ?? undefined,
    publicKey: row.public_key ?? undefined,
  };
}

function mapGrantRow(row: GrantRow): AcpRelayGrantRecord {
  return {
    accountId: row.account_id,
    clientDeviceId: row.client_device_id ?? undefined,
    hostId: row.host_id,
    policyVersion: row.policy_version,
    revoked: Boolean(row.revoked),
    scopes: parseScopes(row.scopes_json),
    workspaceId: row.workspace_id ?? undefined,
    workspaceRoots: row.workspace_roots_json
      ? parseStringArray(row.workspace_roots_json, "workspace roots")
      : undefined,
  };
}

function parseScopes(value: string): readonly AcpRemoteScope[] {
  return parseStringArray(value, "scopes") as readonly AcpRemoteScope[];
}

function parseStringArray(value: string, label: string): readonly string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid ACP relay grant ${label} JSON.`);
  }
  return parsed;
}
