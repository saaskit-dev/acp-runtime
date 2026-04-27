import { spawn } from "node:child_process";
import { stdout as output } from "node:process";
import type { Interface } from "node:readline/promises";
import { SeverityNumber } from "@opentelemetry/api-logs";

import {
  resolveRuntimeTerminalAuthenticationRequest,
  runtimeAuthenticationTerminalSuccessPatterns,
  selectRuntimeAuthenticationMethod,
  type AcpRuntimeAuthenticationMethod,
  type AcpRuntimeAuthorityHandlers,
  type AcpRuntimeTerminalAuthenticationRequest,
} from "@saaskit-dev/acp-runtime";
import type { DemoInputCoordinator } from "./runtime-demo-input.js";
import type { DemoLogSink } from "./runtime-demo-log-sink.js";

type DemoTimelineRenderer = {
  writeLine(label: string, detail: string): void;
};

type DemoTerminalAuthenticationRequest = AcpRuntimeTerminalAuthenticationRequest & {
  successPatterns?: readonly string[];
};

export async function promptForDemoAuthentication(
  input: {
    inputCoordinator: DemoInputCoordinator;
    logSink: DemoLogSink;
    renderer: DemoTimelineRenderer;
    request: Parameters<
      NonNullable<AcpRuntimeAuthorityHandlers["authentication"]>
    >[0];
    rl: Interface;
  },
): Promise<{ cancel: true } | { methodId: string }> {
  const method = await promptForAuthenticationMethod(
    input.inputCoordinator,
    input.request.methods,
  );
  if (!method) {
    input.logSink.emit({
      attributes: {
        "acp.agent.type": input.request.agent.type,
      },
      body: "Authentication cancelled.",
      eventName: "acp.demo.authentication.cancelled",
      severityNumber: SeverityNumber.WARN,
    });
    return { cancel: true };
  }

  const terminalRequest = resolveDemoTerminalAuthenticationRequest({
    agent: input.request.agent,
    method,
  });
  if (terminalRequest) {
    input.logSink.emit({
      attributes: {
        "acp.auth.method_id": method.id,
        "acp.auth.method_type": method.type,
      },
      body: terminalRequest.label,
      eventName: "acp.demo.authentication.started",
    });
    input.renderer.writeLine("auth", `start ${terminalRequest.label}`);
    await runTerminalAuthentication(input.rl, terminalRequest);
    input.renderer.writeLine("auth", `completed ${terminalRequest.label}`);
  } else if (method.type === "env_var") {
    throw new Error(
      `Authentication method "${method.title}" requires env vars and is not supported by this demo CLI yet.`,
    );
  }

  input.logSink.emit({
    attributes: {
      "acp.auth.method_id": method.id,
      "acp.auth.method_type": method.type,
    },
    body: method.title,
    eventName: "acp.demo.authentication.selected",
  });
  return { methodId: method.id };
}

export function resolveDemoTerminalAuthenticationRequest(input: {
  agent: Parameters<
    NonNullable<AcpRuntimeAuthorityHandlers["authentication"]>
  >[0]["agent"];
  method: AcpRuntimeAuthenticationMethod;
}): DemoTerminalAuthenticationRequest | undefined {
  const request = resolveRuntimeTerminalAuthenticationRequest(input);
  if (!request) {
    return undefined;
  }

  return {
    ...request,
    successPatterns: runtimeAuthenticationTerminalSuccessPatterns(input.method),
  };
}

async function promptForAuthenticationMethod(
  inputCoordinator: DemoInputCoordinator,
  methods: readonly AcpRuntimeAuthenticationMethod[],
): Promise<AcpRuntimeAuthenticationMethod | undefined> {
  if (methods.length === 0) {
    return undefined;
  }

  if (methods.length === 1) {
    return methods[0];
  }

  const defaultMethod = selectRuntimeAuthenticationMethod(methods);
  if (defaultMethod) {
    console.log(
      `[runtime] authentication default: ${defaultMethod.title} (${defaultMethod.id})`,
    );
    return defaultMethod;
  }

  while (true) {
    const choices = methods
      .map((method, index) => {
        const type = method.type === "env_var"
          ? "env"
          : method.type === "terminal"
            ? "terminal"
            : "agent";
        const description = method.description ? ` — ${method.description}` : "";
        return `${index + 1}. ${method.title} [${type}]${description}`;
      })
      .join("\n");
    const answer = (
      await inputCoordinator.promptExclusive({
        promptText: `authentication required\n${choices}\nchoose method [1-${methods.length}] or [n] cancel`,
      })
    )
      .trim()
      .toLowerCase();

    if (answer === "n" || answer === "no" || answer === "/exit") {
      return undefined;
    }

    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= methods.length) {
      return methods[index - 1];
    }

    console.log(`Enter a number between 1 and ${methods.length}, or n.`);
  }
}

