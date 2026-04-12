import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AcpRuntimeJsonSessionRegistryStore,
  AcpRuntimeSessionRegistry,
} from "./index.js";
import type { AcpRuntimeSnapshot } from "./types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (path) => {
      await rm(path, { force: true, recursive: true });
    }),
  );
});

function createSnapshot(input: {
  agentType?: string;
  config?: Record<string, string>;
  currentModeId?: string;
  cwd: string;
  sessionId: string;
}): AcpRuntimeSnapshot {
  return {
    agent: {
      command: "mock-agent",
      type: input.agentType,
    },
    config: input.config,
    currentModeId: input.currentModeId,
    cwd: input.cwd,
    session: {
      id: input.sessionId,
    },
    version: 1,
  };
}

describe("AcpRuntimeSessionRegistry persistence", () => {
  it("hydrates persisted snapshots from the JSON registry store", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-runtime-registry-"));
    tempDirs.push(root);
    const path = join(root, "registry.json");
    const store = new AcpRuntimeJsonSessionRegistryStore(path);

    const writer = new AcpRuntimeSessionRegistry({ store });
    await writer.rememberSnapshot(
      createSnapshot({
        agentType: "agent-alpha",
        config: {
          model: "alpha",
        },
        currentModeId: "plan",
        cwd: "/tmp/project-alpha",
        sessionId: "session-alpha",
      }),
    );
    await writer.rememberSnapshot(
      createSnapshot({
        agentType: "agent-beta",
        cwd: "/tmp/project-beta",
        sessionId: "session-beta",
      }),
    );

    const reader = new AcpRuntimeSessionRegistry({ store });
    await reader.hydrate();

    expect(reader.getSnapshot("session-alpha")).toEqual(
      createSnapshot({
        agentType: "agent-alpha",
        config: {
          model: "alpha",
        },
        currentModeId: "plan",
        cwd: "/tmp/project-alpha",
        sessionId: "session-alpha",
      }),
    );
    expect(reader.listSessions().sessions).toEqual([
      {
        agentType: "agent-beta",
        cwd: "/tmp/project-beta",
        id: "session-beta",
        title: undefined,
      },
      {
        agentType: "agent-alpha",
        cwd: "/tmp/project-alpha",
        id: "session-alpha",
        title: undefined,
      },
    ]);
  });

  it("replaces existing snapshots by session id and supports filtered listing by agent type", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-runtime-registry-"));
    tempDirs.push(root);
    const path = join(root, "registry.json");
    const store = new AcpRuntimeJsonSessionRegistryStore(path);

    const registry = new AcpRuntimeSessionRegistry({ store });
    await registry.rememberSnapshot(
      createSnapshot({
        agentType: "agent-gamma",
        cwd: "/tmp/project-gamma",
        sessionId: "session-gamma-1",
      }),
    );
    await registry.rememberSnapshot(
      createSnapshot({
        agentType: "agent-gamma",
        cwd: "/tmp/project-gamma",
        sessionId: "session-gamma-2",
      }),
    );
    await registry.rememberSnapshot(
      createSnapshot({
        agentType: "agent-gamma",
        cwd: "/tmp/project-gamma",
        sessionId: "session-gamma-1",
      }),
    );

    const hydrated = new AcpRuntimeSessionRegistry({ store });
    await hydrated.hydrate();

    expect(
      hydrated.listSessions({ agentType: "agent-gamma", limit: 1 }),
    ).toEqual({
      nextCursor: "1",
      sessions: [
        {
          agentType: "agent-gamma",
          cwd: "/tmp/project-gamma",
          id: "session-gamma-2",
          title: undefined,
        },
      ],
    });
    expect(
      hydrated.listSessions({ agentType: "agent-gamma", cursor: "1" }),
    ).toEqual({
      nextCursor: undefined,
      sessions: [
        {
          agentType: "agent-gamma",
          cwd: "/tmp/project-gamma",
          id: "session-gamma-1",
          title: undefined,
        },
      ],
    });
  });
});
