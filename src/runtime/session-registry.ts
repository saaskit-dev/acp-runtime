import type {
  AcpRuntimeRegistryListOptions,
  AcpRuntimeSessionList,
  AcpRuntimeSessionReference,
  AcpRuntimeSnapshot,
} from "./types.js";

export type AcpRuntimeSessionRegistryState = {
  sessions: readonly AcpRuntimeSnapshot[];
  version: 1;
};

export type AcpRuntimeSessionRegistryStore = {
  load(): Promise<AcpRuntimeSessionRegistryState | undefined>;
  save(state: AcpRuntimeSessionRegistryState): Promise<void>;
};

export class AcpRuntimeSessionRegistry {
  private hydrated = false;
  private persistQueue: Promise<void> = Promise.resolve();
  private readonly sessions = new Map<string, AcpRuntimeSnapshot>();

  constructor(
    private readonly options: {
      store?: AcpRuntimeSessionRegistryStore;
    } = {},
  ) {}

  getSnapshot(sessionId: string): AcpRuntimeSnapshot | undefined {
    const snapshot = this.sessions.get(sessionId);
    return snapshot ? this.cloneSnapshot(snapshot) : undefined;
  }

  async hydrate(): Promise<void> {
    if (this.hydrated) {
      return;
    }
    this.hydrated = true;

    const state = await this.options.store?.load();
    if (!state) {
      return;
    }

    this.sessions.clear();
    for (const snapshot of state.sessions) {
      this.sessions.set(snapshot.session.id, this.cloneSnapshot(snapshot));
    }
  }

  listSessions(
    options: AcpRuntimeRegistryListOptions = {},
  ): AcpRuntimeSessionList {
    const limit = Math.max(1, options.limit ?? 50);
    const startIndex = options.cursor
      ? Number.parseInt(options.cursor, 10) || 0
      : 0;
    const filtered = [...this.sessions.values()]
      .filter((snapshot) =>
        options.agentType ? snapshot.agent.type === options.agentType : true,
      )
      .filter((snapshot) => (options.cwd ? snapshot.cwd === options.cwd : true))
      .sort((left, right) => right.session.id.localeCompare(left.session.id));

    const page = filtered.slice(startIndex, startIndex + limit);
    const nextCursor =
      startIndex + limit < filtered.length
        ? String(startIndex + limit)
        : undefined;
    return {
      nextCursor,
      sessions: page.map((snapshot) => this.toSessionReference(snapshot)),
    };
  }

  async rememberSnapshot(
    snapshot: AcpRuntimeSnapshot,
    metadata?: {
      title?: string;
    },
  ): Promise<AcpRuntimeSessionReference> {
    await this.hydrate();
    this.sessions.set(snapshot.session.id, this.cloneSnapshot(snapshot));
    await this.persist();
    return this.toSessionReference(snapshot, metadata);
  }

  async save(): Promise<void> {
    await this.hydrate();
    await this.persist();
  }

  private cloneSnapshot(snapshot: AcpRuntimeSnapshot): AcpRuntimeSnapshot {
    return {
      ...snapshot,
      agent: {
        ...snapshot.agent,
        args: snapshot.agent.args ? [...snapshot.agent.args] : undefined,
        env: snapshot.agent.env ? { ...snapshot.agent.env } : undefined,
      },
      config: snapshot.config ? { ...snapshot.config } : undefined,
      currentModeId: snapshot.currentModeId,
      mcpServers: snapshot.mcpServers ? [...snapshot.mcpServers] : undefined,
      session: {
        id: snapshot.session.id,
      },
    };
  }

  private persist(): Promise<void> {
    if (!this.options.store) {
      return Promise.resolve();
    }

    this.persistQueue = this.persistQueue
      .catch(() => {})
      .then(
        () =>
          this.options.store?.save({
            sessions: [...this.sessions.values()].map((snapshot) =>
              this.cloneSnapshot(snapshot),
            ),
            version: 1,
          }) ?? Promise.resolve(),
      );
    return this.persistQueue;
  }

  private toSessionReference(
    snapshot: AcpRuntimeSnapshot,
    metadata?: {
      title?: string;
    },
  ): AcpRuntimeSessionReference {
    return {
      agentType: snapshot.agent.type,
      cwd: snapshot.cwd,
      id: snapshot.session.id,
      title: metadata?.title,
    };
  }
}
