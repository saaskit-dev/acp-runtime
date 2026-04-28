import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type Client,
} from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createAcpRemoteDaemonIdentity,
  createAcpRemoteDaemonRegistrationHeaders,
} from "../../../src/runtime/remote/daemon/host-identity.js";
import { createAcpRemoteDaemonConnection } from "../../../src/runtime/remote/daemon/relay-connection.js";
import { createAcpJsonRpcWebSocketStream } from "../../../src/runtime/remote/protocol/index.js";
import { createStdioAcpConnectionFactory } from "../../../src/runtime/acp/stdio-connection.js";
import { SIMULATOR_AGENT_ACP_REGISTRY_ID } from "../../../src/runtime/agents/simulator-agent-acp.js";
import { AcpRuntime } from "../../../src/runtime/core/runtime.js";
import { resolveBuiltSimulatorWorkspaceCliPath } from "../../../src/runtime/registry/simulator-workspace.js";
import { createAcpRelayAccountSessionToken } from "./account-session.js";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1Value,
} from "./control-plane-store.js";
import worker, { AcpRelayShard, type Env } from "./index.js";

type TestGlobal = typeof globalThis & {
  Response: typeof Response;
  WebSocketPair?: typeof WebSocketPair;
};

const testGlobal = globalThis as TestGlobal;
const originalResponse = testGlobal.Response;
const originalWebSocketPair = testGlobal.WebSocketPair;
const tempDirs: string[] = [];

beforeEach(() => {
  testGlobal.Response = FakeWorkerResponse as unknown as typeof Response;
  testGlobal.WebSocketPair =
    FakeWebSocketPair as unknown as typeof WebSocketPair;
});

afterEach(async () => {
  testGlobal.Response = originalResponse;
  testGlobal.WebSocketPair = originalWebSocketPair;
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("native ACP Worker relay smoke", () => {
  it("runs native ACP initialize/authenticate/session through Worker and Durable Object into the simulator", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-remote-worker-smoke-"));
    const projectDir = join(root, "project");
    const storageDir = join(root, "simulator-storage");
    await mkdir(projectDir, { recursive: true });
    await mkdir(storageDir, { recursive: true });
    tempDirs.push(root);

    const identity = await createAcpRemoteDaemonIdentity(
      new Date("2026-04-28T00:00:00.000Z"),
    );
    const database = new FakeD1Database({
      accounts: [{ account_id: "acct-smoke", disabled: 0 }],
      clientDevices: [
        {
          account_id: "acct-smoke",
          client_device_id: "native-acp-client",
          disabled: 0,
          public_key: "native-client-key-not-used",
        },
      ],
      grants: [
        {
          account_id: "acct-smoke",
          client_device_id: null,
          grant_id: "grant-smoke",
          host_id: "host-smoke",
          policy_version: 1,
          revoked: 0,
          scopes_json: JSON.stringify([
            "acp:connect",
            "acp:session:create",
            "acp:session:resume",
            "acp:turn:send",
          ]),
          workspace_id: null,
          workspace_roots_json: JSON.stringify([root]),
        },
      ],
      hosts: [
        {
          account_id: "acct-smoke",
          disabled: 0,
          host_id: "host-smoke",
          public_key: identity.publicKey,
        },
      ],
    });
    const env = createSmokeEnv(database);

    const daemonHeaders = await createAcpRemoteDaemonRegistrationHeaders({
      accountId: "acct-smoke",
      hostId: "host-smoke",
      identity,
      nonce: "daemon-nonce",
    });
    const daemonResponse = await worker.fetch(
      new Request("https://relay.test/daemon?accountId=acct-smoke&hostId=host-smoke", {
        headers: {
          ...daemonHeaders,
          Upgrade: "websocket",
        },
      }),
      env,
    );
    expect(daemonResponse.status).toBe(101);
    const daemonSocket = responseWebSocket(daemonResponse);
    const runtime = new AcpRuntime(createStdioAcpConnectionFactory());
    const daemon = createAcpRemoteDaemonConnection({
      agent: {
        args: [resolveBuiltSimulatorWorkspaceCliPath(), "--storage-dir", storageDir],
        command: process.execPath,
        type: SIMULATOR_AGENT_ACP_REGISTRY_ID,
      },
      hostId: "host-smoke",
      runtime,
      socket: daemonSocket,
      ticketVerificationKeys: [
        {
          kid: "test-key",
          secret: "relay-ticket-secret",
        },
      ],
    });

    const connectionId = "conn-worker-smoke";
    const clientResponse = await worker.fetch(
      new Request(
        `https://relay.test/acp?accountId=acct-smoke&connectionId=${connectionId}`,
        {
          headers: {
            Upgrade: "websocket",
          },
        },
      ),
      env,
    );
    expect(clientResponse.status).toBe(101);
    const nativeClientSocket = responseWebSocket(clientResponse);
    const notifications: unknown[] = [];
    const clientConnection = new ClientSideConnection(
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
          async sessionUpdate(params) {
            notifications.push(params);
          },
        }) satisfies Client,
      createAcpJsonRpcWebSocketStream(nativeClientSocket),
    );

    const initialize = await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(initialize.agentInfo?.name).toBe("acp-runtime-relay");
    expect(initialize.authMethods?.[0]?.id).toBe("acp-runtime-browser");

    const authentication = clientConnection.authenticate({
      methodId: "acp-runtime-browser",
    });
    const accountSession = await createAcpRelayAccountSessionToken({
      secret: "account-session-secret",
      session: {
        accountId: "acct-smoke",
        expiresAt: "2099-04-28T00:00:00.000Z",
        sessionId: "session-smoke",
      },
    });
    const authorizeResponse = await worker.fetch(
      new Request(
        `https://relay.test/authorize?accountId=acct-smoke&connectionId=${connectionId}&hostId=host-smoke`,
        {
          headers: {
            authorization: `Bearer ${accountSession}`,
          },
        },
      ),
      env,
    );
    expect(authorizeResponse.status).toBe(200);
    await expect(authentication).resolves.toMatchObject({
      _meta: {
        "acp-runtime/remote/hostId": "host-smoke",
        "acp-runtime/remote/ticketKid": "test-key",
      },
    });

    const session = await clientConnection.newSession({
      cwd: projectDir,
      mcpServers: [],
    });
    expect(session.sessionId).toBeTruthy();

    const response = await clientConnection.prompt({
      prompt: [{ text: "/help", type: "text" }],
      sessionId: session.sessionId,
    });
    expect(response.stopReason).toBe("end_turn");
    expect(
      notifications.some(
        (notification) =>
          isAcpTextNotification(notification) &&
          notification.update.content.text.includes("Simulator Agent ACP"),
      ),
    ).toBe(true);

    await clientConnection.closeSession({ sessionId: session.sessionId });
    daemon.close();
    nativeClientSocket.close();
  });
});

