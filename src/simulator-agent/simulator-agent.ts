import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type AvailableCommand,
  type ClientCapabilities,
  type CloseNesRequest,
  type CloseNesResponse,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ContentBlock,
  type DidChangeDocumentNotification,
  type DidCloseDocumentNotification,
  type DidFocusDocumentNotification,
  type DidOpenDocumentNotification,
  type DidSaveDocumentNotification,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type LogoutRequest,
  type LogoutResponse,
  type McpServer,
  type ModelInfo,
  type NesCapabilities,
  type NesSuggestion,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SessionModelState,
  type SessionMode,
  type SessionModeState,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type StartNesRequest,
  type StartNesResponse,
  type SuggestNesRequest,
  type SuggestNesResponse,
  type ToolCallContent,
  type ToolCallLocation,
  type ToolCallStatus,
  type Usage,
} from "@agentclientprotocol/sdk";

type AuthMode = "none" | "optional" | "required";

type SimulatorAgentOptions = {
  authMode?: AuthMode;
  name?: string;
  storageDir?: string;
  title?: string;
  version?: string;
};

type StoredDocument = {
  languageId: string;
  lastFocusedMs?: number;
  text: string;
  uri: string;
  version: number;
};

type StoredNesSession = {
  acceptedSuggestionIds: string[];
  rejectedSuggestionIds: string[];
  sessionId: string;
};

type StoredSession = {
  additionalDirectories: string[];
  configOptions: SessionConfigOption[];
  cwd: string;
  documents: Record<string, StoredDocument>;
  history: SessionNotification[];
  id: string;
  mcpServers: McpServer[];
  models: SessionModelState;
  modes: SessionModeState;
  title: string | null;
  updatedAt: string;
};

type ActivePrompt = {
  abortController: AbortController;
  running: Promise<PromptResponse>;
};

const DEFAULT_AGENT_NAME = "acp-simulator-agent";
const DEFAULT_AGENT_TITLE = "ACP Simulator Agent";
const DEFAULT_AGENT_VERSION = "0.1.0";
const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_AUTH_METHOD_ID = "simulator-agent-login";

function nowIso(): string {
  return new Date().toISOString();
}

function ensureAbsolutePath(pathValue: string, fieldName: string): void {
  if (!isAbsolute(pathValue)) {
    throw RequestError.invalidParams({ field: fieldName }, `${fieldName} must be an absolute path`);
  }
}

function ensureAdditionalDirectories(paths: string[] | undefined): string[] {
  const normalized = paths ?? [];
  for (const pathValue of normalized) {
    ensureAbsolutePath(pathValue, "additionalDirectories");
  }
  return normalized;
}

function createDefaultModes(): SessionModeState {
  const availableModes: SessionMode[] = [
    {
      id: "ask",
      name: "Ask",
      description: "Requests permission before using filesystem and terminal tools.",
    },
    {
      id: "code",
      name: "Code",
      description: "Uses tools automatically when the client advertises the needed capabilities.",
    },
    {
      id: "review",
      name: "Review",
      description: "Focuses on analysis and avoids mutating tools unless explicitly requested.",
    },
  ];

  return {
    availableModes,
    currentModeId: availableModes[0].id,
  };
}

function createDefaultModels(): SessionModelState {
  const availableModels: ModelInfo[] = [
    {
      modelId: "reference-fast",
      name: "Reference Fast",
      description: "Fast deterministic reference model.",
    },
    {
      modelId: "reference-precise",
      name: "Reference Precise",
      description: "More verbose deterministic reference model.",
    },
  ];

  return {
    availableModels,
    currentModelId: availableModels[0].modelId,
  };
}

function createDefaultConfigOptions(): SessionConfigOption[] {
  return [
    {
      id: "approval-policy",
      name: "Approval Policy",
      description: "Controls whether tool calls request permission first.",
      category: "mode",
      type: "select",
      currentValue: "ask",
      options: [
        { value: "ask", name: "Ask first", description: "Request permission for tool usage." },
        { value: "auto", name: "Auto", description: "Run tools automatically when supported." },
      ],
    },
    {
      id: "model",
      name: "Model",
      description: "Selects the active reference model.",
      category: "model",
      type: "select",
      currentValue: "reference-fast",
      options: [
        { value: "reference-fast", name: "Reference Fast" },
        { value: "reference-precise", name: "Reference Precise" },
      ],
    },
    {
      id: "reasoning",
      name: "Reasoning",
      description: "Controls how much internal reasoning detail is surfaced.",
      category: "thought_level",
      type: "select",
      currentValue: "balanced",
      options: [
        { value: "minimal", name: "Minimal" },
        { value: "balanced", name: "Balanced" },
        { value: "detailed", name: "Detailed" },
      ],
    },
    {
      id: "emit-plan",
      name: "Emit Plan Updates",
      description: "Whether prompt execution should emit plan notifications.",
      type: "boolean",
      currentValue: true,
    },
  ];
}

