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
  type PlanEntry,
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
  type ToolKind,
  type ToolCallLocation,
  type ToolCallStatus,
  type Usage,
} from "@agentclientprotocol/sdk";

const ACP_PROTOCOL_SOURCE_REPO = "https://github.com/agentclientprotocol/agent-client-protocol";
const ACP_PROTOCOL_SOURCE_REF = "v0.11.4";
const ACP_PROTOCOL_DOCS_URL = "https://agentclientprotocol.com/protocol/overview";
const ACP_PROTOCOL_DOCS_SCHEMA_URL = "https://agentclientprotocol.com/protocol/draft/schema";
const ACP_PROTOCOL_ALIGNMENT_VERIFIED_AT = "2026-04-08";

type AuthMode = "none" | "optional" | "required";

type SimulatorAgentAcpOptions = {
  authMode?: AuthMode;
  name?: string;
  onFatalExit?: ((code: number) => void | Promise<void>) | null;
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

type PermissionMode =
  | "deny"
  | "accept-edits"
  | "yolo";

type FaultMode =
  | "drop-next-tool-update"
  | "duplicate-next-tool-update"
  | "out-of-order-next-tool-update"
  | "drop-next-plan-update"
  | "duplicate-next-plan-update"
  | "timeout-next-prompt"
  | "hang-next-prompt"
  | "error-next-prompt"
  | "crash-next-prompt";

type ScenarioName = "full-cycle";

type PromptAction =
  | { type: "help" }
  | { type: "plan"; rawPlan: string }
  | { type: "read"; path: string }
  | { type: "write"; path: string; content: string }
  | { type: "run"; command: string; args: string[] }
  | { type: "rename"; title: string }
  | { type: "scenario"; name: ScenarioName; path: string; command?: string; content?: string }
  | { type: "simulate"; fault: FaultMode }
  | { type: "describe" };

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
  pendingFaults: FaultMode[];
  permissionRules: PermissionRule[];
  title: string | null;
  updatedAt: string;
};

type ActivePrompt = {
  abortController: AbortController;
  running: Promise<PromptResponse>;
};

type PromptFaultState = {
  dropNextPlanUpdate: boolean;
  duplicateNextPlanUpdate: boolean;
  dropNextToolUpdate: boolean;
  duplicateNextToolUpdate: boolean;
  outOfOrderNextToolUpdate: boolean;
};

type PlanEntryStatus = "pending" | "in_progress" | "completed";
type SimulatorModelId = "claude" | "gpt" | "gemini";
type ReasoningLevel = "low" | "medium" | "high";
type PermissionRule = {
  decision: "allow" | "reject";
  target: string;
  tool: "read" | "run" | "write";
};
type PermissionDescriptor = {
  target: string;
  title: string;
  tool: PermissionRule["tool"];
};

