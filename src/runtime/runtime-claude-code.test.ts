import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AcpRuntime,
  type AcpRuntimeTurnEvent,
  createClaudeCodeAcpAgent,
  createStdioAcpConnectionFactory,
} from "../index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (path) => {
      await rm(path, { force: true, recursive: true });
    }),
  );
});

const shouldRunClaudeCodeContract =
  process.env.ACP_RUNTIME_RUN_CLAUDE_CODE_TEST === "1";

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
  it.skipIf(!shouldRunClaudeCodeContract)(
    "creates a Claude Code ACP session over stdio",
    async () => {
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
        let session: Awaited<ReturnType<AcpRuntime["create"]>> | undefined;

        try {
          trace.push(`attempt=${attempt} stage=${stage}`);
          session = await runtime.create({
            agent: createClaudeCodeAcpAgent({ via: "npx" }),
            cwd,
          });

          expect(session.metadata.id).toBeTruthy();
          expect(
            session.listAgentModes().some((mode) => mode.id === "plan"),
          ).toBe(true);
          expect(
            session.listAgentConfigOptions().some((option) => option.id === "model"),
          ).toBe(true);
          const firstEvents: AcpRuntimeTurnEvent[] = [];

          stage = "send";
          trace.push(`attempt=${attempt} stage=${stage}`);
          const result = await session.send("Reply with exactly the word READY.", {
            onEvent(event) {
              firstEvents.push(event);
              trace.push(`event: ${JSON.stringify(event)}`);
            },
          });
          expect(result.outputText).toContain("READY");
          expect(firstEvents.some((event) => event.type === "started")).toBe(true);
          expect(firstEvents.some((event) => event.type === "completed")).toBe(true);

          stage = "set-raw-mode";
          trace.push(`attempt=${attempt} stage=${stage}`);
          await session.setAgentMode("plan");
          expect(session.metadata.currentModeId).toBe("plan");

          stage = "set-bypass-mode";
          trace.push(`attempt=${attempt} stage=${stage}`);
          await session.setAgentMode("bypassPermissions");
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
