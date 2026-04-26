import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AcpPermissionDeniedError,
  AcpRuntime,
  type AcpRuntimeSession,
  type AcpRuntimeTurnEvent,
  createClaudeCodeAcpAgent,
  createStdioAcpConnectionFactory,
  resolveRuntimeAgentFromRegistry,
} from "../index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (path) => {
      await rm(path, { force: true, recursive: true });
    }),
  );
});

function shouldSkipClaudeCodeContract(): boolean {
  return process.env.ACP_RUNTIME_SKIP_CLAUDE_CODE_TEST === "1";
}

function isCommandInPath(command: string): boolean {
  const which = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(which, [command], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0;
}

async function resolveClaudeCodeContractAgent() {
  if (shouldSkipClaudeCodeContract()) {
    return {
      skipReason: "ACP_RUNTIME_SKIP_CLAUDE_CODE_TEST=1",
    } as const;
  }

  if (process.env.ACP_RUNTIME_RUN_CLAUDE_CODE_TEST === "1") {
    return {
      createSession(runtime: AcpRuntime, cwd: string) {
        return runtime.sessions.start({
          agent: createClaudeCodeAcpAgent({ via: "npx" }),
          cwd,
        });
      },
    } as const;
  }

  try {
    const resolvedAgent = await resolveRuntimeAgentFromRegistry("claude-acp");
    if (
      resolvedAgent.command === "npx" &&
      !isCommandInPath("claude-agent-acp")
    ) {
      return {
        skipReason:
          "claude-agent-acp is not installed locally; skipping registry-backed npx launch that would require package download. Set ACP_RUNTIME_RUN_CLAUDE_CODE_TEST=1 to force it.",
      } as const;
    }

    return {
      createSession(runtime: AcpRuntime, cwd: string) {
        return runtime.sessions.start({
          agent: "claude-acp",
          cwd,
        });
      },
    } as const;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      skipReason: `failed to resolve claude-acp launch from ACP registry: ${message}`,
    } as const;
  }
}

function isClaudeInternalError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("internal error");
}

async function retryClaudeLifecycle<T>(
  operation: (attempt: number) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (!isClaudeInternalError(error) || attempt === 3) {
        throw error;
      }
    }
  }

  throw lastError;
}

describe("AcpRuntime x Claude Code ACP", () => {
  it(
    "creates a Claude Code ACP session over stdio",
    async (context) => {
      const resolution = await resolveClaudeCodeContractAgent();
      if ("skipReason" in resolution) {
        context.skip(resolution.skipReason);
      }

      await retryClaudeLifecycle(async (attempt) => {
        const cwd = await mkdtemp(join(tmpdir(), "acp-runtime-claude-"));
        tempDirs.push(cwd);
        const trace: string[] = [];
        const runtime = new AcpRuntime(
          createStdioAcpConnectionFactory({
            onAcpMessage(direction, message) {
              trace.push(
                `${direction}: ${JSON.stringify(message)}`,
              );
            },
            stderr: "pipe",
          }),
        );
        let stage = "create";
        let session: AcpRuntimeSession | undefined;

        try {
          trace.push(`attempt=${attempt} stage=${stage}`);
          session = await resolution.createSession(runtime, cwd);

          expect(session.metadata.id).toBeTruthy();
          expect(
            session.agent.listModes().some((mode) => mode.id === "plan"),
          ).toBe(true);
          expect(
            session.agent.listConfigOptions().some((option) => option.id === "model"),
          ).toBe(true);
          const firstEvents: AcpRuntimeTurnEvent[] = [];

          stage = "send";
          trace.push(`attempt=${attempt} stage=${stage}`);
          const result = await session.turn.send("Reply with exactly the word READY.", {
            onEvent(event) {
              firstEvents.push(event);
              trace.push(`event: ${JSON.stringify(event)}`);
            },
          });
          expect(result.outputText).toContain("READY");
          expect(firstEvents.some((event) => event.type === "started")).toBe(true);
          expect(firstEvents.some((event) => event.type === "completed")).toBe(true);

          const defaultDeniedEvents: AcpRuntimeTurnEvent[] = [];
          stage = "default-permission-denied";
          trace.push(`attempt=${attempt} stage=${stage}`);
          await expect(
            session.turn.send(
              "Write the exact text 'denied' into ./claude-default-denied.txt using tools, then report success.",
              {
                onEvent(event) {
                  defaultDeniedEvents.push(event);
                  trace.push(`event: ${JSON.stringify(event)}`);
                },
              },
            ),
          ).rejects.toBeInstanceOf(AcpPermissionDeniedError);
          expect(
            defaultDeniedEvents.some((event) => event.type === "permission_requested"),
          ).toBe(true);
          expect(
            defaultDeniedEvents.some(
              (event) =>
                event.type === "operation_failed" &&
                event.operation.permission?.family === "permission_request_end_turn",
            ),
          ).toBe(true);

          stage = "set-raw-mode";
          trace.push(`attempt=${attempt} stage=${stage}`);
          await session.agent.setMode("plan");
          expect(session.metadata.currentModeId).toBe("plan");

          stage = "set-dontask-mode";
          trace.push(`attempt=${attempt} stage=${stage}`);
          await session.agent.setMode("dontAsk");
          expect(session.metadata.currentModeId).toBe("dontAsk");

          const modeDeniedEvents: AcpRuntimeTurnEvent[] = [];
          stage = "mode-denied";
          trace.push(`attempt=${attempt} stage=${stage}`);
          await expect(
            session.turn.send(
              "Write the exact text 'denied' into ./claude-dontask-denied.txt using tools, then report success.",
              {
                onEvent(event) {
                  modeDeniedEvents.push(event);
                  trace.push(`event: ${JSON.stringify(event)}`);
                },
              },
            ),
          ).rejects.toBeInstanceOf(AcpPermissionDeniedError);
          expect(
            modeDeniedEvents.some((event) => event.type === "permission_requested"),
          ).toBe(false);
          expect(
            modeDeniedEvents.some(
              (event) =>
                event.type === "operation_failed" &&
                event.operation.permission?.family === "mode_denied",
            ),
          ).toBe(true);

          stage = "set-bypass-mode";
          trace.push(`attempt=${attempt} stage=${stage}`);
          await session.agent.setMode("bypassPermissions");
          expect(session.metadata.currentModeId).toBe("bypassPermissions");
          expect(session.status).toBe("ready");
        } catch (error) {
          console.error(
            `[claude-contract] attempt=${attempt} failed during ${stage}`,
          );
          for (const line of trace.slice(-40)) {
            console.error(`[claude-contract] ${line}`);
          }
          if (isClaudeInternalError(error)) {
            throw new Error(`Claude Code ACP internal error during ${stage}`);
          }
          throw error;
        } finally {
          await session?.close().catch(() => undefined);
        }
      });
    },
    120_000,
  );
});
