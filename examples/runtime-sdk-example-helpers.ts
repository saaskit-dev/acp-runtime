import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  AcpRuntime,
  AcpRuntimeJsonSessionRegistryStore,
  AcpRuntimeSessionRegistry,
  type AcpRuntimeAuthorityHandlers,
  type AcpRuntimePrompt,
  type AcpRuntimeSession,
  type AcpRuntimeStreamOptions,
  type AcpRuntimeTurnEvent,
  createStdioAcpConnectionFactory,
} from "@saaskit-dev/acp-runtime";

export const DEFAULT_EXAMPLE_AGENT_ID = "simulator-agent-acp-local";

type MemoryTerminal = {
  exitCode: number | null;
  output: string;
};

export async function createExampleRuntime(input: {
  registryPath?: string;
} = {}): Promise<AcpRuntime> {
  const registryPath = resolve(
    process.cwd(),
    input.registryPath ?? ".tmp/runtime-sdk-examples/session-registry.json",
  );
  await mkdir(dirname(registryPath), { recursive: true });

  const registry = new AcpRuntimeSessionRegistry({
    store: new AcpRuntimeJsonSessionRegistryStore(registryPath),
  });

  return new AcpRuntime(createStdioAcpConnectionFactory(), { registry });
}

export function createExampleHandlers(input: {
  files?: Record<string, string>;
} = {}): AcpRuntimeAuthorityHandlers {
  const files = new Map(Object.entries(input.files ?? {}));
  const terminals = new Map<string, MemoryTerminal>();
  let terminalCount = 0;

  return {
    authentication: ({ methods }) =>
      methods[0] ? { methodId: methods[0].id } : { cancel: true },
    filesystem: {
      async readTextFile(path: string): Promise<string> {
        return files.get(path) ?? "";
      },
      async writeTextFile(input): Promise<void> {
        files.set(input.path, input.content);
      },
    },
    permission: () => ({ decision: "allow", scope: "session" }),
    terminal: {
      async kill(terminalId: string): Promise<void> {
        const terminal = terminals.get(terminalId);
        if (terminal) {
          terminal.exitCode = terminal.exitCode ?? 137;
        }
      },
      async output(terminalId: string) {
        const terminal = terminals.get(terminalId);
        return {
          exitCode: terminal?.exitCode ?? null,
          output: terminal?.output ?? "",
          truncated: false,
        };
      },
      async release(_terminalId: string): Promise<void> {},
      async start(request) {
        const terminalId = `example-terminal-${++terminalCount}`;
        terminals.set(terminalId, {
          exitCode: 0,
          output: `${request.command}${request.args?.length ? ` ${request.args.join(" ")}` : ""}\n`,
        });
        return { terminalId };
      },
      async wait(terminalId: string) {
        return {
          exitCode: terminals.get(terminalId)?.exitCode ?? 0,
        };
      },
    },
  };
}

export async function startRegistryExampleSession(input: {
  agentId?: string;
  cwd?: string;
  handlers?: AcpRuntimeAuthorityHandlers;
  registryPath?: string;
} = {}): Promise<{
  handlers: AcpRuntimeAuthorityHandlers;
  runtime: AcpRuntime;
  session: AcpRuntimeSession;
}> {
  const runtime = await createExampleRuntime({
    registryPath: input.registryPath,
  });
  const handlers = input.handlers ?? createExampleHandlers();
  const session = await runtime.sessions.registry.start({
    agentId: input.agentId ?? DEFAULT_EXAMPLE_AGENT_ID,
    cwd: input.cwd ?? process.cwd(),
    handlers,
  });
  return { handlers, runtime, session };
}

export async function collectTurnEvents(
  session: AcpRuntimeSession,
  prompt: AcpRuntimePrompt,
  options?: AcpRuntimeStreamOptions,
): Promise<readonly AcpRuntimeTurnEvent[]> {
  const events: AcpRuntimeTurnEvent[] = [];
  for await (const event of session.turn.stream(prompt, options)) {
    events.push(event);
  }
  return events;
}
