import {
  AcpError,
  AcpCreateError,
  AcpForkError,
  AcpListError,
  AcpLoadError,
  AcpResumeError,
  AcpSystemPromptError,
} from "./errors.js";
import { resolveRuntimeAgentFromRegistry } from "../registry/agent-resolver.js";
import { AcpRuntimeSession } from "./session.js";
import { ACP_RUNTIME_SNAPSHOT_VERSION } from "./constants.js";
import type { AcpSessionDriver, AcpSessionService } from "./session-driver.js";
import {
  createAcpSessionService,
  type AcpSessionServiceOptions,
} from "../acp/session-service.js";
import { SingleFlight } from "./concurrency.js";
import { applyRuntimeInitialConfig } from "./initial-config.js";
import type { AcpConnectionFactory } from "../acp/connection-types.js";
import { resolveRuntimeHomePath } from "../paths.js";
import { AcpRuntimeSessionRegistry } from "../registry/session-registry.js";
import { AcpRuntimeJsonSessionRegistryStore } from "../registry/session-registry-store.js";
import type {
  AcpRuntimeAgent,
  AcpRuntimeAgentInput,
  AcpRuntimeCreateOptions,
  AcpRuntimeForkSessionOptions,
  AcpRuntimeInitialConfig,
  AcpRuntimeInitialConfigReport,
  AcpRuntimeListAgentSessionsOptions,
  AcpRuntimeListSessionsOptions,
  AcpRuntimeLoadOptions,
  AcpRuntimeLoadSessionOptions,
  AcpRuntimeOptions,
  AcpRuntimeRegistryListOptions,
  AcpRuntimeResumeOptions,
  AcpRuntimeResumeSessionOptions,
  AcpRuntimeSessionList,
  AcpRuntimeSessionReference,
  AcpRuntimeStoredSessionWatcher,
  AcpRuntimeSnapshot,
  AcpRuntimeStartSessionOptions,
} from "./types.js";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { emitRuntimeLog } from "../observability/logging.js";
import { sessionAttributes, withSpan } from "../observability/tracing.js";

type RuntimeConstructorOptions = AcpRuntimeOptions & {
  acp?: AcpSessionServiceOptions;
  sessionService?: AcpSessionService;
};

type ManagedSessionEntry = {
  driver: AcpSessionDriver;
  refCount: number;
  sessionId: string;
};

export class AcpRuntime {
  private readonly options: RuntimeConstructorOptions;
  private readonly sessionRegistry?: AcpRuntimeSessionRegistry;
  private readonly sessionService: AcpSessionService;
  private readonly activeSessions = new Map<string, ManagedSessionEntry>();
  private readonly closingSessions = new Map<string, Promise<void>>();
  private readonly pendingOpens = new SingleFlight<ManagedSessionEntry>();

  readonly sessions = {
    start: (options: AcpRuntimeStartSessionOptions) =>
      this.startSessionFromInput(options),
    fork: (options: AcpRuntimeForkSessionOptions) =>
      this.forkSessionFromInput(options),
    load: (options: AcpRuntimeLoadSessionOptions) =>
      this.loadSessionFromInput(options),
    resume: (options: AcpRuntimeResumeSessionOptions) =>
      this.resumeSessionFromInput(options),
    list: (options: AcpRuntimeListSessionsOptions = {}) =>
      this.listSessions(options),
    delete: (sessionId: string) => this.deleteStoredSession(sessionId),
    refresh: () => this.refreshStoredSessions(),
    watch: (watcher: AcpRuntimeStoredSessionWatcher) =>
      this.watchStoredSessions(watcher),
  } as const;

  constructor(connectionFactory: AcpConnectionFactory, options?: AcpRuntimeOptions);
  constructor(
    connectionFactory: AcpConnectionFactory,
    options: RuntimeConstructorOptions = {},
  ) {
    this.options = options;
    this.sessionRegistry = createSessionRegistry(options);
    this.sessionService =
      options.sessionService ??
      createAcpSessionService(connectionFactory, options.acp ?? {});
  }

  private async startSessionFromInput(
    options: AcpRuntimeStartSessionOptions,
  ): Promise<AcpRuntimeSession> {
    return this.startSession({
      ...options,
      agent: await this.resolveAgentInput(options.agent),
    });
  }

