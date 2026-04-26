import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { stage1ExplicitAgentExample, stage1RegistryMinimalExample } from "./runtime-sdk-stage-1-minimal.js";
import { stage2SendExample, stage2StreamExample } from "./runtime-sdk-stage-2-interactive.js";
import { stage3RecoveryExample } from "./runtime-sdk-stage-3-session-recovery.js";
import { stage4AgentControlExample } from "./runtime-sdk-stage-4-agent-control.js";
import { stage5ReadModelExample } from "./runtime-sdk-stage-5-read-model.js";
import { stage6StoredSessionsExample } from "./runtime-sdk-stage-6-stored-sessions.js";
import {
  stage7AuthorityHandlersExample,
  stage7ResolveTerminalAuthenticationExample,
} from "./runtime-sdk-stage-7-host-authority.js";

describe("runtime SDK staged examples", () => {
  let runtimeHomeDir = "";

  beforeAll(async () => {
    runtimeHomeDir = await mkdtemp(join(tmpdir(), "acp-runtime-stage-tests-"));
    vi.stubEnv("ACP_RUNTIME_HOME_DIR", runtimeHomeDir);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (runtimeHomeDir) {
      await rm(runtimeHomeDir, { force: true, recursive: true });
    }
  });

  it("covers stage 1 minimal startup through registry-id and explicit agent paths", async () => {
    const registryResult = await stage1RegistryMinimalExample();
    const explicitResult = await stage1ExplicitAgentExample();

    expect(registryResult.metadata.id).toBeTruthy();
    expect(registryResult.snapshot.session.id).toBe(registryResult.metadata.id);
    expect(registryResult.outputText.length).toBeGreaterThan(0);
    expect(explicitResult.outputText.length).toBeGreaterThan(0);
  });

  it("covers stage 2 interactive send and stream paths", async () => {
    const sendResult = await stage2SendExample();
    const streamEvents = await stage2StreamExample();

    expect(sendResult.completion.outputText.length).toBeGreaterThan(0);
    expect(sendResult.events.some((event) => event.type === "completed")).toBe(
      true,
    );
    expect(
      streamEvents.some(
        (event) => event.type === "completed" || event.type === "failed",
      ),
    ).toBe(true);
  });

  it("covers stage 3 recovery and remote session paths", async () => {
    const result = await stage3RecoveryExample();

    expect(result.snapshot.session.id).toBeTruthy();
    expect(result.sessionId).toBeTruthy();
    expect(result.resumedStatus).toBe("ready");
    expect(result.loadedStatus).toBe("ready");
    expect(result.directRemoteSessions.sessions.length).toBeGreaterThan(0);
    expect(result.registryRemoteSessions.sessions.length).toBeGreaterThan(0);
  });

  it("covers stage 4 agent controls", async () => {
    const result = await stage4AgentControlExample();

    expect(result.metadata.id).toBeTruthy();
    expect(Array.isArray(result.modes)).toBe(true);
    expect(Array.isArray(result.configOptions)).toBe(true);
  });

  it("covers stage 5 read-model and live projection surfaces", async () => {
    const result = await stage5ReadModelExample();

    expect(result.thread.length).toBeGreaterThan(0);
    expect(result.toolCalls.length).toBeGreaterThan(0);
    expect(result.toolCallSnapshots.length).toBeGreaterThan(0);
    expect(result.operations.length).toBeGreaterThan(0);
    expect(result.permissions.length).toBeGreaterThan(0);
    expect(result.diffs.length).toBeGreaterThan(0);
    expect(result.terminals.length).toBeGreaterThan(0);
    expect(result.readModelUpdates.length).toBeGreaterThan(0);
    expect(result.projectionUpdates.length).toBeGreaterThan(0);
  });

  it("covers stage 6 unified session listing", async () => {
    const result = await stage6StoredSessionsExample();

    expect(result.localSessions.sessions.length).toBeGreaterThan(0);
    expect(result.remoteSessions.sessions.length).toBeGreaterThan(0);
    expect(result.allSessions.sessions.length).toBeGreaterThan(0);
    expect(
      result.allSessions.sessions.some(
        (session) => session.source === "both" || session.source === "local",
      ),
    ).toBe(true);
  });

  it("covers stage 7 authority handler composition and terminal-auth resolution", () => {
    const handlers = stage7AuthorityHandlersExample();
    const request = stage7ResolveTerminalAuthenticationExample({
      agent: {
        args: ["serve"],
        command: "claude-agent-acp",
        type: "claude-acp",
      },
      method: {
        args: ["login"],
        id: "claude-login",
        title: "Claude Login",
        type: "terminal",
      },
    });

    expect(typeof handlers.authentication).toBe("function");
    expect(typeof handlers.filesystem?.readTextFile).toBe("function");
    expect(typeof handlers.permission).toBe("function");
    expect(typeof handlers.terminal?.start).toBe("function");
    expect(request).toEqual({
      args: ["serve", "login"],
      command: "claude-agent-acp",
      env: undefined,
      label: "Claude Login",
      methodId: "claude-login",
    });
  });
});