const DEFAULT_AGENT_NAME = "simulator-agent-acp";
const DEFAULT_AGENT_TITLE = "Simulator Agent ACP";
const DEFAULT_AGENT_VERSION = "0.1.0";
const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_AUTH_METHOD_ID = "simulator-agent-login";
const SIMULATED_FATAL_EXIT_CODE = 97;

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new Error("Aborted"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
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

function ensureSupportedProtocolVersion(protocolVersion: number): void {
  if (protocolVersion !== PROTOCOL_VERSION) {
    throw RequestError.invalidParams(
      {
        protocolVersion,
        supportedProtocolVersion: PROTOCOL_VERSION,
      },
      `Unsupported protocolVersion ${protocolVersion}; simulator-agent-acp requires ${PROTOCOL_VERSION}.`,
    );
  }
}

function ensureSupportedMcpServers(mcpServers: McpServer[]): McpServer[] {
  for (const server of mcpServers) {
    if ("command" in server) {
      if (!server.command.trim()) {
        throw RequestError.invalidParams({ mcpServer: server }, "MCP stdio server command must be non-empty");
      }
      continue;
    }

    if ("url" in server) {
      const transport = "type" in server ? server.type : "remote";
      if (!server.url.trim()) {
        throw RequestError.invalidParams({ mcpServer: server }, `MCP ${transport} server URL must be non-empty`);
      }
      continue;
    }

    throw RequestError.invalidParams({ mcpServer: server }, "Unsupported MCP server transport");
  }

  return mcpServers;
}

function createDefaultModes(): SessionModeState {
  const availableModes: SessionMode[] = [
    {
      id: "deny",
      name: "Deny",
      description: "Allows planning and reads, but blocks edits and terminal execution.",
    },
    {
      id: "accept-edits",
      name: "Accept Edits",
      description: "Allows file edits and commands, but requests permission before mutating actions.",
    },
    {
      id: "yolo",
      name: "YOLO",
      description: "Runs tools without permission prompts when the client advertises the needed capabilities.",
    },
  ];

  return {
    availableModes,
    currentModeId: "accept-edits",
  };
}

function createDefaultModels(): SessionModelState {
  const availableModels: ModelInfo[] = [
    {
      modelId: "claude",
      name: "Claude",
      description: "Simulator profile for Claude-style coding behavior.",
    },
    {
      modelId: "gpt",
      name: "GPT",
      description: "Simulator profile for GPT-style coding behavior.",
    },
    {
      modelId: "gemini",
      name: "Gemini",
      description: "Simulator profile for Gemini-style coding behavior.",
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
      currentValue: "accept-edits",
      options: [
        { value: "deny", name: "Deny", description: "Allow planning and reads only." },
        {
          value: "accept-edits",
          name: "Accept Edits",
          description: "Ask permission before edits or terminal execution.",
        },
        { value: "yolo", name: "YOLO", description: "Run tools automatically when supported." },
      ],
    },
    {
      id: "model",
      name: "Model",
      description: "Selects the active simulator model profile.",
      category: "model",
      type: "select",
      currentValue: "claude",
      options: [
        { value: "claude", name: "Claude" },
        { value: "gpt", name: "GPT" },
        { value: "gemini", name: "Gemini" },
      ],
    },
    {
      id: "reasoning",
      name: "Reasoning",
      description: "Controls how much internal reasoning detail is surfaced.",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
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
      name: "bash",
      description: "Run a terminal command through ACP client terminal APIs.",
      input: { hint: "/bash git diff --stat" },
    },
    {
      name: "plan",
      description: "Emit an execution plan update.",
      input: { hint: "/plan step one | step two | done" },
    },
    {
      name: "rename",
      description: "Rename the current session and emit session_info_update.",
      input: { hint: "/rename Human readable title" },
    },
    {
      name: "scenario",
      description: "Run a multi-step Claude Code style scenario.",
      input: { hint: "/scenario full-cycle /absolute/path [command] [content]" },
    },
    {
      name: "simulate",
      description: "Inject a failure mode into the next prompt.",
      input: {
        hint:
          "/simulate drop-next-tool-update|duplicate-next-tool-update|out-of-order-next-tool-update|drop-next-plan-update|duplicate-next-plan-update|timeout-next-prompt|hang-next-prompt|error-next-prompt|crash-next-prompt",
      },
    },
  ];
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

function detectPermissionMode(value: string): PermissionMode | null {
  const normalized = value.trim().toLowerCase();
  const mapping: Record<string, PermissionMode> = {
    deny: "deny",
    "read-only": "deny",
    readonly: "deny",
    safe: "deny",
    "accept-edits": "accept-edits",
    accept: "accept-edits",
    edit: "accept-edits",
    code: "accept-edits",
    yolo: "yolo",
    auto: "yolo",
  };
  return mapping[normalized] ?? null;
}

function detectModelId(value: string): SimulatorModelId | null {
  const normalized = value.trim().toLowerCase();
  const mapping: Record<string, SimulatorModelId> = {
    claude: "claude",
    anthropic: "claude",
    "reference-fast": "claude",
    gpt: "gpt",
    openai: "gpt",
    "reference-precise": "gpt",
    gemini: "gemini",
    google: "gemini",
  };
  return mapping[normalized] ?? null;
}

function detectReasoningLevel(value: string): ReasoningLevel | null {
  const normalized = value.trim().toLowerCase();
  const mapping: Record<string, ReasoningLevel> = {
    low: "low",
    minimal: "low",
    medium: "medium",
    balanced: "medium",
    high: "high",
    detailed: "high",
  };
  return mapping[normalized] ?? null;
}

function syncPermissionModeState(session: Pick<StoredSession, "configOptions" | "modes">): PermissionMode {
  const configMode = detectPermissionMode(getSelectConfig(session.configOptions, "approval-policy", ""));
  const nextMode = configMode ?? detectPermissionMode(session.modes.currentModeId) ?? "accept-edits";

  session.modes.currentModeId = nextMode;
  const approvalPolicy = session.configOptions.find(
    (entry) => entry.id === "approval-policy" && entry.type === "select",
  );
  if (approvalPolicy && approvalPolicy.type === "select") {
    approvalPolicy.currentValue = nextMode;
  }

  return nextMode;
}

function detectPromptAction(text: string): PromptAction {
  const trimmed = normalizeSlashPrompt(text.trim());
  const [commandToken, ...restTokens] = trimmed.split(/\s+/);
  const remainder = restTokens.join(" ").trim();

  switch (commandToken) {
    case "/help":
      return { type: "help" };
    case "/read":
      return { type: "read", path: restTokens[0] ?? "" };
    case "/write": {
      const [path, ...contentParts] = restTokens;
      return { type: "write", path: path ?? "", content: contentParts.join(" ") };
    }
    case "/bash":
      return { type: "run", command: restTokens[0] ?? "", args: restTokens.slice(1) };
    case "/plan":
      return { type: "plan", rawPlan: remainder };
    case "/rename":
      return remainder ? { type: "rename", title: remainder } : { type: "describe" };
    case "/scenario": {
      const [name, pathValue, ...tail] = restTokens;
      if (name === "full-cycle" && pathValue) {
        return {
          type: "scenario",
          name: "full-cycle",
          path: pathValue,
          command: tail[0] ? tail.join(" ") : undefined,
        };
      }
      return { type: "describe" };
    }
    case "/simulate": {
      const fault = detectFaultMode(remainder);
      return fault ? { type: "simulate", fault } : { type: "describe" };
    }
    default:
      break;
  }

  const planMatch = trimmed.match(/^plan[:\s-]+(.*)$/i);
  if (planMatch && (planMatch[1] || trimmed.toLowerCase().includes("step"))) {
    return { type: "plan", rawPlan: planMatch[1] || "Inspect request | Execute tools | Summarize outcome" };
  }

  const renameSessionMatch = trimmed.match(
    /\b(?:rename|retitle|rename session|rename chat|name this session|set title)\b(?:\s+(?:to|as))?[:\s-]+(.+)/i,
  );
  if (renameSessionMatch) {
    return { type: "rename", title: renameSessionMatch[1].trim() };
  }

  const readMatch = trimmed.match(/^(?:read|open|show|cat)\s+([/~A-Za-z0-9._/-]+)$/i);
  if (readMatch && readMatch[1].startsWith("/")) {
    return { type: "read", path: readMatch[1] };
  }

  const writeMatch = trimmed.match(/^(?:write|save)\s+([/~A-Za-z0-9._/-]+)\s*[:\-]?\s+(.+)$/i);
  if (writeMatch && writeMatch[1].startsWith("/")) {
    return { type: "write", path: writeMatch[1], content: writeMatch[2] };
  }

  const scenarioMatch = trimmed.match(
    /^(?:do\s+a\s+)?(?:full cycle|full edit cycle|inspect and edit|read run write)\b.*?([/~A-Za-z0-9._/-]+)/i,
  );
  if (scenarioMatch && scenarioMatch[1]?.startsWith("/")) {
    const commandMatch = trimmed.match(/`([^`]+)`/);
    return {
      type: "scenario",
      name: "full-cycle",
      path: scenarioMatch[1],
      command: commandMatch?.[1],
    };
  }

  const shellMatch = trimmed.match(/`([^`]+)`/);
  if (shellMatch && /^(?:please\s+)?(?:run|execute|bash|shell)\b/i.test(trimmed)) {
    const [cmd, ...args] = shellMatch[1].trim().split(/\s+/);
    if (cmd) return { type: "run", command: cmd, args };
  }

  const fault = detectFaultMode(trimmed);
  if (fault) {
    return { type: "simulate", fault };
  }

  return { type: "describe" };
}

function detectFaultMode(value: string): FaultMode | null {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
  const mapping: Record<string, FaultMode> = {
    "drop-next-tool-update": "drop-next-tool-update",
    "drop-tool-update": "drop-next-tool-update",
    "drop-update": "drop-next-tool-update",
    "duplicate-next-tool-update": "duplicate-next-tool-update",
    "duplicate-tool-update": "duplicate-next-tool-update",
    "out-of-order-next-tool-update": "out-of-order-next-tool-update",
    "out-of-order-update": "out-of-order-next-tool-update",
    "out-of-order-updates": "out-of-order-next-tool-update",
    "drop-next-plan-update": "drop-next-plan-update",
    "drop-plan-update": "drop-next-plan-update",
    "duplicate-next-plan-update": "duplicate-next-plan-update",
    "duplicate-plan-update": "duplicate-next-plan-update",
    "timeout-next-prompt": "timeout-next-prompt",
    "timeout-prompt": "timeout-next-prompt",
    timeout: "timeout-next-prompt",
    "hang-next-prompt": "hang-next-prompt",
    hang: "hang-next-prompt",
    "error-next-prompt": "error-next-prompt",
    error: "error-next-prompt",
    "crash-next-prompt": "crash-next-prompt",
    crash: "crash-next-prompt",
  };
  if (mapping[normalized]) {
    return mapping[normalized];
  }

  const raw = value.trim().toLowerCase();
  if (/\bdrop\b.*\btool\b.*\bupdate\b/.test(raw)) {
    return "drop-next-tool-update";
  }
  if (/\bduplicate\b.*\btool\b.*\bupdate\b/.test(raw)) {
    return "duplicate-next-tool-update";
  }
  if (/\bout[-\s]?of[-\s]?order\b.*\bupdate/.test(raw)) {
    return "out-of-order-next-tool-update";
  }
  if (/\bdrop\b.*\bplan\b.*\bupdate\b/.test(raw)) {
    return "drop-next-plan-update";
  }
  if (/\bduplicate\b.*\bplan\b.*\bupdate\b/.test(raw)) {
    return "duplicate-next-plan-update";
  }
  if (/\btimeout\b.*\bprompt\b/.test(raw)) {
    return "timeout-next-prompt";
  }
  if (/\bhang\b.*\bprompt\b/.test(raw)) {
    return "hang-next-prompt";
  }
  if (/\berror\b.*\bprompt\b/.test(raw)) {
    return "error-next-prompt";
  }
  if (/\bcrash\b.*\bprompt\b/.test(raw)) {
    return "crash-next-prompt";
  }

  return null;
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

function deriveSessionTitleFromPrompt(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // Avoid generating bad titles from command-style prompts or raw file paths.
  if (trimmed.startsWith("/")) {
    return null;
  }
  if (/^([/~]|\w+:\/\/)/.test(trimmed)) {
    return null;
  }
  if (/^(git|pnpm|npm|node|ls|pwd|cat)\b/i.test(trimmed)) {
    return null;
  }

  const cleaned = trimmed
    .replace(/`[^`]+`/g, " ")
    .replace(/\b(read|write|run|bash|cat|open|show)\b\s+\/[^\s]+/gi, " ")
    .replace(/\bplease\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) {
    return null;
  }

  const words = cleaned.split(" ").slice(0, 6);
  const title = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
    .replace(/[^\w\s:/.-]/g, "")
    .trim();

  return title.length > 0 ? title : null;
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

function shouldEmitPlanForAction(action: PromptAction): boolean {
  return action.type === "plan" || action.type === "scenario";
}

function normalizeSlashPrompt(text: string): string {
  const knownCommands = [
    "help",
    "read",
    "write",
    "bash",
    "plan",
    "rename",
    "scenario",
    "simulate",
  ];

  for (const command of knownCommands) {
    const prefix = `/${command}/`;
    if (text.startsWith(prefix)) {
      return `/${command} ${text.slice(prefix.length)}`.trim();
    }
  }

  return text;
}

function parsePlanContents(rawPlan: string): string[] {
  return rawPlan
    .split("|")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function buildPlanEntries(contents: string[], activeIndex: number): PlanEntry[] {
  return contents.map((content, index) => ({
    content,
    priority: index === 0 ? "high" : "medium",
    status:
      index < activeIndex
        ? "completed"
        : index === activeIndex
          ? "in_progress"
          : "pending",
  }));
}

function markPlanContentsCompleted(contents: string[]): PlanEntry[] {
  return contents.map((content, index) => ({
    content,
    priority: index === 0 ? "high" : "medium",
    status: "completed" satisfies PlanEntryStatus,
  }));
}

function formatPromptSummaryItems(items: string[], bullet: string): string[] {
  return items.map((entry) => `${bullet} ${entry}`);
}

function formatPlanStepStatuses(contents: string[], activeIndex: number): string[] {
  return contents.map((content, index) => {
    const status =
      index < activeIndex ? "completed" : index === activeIndex ? "in_progress" : "pending";
    return `${index + 1}. [${status}] ${content}`;
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

export class SimulatorAgentAcp implements Agent {
  readonly connection: AgentSideConnection;
  readonly options: Required<SimulatorAgentAcpOptions>;
  readonly store: SimulatorAgentStore;
  readonly sessions = new Map<string, StoredSession>();
  readonly activePrompts = new Map<string, ActivePrompt>();
  readonly nesSessions = new Map<string, StoredNesSession>();
  readonly availableCommands = createAvailableCommands();

  clientCapabilities: ClientCapabilities | null = null;
  authenticated = false;

  constructor(connection: AgentSideConnection, options: SimulatorAgentAcpOptions = {}) {
    this.connection = connection;
    this.options = {
      authMode: options.authMode ?? "optional",
      name: options.name ?? DEFAULT_AGENT_NAME,
      onFatalExit: options.onFatalExit ?? null,
      storageDir: options.storageDir ?? join(process.cwd(), ".simulator-agent-acp"),
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
      this.sessions.set(session.id, this.normalizeSession(session));
    }
  }

  private normalizeSession(session: StoredSession): StoredSession {
    const defaultConfigOptions = createDefaultConfigOptions();
    const normalized: StoredSession = {
      ...session,
      pendingFaults: session.pendingFaults ?? [],
      permissionRules: session.permissionRules ?? [],
    };
    const normalizedModel = detectModelId(normalized.models.currentModelId) ?? "claude";
    normalized.models.currentModelId = normalizedModel;
    normalized.models.availableModels = createDefaultModels().availableModels;
    const modelConfig = normalized.configOptions.find((entry) => entry.id === "model" && entry.type === "select");
    if (modelConfig && modelConfig.type === "select") {
      modelConfig.currentValue = normalizedModel;
      const defaultModelConfig = defaultConfigOptions.find(
        (entry) => entry.id === "model" && entry.type === "select",
      );
      if (defaultModelConfig && defaultModelConfig.type === "select") {
        modelConfig.options = defaultModelConfig.options;
      }
    }
    const reasoningConfig = normalized.configOptions.find(
      (entry) => entry.id === "reasoning" && entry.type === "select",
    );
    if (reasoningConfig && reasoningConfig.type === "select") {
      const normalizedReasoning = detectReasoningLevel(reasoningConfig.currentValue) ?? "medium";
      reasoningConfig.currentValue = normalizedReasoning;
      const defaultReasoningConfig = defaultConfigOptions.find(
        (entry) => entry.id === "reasoning" && entry.type === "select",
      );
      if (defaultReasoningConfig && defaultReasoningConfig.type === "select") {
        reasoningConfig.options = defaultReasoningConfig.options;
      }
    }
    syncPermissionModeState(normalized);
    return normalized;
  }

  private currentModelId(session: StoredSession): SimulatorModelId {
    return detectModelId(session.models.currentModelId) ?? "claude";
  }

  private currentReasoningLevel(session: StoredSession): ReasoningLevel {
    return detectReasoningLevel(getSelectConfig(session.configOptions, "reasoning", "medium")) ?? "medium";
  }

  private displayModelName(session: StoredSession): string {
    const model = this.currentModelId(session);
    switch (model) {
      case "gpt":
        return "GPT";
      case "gemini":
        return "Gemini";
      case "claude":
      default:
        return "Claude";
    }
  }

  private thoughtForAction(session: StoredSession, action: PromptAction): string {
    const model = this.currentModelId(session);
    const reasoning = this.currentReasoningLevel(session);

    switch (model) {
      case "gpt":
        switch (action.type) {
          case "scenario":
            return reasoning === "high"
              ? "GPT profile is decomposing the request into read, run, write, and verification stages."
              : "GPT profile is breaking the request into executable stages.";
          case "plan":
            return "GPT profile is converting the prompt into a compact execution plan.";
          case "run":
            return "GPT profile is validating command execution constraints before invoking the terminal.";
          default:
            return reasoning === "low"
              ? "GPT profile is evaluating the request."
              : "GPT profile is evaluating the request, constraints, and client capabilities.";
        }
      case "gemini":
        switch (action.type) {
          case "scenario":
            return reasoning === "high"
              ? "Gemini profile is surveying the prompt, workspace action sequence, and expected outcome before continuing."
              : "Gemini profile is surveying the request and available actions.";
          case "read":
            return "Gemini profile is reviewing repository context before opening the requested file.";
          case "simulate":
            return "Gemini profile is staging a fault injection path for the next prompt.";
          default:
            return "Gemini profile is reviewing the prompt against available capabilities and likely next steps.";
        }
      case "claude":
      default:
        switch (action.type) {
          case "write":
            return "Claude profile is preparing a controlled edit and checking whether client authority allows it.";
          case "scenario":
            return "Claude profile is orchestrating a coding workflow across read, run, write, and summary phases.";
          case "rename":
            return "Claude profile is updating session metadata and preparing a session_info_update.";
          case "plan":
            return "Claude profile is turning the request into an explicit execution plan.";
          default:
            return "Claude profile is evaluating the prompt and available client capabilities.";
        }
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
                  name: "ACP_SIMULATOR_AGENT_TOKEN",
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
        mcpCapabilities: {
          http: true,
          sse: true,
        },
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
    ensureSupportedProtocolVersion(params.protocolVersion);
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
      title: title ?? "ACP Simulator Session",
      updatedAt: nowIso(),
      history: history ?? [],
      documents: {},
      modes: createDefaultModes(),
      models: createDefaultModels(),
      configOptions: createDefaultConfigOptions(),
      pendingFaults: [],
      permissionRules: [],
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

  private consumePendingFault(session: StoredSession): FaultMode | null {
    const fault = session.pendingFaults.shift() ?? null;
    return fault;
  }

  private createPromptFaultState(fault: FaultMode | null): PromptFaultState {
    return {
      dropNextPlanUpdate: fault === "drop-next-plan-update",
      duplicateNextPlanUpdate: fault === "duplicate-next-plan-update",
      dropNextToolUpdate: fault === "drop-next-tool-update",
      duplicateNextToolUpdate: fault === "duplicate-next-tool-update",
      outOfOrderNextToolUpdate: fault === "out-of-order-next-tool-update",
    };
  }

  private async applyPromptFault(
    session: StoredSession,
    fault: FaultMode | null,
    signal: AbortSignal,
  ): Promise<void> {
    switch (fault) {
      case "timeout-next-prompt":
        await this.emitTextChunk(
          session,
          "agent_thought_chunk",
          "Simulator fault injected: delaying next prompt to mimic a slow agent.",
        );
        await sleep(2_000, signal);
        return;
      case "hang-next-prompt":
        await this.emitTextChunk(
          session,
          "agent_thought_chunk",
          "Simulator fault injected: next prompt will hang until the client cancels it.",
        );
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return;
      case "error-next-prompt":
        throw new Error("Simulated prompt failure requested by /simulate error-next-prompt");
      case "crash-next-prompt":
        await this.emitTextChunk(
          session,
          "agent_thought_chunk",
          "Simulator fault injected: crashing the agent process before responding.",
        );
        await this.options.onFatalExit?.(SIMULATED_FATAL_EXIT_CODE);
        throw new Error("Simulated fatal exit");
      default:
        return;
    }
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

  private schedulePostResponse(fn: () => Promise<void>): void {
    setTimeout(() => {
      void fn().catch(() => {
        // Best-effort follow-up notifications should not crash the agent.
      });
    }, 0);
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
    const mcpServers = ensureSupportedMcpServers(params.mcpServers);
    const session = this.createSession(params.cwd, mcpServers, additionalDirectories);
    await this.persistSession(session);
    this.schedulePostResponse(async () => {
      await this.emitSessionInfoUpdate(session);
      await this.emitAvailableCommands(session);
    });

    return {
      sessionId: session.id,
      ...this.buildSessionState(session),
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.requireAuth();
    ensureAbsolutePath(params.cwd, "cwd");
    const session = this.normalizeSession(await this.store.loadSession(params.sessionId));
    session.cwd = params.cwd;
    session.additionalDirectories = ensureAdditionalDirectories(params.additionalDirectories);
    session.mcpServers = ensureSupportedMcpServers(params.mcpServers);
    await this.persistSession(session);
    this.schedulePostResponse(async () => {
      for (const entry of session.history) {
        await this.connection.sessionUpdate(entry);
      }
      await this.emitAvailableCommands(session);
    });

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
    const session = this.normalizeSession(await this.store.loadSession(params.sessionId));
    session.cwd = params.cwd;
    session.additionalDirectories = ensureAdditionalDirectories(params.additionalDirectories);
    session.mcpServers = params.mcpServers ? ensureSupportedMcpServers(params.mcpServers) : session.mcpServers;
    await this.persistSession(session);
    this.schedulePostResponse(async () => {
      await this.emitAvailableCommands(session);
    });
    return this.buildSessionState(session);
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    this.requireAuth();
    const source = this.normalizeSession(await this.store.loadSession(params.sessionId));
    ensureAbsolutePath(params.cwd, "cwd");

    const forked: StoredSession = {
      ...source,
      id: randomUUID(),
      cwd: params.cwd,
      additionalDirectories: ensureAdditionalDirectories(params.additionalDirectories),
      mcpServers: params.mcpServers ? ensureSupportedMcpServers(params.mcpServers) : source.mcpServers,
      history: [...source.history],
      documents: structuredClone(source.documents),
      configOptions: structuredClone(source.configOptions),
      modes: structuredClone(source.modes),
      models: structuredClone(source.models),
      title: source.title ? `${source.title} (fork)` : "Forked ACP Simulator Session",
      updatedAt: nowIso(),
    };
    await this.persistSession(forked);
    this.schedulePostResponse(async () => {
      await this.emitSessionInfoUpdate(forked);
      await this.emitAvailableCommands(forked);
    });

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

    const approvalPolicy = session.configOptions.find(
      (entry) => entry.id === "approval-policy" && entry.type === "select",
    );
    if (approvalPolicy && approvalPolicy.type === "select") {
      approvalPolicy.currentValue = params.modeId;
    }
    syncPermissionModeState(session);

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
      } else if (option.id === "approval-policy") {
        syncPermissionModeState(session);
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
    const configValue = getSelectConfig(
      session.configOptions,
      "approval-policy",
      session.modes.currentModeId,
    );
    return configValue === "accept-edits";
  }

  private currentPermissionMode(session: StoredSession): PermissionMode {
    return (
      detectPermissionMode(
        getSelectConfig(session.configOptions, "approval-policy", session.modes.currentModeId),
      ) ?? "accept-edits"
    );
  }

  private canMutate(session: StoredSession): boolean {
    const mode = this.currentPermissionMode(session);
    return mode !== "deny";
  }

  private async requestPermissionIfNeeded(
    session: StoredSession,
    toolCallId: string,
    descriptor: PermissionDescriptor,
  ): Promise<boolean> {
    if (!this.shouldRequestPermission(session)) {
      return true;
    }

    const remembered = session.permissionRules.find(
      (rule) => rule.tool === descriptor.tool && rule.target === descriptor.target,
    );
    if (remembered) {
      return remembered.decision === "allow";
    }

    const outcome = await this.connection.requestPermission({
      sessionId: session.id,
      toolCall: {
        toolCallId,
        title: descriptor.title,
        status: "pending",
      },
      options: [
        {
          optionId: "allow",
          kind: "allow_once",
          name: `Allow ${descriptor.title}`,
        },
        {
          optionId: "allow-always",
          kind: "allow_always",
          name: `Always allow ${descriptor.title} in this session`,
        },
        {
          optionId: "deny",
          kind: "reject_once",
          name: `Reject ${descriptor.title}`,
        },
        {
          optionId: "deny-always",
          kind: "reject_always",
          name: `Always reject ${descriptor.title} in this session`,
        },
      ],
    });

    if (outcome.outcome.outcome !== "selected") {
      return false;
    }

    if (outcome.outcome.optionId === "allow-always" || outcome.outcome.optionId === "deny-always") {
      session.permissionRules = [
        ...session.permissionRules.filter(
          (rule) => !(rule.tool === descriptor.tool && rule.target === descriptor.target),
        ),
        {
          tool: descriptor.tool,
          target: descriptor.target,
          decision: outcome.outcome.optionId === "allow-always" ? "allow" : "reject",
        },
      ];
      await this.persistSession(session);
    }

    return outcome.outcome.optionId === "allow" || outcome.outcome.optionId === "allow-always";
  }

  private async emitToolCall(
    session: StoredSession,
    faultState: PromptFaultState,
    input: {
      content?: ToolCallContent[];
      kind: ToolKind;
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

    if (faultState.outOfOrderNextToolUpdate) {
      faultState.outOfOrderNextToolUpdate = false;
      await this.emitToolCallUpdate(session, faultState, {
        toolCallId: input.toolCallId,
        status: "completed",
        title: `${input.title} (out-of-order completion)`,
        rawOutput: { simulated: true },
      });
    }
  }

  private async emitToolCallUpdate(
    session: StoredSession,
    faultState: PromptFaultState,
    input: {
      content?: ToolCallContent[] | null;
      kind?: ToolKind | null;
      locations?: ToolCallLocation[] | null;
      rawInput?: unknown;
      rawOutput?: unknown;
      status?: ToolCallStatus | null;
      title?: string | null;
      toolCallId: string;
    },
  ): Promise<void> {
    if (faultState.dropNextToolUpdate) {
      faultState.dropNextToolUpdate = false;
      return;
    }

    const update = {
      sessionUpdate: "tool_call_update",
      ...input,
    } as const;
    await this.emitSessionUpdate(session, update);
    if (faultState.duplicateNextToolUpdate) {
      faultState.duplicateNextToolUpdate = false;
      await this.emitSessionUpdate(session, update);
    }
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

  private planContentsForAction(session: StoredSession, action: PromptAction): string[] | null {
    const model = this.currentModelId(session);
    const reasoning = this.currentReasoningLevel(session);

    switch (action.type) {
      case "describe":
        return null;
      case "help":
        if (model === "gpt") {
          return ["Parse help request", "Assemble command reference", "Return help response"];
        }
        if (model === "gemini") {
          return ["Survey help request", "Assemble guidance", "Return help response"];
        }
        return ["Inspect help request", "Assemble command surface", "Return help response"];
      case "plan":
        return model === "gemini"
          ? ["Survey requested plan", "Publish plan update", "Confirm plan delivery"]
          : ["Interpret requested plan", "Publish plan update", "Confirm completion"];
      case "scenario":
        if (model === "gpt") {
          return reasoning === "high"
            ? [
                `Read ${action.path}`,
                `Execute ${action.command?.trim() || "git status"}`,
                `Write ${action.path}`,
                "Verify result",
                "Return summary",
              ]
            : [
                `Read ${action.path}`,
                `Execute ${action.command?.trim() || "git status"}`,
                `Write ${action.path}`,
                "Return summary",
              ];
        }
        if (model === "gemini") {
          return reasoning === "low"
            ? [
                `Inspect ${action.path}`,
                `Run ${action.command?.trim() || "git status"}`,
                "Summarize result",
              ]
            : [
                `Inspect ${action.path}`,
                `Run ${action.command?.trim() || "git status"}`,
                `Write ${action.path}`,
                "Summarize result",
              ];
        }
        return reasoning === "high"
          ? [
              `Inspect ${action.path}`,
              `Run ${action.command?.trim() || "git status"}`,
              `Write ${action.path}`,
              "Verify diff-style result",
              "Summarize result",
            ]
          : [
              `Inspect ${action.path}`,
              `Run ${action.command?.trim() || "git status"}`,
              `Write ${action.path}`,
              "Summarize result",
            ];
      default:
        return null;
    }
  }

  private async emitPlanProgress(
    session: StoredSession,
    faultState: PromptFaultState,
    contents: string[],
    activeIndex: number,
  ): Promise<PlanEntry[] | null> {
    if (faultState.dropNextPlanUpdate) {
      faultState.dropNextPlanUpdate = false;
      return null;
    }

    const entries = buildPlanEntries(contents, activeIndex);
    await this.emitSessionUpdate(session, {
      sessionUpdate: "plan",
      entries,
    });
    if (faultState.duplicateNextPlanUpdate) {
      faultState.duplicateNextPlanUpdate = false;
      await this.emitSessionUpdate(session, {
        sessionUpdate: "plan",
        entries,
      });
    }
    return entries;
  }

  private async emitPlanStepOutput(
    session: StoredSession,
    contents: string[] | null,
    activeIndex: number,
    detail?: string,
  ): Promise<void> {
    if (!contents || contents.length === 0 || activeIndex < 0 || activeIndex >= contents.length) {
      return;
    }

    const lines = [`Plan step ${activeIndex + 1}/${contents.length}: ${contents[activeIndex]}`];
    if (detail) {
      lines.push(detail);
    }

    await this.emitTextChunk(session, "agent_thought_chunk", lines.join("\n"));
  }

  private findPlanStepIndex(
    contents: string[] | null,
    matcher: (content: string) => boolean,
  ): number {
    if (!contents) {
      return -1;
    }
    return contents.findIndex(matcher);
  }

  private async completePlan(
    session: StoredSession,
    faultState: PromptFaultState,
    contents: string[] | null,
  ): Promise<void> {
    if (!contents) {
      return;
    }

    await this.emitPlanProgress(session, faultState, markPlanContentsCompleted(contents).map((entry) => entry.content), contents.length);
  }

  private renderScenarioSummary(
    session: StoredSession,
    readSummary: string,
    runSummary: string,
    writeSummary: string,
  ): string {
    const model = this.currentModelId(session);
    const reasoning = this.currentReasoningLevel(session);

    switch (model) {
      case "gpt":
        return [
          "Completed full-cycle scenario.",
          "",
          "Result:",
          ...formatPromptSummaryItems([readSummary, runSummary, writeSummary], "-"),
          "",
          reasoning === "high"
            ? "Verification: the simulator completed the read, command execution, write, and final summary stages."
            : "Verification: the simulator completed the requested tool sequence.",
        ].join("\n");
      case "gemini":
        return [
          "Completed full-cycle scenario.",
          "",
          readSummary,
          "",
          runSummary,
          "",
          writeSummary,
          "",
          reasoning === "low"
            ? "Summary: the simulator completed the requested workflow."
            : "Summary: the simulator walked the workspace action chain from inspection through execution and final writeback.",
        ].join("\n");
      case "claude":
      default:
        return [
          "Completed full-cycle scenario.",
          "",
          readSummary,
          "",
          runSummary,
          "",
          writeSummary,
          "",
          reasoning === "high"
            ? "Summary: the simulator inspected the file, executed the terminal step, produced a diff-style write, verified progression, and closed the turn."
            : "Summary: the simulator inspected the file, executed a shell command, produced a diff-style write, and closed the turn.",
        ].join("\n");
    }
  }

  private buildScenarioWriteContent(session: StoredSession, currentText: string): string {
    const model = this.currentModelId(session);
    const reasoning = this.currentReasoningLevel(session);
    const additions = (() => {
      switch (model) {
        case "gpt":
          return [
            'export const simulatorProfile = "gpt";',
            "export const simulatorEdited = true;",
            ...(reasoning === "high" ? ['export const simulatorVerification = "structured";'] : []),
          ];
        case "gemini":
          return [
            'export const simulatorProfile = "gemini";',
            "export const simulatorEdited = true;",
            ...(reasoning !== "low" ? ['export const simulatorContext = "surveyed";'] : []),
          ];
        case "claude":
        default:
          return [
            'export const simulatorProfile = "claude";',
            "export const simulatorEdited = true;",
            ...(reasoning === "high" ? ['export const simulatorStyle = "workflow";'] : []),
          ];
      }
    })();

    const missingLines = additions.filter((line) => !currentText.includes(line));
    if (missingLines.length === 0) {
      return currentText;
    }

    const header = `// updated by simulator-agent-acp:${model}`;
    const segments = [currentText.trimEnd()];
    if (!currentText.includes(header)) {
      segments.push(header);
    }
    segments.push(...missingLines);
    return segments.filter((segment) => segment.length > 0).join("\n") + "\n";
  }

  private renderDescribeResponse(session: StoredSession, prompt: ContentBlock[]): string {
    const model = this.currentModelId(session);
    const reasoning = this.currentReasoningLevel(session);
    const summaries = summarizePrompt(prompt);

    switch (model) {
      case "gpt":
        return [
          "GPT simulator profile received the prompt successfully.",
          "",
          "Prompt summary:",
          ...formatPromptSummaryItems(summaries, "-"),
          "",
          `Mode: ${session.modes.currentModeId}`,
          `Model: ${this.displayModelName(session)}`,
          `Reasoning: ${reasoning}`,
          `Permission policy: ${this.currentPermissionMode(session)}`,
          `Queued faults: ${session.pendingFaults.length > 0 ? session.pendingFaults.join(", ") : "none"}`,
          "",
            "Hint: include plan, bash, read, write, scenario, or simulate to trigger richer tool flows.",
        ].join("\n");
      case "gemini":
        return [
          "Gemini simulator profile received the prompt successfully.",
          "",
          "Observed prompt:",
          ...formatPromptSummaryItems(summaries, "•"),
          "",
          `Mode: ${session.modes.currentModeId}`,
          `Model: ${this.displayModelName(session)}`,
          `Reasoning: ${reasoning}`,
          `Permission policy: ${this.currentPermissionMode(session)}`,
          `Queued faults: ${session.pendingFaults.length > 0 ? session.pendingFaults.join(", ") : "none"}`,
          "",
          "Hint: use scenario or simulate when you want richer multi-step client behavior.",
        ].join("\n");
      case "claude":
      default:
        return [
          "Claude simulator profile received the prompt successfully.",
          "",
          "Prompt summary:",
          ...formatPromptSummaryItems(summaries, "-"),
          "",
          `Current mode: ${session.modes.currentModeId}`,
          `Current model: ${this.displayModelName(session)}`,
          `Reasoning: ${reasoning}`,
          `Permission policy: ${this.currentPermissionMode(session)}`,
          `Queued faults: ${session.pendingFaults.length > 0 ? session.pendingFaults.join(", ") : "none"}`,
          "",
          "Hint: include keywords like plan, bash, read, write, scenario, or simulate to trigger richer tool flows.",
        ].join("\n");
    }
  }

  private async performReadCommand(
    session: StoredSession,
    faultState: PromptFaultState,
    toolCallId: string,
    pathValue: string,
  ): Promise<{ content: string; summary: string }> {
    this.ensureToolCapability("fs/read_text_file", Boolean(this.clientCapabilities?.fs?.readTextFile));
    ensureAbsolutePath(pathValue, "path");

    await this.emitToolCall(session, faultState, {
      toolCallId,
      title: `Read ${pathValue}`,
      kind: "read",
      status: "pending",
      rawInput: { path: pathValue },
      locations: [{ path: pathValue }],
    });

    const allowed = await this.requestPermissionIfNeeded(session, toolCallId, {
      tool: "read",
      target: pathValue,
      title: `read ${pathValue}`,
    });
    if (!allowed) {
      await this.emitToolCallUpdate(session, faultState, {
        toolCallId,
        status: "failed",
        title: "Read denied by client",
      });
      return {
        content: "",
        summary: `Permission denied while reading ${pathValue}.`,
      };
    }

    await this.emitToolCallUpdate(session, faultState, {
      toolCallId,
      status: "in_progress",
      title: `Reading ${pathValue}`,
    });

    const result = await this.connection.readTextFile({
      sessionId: session.id,
      path: pathValue,
    });

    await this.emitToolCallUpdate(session, faultState, {
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

    return {
      content: result.content,
      summary: `Read ${pathValue}:\n${result.content}`,
    };
  }

  private async handleReadCommand(
    session: StoredSession,
    faultState: PromptFaultState,
    toolCallId: string,
    pathValue: string,
  ): Promise<string> {
    const result = await this.performReadCommand(session, faultState, toolCallId, pathValue);
    return result.summary;
  }

  private async handleWriteCommand(
    session: StoredSession,
    faultState: PromptFaultState,
    toolCallId: string,
    pathValue: string,
    nextText: string,
  ): Promise<string> {
    this.ensureToolCapability("fs/write_text_file", Boolean(this.clientCapabilities?.fs?.writeTextFile));
    if (!this.canMutate(session)) {
      return `Current mode ${this.currentPermissionMode(session)} blocks file edits. Switch to accept-edits or yolo.`;
    }
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

    await this.emitToolCall(session, faultState, {
      toolCallId,
      title: `Write ${pathValue}`,
      kind: "edit",
      status: "pending",
      rawInput: { path: pathValue, content: nextText },
      locations: [{ path: pathValue }],
    });

    const allowed = await this.requestPermissionIfNeeded(session, toolCallId, {
      tool: "write",
      target: pathValue,
      title: `write ${pathValue}`,
    });
    if (!allowed) {
      await this.emitToolCallUpdate(session, faultState, {
        toolCallId,
        status: "failed",
        title: "Write denied by client",
      });
      return `Permission denied while writing ${pathValue}.`;
    }

    await this.emitToolCallUpdate(session, faultState, {
      toolCallId,
      status: "in_progress",
      title: `Writing ${pathValue}`,
    });

    await this.connection.writeTextFile({
      sessionId: session.id,
      path: pathValue,
      content: nextText,
    });

    await this.emitToolCallUpdate(session, faultState, {
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
    faultState: PromptFaultState,
    toolCallId: string,
    command: string,
    args: string[],
  ): Promise<string> {
    this.ensureToolCapability("terminal", Boolean(this.clientCapabilities?.terminal));
    if (!this.canMutate(session)) {
      return `Current mode ${this.currentPermissionMode(session)} blocks terminal execution. Switch to accept-edits or yolo.`;
    }

    await this.emitToolCall(session, faultState, {
      toolCallId,
      title: `Run ${[command, ...args].join(" ")}`,
      kind: "execute",
      status: "pending",
      rawInput: { command, args },
    });

    const allowed = await this.requestPermissionIfNeeded(session, toolCallId, {
      tool: "run",
      target: [command, ...args].join(" "),
      title: `run ${command}`,
    });
    if (!allowed) {
      await this.emitToolCallUpdate(session, faultState, {
        toolCallId,
        status: "failed",
        title: "Command denied by client",
      });
      return `Permission denied while running ${command}.`;
    }

    await this.emitToolCallUpdate(session, faultState, {
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

    await this.emitToolCallUpdate(session, faultState, {
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

  private async handlePlanCommand(_session: StoredSession, planContents: string[]): Promise<string> {
    if (planContents.length === 0) {
      return "No plan entries provided. Use `/plan step one | step two | step three`.";
    }

    return [
      "Published plan.",
      "",
      "Current plan state:",
      ...formatPlanStepStatuses(planContents, 0),
      "",
      "No step was executed in this turn. The plan remains active until a later turn updates or completes it.",
    ].join("\n");
  }

  private async handleRenameSessionCommand(session: StoredSession, title: string): Promise<string> {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      return "No session title provided.";
    }

    session.title = trimmed;
    await this.persistSession(session);
    await this.emitSessionInfoUpdate(session);
    return `Renamed session to "${session.title}".`;
  }

  private async maybeAutoTitleFromPrompt(session: StoredSession, promptValue: string): Promise<void> {
    if (session.title && session.title !== "ACP Simulator Session") {
      return;
    }

    const generatedTitle = deriveSessionTitleFromPrompt(promptValue);
    if (!generatedTitle || generatedTitle === session.title) {
      return;
    }

    session.title = generatedTitle;
    await this.persistSession(session);
    await this.emitSessionInfoUpdate(session);
  }

  private async handleScenarioCommand(
    session: StoredSession,
    faultState: PromptFaultState,
    action: Extract<PromptAction, { type: "scenario" }>,
    planContents: string[] | null,
  ): Promise<string> {
    const pathValue = action.path;
    ensureAbsolutePath(pathValue, "path");

    const commandText = action.command?.trim() || "git status";
    const [command, ...args] = commandText.split(/\s+/);
    const readStepIndex = this.findPlanStepIndex(planContents, (content) => /^(inspect|read)\b/i.test(content));
    const runStepIndex = this.findPlanStepIndex(planContents, (content) => /^(run|execute)\b/i.test(content));
    const writeStepIndex = this.findPlanStepIndex(planContents, (content) => /^(write)\b/i.test(content));
    const verifyStepIndex = this.findPlanStepIndex(planContents, (content) => /^(verify)\b/i.test(content));
    const summaryStepIndex = this.findPlanStepIndex(
      planContents,
      (content) => /^(summarize|return summary|return result|return response)\b/i.test(content),
    );

    if (readStepIndex > 0 && planContents) {
      await this.emitPlanProgress(session, faultState, planContents, readStepIndex);
      await this.emitPlanStepOutput(session, planContents, readStepIndex);
    }
    const readResult = await this.performReadCommand(session, faultState, randomUUID(), pathValue);
    const nextContent = action.content?.trim() || this.buildScenarioWriteContent(session, readResult.content);
    if (runStepIndex >= 0 && planContents) {
      await this.emitPlanProgress(session, faultState, planContents, runStepIndex);
      await this.emitPlanStepOutput(session, planContents, runStepIndex, `Command: ${commandText}`);
    }
    const runSummary = await this.handleRunCommand(session, faultState, randomUUID(), command, args);
    if (writeStepIndex >= 0 && planContents) {
      await this.emitPlanProgress(session, faultState, planContents, writeStepIndex);
      await this.emitPlanStepOutput(session, planContents, writeStepIndex, `Target: ${pathValue}`);
    }
    const writeSummary = await this.handleWriteCommand(
      session,
      faultState,
      randomUUID(),
      pathValue,
      nextContent,
    );
    if (verifyStepIndex >= 0 && planContents) {
      await this.emitPlanProgress(session, faultState, planContents, verifyStepIndex);
      await this.emitPlanStepOutput(session, planContents, verifyStepIndex, "Verified that the scenario produced a diff-style file update.");
    }
    if (summaryStepIndex >= 0 && planContents) {
      await this.emitPlanProgress(session, faultState, planContents, summaryStepIndex);
      await this.emitPlanStepOutput(session, planContents, summaryStepIndex, "Preparing final scenario summary.");
    }

    return this.renderScenarioSummary(session, readResult.summary, runSummary, writeSummary);
  }

  private async handleSimulateCommand(
    session: StoredSession,
    fault: FaultMode,
  ): Promise<string> {
    session.pendingFaults.push(fault);
    await this.persistSession(session);
    return `Queued simulator fault ${fault}. It will apply to the next prompt on this session.`;
  }

  private async executePrompt(session: StoredSession, params: PromptRequest, signal: AbortSignal): Promise<PromptResponse> {
    const text = promptText(params.prompt);
    const messageId = params.messageId ?? randomUUID();
    const trimmed = text.trim();
    const action = detectPromptAction(trimmed);

    for (const summary of summarizePrompt(params.prompt)) {
      await this.emitTextChunk(session, "user_message_chunk", summary, messageId);
    }

    if (action.type !== "rename") {
      await this.maybeAutoTitleFromPrompt(session, trimmed);
    }

    const pendingFault = action.type === "simulate" ? null : this.consumePendingFault(session);
    const promptFaultState = this.createPromptFaultState(pendingFault);

    const explicitPlanContents = action.type === "plan" ? parsePlanContents(action.rawPlan) : null;
    const activePlanContents =
      action.type === "plan"
        ? (explicitPlanContents && explicitPlanContents.length > 0 ? explicitPlanContents : null)
        : shouldEmitPlanForAction(action)
          ? this.planContentsForAction(session, action)
          : null;
    if (activePlanContents) {
      await this.emitPlanProgress(session, promptFaultState, activePlanContents, 0);
    }

    await this.emitTextChunk(
      session,
      "agent_thought_chunk",
      this.thoughtForAction(session, action),
    );
    if (activePlanContents) {
      const detail =
        action.type === "plan"
          ? "The requested plan has been registered for later execution."
          : undefined;
      await this.emitPlanStepOutput(session, activePlanContents, 0, detail);
    }

    if (signal.aborted) {
      return {
        stopReason: "cancelled",
        userMessageId: params.messageId ?? null,
      };
    }

    let finalText: string;

    try {
      await this.applyPromptFault(session, pendingFault, signal);
      if (signal.aborted) {
        return {
          stopReason: "cancelled",
          userMessageId: params.messageId ?? null,
        };
      }
      switch (action.type) {
        case "help":
          if (activePlanContents && activePlanContents.length > 1) {
            await this.emitPlanProgress(session, promptFaultState, activePlanContents, 1);
            await this.emitPlanStepOutput(session, activePlanContents, 1, "Collecting available commands, modes, and profile settings.");
          }
          if (activePlanContents && activePlanContents.length > 2) {
            await this.emitPlanProgress(session, promptFaultState, activePlanContents, 2);
            await this.emitPlanStepOutput(session, activePlanContents, 2, "Formatting the help response.");
          }
          finalText = [
            "Simulator Agent ACP",
            "Modes:",
            "- deny: reads + plans only",
            "- accept-edits: asks before edits or shell commands",
            "- yolo: runs tools automatically",
            "",
            "Commands and prompt keywords:",
            "/help",
            "/read /absolute/path",
            "/write /absolute/path content...",
            "/bash command [args...]",
            "/bash command [args...]",
            "/plan step one | step two",
            "/rename Human readable title",
            "/scenario full-cycle /absolute/path [command]",
            "/simulate timeout-next-prompt",
            "/simulate hang-next-prompt",
            "/simulate drop-next-tool-update",
            "/simulate duplicate-next-tool-update",
            "/simulate out-of-order-next-tool-update",
            "/simulate drop-next-plan-update",
            "/simulate duplicate-next-plan-update",
            "/simulate error-next-prompt",
            "/simulate crash-next-prompt",
            "",
            "Natural language examples:",
            "- read /tmp/file.ts",
            "- write /tmp/file.ts: const x = 1",
            "- run `git status`",
            "- plan: inspect | edit | verify",
            "- rename session to Repository Cleanup",
            "- do a full cycle on /tmp/file.ts and run `git diff --stat`",
            "- simulate timeout next prompt",
            "",
            `Current mode: ${session.modes.currentModeId}`,
            `Current model: ${this.displayModelName(session)}`,
            `Reasoning: ${this.currentReasoningLevel(session)}`,
            `Permission policy: ${this.currentPermissionMode(session)}`,
            "Mode and model changes must use ACP session/set_mode and session/set_model.",
          ].join("\n");
          break;
        case "read":
          finalText = await this.handleReadCommand(session, promptFaultState, randomUUID(), action.path);
          break;
        case "write": {
          finalText = await this.handleWriteCommand(
            session,
            promptFaultState,
            randomUUID(),
            action.path,
            action.content,
          );
          break;
        }
        case "run":
          finalText = await this.handleRunCommand(
            session,
            promptFaultState,
            randomUUID(),
            action.command,
            action.args,
          );
          break;
        case "plan":
          finalText = await this.handlePlanCommand(session, explicitPlanContents ?? []);
          break;
        case "rename":
          finalText = await this.handleRenameSessionCommand(session, action.title);
          break;
        case "scenario":
          finalText = await this.handleScenarioCommand(session, promptFaultState, action, activePlanContents);
          break;
        case "simulate":
          finalText = await this.handleSimulateCommand(session, action.fault);
          break;
        default: {
          finalText = this.renderDescribeResponse(session, params.prompt);
          break;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message === "Simulated fatal exit") {
        throw error;
      }
      finalText = `ACP simulator agent failed: ${error instanceof Error ? error.message : String(error)}`;
    }

    if (signal.aborted) {
      return {
        stopReason: "cancelled",
        userMessageId: params.messageId ?? null,
      };
    }

    if (action.type !== "plan") {
      await this.completePlan(session, promptFaultState, activePlanContents);
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

export function createSimulatorAgentAcp(
  connection: AgentSideConnection,
  options?: SimulatorAgentAcpOptions,
): SimulatorAgentAcp {
  return new SimulatorAgentAcp(connection, options);
}

export {
  ACP_PROTOCOL_ALIGNMENT_VERIFIED_AT,
  ACP_PROTOCOL_DOCS_SCHEMA_URL,
  ACP_PROTOCOL_DOCS_URL,
  ACP_PROTOCOL_SOURCE_REF,
  ACP_PROTOCOL_SOURCE_REPO,
  PROTOCOL_VERSION as ACP_PROTOCOL_VERSION,
};
export type { SimulatorAgentAcpOptions };