function createAvailableCommands(): AvailableCommand[] {
  return [
    {
      name: "help",
      description: "Show the simulator agent command surface.",
      input: { hint: "optional topic" },
    },
    {
      name: "read",
      description: "Read a file through ACP client filesystem APIs.",
      input: { hint: "/read /absolute/path" },
    },
    {
      name: "write",
      description: "Write a file through ACP client filesystem APIs.",
      input: { hint: "/write /absolute/path file contents..." },
    },
    {
      name: "run",
      description: "Run a terminal command through ACP client terminal APIs.",
      input: { hint: "/run git status" },
    },
    {
      name: "title",
      description: "Update session title and emit session_info_update.",
      input: { hint: "/title Human readable title" },
    },
    {
      name: "plan",
      description: "Emit an execution plan update.",
      input: { hint: "/plan step one | step two | done" },
    },
  ];
}

function getBooleanConfig(configOptions: SessionConfigOption[], optionId: string, fallback: boolean): boolean {
  const option = configOptions.find((entry) => entry.id === optionId && entry.type === "boolean");
  if (!option || option.type !== "boolean") {
    return fallback;
  }

  return option.currentValue;
}

function getSelectConfig(configOptions: SessionConfigOption[], optionId: string, fallback: string): string {
  const option = configOptions.find((entry) => entry.id === optionId && entry.type === "select");
  if (!option || option.type !== "select") {
    return fallback;
  }

  return option.currentValue;
}

function estimateUsage(inputText: string, outputText: string): Usage {
  const inputTokens = Math.max(1, Math.ceil(inputText.length / 4));
  const outputTokens = Math.max(1, Math.ceil(outputText.length / 4));
  const thoughtTokens = Math.max(1, Math.ceil((inputText.length + outputText.length) / 12));

  return {
    inputTokens,
    outputTokens,
    thoughtTokens,
    totalTokens: inputTokens + outputTokens + thoughtTokens,
  };
}

function promptText(prompt: ContentBlock[]): string {
  return prompt
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "resource_link":
          return `resource:${block.uri}`;
        case "resource":
          return `embedded-resource:${block.resource.uri}`;
        case "image":
          return `image:${block.mimeType}`;
        case "audio":
          return `audio:${block.mimeType}`;
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join("\n");
}

function summarizePrompt(prompt: ContentBlock[]): string[] {
  return prompt.map((block) => {
    switch (block.type) {
      case "text":
        return block.text;
      case "resource_link":
        return `Referenced resource ${block.uri}`;
      case "resource":
        return `Embedded resource ${block.resource.uri}`;
      case "image":
        return `Image content (${block.mimeType})`;
      case "audio":
        return `Audio content (${block.mimeType})`;
      default:
        return "Unknown content block";
    }
  });
}

class SimulatorAgentStore {
  readonly storageDir: string;
  readonly sessionsDir: string;

  constructor(storageDir: string) {
    this.storageDir = storageDir;
    this.sessionsDir = join(storageDir, "sessions");
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
  }

