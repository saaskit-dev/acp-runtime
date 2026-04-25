import {
  AcpError,
  AcpCreateError,
  AcpListError,
  AcpLoadError,
  AcpResumeError,
} from "./errors.js";
import { resolveRuntimeAgentFromRegistry } from "../registry/agent-resolver.js";
import { AcpRuntimeSession } from "./session.js";
import type { AcpSessionDriver, AcpSessionService } from "./session-driver.js";
import {
  createAcpSessionService,
  type AcpSessionServiceOptions,
} from "../acp/session-service.js";
import type { AcpConnectionFactory } from "../acp/connection-types.js";
import type {
  AcpRuntimeCreateOptions,
  AcpRuntimeCreateFromRegistryOptions,
  AcpRuntimeListAgentSessionsOptions,
  AcpRuntimeListAgentSessionsFromRegistryOptions,
  AcpRuntimeLoadOptions,
  AcpRuntimeLoadFromRegistryOptions,
  AcpRuntimeOptions,
  AcpRuntimeRegistryListOptions,
  AcpRuntimeResumeOptions,
  AcpRuntimeSessionList,
  AcpRuntimeStoredSessionWatcher,
} from "./types.js";

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
  private readonly sessionService: AcpSessionService;
  private readonly activeSessions = new Map<string, ManagedSessionEntry>();
  private readonly pendingLoads = new Map<string, Promise<ManagedSessionEntry>>();
  private readonly pendingResumes = new Map<string, Promise<ManagedSessionEntry>>();

  constructor(
    connectionFactory: AcpConnectionFactory,
    private readonly options: RuntimeConstructorOptions = {},
  ) {
    this.sessionService =
      options.sessionService ??
      createAcpSessionService(connectionFactory, options.acp ?? {});
  }

  async create(options: AcpRuntimeCreateOptions): Promise<AcpRuntimeSession> {
    try {
      await this.ensureRegistryHydrated();
      const driver = await this.sessionService.create(options);
      return await this.registerManagedSession(driver);
    } catch (error) {
      if (error instanceof AcpError) {
        throw error;
      }
      throw new AcpCreateError("Failed to create runtime session.", error);
    }
  }

  async createFromRegistry(
    options: AcpRuntimeCreateFromRegistryOptions,
  ): Promise<AcpRuntimeSession> {
    const { agentId, ...rest } = options;
    return this.create({
      ...rest,
      agent: await this.resolveAgent(agentId),
    });
  }

  async load(options: AcpRuntimeLoadOptions): Promise<AcpRuntimeSession> {
    try {
      await this.ensureRegistryHydrated();
      const existing = this.activeSessions.get(options.sessionId);
      if (existing) {
        return this.acquireSessionHandle(existing);
      }

      let pending = this.pendingLoads.get(options.sessionId);
      if (!pending) {
        pending = this.sessionService
          .load(options)
          .then((driver) => this.registerManagedSessionEntry(driver))
          .finally(() => {
            this.pendingLoads.delete(options.sessionId);
          });
        this.pendingLoads.set(options.sessionId, pending);
      }

      const entry = await pending;
      return this.acquireSessionHandle(entry);
    } catch (error) {
      if (error instanceof AcpError) {
        throw error;
      }
      throw new AcpLoadError("Failed to load runtime session.", error);
    }
  }

  async loadFromRegistry(
    options: AcpRuntimeLoadFromRegistryOptions,
  ): Promise<AcpRuntimeSession> {
    const { agentId, ...rest } = options;
    return this.load({
      ...rest,
      agent: await this.resolveAgent(agentId),
    });
  }

  async listAgentSessions(
    options: AcpRuntimeListAgentSessionsOptions,
  ): Promise<AcpRuntimeSessionList> {
    try {
      await this.ensureRegistryHydrated();
      return await this.sessionService.listAgentSessions(options);
    } catch (error) {
      if (error instanceof AcpError) {
        throw error;
      }
      throw new AcpListError("Failed to list runtime sessions.", error);
    }
  }

  async listAgentSessionsFromRegistry(
    options: AcpRuntimeListAgentSessionsFromRegistryOptions,
  ): Promise<AcpRuntimeSessionList> {
    const { agentId, ...rest } = options;
    return this.listAgentSessions({
      ...rest,
      agent: await this.resolveAgent(agentId),
    });
  }

  async resume(options: AcpRuntimeResumeOptions): Promise<AcpRuntimeSession> {
    try {
      await this.ensureRegistryHydrated();
      const sessionId = options.snapshot.session.id;
      const existing = this.activeSessions.get(sessionId);
      if (existing) {
        return this.acquireSessionHandle(existing);
      }

      let pending = this.pendingResumes.get(sessionId);
      if (!pending) {
        pending = this.sessionService
          .resume(options)
          .then((driver) => this.registerManagedSessionEntry(driver))
          .finally(() => {
            this.pendingResumes.delete(sessionId);
          });
        this.pendingResumes.set(sessionId, pending);
      }

      const entry = await pending;
      return this.acquireSessionHandle(entry);
    } catch (error) {
      if (error instanceof AcpError) {
        throw error;
      }
      throw new AcpResumeError("Failed to resume runtime session.", error);
    }
  }

  async listStoredSessions(
    options: AcpRuntimeRegistryListOptions = {},
  ): Promise<AcpRuntimeSessionList> {
    await this.ensureRegistryHydrated();
    return this.options.registry?.listSessions(options) ?? {
      nextCursor: undefined,
      sessions: [],
    };
  }

  async deleteStoredSession(sessionId: string): Promise<boolean> {
    await this.ensureRegistryHydrated();
    return (await this.options.registry?.deleteSession(sessionId)) ?? false;
  }

  async deleteStoredSessions(
    options: AcpRuntimeRegistryListOptions = {},
  ): Promise<number> {
    await this.ensureRegistryHydrated();
    return (await this.options.registry?.deleteSessions(options)) ?? 0;
  }

  watchStoredSessions(watcher: AcpRuntimeStoredSessionWatcher): () => void {
    return this.options.registry?.watch(watcher) ?? (() => {});
  }

  refreshStoredSessions(): void {
    this.options.registry?.notifyRefresh();
  }

  private async registerManagedSession(
    driver: AcpSessionDriver,
  ): Promise<AcpRuntimeSession> {
    const entry = await this.registerManagedSessionEntry(driver);
    return this.acquireSessionHandle(entry);
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
    const entry: ManagedSessionEntry = {
      driver,
      refCount: 0,
      sessionId,
    };
    this.activeSessions.set(sessionId, entry);
    await this.options.registry?.rememberSnapshot(driver.snapshot(), {
      title: driver.metadata.title,
    });
    return entry;
  }

  private acquireSessionHandle(entry: ManagedSessionEntry): AcpRuntimeSession {
    entry.refCount += 1;
    return this.createSession(entry);
  }

  private createSession(entry: ManagedSessionEntry): AcpRuntimeSession {
    return new AcpRuntimeSession(entry.driver, {
      onClose: async () => {
        await this.releaseSession(entry.sessionId, entry.driver);
      },
      onSnapshotChanged: async (snapshot) => {
        await this.options.registry?.rememberSnapshot(snapshot);
      },
    });
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
    await driver.close();
  }

  private async ensureRegistryHydrated(): Promise<void> {
    await this.options.registry?.hydrate();
  }

  private async resolveAgent(agentId: string) {
    return (this.options.agentResolver ?? resolveRuntimeAgentFromRegistry)(
      agentId,
    );
  }
}
