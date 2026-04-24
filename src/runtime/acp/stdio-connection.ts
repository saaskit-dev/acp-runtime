import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  type AnyMessage,
} from "@agentclientprotocol/sdk";

import type {
  AcpConnection,
  AcpConnectionFactory,
} from "./connection-types.js";

const QODER_BENIGN_STDOUT_LINES = new Set([
  "Received interrupt signal. Cleaning up resources...",
  "Cleanup completed. Exiting...",
]);

export type StdioFactoryOptions = {
  stderr?: "ignore" | "inherit" | "pipe";
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

export function createStdioAcpConnectionFactory(
  options: StdioFactoryOptions = {},
): AcpConnectionFactory {
  return async (input) => {
    let disposing = false;
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
      options.onAcpMessage,
    );
    const sdkConnection = new ClientSideConnection(() => input.client, stream);

    const onExit = createExitWatcher(child, stderrChunks, () => disposing);
    void onExit.catch(() => {
      // Observed by wrapped requests/closed; suppress global unhandled rejection noise.
    });
    const connection = wrapConnectionWithExit(sdkConnection, onExit);
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
): AcpConnection {
  const exitFailure = onExit.then<never>(
    () => new Promise<never>(() => {}),
    (error) => Promise.reject(error),
  );
  const withExit = <T>(operation: Promise<T>): Promise<T> =>
    Promise.race([operation, exitFailure]);
  const signal = createConnectionSignal(connection.signal, onExit);
  const closed = Promise.race([connection.closed, onExit]);

  return {
    signal,
    closed,
    authenticate(params) {
      return withExit(connection.authenticate(params));
    },
    cancel(params) {
      return withExit(connection.cancel(params));
    },
    initialize(params) {
      return withExit(connection.initialize(params));
    },
    listSessions: connection.listSessions
      ? (params) => withExit(connection.listSessions(params))
      : undefined,
    loadSession: connection.loadSession
      ? (params) => withExit(connection.loadSession(params))
      : undefined,
    newSession(params) {
      return withExit(connection.newSession(params));
    },
    prompt(params) {
      return withExit(connection.prompt(params));
    },
    setSessionConfigOption: connection.setSessionConfigOption
      ? (params) => withExit(connection.setSessionConfigOption(params))
      : undefined,
    setSessionMode: connection.setSessionMode
      ? (params) => withExit(connection.setSessionMode(params))
      : undefined,
    unstable_closeSession: connection.unstable_closeSession
      ? (params) => withExit(connection.unstable_closeSession(params))
      : undefined,
    unstable_resumeSession: connection.unstable_resumeSession
      ? (params) => withExit(connection.unstable_resumeSession(params))
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
  onAcpMessage:
    | ((direction: "inbound" | "outbound", message: AnyMessage) => void)
    | undefined,
): {
  readable: ReadableStream<AnyMessage>;
  writable: WritableStream<AnyMessage>;
} {
  if (!onAcpMessage) {
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
            onAcpMessage("inbound", value);
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
        onAcpMessage("outbound", message);
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

function createExitWatcher(
  child: AgentProcess,
  stderrChunks: string[],
  isExpectedExit: () => boolean,
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
        new Error(
          stderr.length > 0
            ? `ACP stdio process exited unexpectedly: ${stderr}`
            : `ACP stdio process exited unexpectedly with code=${code} signal=${signal}`,
        ),
      );
    });
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
