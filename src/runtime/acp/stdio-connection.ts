import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  type AnyMessage,
} from "@agentclientprotocol/sdk";
import { SeverityNumber } from "@opentelemetry/api-logs";

import type {
  AcpConnection,
  AcpConnectionFactory,
} from "./connection-types.js";
import { AcpRuntimeObservabilityRedactionKind } from "../core/types.js";
import type {
  AcpRuntimeAgent,
  AcpRuntimeObservabilityOptions,
} from "../core/types.js";
import {
  emitRuntimeLog,
  isRuntimeLogEnabled,
  observedLogBody,
} from "../observability/logging.js";

const QODER_BENIGN_STDOUT_LINES = new Set([
  "Received interrupt signal. Cleaning up resources...",
  "Cleanup completed. Exiting...",
]);

export type StdioFactoryOptions = {
  stderr?: "ignore" | "inherit" | "pipe";
  observability?: AcpRuntimeObservabilityOptions;
  onAcpMessage?:
    | ((direction: "inbound" | "outbound", message: AnyMessage) => void)
    | undefined;
};

type NodeReadableLike = AsyncIterable<Buffer | Uint8Array | string> &
  Pick<Readable, "destroy" | "off" | "on">;

type NodeWritableLike = Pick<Writable, "destroy" | "end" | "write">;

type AgentProcess = ChildProcess & {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable | null;
};

const DEFAULT_AGENT_CLOSE_AFTER_STDIN_END_MS = 100;
const AGENT_CLOSE_TERM_GRACE_MS = 1_500;
const AGENT_CLOSE_KILL_GRACE_MS = 1_000;
const STDERR_TAIL_LIMIT = 2_000;

type StdioOperationTracker = {
  end(operation: string): void;
  start(operation: string): void;
  summary(): string | undefined;
};

export function createStdioAcpConnectionFactory(
  options: StdioFactoryOptions = {},
): AcpConnectionFactory {
  return async (input) => {
    let disposing = false;
    const operationTracker = createStdioOperationTracker();
    const spawnedChild = spawn(input.agent.command, input.agent.args ?? [], {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...input.agent.env,
      },
      stdio: ["pipe", "pipe", options.stderr ?? "pipe"],
      windowsHide: true,
    });
    await waitForSpawn(spawnedChild);
    const child = requireAgentStdio(spawnedChild);

    const stderrChunks: string[] = [];
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrChunks.push(chunk);
      });
    }

    const stream = createTappedStream(
      createNdJsonMessageStream(
        input.agent.command,
        nodeWritableToWeb(child.stdin),
        nodeReadableToWeb(child.stdout),
      ),
      {
        agent: input.agent,
        cwd: input.cwd,
        onAcpMessage: options.onAcpMessage,
        observability: input.observability ?? options.observability,
        traceContext: input.traceContext,
      },
    );
    const sdkConnection = new ClientSideConnection(() => input.client, stream);

    const onExit = createExitWatcher(
      child,
      {
        args: input.agent.args,
        command: input.agent.command,
        cwd: input.cwd,
        pid: child.pid ?? undefined,
      },
      stderrChunks,
      () => disposing,
      () => operationTracker.summary(),
    );
    void onExit.catch(() => {
      // Observed by wrapped requests/closed; suppress global unhandled rejection noise.
    });
    const connection = wrapConnectionWithExit(
      sdkConnection,
      onExit,
      operationTracker,
    );
    void connection.closed.catch(() => {
      // Suppress unhandled rejections for callers that do not observe `closed`.
    });

    return {
      connection,
      async dispose() {
        disposing = true;
        try {
          await terminateAgentProcess(child);
          await onExit.catch(() => {});
        } finally {
          detachAgentHandles(child);
        }
      },
    };
  };
}