  private async loadSessionFromInput(
    options: AcpRuntimeLoadSessionOptions,
  ): Promise<AcpRuntimeSession> {
    assertNoSystemPromptForSessionOpen(options, "load");
    const resolved = await this.resolveSessionOpenOptions(options);
    return this.loadSession({
      ...resolved,
      sessionId: options.sessionId,
    });
  }

  private async forkSessionFromInput(
    options: AcpRuntimeForkSessionOptions,
  ): Promise<AcpRuntimeSession> {
    assertNoSystemPromptForSessionOpen(options, "fork");
    const resolved = await this.resolveSessionOpenOptions(options);
    return this.forkSession({
      ...resolved,
      sessionId: options.sessionId,
    });
  }

  private async resumeSessionFromInput(
    options: AcpRuntimeResumeSessionOptions,
  ): Promise<AcpRuntimeSession> {
    assertNoSystemPromptForSessionOpen(options, "resume");
    const resolved = await this.resolveSessionOpenOptions(options);
    const storedSnapshot = await this.getStoredSnapshot(options.sessionId);
    const snapshot: AcpRuntimeSnapshot = {
      ...(storedSnapshot ?? {
        session: { id: options.sessionId },
        version: ACP_RUNTIME_SNAPSHOT_VERSION,
      }),
      agent: resolved.agent,
      cwd: resolved.cwd,
      mcpServers: resolved.mcpServers ?? storedSnapshot?.mcpServers,
      session: { id: options.sessionId },
      version: storedSnapshot?.version ?? ACP_RUNTIME_SNAPSHOT_VERSION,
    };
    return this.resumeSession({
      handlers: options.handlers,
      initialConfig: options.initialConfig,
      queue: options.queue,
      snapshot,
    });
  }

  private async startSession(
    options: AcpRuntimeCreateOptions,
  ): Promise<AcpRuntimeSession> {
    return withSpan(
      "acp.session.start",
      {
        attributes: sessionAttributes({
          action: "start",
          agent: options.agent,
          cwd: options.cwd,
        }),
      },
      async (span, spanContext) => {
        try {
          await this.ensureRegistryHydrated();
          const driver = await this.sessionService.create({
            ...options,
            _observability: this.options.observability,
            _traceContext: spanContext,
          } as AcpRuntimeCreateOptions);
          let initialConfigReport:
            | AcpRuntimeInitialConfigReport
            | undefined;
          try {
            initialConfigReport = await applyRuntimeInitialConfig(
              driver,
              options.initialConfig,
            );
          } catch (error) {
            await driver.close().catch(() => {});
            throw error;
          }
          const sessionId = driver.snapshot().session.id;
          span.setAttribute("acp.session.id", sessionId);
          emitRuntimeLog({
            attributes: sessionAttributes({
              action: "start",
              agent: options.agent,
              cwd: options.cwd,
              sessionId,
            }),
            body: "Runtime session started.",
            context: spanContext,
            eventName: "acp.session.start",
          });
          return await this.registerManagedSession(driver, initialConfigReport);
        } catch (error) {
          emitRuntimeLog({
            attributes: sessionAttributes({
              action: "start",
              agent: options.agent,
              cwd: options.cwd,
            }),
            body: error instanceof Error ? error.message : String(error),
            context: spanContext,
            eventName: "acp.session.start.failed",
            exception: error,
            severityNumber: SeverityNumber.ERROR,
          });
          if (error instanceof AcpError) {
            throw error;
          }
          throw new AcpCreateError("Failed to create runtime session.", error);
        }
      },
    );
  }

