import { basename, isAbsolute, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";

import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  Client,
  CloseSessionRequest,
  CloseSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";

import type {
  AcpConnection,
  AcpConnectionFactory,
  AcpConnectionHandle,
} from "../../acp/connection-types.js";
import type {
  AcpRuntimeAgent,
  AcpRuntimeAgentInput,
} from "../../core/types.js";
import { emitRuntimeSuppressedError } from "../../observability/logging.js";
import { resolveRuntimeAgentFromRegistry } from "../../registry/agent-resolver.js";
import { createRemoteInitializeResponse } from "./mappers.js";

export type AcpRemoteProxyAgentOptions = {
  agent?: AcpRuntimeAgentInput;
  connectionFactory: AcpConnectionFactory;
  agentInfo?: InitializeResponse["agentInfo"];
  remoteDaemonId?: string;
  remoteMachineName?: string;
  sessionAgent?: AcpRuntimeAgentInput;
  workspaceRoots?: readonly string[];
};

type ActiveProxyConnection = {
  agent: AcpRuntimeAgentInput;
  connection: AcpConnection;
  cwd: string;
  dispose?: (() => Promise<void> | void) | undefined;
  remoteConfigOptions: SessionConfigOption[];
  sessionIds: Set<string>;
  terminalHandles: Map<
    string,
    Awaited<ReturnType<AgentSideConnection["createTerminal"]>>
  >;
  workspaceRoots?: readonly string[];
};

type SessionScopedParams = {
  _meta?: Record<string, unknown> | null;
  sessionId: string;
};

const REMOTE_SESSION_AGENT_META = "acp-runtime/remote/sessionAgent";
const REMOTE_SESSION_WORKSPACE_ROOTS_META =
  "acp-runtime/remote/sessionWorkspaceRoots";
const REMOTE_DAEMON_ID_META = "acp-runtime/remote/daemonId";
const REMOTE_CONFIG_OPTION_PREFIX = "acp-runtime.remote.";

export class AcpRemoteProxyAgent implements Agent {
  private initializeParams: InitializeRequest | undefined;
  private readonly connections = new Set<ActiveProxyConnection>();
  private readonly sessionConnections = new Map<string, ActiveProxyConnection>();
  private readonly sessionRestorePromises = new Map<
    string,
    Promise<ActiveProxyConnection>
  >();

  constructor(
    private readonly outer: AgentSideConnection,
    private readonly options: AcpRemoteProxyAgentOptions,
  ) {}

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.initializeParams = params;
    return createRemoteInitializeResponse(params, {
      agentInfo: this.options.agentInfo,
    });
  }

  async authenticate(
    params: AuthenticateRequest,
  ): Promise<AuthenticateResponse | void> {
    const active = await this.ensureConnectionForParams(params, "authenticate");
    return active.connection.authenticate(stripRemoteSelection(params));
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const active = await this.createConnectionForSessionOpen(
      params,
      "session/new",
    );
    const response = await active.connection.newSession(
      stripRemoteSelection({ ...params, cwd: active.cwd }),
    );
    this.registerSession(active, response.sessionId);
    return this.decorateSessionResponse(response, active, params);
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const active = await this.createConnectionForSessionOpen(
      params,
      "session/load",
    );
    const response = await active.connection.loadSession?.(
      stripRemoteSelection({ ...params, cwd: active.cwd }),
    );
    if (!response) {
      throw RequestError.invalidParams(
        { method: "session/load", sessionId: params.sessionId },
        "ACP agent does not support session/load.",
      );
    }
    this.registerSession(active, params.sessionId);
    return this.decorateSessionResponse(response, active, params);
  }

  async resumeSession(
    params: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
    const active = await this.createConnectionForSessionOpen(
      params,
      "session/resume",
    );
    const response = await active.connection.resumeSession?.(
      stripRemoteSelection({ ...params, cwd: active.cwd }),
    );
    if (!response) {
      throw RequestError.invalidParams(
        { method: "session/resume", sessionId: params.sessionId },
        "ACP agent does not support session/resume.",
      );
    }
    this.registerSession(active, params.sessionId);
    return this.decorateSessionResponse(response, active, params);
  }

  async listSessions(
    params: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const active = await this.ensureConnectionForParams(params, "session/list");
    const response = await active.connection.listSessions?.(
      stripRemoteSelection(params),
    );
    if (!response) {
      throw RequestError.invalidParams(
        { method: "session/list" },
        "ACP agent does not support session/list.",
      );
    }
    return {
      ...response,
      sessions: response.sessions.map((session) =>
        addRemoteSessionMetadata(
          session,
          this.createRemoteSessionMetadata(
            active,
            session.cwd ?? active.cwd,
          ),
        ),
      ),
    };
  }

  async closeSession(
    params: CloseSessionRequest,
  ): Promise<CloseSessionResponse | void> {
    const active = await this.getOrRestoreSession(params, "session/close");
    const response = await active.connection.closeSession?.(
      stripRemoteSelection(params),
    );
    this.unregisterSession(active, params.sessionId);
    if (active.sessionIds.size === 0) {
      await this.disposeConnection(active);
    }
    return response ?? {};
  }

  async setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse | void> {
    const active = await this.getOrRestoreSession(params, "session/set_mode");
    return active.connection.setSessionMode?.(stripRemoteSelection(params));
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const active = await this.getOrRestoreSession(
      params,
      "session/set_config_option",
    );
    if (params.configId.startsWith(REMOTE_CONFIG_OPTION_PREFIX)) {
      return { configOptions: active.remoteConfigOptions };
    }
    const response = await active.connection.setSessionConfigOption?.(
      stripRemoteSelection(params),
    );
    if (!response) {
      throw RequestError.invalidParams(
        {
          configId: params.configId,
          sessionId: params.sessionId,
        },
        "ACP agent does not support session/set_config_option.",
      );
    }
    return addRemoteConfigOptions(response, active.remoteConfigOptions);
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const active = await this.getOrRestoreSession(params, "session/prompt");
    return active.connection.prompt(stripRemoteSelection(params));
  }

  async cancel(params: CancelNotification): Promise<void> {
    const active = this.sessionConnections.get(params.sessionId);
    if (!active) {
      return;
    }
    await active.connection.cancel(stripRemoteSelection(params));
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.connections].map((connection) =>
        this.disposeConnection(connection),
      ),
    );
  }

  private async createConnectionForSessionOpen(
    params: NewSessionRequest | LoadSessionRequest | ResumeSessionRequest,
    method: string,
  ): Promise<ActiveProxyConnection> {
    const selection = readSessionSelection(params);
    const workspaceRoots = selection.workspaceRoots ?? this.options.workspaceRoots;
    const cwdInput = selection.workspaceRoots?.[0] ?? params.cwd;
    const cwd = await this.authorizeRequiredWorkspaceCwd(
      cwdInput,
      method,
      workspaceRoots,
    );
    const agent = selection.agent ?? this.options.sessionAgent ?? this.requireAgent();
    return this.createInitializedConnection({
      agent,
      cwd,
      workspaceRoots,
    });
  }

  private async ensureConnectionForParams(
    params: unknown,
    method: string,
  ): Promise<ActiveProxyConnection> {
    const selection = readSessionSelection(params);
    const workspaceRoots = selection.workspaceRoots ?? this.options.workspaceRoots;
    const cwdInput =
      readCwd(params) ?? selection.workspaceRoots?.[0] ?? workspaceRoots?.[0];
    if (!cwdInput) {
      throw RequestError.invalidParams(
        { method },
        `Remote workspace policy requires cwd for ${method}.`,
      );
    }
    const cwd = await this.authorizeRequiredWorkspaceCwd(
      cwdInput,
      method,
      workspaceRoots,
    );
    const agent = selection.agent ?? this.options.sessionAgent ?? this.requireAgent();
    const existing = [...this.connections].find(
      (connection) =>
        sameAgent(connection.agent, agent) && pathContains(connection.cwd, cwd),
    );
    return (
      existing ??
      this.createInitializedConnection({
        agent,
        cwd,
        workspaceRoots,
      })
    );
  }

  private async getOrRestoreSession(
    params: SessionScopedParams,
    method: string,
  ): Promise<ActiveProxyConnection> {
    const active = this.sessionConnections.get(params.sessionId);
    if (active) {
      return active;
    }

    const existingRestore = this.sessionRestorePromises.get(params.sessionId);
    if (existingRestore) {
      return existingRestore;
    }

    const restore = this.restoreSession(params, method);
    this.sessionRestorePromises.set(params.sessionId, restore);
    try {
      return await restore;
    } finally {
      this.sessionRestorePromises.delete(params.sessionId);
    }
  }

  private async restoreSession(
    params: SessionScopedParams,
    method: string,
  ): Promise<ActiveProxyConnection> {
    const active = await this.ensureConnectionForParams(params, method);
    const stripped = stripRemoteSelection({
      cwd: active.cwd,
      mcpServers: [],
      sessionId: params.sessionId,
    });
    try {
      const loaded = await active.connection.loadSession?.(stripped);
      if (loaded) {
        this.registerSession(active, params.sessionId);
        return active;
      }
    } catch (firstError) {
      try {
        const resumed = await active.connection.resumeSession?.(stripped);
        if (resumed) {
          this.registerSession(active, params.sessionId);
          return active;
        }
      } catch (secondError) {
        throw RequestError.invalidParams(
          {
            firstError: formatError(firstError),
            method,
            secondError: formatError(secondError),
            sessionId: params.sessionId,
          },
          `Remote ACP session could not be restored: ${params.sessionId}`,
        );
      }
      throw RequestError.invalidParams(
        {
          firstError: formatError(firstError),
          method,
          sessionId: params.sessionId,
        },
        `Remote ACP session could not be restored: ${params.sessionId}`,
      );
    }
    throw RequestError.invalidParams(
      { method, sessionId: params.sessionId },
      `Remote ACP session could not be restored: ${params.sessionId}`,
    );
  }

  private async createInitializedConnection(input: {
    agent: AcpRuntimeAgentInput;
    cwd: string;
    workspaceRoots?: readonly string[];
  }): Promise<ActiveProxyConnection> {
    const terminalHandles = new Map<
      string,
      Awaited<ReturnType<AgentSideConnection["createTerminal"]>>
    >();
    const resolvedAgent = await resolveAgentInput(input.agent);
    let handle: AcpConnectionHandle | undefined;
    try {
      handle = await this.options.connectionFactory({
        agent: resolvedAgent,
        client: this.createForwardingClient(terminalHandles),
        cwd: input.cwd,
      });
      await handle.connection.initialize(
        this.initializeParams ?? {
          clientCapabilities: {},
          protocolVersion: 1,
        },
      );
      const active: ActiveProxyConnection = {
        agent: input.agent,
        connection: handle.connection,
        cwd: input.cwd,
        dispose: handle.dispose,
        remoteConfigOptions: createRemoteConfigOptions({
          agent: input.agent,
          machine: this.options.remoteMachineName,
          workspace: input.workspaceRoots?.[0] ?? input.cwd,
        }),
        sessionIds: new Set(),
        terminalHandles,
        workspaceRoots: input.workspaceRoots ?? [input.cwd],
      };
      this.connections.add(active);
      void active.connection.closed.finally(() => {
        void this.disposeConnection(active);
      });
      return active;
    } catch (error) {
      await handle?.dispose?.();
      throw error;
    }
  }

  private createForwardingClient(
    terminalHandles: Map<
      string,
      Awaited<ReturnType<AgentSideConnection["createTerminal"]>>
    >,
  ): Client {
    return {
      requestPermission: (params) => this.outer.requestPermission(params),
      sessionUpdate: (params) => this.outer.sessionUpdate(params),
      readTextFile: (params) => this.outer.readTextFile(params),
      writeTextFile: (params) => this.outer.writeTextFile(params),
      createTerminal: async (params) => {
        const handle = await this.outer.createTerminal(params);
        terminalHandles.set(handle.id, handle);
        return { terminalId: handle.id };
      },
      terminalOutput: (params) =>
        requireTerminal(terminalHandles, params.terminalId).currentOutput(),
      waitForTerminalExit: (params) =>
        requireTerminal(terminalHandles, params.terminalId).waitForExit(),
      killTerminal: (params) =>
        requireTerminal(terminalHandles, params.terminalId).kill(),
      releaseTerminal: async (params) => {
        const handle = requireTerminal(terminalHandles, params.terminalId);
        terminalHandles.delete(params.terminalId);
        return handle.release();
      },
      unstable_createElicitation: (params) =>
        this.outer.unstable_createElicitation(params),
      unstable_completeElicitation: (params) =>
        this.outer.unstable_completeElicitation(params),
      extMethod: (method, params) => this.outer.extMethod(method, params),
      extNotification: (method, params) =>
        this.outer.extNotification(method, params),
    };
  }

  private decorateSessionResponse<
    T extends { configOptions?: SessionConfigOption[] | null },
  >(response: T, active: ActiveProxyConnection, params: unknown): T & {
    _meta: Record<string, unknown>;
    configOptions: SessionConfigOption[];
  } {
    return addRemoteSessionMetadata(
      addRemoteConfigOptions(response, active.remoteConfigOptions),
      this.createRemoteSessionMetadata(active, readCwd(params) ?? active.cwd),
    );
  }

  private createRemoteSessionMetadata(
    active: ActiveProxyConnection,
    cwd: string,
  ): Record<string, unknown> {
    return createRemoteSessionMetadata({
      agent: active.agent,
      daemonId: this.options.remoteDaemonId,
      workspaceRoots: active.workspaceRoots ?? (cwd ? [cwd] : undefined),
    });
  }

  private registerSession(
    active: ActiveProxyConnection,
    sessionId: string,
    alias?: string,
  ): void {
    active.sessionIds.add(sessionId);
    this.sessionConnections.set(sessionId, active);
    if (alias && alias !== sessionId) {
      active.sessionIds.add(alias);
      this.sessionConnections.set(alias, active);
    }
  }

  private unregisterSession(
    active: ActiveProxyConnection,
    sessionId: string,
  ): void {
    active.sessionIds.delete(sessionId);
    this.sessionConnections.delete(sessionId);
  }

  private async disposeConnection(active: ActiveProxyConnection): Promise<void> {
    if (!this.connections.has(active)) {
      return;
    }
    this.connections.delete(active);
    for (const sessionId of active.sessionIds) {
      this.sessionConnections.delete(sessionId);
    }
    active.sessionIds.clear();
    await Promise.all(
      [...active.terminalHandles.values()].map((handle) =>
        handle.release().catch((error) => {
          emitRuntimeSuppressedError({
            attributes: {
              "acp.remote.agent": formatAgent(active.agent),
              "acp.remote.terminal.id": handle.id,
            },
            body: "Remote proxy terminal release failed during cleanup.",
            eventName: "acp.remote.proxy.terminal.release.failed",
            exception: error,
          });
        }),
      ),
    );
    active.terminalHandles.clear();
    await active.dispose?.();
  }

  private requireAgent(): AcpRuntimeAgentInput {
    if (!this.options.agent) {
      throw RequestError.invalidParams(
        {},
        "No agent configured. Select an agent during authorization.",
      );
    }
    return this.options.agent;
  }

  private async authorizeWorkspaceCwd(
    cwd: string | null | undefined,
    method: string,
    workspaceRoots = this.options.workspaceRoots,
  ): Promise<string | undefined> {
    if (!workspaceRoots?.length) {
      return cwd ?? undefined;
    }
    if (!cwd) {
      throw RequestError.invalidParams(
        { method },
        `Remote workspace policy requires cwd for ${method}.`,
      );
    }

    const resolvedCwd = await safeRealpath(resolve(cwd));
    const allowed = (
      await Promise.all(workspaceRoots.map((r) => safeRealpath(resolve(r))))
    ).some((root) => pathContains(root, resolvedCwd));
    if (!allowed) {
      throw RequestError.invalidParams(
        { cwd, method },
        "Remote workspace policy denied cwd.",
      );
    }
    return resolvedCwd;
  }

  private authorizeRequiredWorkspaceCwd(
    cwd: string,
    method: string,
    workspaceRoots = this.options.workspaceRoots,
  ): Promise<string> {
    return this.authorizeWorkspaceCwd(cwd, method, workspaceRoots).then(
      (resolvedCwd) => resolvedCwd ?? cwd,
    );
  }
}

