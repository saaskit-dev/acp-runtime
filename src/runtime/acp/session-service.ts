import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

import { AcpAuthenticationError, AcpProtocolError } from "../core/errors.js";
import type { AcpSessionDriver, AcpSessionService } from "../core/session-driver.js";
import type {
  AcpRuntimeAuthorityHandlers,
  AcpRuntimeConfigValue,
  AcpRuntimeCreateOptions,
  AcpRuntimeListAgentSessionsOptions,
  AcpRuntimeLoadOptions,
  AcpRuntimeResumeOptions,
  AcpRuntimeSessionList,
} from "../core/types.js";
import { AcpClientBridge } from "./authority-bridge.js";
import type {
  AcpClientInfo,
  AcpConnectionFactory,
  AcpOptions,
} from "./connection-types.js";
import { mapMcpServersToAcp } from "./connection-types.js";
import { AcpSdkSessionDriver } from "./driver.js";
import { resolveAcpAgentProfile } from "./profiles/index.js";

const DEFAULT_CLIENT_INFO = {
  name: "acp-runtime",
  version: "0.1.0",
} as const satisfies AcpClientInfo;

export type AcpSessionServiceOptions = AcpOptions;

export function createAcpSessionService(
  connectionFactory: AcpConnectionFactory,
  options: AcpSessionServiceOptions = {},
): AcpSessionService {
  return {
    async create(input: AcpRuntimeCreateOptions): Promise<AcpSessionDriver> {
      const bootstrap = await bootstrapAcpSession({
        connectionFactory,
        connectionOptions: options,
        agent: input.agent,
        cwd: input.cwd,
        handlers: input.handlers,
      });
      const response = await bootstrap.connection.newSession({
        cwd: input.cwd,
        mcpServers: mapMcpServersToAcp(input.mcpServers ?? []),
      });
      const profile = resolveAcpAgentProfile(input.agent);

      const driver = new AcpSdkSessionDriver(bootstrap.bridge, {
        agent: input.agent,
        connection: bootstrap.connection,
        cwd: input.cwd,
        dispose: bootstrap.dispose,
        handlers: input.handlers,
        initializeResponse: bootstrap.initializeResponse,
        mcpServers: input.mcpServers ?? [],
        profile,
        response,
        sessionId: response.sessionId,
      });
      return driver;
    },

    async listAgentSessions(
      input: AcpRuntimeListAgentSessionsOptions,
    ): Promise<AcpRuntimeSessionList> {
      const bootstrap = await bootstrapAcpSession({
        connectionFactory,
        connectionOptions: options,
        agent: input.agent,
        cwd: input.cwd,
        handlers: input.handlers,
      });
      try {
        if (!bootstrap.connection.listSessions) {
          throw new AcpProtocolError(
            "ACP agent does not support session/list.",
          );
        }

        const response = await bootstrap.connection.listSessions({
          cursor: input.cursor ?? null,
          cwd: input.cwd,
        });

        return {
          nextCursor: response.nextCursor ?? undefined,
          sessions: response.sessions.map((session) => ({
            agentType: input.agent.type,
            cwd: session.cwd,
            id: session.sessionId,
            title: session.title ?? undefined,
            updatedAt: session.updatedAt ?? undefined,
          })),
        };
      } finally {
        await bootstrap.dispose?.();
      }
    },

    async load(input: AcpRuntimeLoadOptions): Promise<AcpSessionDriver> {
      const bootstrap = await bootstrapAcpSession({
        connectionFactory,
        connectionOptions: options,
        agent: input.agent,
        cwd: input.cwd,
        handlers: input.handlers,
      });
      if (!bootstrap.connection.loadSession) {
        throw new AcpProtocolError("ACP agent does not support session/load.");
      }

      const response = await bootstrap.connection.loadSession({
        cwd: input.cwd,
        mcpServers: mapMcpServersToAcp(input.mcpServers ?? []),
        sessionId: input.sessionId,
      });
      const profile = resolveAcpAgentProfile(input.agent);

      const driver = new AcpSdkSessionDriver(bootstrap.bridge, {
        agent: input.agent,
        connection: bootstrap.connection,
        cwd: input.cwd,
        dispose: bootstrap.dispose,
        handlers: input.handlers,
        initializeResponse: bootstrap.initializeResponse,
        mcpServers: input.mcpServers ?? [],
        profile,
        response,
        sessionId: input.sessionId,
      });
      return driver;
    },

    async resume(input: AcpRuntimeResumeOptions): Promise<AcpSessionDriver> {
      const bootstrap = await bootstrapAcpSession({
        connectionFactory,
        connectionOptions: options,
        agent: input.snapshot.agent,
        cwd: input.snapshot.cwd,
        handlers: input.handlers,
      });
      if (!bootstrap.connection.unstable_resumeSession) {
        throw new AcpProtocolError(
          "ACP agent does not support session/resume.",
        );
      }

      const response = await bootstrap.connection.unstable_resumeSession({
        cwd: input.snapshot.cwd,
        mcpServers: mapMcpServersToAcp(input.snapshot.mcpServers ?? []),
        sessionId: input.snapshot.session.id,
      });
      const profile = resolveAcpAgentProfile(input.snapshot.agent);

      const driver = new AcpSdkSessionDriver(bootstrap.bridge, {
        agent: input.snapshot.agent,
        connection: bootstrap.connection,
        cwd: input.snapshot.cwd,
        dispose: bootstrap.dispose,
        handlers: input.handlers,
        initializeResponse: bootstrap.initializeResponse,
        mcpServers: input.snapshot.mcpServers ?? [],
        profile,
        response,
        sessionId: input.snapshot.session.id,
      });
      try {
        await applySnapshotMode(
          bootstrap.connection,
          input.snapshot.session.id,
          input.snapshot.currentModeId,
        );
        await applySnapshotConfig(
          bootstrap.connection,
          input.snapshot.session.id,
          input.snapshot.config,
        );
      } catch (error) {
        await driver.close().catch(() => {});
        throw error;
      }
      return driver;
    },
  };
}

