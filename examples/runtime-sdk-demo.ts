import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { cwd, stdin as input, stdout as output } from "node:process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { SeverityNumber } from "@opentelemetry/api-logs";

import {
  AcpProtocolError,
  AcpRuntime,
  AcpRuntimeOperationKind,
  AcpRuntimeOperationProjectionLifecycle,
  AcpRuntimePermissionProjectionLifecycle,
  AcpRuntimePermissionResolution,
  AcpRuntimeProjectionUpdateType,
  AcpRuntimeReadModelUpdateType,
  AcpRuntimeSession,
  AcpRuntimeThreadEntryKind,
  AcpRuntimeTurnEventType,
  createStdioAcpConnectionFactory,
  listRuntimeAgentModeKeys,
  resolveRuntimeAgentId,
  resolveRuntimeAgentModeId,
  resolveRuntimeHomePath,
  runtimeAgentModeKey,
  type AcpRuntimeHistoryEntry,
  type AcpRuntimeInitialConfig,
  type AcpRuntimeInitialConfigReport,
  type AcpRuntimeProjectionUpdate,
  type AcpRuntimeStateUpdate,
  type AcpRuntimeAuthorityHandlers,
  type AcpRuntimeAgentConfigOption,
  type AcpRuntimeConfigValue,
  type AcpRuntimeOperation,
  type AcpRuntimePermissionRequest,
  type AcpRuntimePrompt,
  type AcpRuntimeThreadEntry,
  type AcpRuntimeTurnEvent,
} from "@saaskit-dev/acp-runtime";
import { promptForDemoAuthentication } from "./runtime-demo-auth-adapter.js";
import {
  configureDemoLogSink,
  type DemoLogSink as LogSink,
} from "./runtime-demo-log-sink.js";
import {
  createInputCoordinator,
  createOutputGate,
  type DemoInputCoordinator as InputCoordinator,
  type DemoOutputGate as OutputGate,
} from "./runtime-demo-input.js";

type TimelineRenderer = {
  createTurn(prompt: string): TurnRenderer;
  flush(): void;
  writeLine(label: string, detail: string): void;
  writeEvent(event: AcpRuntimeTurnEvent): void;
};

type TurnRenderer = {
  flush(): void;
  writeEvent(event: AcpRuntimeTurnEvent): void;
  writeLine(label: string, detail: string): void;
};

type RuntimeSmokeConfig = {
  agentId: string;
  cwd: string;
  cleanup(): Promise<void>;
  handlers?: AcpRuntimeAuthorityHandlers;
  label: string;
};

type DemoCliOptions = {
  agentId: string;
  initialConfig?: AcpRuntimeInitialConfig;
  initialPrompt: string;
  listSessions: boolean;
  loadSessionId?: string;
  logFile?: string;
  resumeLast: boolean;
  resumeSessionId?: string;
  systemPrompt?: string;
  systemPromptFile?: string;
};

type ExitSignal = {
  requested: boolean;
};

type StreamChunkType = "text" | "thinking";

type StreamAccumulator = {
  buffer: string;
  type?: StreamChunkType;
};

type TurnEventProjectionInstruction =
  | {
      kind: "line";
      label: string;
      detail: string;
    }
  | {
      kind: "skip";
    }
  | {
      kind: "stream";
      streamType: StreamChunkType;
      text: string;
    };

type TurnProjection = {
  bindTurn(turnId: string): void;
  stop(): void;
};

type TurnEventProjection = {
  nextTurn(): void;
  project(event: AcpRuntimeTurnEvent): TurnEventProjectionInstruction;
};

const LOCAL_COMMANDS = [
  "/help",
  "/mode",
  "/config",
  "/config-json",
  "/thread",
  "/diffs",
  "/terminals",
  "/toolcalls",
  "/operations",
  "/permissions",
  "/usage",
  "/metadata",
  "/metadata-json",
  "/queue",
  "/queue-policy",
  "/queue-clear",
  "/drop",
  "/cancel",
  "/insert",
  "/slash",
  "/exit",
] as const;

const DEFAULT_LOG_FILE = resolveRuntimeHomePath("logs", "runtime.log");

function resolveAgentId(inputAgent: string | undefined): string {
  if (!inputAgent) {
    return resolveRuntimeAgentId("simulator");
  }
  return resolveRuntimeAgentId(inputAgent);
}

function isLocalSimulatorAgent(agentId: string): boolean {
  return agentId === "simulator-agent-acp-local";
}

function parseCliOptions(argv: string[]): DemoCliOptions {
  const rawAgent = argv[2];
  const agentId = resolveAgentId(rawAgent);
  const promptTokens: string[] = [];
  const rawInitialConfig: {
    mode?: string;
    model?: string;
    effort?: string;
    strict?: boolean;
  } = {};
  let listSessions = false;
  let loadSessionId: string | undefined;
  let logFile: string | undefined =
    process.env.ACP_RUNTIME_LOG_FILE?.trim() || DEFAULT_LOG_FILE;
  let resumeLast = false;
  let resumeSessionId: string | undefined;
  let systemPrompt: string | undefined;
  let systemPromptFile: string | undefined;

  for (const token of argv.slice(rawAgent ? 3 : 2)) {
    if (token === "--sessions") {
      listSessions = true;
      continue;
    }
    if (token.startsWith("--load=")) {
      loadSessionId = token.slice("--load=".length) || undefined;
      continue;
    }
    if (token.startsWith("--resume=")) {
      resumeSessionId = token.slice("--resume=".length) || undefined;
      continue;
    }
    if (token === "--resume-last") {
      resumeLast = true;
      continue;
    }
    if (token === "--resume-snapshot" || token.startsWith("--resume-snapshot=")) {
      throw new Error(
        "usage: --resume-snapshot was removed; use --resume=<sessionId> or --resume-last",
      );
    }
    if (token.startsWith("--log-file=")) {
      logFile = token.slice("--log-file=".length).trim() || undefined;
      continue;
    }
    if (token.startsWith("--log=")) {
      logFile = token.slice("--log=".length).trim() || undefined;
      continue;
    }
    if (token.startsWith("--mode=")) {
      rawInitialConfig.mode = token.slice("--mode=".length).trim() || undefined;
      continue;
    }
    if (token.startsWith("--model=")) {
      rawInitialConfig.model = token.slice("--model=".length).trim() || undefined;
      continue;
    }
    if (token.startsWith("--effort=")) {
      rawInitialConfig.effort =
        token.slice("--effort=".length).trim() || undefined;
      continue;
    }
    if (token === "--config" || token.startsWith("--config=")) {
      throw new Error(
        "usage: startup --config was removed; use --mode=<id>, --model=<id>, or --effort=<level>",
      );
    }
    if (
      token === "--initial-config-strict" ||
      token === "--strict-initial-config"
    ) {
      rawInitialConfig.strict = true;
      continue;
    }
    if (token.startsWith("--system-prompt=")) {
      systemPrompt = token.slice("--system-prompt=".length);
      continue;
    }
    if (token === "--system-prompt") {
      throw new Error("usage: --system-prompt=<text>");
    }
    if (token.startsWith("--system-prompt-file=")) {
      systemPromptFile =
        token.slice("--system-prompt-file=".length).trim() || undefined;
      continue;
    }
    if (token === "--system-prompt-file") {
      throw new Error("usage: --system-prompt-file=<path>");
    }
    if (token === "--no-log-file") {
      logFile = undefined;
      continue;
    }
    if (token.startsWith("--")) {
      console.error(`[runtime] warning: ignoring unknown option: ${token}`);
      continue;
    }
    promptTokens.push(token);
  }

  if (
    (systemPrompt !== undefined || systemPromptFile !== undefined) &&
    (loadSessionId || resumeLast || resumeSessionId)
  ) {
    throw new Error(
      "usage: --system-prompt and --system-prompt-file are only supported when creating a new session; remove them when using --load, --resume, or --resume-last",
    );
  }

  return {
    agentId,
    initialConfig: createInitialConfig(rawInitialConfig),
    initialPrompt: promptTokens.join(" "),
    listSessions,
    loadSessionId,
    logFile,
    resumeLast,
    resumeSessionId,
    systemPrompt,
    systemPromptFile,
  };
}

function createInitialConfig(input: {
  mode?: string;
  model?: string;
  effort?: string;
  strict?: boolean;
}): AcpRuntimeInitialConfig | undefined {
  if (
    !input.mode &&
    !input.model &&
    !input.effort &&
    !input.strict
  ) {
    return undefined;
  }
  return {
    mode: input.mode,
    model: input.model,
    effort: input.effort,
    strict: input.strict,
  };
}

function formatSessionList(
  sessions: readonly {
    id: string;
    cwd: string;
    title?: string;
    updatedAt?: string;
    agentType?: string;
  }[],
): string {
  if (sessions.length === 0) {
    return "[runtime] no agent sessions";
  }

  return sessions
    .map((session, index) =>
      [
        `${index + 1}. ${session.id}`,
        `   cwd=${session.cwd}`,
        `   title=${session.title ?? "<none>"}`,
        `   updatedAt=${session.updatedAt ?? "<none>"}`,
        `   agentType=${session.agentType ?? "<none>"}`,
      ].join("\n"),
    )
    .join("\n");
}