export function nodeReadableToWeb(
  stream: NodeReadableLike,
  options: { preferNative?: boolean } = {},
): ReadableStream<Uint8Array> {
  if (options.preferNative !== false) {
    const nativeToWeb = (
      Readable as typeof Readable & {
        toWeb?: ((stream: Readable) => ReadableStream<Uint8Array>) | undefined;
      }
    ).toWeb;
    if (typeof nativeToWeb === "function" && stream instanceof Readable) {
      try {
        return nativeToWeb(stream) as unknown as ReadableStream<Uint8Array>;
      } catch {
        // Bun exposes the static bridge but can fail at runtime. Fall back to a
        // portable wrapper so the runtime can still operate under Bun.
      }
    }
  }

  let cancelled = false;
  let onError: ((error: unknown) => void) | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      onError = (error: unknown) => {
        controller.error(error);
      };

      stream.on("error", onError);

      void (async () => {
        try {
          for await (const chunk of stream) {
            if (cancelled) {
              break;
            }
            controller.enqueue(normalizeReadableChunk(chunk));
          }
          if (!cancelled) {
            controller.close();
          }
        } catch (error) {
          if (!cancelled) {
            controller.error(error);
          }
        } finally {
          stream.off("error", onError);
        }
      })();
    },
    cancel(reason) {
      cancelled = true;
      if (onError) {
        stream.off("error", onError);
      }
      stream.destroy(toError(reason));
    },
  });
}

export function nodeWritableToWeb(
  stream: NodeWritableLike,
  options: { preferNative?: boolean } = {},
): WritableStream<Uint8Array> {
  if (options.preferNative !== false) {
    const nativeToWeb = (
      Writable as typeof Writable & {
        toWeb?: ((stream: Writable) => WritableStream<Uint8Array>) | undefined;
      }
    ).toWeb;
    if (typeof nativeToWeb === "function" && stream instanceof Writable) {
      try {
        return nativeToWeb(stream);
      } catch {
        // Bun can surface a partially implemented bridge here.
      }
    }
  }

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

function wrapConnectionWithExit(
  connection: ClientSideConnection,
  onExit: Promise<void>,
  operationTracker: StdioOperationTracker,
): AcpConnection {
  const exitFailure = onExit.then<never>(
    () => new Promise<never>(() => {}),
    (error) => Promise.reject(error),
  );
  const withExit = <T>(name: string, operation: Promise<T>): Promise<T> => {
    operationTracker.start(name);
    const guardedOperation = operation.catch(async (error) => {
      throw await enhanceClosedConnectionError(error, onExit, name);
    });
    return Promise.race([guardedOperation, exitFailure]).finally(() => {
      operationTracker.end(name);
    });
  };
  const signal = createConnectionSignal(connection.signal, onExit);
  const closed = Promise.race([connection.closed, onExit]);

  return {
    signal,
    closed,
    authenticate(params) {
      return withExit("authenticate", connection.authenticate(params));
    },
    cancel(params) {
      return withExit("cancel", connection.cancel(params));
    },
    initialize(params) {
      return withExit("initialize", connection.initialize(params));
    },
    listSessions: connection.listSessions
      ? (params) => withExit("listSessions", connection.listSessions(params))
      : undefined,
    loadSession: connection.loadSession
      ? (params) => withExit("loadSession", connection.loadSession(params))
      : undefined,
    newSession(params) {
      return withExit("newSession", connection.newSession(params));
    },
    prompt(params) {
      return withExit("prompt", connection.prompt(params));
    },
    setSessionConfigOption: connection.setSessionConfigOption
      ? (params) =>
          withExit(
            "setSessionConfigOption",
            connection.setSessionConfigOption(params),
          )
      : undefined,
    setSessionMode: connection.setSessionMode
      ? (params) => withExit("setSessionMode", connection.setSessionMode(params))
      : undefined,
    closeSession: connection.closeSession
      ? (params) => withExit("closeSession", connection.closeSession(params))
      : undefined,
    resumeSession: connection.resumeSession
      ? (params) => withExit("resumeSession", connection.resumeSession(params))
      : undefined,
  };
}

function createConnectionSignal(
  signal: AbortSignal,
  onExit: Promise<void>,
): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();

  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener("abort", abort, { once: true });
  }

  void onExit.then(abort, abort);
  return controller.signal;
}

