import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Writable, Readable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import type {
  AuthenticateResponse,
  CancelNotification,
  ClientCapabilities,
  CreateTerminalRequest,
  CreateTerminalResponse,
  ForkSessionResponse,
  InitializeResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  NewSessionResponse,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionResponse,
  SessionNotification,
  SetSessionConfigOptionResponse,
  SetSessionModeResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
} from "@agentclientprotocol/sdk";

import { resolveAgentLaunch } from "./agent-registry.js";
import type { AgentLaunchConfig } from "./agent-registry.js";
import type {
  HarnessAgentDefinition,
  HarnessCase,
  HarnessFailureStatus,
  HarnessProbeProfile,
  HarnessSummary,
  TranscriptEntry,
} from "./types.js";
import type { HarnessCaseExecutor } from "./run-case.js";

type PermissionDecisionQueue = Array<"allow" | "deny">;
const STEP_TIMEOUT_MS = 30_000;

type HarnessTerminalState = {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  output: string;
  exitCode: number | null;
  waitMs: number;
  createdAt: number;
  killed: boolean;
};

type RuntimeClientState = {
  sessionId?: string;
  lastListedSessions?: ListSessionsResponse["sessions"];
  availableModes?: NonNullable<NewSessionResponse["modes"]>["availableModes"];
  currentModeId?: string;
  configOptions?: NonNullable<NewSessionResponse["configOptions"]>;
  promptPromise?: Promise<PromptResponse>;
  promptCompleted: boolean;
  pendingPermissionDecisions: PermissionDecisionQueue;
  pendingSessionUpdates: SessionNotification[];
  availableAuthMethods?: InitializeResponse["authMethods"];
  lastSessionUpdateAt?: number;
  summaryPatch: Partial<HarnessSummary>;
  virtualFiles: Map<string, string>;
  terminals: Map<string, HarnessTerminalState>;
  nextTerminalId: number;
};

function mergeSummaryPatch(
  state: RuntimeClientState,
  patch: Partial<HarnessSummary>,
): void {
  state.summaryPatch = {
    ...state.summaryPatch,
    ...patch,
    protocolCoverage: {
      ...state.summaryPatch.protocolCoverage,
      ...patch.protocolCoverage,
    },
    scenarioResults: {
      ...state.summaryPatch.scenarioResults,
      ...patch.scenarioResults,
    },
    discovery: {
      ...state.summaryPatch.discovery,
      ...patch.discovery,
      initialize: {
        ...state.summaryPatch.discovery?.initialize,
        ...patch.discovery?.initialize,
      },
      session: {
        ...state.summaryPatch.discovery?.session,
        ...patch.discovery?.session,
      },
      auth: {
        ...state.summaryPatch.discovery?.auth,
        ...patch.discovery?.auth,
      },
      plan: {
        ...state.summaryPatch.discovery?.plan,
        ...patch.discovery?.plan,
      },
      commands: {
        ...state.summaryPatch.discovery?.commands,
        ...patch.discovery?.commands,
      },
      mode: {
        ...state.summaryPatch.discovery?.mode,
        ...patch.discovery?.mode,
      },
    },
  };
}

function recordSessionUpdateSummary(state: RuntimeClientState, notification: SessionNotification): void {
  const update = notification.update;

  switch (update.sessionUpdate) {
    case "plan":
      mergeSummaryPatch(state, {
        discovery: {
          plan: {
            entries: update.entries.map((entry) => ({
              content: entry.content,
              priority: entry.priority,
              status: entry.status,
            })),
          },
        },
      });
      return;
    case "available_commands_update":
      mergeSummaryPatch(state, {
        discovery: {
          commands: {
            available: update.availableCommands.map((command) => ({
              name: command.name,
              description: command.description,
              inputHint: command.input?.hint ?? undefined,
            })),
          },
        },
      });
      return;
    case "current_mode_update":
      state.currentModeId = update.currentModeId;
      mergeSummaryPatch(state, {
        discovery: {
          mode: {
            currentModeId: update.currentModeId,
          },
        },
      });
      return;
    case "config_option_update":
      state.configOptions = update.configOptions;
      return;
    default:
      return;
  }
}

