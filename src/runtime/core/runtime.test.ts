import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ACP_RUNTIME_SNAPSHOT_VERSION } from "./constants.js";
import { AcpRuntime } from "./runtime.js";
import type { AcpSessionDriver, AcpSessionService } from "./session-driver.js";
import {
  AcpRuntimeAgentConfigOptionType,
  AcpRuntimeQueueDelivery,
  AcpRuntimeSessionStatus,
  type AcpRuntimeAgent,
  type AcpRuntimeAgentConfigOption,
  type AcpRuntimeConfigValue,
  type AcpRuntimeCreateOptions,
  type AcpRuntimeLoadOptions,
  type AcpRuntimeSessionMetadata,
  type AcpRuntimeSnapshot,
} from "./types.js";

describe("AcpRuntime session restore", () => {
  it("restores all stored session config options and mode on load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-runtime-restore-"));
    const sessionRegistryPath = join(dir, "runtime-session-registry.json");
    const agent = {
      command: "fake",
      type: "codex-acp",
    } satisfies AcpRuntimeAgent;
    const startedDriver = createConfigurableDriver({
      agent,
      cwd: dir,
      sessionId: "session-restore-all-options",
    });
    const loadedDriver = createConfigurableDriver({
      agent,
      cwd: dir,
      sessionId: "session-restore-all-options",
    });
    const runtime = new AcpRuntime(createUnusedConnectionFactory, {
      sessionService: createFakeSessionService({
        create: startedDriver,
        load: loadedDriver,
      }),
      state: { sessionRegistryPath },
    });

    const started = await runtime.sessions.start({
      agent,
      cwd: dir,
    });
    await started.agent.setConfigOption("approval-policy", "yolo");
    await started.agent.setConfigOption("custom-toggle", true);
    await started.agent.setConfigOption("custom-select", "custom-b");
    await started.agent.setMode("bypassPermissions");
    await started.close();

    const loadRuntime = new AcpRuntime(createUnusedConnectionFactory, {
      sessionService: createFakeSessionService({
        create: createConfigurableDriver({
          agent,
          cwd: dir,
          sessionId: "unused",
        }),
        load: loadedDriver,
      }),
      state: { sessionRegistryPath },
    });
    const loaded = await loadRuntime.sessions.load({
      agent,
      cwd: dir,
      sessionId: "session-restore-all-options",
    });

    expect(loaded.metadata.currentModeId).toBe("bypassPermissions");
    expect(loaded.metadata.config).toMatchObject({
      "approval-policy": "yolo",
      "custom-select": "custom-b",
      "custom-toggle": true,
    });
  });
});

function createFakeSessionService(input: {
  create: AcpSessionDriver;
  load: AcpSessionDriver;
}): AcpSessionService {
  return {
    async create(_options: AcpRuntimeCreateOptions) {
      return input.create;
    },
    async fork() {
      throw new Error("Not implemented.");
    },
    async listAgentSessions() {
      return { sessions: [] };
    },
    async load(_options: AcpRuntimeLoadOptions) {
      return input.load;
    },
    async resume() {
      return input.load;
    },
  };
}

function createConfigurableDriver(input: {
  agent: AcpRuntimeAgent;
  cwd: string;
  sessionId: string;
}): AcpSessionDriver {
  const configOptions: AcpRuntimeAgentConfigOption[] = [
    {
      category: "mode",
      id: "approval-policy",
      name: "Approval Policy",
      options: [
        { name: "Accept Edits", value: "accept-edits" },
        { name: "YOLO", value: "yolo" },
      ],
      type: AcpRuntimeAgentConfigOptionType.Select,
      value: "accept-edits",
    },
    {
      category: "custom",
      id: "custom-toggle",
      name: "Custom Toggle",
      type: AcpRuntimeAgentConfigOptionType.Boolean,
      value: false,
    },
    {
      category: "custom-select",
      id: "custom-select",
      name: "Custom Select",
      options: [
        { name: "A", value: "custom-a" },
        { name: "B", value: "custom-b" },
      ],
      type: AcpRuntimeAgentConfigOptionType.Select,
      value: "custom-a",
    },
  ];
  const metadata: AcpRuntimeSessionMetadata = {
    agentConfigOptions: configOptions,
    config: configFromOptions(configOptions),
    currentModeId: "default",
    id: input.sessionId,
  };
  return {
    cancelTurn: async () => false,
    capabilities: {},
    clearQueuedTurns: () => 0,
    close: async () => {},
    diagnostics: {},
    diff: () => undefined,
    diffPaths: () => [],
    diffs: () => [],
    drainHistoryEntries: () => [],
    killTerminal: async () => undefined,
    listAgentConfigOptions: () => configOptions,
    listAgentModes: () => [
      { id: "default", name: "Default" },
      { id: "bypassPermissions", name: "Bypass Permissions" },
    ],
    metadata,
    operation: () => undefined,
    operationBundle: () => undefined,
    operationBundles: () => [],
    operationIds: () => [],
    operationPermissionRequests: () => [],
    operations: () => [],
    permissionRequest: () => undefined,
    permissionRequestIds: () => [],
    permissionRequests: () => [],
    projectionMetadata: () => metadata,
    projectionUsage: () => undefined,
    queuePolicy: () => ({ delivery: AcpRuntimeQueueDelivery.Immediate }),
    queuedTurn: () => undefined,
    queuedTurns: () => [],
    refreshTerminal: async () => undefined,
    releaseTerminal: async () => undefined,
    sendQueuedTurnNow: async () => false,
    setAgentConfigOption: async (id: string, value: AcpRuntimeConfigValue) => {
      const option = configOptions.find((entry) => entry.id === id);
      if (!option) {
        throw new Error(`Unknown config option: ${id}`);
      }
      option.value = value;
      metadata.config = configFromOptions(configOptions);
    },
    setAgentMode: async (modeId: string) => {
      metadata.currentModeId = modeId;
    },
    setQueuePolicy: () => ({ delivery: AcpRuntimeQueueDelivery.Immediate }),
    snapshot: (): AcpRuntimeSnapshot => ({
      agent: input.agent,
      config: metadata.config,
      currentModeId: metadata.currentModeId,
      cwd: input.cwd,
      session: { id: input.sessionId },
      version: ACP_RUNTIME_SNAPSHOT_VERSION,
    }),
    startTurn: () => {
      throw new Error("Not implemented.");
    },
    status: AcpRuntimeSessionStatus.Ready,
    terminal: () => undefined,
    terminalIds: () => [],
    terminals: () => [],
    threadEntries: () => [],
    toolCall: () => undefined,
    toolCallBundle: () => undefined,
    toolCallBundles: () => [],
    toolCallDiffs: () => [],
    toolCallIds: () => [],
    toolCallTerminals: () => [],
    toolCalls: () => [],
    waitForTerminal: async () => undefined,
    watchDiff: () => () => {},
    watchOperation: () => () => {},
    watchOperationBundle: () => () => {},
    watchPermissionRequest: () => () => {},
    watchProjection: () => () => {},
    watchReadModel: () => () => {},
    watchTerminal: () => () => {},
    watchToolCall: () => () => {},
    watchToolCallObjects: () => () => {},
    withdrawQueuedTurn: () => false,
  };
}

function configFromOptions(
  options: readonly AcpRuntimeAgentConfigOption[],
): Record<string, AcpRuntimeConfigValue> {
  return Object.fromEntries(options.map((option) => [option.id, option.value]));
}

function createUnusedConnectionFactory(): never {
  throw new Error("Connection factory should not be used.");
}
