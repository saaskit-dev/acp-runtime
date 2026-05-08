import { isAbsolute, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";

import type {
  Agent,
  AgentCapabilities,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  ClientCapabilities,
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
} from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";

import type { AcpRuntimeSession } from "../../core/session.js";
import type {
  AcpRuntimeAgentInput,
  AcpRuntimeAuthorityHandlers,
  AcpRuntimeConfigValue,
  AcpRuntimeListSessionsOptions,
  AcpRuntimeSessionList,
  AcpRuntimeStartSessionOptions,
} from "../../core/types.js";
import {
  mapAcpMcpServersToRuntime,
  mapAcpPermissionOutcomeToRuntimeDecision,
  mapAcpPromptToRuntimePrompt,
  mapRemotePermissionRequestToAcp,
  mapRuntimeConfigOptionsToAcp,
  mapRuntimeHistoryEntryToAcpNotifications,
  mapRuntimeSessionListToAcp,
  mapRuntimeSessionToAcpResponse,
  mapRuntimeTurnCompletionToAcp,
  mapRuntimeTurnEventToAcpNotifications,
  createRemoteInitializeResponse,
} from "./mappers.js";
import { traceContextFromMeta } from "../../observability/tracing.js";

type RemoteRuntimeSessions = {
  list(
    options?: AcpRuntimeListSessionsOptions & {
      _traceContext?: import("@opentelemetry/api").Context;
    },
  ): Promise<AcpRuntimeSessionList>;
  load(options: {
    agent?: AcpRuntimeAgentInput;
    cwd?: string;
    handlers?: AcpRuntimeAuthorityHandlers;
    mcpServers?: ReturnType<typeof mapAcpMcpServersToRuntime>;
    sessionId: string;
    _traceContext?: import("@opentelemetry/api").Context;
  }): Promise<AcpRuntimeSession>;
  resume(options: {
    agent?: AcpRuntimeAgentInput;
    cwd?: string;
    handlers?: AcpRuntimeAuthorityHandlers;
    mcpServers?: ReturnType<typeof mapAcpMcpServersToRuntime>;
    sessionId: string;
    _traceContext?: import("@opentelemetry/api").Context;
  }): Promise<AcpRuntimeSession>;
  start(
    options: AcpRuntimeStartSessionOptions & {
      _traceContext?: import("@opentelemetry/api").Context;
    },
  ): Promise<AcpRuntimeSession>;
};

export type AcpRemoteRuntimeAgentOptions = {
  agent?: AcpRuntimeAgentInput;
  agentCapabilities?: AgentCapabilities;
  agentInfo?: InitializeResponse["agentInfo"];
  remoteDaemonId?: string;
  remoteMachineName?: string;
  runtime: {
    sessions: RemoteRuntimeSessions;
  };
  sessionAgent?: AcpRuntimeAgentInput;
  workspaceRoots?: readonly string[];
};

type ActiveRemoteSession = {
  session: AcpRuntimeSession;
  terminalHandles: Map<string, Awaited<ReturnType<AgentSideConnection["createTerminal"]>>>;
  turnId?: string;
};

type SessionScopedParams = {
  _meta?: Record<string, unknown> | null;
  sessionId: string;
};

const REMOTE_SESSION_AGENT_META = "acp-runtime/remote/sessionAgent";
const REMOTE_SESSION_MACHINE_META = "acp-runtime/remote/sessionMachine";
const REMOTE_SESSION_WORKSPACE_ROOTS_META =
  "acp-runtime/remote/sessionWorkspaceRoots";
const REMOTE_DAEMON_ID_META = "acp-runtime/remote/daemonId";

export class AcpRemoteRuntimeAgent implements Agent {
  private clientCapabilities: ClientCapabilities = {};
  private readonly sessions = new Map<string, ActiveRemoteSession>();
  private readonly sessionRestorePromises = new Map<
    string,
    Promise<ActiveRemoteSession>
  >();

  constructor(
    private readonly connection: AgentSideConnection,
    private readonly options: AcpRemoteRuntimeAgentOptions,
  ) {}

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = params.clientCapabilities ?? {};
    return createRemoteInitializeResponse(params, {
      agentCapabilities: this.options.agentCapabilities,
      agentInfo: this.options.agentInfo,
    });
  }

  async authenticate(
    _params: AuthenticateRequest,
  ): Promise<AuthenticateResponse | void> {
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const traceContext = traceContextFromParams(params);
    const selection = readSessionSelection(params);
    const workspaceRoots = selection.workspaceRoots ?? this.options.workspaceRoots;
    const cwdInput = selection.workspaceRoots?.[0] ?? params.cwd;
    const cwd = await this.authorizeRequiredWorkspaceCwd(
      cwdInput,
      "session/new",
      workspaceRoots,
    );
    const session = await this.options.runtime.sessions.start({
      agent: selection.agent ?? this.requireAgent(),
      cwd,
      handlers: this.createAuthorityHandlers(),
      mcpServers: mapAcpMcpServersToRuntime(params.mcpServers),
      _traceContext: traceContext,
    });
    this.storeActiveSession(session);
    return addRemoteSessionMetadata(
      mapRuntimeSessionToAcpResponse(session.metadata),
      this.createRemoteSessionMetadata(selection, cwd),
    );
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const traceContext = traceContextFromParams(params);
    const selection = readSessionSelection(params);
    const workspaceRoots = selection.workspaceRoots ?? this.options.workspaceRoots;
    const cwdInput = selection.workspaceRoots?.[0] ?? params.cwd;
    const cwd = await this.authorizeRequiredWorkspaceCwd(
      cwdInput,
      "session/load",
      workspaceRoots,
    );
    const agent = selection.agent ?? this.requireAgent();
    const mcpServers = mapAcpMcpServersToRuntime(params.mcpServers ?? []);
    const session = await this.loadOrResumeRuntimeSession({
      agent,
      cwd,
      mcpServers,
      preferred: "load",
      method: "session/load",
      sessionId: params.sessionId,
      traceContext,
    });
    this.storeActiveSession(session, [params.sessionId]);
    await this.replayHistory(params.sessionId, session);
    return addRemoteSessionMetadata(
      mapRuntimeSessionToAcpResponse(session.metadata),
      this.createRemoteSessionMetadata({ agent }, cwd),
    );
  }

  async resumeSession(
    params: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
    const traceContext = traceContextFromParams(params);
    const selection = readSessionSelection(params);
    const workspaceRoots = selection.workspaceRoots ?? this.options.workspaceRoots;
    const cwdInput = selection.workspaceRoots?.[0] ?? params.cwd;
    const cwd = await this.authorizeRequiredWorkspaceCwd(
      cwdInput,
      "session/resume",
      workspaceRoots,
    );
    const agent = selection.agent ?? this.requireAgent();
    const mcpServers = mapAcpMcpServersToRuntime(params.mcpServers ?? []);
    const session = await this.loadOrResumeRuntimeSession({
      agent,
      cwd,
      mcpServers,
      preferred: "resume",
      method: "session/resume",
      sessionId: params.sessionId,
      traceContext,
    });
    this.storeActiveSession(session, [params.sessionId]);
    await this.replayHistory(params.sessionId, session);
    return addRemoteSessionMetadata(
      mapRuntimeSessionToAcpResponse(session.metadata),
      this.createRemoteSessionMetadata({ agent }, cwd),
    );
  }

  async listSessions(
    params: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const traceContext = traceContextFromParams(params);
    const cwd = await this.authorizeWorkspaceCwd(
      params.cwd ?? undefined,
      "session/list",
    );
    const list = mapRuntimeSessionListToAcp(
      await this.options.runtime.sessions.list({
        agent: this.requireAgent(),
        cursor: params.cursor ?? undefined,
        cwd,
        source: "all",
        _traceContext: traceContext,
      }),
    );
    return {
      ...list,
      sessions: list.sessions.map((session) =>
        addRemoteSessionMetadata(
          session,
          this.createRemoteSessionMetadata(
            { agent: this.options.sessionAgent ?? this.options.agent },
            session.cwd,
          ),
        ),
      ),
    };
  }

  async closeSession(
    params: CloseSessionRequest,
  ): Promise<CloseSessionResponse | void> {
    const active = await this.getOrRestoreSession(params, "session/close");
    await active.session.close();
    this.deleteSessionAliases(active);
    active.terminalHandles.clear();
    return {};
  }

  async setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse | void> {
    const active = await this.getOrRestoreSession(params, "session/set_mode");
    await active.session.agent.setMode(params.modeId);
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const active = await this.getOrRestoreSession(
      params,
      "session/set_config_option",
    );
    const value: AcpRuntimeConfigValue =
      "type" in params && params.type === "boolean" ? params.value : params.value;
    await active.session.agent.setConfigOption(params.configId, value);
    return {
      configOptions:
        mapRuntimeConfigOptionsToAcp(
          active.session.metadata.agentConfigOptions,
        ) ?? [],
    };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const active = await this.getOrRestoreSession(params, "session/prompt");
    const turn = active.session.turn.start(
      mapAcpPromptToRuntimePrompt(params.prompt),
    );
    active.turnId = turn.turnId;

    try {
      let completion:
        | import("../../core/types.js").AcpRuntimeTurnCompletion
        | undefined;
      for await (const event of turn.events) {
        for (const notification of mapRuntimeTurnEventToAcpNotifications(
          params.sessionId,
          event,
        )) {
          await this.connection.sessionUpdate(notification);
        }
        if (event.type === "completed") {
          completion = {
            output: event.output,
            outputText: event.outputText,
            turnId: event.turnId,
          };
        } else if (event.type === "cancelled") {
          return {
            stopReason: "cancelled",
            userMessageId: params.messageId ?? undefined,
          };
        } else if (event.type === "failed") {
          throw RequestError.internalError(
            { sessionId: params.sessionId, turnId: event.turnId },
            formatError(event.error),
          );
        }
      }

      if (!completion) {
        throw RequestError.internalError(
          { sessionId: params.sessionId },
          "Remote runtime turn ended without completion.",
        );
      }

      return mapRuntimeTurnCompletionToAcp(completion, {
        userMessageId: params.messageId,
      });
    } finally {
      if (active.turnId === turn.turnId) {
        active.turnId = undefined;
      }
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const active = await this.getOrRestoreSession(params, "session/cancel");
    if (active.turnId) {
      await active.session.turn.cancel(active.turnId);
    }
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

  private createRemoteSessionMetadata(
    selection: {
      agent?: AcpRuntimeAgentInput;
      workspaceRoots?: readonly string[];
    },
    cwd: string,
  ): Record<string, unknown> {
    return createRemoteSessionMetadata({
      agent:
        selection.agent ??
        this.options.sessionAgent ??
        this.options.agent,
      daemonId: this.options.remoteDaemonId,
      machine: this.options.remoteMachineName,
      workspaceRoots:
        selection.workspaceRoots ??
        this.options.workspaceRoots ??
      (cwd ? [cwd] : undefined),
    });
  }

  private async getOrRestoreSession(
    params: SessionScopedParams,
    method: string,
  ): Promise<ActiveRemoteSession> {
    const active = this.sessions.get(params.sessionId);
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
  ): Promise<ActiveRemoteSession> {
    const traceContext = traceContextFromParams(params);
    const selection = readSessionSelection(params);
    const workspaceRoots = selection.workspaceRoots ?? this.options.workspaceRoots;
    const cwdInput = selection.workspaceRoots?.[0] ?? workspaceRoots?.[0];
    if (!cwdInput) {
      throw RequestError.invalidParams(
        { method, sessionId: params.sessionId },
        `Unknown remote runtime session: ${params.sessionId}`,
      );
    }
    const cwd = await this.authorizeRequiredWorkspaceCwd(
      cwdInput,
      method,
      workspaceRoots,
    );
    const agent =
      selection.agent ?? this.options.sessionAgent ?? this.requireAgent();
    const session = await this.loadOrResumeRuntimeSession({
      agent,
      cwd,
      method,
      sessionId: params.sessionId,
      traceContext,
    });
    const active = this.storeActiveSession(session, [params.sessionId]);
    await this.replayHistory(params.sessionId, session);
    return active;
  }

  private async loadOrResumeRuntimeSession(input: {
    agent: AcpRuntimeAgentInput;
    cwd: string;
    mcpServers?: ReturnType<typeof mapAcpMcpServersToRuntime>;
    preferred?: "load" | "resume";
    method: string;
    sessionId: string;
    traceContext?: import("@opentelemetry/api").Context;
  }): Promise<AcpRuntimeSession> {
    const attempts =
      input.preferred === "resume"
        ? [
            this.options.runtime.sessions.resume.bind(this.options.runtime.sessions),
            this.options.runtime.sessions.load.bind(this.options.runtime.sessions),
          ]
        : [
            this.options.runtime.sessions.load.bind(this.options.runtime.sessions),
            this.options.runtime.sessions.resume.bind(this.options.runtime.sessions),
          ];
    let firstError: unknown;
    let secondError: unknown;
    for (const attempt of attempts) {
      try {
        return await attempt({
          agent: input.agent,
          cwd: input.cwd,
          handlers: this.createAuthorityHandlers(),
          mcpServers: input.mcpServers ?? [],
          sessionId: input.sessionId,
          _traceContext: input.traceContext,
        } as Parameters<typeof attempt>[0]);
      } catch (error) {
        if (firstError === undefined) {
          firstError = error;
        } else {
          secondError = error;
        }
      }
    }
    throw RequestError.invalidParams(
      {
        firstError: formatError(firstError),
        method: input.method,
        secondError: formatError(secondError),
        sessionId: input.sessionId,
      },
      `Remote runtime session could not be restored: ${input.sessionId}`,
    );
  }

  private storeActiveSession(
    session: AcpRuntimeSession,
    aliases: readonly string[] = [],
  ): ActiveRemoteSession {
    const active: ActiveRemoteSession = {
      session,
      terminalHandles: new Map(),
    };
    this.sessions.set(session.metadata.id, active);
    for (const alias of aliases) {
      if (alias !== session.metadata.id) {
        this.sessions.set(alias, active);
      }
    }
    return active;
  }

  private async replayHistory(
    sessionId: string,
    session: AcpRuntimeSession,
  ): Promise<void> {
    const history = session.state.history.drain();
    for (const entry of history) {
      for (const notification of mapRuntimeHistoryEntryToAcpNotifications(
        sessionId,
        entry,
      )) {
        await this.connection.sessionUpdate(notification);
      }
    }
  }

  private deleteSessionAliases(active: ActiveRemoteSession): void {
    for (const [sessionId, candidate] of this.sessions.entries()) {
      if (candidate === active || candidate.session === active.session) {
        this.sessions.delete(sessionId);
      }
    }
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
    return this.authorizeWorkspaceCwd(cwd, method, workspaceRoots).then((r) => r ?? cwd);
  }

  private createAuthorityHandlers(): AcpRuntimeAuthorityHandlers {
    const handlers: AcpRuntimeAuthorityHandlers = {
      permission: async (request) => {
        const response = await this.connection.requestPermission(
          mapRemotePermissionRequestToAcp(
            this.findSessionIdForTurn(request.turnId),
            request,
          ),
        );
        return mapAcpPermissionOutcomeToRuntimeDecision(response.outcome);
      },
    };

    if (this.clientCapabilities.fs?.readTextFile || this.clientCapabilities.fs?.writeTextFile) {
      handlers.filesystem = {
        readTextFile: async (path) => {
          const response = await this.connection.readTextFile({
            path,
            sessionId: this.findActiveSessionId(),
          });
          return response.content;
        },
        writeTextFile: async (input) => {
          await this.connection.writeTextFile({
            content: input.content,
            path: input.path,
            sessionId: this.findActiveSessionId(),
          });
        },
      };
    }

    if (this.clientCapabilities.terminal) {
      handlers.terminal = {
        kill: async (terminalId) => {
          const handle = this.findTerminalHandle(terminalId);
          await handle.kill();
        },
        output: async (terminalId) => {
          const output = await this.findTerminalHandle(
            terminalId,
          ).currentOutput();
          return {
            exitCode: output.exitStatus?.exitCode ?? null,
            output: output.output,
            truncated: output.truncated ?? false,
          };
        },
        release: async (terminalId) => {
          const handle = this.findTerminalHandle(terminalId);
          await handle.release();
          this.deleteTerminalHandle(terminalId);
        },
        start: async (request) => {
          const handle = await this.connection.createTerminal({
            args: request.args,
            command: request.command,
            cwd: request.cwd,
            env: Object.entries(request.env ?? {}).flatMap(([name, value]) =>
              value === undefined ? [] : [{ name, value }],
            ),
            sessionId: this.findActiveSessionId(),
          });
          this.storeTerminalHandle(handle);
          return { terminalId: handle.id };
        },
        wait: async (terminalId) => {
          const result = await this.findTerminalHandle(terminalId).waitForExit();
          return { exitCode: result.exitCode ?? 0 };
        },
      };
    }

    return handlers;
  }

  private storeTerminalHandle(
    handle: Awaited<ReturnType<AgentSideConnection["createTerminal"]>>,
  ): void {
    const active = [...this.sessions.values()].find(
      (entry) => entry.turnId !== undefined,
    );
    active?.terminalHandles.set(handle.id, handle);
  }

  private findTerminalHandle(
    terminalId: string,
  ): Awaited<ReturnType<AgentSideConnection["createTerminal"]>> {
    for (const active of this.sessions.values()) {
      const handle = active.terminalHandles.get(terminalId);
      if (handle) {
        return handle;
      }
    }
    throw RequestError.invalidParams({ terminalId }, "Unknown terminal.");
  }

  private deleteTerminalHandle(terminalId: string): void {
    for (const active of this.sessions.values()) {
      active.terminalHandles.delete(terminalId);
    }
  }

  private findSessionIdForTurn(turnId: string): string {
    for (const [sessionId, active] of this.sessions.entries()) {
      if (active.turnId === turnId) {
        return sessionId;
      }
    }
    return this.findActiveSessionId();
  }

  private findActiveSessionId(): string {
    for (const [sessionId, active] of this.sessions.entries()) {
      if (active.turnId !== undefined) {
        return sessionId;
      }
    }
    const first = this.sessions.keys().next();
    if (!first.done) {
      return first.value;
    }
    throw RequestError.invalidParams({}, "No active remote runtime session.");
  }
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

function traceContextFromParams(
  params: { _meta?: Record<string, unknown> | null },
): import("@opentelemetry/api").Context | undefined {
  return traceContextFromMeta(params._meta);
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
  machine?: string;
  workspaceRoots?: readonly string[];
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (input.daemonId) {
    metadata[REMOTE_DAEMON_ID_META] = input.daemonId;
  }
  if (input.machine) {
    metadata[REMOTE_SESSION_MACHINE_META] = input.machine;
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

function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const message = error.message;
  const cause = readErrorCause(error);
  if (!cause) {
    return message;
  }
  return `${message} Caused by: ${formatError(cause)}`;
}

function readErrorCause(error: Error): unknown {
  if ("cause" in error) {
    return error.cause;
  }
  return undefined;
}

export function createAcpRemoteRuntimeAgent(input: {
  connection: AgentSideConnection;
  options: AcpRemoteRuntimeAgentOptions;
}): AcpRemoteRuntimeAgent {
  return new AcpRemoteRuntimeAgent(input.connection, input.options);
}
