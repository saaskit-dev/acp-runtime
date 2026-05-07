import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AcpRuntimeSessionRegistry,
  type AcpRuntimeSessionRegistryState,
  type AcpRuntimeSessionRegistryStore,
} from "./registry/session-registry.js";
import { AcpRuntimeJsonSessionRegistryStore } from "./registry/session-registry-store.js";
import type { AcpRuntimeSnapshot } from "./core/types.js";

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
        updatedAt: expect.any(String),
      },
      {
        agentType: "agent-alpha",
        cwd: "/tmp/project-alpha",
        id: "session-alpha",
        title: undefined,
        updatedAt: expect.any(String),
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
          id: "session-gamma-1",
          title: undefined,
          updatedAt: expect.any(String),
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
          id: "session-gamma-2",
          title: undefined,
          updatedAt: expect.any(String),
        },
      ],
    });
  });

  it("supports watch/delete/refresh on the host registry", async () => {
    const registry = new AcpRuntimeSessionRegistry();
    const updates: string[] = [];
    const stop = registry.watch((update) => {
      updates.push(
        update.type === "session_saved"
          ? `${update.type}:${update.session.id}`
          : update.type === "session_deleted"
            ? `${update.type}:${update.sessionId}`
            : update.type,
      );
    });

    await registry.rememberSnapshot(
      createSnapshot({
        agentType: "agent-delta",
        cwd: "/tmp/project-delta",
        sessionId: "session-delta",
      }),
      { title: "Delta" },
    );
    expect(await registry.deleteSession("session-delta")).toBe(true);
    registry.notifyRefresh();
    stop();

    expect(updates).toEqual([
      "session_saved:session-delta",
      "session_deleted:session-delta",
      "refresh",
    ]);
    expect(registry.listSessions().sessions).toEqual([]);
  });

  it("merges concurrent registry writes from separate registry instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-runtime-registry-"));
    tempDirs.push(root);
    const path = join(root, "registry.json");
    const first = new AcpRuntimeSessionRegistry({
      store: new AcpRuntimeJsonSessionRegistryStore(path),
    });
    const second = new AcpRuntimeSessionRegistry({
      store: new AcpRuntimeJsonSessionRegistryStore(path),
    });

    await Promise.all([
      first.rememberSnapshot(
        createSnapshot({
          agentType: "agent-alpha",
          cwd: "/tmp/project-alpha",
          sessionId: "session-alpha",
        }),
      ),
      second.rememberSnapshot(
        createSnapshot({
          agentType: "agent-beta",
          cwd: "/tmp/project-beta",
          sessionId: "session-beta",
        }),
      ),
    ]);

    const reader = new AcpRuntimeSessionRegistry({
      store: new AcpRuntimeJsonSessionRegistryStore(path),
    });
    await reader.hydrate();

    expect(reader.listSessions().sessions.map((session) => session.id).sort()).toEqual([
      "session-alpha",
      "session-beta",
    ]);
  });

  it("coalesces registry persistence while a save is already in flight", async () => {
    const savedStates: AcpRuntimeSessionRegistryState[] = [];
    let releaseFirstSave: (() => void) | undefined;
    const store: AcpRuntimeSessionRegistryStore = {
      async load() {
        return undefined;
      },
      async save(state) {
        savedStates.push(state);
        if (savedStates.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstSave = resolve;
          });
        }
      },
    };
    const registry = new AcpRuntimeSessionRegistry({ store });

    const first = registry.rememberSnapshot(
      createSnapshot({
        agentType: "agent-alpha",
        cwd: "/tmp/project-alpha",
        sessionId: "session-alpha",
      }),
    );
    await waitFor(() => savedStates.length === 1);

    const second = registry.rememberSnapshot(
      createSnapshot({
        agentType: "agent-beta",
        cwd: "/tmp/project-beta",
        sessionId: "session-beta",
      }),
    );
    const third = registry.rememberSnapshot(
      createSnapshot({
        agentType: "agent-gamma",
        cwd: "/tmp/project-gamma",
        sessionId: "session-gamma",
      }),
    );

    await Promise.resolve();
    expect(savedStates).toHaveLength(1);

    releaseFirstSave?.();
    await Promise.all([first, second, third]);

    expect(savedStates).toHaveLength(2);
    expect(
      savedStates[1]?.sessions.map((entry) => entry.snapshot.session.id).sort(),
    ).toEqual(["session-alpha", "session-beta", "session-gamma"]);
  });

  it("retries registry lock acquisition until the lock is released", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-runtime-registry-"));
    tempDirs.push(root);
    const path = join(root, "registry.json");
    const lockPath = `${path}.lock`;
    await writeFile(lockPath, "busy\n", "utf8");

    const registry = new AcpRuntimeSessionRegistry({
      store: new AcpRuntimeJsonSessionRegistryStore(path),
    });
    const save = registry.rememberSnapshot(
      createSnapshot({
        agentType: "agent-lock",
        cwd: "/tmp/project-lock",
        sessionId: "session-lock",
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(lockPath, { force: true });
    await save;

    const reader = new AcpRuntimeSessionRegistry({
      store: new AcpRuntimeJsonSessionRegistryStore(path),
    });
    await reader.hydrate();

    expect(reader.getSnapshot("session-lock")).toEqual(
      createSnapshot({
        agentType: "agent-lock",
        cwd: "/tmp/project-lock",
        sessionId: "session-lock",
      }),
    );
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}