function formatInitialConfigReport(
  report: AcpRuntimeInitialConfigReport | undefined,
  options: readonly AcpRuntimeAgentConfigOption[] = [],
): string | undefined {
  if (!report || report.items.length === 0) {
    return undefined;
  }

  const lines = [
    `[runtime] initial config ${report.ok ? "applied" : "partially applied"}`,
  ];
  for (const item of report.items) {
    const target = item.optionId ? `${item.key} -> ${item.optionId}` : item.key;
    const value =
      item.appliedValue === undefined
        ? String(item.requestedValue)
        : String(item.appliedValue);
    const label = formatConfigValueLabel(options, item.optionId, value);
    const reason = item.reason ? ` | ${item.reason}` : "";
    lines.push(`  ${item.status} ${target}=${value}${label}${reason}`);
  }
  return lines.join("\n");
}

function formatConfigValueLabel(
  options: readonly AcpRuntimeAgentConfigOption[],
  optionId: string | undefined,
  value: string,
): string {
  if (!optionId || optionId === "currentModeId") {
    return "";
  }
  const option = options.find((entry) => entry.id === optionId);
  const choice = option?.options?.find((entry) => String(entry.value) === value);
  if (!choice || choice.name === value) {
    return "";
  }
  return ` (${choice.name})`;
}

function renderHistoryEntries(
  entries: readonly AcpRuntimeHistoryEntry[],
  renderer: TimelineRenderer,
): void {
  for (const entry of entries) {
    if (entry.type === "user") {
      renderer.writeLine("user", entry.text);
      continue;
    }
    renderer.writeEvent(entry);
  }
}

function summarizeQueuedPrompt(prompt: AcpRuntimePrompt): string {
  if (typeof prompt === "string") {
    return shortenForTerminal(prompt, 72);
  }

  if (!Array.isArray(prompt) || prompt.length === 0) {
    return "<empty>";
  }

  const first = prompt[0];
  if (
    typeof first === "object" &&
    first !== null &&
    "role" in first &&
    "content" in first
  ) {
    const userMessage = prompt.find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "role" in entry &&
        entry.role === "user",
    ) as { content: string | readonly { text?: string; type: string }[] } | undefined;
    if (!userMessage) {
      return "<message prompt>";
    }
    if (typeof userMessage.content === "string") {
      return shortenForTerminal(userMessage.content, 72);
    }
    const text = userMessage.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join(" ");
    return text ? shortenForTerminal(text, 72) : "<multipart prompt>";
  }

  const text = prompt
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");
  return text ? shortenForTerminal(text, 72) : "<multipart prompt>";
}

function formatQueuedTurns(session: AcpRuntimeSession): string {
  const queuedTurns = session.turn.queue.list();
  if (queuedTurns.length === 0) {
    return "[runtime] queue is empty";
  }

  return queuedTurns
    .map(
      (turn) =>
        `${turn.position}. ${turn.turnId} [${turn.status}]\n   prompt=${summarizeQueuedPrompt(turn.prompt)}\n   queuedAt=${turn.queuedAt}`,
    )
    .join("\n");
}

function resolveQueuedTurnId(
  session: AcpRuntimeSession,
  rawTurnId: string,
): string | undefined {
  const queuedTurns = session.turn.queue.list();
  const exact = queuedTurns.find((turn) => turn.turnId === rawTurnId);
  if (exact) {
    return exact.turnId;
  }
  const matches = queuedTurns.filter((turn) => turn.turnId.startsWith(rawTurnId));
  return matches.length === 1 ? matches[0].turnId : undefined;
}

function formatThreadEntries(session: AcpRuntimeSession): string {
  const entries = session.state.thread.entries();
  if (entries.length === 0) {
    return "[runtime] thread is empty";
  }

  return entries
    .map((entry, index) => {
      switch (entry.kind) {
        case AcpRuntimeThreadEntryKind.UserMessage:
          return `${index + 1}. user ${entry.turnId ? `[${entry.turnId}]` : ""}\n   ${shortenForTerminal(entry.text, 180)}`;
        case AcpRuntimeThreadEntryKind.AssistantMessage:
          return `${index + 1}. assistant ${entry.status} [${entry.turnId}]\n   ${shortenForTerminal(entry.text, 180)}`;
        case AcpRuntimeThreadEntryKind.AssistantThought:
          return `${index + 1}. thinking ${entry.status} [${entry.turnId}]\n   ${shortenForTerminal(entry.text, 180)}`;
        case AcpRuntimeThreadEntryKind.Plan:
          return `${index + 1}. plan [${entry.turnId}]\n   ${entry.plan.map((item) => `${item.status}:${item.content}`).join(" / ")}`;
        case AcpRuntimeThreadEntryKind.ToolCall:
          return `${index + 1}. tool ${entry.status} ${entry.toolCallId} [${entry.turnId}]\n   ${shortenForTerminal(entry.title, 180)}`;
      }
    })
    .join("\n");
}

function formatDiffs(session: AcpRuntimeSession): string {
  const diffs = session.state.diffs.list();
  if (diffs.length === 0) {
    return "[runtime] no diffs";
  }

  return diffs
    .map(
      (diff, index) =>
        `${index + 1}. ${diff.path} rev=${diff.revision} ${diff.changeType} +${diff.newLineCount}${typeof diff.oldLineCount === "number" ? ` -${diff.oldLineCount}` : ""}${diff.toolCallId ? ` tool=${diff.toolCallId}` : ""}`,
    )
    .join("\n");
}

function formatTerminals(session: AcpRuntimeSession): string {
  const terminals = session.state.terminals.list();
  if (terminals.length === 0) {
    return "[runtime] no terminals";
  }

  return terminals
    .map((terminal, index) => {
      const output = terminal.output
        ? `\n   ${previewLines(terminal.output, 3)}`
        : "";
      return `${index + 1}. ${terminal.terminalId} ${terminal.status}${typeof terminal.exitCode === "number" ? ` exit=${terminal.exitCode}` : ""}${terminal.command ? ` | ${terminal.command}` : ""}${terminal.toolCallId ? ` | tool=${terminal.toolCallId}` : ""}${output}`;
    })
    .join("\n");
}

function formatToolCalls(session: AcpRuntimeSession): string {
  const bundles = session.state.toolCalls.bundles();
  if (bundles.length === 0) {
    return "[runtime] no tool calls";
  }

  return bundles
    .map((bundle, index) => {
      const tool = bundle.toolCall;
      return `${index + 1}. ${tool.toolCallId} ${tool.status} [${tool.turnId}]\n   ${shortenForTerminal(tool.title, 160)}\n   diffs=${bundle.diffs.length} terminals=${bundle.terminals.length} content=${tool.content.length}`;
    })
    .join("\n");
}

function formatOperations(session: AcpRuntimeSession): string {
  const operations = session.state.operations.list();
  if (operations.length === 0) {
    return "[runtime] no operations";
  }

  return operations
    .map(
      (operation, index) =>
        `${index + 1}. ${operation.id} ${operation.kind} ${operation.phase} [${operation.turnId}]\n   ${formatOperationHeader(operation)}${operation.permission?.requested ? `\n   permission=${operation.permission.decision ?? "pending"}` : ""}`,
    )
    .join("\n");
}

function formatPermissions(session: AcpRuntimeSession): string {
  const permissions = session.state.permissions.list();
  if (permissions.length === 0) {
    return "[runtime] no permissions";
  }

  return permissions
    .map(
      (request, index) =>
        `${index + 1}. ${request.id} ${request.kind} ${request.phase} [${request.turnId}]\n   ${shortenForTerminal(request.title, 180)}`,
    )
    .join("\n");
}

function formatUsageSnapshot(session: AcpRuntimeSession): string {
  return formatUsage(session.state.usage() ?? {}) ?? "[runtime] no usage yet";
}

function formatMetadataSnapshot(session: AcpRuntimeSession): string {
  return summarizeMetadata(
    (session.state.metadata() ?? session.metadata) as Record<string, unknown>,
  );
}


function completeLocalCommand(
  line: string,
  session?: AcpRuntimeSession,
): [string[], string] {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("/")) {
    return [[], line];
  }

  const parts = trimmed.split(/\s+/);
  const trailingSpace = /\s$/.test(trimmed);

  if (parts.length <= 1 && !trailingSpace) {
    const matches = LOCAL_COMMANDS.filter((command) =>
      command.startsWith(trimmed),
    );
    return [matches.length > 0 ? [...matches] : [...LOCAL_COMMANDS], trimmed];
  }

  if (parts[0] === "/mode") {
    const modes = listRuntimeAgentModeKeys(session?.agent.listModes() ?? []);
    const current = trailingSpace ? "" : (parts[1] ?? "");
    const matches = modes.filter((mode) => mode.startsWith(current));
    return [matches.length > 0 ? matches : modes, current];
  }

  if (parts[0] === "/config") {
    const options = session?.agent.listConfigOptions() ?? [];
    const optionIds = listConfigOptionKeys(options);

    if (parts.length === 2 && !trailingSpace) {
      const current = parts[1] ?? "";
      const matches = optionIds.filter((id) => id.startsWith(current));
      return [matches.length > 0 ? matches : optionIds, current];
    }

    if (parts.length === 2 && trailingSpace) {
      return [optionIds, ""];
    }

    const optionId = parts[1];
    const option = resolveCliConfigOption(options, optionId).option;
    const values = option?.options?.map((entry) => String(entry.value)) ?? [];
    const current = trailingSpace ? "" : (parts[2] ?? "");
    const matches = values.filter((value) => value.startsWith(current));
    return [matches.length > 0 ? matches : values, current];
  }
  if (parts[0] === "/drop") {
    const queuedTurnIds = session?.turn.queue.list().map((turn) => turn.turnId) ?? [];
    const current = trailingSpace ? "" : (parts[1] ?? "");
    const matches = queuedTurnIds.filter((turnId) => turnId.startsWith(current));
    return [matches.length > 0 ? matches : queuedTurnIds, current];
  }
  if (parts[0] === "/queue-policy") {
    const values = ["sequential", "coalesce"];
    const current = trailingSpace ? "" : (parts[1] ?? "");
    const matches = values.filter((value) => value.startsWith(current));
    return [matches.length > 0 ? matches : values, current];
  }
  if (parts[0] === "/slash") {
    const commands =
      session?.metadata.availableCommands?.map((command) => command.name) ?? [];

    if (parts.length === 2 && !trailingSpace) {
      const current = parts[1] ?? "";
      const matches = commands.filter((command) => command.startsWith(current));
      return [matches.length > 0 ? matches : commands, current];
    }

    if (parts.length === 2 && trailingSpace) {
      return [commands, ""];
    }

    return [[], trimmed];
  }

  return [[], trimmed];
}

