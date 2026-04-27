import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

import {
  AcpAuthenticationError,
  AcpProtocolError,
  AcpSystemPromptError,
} from "../core/errors.js";
import type { AcpSessionDriver, AcpSessionService } from "../core/session-driver.js";
import type {
  AcpRuntimeAuthorityHandlers,
  AcpRuntimeCreateOptions,
  AcpRuntimeForkSessionOptions,
  AcpRuntimeListAgentSessionsOptions,
  AcpRuntimeLoadOptions,
  AcpRuntimeObservabilityOptions,
  AcpRuntimeResumeOptions,
  AcpRuntimeSessionList,
} from "../core/types.js";
import type { AcpRuntimeAgent } from "../core/types.js";
import { AcpClientBridge } from "./authority-bridge.js";
import type {
  AcpClientInfo,
  AcpConnectionFactory,
  AcpOptions,
} from "./connection-types.js";
import { mapInitializeResponseToCapabilities } from "./capability-mapper.js";
import { mapMcpServersToAcp } from "./connection-types.js";
import { AcpSdkSessionDriver } from "./driver.js";
import { selectRuntimeAuthenticationMethod } from "../core/authentication-utils.js";
import { emitRuntimeLog } from "../observability/logging.js";
import { mergeTraceMeta, sessionAttributes, withSpan } from "../observability/tracing.js";
import { resolveAcpAgentProfile } from "./profiles/index.js";
import type { AcpAgentProfile } from "./profiles/profile.js";

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
      const systemPrompt = prepareSystemPrompt({
        agent: input.agent,
        systemPrompt: input.systemPrompt,
      });
      const bootstrap = await bootstrapAcpSession({
        connectionFactory,
        connectionOptions: options,
        agent: systemPrompt.agent,
        cwd: input.cwd,
        handlers: input.handlers,
        observability: getObservabilityOptions(input),
        traceContext: getTraceContext(input),
      });
      try {
        const response = await bootstrap.connection.newSession(
          mergeTraceMeta(
            {
              _meta: systemPrompt.sessionMeta,
              cwd: input.cwd,
              mcpServers: mapMcpServersToAcp(input.mcpServers ?? []),
            },
            getTraceContext(input),
          ),
        );

        const driver = new AcpSdkSessionDriver(bootstrap.bridge, {
          agent: systemPrompt.agent,
          connection: bootstrap.connection,
          cwd: input.cwd,
          dispose: bootstrap.dispose,
          handlers: input.handlers,
          initializeResponse: bootstrap.initializeResponse,
          mcpServers: input.mcpServers ?? [],
          observability: getObservabilityOptions(input),
          profile: systemPrompt.profile,
          queue: input.queue,
          response,
          sessionId: response.sessionId,
        });
        return driver;
      } catch (error) {
        await Promise.resolve(bootstrap.dispose?.()).catch(() => {});
        throw error;
      }
    },

    async fork(
      input: AcpRuntimeForkSessionOptions & {
        agent: AcpRuntimeAgent;
        cwd: string;
      },
    ): Promise<AcpSessionDriver> {
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
        if (!bootstrap.connection.unstable_forkSession) {
          throw new AcpProtocolError("ACP agent does not support session/fork.");
        }

        const response = await bootstrap.connection.unstable_forkSession(
          mergeTraceMeta(
            {
              cwd: input.cwd,
              mcpServers: mapMcpServersToAcp(input.mcpServers ?? []),
              sessionId: input.sessionId,
            },
            getTraceContext(input),
          ),
        );

        const driver = new AcpSdkSessionDriver(bootstrap.bridge, {
          agent: input.agent,
          connection: bootstrap.connection,
          cwd: input.cwd,
          dispose: bootstrap.dispose,
          handlers: input.handlers,
          initializeResponse: bootstrap.initializeResponse,
          mcpServers: input.mcpServers ?? [],
          observability: getObservabilityOptions(input),
          profile: resolveAcpAgentProfile(input.agent),
          queue: input.queue,
          response,
          sessionId: response.sessionId,
        });
        return driver;
      } catch (error) {
        await Promise.resolve(bootstrap.dispose?.()).catch(() => {});
        throw error;
      }
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
      try {
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

        const driver = new AcpSdkSessionDriver(bootstrap.bridge, {
          agent: input.agent,
          connection: bootstrap.connection,
          cwd: input.cwd,
          dispose: bootstrap.dispose,
          handlers: input.handlers,
          initializeResponse: bootstrap.initializeResponse,
          mcpServers: input.mcpServers ?? [],
          observability: getObservabilityOptions(input),
          profile: resolveAcpAgentProfile(input.agent),
          queue: input.queue,
          response,
          sessionId: input.sessionId,
        });
        await bootstrap.bridge.waitForBufferedSessionUpdates();
        driver.sealHistoryReplay();
        return driver;
      } catch (error) {
        await Promise.resolve(bootstrap.dispose?.()).catch(() => {});
        throw error;
      }
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
      try {
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

        const driver = new AcpSdkSessionDriver(bootstrap.bridge, {
          agent: input.snapshot.agent,
          connection: bootstrap.connection,
          cwd: input.snapshot.cwd,
          dispose: bootstrap.dispose,
          handlers: input.handlers,
          initializeResponse: bootstrap.initializeResponse,
          mcpServers: input.snapshot.mcpServers ?? [],
          observability: getObservabilityOptions(input),
          profile: resolveAcpAgentProfile(input.snapshot.agent),
          queue: input.queue,
          response,
          sessionId: input.snapshot.session.id,
        });
        return driver;
      } catch (error) {
        await Promise.resolve(bootstrap.dispose?.()).catch(() => {});
        throw error;
      }
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
  try {
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
              clientInfo:
                input.connectionOptions.clientInfo ?? DEFAULT_CLIENT_INFO,
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

    if (normalizedInitializeResponse.authMethods?.length) {
      const mappedCapabilities = mapInitializeResponseToCapabilities({
        handlers: input.handlers,
        response: normalizedInitializeResponse,
      });
      const methods = await profile.normalizeRuntimeAuthenticationMethods!({
        agent: input.agent,
        methods: mappedCapabilities.authMethods ?? [],
      });
      const selection = input.handlers?.authentication
        ? await input.handlers.authentication({
            agent: {
              args: input.agent.args,
              command: input.agent.command,
              env: input.agent.env,
              type: input.agent.type,
            },
            methods,
          })
        : resolveAutomaticAuthenticationSelection(methods);

      if (!selection) {
        // Without a host auth handler, only protocol-only agent auth methods can
        // be selected safely. Terminal/env auth still requires host UI/execution.
      } else if ("cancel" in selection) {
        throw new AcpAuthenticationError("Authentication cancelled.");
      } else {
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
            authenticateOrSkipUnsupported({
              agent: input.agent,
              connection: handle.connection,
              methodId: selection.methodId,
              spanContext,
            }),
        );
      }
    }

    return {
      bridge,
      connection: handle.connection,
      dispose: handle.dispose,
      initializeResponse: normalizedInitializeResponse,
    };
  } catch (error) {
    await Promise.resolve(handle.dispose?.()).catch(() => {});
    throw error;
  }
}

