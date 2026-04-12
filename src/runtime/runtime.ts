import {
  AcpError,
  AcpCreateError,
  AcpListError,
  AcpLoadError,
  AcpResumeError,
} from "./errors.js";
import { AcpRuntimeSession } from "./session.js";
import type { AcpSessionDriver, AcpSessionService } from "./session-driver.js";
import {
  createAcpSessionService,
  type AcpSessionServiceOptions,
} from "./acp/session-service.js";
import type { AcpConnectionFactory } from "./acp/connection-types.js";
import type {
  AcpRuntimeCreateOptions,
  AcpRuntimeListAgentSessionsOptions,
  AcpRuntimeLoadOptions,
  AcpRuntimeOptions,
  AcpRuntimeResumeOptions,
  AcpRuntimeSessionList,
} from "./types.js";

type RuntimeConstructorOptions = AcpRuntimeOptions & {
  acp?: AcpSessionServiceOptions;
  sessionService?: AcpSessionService;
};

export class AcpRuntime {
  private readonly sessionService: AcpSessionService;

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
      const session = this.createSession(driver);
      await this.options.registry?.rememberSnapshot(session.snapshot(), {
        title: session.metadata.title,
      });
      return session;
    } catch (error) {
      if (error instanceof AcpError) {
        throw error;
      }
      throw new AcpCreateError("Failed to create runtime session.", error);
    }
  }

  async load(options: AcpRuntimeLoadOptions): Promise<AcpRuntimeSession> {
    try {
      await this.ensureRegistryHydrated();
      const driver = await this.sessionService.load(options);
      const session = this.createSession(driver);
      await this.options.registry?.rememberSnapshot(session.snapshot(), {
        title: session.metadata.title,
      });
      return session;
    } catch (error) {
      if (error instanceof AcpError) {
        throw error;
      }
      throw new AcpLoadError("Failed to load runtime session.", error);
    }
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

  async resume(options: AcpRuntimeResumeOptions): Promise<AcpRuntimeSession> {
    try {
      await this.ensureRegistryHydrated();
      const driver = await this.sessionService.resume(options);
      const session = this.createSession(driver);
      await this.options.registry?.rememberSnapshot(session.snapshot(), {
        title: session.metadata.title,
      });
      return session;
    } catch (error) {
      if (error instanceof AcpError) {
        throw error;
      }
      throw new AcpResumeError("Failed to resume runtime session.", error);
    }
  }

  private createSession(driver: AcpSessionDriver): AcpRuntimeSession {
    return new AcpRuntimeSession(driver, {
      onSnapshotChanged: async (snapshot) => {
        await this.options.registry?.rememberSnapshot(snapshot);
      },
    });
  }

  private async ensureRegistryHydrated(): Promise<void> {
    await this.options.registry?.hydrate();
  }
}
