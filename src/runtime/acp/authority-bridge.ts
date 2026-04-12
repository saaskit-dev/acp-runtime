import type {
  Client,
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

import type { AcpRuntimeAuthorityHandlers } from "../types.js";

export class AcpClientBridge implements Client {
  private bufferedUpdates: SessionNotification[] = [];
  private permissionHandler:
    | ((params: RequestPermissionRequest) => Promise<RequestPermissionResponse>)
    | undefined;
  private sessionUpdateHandler:
    | ((params: SessionNotification) => Promise<void>)
    | undefined;

  constructor(private readonly handlers?: AcpRuntimeAuthorityHandlers) {}

  setPermissionHandler(
    handler: (
      params: RequestPermissionRequest,
    ) => Promise<RequestPermissionResponse>,
  ): void {
    this.permissionHandler = handler;
  }

  setSessionUpdateHandler(
    handler: (params: SessionNotification) => Promise<void>,
  ): void {
    this.sessionUpdateHandler = handler;
    const pending = this.bufferedUpdates;
    this.bufferedUpdates = [];
    void (async () => {
      for (const update of pending) {
        await handler(update);
      }
    })();
  }

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (this.permissionHandler) {
      return this.permissionHandler(params);
    }

    return {
      outcome: {
        outcome: "cancelled",
      },
    };
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    if (!this.sessionUpdateHandler) {
      this.bufferedUpdates.push(params);
      return;
    }

    await this.sessionUpdateHandler(params);
  }

  async writeTextFile(
    params: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    if (!this.handlers?.filesystem) {
      throw new Error(
        "ACP agent requested writeTextFile without a filesystem handler.",
      );
    }

    await this.handlers.filesystem.writeTextFile({
      content: params.content,
      path: params.path,
    });
    return {};
  }

  async readTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    if (!this.handlers?.filesystem) {
      throw new Error(
        "ACP agent requested readTextFile without a filesystem handler.",
      );
    }

    return {
      content: await this.handlers.filesystem.readTextFile(params.path),
    };
  }

  async createTerminal(
    params: CreateTerminalRequest,
  ): Promise<CreateTerminalResponse> {
    if (!this.handlers?.terminal) {
      throw new Error(
        "ACP agent requested terminal access without a terminal handler.",
      );
    }

    return this.handlers.terminal.start({
      args: params.args ?? undefined,
      command: params.command,
      cwd: params.cwd ?? undefined,
      env: params.env?.reduce<Record<string, string>>((acc, entry) => {
        acc[entry.name] = entry.value;
        return acc;
      }, {}),
    });
  }

  async terminalOutput(
    params: TerminalOutputRequest,
  ): Promise<TerminalOutputResponse> {
    if (!this.handlers?.terminal) {
      throw new Error(
        "ACP agent requested terminal output without a terminal handler.",
      );
    }

    const output = await this.handlers.terminal.output(params.terminalId);
    return {
      exitStatus:
        output.exitCode === null
          ? undefined
          : {
              exitCode: output.exitCode,
            },
      output: output.output,
      truncated: output.truncated,
    };
  }

  async waitForTerminalExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    if (!this.handlers?.terminal) {
      throw new Error(
        "ACP agent requested terminal wait without a terminal handler.",
      );
    }

    return this.handlers.terminal.wait(params.terminalId);
  }

  async killTerminal(
    params: KillTerminalRequest,
  ): Promise<KillTerminalResponse> {
    if (!this.handlers?.terminal) {
      throw new Error(
        "ACP agent requested terminal kill without a terminal handler.",
      );
    }

    await this.handlers.terminal.kill(params.terminalId);
    return {};
  }

  async releaseTerminal(
    params: ReleaseTerminalRequest,
  ): Promise<ReleaseTerminalResponse> {
    if (!this.handlers?.terminal) {
      throw new Error(
        "ACP agent requested terminal release without a terminal handler.",
      );
    }

    await this.handlers.terminal.release(params.terminalId);
    return {};
  }
}