async function authenticateOrSkipUnsupported(input: {
  agent: AcpRuntimeAgent;
  connection: import("./connection-types.js").AcpConnection;
  methodId: string;
  spanContext?: import("@opentelemetry/api").Context;
}) {
  try {
    const result = await input.connection.authenticate(
      mergeTraceMeta(
        {
          methodId: input.methodId,
        },
        input.spanContext,
      ),
    );
    emitRuntimeLog({
      attributes: {
        "acp.agent.type": input.agent.type,
        "acp.auth.method_id": input.methodId,
      },
      body: "ACP session authenticated.",
      context: input.spanContext,
      eventName: "acp.session.authenticate",
    });
    return result;
  } catch (error) {
    if (!isAuthenticationNotImplementedError(error)) {
      throw error;
    }

    emitRuntimeLog({
      attributes: {
        "acp.agent.type": input.agent.type,
        "acp.auth.method_id": input.methodId,
        "acp.auth.skipped": true,
      },
      body: "ACP agent does not implement authenticate; skipping authentication.",
      context: input.spanContext,
      eventName: "acp.session.authenticate.skipped",
    });
  }
}

function resolveAutomaticAuthenticationSelection(
  methods: readonly import("../core/types.js").AcpRuntimeAuthenticationMethod[],
): { methodId: string } | undefined {
  const method = selectRuntimeAuthenticationMethod(methods);
  if (!method || method.type !== "agent") {
    return undefined;
  }
  return { methodId: method.id };
}

function isAuthenticationNotImplementedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const value = error as {
    data?: unknown;
    message?: unknown;
  };
  if (
    typeof value.message === "string" &&
    value.message.toLowerCase().includes("authentication not implemented")
  ) {
    return true;
  }

  const details = extractErrorDetails(value.data);
  return (
    typeof details === "string" &&
    details.toLowerCase().includes("authentication not implemented")
  );
}

function extractErrorDetails(data: unknown): string | undefined {
  if (typeof data === "string") {
    return data;
  }

  if (!data || typeof data !== "object") {
    return undefined;
  }

  const details = (data as { details?: unknown }).details;
  return typeof details === "string" ? details : undefined;
}

function prepareSystemPrompt(input: {
  agent: AcpRuntimeAgent;
  systemPrompt?: string | undefined;
}): {
  agent: AcpRuntimeAgent;
  profile: AcpAgentProfile;
  sessionMeta?: Record<string, unknown> | undefined;
} {
  const profile = resolveAcpAgentProfile(input.agent);
  const systemPrompt = input.systemPrompt?.trim();
  if (!systemPrompt) {
    return {
      agent: input.agent,
      profile,
    };
  }

  const agent =
    profile.applySystemPromptToAgent?.({
      agent: input.agent,
      systemPrompt,
    }) ?? input.agent;
  const sessionMeta = profile.createSystemPromptSessionMeta?.({
    systemPrompt,
  });

  if (agent === input.agent && !sessionMeta) {
    throw new AcpSystemPromptError(
      `ACP agent ${input.agent.type ?? input.agent.command} does not support systemPrompt.`,
    );
  }

  return {
    agent,
    profile: resolveAcpAgentProfile(agent),
    sessionMeta,
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