function createSmokeEnv(database: FakeD1Database): Env {
  const env = {
    ACP_RELAY_ACCOUNT_SESSION_SECRET: "account-session-secret",
    ACP_RELAY_CONTROL_PLANE_SECRET: "control-plane-secret",
    ACP_RELAY_DB: database as unknown as D1Database,
    ACP_RELAY_SHARDS: undefined as unknown as DurableObjectNamespace,
    ACP_RELAY_TICKET_KID: "test-key",
    ACP_RELAY_TICKET_SECRET: "relay-ticket-secret",
  } satisfies Env;
  const shard = new AcpRelayShard(
    {
      storage: {
        async setAlarm() {},
      },
    } as DurableObjectState,
    env,
  );
  env.ACP_RELAY_SHARDS = {
    get() {
      return {
        fetch(request: Request) {
          return shard.fetch(request);
        },
      };
    },
    idFromName() {
      return {} as DurableObjectId;
    },
  } as DurableObjectNamespace;
  return env;
}

function responseWebSocket(response: Response): MemoryWebSocket {
  const webSocket = (response as Response & { webSocket?: MemoryWebSocket })
    .webSocket;
  if (!webSocket) {
    throw new Error("Expected WebSocket response.");
  }
  return webSocket;
}

class FakeWorkerResponse {
  readonly headers: Headers;
  readonly status: number;
  readonly webSocket: MemoryWebSocket | undefined;
  private readonly bodyText: string;

  constructor(
    body: BodyInit | null = null,
    init: (ResponseInit & { webSocket?: MemoryWebSocket }) | undefined = {},
  ) {
    this.headers = new Headers(init.headers);
    this.status = init.status ?? 200;
    this.webSocket = init.webSocket;
    this.bodyText = serializeResponseBody(body);
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.bodyText);
  }

  async text(): Promise<string> {
    return this.bodyText;
  }

  static redirect(url: string | URL, status = 302): FakeWorkerResponse {
    return new FakeWorkerResponse(null, {
      headers: {
        location: url.toString(),
      },
      status,
    });
  }
}

function serializeResponseBody(body: BodyInit | null): string {
  if (body === null) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  return "";
}

class FakeWebSocketPair {
  readonly 0: MemoryWebSocket;
  readonly 1: MemoryWebSocket;

  constructor() {
    const [client, server] = createMemoryWebSocketPair();
    this[0] = client;
    this[1] = server;
  }
}

class MemoryWebSocket {
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<() => void>();
  private readonly messageListeners = new Set<(event: { data: unknown }) => void>();
  private closed = false;
  peer?: MemoryWebSocket;

  accept(): void {}

  addEventListener(type: "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: "close" | "error" | "message",
    listener: (() => void) | ((event: { data: unknown }) => void),
  ): void {
    if (type === "message") {
      this.messageListeners.add(listener as (event: { data: unknown }) => void);
    } else if (type === "close") {
      this.closeListeners.add(listener as () => void);
    } else {
      this.errorListeners.add(listener as () => void);
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
    } else if (type === "close") {
      this.closeListeners.delete(listener as () => void);
    } else {
      this.errorListeners.delete(listener as () => void);
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

function createMemoryWebSocketPair(): [MemoryWebSocket, MemoryWebSocket] {
  const left = new MemoryWebSocket();
  const right = new MemoryWebSocket();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

function isAcpTextNotification(value: unknown): value is {
  update: {
    content: {
      text: string;
      type: "text";
    };
  };
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "update" in value &&
    typeof value.update === "object" &&
    value.update !== null &&
    "content" in value.update &&
    typeof value.update.content === "object" &&
    value.update.content !== null &&
    "type" in value.update.content &&
    value.update.content.type === "text" &&
    "text" in value.update.content &&
    typeof value.update.content.text === "string"
  );
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
}
