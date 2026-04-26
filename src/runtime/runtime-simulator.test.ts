import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AcpRuntime,
  SIMULATOR_AGENT_ACP_REGISTRY_ID,
  type AcpRuntimeAuthorityHandlers,
  type AcpRuntimeTurnEvent,
  createStdioAcpConnectionFactory,
} from "../index.js";
import { resolveBuiltSimulatorWorkspaceCliPath } from "./registry/simulator-workspace.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (path) => {
      await rm(path, { force: true, recursive: true });
    }),
  );
});

async function createTestDirs(): Promise<{
  projectDir: string;
  storageDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "acp-runtime-simulator-"));
  const projectDir = join(root, "project");
  const storageDir = join(root, "storage");
  await mkdir(projectDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  tempDirs.push(root);
  return { projectDir, storageDir };
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

function createAuthorityHandlers(): AcpRuntimeAuthorityHandlers {
  return {
    filesystem: createFilesystemHandlers(),
    permission() {
      return {
        decision: "allow",
        scope: "once",
      };
    },
  };
}

function collectEvents(): {
  events: AcpRuntimeTurnEvent[];
  onEvent(event: AcpRuntimeTurnEvent): void;
} {
  const events: AcpRuntimeTurnEvent[] = [];
  return {
    events,
    onEvent(event) {
      events.push(event);
    },
  };
}

describe("AcpRuntime x simulator-agent ACP", () => {
  it("creates, configures, snapshots, and resumes simulator sessions through the runtime", async () => {
    const cliPath = resolveBuiltSimulatorWorkspaceCliPath();
    const { projectDir, storageDir } = await createTestDirs();
    const runtime = new AcpRuntime(createStdioAcpConnectionFactory(), {
      state: {
        sessionRegistryPath: join(storageDir, "runtime-session-registry.json"),
      },
    });
    const handlers = createAuthorityHandlers();
    const firstPath = join(projectDir, "notes-one.txt");
    const secondPath = join(projectDir, "notes-two.txt");

    await writeFile(firstPath, "seed one\n", "utf8");
    await writeFile(secondPath, "seed two\n", "utf8");

    const session = await runtime.sessions.start({
      agent: {
        args: [cliPath, "--storage-dir", storageDir],
        command: process.execPath,
        type: SIMULATOR_AGENT_ACP_REGISTRY_ID,
      },
      cwd: projectDir,
      handlers,
    });

    expect(session.snapshot().agent.type).toBe(SIMULATOR_AGENT_ACP_REGISTRY_ID);
    expect(session.agent.listModes().map((mode) => mode.id)).toEqual([
      "deny",
      "accept-edits",
      "yolo",
    ]);
    expect(session.agent.listConfigOptions().map((option) => option.id)).toEqual([
      "approval-policy",
      "model",
      "reasoning",
    ]);

    const renameTurn = collectEvents();
    const renameResult = await session.turn.send(
      "/rename Integration Session",
      renameTurn,
    );
    expect(renameResult.outputText).toContain(
      'Renamed session to "Integration Session".',
    );
    expect(session.metadata.title).toBe("Integration Session");

    const guardedWrite = collectEvents();
    const guardedWriteResult = await session.turn.send(
      `/write ${firstPath} first`,
      guardedWrite,
    );
    expect(guardedWriteResult.outputText).toContain("Wrote");
    expect(
      guardedWrite.events.some(
        (event) => event.type === "permission_requested",
      ),
    ).toBe(true);

    await session.agent.setMode("yolo");
    expect(session.metadata.currentModeId).toBe("yolo");

    const unguardedWrite = collectEvents();
    const unguardedWriteResult = await session.turn.send(
      `/write ${secondPath} second`,
      unguardedWrite,
    );
    expect(unguardedWriteResult.outputText).toContain("Wrote");
    expect(
      unguardedWrite.events.some(
        (event) => event.type === "permission_requested",
      ),
    ).toBe(false);

    const snapshot = session.snapshot();
    expect(snapshot.config).toMatchObject({
      "approval-policy": "accept-edits",
      model: "claude",
      reasoning: "medium",
    });
    expect(snapshot.currentModeId).toBe("yolo");

    const resumed = await runtime.sessions.resume({
      handlers,
      sessionId: snapshot.session.id,
    });
    expect(resumed.metadata.id).toBe(snapshot.session.id);
    expect(resumed.metadata.config).toMatchObject({
      "approval-policy": "accept-edits",
      model: "claude",
      reasoning: "medium",
    });

    await resumed.agent.setMode("deny");
    expect(resumed.metadata.currentModeId).toBe("deny");
    const deniedSnapshot = resumed.snapshot();
    expect(deniedSnapshot.currentModeId).toBe("deny");

    const describeResult = await resumed.turn.send("/describe");
    expect(describeResult.outputText).toContain("Current mode: deny");
    expect(describeResult.outputText).toContain("Permission policy: deny");

    const resumedDenied = await runtime.sessions.resume({
      handlers,
      sessionId: deniedSnapshot.session.id,
    });
    expect(resumedDenied.metadata.currentModeId).toBe("deny");

    await resumedDenied.close();

    await resumed.close();
    await session.close();
  });
});