async function resolveAgentInput(
  agent: AcpRuntimeAgentInput,
): Promise<AcpRuntimeAgent> {
  if (typeof agent === "string") {
    return resolveRuntimeAgentFromRegistry(agent);
  }
  return agent;
}

function readSessionSelection(params: unknown): {
  agent?: AcpRuntimeAgentInput;
  workspaceRoots?: readonly string[];
} {
  if (!isRecord(params) || !isRecord(params._meta)) {
    return {};
  }
  return {
    agent: readSessionAgent(params._meta[REMOTE_SESSION_AGENT_META]),
    workspaceRoots: readStringArray(
      params._meta[REMOTE_SESSION_WORKSPACE_ROOTS_META],
    ),
  };
}

function readSessionAgent(value: unknown): AcpRuntimeAgentInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.id === "string" && value.id.trim()) {
    return value.id;
  }
  if (typeof value.command !== "string" || !value.command.trim()) {
    return undefined;
  }
  return {
    args: Array.isArray(value.args)
      ? value.args.filter((arg): arg is string => typeof arg === "string")
      : undefined,
    command: value.command,
    env: isStringRecord(value.env) ? value.env : undefined,
    type: typeof value.type === "string" ? value.type : undefined,
  };
}

function stripRemoteSelection<T>(params: T): T {
  if (!isRecord(params) || !isRecord(params._meta)) {
    return params;
  }
  const meta = { ...params._meta };
  delete meta[REMOTE_DAEMON_ID_META];
  delete meta[REMOTE_SESSION_AGENT_META];
  delete meta[REMOTE_SESSION_WORKSPACE_ROOTS_META];
  const result: Record<string, unknown> = { ...params };
  if (Object.keys(meta).length > 0) {
    result._meta = meta;
  } else {
    delete result._meta;
  }
  return result as T;
}