export function resolvePermissionDecisionResponse(
  decision: "allow" | "deny",
  options: RequestPermissionRequest["options"],
): RequestPermissionResponse {
  if (decision === "allow") {
    const firstOption = options[0];
    if (!firstOption) {
      throw new Error("Permission request has no selectable options");
    }

    return {
      outcome: {
        outcome: "selected",
        optionId: firstOption.optionId,
      },
    };
  }

  const rejectOption = options.find((option) => option.kind === "reject_once" || option.kind === "reject_always");
  if (rejectOption) {
    return {
      outcome: {
        outcome: "selected",
        optionId: rejectOption.optionId,
      },
    };
  }

  return {
    outcome: {
      outcome: "cancelled",
    },
  };
}

class HarnessClient implements acp.Client {
  readonly state: RuntimeClientState;
  readonly emitWireEntry: (
    entry: Omit<TranscriptEntry, "timestamp" | "kind"> & { kind?: TranscriptEntry["kind"] },
  ) => void;

  constructor(
    state: RuntimeClientState,
    emitWireEntry: (
      entry: Omit<TranscriptEntry, "timestamp" | "kind"> & { kind?: TranscriptEntry["kind"] },
    ) => void,
  ) {
    this.state = state;
    this.emitWireEntry = emitWireEntry;
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.emitWireEntry({
      direction: "inbound",
      type: "permission-request",
      method: "session/request_permission",
      sessionId: params.sessionId,
      payload: params,
    });

    const next = this.state.pendingPermissionDecisions.shift() ?? "deny";
    const response = resolvePermissionDecisionResponse(next, params.options);

    this.emitWireEntry({
      direction: "outbound",
      type: "permission-decision",
      method: "session/request_permission",
      sessionId: params.sessionId,
      payload: response,
    });

    return response;
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.state.pendingSessionUpdates.push(params);
    this.state.lastSessionUpdateAt = Date.now();
    recordSessionUpdateSummary(this.state, params);
    this.emitWireEntry({
      direction: "inbound",
      type: params.update.sessionUpdate,
      method: "session/update",
      sessionId: params.sessionId,
      payload: params,
    });
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    this.emitWireEntry({
      direction: "inbound",
      type: "client-write-text-file",
      method: "fs/write_text_file",
      sessionId: params.sessionId,
      payload: params,
    });
    const absolutePath = resolve(params.path);
    this.state.virtualFiles.set(absolutePath, params.content);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, params.content, "utf8");
    return {};
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    this.emitWireEntry({
      direction: "inbound",
      type: "client-read-text-file",
      method: "fs/read_text_file",
      sessionId: params.sessionId,
      payload: params,
    });
    const absolutePath = resolve(params.path);
    const overridden = this.state.virtualFiles.get(absolutePath);
    if (overridden !== undefined) {
      return { content: overridden };
    }

