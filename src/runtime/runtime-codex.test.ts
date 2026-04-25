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
  createCodexAcpAgent,
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

function shouldSkipCodexContract(): boolean {
  return process.env.ACP_RUNTIME_SKIP_CODEX_TEST === "1";
}

function isCommandInPath(command: string): boolean {
  const which = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(which, [command], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0;
}

function hasCodexCredentials(): boolean {
  if (process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) {
    return true;
  }

  const result = spawnSync("codex", ["login", "status"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return result.status === 0 && /logged in/i.test(output);
}

async function resolveCodexContractAgent() {
  if (shouldSkipCodexContract()) {
    return {
      skipReason: "ACP_RUNTIME_SKIP_CODEX_TEST=1",
    } as const;
  }

  if (!hasCodexCredentials()) {
    return {
      skipReason:
        "Codex auth unavailable; set CODEX_API_KEY / OPENAI_API_KEY or log in with `codex login`.",
    } as const;
  }

  if (process.env.ACP_RUNTIME_RUN_CODEX_TEST === "1") {
    return {
      createSession(runtime: AcpRuntime, cwd: string) {
        return runtime.sessions.start({
          agent: createCodexAcpAgent({ via: "npx" }),
          cwd,
        });
      },
    } as const;
  }

  if (!isCommandInPath("codex-acp")) {
    return {
      skipReason:
        "codex-acp is not installed locally; skipping registry-backed launch that would require package download or binary fetch. Set ACP_RUNTIME_RUN_CODEX_TEST=1 to force it.",
    } as const;
  }

  try {
    await resolveRuntimeAgentFromRegistry("codex-acp");
    return {
      createSession(runtime: AcpRuntime, cwd: string) {
        return runtime.sessions.registry.start({
          agentId: "codex-acp",
          cwd,
        });
      },
    } as const;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      skipReason: `failed to resolve codex-acp launch from ACP registry: ${message}`,
    } as const;
  }
}

describe("AcpRuntime x Codex ACP", () => {
  it(
    "creates a Codex ACP session over stdio",
    async (context) => {
      const resolution = await resolveCodexContractAgent();
      if ("skipReason" in resolution) {
        context.skip(resolution.skipReason);
      }

      const cwd = await mkdtemp(join(tmpdir(), "acp-runtime-codex-"));
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
        trace.push(`stage=${stage}`);
        session = await resolution.createSession(runtime, cwd);

        expect(session.metadata.id).toBeTruthy();
        expect(session.capabilities.agent.prompt).toBe(true);
        expect(
          session.agent.listModes().some((mode) => mode.id === "read-only"),
        ).toBe(true);
        const firstEvents: AcpRuntimeTurnEvent[] = [];

        stage = "send";
        trace.push(`stage=${stage}`);
        const result = await session.turn.send("Reply with exactly the word READY.", {
          onEvent(event) {
            firstEvents.push(event);
            trace.push(`event: ${JSON.stringify(event)}`);
          },
        });

        expect(result.outputText).toContain("READY");
        expect(firstEvents.some((event) => event.type === "started")).toBe(true);
        expect(firstEvents.some((event) => event.type === "completed")).toBe(true);

        stage = "set-read-only";
        trace.push(`stage=${stage}`);
        await session.agent.setMode("read-only");
        expect(session.metadata.currentModeId).toBe("read-only");

        const deniedEvents: AcpRuntimeTurnEvent[] = [];
        stage = "permission-denied";
        trace.push(`stage=${stage}`);
        await expect(
          session.turn.send(
            "Write the exact text 'denied' into ./codex-readonly-denied.txt using tools, then report success.",
            {
              onEvent(event) {
                deniedEvents.push(event);
                trace.push(`event: ${JSON.stringify(event)}`);
              },
            },
          ),
        ).rejects.toBeInstanceOf(AcpPermissionDeniedError);
        expect(
          deniedEvents.some((event) => event.type === "permission_requested"),
        ).toBe(true);
        expect(
          deniedEvents.some(
            (event) =>
              event.type === "operation_updated" &&
              event.operation.permission?.family === "permission_request_cancelled",
          ),
        ).toBe(true);
        expect(session.status).toBe("ready");
      } catch (error) {
        console.error(`[codex-contract] failed during ${stage}`);
        for (const line of trace.slice(-40)) {
          console.error(`[codex-contract] ${line}`);
        }
        throw error;
      } finally {
        await session?.lifecycle.close().catch(() => undefined);
      }
    },
    240_000,
  );
});