function readCwd(params: unknown): string | undefined {
  return isRecord(params) && typeof params.cwd === "string"
    ? params.cwd
    : undefined;
}

function sameAgent(
  left: AcpRuntimeAgentInput,
  right: AcpRuntimeAgentInput,
): boolean {
  return JSON.stringify(serializeSessionAgent(left)) === JSON.stringify(serializeSessionAgent(right));
}

function requireTerminal(
  terminalHandles: Map<
    string,
    Awaited<ReturnType<AgentSideConnection["createTerminal"]>>
  >,
  terminalId: string,
): Awaited<ReturnType<AgentSideConnection["createTerminal"]>> {
  const handle = terminalHandles.get(terminalId);
  if (!handle) {
    throw RequestError.invalidParams(
      { terminalId },
      `Unknown remote terminal: ${terminalId}`,
    );
  }
  return handle;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function addRemoteSessionMetadata<T extends object>(
  response: T,
  metadata: Record<string, unknown>,
): T & { _meta: Record<string, unknown> } {
  const existingMeta =
    "_meta" in response && isRecord(response._meta) ? response._meta : {};
  return {
    ...response,
    _meta: {
      ...existingMeta,
      ...metadata,
    },
  };
}

function createRemoteSessionMetadata(input: {
  agent?: AcpRuntimeAgentInput;
  daemonId?: string;
  workspaceRoots?: readonly string[];
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (input.daemonId) {
    metadata[REMOTE_DAEMON_ID_META] = input.daemonId;
  }
  const agent = serializeSessionAgent(input.agent);
  if (agent) {
    metadata[REMOTE_SESSION_AGENT_META] = agent;
  }
  if (input.workspaceRoots?.length) {
    metadata[REMOTE_SESSION_WORKSPACE_ROOTS_META] = input.workspaceRoots;
  }
  return metadata;
}

function serializeSessionAgent(
  agent: AcpRuntimeAgentInput | undefined,
): Record<string, unknown> | undefined {
  if (!agent) {
    return undefined;
  }
  if (typeof agent === "string") {
    return { id: agent };
  }
  const serialized: Record<string, unknown> = {
    command: agent.command,
  };
  if (agent.args?.length) {
    serialized.args = agent.args;
  }
  if (agent.env && Object.keys(agent.env).length) {
    serialized.env = agent.env;
  }
  if (agent.type) {
    serialized.type = agent.type;
  }
  return serialized;
}

function addRemoteConfigOptions<
  T extends { configOptions?: SessionConfigOption[] | null },
>(
  response: T,
  remoteConfigOptions: readonly SessionConfigOption[],
): T & { configOptions: SessionConfigOption[] } {
  return {
    ...response,
    configOptions: [
      ...(response.configOptions ?? []),
      ...remoteConfigOptions,
    ],
  };
}

function createRemoteConfigOptions(input: {
  agent?: AcpRuntimeAgentInput;
  machine?: string;
  workspace?: string;
}): SessionConfigOption[] {
  return [
    createReadonlyRemoteOption(
      "machine",
      "Remote Machine",
      input.machine ?? "Unknown machine",
      "Machine selected in ACP relay authorization.",
    ),
    createReadonlyRemoteOption(
      "agent",
      "Remote Agent",
      formatAgent(input.agent),
      "Agent selected in ACP relay authorization.",
    ),
    createReadonlyRemoteOption(
      "workspace",
      "Remote Workspace",
      input.workspace ?? "No workspace preference",
      "Workspace selected in ACP relay authorization.",
    ),
  ];
}

function createReadonlyRemoteOption(
  key: string,
  name: string,
  value: string,
  description: string,
): SessionConfigOption {
  return {
    category: "remote",
    currentValue: value,
    description,
    id: `${REMOTE_CONFIG_OPTION_PREFIX}${key}`,
    name,
    options: [{ name: value, value }],
    type: "select",
  };
}

function formatAgent(agent: AcpRuntimeAgentInput | undefined): string {
  if (!agent) {
    return "Default daemon agent";
  }
  if (typeof agent === "string") {
    return agent;
  }
  if (agent.type) {
    return agent.type;
  }
  return basename(agent.command);
}

function pathContains(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

async function safeRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = "cause" in error ? error.cause : undefined;
  return cause ? `${error.message} Caused by: ${formatError(cause)}` : error.message;
}
