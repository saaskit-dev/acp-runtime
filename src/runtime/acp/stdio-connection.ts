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
  emitRuntimeSuppressedError,
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

type NodeWritableLike = Pick<Writable, "destroy" | "end" | "off" | "on" | "write">;

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

type StdioStderrTail = {
  append(chunk: string): void;
  read(): string;
};

type StdioProcessLifecycleContext = {
  agent: AcpRuntimeAgent;
  cwd: string;
  pid?: number;
  startedAt: number;
  traceContext?: import("@opentelemetry/api").Context;
};

type StdioProcessLifecycleLogInput = StdioProcessLifecycleContext & {
  body: string;
  eventName: string;
  exitCode?: number | null;
  exitClassification?: string;
  exitKillCalled?: boolean;
  exitSignal?: NodeJS.Signals | null;
  operationSummary?: string;
  severityNumber?: SeverityNumber;
  signal?: NodeJS.Signals;
  stderrTail?: string;
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
    const processStartedAt = Date.now();
    const lifecycleContext = {
      agent: input.agent,
      cwd: input.cwd,
      pid: child.pid ?? undefined,
      startedAt: processStartedAt,
      traceContext: input.traceContext,
    };
    emitStdioProcessLifecycleLog({
      ...lifecycleContext,
      body: "ACP stdio process spawned.",
      eventName: "acp.stdio.process.spawned",
    });

    const stderrTail = createStdioStderrTail(STDERR_TAIL_LIMIT);
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrTail.append(chunk);
      });
    }

    const stream = createTappedStream(
      createNdJsonMessageStream(
        input.agent.command,
        nodeWritableToWeb(child.stdin, { preferNative: false }),
        nodeReadableToWeb(child.stdout, { preferNative: false }),
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
        startedAt: processStartedAt,
      },
      stderrTail,
      () => disposing,
      () => operationTracker.summary(),
      (code, signal, expected) => {
        const stderrOutput = stderrTail.read();
        emitStdioProcessLifecycleLog({
          ...lifecycleContext,
          body: expected
            ? "ACP stdio process exited during expected cleanup."
            : "ACP stdio process exited unexpectedly.",
          eventName: expected
            ? "acp.stdio.process.exit.expected"
            : "acp.stdio.process.exit.unexpected",
          exitClassification: classifyStdioProcessExit({
            expected,
            killCalled: child.killed,
            signal,
          }),
          exitCode: code,
          exitKillCalled: child.killed,
          exitSignal: signal,
          operationSummary: operationTracker.summary(),
          severityNumber: expected ? SeverityNumber.DEBUG : SeverityNumber.ERROR,
          stderrTail: stderrOutput,
        });
      },
    );
    void onExit.catch((error) => {
      emitRuntimeSuppressedError({
        attributes: {
          "acp.agent.command": input.agent.command,
          "acp.agent.type": input.agent.type,
          "acp.process.pid": child.pid ?? undefined,
          "acp.session.cwd": input.cwd,
        },
        body: "ACP stdio process exit rejection was not directly observed.",
        context: input.traceContext,
        eventName: "acp.stdio.exit.unobserved",
        exception: error,
        severityNumber: SeverityNumber.DEBUG,
      });
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
        emitStdioProcessLifecycleLog({
          ...lifecycleContext,
          body: "ACP stdio process dispose started.",
          eventName: "acp.stdio.process.dispose.started",
          operationSummary: operationTracker.summary(),
          severityNumber: SeverityNumber.DEBUG,
        });
        try {
          await terminateAgentProcess(
            child,
            lifecycleContext,
            operationTracker,
            (operation, error) => {
              emitRuntimeSuppressedError({
                attributes: {
                  "acp.agent.command": input.agent.command,
                  "acp.agent.type": input.agent.type,
                  "acp.process.cleanup.operation": operation,
                  "acp.process.pid": child.pid ?? undefined,
                  "acp.session.cwd": input.cwd,
                },
                body: "ACP stdio process cleanup failed.",
                context: input.traceContext,
                eventName: "acp.stdio.process.cleanup.failed",
                exception: error,
              });
            },
          );
          await onExit.catch((error) => {
            emitRuntimeSuppressedError({
              attributes: {
                "acp.agent.command": input.agent.command,
                "acp.agent.type": input.agent.type,
                "acp.process.pid": child.pid ?? undefined,
                "acp.session.cwd": input.cwd,
              },
              body: "ACP stdio process exit failed during dispose.",
              context: input.traceContext,
              eventName: "acp.stdio.dispose.exit.failed",
              exception: error,
            });
          });
        } finally {
          emitStdioProcessLifecycleLog({
            ...lifecycleContext,
            body: "ACP stdio process dispose finished.",
            eventName: "acp.stdio.process.dispose.finished",
            operationSummary: operationTracker.summary(),
            severityNumber: SeverityNumber.DEBUG,
          });
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

  const pendingOperations = new Set<{
    reject(error: Error): void;
  }>();
  let streamError: Error | undefined;
  let removeErrorListener: (() => void) | undefined;

  const failPendingOperations = (error: unknown) => {
    const normalized = normalizeWritableStreamError(error);
    streamError = streamError ?? normalized;
    for (const operation of [...pendingOperations]) {
      operation.reject(normalized);
    }
  };

  return new WritableStream<Uint8Array>({
    start(controller) {
      const onError = (error: unknown) => {
        failPendingOperations(error);
        try {
          controller.error(streamError);
        } catch {
          // The controller may already be closed or errored.
        }
      };
      stream.on("error", onError);
      removeErrorListener = () => {
        stream.off("error", onError);
      };
    },
    async write(chunk) {
      if (streamError) {
        throw streamError;
      }
      if (isWritableStreamClosed(stream)) {
        throw createAcpConnectionClosedError();
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const operation = {
          reject(error: Error) {
            finish(error);
          },
        };
        const finish = (error?: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          pendingOperations.delete(operation);
          if (error) {
            reject(normalizeWritableStreamError(error));
            return;
          }
          resolve();
        };
        pendingOperations.add(operation);
        try {
          stream.write(chunk, (error?: Error | null) => {
            finish(error);
          });
        } catch (error) {
          finish(error);
        }
      });
    },
    async close() {
      if (streamError) {
        throw streamError;
      }
      if (isWritableStreamClosed(stream)) {
        removeErrorListener?.();
        return;
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const operation = {
          reject(error: Error) {
            finish(error);
          },
        };
        const finish = (error?: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          pendingOperations.delete(operation);
          if (error) {
            reject(normalizeWritableStreamError(error));
            return;
          }
          resolve();
        };
        pendingOperations.add(operation);
        try {
          stream.end((error?: Error | null) => {
            finish(error);
          });
        } catch (error) {
          finish(error);
        }
      });
      removeErrorListener?.();
    },
    abort(reason) {
      removeErrorListener?.();
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
    unstable_forkSession: connection.unstable_forkSession
      ? (params) =>
          withExit(
            "unstable_forkSession",
            connection.unstable_forkSession(params),
          )
      : undefined,
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
          let lineStart = 0;
          while (true) {
            const lineEnd = content.indexOf("\n", lineStart);
            if (lineEnd === -1) {
              break;
            }
            enqueueNdJsonLine(
              agentCommand,
              controller,
              content.slice(lineStart, lineEnd),
            );
            lineStart = lineEnd + 1;
          }
          if (lineStart > 0) {
            content = content.slice(lineStart);
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });

  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  const writable = new WritableStream<AnyMessage>({
    start() {
      writer = output.getWriter();
    },
    async write(message) {
      const content = JSON.stringify(message) + "\n";
      if (!writer) {
        throw new Error("ACP connection closed");
      }
      await writer.write(textEncoder.encode(content));
    },
    async close() {
      if (!writer) {
        return;
      }
      try {
        await writer.close();
      } finally {
        writer.releaseLock();
        writer = undefined;
      }
    },
    async abort(reason) {
      if (!writer) {
        return;
      }
      try {
        await writer.abort(reason);
      } finally {
        writer.releaseLock();
        writer = undefined;
      }
    },
  });

  return { readable, writable };
}

function enqueueNdJsonLine(
  agentCommand: string,
  controller: ReadableStreamDefaultController<AnyMessage>,
  line: string,
): void {
  const trimmedLine = line.trim();
  if (
    !trimmedLine ||
    shouldIgnoreNonJsonAgentOutputLine(agentCommand, trimmedLine)
  ) {
    return;
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
    startedAt: number;
  },
  stderrTail: StdioStderrTail,
  isExpectedExit: () => boolean,
  getActiveOperationSummary: () => string | undefined,
  onExit: (
    code: number | null,
    signal: NodeJS.Signals | null,
    expected: boolean,
  ) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const expected = isExpectedExit();
      onExit(code, signal, expected);
      if (expected) {
        resolve();
        return;
      }

      const stderr = stderrTail.read();
      const classification = classifyStdioProcessExit({
        expected,
        killCalled: child.killed,
        signal,
      });
      reject(
        formatUnexpectedStdioExitError({
          activeOperationSummary: getActiveOperationSummary(),
          code,
          command: context.command,
          cwd: context.cwd,
          exitClassification: classification,
          killCalled: child.killed,
          pid: context.pid,
          signal,
          stderr,
          uptimeMs: Date.now() - context.startedAt,
        }),
      );
    });
  });
}