  private async loadSession(
    options: AcpRuntimeLoadOptions,
  ): Promise<AcpRuntimeSession> {
    return withSpan(
      "acp.session.load",
      {
        attributes: sessionAttributes({
          action: "load",
          agent: options.agent,
          cwd: options.cwd,
          sessionId: options.sessionId,
        }),
      },
      async (span, spanContext) => {
        try {
          await this.ensureRegistryHydrated();
          let reused = false;
          const existing = this.activeSessions.get(options.sessionId);
          if (existing) {
            reused = true;
            span.setAttribute("acp.session.reused", true);
            emitRuntimeLog({
              attributes: sessionAttributes({
                action: "load",
                agent: options.agent,
                cwd: options.cwd,
                reused,
                sessionId: existing.sessionId,
              }),
              body: "Runtime session loaded.",
              context: spanContext,
              eventName: "acp.session.load",
            });
            if (options.queue) {
              existing.driver.setQueuePolicy(options.queue);
            }
            const initialConfigReport = await this.applyInitialConfigForOpen(
              existing,
              options.initialConfig,
            );
            return this.acquireSessionHandle(existing, initialConfigReport);
          }

          const pending = this.pendingOpens.do(options.sessionId, async () => {
            await this.waitForSessionClose(options.sessionId);
            const active = this.activeSessions.get(options.sessionId);
            if (active) {
              return active;
            }
            return this.registerManagedSessionEntry(
              await this.sessionService.load({
                ...options,
                _observability: this.options.observability,
                _traceContext: spanContext,
              } as AcpRuntimeLoadOptions),
            );
          });
          reused = this.activeSessions.has(options.sessionId);
          if (reused) {
            span.setAttribute("acp.session.reused", true);
          }

          const entry = await pending;
          if (options.queue) {
            entry.driver.setQueuePolicy(options.queue);
          }
          const initialConfigReport = await this.applyInitialConfigForOpen(
            entry,
            options.initialConfig,
          );
          span.setAttribute("acp.session.id", entry.sessionId);
          emitRuntimeLog({
            attributes: sessionAttributes({
              action: "load",
              agent: options.agent,
              cwd: options.cwd,
              reused,
              sessionId: entry.sessionId,
            }),
            body: "Runtime session loaded.",
            context: spanContext,
            eventName: "acp.session.load",
          });
          return this.acquireSessionHandle(entry, initialConfigReport);
        } catch (error) {
          emitRuntimeLog({
            attributes: sessionAttributes({
              action: "load",
              agent: options.agent,
              cwd: options.cwd,
              sessionId: options.sessionId,
            }),
            body: error instanceof Error ? error.message : String(error),
            context: spanContext,
            eventName: "acp.session.load.failed",
            exception: error,
            severityNumber: SeverityNumber.ERROR,
          });
          if (error instanceof AcpError) {
            throw error;
          }
          throw new AcpLoadError("Failed to load runtime session.", error);
        }
      },
    );
  }

  private async listRemoteSessions(
    options: AcpRuntimeListAgentSessionsOptions,
  ): Promise<AcpRuntimeSessionList> {
    return withSpan(
      "acp.session.list",
      {
        attributes: sessionAttributes({
          action: "list",
          agent: options.agent,
          cwd: options.cwd,
        }),
      },
      async (span, spanContext) => {
        try {
          await this.ensureRegistryHydrated();
          const list = await this.sessionService.listAgentSessions({
            ...options,
            _observability: this.options.observability,
            _traceContext: spanContext,
          } as AcpRuntimeListAgentSessionsOptions);
          span.setAttribute("acp.session.list.count", list.sessions.length);
          emitRuntimeLog({
            attributes: {
              ...sessionAttributes({
                action: "list",
                agent: options.agent,
                cwd: options.cwd,
              }),
              "acp.session.list.count": list.sessions.length,
            },
            body: `Listed ${list.sessions.length} remote sessions.`,
            context: spanContext,
            eventName: "acp.session.list",
          });
          return list;
        } catch (error) {
          emitRuntimeLog({
            attributes: sessionAttributes({
              action: "list",
              agent: options.agent,
              cwd: options.cwd,
            }),
            body: error instanceof Error ? error.message : String(error),
            context: spanContext,
            eventName: "acp.session.list.failed",
            exception: error,
            severityNumber: SeverityNumber.ERROR,
          });
          if (error instanceof AcpError) {
            throw error;
          }
          throw new AcpListError("Failed to list runtime sessions.", error);
        }
      },
    );
  }