function shouldIgnoreNonJsonAgentOutputLine(
  agentCommand: string,
  trimmedLine: string,
): boolean {
  return (
    basenameToken(agentCommand) === "qodercli" &&
    QODER_BENIGN_STDOUT_LINES.has(trimmedLine)
  );
}

function createNdJsonMessageStream(
  agentCommand: string,
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
): {
  readable: ReadableStream<AnyMessage>;
  writable: WritableStream<AnyMessage>;
} {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      let content = "";
      const reader = input.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          if (!value) {
            continue;
          }
          content += textDecoder.decode(value, { stream: true });
          const lines = content.split("\n");
          content = lines.pop() || "";
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (
              !trimmedLine ||
              shouldIgnoreNonJsonAgentOutputLine(agentCommand, trimmedLine)
            ) {
              continue;
            }
            try {
              controller.enqueue(
                normalizeInboundAcpMessage(
                  JSON.parse(trimmedLine) as AnyMessage,
                ),
              );
            } catch (error) {
              console.error(
                "Failed to parse JSON message:",
                trimmedLine,
                error,
              );
            }
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      const content = JSON.stringify(message) + "\n";
      const writer = output.getWriter();
      try {
        await writer.write(textEncoder.encode(content));
      } finally {
        writer.releaseLock();
      }
    },
  });

  return { readable, writable };
}

export function normalizeInboundAcpMessage(message: AnyMessage): AnyMessage {
  if (
    typeof message !== "object" ||
    message === null ||
    !("method" in message) ||
    message.method !== "session/update" ||
    !("params" in message)
  ) {
    return message;
  }

  const params = message.params;
  if (
    typeof params !== "object" ||
    params === null ||
    !("update" in params) ||
    typeof params.update !== "object" ||
    params.update === null ||
    !("sessionUpdate" in params.update) ||
    params.update.sessionUpdate !== "usage_update" ||
    !("used" in params.update) ||
    params.update.used !== null
  ) {
    return message;
  }

  return {
    ...message,
    params: {
      ...params,
      update: {
        ...params.update,
        used: 0,
      },
    },
  } as AnyMessage;
}

function createTappedStream(
  base: {
    readable: ReadableStream<AnyMessage>;
    writable: WritableStream<AnyMessage>;
  },
  options: {
    agent: AcpRuntimeAgent;
    cwd: string;
    observability?: AcpRuntimeObservabilityOptions;
    onAcpMessage?:
      | ((direction: "inbound" | "outbound", message: AnyMessage) => void)
      | undefined;
    traceContext?: import("@opentelemetry/api").Context;
  },
): {
  readable: ReadableStream<AnyMessage>;
  writable: WritableStream<AnyMessage>;
} {
  if (!options.onAcpMessage && !protocolMessageLoggingEnabled(options.traceContext)) {
    return base;
  }

  return {
    readable: new ReadableStream<AnyMessage>({
      async start(controller) {
        const reader = base.readable.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              break;
            }
            if (!value) {
              continue;
            }
            emitAcpProtocolMessageLog({
              agent: options.agent,
              cwd: options.cwd,
              direction: "inbound",
              message: value,
              observability: options.observability,
              traceContext: options.traceContext,
            });
            options.onAcpMessage?.("inbound", value);
            controller.enqueue(value);
          }
        } finally {
          reader.releaseLock();
          controller.close();
        }
      },
    }),
    writable: new WritableStream<AnyMessage>({
      async write(message) {
        emitAcpProtocolMessageLog({
          agent: options.agent,
          cwd: options.cwd,
          direction: "outbound",
          message,
          observability: options.observability,
          traceContext: options.traceContext,
        });
        options.onAcpMessage?.("outbound", message);
        const writer = base.writable.getWriter();
        try {
          await writer.write(message);
        } finally {
          writer.releaseLock();
        }
      },
    }),
  };
}