function createStdioStderrTail(limit: number): StdioStderrTail {
  let tail = "";
  return {
    append(chunk: string) {
      tail += chunk;
      if (tail.length > limit) {
        tail = tail.slice(-limit);
      }
    },
    read() {
      return tail.trim();
    },
  };
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
      const active = [...counts.entries()].map(([operation, count]) =>
        count > 1 ? `${operation}:${count}` : operation,
      );
      return active.length > 0 ? active.join(",") : undefined;
    },
  };
}

function classifyStdioProcessExit(input: {
  expected: boolean;
  killCalled: boolean;
  signal: NodeJS.Signals | null;
}): string {
  if (input.expected) {
    return "expected_cleanup";
  }
  if (input.signal === "SIGKILL" && !input.killCalled) {
    return "external_sigkill_or_os_oom";
  }
  if (input.signal && !input.killCalled) {
    return "external_signal";
  }
  if (input.killCalled) {
    return "runtime_requested_kill";
  }
  return "unexpected_exit";
}

export function emitStdioProcessLifecycleLog(
  input: StdioProcessLifecycleLogInput,
): void {
  const memory = process.memoryUsage();
  emitRuntimeLog({
    attributes: {
      "acp.agent.command": input.agent.command,
      "acp.agent.args.count": input.agent.args?.length,
      "acp.agent.env.keys": input.agent.env
        ? Object.keys(input.agent.env).sort().join(",")
        : undefined,
      "acp.agent.type": input.agent.type,
      "acp.process.exit.classification": input.exitClassification,
      "acp.process.exit.code": input.exitCode ?? undefined,
      "acp.process.exit.kill_called": input.exitKillCalled,
      "acp.process.exit.signal": input.exitSignal ?? undefined,
      "acp.process.operation.active": input.operationSummary,
      "acp.process.pid": input.pid,
      "acp.process.signal": input.signal,
      "acp.process.stderr.tail": input.stderrTail,
      "acp.process.uptime_ms": Math.max(0, Date.now() - input.startedAt),
      "acp.runtime.memory.array_buffers_bytes": memory.arrayBuffers,
      "acp.runtime.memory.external_bytes": memory.external,
      "acp.runtime.memory.heap_total_bytes": memory.heapTotal,
      "acp.runtime.memory.heap_used_bytes": memory.heapUsed,
      "acp.runtime.memory.rss_bytes": memory.rss,
      "acp.session.cwd": input.cwd,
    },
    body: input.body,
    context: input.traceContext,
    eventName: input.eventName,
    severityNumber: input.severityNumber ?? SeverityNumber.INFO,
  });
}