  private async forkSession(
    options: AcpRuntimeForkSessionOptions & {
      agent: AcpRuntimeAgent;
      cwd: string;
    },
  ): Promise<AcpRuntimeSession> {
    return withSpan(
      "acp.session.fork",
      {
        attributes: sessionAttributes({
          action: "fork",
          agent: options.agent,
          cwd: options.cwd,
          sessionId: options.sessionId,
        }),
      },
      async (span, spanContext) => {
        try {
          await this.ensureRegistryHydrated();
          const driver = await this.sessionService.fork({
            ...options,
            _observability: this.options.observability,
            _traceContext: spanContext,
          } as AcpRuntimeForkSessionOptions & {
            agent: AcpRuntimeAgent;
            cwd: string;
          });
          let initialConfigReport:
            | AcpRuntimeInitialConfigReport
            | undefined;
          try {
            initialConfigReport = await applyRuntimeInitialConfig(
              driver,
              options.initialConfig,
            );
          } catch (error) {
            await driver.close().catch(() => {});
            throw error;
          }
          const forkedSessionId = driver.snapshot().session.id;
          span.setAttribute("acp.session.id", forkedSessionId);
          emitRuntimeLog({
            attributes: sessionAttributes({
              action: "fork",
              agent: options.agent,
              cwd: options.cwd,
              sessionId: forkedSessionId,
            }),
            body: "Runtime session forked.",
            context: spanContext,
            eventName: "acp.session.fork",
          });
          return await this.registerManagedSession(driver, initialConfigReport);
        } catch (error) {
          emitRuntimeLog({
            attributes: sessionAttributes({
              action: "fork",
              agent: options.agent,
              cwd: options.cwd,
              sessionId: options.sessionId,
            }),
            body: error instanceof Error ? error.message : String(error),
            context: spanContext,
            eventName: "acp.session.fork.failed",
            exception: error,
            severityNumber: SeverityNumber.ERROR,
          });
          if (error instanceof AcpError) {
            throw error;
          }
          throw new AcpForkError("Failed to fork runtime session.", error);
        }
      },
    );
  }

  private async listSessions(
    options: AcpRuntimeListSessionsOptions,
  ): Promise<AcpRuntimeSessionList> {
    const source = options.source ?? "all";
    const shouldListLocal = source === "all" || source === "local";
    const shouldListRemote = source === "all" || source === "remote";
    let agent: AcpRuntimeAgent | undefined;

    if (options.agent && shouldListRemote) {
      agent = await this.resolveAgentInput(options.agent);
    } else if (typeof options.agent === "object") {
      agent = options.agent;
    }

    if (source === "remote" && (!options.agent || !options.cwd)) {
      throw new AcpListError(
        "Remote session listing requires both agent and cwd.",
      );
    }

    const local = shouldListLocal
      ? await this.listStoredSessionRefs({
          agentType:
            agent?.type ??
            (typeof options.agent === "string" ? options.agent : undefined),
          cursor: options.cursor,
          cwd: options.cwd,
          limit: options.limit,
        })
      : { nextCursor: undefined, sessions: [] };

    const remote =
      shouldListRemote && agent && options.cwd
        ? await this.listRemoteSessions({
            agent,
            cursor: options.cursor,
            cwd: options.cwd,
            handlers: options.handlers,
          })
        : { nextCursor: undefined, sessions: [] };

    if (source === "local") {
      return {
        nextCursor: local.nextCursor,
        sessions: local.sessions.map((session) => ({
          ...session,
          source: "local" as const,
        })),
      };
    }

    if (source === "remote") {
      return {
        nextCursor: remote.nextCursor,
        sessions: remote.sessions.map((session) => ({
          ...session,
          source: "remote" as const,
        })),
      };
    }

    return this.mergeSessionLists(local, remote);
  }

  private async resumeSession(
    options: AcpRuntimeResumeOptions,
  ): Promise<AcpRuntimeSession> {
    return withSpan(
      "acp.session.resume",
      {
        attributes: sessionAttributes({
          action: "resume",
          agent: options.snapshot.agent,
          cwd: options.snapshot.cwd,
          sessionId: options.snapshot.session.id,
        }),
      },
      async (span, spanContext) => {
        try {
          await this.ensureRegistryHydrated();
          const sessionId = options.snapshot.session.id;
          let reused = false;
          const existing = this.activeSessions.get(sessionId);
          if (existing) {
            reused = true;
            span.setAttribute("acp.session.reused", true);
            emitRuntimeLog({
              attributes: sessionAttributes({
                action: "resume",
                agent: options.snapshot.agent,
                cwd: options.snapshot.cwd,
                reused,
                sessionId: existing.sessionId,
              }),
              body: "Runtime session resumed.",
              context: spanContext,
              eventName: "acp.session.resume",
            });
            if (options.queue) {
              existing.driver.setQueuePolicy(options.queue);
            }
            const initialConfigReport = await this.applyInitialConfigForOpen(
              existing,
              options.initialConfig,
            );
            return this.acquireSessionHandle(existing, initialConfigReport);
          }

          const pending = this.pendingOpens.do(sessionId, async () => {
            await this.waitForSessionClose(sessionId);
            const active = this.activeSessions.get(sessionId);
            if (active) {
              return active;
            }
            return this.registerManagedSessionEntry(
              await this.sessionService.resume({
                ...options,
                _observability: this.options.observability,
                _traceContext: spanContext,
              } as AcpRuntimeResumeOptions),
            );
          });
          reused = this.activeSessions.has(sessionId);
          if (reused) {
            span.setAttribute("acp.session.reused", true);
          }

          const entry = await pending;
          if (options.queue) {
            entry.driver.setQueuePolicy(options.queue);
          }
          const initialConfigReport = await this.applyInitialConfigForOpen(
            entry,
            options.initialConfig,
          );
          span.setAttribute("acp.session.id", entry.sessionId);
          emitRuntimeLog({
            attributes: sessionAttributes({
              action: "resume",
              agent: options.snapshot.agent,
              cwd: options.snapshot.cwd,
              reused,
              sessionId: entry.sessionId,
            }),
            body: "Runtime session resumed.",
            context: spanContext,
            eventName: "acp.session.resume",
          });
          return this.acquireSessionHandle(entry, initialConfigReport);
        } catch (error) {
          emitRuntimeLog({
            attributes: sessionAttributes({
              action: "resume",
              agent: options.snapshot.agent,
              cwd: options.snapshot.cwd,
              sessionId: options.snapshot.session.id,
            }),
            body: error instanceof Error ? error.message : String(error),
            context: spanContext,
            eventName: "acp.session.resume.failed",
            exception: error,
            severityNumber: SeverityNumber.ERROR,
          });
          if (error instanceof AcpError) {
            throw error;
          }
          throw new AcpResumeError("Failed to resume runtime session.", error);
        }
      },
    );
  }

