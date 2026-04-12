import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  AcpRuntime,
  createSimulatorAgentAcpAgent,
  createStdioAcpConnectionFactory,
  type AcpRuntimeAuthorityHandlers,
  type AcpRuntimeTurnEvent,
} from "../index.js";

function formatEvent(event: AcpRuntimeTurnEvent): string {
  switch (event.type) {
    case "queued":
      return "[event] queued";
    case "started":
      return "[event] started";
    case "thinking":
      return "[event] thinking";
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

function createFilesystemHandlers(): AcpRuntimeAuthorityHandlers["filesystem"] {
  return {
    async readTextFile(path) {
      const { readFile } = await import("node:fs/promises");
      return readFile(path, "utf8");
    },
    async writeTextFile(input) {
      await mkdir(dirname(input.path), { recursive: true });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(input.path, input.content, "utf8");
    },
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "acp-runtime-smoke-"));
  const projectDir = join(root, "project");
  const prompt =
    process.argv.slice(2).join(" ") || "/rename Runtime CLI Session";
  const readmePath = join(projectDir, "README.md");

  await mkdir(projectDir, { recursive: true });
  await writeFile(readmePath, "hello from runtime stdio smoke\n", "utf8");

  const runtime = new AcpRuntime(createStdioAcpConnectionFactory());

  const session = await runtime.create({
    agent: createSimulatorAgentAcpAgent({ via: "npx" }),
    cwd: projectDir,
    handlers: {
      filesystem: createFilesystemHandlers(),
    },
  });

  console.log("[runtime] session created");
  console.log(`[runtime] sessionId: ${session.metadata.id}`);
  console.log(
    `[runtime] agentType: ${session.snapshot().agent.type ?? "<none>"}`,
  );
  console.log(`[runtime] cwd: ${projectDir}`);
  console.log(`[runtime] prompt: ${prompt}`);

  try {
    const result = await session.send(prompt, {
      onEvent(event) {
        console.log(formatEvent(event));
      },
    });

    console.log("[runtime] final output:");
    console.log(JSON.stringify(result, null, 2));
    console.log("[runtime] session metadata:");
    console.log(JSON.stringify(session.metadata, null, 2));
    console.log("[runtime] snapshot:");
    console.log(JSON.stringify(session.snapshot(), null, 2));
  } finally {
    await session.close();
    await rm(root, { force: true, recursive: true });
  }
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
