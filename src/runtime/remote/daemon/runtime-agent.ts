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
  mapRuntimeSessionListToAcp,
  mapRuntimeSessionToAcpResponse,
  mapRuntimeTurnCompletionToAcp,
  mapRuntimeTurnEventToAcpNotifications,
  createRemoteInitializeResponse,
} from "./mappers.js";

type RemoteRuntimeSessions = {
  list(options?: AcpRuntimeListSessionsOptions): Promise<AcpRuntimeSessionList>;
  load(options: {
    agent?: AcpRuntimeAgentInput;
    cwd?: string;
    handlers?: AcpRuntimeAuthorityHandlers;
    mcpServers?: ReturnType<typeof mapAcpMcpServersToRuntime>;
    sessionId: string;
  }): Promise<AcpRuntimeSession>;
  resume(options: {
    agent?: AcpRuntimeAgentInput;
    cwd?: string;
    handlers?: AcpRuntimeAuthorityHandlers;
    mcpServers?: ReturnType<typeof mapAcpMcpServersToRuntime>;
    sessionId: string;
  }): Promise<AcpRuntimeSession>;
  start(options: AcpRuntimeStartSessionOptions): Promise<AcpRuntimeSession>;
};

export type AcpRemoteRuntimeAgentOptions = {
  agent: AcpRuntimeAgentInput;
  agentCapabilities?: AgentCapabilities;
  agentInfo?: InitializeResponse["agentInfo"];
  runtime: {
    sessions: RemoteRuntimeSessions;
  };
  workspaceRoots?: readonly string[];
};

type ActiveRemoteSession = {
  session: AcpRuntimeSession;
  terminalHandles: Map<string, Awaited<ReturnType<AgentSideConnection["createTerminal"]>>>;
  turnId?: string;
};

export class AcpRemoteRuntimeAgent implements Agent {
  private clientCapabilities: ClientCapabilities = {};
  private readonly sessions = new Map<string, ActiveRemoteSession>();

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
    const cwd = await this.authorizeRequiredWorkspaceCwd(params.cwd, "session/new");
    const session = await this.options.runtime.sessions.start({
      agent: this.options.agent,
      cwd,
      handlers: this.createAuthorityHandlers(),
      mcpServers: mapAcpMcpServersToRuntime(params.mcpServers),
    });
    this.sessions.set(session.metadata.id, {
      session,
      terminalHandles: new Map(),
    });
    return mapRuntimeSessionToAcpResponse(session.metadata);
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const cwd = await this.authorizeWorkspaceCwd(params.cwd, "session/load");
    const session = await this.options.runtime.sessions.load({
      agent: this.options.agent,
      cwd,
      handlers: this.createAuthorityHandlers(),
      mcpServers: mapAcpMcpServersToRuntime(params.mcpServers ?? []),
      sessionId: params.sessionId,
    });
    this.sessions.set(session.metadata.id, {
      session,
      terminalHandles: new Map(),
    });
    return mapRuntimeSessionToAcpResponse(session.metadata);
  }

  async resumeSession(
    params: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
    const cwd = await this.authorizeWorkspaceCwd(params.cwd, "session/resume");
    const session = await this.options.runtime.sessions.resume({
      agent: this.options.agent,
      cwd,
      handlers: this.createAuthorityHandlers(),
      mcpServers: mapAcpMcpServersToRuntime(params.mcpServers ?? []),
      sessionId: params.sessionId,
    });
    this.sessions.set(session.metadata.id, {
      session,
      terminalHandles: new Map(),
    });
    return mapRuntimeSessionToAcpResponse(session.metadata);
  }

  async listSessions(
    params: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const cwd = await this.authorizeWorkspaceCwd(
      params.cwd ?? undefined,
      "session/list",
    );
    return mapRuntimeSessionListToAcp(
      await this.options.runtime.sessions.list({
        agent: this.options.agent,
        cursor: params.cursor ?? undefined,
        cwd,
        source: "all",
      }),
    );
  }

  async closeSession(
    params: CloseSessionRequest,
  ): Promise<CloseSessionResponse | void> {
    const active = this.requireSession(params.sessionId);
    await active.session.close();
    this.sessions.delete(params.sessionId);
    active.terminalHandles.clear();
    return {};
  }

  async setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse | void> {
    const active = this.requireSession(params.sessionId);
    await active.session.agent.setMode(params.modeId);
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const active = this.requireSession(params.sessionId);
    const value: AcpRuntimeConfigValue =
      "type" in params && params.type === "boolean" ? params.value : params.value;
    await active.session.agent.setConfigOption(params.configId, value);
    return {
      configOptions:
        mapRuntimeConfigOptionsToAcp(active.session.metadata.agentConfigOptions) ??
        [],
    };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const active = this.requireSession(params.sessionId);
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
            event.error.message,
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
    const active = this.requireSession(params.sessionId);
    if (active.turnId) {
      await active.session.turn.cancel(active.turnId);
    }
  }

  private requireSession(sessionId: string): ActiveRemoteSession {
    const active = this.sessions.get(sessionId);
    if (!active) {
      throw RequestError.invalidParams(
        { sessionId },
        `Unknown remote runtime session: ${sessionId}`,
      );
    }
    return active;
  }

  private async authorizeWorkspaceCwd(
    cwd: string | null | undefined,
    method: string,
  ): Promise<string | undefined> {
    const workspaceRoots = this.options.workspaceRoots;
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
  ): Promise<string> {
    return this.authorizeWorkspaceCwd(cwd, method).then((r) => r ?? cwd);
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

export function createAcpRemoteRuntimeAgent(input: {
  connection: AgentSideConnection;
  options: AcpRemoteRuntimeAgentOptions;
}): AcpRemoteRuntimeAgent {
  return new AcpRemoteRuntimeAgent(input.connection, input.options);
}