async function bootstrapAcpSession(input: {
  connectionFactory: AcpConnectionFactory;
  connectionOptions: AcpOptions;
  agent: import("../core/types.js").AcpRuntimeAgent;
  cwd: string;
  handlers?: AcpRuntimeAuthorityHandlers;
}) {
  const bridge = new AcpClientBridge(input.handlers);
  const handle = await input.connectionFactory({
    agent: input.agent,
    client: bridge,
    cwd: input.cwd,
  });
  const initializeResponse = await handle.connection.initialize({
    clientCapabilities: {
      auth: input.handlers?.authentication
        ? { terminal: Boolean(input.handlers.terminal) }
        : undefined,
      fs: input.handlers?.filesystem
        ? {
            readTextFile: true,
            writeTextFile: true,
          }
        : undefined,
      terminal: Boolean(input.handlers?.terminal),
    },
    clientInfo: input.connectionOptions.clientInfo ?? DEFAULT_CLIENT_INFO,
    protocolVersion: PROTOCOL_VERSION,
  });

  if (
    initializeResponse.authMethods?.length &&
    input.handlers?.authentication
  ) {
    const selection = await input.handlers.authentication({
      agent: {
        args: input.agent.args,
        command: input.agent.command,
        env: input.agent.env,
        type: input.agent.type,
      },
      methods: initializeResponse.authMethods.map((method) => ({
        description: method.description ?? undefined,
        id: method.id,
        title: method.name,
      })),
    });

    if ("cancel" in selection) {
      throw new AcpAuthenticationError("Authentication cancelled.");
    }

    await handle.connection.authenticate({
      methodId: selection.methodId,
    });
  }

  return {
    bridge,
    connection: handle.connection,
    dispose: handle.dispose,
    initializeResponse,
  };
}

async function applySnapshotConfig(
  connection: import("./connection-types.js").AcpConnection,
  sessionId: string,
  config: Readonly<Record<string, AcpRuntimeConfigValue>> | undefined,
): Promise<void> {
  if (!config || Object.keys(config).length === 0) {
    return;
  }

  if (!connection.setSessionConfigOption) {
    throw new AcpProtocolError(
      "ACP agent does not support restoring runtime config options.",
    );
  }

  for (const [configId, value] of Object.entries(config)) {
    if (typeof value === "boolean") {
      await connection.setSessionConfigOption({
        configId,
        sessionId,
        type: "boolean",
        value,
      });
      continue;
    }

    await connection.setSessionConfigOption({
      configId,
      sessionId,
      value: String(value),
    });
  }
}

async function applySnapshotMode(
  connection: import("./connection-types.js").AcpConnection,
  sessionId: string,
  currentModeId: string | undefined,
): Promise<void> {
  if (!currentModeId) {
    return;
  }

  if (!connection.setSessionMode) {
    throw new AcpProtocolError(
      "ACP agent does not support restoring runtime mode state.",
    );
  }

  await connection.setSessionMode({
    modeId: currentModeId,
    sessionId,
  });
}
