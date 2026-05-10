import { stdout as output } from "node:process";
import { clearLine, cursorTo } from "node:readline";
import type { Interface } from "node:readline/promises";

export type RuntimeCliOutputGate = {
  beginPrompt(rl: Interface, promptText: string): void;
  clearStatus(): void;
  endPrompt(): void;
  flush(): void;
  pause(): void;
  print(line: string): void;
  record(line: string): void;
  resume(): void;
  setStatus(line: string): void;
};

export type RuntimeCliOutputGateOptions = {
  onLine?: ((line: string) => void) | undefined;
};

export type RuntimeCliInputCoordinator = {
  close(): void;
  nextUserInput(): Promise<string>;
  promptExclusive(input: {
    promptText: string;
    promptToken?: string;
  }): Promise<string>;
};

type PendingPrompt = {
  promptText: string;
  promptToken: string;
  reject: (error: unknown) => void;
  resolve: (value: string) => void;
};

export function createOutputGate(
  options: RuntimeCliOutputGateOptions = {},
): RuntimeCliOutputGate {
  let paused = false;
  const buffered: string[] = [];
  let statusLine: string | undefined;
  let promptState:
    | {
        promptText: string;
        rl: Interface;
      }
    | undefined;

  function redrawPrompt(): void {
    if (!output.isTTY || !promptState) {
      return;
    }

    const state = promptState.rl as unknown as {
      cursor?: number;
      line?: string;
    };
    const line = state.line ?? "";
    const cursor = state.cursor ?? line.length;
    output.write(`${promptState.promptText}${line}`);
    cursorTo(output, promptState.promptText.length + cursor);
  }

  function writeImmediate(line: string): void {
    clearStatusLine();
    if (output.isTTY && promptState) {
      clearLine(output, 0);
      cursorTo(output, 0);
      output.write(`${line}\n`);
      options.onLine?.(line);
      redrawPrompt();
      return;
    }

    output.write(`${line}\n`);
    options.onLine?.(line);
    redrawStatusLine();
  }

  function clearStatusLine(): void {
    if (!output.isTTY || !statusLine || promptState) {
      return;
    }
    clearLine(output, 0);
    cursorTo(output, 0);
  }

  function redrawStatusLine(): void {
    if (!output.isTTY || !statusLine || promptState) {
      return;
    }
    clearLine(output, 0);
    cursorTo(output, 0);
    output.write(statusLine);
  }

  return {
    beginPrompt(rl: Interface, promptText: string) {
      clearStatusLine();
      promptState = { promptText, rl };
    },
    clearStatus() {
      clearStatusLine();
      statusLine = undefined;
    },
    endPrompt() {
      promptState = undefined;
      redrawStatusLine();
    },
    flush() {
      while (buffered.length > 0) {
        writeImmediate(buffered.shift()!);
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
      writeImmediate(line);
    },
    record(line: string) {
      options.onLine?.(line);
    },
    resume() {
      paused = false;
      this.flush();
    },
    setStatus(line: string) {
      if (!output.isTTY || paused) {
        return;
      }
      if (promptState) {
        statusLine = line;
        return;
      }
      clearStatusLine();
      statusLine = line;
      redrawStatusLine();
    },
  };
}

export function createInputCoordinator(
  rl: Interface,
  outputGate: RuntimeCliOutputGate,
): RuntimeCliInputCoordinator {
  let closed = false;
  let pendingUserInput:
    | {
        reject: (error: unknown) => void;
        resolve: (value: string) => void;
      }
    | undefined;
  let pendingPrompt: PendingPrompt | undefined;
  const queuedPrompts: PendingPrompt[] = [];
  let savedUserDraft = "";

  function readCurrentLine(): string {
    const state = rl as unknown as { line?: string };
    return state.line ?? "";
  }

  function clearCurrentPromptLine(): void {
    if (!output.isTTY) {
      return;
    }
    clearLine(output, 0);
    cursorTo(output, 0);
  }

  function showUserPrompt(initialLine = ""): void {
    if (!pendingUserInput || pendingPrompt || closed) {
      return;
    }

    rl.setPrompt("you> ");
    outputGate.beginPrompt(rl, "you> ");
    rl.prompt();
    if (initialLine.length > 0) {
      rl.write(initialLine);
    }
  }

  function showExclusivePrompt(request: PendingPrompt): void {
    if (closed) {
      return;
    }

    outputGate.pause();
    outputGate.endPrompt();
    clearCurrentPromptLine();
    output.write(`${request.promptText}\n`);
    outputGate.record(request.promptText);
    rl.setPrompt(request.promptToken);
    rl.prompt();
  }

  function startNextPrompt(): void {
    if (pendingPrompt || queuedPrompts.length === 0 || closed) {
      return;
    }

    pendingPrompt = queuedPrompts.shift()!;
    showExclusivePrompt(pendingPrompt);
  }

  rl.on("line", (line) => {
    if (pendingPrompt) {
      const request = pendingPrompt;
      pendingPrompt = undefined;
      outputGate.resume();
      request.resolve(line);
      if (queuedPrompts.length > 0) {
        startNextPrompt();
        return;
      }
      if (pendingUserInput) {
        const draft = savedUserDraft;
        savedUserDraft = "";
        showUserPrompt(draft);
      }
      return;
    }

    if (pendingUserInput) {
      const request = pendingUserInput;
      pendingUserInput = undefined;
      outputGate.endPrompt();
      savedUserDraft = "";
      request.resolve(line);
    }
  });

  return {
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      outputGate.endPrompt();
      pendingUserInput?.reject(new Error("Input coordinator closed."));
      pendingPrompt?.reject(new Error("Input coordinator closed."));
      for (const request of queuedPrompts.splice(0)) {
        request.reject(new Error("Input coordinator closed."));
      }
      pendingUserInput = undefined;
      pendingPrompt = undefined;
    },
    nextUserInput(): Promise<string> {
      if (closed) {
        throw new Error("Input coordinator closed.");
      }
      if (pendingUserInput) {
        throw new Error("User input prompt already active.");
      }
      return new Promise<string>((resolve, reject) => {
        pendingUserInput = { reject, resolve };
        showUserPrompt();
      });
    },
    promptExclusive(input): Promise<string> {
      if (closed) {
        throw new Error("Input coordinator closed.");
      }
      return new Promise<string>((resolve, reject) => {
        const request: PendingPrompt = {
          promptText: input.promptText,
          promptToken: input.promptToken ?? "> ",
          reject,
          resolve,
        };
        if (pendingPrompt) {
          queuedPrompts.push(request);
          return;
        }
        if (pendingUserInput) {
          savedUserDraft = readCurrentLine();
        }
        pendingPrompt = request;
        showExclusivePrompt(request);
      });
    },
  };
}