function formatAvailableCommands(
  commands: readonly { name: string; description?: string }[],
): string {
  if (commands.length === 0) {
    return "[runtime] no available slash commands";
  }

  return commands
    .map((command) =>
      command.description
        ? `/${command.name}  ${command.description}`
        : `/${command.name}`,
    )
    .join("\n");
}

function formatAgentModes(
  modes: readonly { id: string; name: string; description?: string }[],
): string {
  if (modes.length === 0) {
    return "[runtime] no available modes";
  }

  return [
    "[runtime] modes",
    ...modes.map((mode) => {
      const key = runtimeAgentModeKey(mode);
      const id = key === mode.id ? "" : ` (${mode.id})`;
      return mode.description
        ? `  ${key.padEnd(12)} ${mode.name}${id} - ${mode.description}`
        : `  ${key.padEnd(12)} ${mode.name}${id}`;
    }),
    "usage: /mode <id|name>",
  ].join("\n");
}

function formatConfigOptions(
  options: readonly AcpRuntimeAgentConfigOption[],
): string {
  if (options.length === 0) {
    return "[runtime] no config options";
  }

  return [
    "[runtime] config options",
    ...options.map((option) =>
      [
        `  ${option.id.padEnd(22)}`,
        option.category ? `[${option.category}] `.padEnd(18) : "".padEnd(18),
        `${option.name}: ${String(option.value)}`,
      ].join(""),
    ),
    "usage: /config <id|category> <value>",
    "raw: /config-json",
  ].join("\n");
}

function formatConfigOption(option: AcpRuntimeAgentConfigOption): string {
  const lines = [
    `[runtime] config ${option.id}`,
    `  name: ${option.name}`,
    `  type: ${option.type}`,
    `  value: ${String(option.value)}`,
  ];

  if (option.category) {
    lines.push(`  category: ${option.category}`);
  }
  if (option.description) {
    lines.push(`  description: ${option.description}`);
  }
  if (option.options?.length) {
    lines.push("  options:");
    for (const entry of option.options) {
      lines.push(
        entry.description
          ? `    ${String(entry.value).padEnd(18)} ${entry.name} - ${entry.description}`
          : `    ${String(entry.value).padEnd(18)} ${entry.name}`,
      );
    }
  }
  return lines.join("\n");
}

function listConfigOptionKeys(
  options: readonly AcpRuntimeAgentConfigOption[],
): string[] {
  const categoryCounts = new Map<string, number>();
  for (const option of options) {
    if (option.category && option.category !== option.id) {
      categoryCounts.set(option.category, (categoryCounts.get(option.category) ?? 0) + 1);
    }
  }

  const keys = new Set<string>();
  for (const option of options) {
    keys.add(option.id);
    if (
      option.category &&
      option.category !== option.id &&
      categoryCounts.get(option.category) === 1
    ) {
      keys.add(option.category);
    }
  }
  return [...keys];
}

function parseConfigCommandArgs(args: string): {
  optionId: string;
  value: string;
} {
  const assignment = args.match(/^([^=\s]+)=(.*)$/);
  if (assignment) {
    return {
      optionId: assignment[1] ?? "",
      value: (assignment[2] ?? "").trim(),
    };
  }

  const [optionId, ...valueParts] = args.split(/\s+/);
  return {
    optionId: optionId ?? "",
    value: valueParts.join(" ").trim(),
  };
}

function resolveCliConfigOption(
  options: readonly AcpRuntimeAgentConfigOption[],
  optionIdOrCategory: string | undefined,
): {
  error?: string;
  option?: AcpRuntimeAgentConfigOption;
} {
  if (!optionIdOrCategory) {
    return { error: "usage: /config <id|category> [value]" };
  }

  const byId = options.find((option) => option.id === optionIdOrCategory);
  if (byId) {
    return { option: byId };
  }

  const byCategory = options.filter(
    (option) => option.category === optionIdOrCategory,
  );
  if (byCategory.length === 1 && byCategory[0]) {
    return { option: byCategory[0] };
  }

  if (byCategory.length > 1) {
    return {
      error: `[runtime] ambiguous config category: ${optionIdOrCategory}. Use one of: ${byCategory
        .map((option) => option.id)
        .join(", ")}`,
    };
  }

  return {
    error: `[runtime] unknown config option: ${optionIdOrCategory}`,
  };
}

function normalizeCliConfigValue(
  option: AcpRuntimeAgentConfigOption,
  value: string,
): {
  error?: string;
  value?: AcpRuntimeConfigValue;
} {
  if (option.type === "boolean") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return { value: true };
    }
    if (normalized === "false") {
      return { value: false };
    }
    return {
      error: `[runtime] invalid config value for ${option.id}: ${value}. Valid values: true, false`,
    };
  }

  if (option.type === "number") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return { value: parsed };
    }
    return {
      error: `[runtime] invalid config value for ${option.id}: ${value}. Expected a number.`,
    };
  }

  if (option.type !== "select" || !option.options?.length) {
    return { value };
  }

  const raw = value.trim();
  const lower = raw.toLowerCase();
  const match =
    option.options.find((entry) => String(entry.value) === raw) ??
    option.options.find((entry) => entry.name === raw) ??
    option.options.find((entry) => String(entry.value).toLowerCase() === lower) ??
    option.options.find((entry) => entry.name.toLowerCase() === lower);

  if (match) {
    return { value: match.value };
  }

  return {
    error: `[runtime] invalid config value for ${option.id}: ${value}. Valid values: ${option.options
      .map((entry) =>
        entry.name === String(entry.value)
          ? String(entry.value)
          : `${String(entry.value)} (${entry.name})`,
      )
      .join(", ")}`,
  };
}

function summarizeOutputPart(part: unknown): string {
  if (!part || typeof part !== "object") {
    return shortenForTerminal(JSON.stringify(part));
  }

  const typedPart = part as {
    type?: string;
    text?: string;
    value?: unknown;
  };

  if (typedPart.type === "text" && typeof typedPart.text === "string") {
    return `text(${typedPart.text.length} chars): ${shortenForTerminal(typedPart.text, 80)}`;
  }

  if (typedPart.type === "json") {
    const value =
      typedPart.value && typeof typedPart.value === "object"
        ? Object.keys(typedPart.value as Record<string, unknown>).join(",")
        : shortenForTerminal(JSON.stringify(typedPart.value));
    return `json(${value || "empty"})`;
  }

  return shortenForTerminal(JSON.stringify(part), 100);
}

function getJsonOutputValue(
  operation: AcpRuntimeOperation,
): Record<string, unknown> | undefined {
  const jsonPart = operation.result?.output?.find(
    (part) =>
      part.type === "json" && part.value && typeof part.value === "object",
  );

  return jsonPart?.type === "json" &&
    jsonPart.value &&
    typeof jsonPart.value === "object"
    ? (jsonPart.value as Record<string, unknown>)
    : undefined;
}

function previewLines(text: string, maxLines = 3, maxWidth = 100): string {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(0, maxLines)
    .map((line) => shortenForTerminal(line, maxWidth));
  return lines.join(" / ");
}

function summarizeOperationResult(operation: AcpRuntimeOperation): string[] {
  const lines: string[] = [];
  const jsonValue = getJsonOutputValue(operation);
  const outputText = operation.result?.outputText?.trim();

  if (operation.kind === AcpRuntimeOperationKind.WriteFile && jsonValue) {
    const newText =
      typeof jsonValue.newText === "string" ? jsonValue.newText : undefined;
    const oldText =
      typeof jsonValue.oldText === "string" ? jsonValue.oldText : undefined;

    lines.push(`change=${oldText ? "updated" : "created"}`);
    if (newText) {
      lines.push(`content=${previewLines(newText, 4, 88)}`);
    }
    return lines;
  }

  if (operation.kind === AcpRuntimeOperationKind.ReadFile) {
    if (outputText) {
      const outputLines = outputText.split("\n").filter(Boolean);
      lines.push(`matches=${outputLines.length}`);
      if (outputLines.length > 0) {
        lines.push(`preview=${previewLines(outputText, 3, 96)}`);
      }
      return lines;
    }

    if (operation.result?.output) {
      lines.push(`output.parts=${operation.result.output.length}`);
      lines.push(
        `preview=${operation.result.output
          .slice(0, 3)
          .map((part) => summarizeOutputPart(part))
          .join(" | ")}`,
      );
    }
    return lines;
  }

  if (operation.kind === AcpRuntimeOperationKind.ExecuteCommand) {
    if (outputText) {
      const normalized = outputText
        .replace(/^```[a-z]*\n?/i, "")
        .replace(/\n```$/, "")
        .trim();
      if (normalized) {
        lines.push(`output=${previewLines(normalized, 3, 96)}`);
      }
      return lines;
    }

    if (operation.result?.summary) {
      lines.push(`summary=${shortenForTerminal(operation.result.summary, 96)}`);
      return lines;
    }
  }

  if (operation.result?.summary) {
    lines.push(`result=${shortenForTerminal(operation.result.summary, 96)}`);
  }
  if (outputText) {
    lines.push(`output=${shortenForTerminal(outputText, 96)}`);
  }
  if (operation.result?.output) {
    lines.push(`output.parts=${operation.result.output.length}`);
    lines.push(
      `output.summary=${operation.result.output
        .slice(0, 3)
        .map((part) => summarizeOutputPart(part))
        .join(" | ")}`,
    );
  }

  return lines;
}