export function emitAcpProtocolMessageLog(input: {
  agent: AcpRuntimeAgent;
  cwd: string;
  direction: "inbound" | "outbound";
  message: AnyMessage;
  observability?: AcpRuntimeObservabilityOptions;
  traceContext?: import("@opentelemetry/api").Context;
}): void {
  if (!protocolMessageLoggingEnabled(input.traceContext)) {
    return;
  }

  emitRuntimeLog({
    attributes: {
      "acp.agent.command": input.agent.command,
      "acp.agent.type": input.agent.type,
      "acp.protocol.direction": input.direction,
      "acp.protocol.has_error": hasJsonRpcError(input.message),
      "acp.protocol.id": jsonRpcId(input.message),
      "acp.protocol.method": jsonRpcMethod(input.message),
      "acp.protocol.transport": "stdio",
      "acp.session.cwd": input.cwd,
      "acp.session.id": jsonRpcSessionId(input.message),
    },
    body: observedLogBody({
      options: input.observability,
      redactContext: {
        kind: AcpRuntimeObservabilityRedactionKind.ProtocolMessage,
        sessionId: jsonRpcSessionId(input.message),
      },
      value: input.message,
    }),
    context: input.traceContext,
    eventName: "acp.protocol.message",
    severityNumber: hasJsonRpcError(input.message)
      ? SeverityNumber.WARN
      : SeverityNumber.DEBUG,
  });
}

function protocolMessageLoggingEnabled(
  traceContext: import("@opentelemetry/api").Context | undefined,
): boolean {
  return isRuntimeLogEnabled({
    context: traceContext,
    eventName: "acp.protocol.message",
    severityNumber: SeverityNumber.DEBUG,
  }) || isRuntimeLogEnabled({
    context: traceContext,
    eventName: "acp.protocol.message",
    severityNumber: SeverityNumber.WARN,
  });
}

function jsonRpcId(message: AnyMessage): string | number | undefined {
  const id = readMessageProperty(message, "id");
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

function jsonRpcMethod(message: AnyMessage): string | undefined {
  const method = readMessageProperty(message, "method");
  return typeof method === "string" ? method : undefined;
}

function jsonRpcSessionId(message: AnyMessage): string | undefined {
  const params = readMessageProperty(message, "params");
  if (!params || typeof params !== "object") {
    return undefined;
  }

  const sessionId = (params as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" ? sessionId : undefined;
}

function hasJsonRpcError(message: AnyMessage): boolean {
  return readMessageProperty(message, "error") !== undefined;
}

function readMessageProperty(message: AnyMessage, key: string): unknown {
  return message && typeof message === "object"
    ? (message as Record<string, unknown>)[key]
    : undefined;
}

function createExitWatcher(
  child: AgentProcess,
  context: {
    args?: string[];
    command: string;
    cwd: string;
    pid?: number;
  },
  stderrChunks: string[],
  isExpectedExit: () => boolean,
  getActiveOperationSummary: () => string | undefined,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (isExpectedExit()) {
        resolve();
        return;
      }

      const stderr = stderrChunks.join("").trim();
      reject(
        formatUnexpectedStdioExitError({
          activeOperationSummary: getActiveOperationSummary(),
          code,
          command: context.command,
          cwd: context.cwd,
          pid: context.pid,
          signal,
          stderr,
        }),
      );
    });
  });
}

function createStdioOperationTracker(): StdioOperationTracker {
  const counts = new Map<string, number>();

  return {
    start(operation: string) {
      counts.set(operation, (counts.get(operation) ?? 0) + 1);
    },
    end(operation: string) {
      const next = (counts.get(operation) ?? 0) - 1;
      if (next > 0) {
        counts.set(operation, next);
        return;
      }
      counts.delete(operation);
    },
    summary() {
      const active = [...counts.keys()];
      return active.length > 0 ? active.join(",") : undefined;
    },
  };
}

