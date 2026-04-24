import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { cwd, stdin as input, stdout as output } from "node:process";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { createWriteStream } from "node:fs";

import {
  AcpRuntime,
  createStdioAcpConnectionFactory,
  type AcpRuntimeAuthorityHandlers,
  type AcpRuntimeOperation,
  type AcpRuntimePermissionRequest,
  type AcpRuntimeTurnEvent,
} from "@saaskit-dev/acp-runtime";

type TimelineRenderer = {
  flush(): void;
  nextTurn(prompt: string): void;
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
  initialPrompt: string;
  logFile?: string;
};

type LogSink = {
  rawLogFile?: string;
  writeJson(record: unknown): void;
  close(): Promise<void>;
};

type ExitSignal = {
  requested: boolean;
};

type OutputGate = {
  flush(): void;
  pause(): void;
  print(line: string): void;
  resume(): void;
};

type StreamChunkType = "text" | "thinking";

type StreamAccumulator = {
  buffer: string;
  type?: StreamChunkType;
};

const AGENT_ALIASES: Record<string, string> = {
  claude: "claude-acp",
  codex: "codex-acp",
  simulator: "simulator-agent-acp-local",
};

const LOCAL_COMMANDS = [
  "/help",
  "/snapshot",
  "/mode",
  "/config",
  "/slash",
  "/exit",
] as const;

function resolveAgentId(inputAgent: string | undefined): string {
  if (!inputAgent) {
    return AGENT_ALIASES.simulator;
  }
  return AGENT_ALIASES[inputAgent] ?? inputAgent;
}

function isLocalSimulatorAgent(agentId: string): boolean {
  return agentId === "simulator-agent-acp-local";
}

function parseCliOptions(argv: string[]): DemoCliOptions {
  const rawAgent = argv[2];
  const agentId = resolveAgentId(rawAgent);
  const promptTokens: string[] = [];
  let logFile = process.env.ACP_RUNTIME_LOG_FILE?.trim() || undefined;

  for (const token of argv.slice(rawAgent ? 3 : 2)) {
    if (token.startsWith("--log-file=")) {
      logFile = token.slice("--log-file=".length) || undefined;
      continue;
    }
    if (token.startsWith("--log=")) {
      logFile = token.slice("--log=".length) || undefined;
      continue;
    }
    promptTokens.push(token);
  }

  return {
    agentId,
    initialPrompt: promptTokens.join(" "),
    logFile,
  };
}

