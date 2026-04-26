import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

import { AcpAuthenticationError, AcpProtocolError } from "../core/errors.js";
import type { AcpSessionDriver, AcpSessionService } from "../core/session-driver.js";
import type {
  AcpRuntimeAuthorityHandlers,
  AcpRuntimeConfigValue,
  AcpRuntimeCreateOptions,
  AcpRuntimeListAgentSessionsOptions,
  AcpRuntimeLoadOptions,
  AcpRuntimeObservabilityOptions,
  AcpRuntimeResumeOptions,
  AcpRuntimeSessionList,
} from "../core/types.js";
import { AcpClientBridge } from "./authority-bridge.js";
import type {
  AcpClientInfo,
  AcpConnectionFactory,
  AcpOptions,
} from "./connection-types.js";
import { mapInitializeResponseToCapabilities } from "./capability-mapper.js";
import { mapMcpServersToAcp } from "./connection-types.js";
import { AcpSdkSessionDriver } from "./driver.js";
import { emitRuntimeLog } from "../observability/logging.js";
import { mergeTraceMeta, sessionAttributes, withSpan } from "../observability/tracing.js";
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
        observability: getObservabilityOptions(input),
        traceContext: getTraceContext(input),
      });
      const response = await bootstrap.connection.newSession(
        mergeTraceMeta(
          {
            cwd: input.cwd,
            mcpServers: mapMcpServersToAcp(input.mcpServers ?? []),
          },
          getTraceContext(input),
        ),
      );
      const profile = resolveAcpAgentProfile(input.agent);

      const driver = new AcpSdkSessionDriver(bootstrap.bridge, {
        agent: input.agent,
        connection: bootstrap.connection,
        cwd: input.cwd,
        dispose: bootstrap.dispose,
        handlers: input.handlers,
        initializeResponse: bootstrap.initializeResponse,
        mcpServers: input.mcpServers ?? [],
        observability: getObservabilityOptions(input),
        profile,
        queue: input.queue,
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
        observability: getObservabilityOptions(input),
        traceContext: getTraceContext(input),
      });
      try {
        if (!bootstrap.connection.listSessions) {
          throw new AcpProtocolError(
            "ACP agent does not support session/list.",
          );
        }

        const response = await bootstrap.connection.listSessions(
          mergeTraceMeta(
            {
              cursor: input.cursor ?? null,
              cwd: input.cwd,
            },
            getTraceContext(input),
          ),
        );

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
        observability: getObservabilityOptions(input),
        traceContext: getTraceContext(input),
      });
      if (!bootstrap.connection.loadSession) {
        throw new AcpProtocolError("ACP agent does not support session/load.");
      }

      const response = await bootstrap.connection.loadSession(
        mergeTraceMeta(
          {
            cwd: input.cwd,
            mcpServers: mapMcpServersToAcp(input.mcpServers ?? []),
            sessionId: input.sessionId,
          },
          getTraceContext(input),
        ),
      );
      const profile = resolveAcpAgentProfile(input.agent);

      const driver = new AcpSdkSessionDriver(bootstrap.bridge, {
        agent: input.agent,
        connection: bootstrap.connection,
        cwd: input.cwd,
        dispose: bootstrap.dispose,
        handlers: input.handlers,
        initializeResponse: bootstrap.initializeResponse,
        mcpServers: input.mcpServers ?? [],
        observability: getObservabilityOptions(input),
        profile,
        queue: input.queue,
        response,
        sessionId: input.sessionId,
      });
      await bootstrap.bridge.waitForBufferedSessionUpdates();
      driver.sealHistoryReplay();
      return driver;
    },

    async resume(input: AcpRuntimeResumeOptions): Promise<AcpSessionDriver> {
      const bootstrap = await bootstrapAcpSession({
        connectionFactory,
        connectionOptions: options,
        agent: input.snapshot.agent,
        cwd: input.snapshot.cwd,
        handlers: input.handlers,
        observability: getObservabilityOptions(input),
        traceContext: getTraceContext(input),
      });
      if (!bootstrap.connection.resumeSession) {
        throw new AcpProtocolError(
          "ACP agent does not support session/resume.",
        );
      }

      const response = await bootstrap.connection.resumeSession(
        mergeTraceMeta(
          {
            cwd: input.snapshot.cwd,
            mcpServers: mapMcpServersToAcp(input.snapshot.mcpServers ?? []),
            sessionId: input.snapshot.session.id,
          },
          getTraceContext(input),
        ),
      );
      const profile = resolveAcpAgentProfile(input.snapshot.agent);

      const driver = new AcpSdkSessionDriver(bootstrap.bridge, {
        agent: input.snapshot.agent,
        connection: bootstrap.connection,
        cwd: input.snapshot.cwd,
        dispose: bootstrap.dispose,
        handlers: input.handlers,
        initializeResponse: bootstrap.initializeResponse,
        mcpServers: input.snapshot.mcpServers ?? [],
        observability: getObservabilityOptions(input),
        profile,
        queue: input.queue,
        response,
        sessionId: input.snapshot.session.id,
      });
      try {
        await applySnapshotMode(
          bootstrap.connection,
          input.snapshot.session.id,
          input.snapshot.currentModeId,
          getTraceContext(input),
        );
        await applySnapshotConfig(
          bootstrap.connection,
          input.snapshot.session.id,
          input.snapshot.config,
          getTraceContext(input),
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
  observability?: AcpRuntimeObservabilityOptions;
  traceContext?: import("@opentelemetry/api").Context;
}) {
  const bridge = new AcpClientBridge(input.handlers);
  const profile = resolveAcpAgentProfile(input.agent);
  const handle = await input.connectionFactory({
    agent: input.agent,
    client: bridge,
    cwd: input.cwd,
    observability: input.observability,
    traceContext: input.traceContext,
  });
  const initializeResponse = await withSpan(
    "acp.session.initialize",
    {
      attributes: sessionAttributes({
        action: "start",
        agent: input.agent,
        cwd: input.cwd,
      }),
      parentContext: input.traceContext,
    },
    async (_span, spanContext) =>
      handle.connection.initialize(
        mergeTraceMeta(
          {
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
          },
          spanContext,
        ),
      ).then((response) => {
        emitRuntimeLog({
          attributes: sessionAttributes({
            action: "start",
            agent: input.agent,
            cwd: input.cwd,
          }),
          body: "ACP session initialized.",
          context: spanContext,
          eventName: "acp.session.initialize",
        });
        return response;
      }),
  );
  const normalizedInitializeResponse = {
    ...initializeResponse,
    authMethods: [
      ...(
        profile.normalizeInitializeAuthMethods?.({
          agent: input.agent,
          authMethods: initializeResponse.authMethods ?? undefined,
        }) ?? initializeResponse.authMethods ?? []
      ),
    ],
  };

  if (
    normalizedInitializeResponse.authMethods?.length &&
    input.handlers?.authentication
  ) {
    const selection = await input.handlers.authentication({
      agent: {
        args: input.agent.args,
        command: input.agent.command,
        env: input.agent.env,
        type: input.agent.type,
      },
      methods: mapInitializeResponseToCapabilities({
        handlers: input.handlers,
        response: normalizedInitializeResponse,
      }).authMethods ?? [],
    });

    if ("cancel" in selection) {
      throw new AcpAuthenticationError("Authentication cancelled.");
    }

    await withSpan(
      "acp.session.authenticate",
      {
        attributes: {
          "acp.agent.type": input.agent.type,
          "acp.auth.method_id": selection.methodId,
        },
        parentContext: input.traceContext,
      },
      async (_span, spanContext) =>
        handle.connection.authenticate(
          mergeTraceMeta(
            {
              methodId: selection.methodId,
            },
            spanContext,
          ),
        ).then((result) => {
          emitRuntimeLog({
            attributes: {
              "acp.agent.type": input.agent.type,
              "acp.auth.method_id": selection.methodId,
            },
            body: "ACP session authenticated.",
            context: spanContext,
            eventName: "acp.session.authenticate",
          });
          return result;
        }),
    );
  }

  return {
    bridge,
    connection: handle.connection,
    dispose: handle.dispose,
    initializeResponse: normalizedInitializeResponse,
  };
}

function getTraceContext(
  input: object,
): import("@opentelemetry/api").Context | undefined {
  return (input as { _traceContext?: import("@opentelemetry/api").Context })
    ._traceContext;
}

function getObservabilityOptions(
  input: object,
): AcpRuntimeObservabilityOptions | undefined {
  return (input as { _observability?: AcpRuntimeObservabilityOptions })
    ._observability;
}

async function applySnapshotConfig(
  connection: import("./connection-types.js").AcpConnection,
  sessionId: string,
  config: Readonly<Record<string, AcpRuntimeConfigValue>> | undefined,
  traceContext?: import("@opentelemetry/api").Context,
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
        ...(mergeTraceMeta(
          {
            configId,
            sessionId,
            type: "boolean" as const,
            value,
          },
          traceContext,
        ) as {
          configId: string;
          sessionId: string;
          type: "boolean";
          value: boolean;
        }),
      });
      continue;
    }

    await connection.setSessionConfigOption(
      mergeTraceMeta(
        {
          configId,
          sessionId,
          value: String(value),
        },
        traceContext,
      ),
    );
  }
}

async function applySnapshotMode(
  connection: import("./connection-types.js").AcpConnection,
  sessionId: string,
  currentModeId: string | undefined,
  traceContext?: import("@opentelemetry/api").Context,
): Promise<void> {
  if (!currentModeId) {
    return;
  }

  if (!connection.setSessionMode) {
    throw new AcpProtocolError(
      "ACP agent does not support restoring runtime mode state.",
    );
  }

  await connection.setSessionMode(
    mergeTraceMeta(
      {
        modeId: currentModeId,
        sessionId,
      },
      traceContext,
    ),
  );
}
