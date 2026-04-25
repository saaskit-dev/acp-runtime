import type {
  AcpRuntimeRegistryListOptions,
  AcpRuntimeSessionList,
  AcpRuntimeSessionReference,
  AcpRuntimeSnapshot,
  AcpRuntimeStoredSessionListUpdate,
  AcpRuntimeStoredSessionWatcher,
} from "../core/types.js";

export type AcpRuntimeSessionRegistryState = {
  sessions: readonly AcpRuntimeSessionRegistryEntry[];
  version: 1;
};

export type AcpRuntimeSessionRegistryEntry = {
  createdAt: string;
  snapshot: AcpRuntimeSnapshot;
  title?: string;
  updatedAt: string;
};

export type AcpRuntimeSessionRegistryStore = {
  load(): Promise<AcpRuntimeSessionRegistryState | undefined>;
  save(state: AcpRuntimeSessionRegistryState): Promise<void>;
};

export class AcpRuntimeSessionRegistry {
  private hydrated = false;
  private persistQueue: Promise<void> = Promise.resolve();
  private readonly sessions = new Map<string, AcpRuntimeSessionRegistryEntry>();
  private readonly watchers = new Set<AcpRuntimeStoredSessionWatcher>();
  private lastUpdatedAtMs = 0;

  constructor(
    private readonly options: {
      store?: AcpRuntimeSessionRegistryStore;
    } = {},
  ) {}

  getSnapshot(sessionId: string): AcpRuntimeSnapshot | undefined {
    const entry = this.sessions.get(sessionId);
    return entry ? this.cloneSnapshot(entry.snapshot) : undefined;
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
    for (const entry of state.sessions) {
      this.sessions.set(entry.snapshot.session.id, this.cloneEntry(entry));
      const updatedAtMs = Date.parse(entry.updatedAt);
      if (Number.isFinite(updatedAtMs)) {
        this.lastUpdatedAtMs = Math.max(this.lastUpdatedAtMs, updatedAtMs);
      }
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
      .filter((entry) =>
        options.agentType ? entry.snapshot.agent.type === options.agentType : true,
      )
      .filter((entry) => (options.cwd ? entry.snapshot.cwd === options.cwd : true))
      .sort((left, right) => {
        const time = right.updatedAt.localeCompare(left.updatedAt);
        return time !== 0
          ? time
          : right.snapshot.session.id.localeCompare(left.snapshot.session.id);
      });

    const page = filtered.slice(startIndex, startIndex + limit);
    const nextCursor =
      startIndex + limit < filtered.length
        ? String(startIndex + limit)
        : undefined;
    return {
      nextCursor,
      sessions: page.map((entry) => this.toSessionReference(entry)),
    };
  }

  async rememberSnapshot(
    snapshot: AcpRuntimeSnapshot,
    metadata?: {
      title?: string;
    },
  ): Promise<AcpRuntimeSessionReference> {
    await this.hydrate();
    const existing = this.sessions.get(snapshot.session.id);
    const now = this.nextTimestamp(existing?.updatedAt);
    const entry: AcpRuntimeSessionRegistryEntry = {
      createdAt: existing?.createdAt ?? now,
      snapshot: this.cloneSnapshot(snapshot),
      title: metadata?.title ?? existing?.title,
      updatedAt: now,
    };
    this.sessions.set(snapshot.session.id, entry);
    await this.persist();
    const reference = this.toSessionReference(entry);
    this.emit({
      session: reference,
      type: "session_saved",
    });
    return reference;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    await this.hydrate();
    const deleted = this.sessions.delete(sessionId);
    if (!deleted) {
      return false;
    }
    await this.persist();
    this.emit({
      sessionId,
      type: "session_deleted",
    });
    return true;
  }

  async deleteSessions(options: AcpRuntimeRegistryListOptions = {}): Promise<number> {
    await this.hydrate();
    const matches = this.listSessions(options).sessions.map((session) => session.id);
    if (matches.length === 0) {
      return 0;
    }

    for (const sessionId of matches) {
      this.sessions.delete(sessionId);
    }
    await this.persist();
    for (const sessionId of matches) {
      this.emit({
        sessionId,
        type: "session_deleted",
      });
    }
    return matches.length;
  }

  notifyRefresh(): void {
    this.emit({ type: "refresh" });
  }

  watch(watcher: AcpRuntimeStoredSessionWatcher): () => void {
    this.watchers.add(watcher);
    return () => {
      this.watchers.delete(watcher);
    };
  }

  private nextTimestamp(previous?: string): string {
    const now = Date.now();
    const previousMs = previous ? Date.parse(previous) : Number.NaN;
    const floor = Math.max(
      this.lastUpdatedAtMs,
      Number.isFinite(previousMs) ? previousMs : 0,
    );
    const nextMs = floor >= now ? floor + 1 : now;
    this.lastUpdatedAtMs = nextMs;
    return new Date(nextMs).toISOString();
  }

  async save(): Promise<void> {
    await this.hydrate();
    await this.persist();
  }

  private cloneEntry(
    entry: AcpRuntimeSessionRegistryEntry,
  ): AcpRuntimeSessionRegistryEntry {
    return {
      createdAt: entry.createdAt,
      snapshot: this.cloneSnapshot(entry.snapshot),
      title: entry.title,
      updatedAt: entry.updatedAt,
    };
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
            sessions: [...this.sessions.values()].map((entry) =>
              this.cloneEntry(entry),
            ),
            version: 1,
          }) ?? Promise.resolve(),
      );
    return this.persistQueue;
  }

  private toSessionReference(
    entry: AcpRuntimeSessionRegistryEntry,
  ): AcpRuntimeSessionReference {
    return {
      agentType: entry.snapshot.agent.type,
      cwd: entry.snapshot.cwd,
      id: entry.snapshot.session.id,
      title: entry.title,
      updatedAt: entry.updatedAt,
    };
  }

  private emit(update: AcpRuntimeStoredSessionListUpdate): void {
    for (const watcher of this.watchers) {
      watcher(update);
    }
  }
}