export function formatUnexpectedStdioExitError(input: {
  activeOperationSummary?: string;
  code: number | null;
  command: string;
  cwd: string;
  pid?: number;
  signal: NodeJS.Signals | null;
  stderr?: string;
}): Error {
  const parts = [
    "ACP stdio process exited unexpectedly",
    input.activeOperationSummary
      ? `during ${input.activeOperationSummary}`
      : "while idle",
    `command=${formatCommandForLog(input.command)}`,
    `cwd=${input.cwd}`,
  ];

  if (input.pid !== undefined) {
    parts.push(`pid=${input.pid}`);
  }

  parts.push(`code=${input.code}`);
  parts.push(`signal=${input.signal}`);

  const stderrTail = trimStderrTail(input.stderr);
  if (stderrTail) {
    parts.push(`stderr=${JSON.stringify(stderrTail)}`);
  }

  return new Error(parts.join("; "));
}

async function enhanceClosedConnectionError(
  error: unknown,
  onExit: Promise<void>,
  operationName: string,
): Promise<unknown> {
  if (!isClosedConnectionError(error)) {
    return error;
  }

  const exitError = await waitForExitError(onExit);
  if (exitError) {
    return exitError;
  }

  return new Error(`ACP connection closed during ${operationName}`, {
    cause: error,
  });
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };

    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function requireAgentStdio(child: ChildProcess): AgentProcess {
  if (!child.stdin || !child.stdout) {
    throw new Error("ACP stdio agent must be spawned with piped stdin/stdout");
  }

  return child as AgentProcess;
}

function isChildProcessRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function waitForChildExit(
  child: AgentProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (!isChildProcessRunning(child)) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(
      () => {
        finish(false);
      },
      Math.max(0, timeoutMs),
    );

    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      child.off("close", onExitLike);
      child.off("exit", onExitLike);
      clearTimeout(timer);
      resolve(value);
    };

    const onExitLike = () => {
      finish(true);
    };

    child.once("close", onExitLike);
    child.once("exit", onExitLike);
  });
}

async function terminateAgentProcess(child: AgentProcess): Promise<void> {
  if (!child.stdin.destroyed) {
    try {
      child.stdin.end();
    } catch {
      // best effort
    }
  }

  let exited = await waitForChildExit(
    child,
    DEFAULT_AGENT_CLOSE_AFTER_STDIN_END_MS,
  );
  if (!exited && isChildProcessRunning(child)) {
    try {
      child.kill("SIGTERM");
    } catch {
      // best effort
    }
    exited = await waitForChildExit(child, AGENT_CLOSE_TERM_GRACE_MS);
  }

  if (!exited && isChildProcessRunning(child)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // best effort
    }
    await waitForChildExit(child, AGENT_CLOSE_KILL_GRACE_MS).catch(() => false);
  }
}

function detachAgentHandles(child: AgentProcess): void {
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr?.destroy();
}

function basenameToken(command: string): string {
  const normalized = command.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function formatCommandForLog(command: string): string {
  return JSON.stringify(command);
}

function trimStderrTail(stderr: string | undefined): string | undefined {
  if (!stderr) {
    return undefined;
  }

  if (stderr.length <= STDERR_TAIL_LIMIT) {
    return stderr;
  }

  return `...${stderr.slice(-STDERR_TAIL_LIMIT)}`;
}

function isClosedConnectionError(error: unknown): error is Error {
  return error instanceof Error && error.message === "ACP connection closed";
}

async function waitForExitError(
  onExit: Promise<void>,
  timeoutMs: number = 250,
): Promise<Error | undefined> {
  return new Promise<Error | undefined>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(undefined);
    }, timeoutMs);

    const finish = (value: Error | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    void onExit.then(
      () => finish(undefined),
      (error) => finish(error instanceof Error ? error : new Error(String(error))),
    );
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