export function formatUnexpectedStdioExitError(input: {
  activeOperationSummary?: string;
  code: number | null;
  command: string;
  cwd: string;
  exitClassification?: string;
  killCalled?: boolean;
  pid?: number;
  signal: NodeJS.Signals | null;
  stderr?: string;
  uptimeMs?: number;
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
  if (input.killCalled !== undefined) {
    parts.push(`killCalled=${input.killCalled}`);
  }
  if (input.exitClassification) {
    parts.push(`classification=${input.exitClassification}`);
  }
  if (input.uptimeMs !== undefined) {
    parts.push(`uptimeMs=${Math.max(0, Math.round(input.uptimeMs))}`);
  }

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

async function terminateAgentProcess(
  child: AgentProcess,
  lifecycleContext: StdioProcessLifecycleContext,
  operationTracker: StdioOperationTracker,
  onCleanupError: (operation: string, error: unknown) => void = () => {},
): Promise<void> {
  if (!child.stdin.destroyed) {
    try {
      emitStdioProcessLifecycleLog({
        ...lifecycleContext,
        body: "ACP stdio process stdin end requested.",
        eventName: "acp.stdio.process.stdin.end",
        operationSummary: operationTracker.summary(),
        severityNumber: SeverityNumber.DEBUG,
      });
      child.stdin.end();
    } catch (error) {
      onCleanupError("stdin.end", error);
    }
  }

  let exited = await waitForChildExit(
    child,
    DEFAULT_AGENT_CLOSE_AFTER_STDIN_END_MS,
  );
  if (!exited && isChildProcessRunning(child)) {
    try {
      emitStdioProcessLifecycleLog({
        ...lifecycleContext,
        body: "ACP stdio process SIGTERM sent.",
        eventName: "acp.stdio.process.kill.sent",
        operationSummary: operationTracker.summary(),
        signal: "SIGTERM",
      });
      child.kill("SIGTERM");
    } catch (error) {
      onCleanupError("kill.SIGTERM", error);
    }
    exited = await waitForChildExit(child, AGENT_CLOSE_TERM_GRACE_MS);
  }

  if (!exited && isChildProcessRunning(child)) {
    try {
      emitStdioProcessLifecycleLog({
        ...lifecycleContext,
        body: "ACP stdio process SIGKILL sent.",
        eventName: "acp.stdio.process.kill.sent",
        operationSummary: operationTracker.summary(),
        severityNumber: SeverityNumber.WARN,
        signal: "SIGKILL",
      });
      child.kill("SIGKILL");
    } catch (error) {
      onCleanupError("kill.SIGKILL", error);
    }
    await waitForChildExit(child, AGENT_CLOSE_KILL_GRACE_MS).catch((error) => {
      onCleanupError("wait.SIGKILL", error);
      return false;
    });
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

function createAcpConnectionClosedError(cause?: unknown): Error {
  return cause === undefined
    ? new Error("ACP connection closed")
    : new Error("ACP connection closed", { cause });
}

function normalizeWritableStreamError(error: unknown): Error {
  const normalized = toError(error) ?? new Error("Writable stream failed.");
  return isWritableStreamClosedError(normalized)
    ? createAcpConnectionClosedError(normalized)
    : normalized;
}

function isWritableStreamClosed(stream: NodeWritableLike): boolean {
  const state = stream as {
    destroyed?: boolean;
    writableDestroyed?: boolean;
    writableEnded?: boolean;
  };
  return Boolean(state.destroyed || state.writableDestroyed || state.writableEnded);
}

function isWritableStreamClosedError(error: Error): boolean {
  const code = (error as { code?: unknown }).code;
  return (
    code === "EPIPE" ||
    code === "ECONNRESET" ||
    code === "ERR_STREAM_DESTROYED" ||
    code === "ERR_STREAM_WRITE_AFTER_END" ||
    error.message === "write after end"
  );
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
