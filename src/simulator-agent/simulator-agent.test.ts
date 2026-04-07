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

import { createSimulatorAgentAcp } from "./simulator-agent.js";

type MemoryTerminal = {
  exitCode: number;
  output: string;
  released: boolean;
};

class MemoryClient implements Client {
  readonly files = new Map<string, string>();
  readonly permissionRequests: RequestPermissionRequest[] = [];
  readonly sessionUpdates: SessionNotification[] = [];
  readonly terminals = new Map<string, MemoryTerminal>();
  readonly selectedPermissionOptionIds: string[] = [];
  terminalId = 0;

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.permissionRequests.push(params);
    const requestedOptionId = this.selectedPermissionOptionIds.shift();
    const selectedOption =
      (requestedOptionId
        ? params.options.find((entry) => entry.optionId === requestedOptionId)
        : undefined) ??
      params.options.find((entry) => entry.optionId === "allow") ??
      params.options[0];
    if (!selectedOption) {
      return { outcome: { outcome: "cancelled" } };
    }

    return {
      outcome: {
        outcome: "selected",
        optionId: selectedOption.optionId,
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

async function flushPostResponseUpdates(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function createTestRig(
  capabilities: ClientCapabilities,
  options?: {
    authMode?: "none" | "optional" | "required";
    onFatalExit?: (code: number) => void | Promise<void>;
  },
) {
  const storageDir = await mkdtemp(join(tmpdir(), "simulator-agent-acp-"));
  const { agentStream, clientStream } = createConnectionPair();
  const memoryClient = new MemoryClient();

  new AgentSideConnection(
    (connection) =>
      createSimulatorAgentAcp(connection, {
        authMode: options?.authMode,
        onFatalExit: options?.onFatalExit,
        storageDir,
      }),
    agentStream as any,
  );

  const clientConnection = new ClientSideConnection(() => memoryClient, clientStream as any);
  return { clientConnection, memoryClient };
}

describe("SimulatorAgentAcp", () => {
  it("initializes and creates a fully-capable session", async () => {
    const { clientConnection, memoryClient } = await createTestRig({
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
    expect(initialize.agentCapabilities?.mcpCapabilities).toEqual({
      http: true,
      sse: true,
    });
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
      "read-only",
      "accept-edits",
      "yolo",
    ]);
    expect(created.models?.availableModels.map((entry) => entry.modelId)).toContain(
      "claude",
    );
    expect(created.configOptions?.map((entry) => entry.id)).toContain("approval-policy");
    expect(created.configOptions?.map((entry) => entry.id)).not.toContain("emit-plan");
    await flushPostResponseUpdates();
    const availableCommandsUpdate = memoryClient.sessionUpdates.find(
      (entry) => entry.update.sessionUpdate === "available_commands_update",
    );
    const availableCommandNames =
      availableCommandsUpdate?.update.sessionUpdate === "available_commands_update"
        ? availableCommandsUpdate.update.availableCommands.map((entry) => entry.name)
        : [];
    expect(availableCommandNames).toContain("bash");
    expect(availableCommandNames).toContain("rename");
    expect(availableCommandNames).not.toContain("run");
    expect(availableCommandNames).not.toContain("rename-session");
  });

  it("supports read/write/bash prompt flows and emits ACP session updates", async () => {
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
    await flushPostResponseUpdates();
    await flushPostResponseUpdates();
    memoryClient.sessionUpdates.length = 0;

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
      prompt: [{ type: "text", text: "/bash git status" }],
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
    expect(
      memoryClient.sessionUpdates.some((entry) => entry.update.sessionUpdate === "available_commands_update"),
    ).toBe(false);
    expect(
      memoryClient.sessionUpdates.some((entry) => entry.update.sessionUpdate === "plan"),
    ).toBe(false);
  });

  it("rejects unsupported protocol versions during initialize", async () => {
    const { clientConnection } = await createTestRig({
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    });

    await expect(
      clientConnection.initialize({
        protocolVersion: PROTOCOL_VERSION + 1,
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
      }),
    ).rejects.toThrow(/Unsupported protocolVersion/);
  });

  it("accepts stdio, http, and sse MCP server configurations", async () => {
    const { clientConnection } = await createTestRig({
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    });

    await clientConnection.initialize({
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

    const created = await clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [
        {
          type: "stdio",
          name: "local-mcp",
          command: "node",
          args: ["./mcp.js"],
          env: [],
        },
        {
          type: "http",
          name: "remote-http-mcp",
          url: "https://mcp.example.com",
          headers: [],
        },
        {
          type: "sse",
          name: "remote-sse-mcp",
          url: "https://mcp.example.com/sse",
          headers: [],
        },
      ],
    });

    const resumed = await clientConnection.unstable_resumeSession({
      sessionId: created.sessionId,
      cwd: "/tmp/project",
      mcpServers: [
        {
          type: "http",
          name: "replacement-http-mcp",
          url: "https://mcp.example.com/v2",
          headers: [],
        },
      ],
    });

    expect(resumed.modes?.currentModeId).toBe("accept-edits");
  });

  it("rejects invalid MCP server definitions", async () => {
    const { clientConnection } = await createTestRig({
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    });

    await clientConnection.initialize({
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
        mcpServers: [
          {
            type: "http",
            name: "broken-http-mcp",
            url: "",
            headers: [],
          },
        ],
      }),
    ).rejects.toThrow(/MCP http server URL must be non-empty/);
  });

  it("accepts image, audio, and embedded resource prompt blocks deterministically", async () => {
    const { clientConnection, memoryClient } = await createTestRig({
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    });

    await clientConnection.initialize({
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

    const session = await clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });

    const response = await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [
        { type: "text", text: "Summarize attached context." },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
        { type: "resource_link", name: "README", uri: "file:///tmp/project/README.md" },
        {
          type: "resource",
          resource: {
            uri: "file:///tmp/project/notes.txt",
            text: "embedded context",
            mimeType: "text/plain",
          },
        },
      ],
    });

    expect(response.stopReason).toBe("end_turn");
    const userChunks = memoryClient.sessionUpdates.filter(
      (entry) => entry.update.sessionUpdate === "user_message_chunk",
    );
    const renderedUserText = userChunks
      .map((entry) =>
        entry.update.sessionUpdate === "user_message_chunk" && entry.update.content.type === "text"
          ? entry.update.content.text
          : "",
      )
      .join("\n");
    expect(renderedUserText).toContain("Image content (image/png)");
    expect(renderedUserText).toContain("Audio content (audio/wav)");
    expect(renderedUserText).toContain("Referenced resource file:///tmp/project/README.md");
    expect(renderedUserText).toContain("Embedded resource file:///tmp/project/notes.txt");
  });

  it("supports protocol-only mode changes and prompt-triggered tool actions", async () => {
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

    const session = await clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });

    await clientConnection.setSessionMode({
      sessionId: session.sessionId,
      modeId: "yolo",
    });

    const switchedMode = memoryClient.sessionUpdates.find(
      (entry) =>
        entry.update.sessionUpdate === "current_mode_update" &&
        entry.update.currentModeId === "yolo",
    );
    expect(switchedMode).toBeTruthy();

    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "plan: inspect repo | run tests | summarize" }],
    });
    expect(
      memoryClient.sessionUpdates.some((entry) => entry.update.sessionUpdate === "plan"),
    ).toBe(true);
    const publishedPlan = memoryClient.sessionUpdates
      .filter((entry) => entry.update.sessionUpdate === "plan")
      .at(-1);
    expect(
      publishedPlan?.update.entries?.map((entry) => entry.status),
    ).toEqual(["in_progress", "pending", "pending"]);

    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "please run `git status` for me" }],
    });
    expect(memoryClient.terminals.size).toBeGreaterThan(0);
    expect(memoryClient.permissionRequests).toHaveLength(0);

    await clientConnection.setSessionMode({
      sessionId: session.sessionId,
      modeId: "accept-edits",
    });
    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "please run `git diff --stat` for me" }],
    });
    expect(memoryClient.permissionRequests.length).toBeGreaterThan(0);
  });

  it("keeps explicit /plan active instead of auto-completing it", async () => {
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

    const session = await clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });
    await flushPostResponseUpdates();
    memoryClient.sessionUpdates.length = 0;

    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/plan inspect repo | edit file | verify result" }],
    });

    const plans = memoryClient.sessionUpdates.filter((entry) => entry.update.sessionUpdate === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0]?.update.entries?.map((entry) => entry.status)).toEqual([
      "in_progress",
      "pending",
      "pending",
    ]);
    const finalReply = memoryClient.sessionUpdates.findLast(
      (entry) => entry.update.sessionUpdate === "agent_message_chunk",
    );
    const finalReplyText =
      finalReply?.update.content.type === "text" ? finalReply.update.content.text : "";
    expect(finalReplyText).toContain("Published plan.");
    expect(finalReplyText).toContain("1. [in_progress] inspect repo");
    expect(finalReplyText).toContain("2. [pending] edit file");
    expect(finalReplyText).toContain("3. [pending] verify result");
    const stepThoughts = memoryClient.sessionUpdates
      .filter((entry) => entry.update.sessionUpdate === "agent_thought_chunk")
      .map((entry) => (entry.update.content.type === "text" ? entry.update.content.text : ""));
    expect(stepThoughts).toContain(
      "Plan step 1/3: inspect repo\nThe requested plan has been registered for later execution.",
    );
  });

  it("normalizes duplicated slash command syntax emitted by clients", async () => {
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

    const session = await clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });
    await flushPostResponseUpdates();
    memoryClient.sessionUpdates.length = 0;

    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/plan/inspect repo | edit file" }],
    });

    const publishedPlan = memoryClient.sessionUpdates.find(
      (entry) => entry.update.sessionUpdate === "plan",
    );
    expect(publishedPlan?.update.entries?.map((entry) => entry.content)).toEqual([
      "inspect repo",
      "edit file",
    ]);
  });

  it("changes response style across Claude, GPT, and Gemini profiles", async () => {
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

    const session = await clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });

    await clientConnection.unstable_setSessionModel({
      sessionId: session.sessionId,
      modelId: "gpt",
    });
    await clientConnection.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "reasoning",
      value: "high",
    });
    memoryClient.sessionUpdates.length = 0;

    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi?" }],
    });

    const gptReply = memoryClient.sessionUpdates.findLast(
      (entry) => entry.update.sessionUpdate === "agent_message_chunk",
    );
    expect(gptReply?.update.content.type).toBe("text");
    expect((gptReply?.update.content.type === "text" ? gptReply.update.content.text : "")).toContain(
      "GPT simulator profile received the prompt successfully.",
    );
    expect(
      memoryClient.sessionUpdates.some((entry) => entry.update.sessionUpdate === "plan"),
    ).toBe(false);

    await clientConnection.unstable_setSessionModel({
      sessionId: session.sessionId,
      modelId: "gemini",
    });
    await clientConnection.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "reasoning",
      value: "low",
    });
    memoryClient.sessionUpdates.length = 0;

    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi?" }],
    });

    const geminiReply = memoryClient.sessionUpdates.findLast(
      (entry) => entry.update.sessionUpdate === "agent_message_chunk",
    );
    expect((geminiReply?.update.content.type === "text" ? geminiReply.update.content.text : "")).toContain(
      "Gemini simulator profile received the prompt successfully.",
    );
    expect(
      memoryClient.sessionUpdates.some((entry) => entry.update.sessionUpdate === "plan"),
    ).toBe(false);
  });

  it("does not emit plan updates for plain conversational prompts", async () => {
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

    const session = await clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });
    memoryClient.sessionUpdates.length = 0;

    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi?" }],
    });

    expect(
      memoryClient.sessionUpdates.some((entry) => entry.update.sessionUpdate === "plan"),
    ).toBe(false);
  });

  it("does not infer terminal execution from vague natural-language prompts", async () => {
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

    const session = await clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });
    memoryClient.sessionUpdates.length = 0;

    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "can you run something helpful here?" }],
    });

    expect(memoryClient.terminals.size).toBe(0);
    expect(
      memoryClient.sessionUpdates.some((entry) => entry.update.sessionUpdate === "tool_call"),
    ).toBe(false);
  });

  it("changes scenario write output across model profiles", async () => {
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

    const session = await clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });

    memoryClient.files.set("/tmp/project/profile.ts", "export const before = true;\n");

    await clientConnection.unstable_setSessionModel({
      sessionId: session.sessionId,
      modelId: "gpt",
    });
    await clientConnection.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "reasoning",
      value: "high",
    });
    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/scenario full-cycle /tmp/project/profile.ts git diff --stat" }],
    });
    expect(memoryClient.files.get("/tmp/project/profile.ts")).toContain('simulatorProfile = "gpt"');
    expect(memoryClient.files.get("/tmp/project/profile.ts")).toContain('simulatorVerification = "structured"');

    memoryClient.files.set("/tmp/project/profile.ts", "export const before = true;\n");
    await clientConnection.unstable_setSessionModel({
      sessionId: session.sessionId,
      modelId: "gemini",
    });
    await clientConnection.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "reasoning",
      value: "low",
    });
    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/scenario full-cycle /tmp/project/profile.ts git diff --stat" }],
    });
    expect(memoryClient.files.get("/tmp/project/profile.ts")).toContain('simulatorProfile = "gemini"');
    expect(memoryClient.files.get("/tmp/project/profile.ts")).not.toContain("simulatorVerification");
    expect(memoryClient.files.get("/tmp/project/profile.ts")).not.toContain("simulatorContext");
  });

  it("remembers allow-always permission decisions for the current session", async () => {
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

    const session = await clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });
    await flushPostResponseUpdates();
    memoryClient.selectedPermissionOptionIds.push("allow-always");

    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/bash git status" }],
    });
    expect(memoryClient.permissionRequests).toHaveLength(1);

    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/bash git status" }],
    });
    expect(memoryClient.permissionRequests).toHaveLength(1);
  });

  it("auto-generates a session title from the first meaningful prompt", async () => {
    const { clientConnection, memoryClient } = await createTestRig({
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    });

    await clientConnection.initialize({
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

    const session = await clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });
    await flushPostResponseUpdates();

    memoryClient.sessionUpdates.length = 0;
    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "investigate flaky runtime resume bug and summarize" }],
    });

    const infoUpdate = memoryClient.sessionUpdates.find(
      (entry) =>
        entry.update.sessionUpdate === "session_info_update" &&
        entry.update.title !== "ACP Simulator Session",
    );
    expect(infoUpdate).toBeTruthy();
    expect(infoUpdate?.update.title).toContain("Investigate");
  });

  it("does not auto-generate a session title from command-only prompts", async () => {
    const { clientConnection, memoryClient } = await createTestRig({
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    });

    await clientConnection.initialize({
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

    const session = await clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });
    await flushPostResponseUpdates();

    memoryClient.sessionUpdates.length = 0;
    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/read /tmp/project/README.md" }],
    });

    expect(
      memoryClient.sessionUpdates.some(
        (entry) => entry.update.sessionUpdate === "session_info_update",
      ),
    ).toBe(false);
  });

  it("supports explicit session rename prompts via session_info_update", async () => {
    const { clientConnection, memoryClient } = await createTestRig({
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    });

    await clientConnection.initialize({
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

    const session = await clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });

    memoryClient.sessionUpdates.length = 0;
    const response = await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/rename Runtime Investigation" }],
    });

    expect(response.stopReason).toBe("end_turn");
    expect(
      memoryClient.sessionUpdates.some(
        (entry) =>
          entry.update.sessionUpdate === "session_info_update" &&
          entry.update.title === "Runtime Investigation",
      ),
    ).toBe(true);
  });

  it("runs a full-cycle scenario with Claude Code style multi-step tool orchestration", async () => {
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

    memoryClient.files.set("/tmp/project/index.ts", "export const before = true;\n");
    const session = await clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });
    await clientConnection.setSessionMode({
      sessionId: session.sessionId,
      modeId: "accept-edits",
    });
    memoryClient.sessionUpdates.length = 0;

    const response = await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [
        {
          type: "text",
          text: "/scenario full-cycle /tmp/project/index.ts git diff --stat",
        },
      ],
    });

    expect(response.stopReason).toBe("end_turn");
    expect(memoryClient.files.get("/tmp/project/index.ts")).toContain("simulatorEdited");
    expect(memoryClient.terminals.size).toBeGreaterThan(0);
    expect(
      memoryClient.sessionUpdates.filter((entry) => entry.update.sessionUpdate === "tool_call"),
    ).toHaveLength(3);
    expect(
      memoryClient.sessionUpdates.some(
        (entry) =>
          entry.update.sessionUpdate === "tool_call_update" &&
          entry.update.status === "completed" &&
          Array.isArray(entry.update.content) &&
          entry.update.content.some((content) => content.type === "diff"),
      ),
    ).toBe(true);
    const finalScenarioPlan = memoryClient.sessionUpdates
      .filter((entry) => entry.update.sessionUpdate === "plan")
      .at(-1);
    expect(
      finalScenarioPlan?.update.entries?.every((entry) => entry.status === "completed"),
    ).toBe(true);
    const thoughtChunks = memoryClient.sessionUpdates
      .filter((entry) => entry.update.sessionUpdate === "agent_thought_chunk")
      .map((entry) => (entry.update.content.type === "text" ? entry.update.content.text : ""));
    expect(thoughtChunks).toContain("Plan step 1/4: Inspect /tmp/project/index.ts");
    expect(thoughtChunks).toContain("Plan step 2/4: Run git diff --stat\nCommand: git diff --stat");
    expect(thoughtChunks).toContain("Plan step 3/4: Write /tmp/project/index.ts\nTarget: /tmp/project/index.ts");
    expect(thoughtChunks).toContain("Plan step 4/4: Summarize result\nPreparing final scenario summary.");
  });

  it("can inject dropped and out-of-order tool updates for edge-case clients", async () => {
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

    const session = await clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });

    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/simulate drop-next-tool-update" }],
    });
    memoryClient.sessionUpdates.length = 0;
    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/bash git status" }],
    });
    const droppedStatuses = memoryClient.sessionUpdates
      .filter((entry) => entry.update.sessionUpdate === "tool_call_update")
      .map((entry) => entry.update.status);
    expect(droppedStatuses).not.toContain("in_progress");
    expect(droppedStatuses).toContain("completed");

    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/simulate out-of-order-next-tool-update" }],
    });
    memoryClient.sessionUpdates.length = 0;
    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/bash git diff --stat" }],
    });
    const toolUpdates = memoryClient.sessionUpdates.filter(
      (entry) => entry.update.sessionUpdate === "tool_call_update",
    );
    const firstCompletedIndex = toolUpdates.findIndex((entry) => entry.update.status === "completed");
    const inProgressIndex = toolUpdates.findIndex((entry) => entry.update.status === "in_progress");
    expect(firstCompletedIndex).toBeGreaterThanOrEqual(0);
    expect(inProgressIndex).toBeGreaterThan(firstCompletedIndex);

    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/simulate duplicate-next-tool-update" }],
    });
    memoryClient.sessionUpdates.length = 0;
    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/bash git status" }],
    });
    const duplicateStatuses = memoryClient.sessionUpdates
      .filter((entry) => entry.update.sessionUpdate === "tool_call_update")
      .map((entry) => entry.update.status);
    expect(duplicateStatuses.filter((status) => status === "in_progress").length).toBeGreaterThanOrEqual(2);
  });

  it("can inject dropped and duplicated plan updates for edge-case clients", async () => {
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

    const session = await clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });
    await flushPostResponseUpdates();

    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/simulate drop-next-plan-update" }],
    });
    memoryClient.sessionUpdates.length = 0;
    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/scenario full-cycle /tmp/project/plan.ts git status" }],
    });
    const droppedPlanCount = memoryClient.sessionUpdates.filter(
      (entry) => entry.update.sessionUpdate === "plan",
    ).length;
    expect(droppedPlanCount).toBeGreaterThanOrEqual(1);

    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/simulate duplicate-next-plan-update" }],
    });
    memoryClient.sessionUpdates.length = 0;
    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/plan inspect repo | edit file" }],
    });
    const duplicatedPlans = memoryClient.sessionUpdates.filter(
      (entry) => entry.update.sessionUpdate === "plan",
    );
    expect(duplicatedPlans.length).toBeGreaterThanOrEqual(2);
  });

  it("supports timeout, hang, and crash simulations", async () => {
    let fatalExitCode: number | null = null;
    const { clientConnection } = await createTestRig(
      {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
      },
      {
        onFatalExit: (code) => {
          fatalExitCode = code;
        },
      },
    );

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

    const session = await clientConnection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });

    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "simulate timeout next prompt" }],
    });
    const timedPrompt = clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/help" }],
    });
    const timeoutProbe = await Promise.race([
      timedPrompt.then(() => "resolved"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 100)),
    ]);
    expect(timeoutProbe).toBe("pending");
    await clientConnection.cancel({ sessionId: session.sessionId });
    await expect(timedPrompt).resolves.toMatchObject({ stopReason: "cancelled" });

    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/simulate hang-next-prompt" }],
    });
    const hangingPrompt = clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/help" }],
    });
    const hangProbe = await Promise.race([
      hangingPrompt.then(() => "resolved"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 100)),
    ]);
    expect(hangProbe).toBe("pending");
    await clientConnection.cancel({ sessionId: session.sessionId });
    await expect(hangingPrompt).resolves.toMatchObject({ stopReason: "cancelled" });

    await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/simulate crash-next-prompt" }],
    });
    await expect(
      clientConnection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "/help" }],
      }),
    ).rejects.toThrow(/Internal error/);
    expect(fatalExitCode).toBe(97);
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
      modeId: "accept-edits",
    });
    expect(setMode).toEqual({});

    const setConfig = await clientConnection.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "reasoning",
      value: "high",
    });
    expect(setConfig.configOptions.find((entry) => entry.id === "reasoning")).toMatchObject({
      id: "reasoning",
      currentValue: "high",
    });

    await clientConnection.unstable_setSessionModel({
      sessionId: session.sessionId,
      modelId: "gpt",
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
    await flushPostResponseUpdates();
    expect(loaded.modes?.currentModeId).toBe("accept-edits");
    expect(memoryClient.sessionUpdates.length).toBeGreaterThan(0);

    memoryClient.sessionUpdates.length = 0;
    const resumed = await clientConnection.unstable_resumeSession({
      sessionId: session.sessionId,
      cwd: "/tmp/project",
      mcpServers: [],
    });
    expect(resumed.models?.currentModelId).toBe("gpt");
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