  private sessionPath(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.json`);
  }

  async saveSession(session: StoredSession): Promise<void> {
    await this.ensureReady();
    await writeFile(this.sessionPath(session.id), JSON.stringify(session, null, 2), "utf8");
  }

  async loadSession(sessionId: string): Promise<StoredSession> {
    await this.ensureReady();

    try {
      const content = await readFile(this.sessionPath(sessionId), "utf8");
      return JSON.parse(content) as StoredSession;
    } catch (error) {
      throw RequestError.resourceNotFound(sessionId);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.ensureReady();
    await rm(this.sessionPath(sessionId), { force: true });
  }

  async listSessions(): Promise<StoredSession[]> {
    await this.ensureReady();
    const files = await readdir(this.sessionsDir);
    const sessions: StoredSession[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }

      const content = await readFile(join(this.sessionsDir, file), "utf8");
      sessions.push(JSON.parse(content) as StoredSession);
    }

    return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}

export class AcpSimulatorAgent implements Agent {
  readonly connection: AgentSideConnection;
  readonly options: Required<SimulatorAgentOptions>;
  readonly store: SimulatorAgentStore;
  readonly sessions = new Map<string, StoredSession>();
  readonly activePrompts = new Map<string, ActivePrompt>();
  readonly nesSessions = new Map<string, StoredNesSession>();
  readonly availableCommands = createAvailableCommands();

  clientCapabilities: ClientCapabilities | null = null;
  authenticated = false;

  constructor(connection: AgentSideConnection, options: SimulatorAgentOptions = {}) {
    this.connection = connection;
    this.options = {
      authMode: options.authMode ?? "optional",
      name: options.name ?? DEFAULT_AGENT_NAME,
      storageDir: options.storageDir ?? join(process.cwd(), ".acp-simulator-agent"),
      title: options.title ?? DEFAULT_AGENT_TITLE,
      version: options.version ?? DEFAULT_AGENT_VERSION,
    };
    this.store = new SimulatorAgentStore(this.options.storageDir);
    this.authenticated = this.options.authMode !== "required";
  }

  private async hydrateSessions(): Promise<void> {
    if (this.sessions.size > 0) {
      return;
    }

    const sessions = await this.store.listSessions();
    for (const session of sessions) {
      this.sessions.set(session.id, session);
    }
  }

  private buildInitializeResponse(): InitializeResponse {
    const terminalAuthSupported = Boolean(this.clientCapabilities?.auth?.terminal);
    const authMethods =
      this.options.authMode === "none"
        ? undefined
        : [
            {
              id: DEFAULT_AUTH_METHOD_ID,
              name: "Simulator Agent Login",
              description: "Marks the ACP simulator agent session as authenticated.",
            },
            {
              id: "simulator-agent-env",
              type: "env_var" as const,
              name: "Environment Variable Login",
              description: "Demonstrates env-var based ACP authentication.",
              vars: [
                {
                  name: "ACP_REFERENCE_AGENT_TOKEN",
                  label: "Simulator Agent Token",
                  optional: false,
                  secret: true,
                },
              ],
            },
            ...(terminalAuthSupported
              ? [
                  {
                    id: "simulator-agent-terminal",
                    type: "terminal" as const,
                    name: "Terminal Login",
                    description: "Demonstrates terminal-based ACP authentication.",
                    command: this.options.name,
                    args: ["--auth-helper"],
                  },
                ]
              : []),
          ];

    const nesCapabilities: NesCapabilities = {
      context: {
        diagnostics: {},
        editHistory: { maxCount: 20 },
        openFiles: {},
        recentFiles: { maxCount: 20 },
        relatedSnippets: {},
        userActions: { maxCount: 20 },
      },
      events: {
        document: {
          didOpen: {},
          didChange: { syncKind: "incremental" },
          didClose: {},
          didSave: {},
          didFocus: {},
        },
      },
    };

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: this.options.name,
        title: this.options.title,
        version: this.options.version,
      },
      authMethods,
      agentCapabilities: {
        auth: { logout: {} },
        loadSession: true,
        promptCapabilities: {
          audio: true,
          embeddedContext: true,
          image: true,
        },
        sessionCapabilities: {
          additionalDirectories: {},
          close: {},
          fork: {},
          list: {},
          resume: {},
        },
        nes: nesCapabilities,
        positionEncoding: this.clientCapabilities?.positionEncodings?.[0] ?? null,
      },
    };
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = params.clientCapabilities ?? null;
    await this.store.ensureReady();
    await this.hydrateSessions();
    return this.buildInitializeResponse();
  }

  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    const allowedIds = new Set(
      (this.buildInitializeResponse().authMethods ?? []).map((entry) => entry.id),
    );
    if (!allowedIds.has(params.methodId)) {
      throw RequestError.invalidParams({ methodId: params.methodId }, "Unknown auth method");
    }

    this.authenticated = true;
    return {};
  }

  async unstable_logout(_params: LogoutRequest): Promise<LogoutResponse> {
    this.authenticated = this.options.authMode === "none";
    return {};
  }

  private requireAuth(): void {
    if (this.options.authMode === "required" && !this.authenticated) {
      throw RequestError.authRequired({ authMode: this.options.authMode }, "Authenticate first");
    }
  }

  private createSession(
    cwd: string,
    mcpServers: McpServer[],
    additionalDirectories: string[],
    title?: string | null,
    history?: SessionNotification[],
  ): StoredSession {
    return {
      id: randomUUID(),
      cwd,
      mcpServers,
      additionalDirectories,
      title: title ?? "Reference ACP Session",
      updatedAt: nowIso(),
      history: history ?? [],
      documents: {},
      modes: createDefaultModes(),
      models: createDefaultModels(),
      configOptions: createDefaultConfigOptions(),
    };
  }

  private getSession(sessionId: string): StoredSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.resourceNotFound(sessionId);
    }
    return session;
  }

  private async persistSession(session: StoredSession): Promise<void> {
    session.updatedAt = nowIso();
    this.sessions.set(session.id, session);
    await this.store.saveSession(session);
  }

  private buildSessionState(session: StoredSession): {
    configOptions: SessionConfigOption[];
    models: SessionModelState;
    modes: SessionModeState;
  } {
    return {
      configOptions: session.configOptions,
      models: session.models,
      modes: session.modes,
    };
  }

  private recordHistory(session: StoredSession, notification: SessionNotification): void {
    session.history.push(notification);
    session.updatedAt = nowIso();
  }

  private async emitSessionUpdate(session: StoredSession, update: SessionNotification["update"]): Promise<void> {
    const notification: SessionNotification = {
      sessionId: session.id,
      update,
    };
    this.recordHistory(session, notification);
    await this.connection.sessionUpdate(notification);
  }

  private async emitSessionInfoUpdate(session: StoredSession): Promise<void> {
    await this.emitSessionUpdate(session, {
      sessionUpdate: "session_info_update",
      title: session.title,
      updatedAt: session.updatedAt,
    });
  }

  private async emitAvailableCommands(session: StoredSession): Promise<void> {
    await this.emitSessionUpdate(session, {
      sessionUpdate: "available_commands_update",
      availableCommands: this.availableCommands,
    });
  }

  async newSession(params: {
    additionalDirectories?: string[];
    cwd: string;
    mcpServers: McpServer[];
  }): Promise<{
    configOptions: SessionConfigOption[];
    models: SessionModelState;
    modes: SessionModeState;
    sessionId: string;
  }> {
    this.requireAuth();
    ensureAbsolutePath(params.cwd, "cwd");
    const additionalDirectories = ensureAdditionalDirectories(params.additionalDirectories);

    const session = this.createSession(params.cwd, params.mcpServers, additionalDirectories);
    await this.persistSession(session);
    await this.emitSessionInfoUpdate(session);
    await this.emitAvailableCommands(session);

    return {
      sessionId: session.id,
      ...this.buildSessionState(session),
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.requireAuth();
    ensureAbsolutePath(params.cwd, "cwd");
    const session = await this.store.loadSession(params.sessionId);
    session.cwd = params.cwd;
    session.additionalDirectories = ensureAdditionalDirectories(params.additionalDirectories);
    session.mcpServers = params.mcpServers;
    await this.persistSession(session);

    for (const entry of session.history) {
      await this.connection.sessionUpdate(entry);
    }

    return this.buildSessionState(session);
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    this.requireAuth();
    await this.hydrateSessions();

    let sessions = [...this.sessions.values()];
    if (params.cwd) {
      ensureAbsolutePath(params.cwd, "cwd");
      sessions = sessions.filter((session) => session.cwd === params.cwd);
    }

    const filterAdditionalDirectories = ensureAdditionalDirectories(params.additionalDirectories);
    if (filterAdditionalDirectories.length > 0) {
      const key = JSON.stringify(filterAdditionalDirectories);
      sessions = sessions.filter(
        (session) => JSON.stringify(session.additionalDirectories) === key,
      );
    }

    const startIndex = params.cursor ? Number.parseInt(params.cursor, 10) || 0 : 0;
    const page = sessions.slice(startIndex, startIndex + 50);
    const nextCursor = startIndex + 50 < sessions.length ? String(startIndex + 50) : null;

    const result: SessionInfo[] = page.map((session) => ({
      sessionId: session.id,
      cwd: session.cwd,
      additionalDirectories: session.additionalDirectories,
      title: session.title,
      updatedAt: session.updatedAt,
    }));

    return {
      sessions: result,
      nextCursor,
    };
  }

  async unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    this.requireAuth();
    ensureAbsolutePath(params.cwd, "cwd");
    const session = await this.store.loadSession(params.sessionId);
    session.cwd = params.cwd;
    session.additionalDirectories = ensureAdditionalDirectories(params.additionalDirectories);
    session.mcpServers = params.mcpServers ?? session.mcpServers;
    await this.persistSession(session);
    return this.buildSessionState(session);
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    this.requireAuth();
    const source = await this.store.loadSession(params.sessionId);
    ensureAbsolutePath(params.cwd, "cwd");

    const forked: StoredSession = {
      ...source,
      id: randomUUID(),
      cwd: params.cwd,
      additionalDirectories: ensureAdditionalDirectories(params.additionalDirectories),
      mcpServers: params.mcpServers ?? source.mcpServers,
      history: [...source.history],
      documents: structuredClone(source.documents),
      configOptions: structuredClone(source.configOptions),
      modes: structuredClone(source.modes),
      models: structuredClone(source.models),
      title: source.title ? `${source.title} (fork)` : "Forked Reference ACP Session",
      updatedAt: nowIso(),
    };
    await this.persistSession(forked);
    await this.emitSessionInfoUpdate(forked);

    return {
      sessionId: forked.id,
      ...this.buildSessionState(forked),
    };
  }

  async unstable_closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const prompt = this.activePrompts.get(params.sessionId);
    prompt?.abortController.abort();
    this.activePrompts.delete(params.sessionId);
    this.sessions.delete(params.sessionId);
    await this.store.deleteSession(params.sessionId);
    return {};
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.getSession(params.sessionId);
    const mode = session.modes.availableModes.find((entry) => entry.id === params.modeId);
    if (!mode) {
      throw RequestError.invalidParams({ modeId: params.modeId }, "Unknown mode");
    }

    session.modes.currentModeId = params.modeId;
    for (const option of session.configOptions) {
      if (option.id === "approval-policy" && option.type === "select") {
        option.currentValue = params.modeId === "code" ? "auto" : "ask";
      }
    }

    await this.persistSession(session);
    await this.emitSessionUpdate(session, {
      sessionUpdate: "current_mode_update",
      currentModeId: params.modeId,
    });
    return {};
  }

  async unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse> {
    const session = this.getSession(params.sessionId);
    const model = session.models.availableModels.find((entry) => entry.modelId === params.modelId);
    if (!model) {
      throw RequestError.invalidParams({ modelId: params.modelId }, "Unknown model");
    }

    session.models.currentModelId = params.modelId;
    for (const option of session.configOptions) {
      if (option.id === "model" && option.type === "select") {
        option.currentValue = params.modelId;
      }
    }

    await this.persistSession(session);
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.getSession(params.sessionId);
    const option = session.configOptions.find((entry) => entry.id === params.configId);
    if (!option) {
      throw RequestError.invalidParams({ configId: params.configId }, "Unknown config option");
    }

    if (option.type === "boolean") {
      if (!("type" in params) || params.type !== "boolean") {
        throw RequestError.invalidParams(
          { configId: params.configId },
          "Expected boolean config update",
        );
      }
      option.currentValue = params.value;
    } else {
      if (typeof params.value !== "string") {
        throw RequestError.invalidParams(
          { configId: params.configId },
          "Expected select config update",
        );
      }
      const selectedValue = params.value;
      if (!option.options.some((entry) => "value" in entry && entry.value === selectedValue)) {
        throw RequestError.invalidParams(
          { configId: params.configId, value: selectedValue },
          "Unknown config value",
        );
      }
      option.currentValue = selectedValue;

      if (option.id === "model") {
        session.models.currentModelId = selectedValue;
      }
    }

    await this.persistSession(session);
    await this.emitSessionUpdate(session, {
      sessionUpdate: "config_option_update",
      configOptions: session.configOptions,
    });

    return {
      configOptions: session.configOptions,
    };
  }

  private ensureToolCapability(toolName: string, supported: boolean): void {
    if (!supported) {
      throw RequestError.invalidRequest({ toolName }, `${toolName} is not supported by this client`);
    }
  }

  private shouldRequestPermission(session: StoredSession): boolean {
    return (
      session.modes.currentModeId === "ask" ||
      getSelectConfig(session.configOptions, "approval-policy", "ask") === "ask"
    );
  }

  private async requestPermissionIfNeeded(
    session: StoredSession,
    toolCallId: string,
    title: string,
  ): Promise<boolean> {
    if (!this.shouldRequestPermission(session)) {
      return true;
    }

    const outcome = await this.connection.requestPermission({
      sessionId: session.id,
      toolCall: {
        toolCallId,
        title,
        status: "pending",
      },
      options: [
        {
          optionId: "allow",
          kind: "allow_once",
          name: `Allow ${title}`,
        },
        {
          optionId: "deny",
          kind: "reject_once",
          name: `Reject ${title}`,
        },
      ],
    });

    return outcome.outcome.outcome === "selected" && outcome.outcome.optionId === "allow";
  }

  private async emitToolCall(
    session: StoredSession,
    input: {
      content?: ToolCallContent[];
      kind: "edit" | "execute" | "read" | "other";
      locations?: ToolCallLocation[];
      rawInput?: unknown;
      rawOutput?: unknown;
      status?: ToolCallStatus;
      title: string;
      toolCallId: string;
    },
  ): Promise<void> {
    await this.emitSessionUpdate(session, {
      sessionUpdate: "tool_call",
      ...input,
    });
  }

  private async emitToolCallUpdate(
    session: StoredSession,
    input: {
      content?: ToolCallContent[] | null;
      kind?: "edit" | "execute" | "read" | "other" | null;
      locations?: ToolCallLocation[] | null;
      rawInput?: unknown;
      rawOutput?: unknown;
      status?: ToolCallStatus | null;
      title?: string | null;
      toolCallId: string;
    },
  ): Promise<void> {
    await this.emitSessionUpdate(session, {
      sessionUpdate: "tool_call_update",
      ...input,
    });
  }

  private async emitTextChunk(
    session: StoredSession,
    chunkType: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk",
    text: string,
    messageId?: string | null,
  ): Promise<void> {
    await this.emitSessionUpdate(session, {
      sessionUpdate: chunkType,
      messageId: messageId ?? randomUUID(),
      content: {
        type: "text",
        text,
      },
    });
  }

  private async emitUsageUpdate(session: StoredSession, usage: Usage): Promise<void> {
    await this.emitSessionUpdate(session, {
      sessionUpdate: "usage_update",
      size: DEFAULT_CONTEXT_WINDOW,
      used: usage.totalTokens,
      cost: {
        amount: Number((usage.totalTokens / 1_000_000).toFixed(6)),
        currency: "USD",
      },
    });
  }

  private async handleReadCommand(
    session: StoredSession,
    toolCallId: string,
    pathValue: string,
  ): Promise<string> {
    this.ensureToolCapability("fs/read_text_file", Boolean(this.clientCapabilities?.fs?.readTextFile));
    ensureAbsolutePath(pathValue, "path");

    await this.emitToolCall(session, {
      toolCallId,
      title: `Read ${pathValue}`,
      kind: "read",
      status: "pending",
      rawInput: { path: pathValue },
      locations: [{ path: pathValue }],
    });

    const allowed = await this.requestPermissionIfNeeded(session, toolCallId, `read ${pathValue}`);
    if (!allowed) {
      await this.emitToolCallUpdate(session, {
        toolCallId,
        status: "failed",
        title: "Read denied by client",
      });
      return `Permission denied while reading ${pathValue}.`;
    }

    await this.emitToolCallUpdate(session, {
      toolCallId,
      status: "in_progress",
      title: `Reading ${pathValue}`,
    });

    const result = await this.connection.readTextFile({
      sessionId: session.id,
      path: pathValue,
    });

    await this.emitToolCallUpdate(session, {
      toolCallId,
      status: "completed",
      title: `Read ${pathValue}`,
      rawOutput: result,
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: result.content,
          },
        },
      ],
    });

    return `Read ${pathValue}:\n${result.content}`;
  }

  private async handleWriteCommand(
    session: StoredSession,
    toolCallId: string,
    pathValue: string,
    nextText: string,
  ): Promise<string> {
    this.ensureToolCapability("fs/write_text_file", Boolean(this.clientCapabilities?.fs?.writeTextFile));
    ensureAbsolutePath(pathValue, "path");

    let oldText: string | undefined;
    if (this.clientCapabilities?.fs?.readTextFile) {
      try {
        const readResult = await this.connection.readTextFile({
          sessionId: session.id,
          path: pathValue,
        });
        oldText = readResult.content;
      } catch {
        oldText = undefined;
      }
    }

    await this.emitToolCall(session, {
      toolCallId,
      title: `Write ${pathValue}`,
      kind: "edit",
      status: "pending",
      rawInput: { path: pathValue, content: nextText },
      locations: [{ path: pathValue }],
    });

    const allowed = await this.requestPermissionIfNeeded(session, toolCallId, `write ${pathValue}`);
    if (!allowed) {
      await this.emitToolCallUpdate(session, {
        toolCallId,
        status: "failed",
        title: "Write denied by client",
      });
      return `Permission denied while writing ${pathValue}.`;
    }

    await this.emitToolCallUpdate(session, {
      toolCallId,
      status: "in_progress",
      title: `Writing ${pathValue}`,
    });

    await this.connection.writeTextFile({
      sessionId: session.id,
      path: pathValue,
      content: nextText,
    });

    await this.emitToolCallUpdate(session, {
      toolCallId,
      status: "completed",
      title: `Wrote ${pathValue}`,
      rawOutput: { ok: true },
      content: [
        {
          type: "diff",
          oldText,
          newText: nextText,
          path: pathValue,
        },
      ],
    });

    return `Wrote ${pathValue}.`;
  }

  private async handleRunCommand(
    session: StoredSession,
    toolCallId: string,
    command: string,
    args: string[],
  ): Promise<string> {
    this.ensureToolCapability("terminal", Boolean(this.clientCapabilities?.terminal));

    await this.emitToolCall(session, {
      toolCallId,
      title: `Run ${[command, ...args].join(" ")}`,
      kind: "execute",
      status: "pending",
      rawInput: { command, args },
    });

    const allowed = await this.requestPermissionIfNeeded(session, toolCallId, `run ${command}`);
    if (!allowed) {
      await this.emitToolCallUpdate(session, {
        toolCallId,
        status: "failed",
        title: "Command denied by client",
      });
      return `Permission denied while running ${command}.`;
    }

    await this.emitToolCallUpdate(session, {
      toolCallId,
      status: "in_progress",
      title: `Executing ${command}`,
    });

    const terminal = await this.connection.createTerminal({
      sessionId: session.id,
      command,
      args,
      cwd: session.cwd,
    });

    const output = await terminal.currentOutput();
    const exit = await terminal.waitForExit();
    await terminal.release();

    await this.emitToolCallUpdate(session, {
      toolCallId,
      status: "completed",
      title: `Executed ${command}`,
      rawOutput: { output, exit },
      content: [
        {
          type: "terminal",
          terminalId: terminal.id,
        },
        {
          type: "content",
          content: {
            type: "text",
            text: output.output,
          },
        },
      ],
    });

    return `Command output for ${command}:\n${output.output}`;
  }

  private async handlePlanCommand(session: StoredSession, rawPlan: string): Promise<string> {
    const entries = rawPlan
      .split("|")
      .map((entry, index, list) => ({
        content: entry.trim(),
        priority: (index === 0 ? "high" : "medium") as "high" | "medium",
        status: (index === list.length - 1 ? "in_progress" : "pending") as
          | "pending"
          | "in_progress"
          | "completed",
      }))
      .filter((entry) => entry.content.length > 0);

    if (entries.length === 0) {
      return "No plan entries provided.";
    }

    await this.emitSessionUpdate(session, {
      sessionUpdate: "plan",
      entries,
    });
    return `Emitted plan with ${entries.length} entries.`;
  }

  private async handleTitleCommand(session: StoredSession, title: string): Promise<string> {
    session.title = title.trim() || session.title;
    await this.persistSession(session);
    await this.emitSessionInfoUpdate(session);
    return `Updated session title to "${session.title}".`;
  }

  private async executePrompt(session: StoredSession, params: PromptRequest, signal: AbortSignal): Promise<PromptResponse> {
    const text = promptText(params.prompt);
    const messageId = params.messageId ?? randomUUID();

    for (const summary of summarizePrompt(params.prompt)) {
      await this.emitTextChunk(session, "user_message_chunk", summary, messageId);
    }

    if (getBooleanConfig(session.configOptions, "emit-plan", true)) {
      await this.emitSessionUpdate(session, {
        sessionUpdate: "plan",
        entries: [
          { content: "Inspect prompt", priority: "high", status: "completed" },
          { content: "Execute requested protocol operations", priority: "high", status: "in_progress" },
          { content: "Return deterministic response", priority: "medium", status: "pending" },
        ],
      });
    }

    await this.emitAvailableCommands(session);
    await this.emitTextChunk(
      session,
      "agent_thought_chunk",
      "Reference ACP agent is evaluating the prompt and available client capabilities.",
    );

    if (signal.aborted) {
      return {
        stopReason: "cancelled",
        userMessageId: params.messageId ?? null,
      };
    }

    const trimmed = text.trim();
    const [commandToken, ...restTokens] = trimmed.split(/\s+/);
    const remainder = restTokens.join(" ");
    let finalText: string;

    try {
      switch (commandToken) {
        case "/help":
          finalText = [
            "ACP Simulator Agent",
            "Commands:",
            "/help",
            "/read /absolute/path",
            "/write /absolute/path content...",
            "/run command [args...]",
            "/title New Session Title",
            "/plan step one | step two",
            "",
            `Current mode: ${session.modes.currentModeId}`,
            `Current model: ${session.models.currentModelId}`,
          ].join("\n");
          break;
        case "/read":
          finalText = await this.handleReadCommand(session, randomUUID(), restTokens[0] ?? "");
          break;
        case "/write": {
          const [pathValue, ...contentParts] = restTokens;
          finalText = await this.handleWriteCommand(
            session,
            randomUUID(),
            pathValue ?? "",
            contentParts.join(" "),
          );
          break;
        }
        case "/run":
          finalText = await this.handleRunCommand(
            session,
            randomUUID(),
            restTokens[0] ?? "",
            restTokens.slice(1),
          );
          break;
        case "/title":
          finalText = await this.handleTitleCommand(session, remainder);
          break;
        case "/plan":
          finalText = await this.handlePlanCommand(session, remainder);
          break;
        default: {
          finalText = [
            "Reference ACP agent received the prompt successfully.",
            "",
            "Prompt summary:",
            ...summarizePrompt(params.prompt).map((entry) => `- ${entry}`),
            "",
            "The agent supports initialize/auth/session lifecycle/prompt/cancel/config/modes/models/file-system/terminal/NES/document events.",
          ].join("\n");
          break;
        }
      }
    } catch (error) {
      finalText = `Reference ACP agent failed: ${error instanceof Error ? error.message : String(error)}`;
    }

    if (signal.aborted) {
      return {
        stopReason: "cancelled",
        userMessageId: params.messageId ?? null,
      };
    }

    await this.emitTextChunk(session, "agent_message_chunk", finalText);
    const usage = estimateUsage(text, finalText);
    await this.emitUsageUpdate(session, usage);
    await this.persistSession(session);

    return {
      stopReason: "end_turn",
      usage,
      userMessageId: params.messageId ?? null,
    };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.getSession(params.sessionId);
    if (this.activePrompts.has(params.sessionId)) {
      throw RequestError.invalidRequest({ sessionId: params.sessionId }, "Session already has an active prompt");
    }

    const abortController = new AbortController();
    const running = this.executePrompt(session, params, abortController.signal);
    this.activePrompts.set(params.sessionId, { abortController, running });

    try {
      return await running;
    } finally {
      this.activePrompts.delete(params.sessionId);
    }
  }

  async cancel(params: { sessionId: string }): Promise<void> {
    this.activePrompts.get(params.sessionId)?.abortController.abort();
  }

  async unstable_startNes(_params: StartNesRequest): Promise<StartNesResponse> {
    const sessionId = randomUUID();
    this.nesSessions.set(sessionId, {
      sessionId,
      acceptedSuggestionIds: [],
      rejectedSuggestionIds: [],
    });
    return { sessionId };
  }

  async unstable_suggestNes(params: SuggestNesRequest): Promise<SuggestNesResponse> {
    const suggestionId = randomUUID();
    const line = params.position.line;
    const character = params.position.character;
    const suggestion: NesSuggestion = {
      kind: "edit",
      id: suggestionId,
      uri: params.uri,
      cursorPosition: {
        line,
        character: character + 24,
      },
      edits: [
        {
          range: {
            start: { line, character },
            end: { line, character },
          },
          newText: "/* ACP reference suggestion */",
        },
      ],
    };

    return {
      suggestions: [suggestion],
    };
  }

  async unstable_closeNes(params: CloseNesRequest): Promise<CloseNesResponse> {
    this.nesSessions.delete(params.sessionId);
    return {};
  }

  private sessionDocument(sessionId: string, uri: string): StoredDocument {
    const session = this.getSession(sessionId);
    const document = session.documents[uri];
    if (!document) {
      throw RequestError.resourceNotFound(uri);
    }
    return document;
  }

  async unstable_didOpenDocument(params: DidOpenDocumentNotification): Promise<void> {
    const session = this.getSession(params.sessionId);
    session.documents[params.uri] = {
      uri: params.uri,
      languageId: params.languageId,
      text: params.text,
      version: params.version,
      lastFocusedMs: Date.now(),
    };
    await this.persistSession(session);
  }

  async unstable_didChangeDocument(params: DidChangeDocumentNotification): Promise<void> {
    const session = this.getSession(params.sessionId);
    const existing = this.sessionDocument(params.sessionId, params.uri);
    let nextText = existing.text;

    for (const change of params.contentChanges) {
      if (!change.range) {
        nextText = change.text;
        continue;
      }

      const lines = nextText.split("\n");
      const startLine = lines[change.range.start.line] ?? "";
      const endLine = lines[change.range.end.line] ?? "";
      const before = lines.slice(0, change.range.start.line);
      const after = lines.slice(change.range.end.line + 1);
      const head = startLine.slice(0, change.range.start.character);
      const tail = endLine.slice(change.range.end.character);
      const replacement = `${head}${change.text}${tail}`.split("\n");
      lines.splice(0, lines.length, ...before, ...replacement, ...after);
      nextText = lines.join("\n");
    }

    session.documents[params.uri] = {
      ...existing,
      text: nextText,
      version: params.version,
    };
    await this.persistSession(session);
  }

  async unstable_didCloseDocument(params: DidCloseDocumentNotification): Promise<void> {
    const session = this.getSession(params.sessionId);
    delete session.documents[params.uri];
    await this.persistSession(session);
  }

  async unstable_didSaveDocument(params: DidSaveDocumentNotification): Promise<void> {
    const session = this.getSession(params.sessionId);
    const existing = this.sessionDocument(params.sessionId, params.uri);
    session.documents[params.uri] = {
      ...existing,
      version: existing.version + 1,
    };
    await this.persistSession(session);
  }

  async unstable_didFocusDocument(params: DidFocusDocumentNotification): Promise<void> {
    const session = this.getSession(params.sessionId);
    const existing = this.sessionDocument(params.sessionId, params.uri);
    session.documents[params.uri] = {
      ...existing,
      lastFocusedMs: Date.now(),
    };
    await this.persistSession(session);
  }

  async unstable_acceptNes(params: { id: string; sessionId: string }): Promise<void> {
    const session = this.nesSessions.get(params.sessionId);
    if (session) {
      session.acceptedSuggestionIds.push(params.id);
    }
  }

  async unstable_rejectNes(params: { id: string; sessionId: string }): Promise<void> {
    const session = this.nesSessions.get(params.sessionId);
    if (session) {
      session.rejectedSuggestionIds.push(params.id);
    }
  }

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return {
      method,
      params,
      handledBy: this.options.name,
    };
  }

  async extNotification(_method: string, _params: Record<string, unknown>): Promise<void> {
    return;
  }
}

export function createSimulatorAgent(
  connection: AgentSideConnection,
  options?: SimulatorAgentOptions,
): AcpSimulatorAgent {
  return new AcpSimulatorAgent(connection, options);
}

export type { SimulatorAgentOptions };
