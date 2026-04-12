import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AcpRuntime,
  createClaudeCodeAcpAgent,
  createStdioAcpConnectionFactory,
  type AcpRuntimeTurnEvent,
} from "../index.js";

function formatEvent(event: AcpRuntimeTurnEvent): string {
  switch (event.type) {
    case "queued":
      return "[event] queued";
    case "started":
      return "[event] started";
    case "thinking":
      return `[event] thinking: ${event.text}`;
    case "text":
      return `[event] text: ${event.text}`;
    case "metadata_updated":
      return `[event] metadata_updated: ${JSON.stringify(event.metadata)}`;
    case "usage_updated":
      return `[event] usage_updated: ${JSON.stringify(event.usage)}`;
    case "permission_requested":
      return `[event] permission_requested: ${event.request.kind}`;
    case "permission_resolved":
      return `[event] permission_resolved: ${event.decision}`;
    case "plan_updated":
      return "[event] plan_updated";
    case "operation_started":
      return `[event] operation_started: ${event.operation.kind}`;
    case "operation_updated":
      return `[event] operation_updated: ${event.operation.kind}`;
    case "operation_completed":
      return `[event] operation_completed: ${event.operation.kind}`;
    case "operation_failed":
      return `[event] operation_failed: ${event.operation.kind}`;
    case "failed":
      return `[event] failed: ${event.error.message}`;
    case "completed":
      return "[event] completed";
    default:
      return "[event] <unknown>";
  }
}

async function main(): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "acp-runtime-claude-smoke-"));
  const prompt =
    process.argv.slice(2).join(" ") || "Reply with exactly the word READY.";
  const runtime = new AcpRuntime(createStdioAcpConnectionFactory());

  const session = await runtime.create({
    agent: createClaudeCodeAcpAgent({ via: "npx" }),
    cwd,
  });

  console.log("[runtime] session created");
  console.log(`[runtime] sessionId: ${session.metadata.id}`);
  console.log(
    `[runtime] agentType: ${session.snapshot().agent.type ?? "<none>"}`,
  );
  console.log(`[runtime] cwd: ${cwd}`);
  console.log(`[runtime] prompt: ${prompt}`);
  console.log("[runtime] raw modes:");
  console.log(JSON.stringify(session.listAgentModes(), null, 2));
  console.log("[runtime] raw config options:");
  console.log(JSON.stringify(session.listAgentConfigOptions(), null, 2));

  try {
    const result = await session.send(prompt, {
      onEvent(event) {
        console.log(formatEvent(event));
      },
    });

    console.log("[runtime] final output:");
    console.log(JSON.stringify(result, null, 2));

    if (session.listAgentModes().some((mode) => mode.id === "plan")) {
      await session.setAgentMode("plan");
      console.log("[runtime] switched raw mode to plan");
      console.log(
        `[runtime] current raw mode: ${session.metadata.currentModeId ?? "<none>"}`,
      );
    }

    await session.setAgentMode("bypassPermissions");
    console.log("[runtime] switched raw mode to bypassPermissions");
    console.log(`[runtime] current raw mode: ${session.metadata.currentModeId ?? "<none>"}`);
    console.log("[runtime] session metadata:");
    console.log(JSON.stringify(session.metadata, null, 2));
    console.log("[runtime] snapshot:");
    console.log(JSON.stringify(session.snapshot(), null, 2));
  } finally {
    await session.close().catch(() => undefined);
    await rm(cwd, { force: true, recursive: true });
  }
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