async function runTerminalAuthentication(
  rl: Interface,
  request: DemoTerminalAuthenticationRequest,
): Promise<void> {
  pauseReadlineIfOpen(rl);
  console.log(`[runtime] auth: ${request.label}`);

  const child = spawn(request.command, [...request.args], {
    env: {
      ...process.env,
      ...(request.env ?? {}),
    },
    stdio: ["inherit", "pipe", "pipe"],
    windowsHide: true,
  });
  const signalCancellation = createTerminalAuthenticationSignalCancellation(
    child,
    request,
  );

  let transcript = "";
  const appendOutput = (chunk: string) => {
    transcript += chunk;
  };

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    appendOutput(chunk);
    output.write(chunk);
  });
  child.stderr?.on("data", (chunk: string) => {
    appendOutput(chunk);
    output.write(chunk);
  });

  try {
    await waitForTerminalAuthentication(
      child,
      () => transcript,
      request,
      signalCancellation.promise,
    );
  } finally {
    signalCancellation.dispose();
    await terminateTerminalAuthenticationProcess(child);
    resumeReadlineIfOpen(rl);
  }
}

function pauseReadlineIfOpen(rl: Interface): void {
  try {
    rl.pause();
  } catch (error) {
    if (!isReadlineClosedError(error)) {
      throw error;
    }
  }
}

function resumeReadlineIfOpen(rl: Interface): void {
  try {
    rl.resume();
  } catch (error) {
    if (!isReadlineClosedError(error)) {
      throw error;
    }
  }
}

function isReadlineClosedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_USE_AFTER_CLOSE"
  );
}

type TerminalAuthenticationCancellation = {
  signal: NodeJS.Signals;
};

class TerminalAuthenticationInterruptedError extends Error {
  readonly exitCode = 130;

  constructor(label: string, signal: NodeJS.Signals) {
    super(`Authentication command "${label}" cancelled by ${signal}.`);
    this.name = "TerminalAuthenticationInterruptedError";
  }
}

async function waitForTerminalAuthentication(
  child: import("node:child_process").ChildProcessByStdio<
    null,
    import("node:stream").Readable,
    import("node:stream").Readable
  >,
  getTranscript: () => string,
  request: DemoTerminalAuthenticationRequest,
  cancellation: Promise<TerminalAuthenticationCancellation>,
): Promise<void> {
  const exitPromise = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });

  if (!request.successPatterns || request.successPatterns.length === 0) {
    const result = await Promise.race([
      exitPromise.then((code) => ({ code, kind: "exit" as const })),
      cancellation.then((value) => ({ ...value, kind: "cancelled" as const })),
    ]);
    if (result.kind === "cancelled") {
      throw new TerminalAuthenticationInterruptedError(
        request.label,
        result.signal,
      );
    }
    const code = result.code;
    if (code !== 0) {
      throw new Error(
        `Authentication command "${request.label}" failed with exit code ${code ?? "<none>"}.`,
      );
    }
    return;
  }

  const successPromise = new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const transcript = getTranscript();
      if (request.successPatterns?.some((pattern) => transcript.includes(pattern))) {
        clearInterval(timer);
        resolve();
      }
    }, 250);
    child.once("close", () => clearInterval(timer));
  });

  const result = await Promise.race([
    successPromise.then(() => "success" as const),
    exitPromise.then((code) => ({ code, kind: "exit" as const })),
    cancellation.then((value) => ({ ...value, kind: "cancelled" as const })),
  ]);

  if (result === "success") {
    child.kill("SIGTERM");
    return;
  }

  if (result.kind === "cancelled") {
    throw new TerminalAuthenticationInterruptedError(
      request.label,
      result.signal,
    );
  }

  throw new Error(
    `Authentication command "${request.label}" exited before success was detected (exit=${result.code ?? "<none>"}).`,
  );
}

function createTerminalAuthenticationSignalCancellation(
  child: import("node:child_process").ChildProcess,
  request: DemoTerminalAuthenticationRequest,
): {
  dispose(): void;
  promise: Promise<TerminalAuthenticationCancellation>;
} {
  let settled = false;
  let resolveCancellation: (value: TerminalAuthenticationCancellation) => void;
  const promise = new Promise<TerminalAuthenticationCancellation>((resolve) => {
    resolveCancellation = resolve;
  });

  const onSignal = (signal: NodeJS.Signals) => {
    if (settled) {
      return;
    }
    settled = true;
    console.log(`[runtime] auth: cancelling ${request.label} (${signal})`);
    try {
      child.kill(signal);
    } catch {
      // best effort; the finalizer escalates if the child ignores the signal.
    }
    resolveCancellation({ signal });
  };

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  return {
    dispose() {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    },
    promise,
  };
}

async function terminateTerminalAuthenticationProcess(
  child: import("node:child_process").ChildProcess,
): Promise<void> {
  if (!isTerminalAuthenticationProcessRunning(child)) {
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    // best effort
  }

  if (await waitForTerminalAuthenticationExit(child, 1_500)) {
    return;
  }

  if (isTerminalAuthenticationProcessRunning(child)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // best effort
    }
    await waitForTerminalAuthenticationExit(child, 1_000);
  }
}

function isTerminalAuthenticationProcessRunning(
  child: import("node:child_process").ChildProcess,
): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function waitForTerminalAuthenticationExit(
  child: import("node:child_process").ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (!isTerminalAuthenticationProcessRunning(child)) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off("close", onExit);
      child.off("exit", onExit);
      resolve(value);
    };
    const onExit = () => {
      finish(true);
    };

    child.once("close", onExit);
    child.once("exit", onExit);
  });
}