function formatOperationHeader(operation: AcpRuntimeOperation): string {
  const title = shortenForTerminal(operation.title, 110);
  return `${operation.kind} | ${title}`;
}

function describeOperationKind(kind: AcpRuntimeOperation["kind"]): string {
  switch (kind) {
    case AcpRuntimeOperationKind.ExecuteCommand:
      return "命令";
    case AcpRuntimeOperationKind.ReadFile:
      return "读取文件";
    case AcpRuntimeOperationKind.WriteFile:
      return "写入文件";
    case AcpRuntimeOperationKind.DocumentEdit:
      return "编辑文档";
    case AcpRuntimeOperationKind.McpCall:
      return "工具调用";
    case AcpRuntimeOperationKind.NetworkRequest:
      return "网络请求";
    default:
      return "操作";
  }
}

function summarizeOperationSubject(operation: AcpRuntimeOperation): string {
  if (operation.target?.value) {
    return shortenForTerminal(operation.target.value, 96);
  }
  if (operation.summary) {
    return shortenForTerminal(operation.summary, 96);
  }
  return shortenForTerminal(operation.title, 96);
}

function summarizeOperationInlineResult(
  operation: AcpRuntimeOperation,
): string | undefined {
  const first = summarizeOperationResult(operation)[0];
  if (!first) {
    return undefined;
  }
  return shortenForTerminal(first.replace(/^[a-z.]+=/, ""), 96);
}

function formatOperationInline(
  operation: AcpRuntimeOperation,
  lifecycle: "completed" | "failed" | "started" | "updated",
  errorMessage?: string,
): string {
  const kind = describeOperationKind(operation.kind);
  const subject = summarizeOperationSubject(operation);
  const result = summarizeOperationInlineResult(operation);

  if (lifecycle === "started") {
    return `${kind}: ${subject}`;
  }

  if (lifecycle === "updated") {
    if (operation.phase === "awaiting_permission") {
      return `等待权限 ${kind}: ${subject}`;
    }
    if (operation.phase === "proposed") {
      return `准备 ${kind}: ${subject}`;
    }
    return `进行中 ${kind}: ${subject}`;
  }

  if (lifecycle === "completed") {
    return result ? `${kind}完成: ${result}` : `${kind}完成: ${subject}`;
  }

  return `${kind}失败: ${errorMessage ? shortenForTerminal(errorMessage, 96) : subject}`;
}