    try {
      return { content: await readFile(absolutePath, "utf8") };
    } catch {
      return { content: "Harness placeholder content" };
    }
  }

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    this.emitWireEntry({
      direction: "inbound",
      type: "client-create-terminal",
      method: "terminal/create",
      sessionId: params.sessionId,
      payload: params,
    });
    const terminalId = `harness-terminal-${this.state.nextTerminalId}`;
    this.state.nextTerminalId += 1;
    this.state.terminals.set(terminalId, {
      id: terminalId,
      command: params.command,
      args: params.args ?? [],
      cwd: params.cwd ?? process.cwd(),
      output: simulateTerminalOutput(params.command, params.args ?? [], params.cwd ?? process.cwd()),
      exitCode: 0,
      waitMs: params.command === "sleep" ? Math.min(Number(params.args?.[0] ?? "0") * 1000, STEP_TIMEOUT_MS) : 0,
      createdAt: Date.now(),
      killed: false,
    });
    return { terminalId };
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    this.emitWireEntry({
      direction: "inbound",
      type: "client-terminal-output",
      method: "terminal/output",
      sessionId: params.sessionId,
      payload: params,
    });
    const terminal = this.requireTerminal(params.terminalId);
    return {
      output: terminal.output,
      truncated: false,
    };
  }

  async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    this.emitWireEntry({
      direction: "inbound",
      type: "client-terminal-wait-for-exit",
      method: "terminal/wait_for_exit",
      sessionId: params.sessionId,
      payload: params,
    });
    const terminal = this.requireTerminal(params.terminalId);
    const remainingWaitMs = Math.max(0, terminal.waitMs - (Date.now() - terminal.createdAt));
    if (remainingWaitMs > 0 && !terminal.killed) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, remainingWaitMs));
    }
    return {
      exitCode: terminal.killed ? 130 : (terminal.exitCode ?? 0),
      signal: terminal.killed ? "SIGTERM" : null,
    };
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    this.emitWireEntry({
      direction: "inbound",
      type: "client-terminal-kill",
      method: "terminal/kill",
      sessionId: params.sessionId,
      payload: params,
    });
    const terminal = this.requireTerminal(params.terminalId);
    terminal.killed = true;
    return {};
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    this.emitWireEntry({
      direction: "inbound",
      type: "client-terminal-release",
      method: "terminal/release",
      sessionId: params.sessionId,
      payload: params,
    });
    this.state.terminals.delete(params.terminalId);
    return {};
  }

  private requireTerminal(terminalId: string): HarnessTerminalState {
    const terminal = this.state.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Unknown harness terminal: ${terminalId}`);
    }
    return terminal;
  }
}

function simulateTerminalOutput(command: string, args: string[], cwd: string): string {
  if (command === "pwd") {
    return `${cwd}\n`;
  }

  if (command === "git" && args[0] === "status") {
    return "On branch harness-simulator\nnothing to commit, working tree clean\n";
  }

  if (command === "git" && args[0] === "diff" && args[1] === "--stat") {
    return "README.md | 2 +-\n1 file changed, 1 insertion(+), 1 deletion(-)\n";
  }

  if (command === "pnpm" && args[0] === "test") {
    return " PASS  harness simulation\n";
  }

  return `Simulated command output: ${[command, ...args].join(" ")}\n`;
}

function interpolatePrompt(prompt: string): string {
  return prompt.replaceAll("$cwd", process.cwd());
}

function buildClientCapabilities(): ClientCapabilities {
  return {
    fs: {
      readTextFile: true,
      writeTextFile: true,
    },
    terminal: true,
  };
}

async function createConnection(
  launch: AgentLaunchConfig,
  state: RuntimeClientState,
  emitWireEntry: (
    entry: Omit<TranscriptEntry, "timestamp" | "kind"> & { kind?: TranscriptEntry["kind"] },
  ) => void,
): Promise<{
  connection: acp.ClientSideConnection;
  child: ChildProcess;
}> {
  const child = spawn(launch.command, launch.args, {
    detached: true,
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      ...launch.env,
    },
  });

  if (!child.stdin || !child.stdout) {
    throw new Error("Failed to create stdio pipes for agent process");
  }

  const input = nodeWritableToWeb(child.stdin);
  const output = nodeReadableToWeb(child.stdout);
  const client = new HarnessClient(state, emitWireEntry);
  const stream = acp.ndJsonStream(input, output);
  const connection = new acp.ClientSideConnection(() => client, stream);
  void connection.closed.catch(() => {
    // Individual request promises surface failures. Avoid process-level
    // unhandled rejections when an agent closes stdio early.
  });

  return { connection, child };
}

function nodeReadableToWeb(
  stream: AsyncIterable<Buffer | Uint8Array | string> &
    Pick<Readable, "destroy" | "off" | "on">,
): ReadableStream<Uint8Array> {
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const cleanup = () => {
        stream.off("data", onData);
        stream.off("end", onClose);
        stream.off("close", onClose);
        stream.off("error", onError);
      };
      const onData = (chunk: Buffer | Uint8Array | string) => {
        if (cancelled || closed) {
          return;
        }
        controller.enqueue(normalizeReadableChunk(chunk));
      };
      const onClose = () => {
        if (closed) {
          return;
        }
        closed = true;
        cleanup();
        if (!cancelled) {
          controller.close();
        }
      };
      const onError = (error: unknown) => {
        if (closed) {
          return;
        }
        closed = true;
        cleanup();
        if (!cancelled) {
          controller.error(error);
        }
      };

      stream.on("data", onData);
      stream.on("end", onClose);
      stream.on("close", onClose);
      stream.on("error", onError);
    },
    cancel(reason) {
      cancelled = true;
      stream.destroy(toError(reason));
    },
  });
}

function nodeWritableToWeb(
  stream: Pick<Writable, "destroy" | "end" | "write">,
): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      await new Promise<void>((resolve, reject) => {
        stream.write(chunk, (error?: Error | null) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        stream.end((error?: Error | null) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    abort(reason) {
      stream.destroy(toError(reason));
    },
  });
}

function normalizeReadableChunk(
  chunk: Buffer | Uint8Array | string,
): Uint8Array {
  if (typeof chunk === "string") {
    return new TextEncoder().encode(chunk);
  }

  return chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
}

function toError(reason: unknown): Error | undefined {
  if (reason instanceof Error) {
    return reason;
  }

  if (reason === undefined) {
    return undefined;
  }

  return new Error(String(reason));
}

function hasObservedEvent(state: RuntimeClientState, eventType: string): boolean {
  return state.pendingSessionUpdates.some((item) => item.update.sessionUpdate === eventType);
}

/**
 * Evaluate a skipIf expression against current runtime state.
 * Returns true if the step should be SKIPPED.
 */
export function shouldSkipHarnessStep(
  expr: string,
  context: {
    capabilities?: Record<string, unknown>;
    hasModes: boolean;
    hasAuthMethods: boolean;
    hasConfigOptions: boolean;
    probeProfile?: HarnessProbeProfile;
  },
): boolean {
  const capabilities = context.capabilities ?? {};
  const sessionCapabilities = (
    capabilities.sessionCapabilities &&
    typeof capabilities.sessionCapabilities === "object"
      ? capabilities.sessionCapabilities
      : {}
  ) as Record<string, unknown>;

  switch (expr) {
    case "!capabilities.setMode":
      return !capabilities.setMode;
    case "!capabilities.sessionLoad":
      return !capabilities.loadSession;
    case "!capabilities.sessionResume":
      return !capabilities.resumeSession && !sessionCapabilities.resume;
    case "!capabilities.sessionCapabilities.resume":
      return !sessionCapabilities.resume;
    case "!capabilities.sessionFork":
      return !sessionCapabilities.fork;
    case "!modes":
      return !context.hasModes;
    case "!authMethods":
      return !context.hasAuthMethods;
    case "!configOptions":
      return !context.hasConfigOptions;
    case "!probe.modeId":
      return !context.probeProfile?.modeId;
    case "!probe.prompt":
      return !context.probeProfile?.prompt;
    default:
      // Unknown expression → don't skip (safe default)
      return false;
  }
}

function evaluateSkipCondition(
  expr: string,
  state: RuntimeClientState,
  probeProfile?: HarnessProbeProfile,
): boolean {
  return shouldSkipHarnessStep(expr, {
    capabilities: (state.summaryPatch.discovery?.initialize?.capabilities ?? {}) as Record<string, unknown>,
    hasModes: !!state.availableModes?.length,
    hasAuthMethods: !!state.availableAuthMethods?.length,
    hasConfigOptions: !!state.configOptions?.length,
    probeProfile,
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function mapFailureStatusToCoverageStatus(status: HarnessFailureStatus): "FAIL" | "N/A" | "MISMATCH" | "NOT_OBSERVED" {
  switch (status) {
    case "failed":
      return "FAIL";
    case "not-applicable":
      return "N/A";
    case "mismatch":
      return "MISMATCH";
    case "not-observed":
      return "NOT_OBSERVED";
    default: {
      const exhaustiveCheck: never = status;
      throw new Error(`Unsupported failure status: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function classifyExecutionFailure(testCase: HarnessCase, agentType: string, error: unknown): HarnessFailureStatus {
  const caseDefault = testCase.classification?.[agentType];
  const message = formatError(error);

  if (message.includes("timed out")) {
    return caseDefault?.timeoutStatus ?? "failed";
  }

  return caseDefault?.executionErrorStatus ?? "failed";
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function waitForSessionUpdateQuietPeriod(
  state: RuntimeClientState,
  quietMs: number,
  maxWaitMs: number,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    const lastSeen = state.lastSessionUpdateAt ?? startedAt;
    if (Date.now() - lastSeen >= quietMs) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await withTimeout(
    new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("close", () => resolve());
    }),
    "Agent process exit",
    timeoutMs,
  );
}

function killChildProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // ignore teardown errors
    }
  }
}

async function executeStep(
  step: HarnessCase["steps"][number],
  context: {
    connection: acp.ClientSideConnection;
    state: RuntimeClientState;
    testCase: HarnessCase;
    emitWireEntry: (
      entry: Omit<TranscriptEntry, "timestamp" | "kind"> & { kind?: TranscriptEntry["kind"] },
    ) => void;
    agent: HarnessAgentDefinition;
  },
): Promise<void> {
  const probeProfile = context.testCase.probes?.[context.agent.type];
  const resolveSessionId = (sessionRef: string): string => {
    if (sessionRef === "current") {
      if (!context.state.sessionId) {
        throw new Error("No current session available");
      }
      return context.state.sessionId;
    }

    return sessionRef;
  };

  switch (step.type) {
    case "initialize": {
      const request = {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: {
          name: "acp-runtime-harness",
          version: "0.1.0",
        },
        clientCapabilities: buildClientCapabilities(),
      };
      context.emitWireEntry({
        direction: "outbound",
        type: "request",
        method: "initialize",
        payload: request,
      });
      const response: InitializeResponse = await context.connection.initialize(request);
      context.emitWireEntry({
        direction: "inbound",
        type: "response",
        method: "initialize",
        payload: response,
      });
      mergeSummaryPatch(context.state, {
        protocolCoverage: {
          initialize: {
            status: "PASS",
            advertised: true,
            caseId: context.testCase.id,
            notes: [],
          },
        },
        discovery: {
          initialize: {
            protocolVersion: response.protocolVersion,
            agentInfo: {
              name: response.agentInfo?.name,
              version: response.agentInfo?.version,
            },
            capabilities: response.agentCapabilities as Record<string, unknown> | undefined,
            authMethods: response.authMethods?.map((item) => ({
              id: item.id,
              name: item.name,
              description: item.description ?? undefined,
            })),
          },
        },
      });
      context.state.availableAuthMethods = response.authMethods;
      const authMethods = response.authMethods ?? [];
      if (authMethods.length === 0) {
        mergeSummaryPatch(context.state, {
          discovery: {
            auth: {
              authenticated: false,
            },
          },
        });
      }
      return;
    }
    case "authenticate": {
      const methods = context.state.availableAuthMethods ?? [];
      const methodId = step.authMethod ?? methods[0]?.id;

      if (!methodId) {
        throw new Error("authenticate requires an auth method from initialize or step.authMethod");
      }

      const request = { methodId };
      context.emitWireEntry({
        direction: "outbound",
        type: "request",
        method: "authenticate",
        payload: request,
      });
      const response: AuthenticateResponse = await context.connection.authenticate(request);
      context.emitWireEntry({
        direction: "inbound",
        type: "response",
        method: "authenticate",
        payload: response,
      });
      mergeSummaryPatch(context.state, {
        protocolCoverage: {
          authenticate: {
            status: "PASS",
            advertised: methods.length > 0,
            caseId: context.testCase.id,
            notes: [],
          },
        },
        discovery: {
          auth: {
            authenticated: true,
            methodId,
          },
        },
      });
      return;
    }
    case "session-new": {
      const request = {
        cwd: process.cwd(),
        mcpServers: [],
      };
      context.emitWireEntry({
        direction: "outbound",
        type: "request",
        method: "session/new",
        payload: request,
      });
      const response: NewSessionResponse = await context.connection.newSession(request);
      context.state.sessionId = response.sessionId;
      context.state.availableModes = response.modes?.availableModes ?? undefined;
      context.state.currentModeId = response.modes?.currentModeId ?? undefined;
      context.state.configOptions = response.configOptions ?? undefined;
      context.emitWireEntry({
        direction: "inbound",
        type: "response",
        method: "session/new",
        sessionId: response.sessionId,
        payload: response,
      });
      mergeSummaryPatch(context.state, {
        protocolCoverage: {
          "session/new": {
            status: "PASS",
            advertised: true,
            caseId: context.testCase.id,
            notes: [],
          },
        },
        discovery: {
          session: {
            id: response.sessionId,
          },
          mode: {
            currentModeId: response.modes?.currentModeId,
            availableModes: response.modes?.availableModes?.map((mode) => ({
              id: mode.id,
              name: mode.name,
              description: mode.description ?? undefined,
            })),
          },
        },
      });
      return;
    }
    case "session-list": {
      const request = {
        cwd: process.cwd(),
      };
      context.emitWireEntry({
        direction: "outbound",
        type: "request",
        method: "session/list",
        payload: request,
      });
      const response: ListSessionsResponse = await context.connection.listSessions(request);
      context.state.lastListedSessions = response.sessions;
      context.emitWireEntry({
        direction: "inbound",
        type: "response",
        method: "session/list",
        payload: response,
      });
      mergeSummaryPatch(context.state, {
        protocolCoverage: {
          "session/list": {
            status: "PASS",
            advertised: true,
            caseId: context.testCase.id,
            notes: [],
          },
        },
        discovery: {
          session: {
            listed: response.sessions.map((session) => ({
              id: session.sessionId,
              cwd: session.cwd,
              title: session.title ?? undefined,
            })),
          },
        },
      });
      return;
    }
    case "session-load": {
      const sessionId = resolveSessionId(step.sessionRef);
      const request = {
        sessionId,
        cwd: process.cwd(),
        mcpServers: [],
      };
      context.emitWireEntry({
        direction: "outbound",
        type: "request",
        method: "session/load",
        sessionId,
        payload: request,
      });
      const response: LoadSessionResponse = await context.connection.loadSession(request);
      context.state.sessionId = sessionId;
      context.state.availableModes = response.modes?.availableModes ?? undefined;
      context.state.currentModeId = response.modes?.currentModeId ?? undefined;
      context.state.configOptions = response.configOptions ?? undefined;
      context.emitWireEntry({
        direction: "inbound",
        type: "response",
        method: "session/load",
        sessionId,
        payload: response,
      });
      mergeSummaryPatch(context.state, {
        protocolCoverage: {
          "session/load": {
            status: "PASS",
            advertised: true,
            caseId: context.testCase.id,
            notes: [],
          },
        },
        discovery: {
          session: {
            id: sessionId,
          },
          mode: {
            currentModeId: response.modes?.currentModeId,
            availableModes: response.modes?.availableModes?.map((mode) => ({
              id: mode.id,
              name: mode.name,
              description: mode.description ?? undefined,
            })),
          },
        },
      });
      return;
    }
    case "session-resume": {
      const sessionId = resolveSessionId(step.sessionRef);
      const request = {
        sessionId,
        cwd: process.cwd(),
        mcpServers: [],
      };
      context.emitWireEntry({
        direction: "outbound",
        type: "request",
        method: "session/resume",
        sessionId,
        payload: request,
      });
      const response: ResumeSessionResponse = await context.connection.resumeSession(request);
      context.state.sessionId = sessionId;
      context.state.availableModes = response.modes?.availableModes ?? undefined;
      context.state.currentModeId = response.modes?.currentModeId ?? undefined;
      context.state.configOptions = response.configOptions ?? undefined;
      context.emitWireEntry({
        direction: "inbound",
        type: "response",
        method: "session/resume",
        sessionId,
        payload: response,
      });
      mergeSummaryPatch(context.state, {
        protocolCoverage: {
          "session/resume": {
            status: "PASS",
            advertised: true,
            caseId: context.testCase.id,
            notes: [],
          },
        },
        discovery: {
          session: {
            id: sessionId,
          },
          mode: {
            currentModeId: response.modes?.currentModeId,
            availableModes: response.modes?.availableModes?.map((mode) => ({
              id: mode.id,
              name: mode.name,
              description: mode.description ?? undefined,
            })),
          },
        },
      });
      return;
    }
    case "session-fork": {
      const sessionId = resolveSessionId(step.sessionRef);
      const request = {
        sessionId,
        cwd: process.cwd(),
        mcpServers: [],
      };
      context.emitWireEntry({
        direction: "outbound",
        type: "request",
        method: "session/fork",
        sessionId,
        payload: request,
      });
      const response: ForkSessionResponse = await context.connection.unstable_forkSession(request);
      context.emitWireEntry({
        direction: "inbound",
        type: "response",
        method: "session/fork",
        sessionId: response.sessionId,
        payload: response,
      });
      mergeSummaryPatch(context.state, {
        protocolCoverage: {
          "session/fork": {
            status: "PASS",
            advertised: true,
            caseId: context.testCase.id,
            notes: [],
          },
        },
      });
      return;
    }
    case "session-prompt": {
      if (!context.state.sessionId) {
        throw new Error("session-prompt requires an active session");
      }

      let prompt: string;
      if (step.prompt === "$probe-prompt") {
        prompt = probeProfile?.prompt ?? step.defaultPrompt ?? (() => { throw new Error(`Case ${context.testCase.id} requires agent probe prompt or step defaultPrompt`); })();
      } else {
        prompt = step.prompt;
      }

      prompt = interpolatePrompt(prompt);

      const request = {
        sessionId: context.state.sessionId,
        prompt: [
          {
            type: "text" as const,
            text: prompt,
          },
        ],
      };

      context.emitWireEntry({
        direction: "outbound",
        type: "request",
        method: "session/prompt",
        sessionId: context.state.sessionId,
        turnId: step.turnRef,
        payload: request,
      });

      context.state.promptCompleted = false;
      context.state.promptPromise = context.connection.prompt(request).then((response) => {
        context.state.promptCompleted = true;
        context.emitWireEntry({
          direction: "inbound",
          type: "response",
          method: "session/prompt",
          sessionId: context.state.sessionId,
          turnId: step.turnRef,
          payload: response,
        });
        return response;
      });
      void context.state.promptPromise.catch(() => {
        // Some cases wait for intermediate events instead of awaiting prompt
        // completion. If that step fails and teardown closes stdio, the prompt
        // request rejects; the step failure should remain the reported result.
      });
      return;
    }
    case "session-cancel": {
      if (!context.state.sessionId) {
        throw new Error("session-cancel requires an active session");
      }

      const request: CancelNotification = {
        sessionId: context.state.sessionId,
      };
      context.emitWireEntry({
        direction: "outbound",
        type: "notification",
        method: "session/cancel",
        sessionId: context.state.sessionId,
        turnId: step.turnRef,
        payload: request,
      });
      await context.connection.cancel(request);
      return;
    }
    case "set-mode": {
      if (!context.state.sessionId) {
        throw new Error("set-mode requires an active session");
      }

      let modeId = step.modeId;
      if (modeId === "$probe-mode") {
        modeId = probeProfile?.modeId ?? (() => { throw new Error(`Case ${context.testCase.id} requires agent probe mode`); })();
      }
      if (modeId === "$alternate") {
        const alternate = context.state.availableModes?.find((mode) => mode.id !== context.state.currentModeId);
        if (!alternate) {
          throw new Error("No alternate mode available");
        }
        modeId = alternate.id;
      }

      const request = {
        sessionId: context.state.sessionId,
        modeId,
      };
      context.emitWireEntry({
        direction: "outbound",
        type: "request",
        method: "session/set_mode",
        sessionId: context.state.sessionId,
        payload: request,
      });
      const response: SetSessionModeResponse = await context.connection.setSessionMode(request);
      context.state.currentModeId = modeId;
      context.emitWireEntry({
        direction: "inbound",
        type: "response",
        method: "session/set_mode",
        sessionId: context.state.sessionId,
        payload: response,
      });
      mergeSummaryPatch(context.state, {
        protocolCoverage: {
          "session/set_mode": {
            status: "PASS",
            advertised: true,
            caseId: context.testCase.id,
            notes: [],
          },
        },
        discovery: {
          mode: {
            currentModeId: modeId,
          },
        },
      });
      return;
    }
    case "set-config-option": {
      if (!context.state.sessionId) {
        throw new Error("set-config-option requires an active session");
      }

      let configId = step.key;
      let configValue = step.value;

      if (step.key === "$first") {
        const firstOption = context.state.configOptions?.[0];
        if (!firstOption) {
          throw new Error("set-config-option $first: no configOptions available");
        }
        configId = firstOption.id;
        if (firstOption.type === "select" && Array.isArray((firstOption as any).options)) {
          configValue = (firstOption as any).options[0]?.value ?? firstOption.currentValue;
        } else if (firstOption.type === "boolean") {
          configValue = !(firstOption.currentValue as boolean);
        } else {
          configValue = firstOption.currentValue;
        }
      }

      const request = typeof configValue === "boolean"
        ? {
            sessionId: context.state.sessionId,
            configId,
            type: "boolean" as const,
            value: configValue,
          }
        : {
            sessionId: context.state.sessionId,
            configId,
            value: String(configValue),
          };
      context.emitWireEntry({
        direction: "outbound",
        type: "request",
        method: "session/set_config_option",
        sessionId: context.state.sessionId,
        payload: request,
      });
      const response: SetSessionConfigOptionResponse = await context.connection.setSessionConfigOption(request);
      context.state.configOptions = response.configOptions;
      context.emitWireEntry({
        direction: "inbound",
        type: "response",
        method: "session/set_config_option",
        sessionId: context.state.sessionId,
        payload: response,
      });
      mergeSummaryPatch(context.state, {
        protocolCoverage: {
          "session/set_config_option": {
            status: "PASS",
            advertised: true,
            caseId: context.testCase.id,
            notes: [],
          },
        },
      });
      return;
    }
    case "permission-decision":
      context.state.pendingPermissionDecisions.push(step.decision);
      return;
    case "wait-for-event":
      if (step.eventType === "completed") {
        if (!context.state.promptPromise) {
          throw new Error("wait-for-event completed requires a started prompt");
        }
        await context.state.promptPromise;
        return;
      }

      while (!hasObservedEvent(context.state, step.eventType)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return;
    case "close-session":
      return;
    case "terminal-output":
      await new HarnessClient(context.state, context.emitWireEntry).terminalOutput({
        sessionId: context.state.sessionId ?? "",
        terminalId: step.terminalRef,
      });
      return;
    case "terminal-wait-for-exit":
      await new HarnessClient(context.state, context.emitWireEntry).waitForTerminalExit({
        sessionId: context.state.sessionId ?? "",
        terminalId: step.terminalRef,
      });
      return;
    case "terminal-kill":
      await new HarnessClient(context.state, context.emitWireEntry).killTerminal({
        sessionId: context.state.sessionId ?? "",
        terminalId: step.terminalRef,
      });
      return;
    case "terminal-release":
      await new HarnessClient(context.state, context.emitWireEntry).releaseTerminal({
        sessionId: context.state.sessionId ?? "",
        terminalId: step.terminalRef,
      });
      return;
    default: {
      const exhaustiveCheck: never = step;
      throw new Error(`Unsupported step: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export const executeHarnessCaseOverStdio: HarnessCaseExecutor = async (context) => {
  const { agent, testCase, emitRuntimeEvent, emitWireEntry } = context;
  const state: RuntimeClientState = {
    promptCompleted: false,
    pendingPermissionDecisions: [],
    pendingSessionUpdates: [],
    summaryPatch: {},
    virtualFiles: new Map(),
    terminals: new Map(),
    nextTerminalId: 1,
  };

  const launch = await resolveAgentLaunch(agent.type);
  const { connection, child } = await createConnection(launch, state, emitWireEntry);
  const probeProfile = testCase.probes?.[agent.type];

  try {
    for (const step of testCase.steps) {
      // Check skipIf condition
      if (step.skipIf && evaluateSkipCondition(step.skipIf, state, probeProfile)) {
        emitRuntimeEvent({
          type: "step-skipped",
          caseId: testCase.id,
          agentType: agent.type,
          stepType: step.type,
          details: { skipIf: step.skipIf },
        });
        continue;
      }

      emitRuntimeEvent({
        type: "step-started",
        caseId: testCase.id,
        agentType: agent.type,
        stepType: step.type,
      });
      await withTimeout(
        executeStep(step, {
          connection,
          state,
          testCase,
          emitWireEntry,
          agent,
        }),
        `Step ${step.type}`,
        step.timeoutMs,
      );
      emitRuntimeEvent({
        type: "step-completed",
        caseId: testCase.id,
        agentType: agent.type,
        stepType: step.type,
      });
    }

    await waitForSessionUpdateQuietPeriod(state, 100, 1000);

    return {
      status: "passed" as const,
      summaryPatch: state.summaryPatch,
      notes: [],
    };
  } catch (error) {
    const failureStatus = classifyExecutionFailure(testCase, agent.type, error);
    const coverageStatus = mapFailureStatusToCoverageStatus(failureStatus);
    const failedProtocolCoverage = Object.fromEntries(
      testCase.protocolDependencies
        .filter((dependency) => state.summaryPatch.protocolCoverage?.[dependency] === undefined)
        .map((dependency) => [
          dependency,
          {
            status: coverageStatus,
            advertised: true,
            caseId: testCase.id,
            notes: [formatError(error)],
          },
        ]),
    );

    return {
      status: failureStatus,
      summaryPatch: {
        ...state.summaryPatch,
        protocolCoverage: {
          ...state.summaryPatch.protocolCoverage,
          ...failedProtocolCoverage,
        },
      },
      notes: [formatError(error)],
    };
  } finally {
    try {
      child.stdin?.end();
    } catch {
      // ignore stdin shutdown errors during teardown
    }

    try {
      child.stdout?.destroy();
    } catch {
      // ignore stdout shutdown errors during teardown
    }

    killChildProcessTree(child, "SIGTERM");

    try {
      await waitForChildExit(child, 2_000);
    } catch {
      killChildProcessTree(child, "SIGKILL");
      await waitForChildExit(child, 1_000).catch(() => undefined);
    }

    await withTimeout(
      connection.closed.catch(() => undefined),
      "Connection close",
      2_000,
    ).catch(() => undefined);
  }
};