async function configureLogFile(logFile: string | undefined): Promise<LogSink> {
  if (!logFile) {
    return {
      writeJson() {},
      async close() {},
    };
  }

  await mkdir(dirname(logFile), { recursive: true });
  const rawLogFile = `${logFile}.jsonl`;
  const stream = createWriteStream(logFile, { flags: "a" });
  const rawStream = createWriteStream(rawLogFile, { flags: "a" });
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);

  const writeToLog = (line: string): void => {
    stream.write(`${line}\n`);
  };
  const writeJson = (record: unknown): void => {
    rawStream.write(`${JSON.stringify(record)}\n`);
  };

  console.log = (...args: unknown[]) => {
    originalLog(...args);
    writeToLog(args.map((arg) => String(arg)).join(" "));
  };

  console.error = (...args: unknown[]) => {
    originalError(...args);
    writeToLog(args.map((arg) => String(arg)).join(" "));
  };

  originalLog(`[runtime] log file: ${logFile}`);
  originalLog(`[runtime] raw log file: ${rawLogFile}`);
  writeToLog(`[runtime] log file: ${logFile}`);
  writeToLog(`[runtime] raw log file: ${rawLogFile}`);

  return {
    rawLogFile,
    writeJson,
    async close() {
      console.log = originalLog;
      console.error = originalError;
      await new Promise<void>((resolve, reject) => {
        stream.end((error?: Error | null) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await new Promise<void>((resolve, reject) => {
        rawStream.end((error?: Error | null) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function createOutputGate(): OutputGate {
  let paused = false;
  const buffered: string[] = [];

  return {
    flush() {
      while (buffered.length > 0) {
        console.log(buffered.shift()!);
      }
    },
    pause() {
      paused = true;
    },
    print(line: string) {
      if (paused) {
        buffered.push(line);
        return;
      }
      console.log(line);
    },
    resume() {
      paused = false;
      this.flush();
    },
  };
}

function completeLocalCommand(
  line: string,
  session?: Awaited<ReturnType<AcpRuntime["createFromRegistry"]>>,
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
    const modes = session?.listAgentModes().map((mode) => mode.id) ?? [];
    const current = trailingSpace ? "" : (parts[1] ?? "");
    const matches = modes.filter((mode) => mode.startsWith(current));
    return [matches.length > 0 ? matches : modes, current];
  }

  if (parts[0] === "/config") {
    const options = session?.listAgentConfigOptions() ?? [];
    const optionIds = options.map((option) => option.id);

    if (parts.length === 2 && !trailingSpace) {
      const current = parts[1] ?? "";
      const matches = optionIds.filter((id) => id.startsWith(current));
      return [matches.length > 0 ? matches : optionIds, current];
    }

    if (parts.length === 2 && trailingSpace) {
      return [optionIds, ""];
    }

    const optionId = parts[1];
    const option = options.find((entry) => entry.id === optionId);
    const values = option?.options?.map((entry) => String(entry.value)) ?? [];
    const current = trailingSpace ? "" : (parts[2] ?? "");
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
    (part) => part.type === "json" && part.value && typeof part.value === "object",
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

  if (operation.kind === "write_file" && jsonValue) {
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

  if (operation.kind === "read_file") {
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

  if (operation.kind === "execute_command") {
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
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
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
  metadata: NonNullable<AcpRuntimeTurnEvent["type"] extends never ? never : Record<string, unknown>>,
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
  if (sessionMetadata.config && Object.keys(sessionMetadata.config).length > 0) {
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

function formatEventDetail(event: AcpRuntimeTurnEvent): string {
  switch (event.type) {
    case "queued":
      return `position=${event.position}`;
    case "started":
      return "turn started";
    case "thinking":
      return event.text;
    case "text":
      return event.text;
    case "metadata_updated":
      return summarizeMetadata(event.metadata as Record<string, unknown>);
    case "usage_updated":
      return JSON.stringify(event.usage);
    case "permission_requested":
      return `${event.request.kind} | ${event.request.title}`;
    case "permission_resolved":
      return `${event.decision} | ${event.request.title}`;
    case "plan_updated":
      return JSON.stringify(event.plan);
    case "operation_started":
      return formatOperationDetail(event.operation);
    case "operation_updated":
      return formatOperationDetail(event.operation);
    case "operation_completed":
      return formatOperationDetail(event.operation);
    case "operation_failed":
      return `${formatOperationDetail(event.operation)}\nerror=${event.error.message}`;
    case "failed":
      return event.error.message;
    case "completed":
      return event.outputText
        ? renderMarkdownForTerminal(event.outputText)
        : "turn completed";
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

function createTimelineRenderer(logSink: LogSink, outputGate: OutputGate): TimelineRenderer {
  let turnNumber = 0;
  let turnStartedAt = Date.now();
  const stream: StreamAccumulator = { buffer: "" };
  const operationDetails = new Map<string, string>();
  let lastMetadataSummary: string | undefined;

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
      return (
        /[\n。！？!?]/.test(chunk) ||
        stream.buffer.length >= 160
      );
    }

    return /(?:\n\n|\n|[。！？!?]$)/.test(chunk) || stream.buffer.length >= 220;
  }

  return {
    flush(): void {
      flushStream();
    },
    nextTurn(prompt: string): void {
      flushStream();
      turnNumber += 1;
      turnStartedAt = Date.now();
      operationDetails.clear();
      lastMetadataSummary = undefined;
      logSink.writeJson({
        prompt,
        recordType: "turn_prompt",
        timestamp: new Date().toISOString(),
        turnNumber,
      });
      console.log("");
      console.log(`=== turn ${turnNumber} ===`);
      writeLine("user", prompt);
    },
    writeEvent(event): void {
      logSink.writeJson({
        event,
        recordType: "turn_event",
        timestamp: new Date().toISOString(),
      });

      if (event.type === "thinking" || event.type === "text") {
        const type = event.type;
        if (stream.type && stream.type !== type) {
          flushStream();
        }
        stream.type = type;
        stream.buffer += event.text;
        if (shouldFlushStream(type, event.text)) {
          flushStream();
        }
        return;
      }

      flushStream();

      if (event.type === "metadata_updated") {
        const summary = formatEventDetail(event);
        if (summary === lastMetadataSummary) {
          return;
        }
        lastMetadataSummary = summary;
        writeLine(event.type, summary);
        return;
      }

      if (
        event.type === "operation_started" ||
        event.type === "operation_updated" ||
        event.type === "operation_completed" ||
        event.type === "operation_failed"
      ) {
        const detail =
          event.type === "operation_failed"
            ? `${formatOperationDetail(event.operation)}\nerror=${event.error.message}`
            : formatOperationDetail(event.operation);
        const previous = operationDetails.get(event.operation.id);

        if (event.type === "operation_updated" && previous === detail) {
          return;
        }

        operationDetails.set(event.operation.id, detail);
        writeLine(event.type, detail);

        if (
          event.type === "operation_completed" ||
          event.type === "operation_failed"
        ) {
          operationDetails.delete(event.operation.id);
        }
        return;
      }

      writeLine(event.type, formatEventDetail(event));
    },
    writeLine,
  };
}

async function promptForPermission(
  rl: Interface,
  renderer: TimelineRenderer,
  logSink: LogSink,
  exitSignal: ExitSignal,
  outputGate: OutputGate,
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
    outputGate.pause();
    const answer = (
      await rl.question(
        `permission ${request.kind}${scopeHint}\n${request.title}${reasonSuffix}\nallow? [y]es [n]o [s]ession\n> `,
      )
    )
      .trim()
      .toLowerCase();
    outputGate.resume();

    if (answer === "/exit" || answer === "/quit") {
      exitSignal.requested = true;
      logSink.writeJson({
        decision: { decision: "deny" },
        recordType: "permission_decision",
        request,
        timestamp: new Date().toISOString(),
        triggeredBy: answer,
      });
      renderer.writeLine("permission", "decision=deny requested exit");
      return { decision: "deny" };
    }

    if (answer === "" || answer === "y" || answer === "yes") {
      logSink.writeJson({
        decision: { decision: "allow", scope: "once" },
        recordType: "permission_decision",
        request,
        timestamp: new Date().toISOString(),
      });
      renderer.writeLine("permission", "decision=allow scope=once");
      return { decision: "allow", scope: "once" };
    }

    if (
      (answer === "s" || answer === "session") &&
      request.scopeOptions.includes("session")
    ) {
      logSink.writeJson({
        decision: { decision: "allow", scope: "session" },
        recordType: "permission_decision",
        request,
        timestamp: new Date().toISOString(),
      });
      renderer.writeLine("permission", "decision=allow scope=session");
      return { decision: "allow", scope: "session" };
    }

    if (answer === "n" || answer === "no") {
      logSink.writeJson({
        decision: { decision: "deny" },
        recordType: "permission_decision",
        request,
        timestamp: new Date().toISOString(),
      });
      renderer.writeLine("permission", "decision=deny");
      return { decision: "deny" };
    }

    console.log("Enter y, n, or s.");
  }
}

async function runTurn(
  prompt: string,
  session: Awaited<ReturnType<AcpRuntime["createFromRegistry"]>>,
  renderer: TimelineRenderer,
): Promise<void> {
  renderer.nextTurn(prompt);

  for await (const event of session.stream(prompt)) {
    renderer.writeEvent(event);
    if (event.type === "failed") {
      renderer.flush();
      return;
    }
  }
  renderer.flush();
}

async function runRepl(
  rl: Interface,
  session: Awaited<ReturnType<AcpRuntime["createFromRegistry"]>>,
  renderer: TimelineRenderer,
  logSink: LogSink,
  exitSignal: ExitSignal,
  label: string,
): Promise<void> {
  console.log("");
  console.log(`Interactive runtime smoke ready for ${label}.`);
  console.log("Commands: /help, /snapshot, /mode, /config, /slash, /exit");

  while (true) {
    if (exitSignal.requested) {
      break;
    }

    let prompt: string;
    try {
      prompt = (await rl.question("you> ")).trim();
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ERR_USE_AFTER_CLOSE"
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
        "Use plain text for agent prompts. Local commands: /help, /snapshot, /mode, /config, /slash, /exit",
      );
      console.log("  /mode                  Show available modes");
      console.log("  /mode <id>             Switch current mode");
      console.log("  /config                Show config options");
      console.log("  /config <id>           Show one config option");
      console.log("  /config <id> <value>   Set one config option");
      console.log(
        "  /slash                 Show available agent slash commands",
      );
      console.log("  /slash <name> [args]   Run an agent slash command");
      continue;
    }

    if (prompt === "/snapshot") {
      console.log(JSON.stringify(session.snapshot(), null, 2));
      continue;
    }

    if (prompt === "/mode") {
      console.log(JSON.stringify(session.listAgentModes(), null, 2));
      continue;
    }

    if (prompt === "/config") {
      console.log(JSON.stringify(session.listAgentConfigOptions(), null, 2));
      continue;
    }

    if (prompt === "/slash") {
      console.log(
        formatAvailableCommands(session.metadata.availableCommands ?? []),
      );
      continue;
    }

    if (prompt.startsWith("/mode ")) {
      const modeId = prompt.slice("/mode ".length).trim();
      if (modeId === "") {
        console.log("usage: /mode <id>");
        continue;
      }
      try {
        await session.setAgentMode(modeId);
        logSink.writeJson({
          modeId,
          recordType: "local_command",
          subcommand: "mode",
          timestamp: new Date().toISOString(),
        });
        console.log(
          `[runtime] current mode: ${session.metadata.currentModeId ?? "<none>"}`,
        );
      } catch (error: unknown) {
        const formatted = formatUnknownError(error);
        logSink.writeJson({
          error,
          modeId,
          recordType: "local_command_error",
          subcommand: "mode",
          timestamp: new Date().toISOString(),
        });
        console.error(`[runtime] failed to set mode ${modeId}`);
        console.error(formatted);
      }
      continue;
    }

    if (prompt.startsWith("/config ")) {
      const args = prompt.slice("/config ".length).trim();
      const [optionId, ...valueParts] = args.split(/\s+/);
      const value = valueParts.join(" ").trim();

      if (!optionId) {
        console.log("usage: /config <id> [value]");
        continue;
      }

      const option = session
        .listAgentConfigOptions()
        .find((entry) => entry.id === optionId);

      if (!option) {
        console.log(`[runtime] unknown config option: ${optionId}`);
        continue;
      }

      if (value === "") {
        console.log(JSON.stringify(option, null, 2));
        continue;
      }

      try {
        await session.setAgentConfigOption(optionId, value);
        logSink.writeJson({
          optionId,
          recordType: "local_command",
          subcommand: "config_set",
          timestamp: new Date().toISOString(),
          value,
        });
        console.log(
          `[runtime] config ${optionId}=${String(session.metadata.config?.[optionId] ?? value)}`,
        );
      } catch (error: unknown) {
        const formatted = formatUnknownError(error);
        logSink.writeJson({
          error,
          optionId,
          recordType: "local_command_error",
          subcommand: "config_set",
          timestamp: new Date().toISOString(),
          value,
        });
        console.error(`[runtime] failed to set config ${optionId}=${value}`);
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

      await runTurn(
        `/${slashName}${slashArgs.length > 0 ? ` ${slashArgs.join(" ")}` : ""}`,
        session,
        renderer,
      );
      continue;
    }

    await runTurn(prompt, session, renderer);
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
  const runtime = new AcpRuntime(createStdioAcpConnectionFactory());
  const logSink = await configureLogFile(options.logFile);
  const outputGate = createOutputGate();
  const renderer = createTimelineRenderer(logSink, outputGate);
  const config = await createRuntimeSmokeConfig(options.agentId);
  const exitSignal: ExitSignal = { requested: false };
  let session:
    | Awaited<ReturnType<AcpRuntime["createFromRegistry"]>>
    | undefined;
  const rl = createInterface({
    input,
    output,
    completer(line) {
      return completeLocalCommand(line, session);
    },
  });

  session = await runtime.createFromRegistry({
    agentId: config.agentId,
    cwd: config.cwd,
    handlers: {
      ...config.handlers,
      permission(request) {
        logSink.writeJson({
          recordType: "permission_request",
          request,
          timestamp: new Date().toISOString(),
        });
        return promptForPermission(
          rl,
          renderer,
          logSink,
          exitSignal,
          outputGate,
          request,
        );
      },
    },
  });

  logSink.writeJson({
    agentId: config.agentId,
    label: config.label,
    logFile: options.logFile,
    rawLogFile: logSink.rawLogFile,
    recordType: "session_created",
    sessionMetadata: session.metadata,
    snapshot: session.snapshot(),
    timestamp: new Date().toISOString(),
  });

  console.log("[runtime] session created");
  console.log(`[runtime] sessionId: ${session.metadata.id}`);
  console.log(`[runtime] agentId: ${config.agentId}`);
  console.log(`[runtime] label: ${config.label}`);
  console.log(
    `[runtime] agentType: ${session.snapshot().agent.type ?? "<none>"}`,
  );
  console.log(`[runtime] cwd: ${config.cwd}`);

  try {
    if (options.initialPrompt) {
      await runTurn(options.initialPrompt, session, renderer);
    }

    if (input.isTTY) {
      await runRepl(rl, session, renderer, logSink, exitSignal, config.label);
    } else if (!options.initialPrompt) {
      console.log(
        "[runtime] stdin is not a TTY; pass an initial prompt as argv to run a single turn.",
      );
    }
  } finally {
    rl.close();
    await session.close().catch(() => undefined);
    await config.cleanup();
    await logSink.close();
  }
}

void main().catch((error: unknown) => {
  console.error(formatUnknownError(error));
  process.exitCode = 1;
});