function formatOperationDetail(operation: AcpRuntimeOperation): string {
  const lines = [formatOperationHeader(operation), `phase=${operation.phase}`];

  if (operation.target) {
    lines.push(
      `target=${shortenForTerminal(`${operation.target.type}:${operation.target.value}`)}`,
    );
  }
  if (operation.summary) {
    lines.push(`summary=${shortenForTerminal(operation.summary)}`);
  }
  if (operation.progress) {
    lines.push(
      `progress=${shortenForTerminal(JSON.stringify(operation.progress))}`,
    );
  }
  if (operation.permission) {
    lines.push(
      `permission=${shortenForTerminal(JSON.stringify(operation.permission))}`,
    );
  }
  lines.push(...summarizeOperationResult(operation));
  if (operation.failureReason) {
    lines.push(`failureReason=${operation.failureReason}`);
  }

  return lines.join("\n");
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatElapsed(startedAt: number): string {
  const elapsedMs = Date.now() - startedAt;
  const minutes = Math.floor(elapsedMs / 60_000);
  const seconds = Math.floor((elapsedMs % 60_000) / 1_000);
  const milliseconds = elapsedMs % 1_000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0",
  )}.${String(milliseconds).padStart(3, "0")}`;
}

function color(code: string, text: string): string {
  return `\u001b[${code}m${text}\u001b[0m`;
}

function formatUnknownError(error: unknown): string {
  return formatUnknownErrorWithCauses(error);
}

function formatUnknownErrorWithCauses(
  error: unknown,
  seen = new Set<unknown>(),
): string {
  if (error instanceof Error) {
    if (getErrorExitCode(error) !== undefined) {
      return `${error.name}: ${error.message}`;
    }
    const formatted = error.stack ?? `${error.name}: ${error.message}`;
    const cause = (error as { cause?: unknown }).cause;
    if (cause === undefined || seen.has(cause)) {
      return formatted;
    }
    seen.add(error);
    seen.add(cause);
    return `${formatted}\nCaused by: ${formatUnknownErrorWithCauses(cause, seen)}`;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function getErrorExitCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const value = (error as { exitCode?: unknown }).exitCode;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return undefined;
  }

  return value;
}

function shortenForTerminal(text: string, max = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function renderInlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, (_, value: string) => color("36", value))
    .replace(/\*\*([^*]+)\*\*/g, (_, value: string) => color("1", value));
}

function renderMarkdownForTerminal(markdown: string): string {
  const lines = markdown.split("\n");
  const rendered: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      rendered.push(color("90", line));
      continue;
    }

    if (inCodeBlock) {
      rendered.push(color("36", line));
      continue;
    }

    if (/^\s*\|(?:\s*[-:]+[-|\s:]*)+\|?\s*$/.test(line)) {
      rendered.push(color("90", line));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      rendered.push(color("1;34", heading[2]));
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      rendered.push(color("90", `> ${renderInlineMarkdown(quote[1])}`));
      continue;
    }

    const bullet = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (bullet) {
      rendered.push(
        `${bullet[1]}${color("33", bullet[2])} ${renderInlineMarkdown(bullet[3])}`,
      );
      continue;
    }

    if (line.includes("|")) {
      rendered.push(renderInlineMarkdown(line));
      continue;
    }

    rendered.push(renderInlineMarkdown(line));
  }

  return rendered.join("\n");
}

function summarizeMetadata(
  metadata: NonNullable<
    AcpRuntimeTurnEvent["type"] extends never ? never : Record<string, unknown>
  >,
): string {
  const sessionMetadata = metadata as {
    agentConfigOptions?: readonly { id: string; value: unknown }[];
    agentModes?: readonly unknown[];
    availableCommands?: readonly unknown[];
    config?: Record<string, unknown>;
    currentModeId?: string;
    id?: string;
  };
  const parts: string[] = [];

  if (sessionMetadata.currentModeId) {
    parts.push(`currentMode=${sessionMetadata.currentModeId}`);
  }
  if (
    sessionMetadata.config &&
    Object.keys(sessionMetadata.config).length > 0
  ) {
    parts.push(
      `config=${Object.entries(sessionMetadata.config)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(", ")}`,
    );
  }
  if (sessionMetadata.agentModes) {
    parts.push(`modes=${sessionMetadata.agentModes.length}`);
  }
  if (sessionMetadata.agentConfigOptions) {
    parts.push(`configOptions=${sessionMetadata.agentConfigOptions.length}`);
  }
  if (sessionMetadata.availableCommands) {
    parts.push(`slash=${sessionMetadata.availableCommands.length}`);
  }
  if (sessionMetadata.id) {
    parts.push(`session=${sessionMetadata.id}`);
  }

  return parts.length > 0
    ? parts.join(" | ")
    : shortenForTerminal(JSON.stringify(metadata), 160);
}

function formatUsage(usage: {
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
}): string | undefined {
  const formatCount = (value: number) =>
    new Intl.NumberFormat("en-US").format(value);
  const formatUsd = (value: number) =>
    value.toLocaleString("en-US", {
      maximumFractionDigits: 6,
      minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 0,
    });
  const parts: string[] = [];

  if (typeof usage.inputTokens === "number" && usage.inputTokens > 0) {
    parts.push(`in=${formatCount(usage.inputTokens)}`);
  }
  if (typeof usage.outputTokens === "number" && usage.outputTokens > 0) {
    parts.push(`out=${formatCount(usage.outputTokens)}`);
  }
  if (typeof usage.thoughtTokens === "number" && usage.thoughtTokens > 0) {
    parts.push(`thought=${formatCount(usage.thoughtTokens)}`);
  }
  if (
    typeof usage.cachedReadTokens === "number" &&
    usage.cachedReadTokens > 0
  ) {
    parts.push(`cacheRead=${formatCount(usage.cachedReadTokens)}`);
  }
  if (
    typeof usage.cachedWriteTokens === "number" &&
    usage.cachedWriteTokens > 0
  ) {
    parts.push(`cacheWrite=${formatCount(usage.cachedWriteTokens)}`);
  }
  if (
    (typeof usage.contextUsedTokens === "number" && usage.contextUsedTokens > 0) ||
    typeof usage.contextWindowTokens === "number"
  ) {
    parts.push(
      `ctx=${typeof usage.contextUsedTokens === "number" ? formatCount(usage.contextUsedTokens) : "?"}/${typeof usage.contextWindowTokens === "number" ? formatCount(usage.contextWindowTokens) : "?"}`,
    );
  }
  if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) {
    parts.push(`total=${formatCount(usage.totalTokens)}`);
  }
  if (typeof usage.costUsd === "number" && usage.costUsd > 0) {
    parts.push(`cost=$${formatUsd(usage.costUsd)}`);
  }

  return parts.length > 0
    ? parts.join(" | ")
    : undefined;
}

function formatEventDetail(event: AcpRuntimeTurnEvent): string {
  switch (event.type) {
    case AcpRuntimeTurnEventType.Queued:
      return `position=${event.position} | id=${event.turnId}`;
    case AcpRuntimeTurnEventType.Started:
      return `id=${event.turnId}`;
    case AcpRuntimeTurnEventType.Thinking:
      return event.text;
    case AcpRuntimeTurnEventType.Text:
      return event.text;
    case AcpRuntimeTurnEventType.MetadataUpdated:
      return summarizeMetadata(event.metadata as Record<string, unknown>);
    case AcpRuntimeTurnEventType.UsageUpdated:
      return formatUsage(event.usage) ?? "";
    case AcpRuntimeTurnEventType.PermissionRequested:
      return `需要权限(${event.request.kind}): ${shortenForTerminal(event.request.title, 96)}`;
    case AcpRuntimeTurnEventType.PermissionResolved:
      return `权限${event.decision === "allowed" ? "已允许" : "已拒绝"}(${event.request.kind}): ${shortenForTerminal(event.request.title, 96)}`;
    case AcpRuntimeTurnEventType.PlanUpdated:
      return JSON.stringify(event.plan);
    case AcpRuntimeTurnEventType.OperationStarted:
      return formatOperationInline(event.operation, "started");
    case AcpRuntimeTurnEventType.OperationUpdated:
      return formatOperationInline(event.operation, "updated");
    case AcpRuntimeTurnEventType.OperationCompleted:
      return formatOperationInline(event.operation, "completed");
    case AcpRuntimeTurnEventType.OperationFailed:
      return formatOperationInline(
        event.operation,
        "failed",
        event.error.message,
      );
    case AcpRuntimeTurnEventType.Cancelled:
      return event.error.message;
    case AcpRuntimeTurnEventType.Coalesced:
      return `${event.error.message} | into=${event.intoTurnId}`;
    case AcpRuntimeTurnEventType.Withdrawn:
      return event.error.message;
    case AcpRuntimeTurnEventType.Failed:
      return event.error.message;
    case AcpRuntimeTurnEventType.Completed:
      return event.outputText.length > 0
        ? `completed | outputChars=${event.outputText.length}`
        : "completed";
    default:
      return "<unknown>";
  }
}

function createFilesystemHandlers(): AcpRuntimeAuthorityHandlers["filesystem"] {
  return {
    async readTextFile(path) {
      const { readFile } = await import("node:fs/promises");
      return readFile(path, "utf8");
    },
    async writeTextFile(entry) {
      await mkdir(dirname(entry.path), { recursive: true });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(entry.path, entry.content, "utf8");
    },
  };
}

function createTimelineRenderer(
  outputGate: OutputGate,
): TimelineRenderer {
  let turnNumber = 0;
  function createScopedTurnRenderer(
    currentTurnNumber?: number,
    prompt?: string,
  ): TurnRenderer {
    let turnStartedAt = Date.now();
    const stream: StreamAccumulator = { buffer: "" };
    const eventProjection = createTurnEventProjection();

    function writeLine(label: string, detail: string): void {
      const clock = formatClock(new Date());
      const elapsed = formatElapsed(turnStartedAt);
      const body = detail
        .split("\n")
        .map((line, index) =>
          index === 0 ? line : `${" ".repeat(label.length + 2)}${line}`,
        )
        .join("\n");
      outputGate.print(`${clock}  ${elapsed}  ${label}  ${body}`);
    }

    function flushStream(): void {
      if (!stream.type || stream.buffer.length === 0) {
        return;
      }

      const label = stream.type;
      const content =
        stream.type === "text"
          ? renderMarkdownForTerminal(stream.buffer)
          : shortenForTerminal(stream.buffer, 240);
      writeLine(label, content);
      stream.type = undefined;
      stream.buffer = "";
    }

    function shouldFlushStream(type: StreamChunkType, chunk: string): boolean {
      if (type === "thinking") {
        return /[\n。！？!?]/.test(chunk) || stream.buffer.length >= 160;
      }

      return /(?:\n\n|\n|[。！？!?]$)/.test(chunk) || stream.buffer.length >= 220;
    }

    if (typeof prompt === "string" && typeof currentTurnNumber === "number") {
      turnStartedAt = Date.now();
      eventProjection.nextTurn();
      outputGate.print("");
      outputGate.print(`=== turn ${currentTurnNumber} ===`);
    }

    return {
      flush(): void {
        flushStream();
      },
      writeEvent(event): void {
        const instruction = eventProjection.project(event);
        if (instruction.kind === "stream") {
          const type = instruction.streamType;
          if (stream.type && stream.type !== type) {
            flushStream();
          }
          stream.type = type;
          stream.buffer += instruction.text;
          if (shouldFlushStream(type, instruction.text)) {
            flushStream();
          }
          return;
        }

        flushStream();
        if (instruction.kind === "skip") {
          return;
        }
        writeLine(instruction.label, instruction.detail);
      },
      writeLine,
    };
  }

  const standaloneRenderer = createScopedTurnRenderer();

  return {
    createTurn(prompt: string): TurnRenderer {
      turnNumber += 1;
      return createScopedTurnRenderer(turnNumber, prompt);
    },
    flush(): void {
      standaloneRenderer.flush();
    },
    writeEvent(event): void {
      standaloneRenderer.writeEvent(event);
    },
    writeLine(label: string, detail: string): void {
      standaloneRenderer.writeLine(label, detail);
    },
  };
}

function createTurnEventProjection(): TurnEventProjection {
  const operationDetails = new Map<string, string>();

  return {
    nextTurn(): void {
      operationDetails.clear();
    },
    project(event): TurnEventProjectionInstruction {
      if (event.type === AcpRuntimeTurnEventType.Thinking) {
        return {
          kind: "stream",
          streamType: "thinking",
          text: event.text,
        };
      }

      if (event.type === AcpRuntimeTurnEventType.Text) {
        return {
          kind: "stream",
          streamType: "text",
          text: event.text,
        };
      }

      if (event.type === AcpRuntimeTurnEventType.Queued) {
        return {
          detail: formatEventDetail(event),
          kind: "line",
          label: "queued",
        };
      }

      if (event.type === AcpRuntimeTurnEventType.Coalesced) {
        return {
          detail: formatEventDetail(event),
          kind: "line",
          label: "coalesced",
        };
      }

      if (event.type === AcpRuntimeTurnEventType.MetadataUpdated) {
        return { kind: "skip" };
      }

      if (event.type === AcpRuntimeTurnEventType.Started) {
        return {
          detail: formatEventDetail(event),
          kind: "line",
          label: "running",
        };
      }

      if (event.type === AcpRuntimeTurnEventType.UsageUpdated) {
        const detail = formatEventDetail(event);
        if (detail === "") {
          return { kind: "skip" };
        }
        return {
          detail,
          kind: "line",
          label: "usage",
        };
      }

      if (
        event.type === AcpRuntimeTurnEventType.OperationStarted ||
        event.type === AcpRuntimeTurnEventType.OperationUpdated ||
        event.type === AcpRuntimeTurnEventType.OperationCompleted ||
        event.type === AcpRuntimeTurnEventType.OperationFailed
      ) {
        const detail =
          event.type === AcpRuntimeTurnEventType.OperationFailed
            ? `${formatOperationDetail(event.operation)}\nerror=${event.error.message}`
            : formatOperationDetail(event.operation);
        const previous = operationDetails.get(event.operation.id);

        if (
          event.type === AcpRuntimeTurnEventType.OperationUpdated &&
          previous === detail
        ) {
          return { kind: "skip" };
        }

        operationDetails.set(event.operation.id, detail);
        if (
          event.type === AcpRuntimeTurnEventType.OperationCompleted ||
          event.type === AcpRuntimeTurnEventType.OperationFailed
        ) {
          operationDetails.delete(event.operation.id);
        }
        return {
          detail,
          kind: "line",
          label: "tool",
        };
      }

      if (
        event.type === AcpRuntimeTurnEventType.PermissionRequested ||
        event.type === AcpRuntimeTurnEventType.PermissionResolved
      ) {
        return {
          detail: formatEventDetail(event),
          kind: "line",
          label: "permission",
        };
      }

      if (event.type === AcpRuntimeTurnEventType.Completed) {
        return {
          detail: formatEventDetail(event),
          kind: "line",
          label: "done",
        };
      }

      return {
        detail: formatEventDetail(event),
        kind: "line",
        label: event.type,
      };
    },
  };
}

function projectionUpdateToTurnEvent(
  update: AcpRuntimeProjectionUpdate,
): AcpRuntimeTurnEvent {
  switch (update.type) {
    case AcpRuntimeProjectionUpdateType.MetadataUpdated:
      return {
        metadata: update.metadata,
        turnId: update.turnId,
        type: AcpRuntimeTurnEventType.MetadataUpdated,
      };
    case AcpRuntimeProjectionUpdateType.UsageUpdated:
      return {
        turnId: update.turnId,
        type: AcpRuntimeTurnEventType.UsageUpdated,
        usage: update.usage,
      };
    case AcpRuntimeProjectionUpdateType.OperationUpdated:
      if (update.lifecycle === AcpRuntimeOperationProjectionLifecycle.Started) {
        return {
          operation: update.operation,
          turnId: update.turnId,
          type: AcpRuntimeTurnEventType.OperationStarted,
        };
      }
      if (update.lifecycle === AcpRuntimeOperationProjectionLifecycle.Updated) {
        return {
          operation: update.operation,
          turnId: update.turnId,
          type: AcpRuntimeTurnEventType.OperationUpdated,
        };
      }
      if (update.lifecycle === AcpRuntimeOperationProjectionLifecycle.Completed) {
        return {
          operation: update.operation,
          turnId: update.turnId,
          type: AcpRuntimeTurnEventType.OperationCompleted,
        };
      }
      return {
        error: new AcpProtocolError(update.errorMessage ?? "Operation failed."),
        operation: update.operation,
        turnId: update.turnId,
        type: AcpRuntimeTurnEventType.OperationFailed,
      };
    case AcpRuntimeProjectionUpdateType.PermissionUpdated:
      if (
        update.lifecycle === AcpRuntimePermissionProjectionLifecycle.Requested
      ) {
        return {
          operation: update.operation,
          request: update.request,
          turnId: update.turnId,
          type: AcpRuntimeTurnEventType.PermissionRequested,
        };
      }
      return {
        decision: update.decision ?? AcpRuntimePermissionResolution.Denied,
        operation: update.operation,
        request: update.request,
        turnId: update.turnId,
        type: AcpRuntimeTurnEventType.PermissionResolved,
      };
  }
}

function createTurnProjection(
  session: AcpRuntimeSession,
  renderer: TurnRenderer,
): TurnProjection {
  let activeTurnId: string | undefined;
  const seen = new Map<
    string,
    {
      planSignature?: string;
      textLength?: number;
    }
  >();

  const stopWatching = session.state.watch((update) => {
    if (
      update.type !== AcpRuntimeReadModelUpdateType.ThreadEntryAdded &&
      update.type !== AcpRuntimeReadModelUpdateType.ThreadEntryUpdated
    ) {
      return;
    }

    const entry = update.entry;
    if (!entryHasTurnId(entry) || entry.turnId !== activeTurnId) {
      return;
    }

    const previous = seen.get(entry.id);

    if (entry.kind === AcpRuntimeThreadEntryKind.AssistantMessage) {
      const previousLength = previous?.textLength ?? 0;
      const delta = entry.text.slice(previousLength);
      if (delta.length > 0) {
        renderer.writeEvent({
          text: delta,
          turnId: entry.turnId,
          type: AcpRuntimeTurnEventType.Text,
        });
      }
      seen.set(entry.id, {
        textLength: entry.text.length,
      });
      return;
    }

    if (entry.kind === AcpRuntimeThreadEntryKind.AssistantThought) {
      const previousLength = previous?.textLength ?? 0;
      const delta = entry.text.slice(previousLength);
      if (delta.length > 0) {
        renderer.writeEvent({
          text: delta,
          turnId: entry.turnId,
          type: AcpRuntimeTurnEventType.Thinking,
        });
      }
      seen.set(entry.id, {
        textLength: entry.text.length,
      });
      return;
    }

    if (entry.kind === AcpRuntimeThreadEntryKind.Plan) {
      const signature = JSON.stringify(entry.plan);
      if (previous?.planSignature !== signature) {
        renderer.writeEvent({
          plan: entry.plan,
          turnId: entry.turnId,
          type: AcpRuntimeTurnEventType.PlanUpdated,
        });
      }
      seen.set(entry.id, {
        planSignature: signature,
      });
    }
  });

  const stopWatchingProjection = session.state.watch((update) => {
    if (!isProjectionUpdate(update)) {
      return;
    }
    if (update.turnId !== activeTurnId) {
      return;
    }
    renderer.writeEvent(projectionUpdateToTurnEvent(update));
  });

  return {
    bindTurn(turnId: string): void {
      activeTurnId = turnId;
    },
    stop(): void {
      stopWatching();
      stopWatchingProjection();
    },
  };
}

function isProjectionUpdate(
  update: AcpRuntimeStateUpdate,
): update is AcpRuntimeProjectionUpdate {
  return Object.values(AcpRuntimeProjectionUpdateType).includes(
    update.type as AcpRuntimeProjectionUpdate["type"],
  );
}

function entryHasTurnId(
  entry: AcpRuntimeThreadEntry,
): entry is Exclude<
  Readonly<AcpRuntimeThreadEntry>,
  { kind: typeof AcpRuntimeThreadEntryKind.UserMessage }
> {
  return entry.kind !== AcpRuntimeThreadEntryKind.UserMessage;
}

async function promptForPermission(
  inputCoordinator: InputCoordinator,
  logSink: LogSink,
  exitSignal: ExitSignal,
  request: AcpRuntimePermissionRequest,
): Promise<{
  decision: "allow" | "deny";
  scope?: "once" | "session";
}> {
  const scopeHint =
    request.scopeOptions.length > 0
      ? ` [${request.scopeOptions.join("/")}]`
      : "";
  const reasonSuffix = request.reason ? ` | ${request.reason}` : "";

  while (true) {
    const answer = (
      await inputCoordinator.promptExclusive({
        promptText: `permission ${request.kind}${scopeHint}\n${request.title}${reasonSuffix}\nallow? [y]es [n]o [s]ession`,
      })
    )
      .trim()
      .toLowerCase();

    if (answer === "/exit" || answer === "/quit") {
      exitSignal.requested = true;
      logSink.emit({
        attributes: {
          "acp.permission.id": request.id,
          "acp.permission.kind": request.kind,
          "acp.permission.decision": "deny",
          "acp.permission.triggered_by": answer,
        },
        body: request.title,
        eventName: "acp.demo.permission.resolved",
        severityNumber: SeverityNumber.WARN,
      });
      return { decision: "deny" };
    }

    if (answer === "" || answer === "y" || answer === "yes") {
      logSink.emit({
        attributes: {
          "acp.permission.id": request.id,
          "acp.permission.kind": request.kind,
          "acp.permission.decision": "allow",
          "acp.permission.scope": "once",
        },
        body: request.title,
        eventName: "acp.demo.permission.resolved",
      });
      return { decision: "allow", scope: "once" };
    }

    if (
      (answer === "s" || answer === "session") &&
      request.scopeOptions.includes("session")
    ) {
      logSink.emit({
        attributes: {
          "acp.permission.id": request.id,
          "acp.permission.kind": request.kind,
          "acp.permission.decision": "allow",
          "acp.permission.scope": "session",
        },
        body: request.title,
        eventName: "acp.demo.permission.resolved",
      });
      return { decision: "allow", scope: "session" };
    }

    if (answer === "n" || answer === "no") {
      logSink.emit({
        attributes: {
          "acp.permission.id": request.id,
          "acp.permission.kind": request.kind,
          "acp.permission.decision": "deny",
        },
        body: request.title,
        eventName: "acp.demo.permission.resolved",
        severityNumber: SeverityNumber.WARN,
      });
      return { decision: "deny" };
    }

    console.log("Enter y, n, or s.");
  }
}

async function runTurn(
  prompt: string,
  session: AcpRuntimeSession,
  renderer: TimelineRenderer,
  options?: {
    onStarted?: (turnId: string) => void;
    onTerminal?: (turnId: string) => void;
    sendNow?: boolean;
  },
): Promise<void> {
  const turnRenderer = renderer.createTurn(prompt);
  const projection = createTurnProjection(session, turnRenderer);
  const turn = session.turn.start(prompt);
  if (options?.sendNow) {
    await session.turn.queue.sendNow(turn.turnId);
  }
  let startedTurnId: string | undefined;

  try {
    for await (const event of turn.events) {
      if (event.type === AcpRuntimeTurnEventType.Started) {
        startedTurnId = event.turnId;
        options?.onStarted?.(event.turnId);
        projection.bindTurn(event.turnId);
        turnRenderer.writeEvent(event);
        continue;
      }

      if (
        event.type === AcpRuntimeTurnEventType.Thinking ||
        event.type === AcpRuntimeTurnEventType.Text ||
        event.type === AcpRuntimeTurnEventType.PlanUpdated ||
        event.type === AcpRuntimeTurnEventType.OperationStarted ||
        event.type === AcpRuntimeTurnEventType.OperationUpdated ||
        event.type === AcpRuntimeTurnEventType.OperationCompleted ||
        event.type === AcpRuntimeTurnEventType.OperationFailed ||
        event.type === AcpRuntimeTurnEventType.PermissionRequested ||
        event.type === AcpRuntimeTurnEventType.PermissionResolved ||
        event.type === AcpRuntimeTurnEventType.MetadataUpdated ||
        event.type === AcpRuntimeTurnEventType.UsageUpdated
      ) {
        continue;
      }

      turnRenderer.writeEvent(event);
      if (
        event.type === AcpRuntimeTurnEventType.Failed ||
        event.type === AcpRuntimeTurnEventType.Cancelled ||
        event.type === AcpRuntimeTurnEventType.Coalesced ||
        event.type === AcpRuntimeTurnEventType.Withdrawn ||
        event.type === AcpRuntimeTurnEventType.Completed
      ) {
        if (startedTurnId) {
          options?.onTerminal?.(startedTurnId);
        }
        turnRenderer.flush();
        return;
      }
    }
    if (startedTurnId) {
      options?.onTerminal?.(startedTurnId);
    }
    turnRenderer.flush();
  } finally {
    projection.stop();
  }
}

async function runRepl(
  inputCoordinator: InputCoordinator,
  session: AcpRuntimeSession,
  renderer: TimelineRenderer,
  logSink: LogSink,
  exitSignal: ExitSignal,
  label: string,
): Promise<void> {
  console.log("");
  console.log(`Interactive runtime smoke ready for ${label}.`);
  console.log(
    "Commands: /help, /mode, /config, /thread, /diffs, /terminals, /toolcalls, /operations, /permissions, /usage, /metadata, /queue, /queue-policy, /queue-clear, /drop, /cancel, /insert, /slash, /exit",
  );
  const inFlightTurns = new Set<Promise<void>>();
  let activeTurnId: string | undefined;

  const launchTurn = (prompt: string, options?: { sendNow?: boolean }): void => {
    const task = runTurn(prompt, session, renderer, {
      sendNow: options?.sendNow,
      onStarted(turnId) {
        activeTurnId = turnId;
      },
      onTerminal(turnId) {
        if (activeTurnId === turnId) {
          activeTurnId = undefined;
        }
      },
    }).catch((error: unknown) => {
      console.error(formatUnknownError(error));
    });
    inFlightTurns.add(task);
    void task.finally(() => {
      inFlightTurns.delete(task);
    });
  };

  while (true) {
    if (exitSignal.requested) {
      break;
    }

    let prompt: string;
    try {
      prompt = (await inputCoordinator.nextUserInput()).trim();
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        ("code" in error && error.code === "ERR_USE_AFTER_CLOSE")
      ) {
        return;
      }
      if (
        error instanceof Error &&
        error.message === "Input coordinator closed."
      ) {
        return;
      }
      throw error;
    }

    if (prompt === "") {
      continue;
    }

    if (prompt === "/exit" || prompt === "/quit") {
      break;
    }

    if (prompt === "/help") {
      console.log(
        "Use plain text for agent prompts. Local commands: /help, /mode, /config, /thread, /diffs, /terminals, /toolcalls, /operations, /permissions, /usage, /metadata, /queue, /queue-policy, /queue-clear, /drop, /cancel, /insert, /slash, /exit",
      );
      console.log("  /mode                  Show available modes");
      console.log("  /mode <id|name>        Switch current mode");
      console.log("  /config                Show config options");
      console.log("  /config <id|category>  Show one config option");
      console.log("  /config <id> <value>   Set one config option");
      console.log("  /config <id>=<value>   Set one config option");
      console.log("  /config-json           Show raw config option JSON");
      console.log("  /thread                Show structured thread entries");
      console.log("  /diffs                 Show session diff objects");
      console.log("  /terminals             Show terminal objects and output previews");
      console.log("  /toolcalls             Show tool calls with related object counts");
      console.log("  /operations            Show runtime operation objects");
      console.log("  /permissions           Show permission request history");
      console.log("  /usage                 Show latest token/cost usage");
      console.log("  /metadata              Show latest session metadata");
      console.log("  /metadata-json         Show raw session metadata JSON");
      console.log("  /queue                 Show queued turns that have not started yet");
      console.log("  /queue-policy          Show current queue delivery policy");
      console.log("  /queue-policy <value>  Set future queue delivery: sequential | coalesce");
      console.log("  /queue-clear           Remove all queued turns before they start");
      console.log("  /drop <turnId>         Remove one queued turn before it starts");
      console.log("  /cancel                Cancel the currently running turn");
      console.log("  /insert <prompt>       Interrupt the active turn and run this prompt next");
      console.log(
        "  /slash                 Show available agent slash commands",
      );
      console.log("  /slash <name> [args]   Run an agent slash command");
      continue;
    }

    if (prompt === "/mode") {
      console.log(formatAgentModes(session.agent.listModes()));
      continue;
    }

    if (prompt === "/config") {
      console.log(formatConfigOptions(session.agent.listConfigOptions()));
      continue;
    }

    if (prompt === "/config-json") {
      console.log(JSON.stringify(session.agent.listConfigOptions(), null, 2));
      continue;
    }

    if (prompt === "/slash") {
      console.log(
        formatAvailableCommands(session.metadata.availableCommands ?? []),
      );
      continue;
    }

    if (prompt === "/thread") {
      console.log(formatThreadEntries(session));
      continue;
    }

    if (prompt === "/diffs") {
      console.log(formatDiffs(session));
      continue;
    }

    if (prompt === "/terminals") {
      console.log(formatTerminals(session));
      continue;
    }

    if (prompt === "/toolcalls") {
      console.log(formatToolCalls(session));
      continue;
    }

    if (prompt === "/operations") {
      console.log(formatOperations(session));
      continue;
    }

    if (prompt === "/permissions") {
      console.log(formatPermissions(session));
      continue;
    }

    if (prompt === "/usage") {
      console.log(formatUsageSnapshot(session));
      continue;
    }

    if (prompt === "/metadata") {
      console.log(formatMetadataSnapshot(session));
      continue;
    }

    if (prompt === "/metadata-json") {
      console.log(JSON.stringify(session.metadata, null, 2));
      continue;
    }

    if (prompt === "/queue") {
      console.log(formatQueuedTurns(session));
      continue;
    }

    if (prompt === "/queue-policy") {
      console.log(`[runtime] queue delivery: ${session.queue.policy().delivery}`);
      continue;
    }

    if (prompt.startsWith("/queue-policy ")) {
      const delivery = prompt.slice("/queue-policy ".length).trim();
      if (delivery !== "sequential" && delivery !== "coalesce") {
        console.log("usage: /queue-policy sequential|coalesce");
        continue;
      }
      const policy = session.queue.setPolicy({ delivery });
      console.log(`[runtime] queue delivery: ${policy.delivery}`);
      continue;
    }

    if (prompt === "/queue-clear") {
      const cleared = session.turn.queue.clear();
      console.log(`[runtime] cleared queued turns: ${cleared}`);
      continue;
    }

    if (prompt === "/cancel") {
      if (!activeTurnId) {
        console.log("[runtime] no active turn to cancel");
        continue;
      }
      const cancelled = await session.turn.cancel(activeTurnId);
      if (!cancelled) {
        console.log(`[runtime] turn ${activeTurnId} is no longer cancellable`);
        continue;
      }
      console.log(`[runtime] cancellation requested for ${activeTurnId}`);
      continue;
    }

    if (prompt.startsWith("/insert ")) {
      const insertPrompt = prompt.slice("/insert ".length).trim();
      if (insertPrompt === "") {
        console.log("usage: /insert <prompt>");
        continue;
      }
      launchTurn(insertPrompt, { sendNow: true });
      continue;
    }

    if (prompt.startsWith("/mode ")) {
      const requestedMode = prompt.slice("/mode ".length).trim();
      const resolvedMode = resolveRuntimeAgentModeId(
        session.agent.listModes(),
        requestedMode,
      );
      if (!resolvedMode.modeId) {
        console.log(
          resolvedMode.error ? `[runtime] ${resolvedMode.error}` : "usage: /mode <id|name>",
        );
        continue;
      }
      const modeId = resolvedMode.modeId;
      try {
        await session.agent.setMode(modeId);
        logSink.emit({
          attributes: {
            "acp.agent.mode": modeId,
            "acp.demo.command.name": "mode",
          },
          body: "Updated current mode.",
          eventName: "acp.demo.local_command",
        });
        console.log(
          `[runtime] current mode: ${session.metadata.currentModeId ?? "<none>"}`,
        );
      } catch (error: unknown) {
        const formatted = formatUnknownError(error);
        logSink.emit({
          attributes: {
            "acp.agent.mode": modeId,
            "acp.agent.mode.requested": requestedMode,
            "acp.demo.command.name": "mode",
          },
          body: formatted,
          eventName: "acp.demo.local_command.failed",
          exception: error,
          severityNumber: SeverityNumber.ERROR,
        });
        console.error(`[runtime] failed to set mode ${requestedMode}`);
        console.error(formatted);
      }
      continue;
    }

    if (prompt.startsWith("/config ")) {
      const args = prompt.slice("/config ".length).trim();
      const { optionId, value } = parseConfigCommandArgs(args);

      if (!optionId) {
        console.log("usage: /config <id|category> [value]");
        continue;
      }

      const resolvedOption = resolveCliConfigOption(
        session.agent.listConfigOptions(),
        optionId,
      );

      if (!resolvedOption.option) {
        console.log(resolvedOption.error);
        continue;
      }
      const option = resolvedOption.option;

      if (value === "") {
        console.log(formatConfigOption(option));
        continue;
      }

      const normalizedValue = normalizeCliConfigValue(option, value);
      if (normalizedValue.error) {
        console.log(normalizedValue.error);
        continue;
      }

      try {
        await session.agent.setConfigOption(
          option.id,
          normalizedValue.value ?? value,
        );
        logSink.emit({
          attributes: {
            "acp.agent.config_id": option.id,
            "acp.demo.command.name": "config_set",
            "acp.agent.config_value": String(normalizedValue.value ?? value),
          },
          body: "Updated config option.",
          eventName: "acp.demo.local_command",
        });
        console.log(
          `[runtime] config ${option.id}=${String(session.metadata.config?.[option.id] ?? normalizedValue.value ?? value)}`,
        );
      } catch (error: unknown) {
        const formatted = formatUnknownError(error);
        logSink.emit({
          attributes: {
            "acp.agent.config_id": option.id,
            "acp.demo.command.name": "config_set",
            "acp.agent.config_value": String(normalizedValue.value ?? value),
          },
          body: formatted,
          eventName: "acp.demo.local_command.failed",
          exception: error,
          severityNumber: SeverityNumber.ERROR,
        });
        console.error(
          `[runtime] failed to set config ${option.id}=${String(
            normalizedValue.value ?? value,
          )}`,
        );
        console.error(formatted);
      }
      continue;
    }

    if (prompt.startsWith("/slash ")) {
      const raw = prompt.slice("/slash ".length).trim();
      const [slashName, ...slashArgs] = raw.split(/\s+/);

      if (!slashName) {
        console.log("usage: /slash <name> [args]");
        continue;
      }

      const available = session.metadata.availableCommands ?? [];
      const command = available.find((entry) => entry.name === slashName);

      if (!command) {
        console.log(`[runtime] unknown slash command: /${slashName}`);
        continue;
      }

      launchTurn(
        `/${slashName}${slashArgs.length > 0 ? ` ${slashArgs.join(" ")}` : ""}`,
      );
      continue;
    }

    if (prompt.startsWith("/drop ")) {
      const rawTurnId = prompt.slice("/drop ".length).trim();
      if (rawTurnId === "") {
        console.log("usage: /drop <turnId>");
        continue;
      }
      const turnId = resolveQueuedTurnId(session, rawTurnId);
      if (!turnId) {
        console.log(`[runtime] queued turn not found: ${rawTurnId}`);
        continue;
      }
      if (!session.turn.queue.remove(turnId)) {
        console.log(`[runtime] failed to drop queued turn: ${turnId}`);
        continue;
      }
      console.log(`[runtime] dropped queued turn: ${turnId}`);
      continue;
    }

    launchTurn(prompt);
  }

  if (inFlightTurns.size > 0) {
    await Promise.allSettled([...inFlightTurns]);
  }
}

async function createRuntimeSmokeConfig(
  agentId: string,
): Promise<RuntimeSmokeConfig> {
  if (!isLocalSimulatorAgent(agentId)) {
    return {
      agentId,
      cleanup: async () => {},
      cwd: cwd(),
      label: agentId,
    };
  }

  const root = await mkdtemp(join(tmpdir(), "acp-runtime-demo-"));
  const projectDir = join(root, "project");
  const readmePath = join(projectDir, "README.md");

  await mkdir(projectDir, { recursive: true });
  await writeFile(readmePath, "hello from runtime stdio smoke\n", "utf8");

  return {
    agentId,
    cleanup: async () => {
      await rm(root, { force: true, recursive: true });
    },
    cwd: projectDir,
    handlers: {
      filesystem: createFilesystemHandlers(),
    },
    label: "simulator",
  };
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv);
  if (options.systemPromptFile) {
    options.systemPrompt = await readFile(options.systemPromptFile, "utf8");
  }
  const logSink = await configureDemoLogSink(options.logFile);
  const outputGate = createOutputGate({
    onLine: (line) => logSink.writeLine(line),
  });
  const renderer = createTimelineRenderer(outputGate);
  const config = await createRuntimeSmokeConfig(options.agentId);
  const runtime = new AcpRuntime(createStdioAcpConnectionFactory(), {
    state: {
      sessionRegistryPath: resolveRuntimeHomePath(
        "state",
        "runtime-session-registry.json",
      ),
    },
  });
  const exitSignal: ExitSignal = { requested: false };
  let session: AcpRuntimeSession | undefined;
  const rl = createInterface({
    input,
    output,
    completer(line) {
      return completeLocalCommand(line, session);
    },
  });
  const inputCoordinator = createInputCoordinator(rl, outputGate);

  if (options.listSessions) {
    const result = await runtime.sessions.list({
      agent: config.agentId,
      cwd: config.cwd,
      handlers: config.handlers,
      source: "remote",
    });
    console.log(formatSessionList(result.sessions));
    await config.cleanup();
    await logSink.close();
    rl.close();
    return;
  }

  const createPermissionHandler =
    () => (request: AcpRuntimePermissionRequest) => {
      logSink.emit({
        attributes: {
          "acp.permission.id": request.id,
          "acp.permission.kind": request.kind,
        },
        body: request.title,
        eventName: "acp.demo.permission.prompted",
      });
      return promptForPermission(
        inputCoordinator,
        logSink,
        exitSignal,
        request,
      );
    };

  const createAuthenticationHandler =
    () =>
    (
      request: Parameters<
        NonNullable<AcpRuntimeAuthorityHandlers["authentication"]>
      >[0],
    ) =>
      promptForDemoAuthentication({
        inputCoordinator,
        logSink,
        renderer,
        request,
        rl,
      });

  if (options.resumeLast) {
    const latest = await runtime.sessions.list({
      agent: config.agentId,
      cwd: config.cwd,
      limit: 1,
      source: "local",
    });
    const latestSessionId = latest.sessions[0]?.id;
    if (!latestSessionId) {
      throw new Error(
        `[runtime] no locally persisted sessions found for ${config.agentId} in ${config.cwd}`,
      );
    }
    session = await runtime.sessions.resume({
      handlers: {
        authentication: createAuthenticationHandler(),
        ...config.handlers,
        permission: createPermissionHandler(),
      },
      initialConfig: options.initialConfig,
      sessionId: latestSessionId,
    });
  } else if (options.resumeSessionId) {
    session = await runtime.sessions.resume({
      agent: config.agentId,
      cwd: config.cwd,
      handlers: {
        authentication: createAuthenticationHandler(),
        ...config.handlers,
        permission: createPermissionHandler(),
      },
      initialConfig: options.initialConfig,
      sessionId: options.resumeSessionId,
    });
  } else if (options.loadSessionId) {
    session = await runtime.sessions.load({
      agent: config.agentId,
      cwd: config.cwd,
      handlers: {
        authentication: createAuthenticationHandler(),
        ...config.handlers,
        permission: createPermissionHandler(),
      },
      initialConfig: options.initialConfig,
      sessionId: options.loadSessionId,
    });
  } else {
    session = await runtime.sessions.start({
      agent: config.agentId,
      cwd: config.cwd,
      handlers: {
        authentication: createAuthenticationHandler(),
        ...config.handlers,
        permission: createPermissionHandler(),
      },
      initialConfig: options.initialConfig,
      systemPrompt: options.systemPrompt,
    });
  }

  await logSink.attachSession(session.metadata.id);
  const initialConfigReport = formatInitialConfigReport(
    session.initialConfigReport,
    session.agent.listConfigOptions(),
  );
  if (initialConfigReport) {
    console.log(initialConfigReport);
    logSink.emit({
      attributes: {
        "acp.demo.initial_config.ok": Boolean(
          session.initialConfigReport?.ok,
        ),
        "acp.demo.initial_config.items":
          session.initialConfigReport?.items.length ?? 0,
      },
      body: initialConfigReport,
      eventName: "acp.demo.initial_config",
      severityNumber: session.initialConfigReport?.ok
        ? SeverityNumber.INFO
        : SeverityNumber.WARN,
    });
  }
  logSink.emit({
    attributes: {
      "acp.agent.id": config.agentId,
      "acp.agent.type": session.snapshot().agent.type,
      "acp.demo.label": config.label,
      "acp.session.id": session.metadata.id,
      "acp.session.cwd": config.cwd,
    },
    body: "Demo session ready.",
    eventName: "acp.demo.session.ready",
  });

  console.log("[runtime] session created");
  console.log(`[runtime] sessionId: ${session.metadata.id}`);
  console.log(`[runtime] agentId: ${config.agentId}`);
  console.log(`[runtime] label: ${config.label}`);
  console.log(
    `[runtime] agentType: ${session.snapshot().agent.type ?? "<none>"}`,
  );
  console.log(`[runtime] cwd: ${config.cwd}`);
  if (process.platform === "win32" && config.agentId === "codex-acp") {
    console.log("[runtime] warning: Codex on Windows works best under WSL2.");
  }

  if (options.loadSessionId) {
    const historyEntries = session.state.history.drain();
    if (historyEntries.length > 0) {
      console.log("");
      console.log("[runtime] loaded history replay");
      renderHistoryEntries(historyEntries, renderer);
    }
  }

  try {
    if (options.initialPrompt) {
      await runTurn(options.initialPrompt, session, renderer);
    }

    if (input.isTTY) {
      await runRepl(
        inputCoordinator,
        session,
        renderer,
        logSink,
        exitSignal,
        config.label,
      );
    } else if (!options.initialPrompt) {
      console.log(
        "[runtime] stdin is not a TTY; pass an initial prompt as argv to run a single turn.",
      );
    }
  } finally {
    inputCoordinator.close();
    rl.close();
    await session.close().catch(() => undefined);
    await config.cleanup();
    await logSink.close();
  }
}

void main().catch((error: unknown) => {
  console.error(formatUnknownError(error));
  process.exitCode = getErrorExitCode(error) ?? 1;
});
