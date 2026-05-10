import {
  resolveRuntimeAgentId,
  resolveRuntimeHomePath,
  type AcpRuntimeInitialConfig,
} from "../index.js";

export type RuntimeCliOptions = {
  agentId?: string;
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

const DEFAULT_LOG_FILE = resolveRuntimeHomePath("logs", "runtime.log");

function resolveAgentId(inputAgent: string | undefined): string {
  if (!inputAgent) {
    return resolveRuntimeAgentId("simulator");
  }
  return resolveRuntimeAgentId(inputAgent);
}

export function parseCliOptions(argv: string[]): RuntimeCliOptions {
  const cliArgs = argv.slice(2);
  if (cliArgs[0] === "--") {
    cliArgs.shift();
  }
  const rawAgent = cliArgs[0]?.startsWith("--") ? undefined : cliArgs[0];
  const agentId = rawAgent ? resolveAgentId(rawAgent) : undefined;
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

  for (const token of cliArgs.slice(rawAgent ? 1 : 0)) {
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
    agentId:
      agentId ??
      (loadSessionId || resumeLast || resumeSessionId || listSessions
        ? undefined
        : resolveAgentId(undefined)),
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
  if (!input.mode && !input.model && !input.effort && !input.strict) {
    return undefined;
  }
  return {
    mode: input.mode,
    model: input.model,
    effort: input.effort,
    strict: input.strict,
  };
}
