import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TransformStream } from "node:stream/web";

import { describe, expect, it } from "vitest";

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type Client,
  type ClientCapabilities,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  AgentSideConnection,
} from "@agentclientprotocol/sdk";

import { createSimulatorAgent } from "./simulator-agent.js";

type MemoryTerminal = {
  exitCode: number;
  output: string;
  released: boolean;
};

class MemoryClient implements Client {
  readonly files = new Map<string, string>();
  readonly sessionUpdates: SessionNotification[] = [];
  readonly terminals = new Map<string, MemoryTerminal>();
  terminalId = 0;

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const allowOption = params.options.find((entry) => entry.optionId === "allow") ?? params.options[0];
    if (!allowOption) {
      return { outcome: { outcome: "cancelled" } };
    }

    return {
      outcome: {
        outcome: "selected",
        optionId: allowOption.optionId,
      },
    };
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.sessionUpdates.push(params);
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    this.files.set(params.path, params.content);
    return {};
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return {
      content: this.files.get(params.path) ?? "",
    };
  }

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const terminalId = `term-${++this.terminalId}`;
    this.terminals.set(terminalId, {
      output: `${params.command}${params.args?.length ? ` ${params.args.join(" ")}` : ""}\n`,
      exitCode: 0,
      released: false,
    });
    return { terminalId };
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) {
      throw new Error(`Unknown terminal ${params.terminalId}`);
    }

    return {
      output: terminal.output,
      truncated: false,
      exitStatus: { exitCode: terminal.exitCode },
    };
  }

  async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) {
      throw new Error(`Unknown terminal ${params.terminalId}`);
    }

    return {
      exitCode: terminal.exitCode,
    };
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) {
      throw new Error(`Unknown terminal ${params.terminalId}`);
    }

    terminal.exitCode = 137;
    return {};
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (terminal) {
      terminal.released = true;
    }
    return {};
  }
}

function createConnectionPair() {
  const clientToAgent = new TransformStream<any, any>();
  const agentToClient = new TransformStream<any, any>();

  return {
    agentStream: {
      writable: agentToClient.writable,
      readable: clientToAgent.readable,
    },
    clientStream: {
      writable: clientToAgent.writable,
      readable: agentToClient.readable,
    },
  };
}

async function createTestRig(
  capabilities: ClientCapabilities,
  options?: { authMode?: "none" | "optional" | "required" },
) {
  const storageDir = await mkdtemp(join(tmpdir(), "acp-simulator-agent-"));
  const { agentStream, clientStream } = createConnectionPair();
  const memoryClient = new MemoryClient();

  new AgentSideConnection(
    (connection) =>
      createSimulatorAgent(connection, {
        authMode: options?.authMode,
        storageDir,
      }),
    agentStream as any,
  );

  const clientConnection = new ClientSideConnection(() => memoryClient, clientStream as any);
  return { clientConnection, memoryClient };
}