  private async listStoredSessionRefs(
    options: AcpRuntimeRegistryListOptions = {},
  ): Promise<AcpRuntimeSessionList> {
    await this.ensureRegistryHydrated();
    return this.sessionRegistry?.listSessions(options) ?? {
      nextCursor: undefined,
      sessions: [],
    };
  }

  private async deleteStoredSession(sessionId: string): Promise<boolean> {
    await this.ensureRegistryHydrated();
    return this.sessionRegistry?.deleteSession(sessionId) ?? false;
  }

  private refreshStoredSessions(): void {
    this.sessionRegistry?.notifyRefresh();
  }

  private watchStoredSessions(
    watcher: AcpRuntimeStoredSessionWatcher,
  ): () => void {
    return this.sessionRegistry?.watch(watcher) ?? (() => {});
  }

  private async registerManagedSession(
    driver: AcpSessionDriver,
    initialConfigReport?: AcpRuntimeInitialConfigReport | undefined,
  ): Promise<AcpRuntimeSession> {
    const entry = await this.registerManagedSessionEntry(driver);
    return this.acquireSessionHandle(entry, initialConfigReport);
  }

  private async registerManagedSessionEntry(
    driver: AcpSessionDriver,
  ): Promise<ManagedSessionEntry> {
    const sessionId = driver.metadata.id;
    const existing = this.activeSessions.get(sessionId);
    if (existing) {
      if (existing.driver !== driver) {
        await driver.close().catch(() => {});
      }
      return existing;
    }
    await this.sessionRegistry?.rememberSnapshot(driver.snapshot(), {
      title: driver.metadata.title,
    });
    const existingAfterPersist = this.activeSessions.get(sessionId);
    if (existingAfterPersist) {
      if (existingAfterPersist.driver !== driver) {
        await driver.close().catch(() => {});
      }
      return existingAfterPersist;
    }

    const entry: ManagedSessionEntry = {
      driver,
      refCount: 0,
      sessionId,
    };
    this.activeSessions.set(sessionId, entry);
    return entry;
  }

  private acquireSessionHandle(
    entry: ManagedSessionEntry,
    initialConfigReport?: AcpRuntimeInitialConfigReport | undefined,
  ): AcpRuntimeSession {
    entry.refCount += 1;
    return this.createSession(entry, initialConfigReport);
  }

  private createSession(
    entry: ManagedSessionEntry,
    initialConfigReport?: AcpRuntimeInitialConfigReport | undefined,
  ): AcpRuntimeSession {
    return new AcpRuntimeSession(entry.driver, {
      initialConfigReport,
      onClose: async () => {
        await this.releaseSession(entry.sessionId, entry.driver);
      },
      onSnapshotChanged: async (snapshot) => {
        await this.sessionRegistry?.rememberSnapshot(snapshot);
      },
    });
  }

