import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
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
} from "@agentclientprotocol/sdk";
import { SIMULATOR_AGENT_ACP_PACKAGE } from "../index.js";

type MemoryTerminal = {
  exitCode: number;
  output: string;
};

class SmokeClient implements Client {
  readonly files = new Map<string, string>();
  readonly sessionUpdates: SessionNotification[] = [];
  readonly terminals = new Map<string, MemoryTerminal>();
  terminalId = 0;

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const allowOption = params.options.find((entry) => entry.optionId === "allow") ?? params.options[0];
    console.log("[client] permission request:", params.toolCall.title);
    return allowOption
      ? { outcome: { outcome: "selected", optionId: allowOption.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.sessionUpdates.push(params);
    console.log("[client] session/update:", params.update.sessionUpdate);
    if (params.update.sessionUpdate === "session_info_update") {
      console.log("[client] session title:", params.update.title ?? "<none>");
    }
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    this.files.set(params.path, params.content);
    console.log("[client] writeTextFile:", params.path);
    return {};
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    console.log("[client] readTextFile:", params.path);
    return {
      content: this.files.get(params.path) ?? "",
    };
  }

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const terminalId = `term-${++this.terminalId}`;
    const output = `${params.command}${params.args?.length ? ` ${params.args.join(" ")}` : ""}\n`;
    this.terminals.set(terminalId, { output, exitCode: 0 });
    console.log("[client] createTerminal:", output.trim());
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
    return { exitCode: terminal.exitCode };
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (terminal) {
      terminal.exitCode = 137;
    }
    return {};
  }

  async releaseTerminal(_params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    return {};
  }
}

async function main(): Promise<void> {
  const simulatorStorageDir = await mkdtemp(join(tmpdir(), "simulator-agent-acp-smoke-"));

  const child = spawn(
    "npx",
    ["--yes", SIMULATOR_AGENT_ACP_PACKAGE, "--storage-dir", simulatorStorageDir],
    {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "inherit"],
    },
  );

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );

  const client = new SmokeClient();
  client.files.set("/tmp/project/README.md", "hello from simulator-agent-acp\n");

  const connection = new ClientSideConnection(() => client, stream);

  try {
    const initialize = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        nes: { jump: {}, rename: {}, searchAndReplace: {} },
      },
      clientInfo: {
        name: "smoke-client",
        version: "0.1.0",
      },
    });
    console.log("[client] initialized:", initialize.agentInfo?.name);

    const session = await connection.newSession({
      cwd: "/tmp/project",
      mcpServers: [],
    });
    console.log("[client] session:", session.sessionId);

    await connection.setSessionMode({
      sessionId: session.sessionId,
      modeId: "accept-edits",
    });

    await connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "investigate simulator smoke flow and summarize findings" }],
    });

    await connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/read /tmp/project/README.md" }],
    });

    await connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/rename-session Runtime Investigation" }],
    });

    await connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/scenario full-cycle /tmp/project/README.md git diff --stat" }],
    });

    console.log("[client] final file contents:");
    console.log(client.files.get("/tmp/project/README.md") ?? "<missing>");
  } finally {
    child.kill("SIGTERM");
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