describe("AcpSimulatorAgent", () => {
  it("initializes and creates a fully-capable session", async () => {
    const { clientConnection } = await createTestRig({
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
      terminal: true,
      auth: {
        terminal: true,
      },
      nes: {
        jump: {},
        rename: {},
        searchAndReplace: {},
      },
      positionEncodings: ["utf-16"],
    });

    const initialize = await clientConnection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
        auth: {
          terminal: true,
        },
        nes: {
          jump: {},
          rename: {},
          searchAndReplace: {},
        },
        positionEncodings: ["utf-16"],
      },
      clientInfo: {
        name: "test-client",
        version: "1.0.0",
      },
    });

    expect(initialize.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(initialize.agentCapabilities?.loadSession).toBe(true);
    expect(initialize.agentCapabilities?.sessionCapabilities?.resume).toEqual({});
    expect(initialize.agentCapabilities?.promptCapabilities?.image).toBe(true);
    expect(initialize.agentCapabilities?.nes?.events?.document?.didOpen).toEqual({});
    expect(initialize.authMethods?.length).toBeGreaterThanOrEqual(2);

    const created = await clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
      additionalDirectories: ["/tmp/project/packages"],
    });

    expect(created.sessionId).toBeTruthy();
    expect(created.modes?.availableModes.map((entry) => entry.id)).toEqual([
      "ask",
      "code",
      "review",
    ]);
    expect(created.models?.availableModels.map((entry) => entry.modelId)).toContain(
      "reference-fast",
    );
    expect(created.configOptions?.map((entry) => entry.id)).toContain("approval-policy");
  });

  it("supports read/write/run prompt flows and emits ACP session updates", async () => {
    const { clientConnection, memoryClient } = await createTestRig({
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
      terminal: true,
    });

    await clientConnection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
      },
      clientInfo: {
        name: "test-client",
        version: "1.0.0",
      },
    });

    memoryClient.files.set("/tmp/project/README.md", "hello from ACP");
    const session = await clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });

    const readResponse = await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/read /tmp/project/README.md" }],
    });
    expect(readResponse.stopReason).toBe("end_turn");

    const writeResponse = await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/write /tmp/project/notes.txt reference text" }],
    });
    expect(writeResponse.stopReason).toBe("end_turn");
    expect(memoryClient.files.get("/tmp/project/notes.txt")).toBe("reference text");

    const runResponse = await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/run git status" }],
    });
    expect(runResponse.stopReason).toBe("end_turn");

    expect(
      memoryClient.sessionUpdates.some(
        (entry) => entry.update.sessionUpdate === "tool_call" && entry.update.kind === "read",
      ),
    ).toBe(true);
    expect(
      memoryClient.sessionUpdates.some(
        (entry) => entry.update.sessionUpdate === "tool_call_update" && entry.update.status === "completed",
      ),
    ).toBe(true);
    expect(
      memoryClient.sessionUpdates.some((entry) => entry.update.sessionUpdate === "usage_update"),
    ).toBe(true);
  });

  it("supports load/list/resume/fork/config/mode/NES/document events", async () => {
    const { clientConnection, memoryClient } = await createTestRig({
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
      terminal: true,
      nes: {
        jump: {},
        rename: {},
        searchAndReplace: {},
      },
    });

    await clientConnection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
        nes: {
          jump: {},
          rename: {},
          searchAndReplace: {},
        },
      },
      clientInfo: {
        name: "test-client",
        version: "1.0.0",
      },
    });

    const session = await clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });

    await clientConnection.unstable_didOpenDocument({
      sessionId: session.sessionId,
      uri: "file:///tmp/project/index.ts",
      languageId: "typescript",
      text: "const value = 1;\n",
      version: 1,
    });
    await clientConnection.unstable_didChangeDocument({
      sessionId: session.sessionId,
      uri: "file:///tmp/project/index.ts",
      version: 2,
      contentChanges: [{ text: "const value = 2;\n" }],
    });

    const setMode = await clientConnection.setSessionMode({
      sessionId: session.sessionId,
      modeId: "code",
    });
    expect(setMode).toEqual({});

    const setConfig = await clientConnection.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "reasoning",
      value: "detailed",
    });
    expect(setConfig.configOptions.find((entry) => entry.id === "reasoning")).toMatchObject({
      id: "reasoning",
      currentValue: "detailed",
    });

    await clientConnection.unstable_setSessionModel({
      sessionId: session.sessionId,
      modelId: "reference-precise",
    });

    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/title Runtime Session" }],
    });

    const listed = await clientConnection.listSessions({
      cwd: "/tmp/project",
    });
    expect(listed.sessions.map((entry) => entry.sessionId)).toContain(session.sessionId);

    memoryClient.sessionUpdates.length = 0;
    const loaded = await clientConnection.loadSession({
      sessionId: session.sessionId,
      cwd: "/tmp/project",
      mcpServers: [],
    });
    expect(loaded.modes?.currentModeId).toBe("code");
    expect(memoryClient.sessionUpdates.length).toBeGreaterThan(0);

    memoryClient.sessionUpdates.length = 0;
    const resumed = await clientConnection.unstable_resumeSession({
      sessionId: session.sessionId,
      cwd: "/tmp/project",
      mcpServers: [],
    });
    expect(resumed.models?.currentModelId).toBe("reference-precise");
    expect(memoryClient.sessionUpdates).toHaveLength(0);

    const forked = await clientConnection.unstable_forkSession({
      sessionId: session.sessionId,
      cwd: "/tmp/project",
      mcpServers: [],
    });
    expect(forked.sessionId).not.toBe(session.sessionId);

    const nesSession = await clientConnection.unstable_startNes({
      workspaceUri: "file:///tmp/project",
    });
    const suggestions = await clientConnection.unstable_suggestNes({
      sessionId: nesSession.sessionId,
      uri: "file:///tmp/project/index.ts",
      version: 2,
      triggerKind: "manual",
      position: {
        line: 0,
        character: 5,
      },
    });
    expect(suggestions.suggestions).toHaveLength(1);

    await clientConnection.unstable_closeNes({
      sessionId: nesSession.sessionId,
    });
    await clientConnection.unstable_closeSession({
      sessionId: forked.sessionId,
    });
  });

  it("requires authentication when configured", async () => {
    const { clientConnection } = await createTestRig(
      {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
      { authMode: "required" },
    );

    const initialize = await clientConnection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
      clientInfo: {
        name: "test-client",
        version: "1.0.0",
      },
    });

    await expect(
      clientConnection.newSession({
        cwd: "/tmp/project",
        mcpServers: [],
      }),
    ).rejects.toThrow(/Authenticate first/);

    await clientConnection.authenticate({
      methodId: initialize.authMethods?.[0]?.id ?? "simulator-agent-login",
    });

    const session = await clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });
    expect(session.sessionId).toBeTruthy();
  });
});