  private async applyInitialConfigForOpen(
    entry: ManagedSessionEntry,
    initialConfig: AcpRuntimeInitialConfig | undefined,
  ): Promise<AcpRuntimeInitialConfigReport | undefined> {
    try {
      return await applyRuntimeInitialConfig(entry.driver, initialConfig);
    } catch (error) {
      if (entry.refCount === 0 && this.activeSessions.get(entry.sessionId) === entry) {
        this.activeSessions.delete(entry.sessionId);
        await entry.driver.close().catch(() => {});
      }
      throw error;
    }
  }

  private async releaseSession(
    sessionId: string,
    driver: AcpSessionDriver,
  ): Promise<void> {
    const entry = this.activeSessions.get(sessionId);
    if (!entry || entry.driver !== driver) {
      return;
    }
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount > 0) {
      return;
    }
    this.activeSessions.delete(sessionId);
    let closing = this.closingSessions.get(sessionId);
    if (!closing) {
      closing = driver.close().finally(() => {
        if (this.closingSessions.get(sessionId) === closing) {
          this.closingSessions.delete(sessionId);
        }
      });
      this.closingSessions.set(sessionId, closing);
    }
    await closing;
  }

  private async waitForSessionClose(sessionId: string): Promise<void> {
    await this.closingSessions.get(sessionId);
  }

  private async ensureRegistryHydrated(): Promise<void> {
    await this.sessionRegistry?.hydrate();
  }

  private async getStoredSnapshot(
    sessionId: string,
  ): Promise<AcpRuntimeSnapshot | undefined> {
    await this.ensureRegistryHydrated();
    return this.sessionRegistry?.getSnapshot(sessionId);
  }

  private async resolveSessionOpenOptions(
    options: AcpRuntimeLoadSessionOptions | AcpRuntimeResumeSessionOptions,
  ): Promise<AcpRuntimeCreateOptions> {
    const storedSnapshot = await this.getStoredSnapshot(options.sessionId);
    const agent = options.agent
      ? await this.resolveAgentInput(options.agent)
      : storedSnapshot?.agent;
    const cwd = options.cwd ?? storedSnapshot?.cwd;

    if (!agent || !cwd) {
      throw new AcpLoadError(
        "Opening a session by id requires agent and cwd unless a local stored snapshot exists.",
      );
    }

    return {
      agent,
      cwd,
      handlers: options.handlers,
      initialConfig: options.initialConfig,
      mcpServers: options.mcpServers ?? storedSnapshot?.mcpServers,
      queue: options.queue,
    };
  }

  private mergeSessionLists(
    local: AcpRuntimeSessionList,
    remote: AcpRuntimeSessionList,
  ): AcpRuntimeSessionList {
    const sessions = new Map<string, AcpRuntimeSessionReference>();
    for (const session of local.sessions) {
      sessions.set(session.id, {
        ...session,
        source: "local",
      });
    }
    for (const session of remote.sessions) {
      const existing = sessions.get(session.id);
      sessions.set(session.id, {
        ...existing,
        ...session,
        source: existing ? "both" : "remote",
        updatedAt: existing?.updatedAt ?? session.updatedAt,
      });
    }
    return {
      nextCursor: remote.nextCursor ?? local.nextCursor,
      sessions: [...sessions.values()],
    };
  }

  private async resolveAgentInput(agent: AcpRuntimeAgentInput) {
    return typeof agent === "string" ? this.resolveAgent(agent) : agent;
  }

  private async resolveAgent(agentId: string) {
    return (this.options.agentResolver ?? resolveRuntimeAgentFromRegistry)(
      agentId,
    );
  }
}

function createSessionRegistry(
  options: RuntimeConstructorOptions,
): AcpRuntimeSessionRegistry | undefined {
  if (options.state === false || options.state?.enabled === false) {
    return undefined;
  }

  return new AcpRuntimeSessionRegistry({
    store: new AcpRuntimeJsonSessionRegistryStore(
      options.state?.sessionRegistryPath ??
        resolveRuntimeHomePath("state", "runtime-session-registry.json"),
    ),
  });
}

function assertNoSystemPromptForSessionOpen(
  options: object,
  action: "fork" | "load" | "resume",
): void {
  if (
    Object.prototype.hasOwnProperty.call(options, "systemPrompt") &&
    (options as { systemPrompt?: unknown }).systemPrompt !== undefined
  ) {
    throw new AcpSystemPromptError(
      `sessions.${action}() does not accept option "systemPrompt". Use sessions.start() to create a new session with a system prompt.`,
    );
  }
}
