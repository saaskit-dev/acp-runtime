import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  AcpRuntimeSessionRegistryEntry,
  AcpRuntimeSessionRegistryState,
  AcpRuntimeSessionRegistryStore,
} from "./session-registry.js";

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 25;

export class AcpRuntimeJsonSessionRegistryStore implements AcpRuntimeSessionRegistryStore {
  constructor(readonly path: string) {}

  async load(): Promise<AcpRuntimeSessionRegistryState | undefined> {
    return loadRegistryState(this.path);
  }

  async save(
    state: AcpRuntimeSessionRegistryState,
    options?: { deletedSessionIds?: readonly string[] },
  ): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await withFileLock(`${this.path}.lock`, async () => {
      const latest = await loadRegistryState(this.path);
      const merged = mergeRegistryState(latest, state, options);
      await writeRegistryStateAtomically(this.path, merged);
    });
  }
}

async function loadRegistryState(
  path: string,
): Promise<AcpRuntimeSessionRegistryState | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as
      | Partial<AcpRuntimeSessionRegistryState>
      | undefined;
    if (!parsed || parsed.version !== 1) {
      return undefined;
    }
    return {
      sessions: Array.isArray(parsed.sessions)
        ? parsed.sessions
            .map((entry) => normalizeRegistryEntry(entry))
            .filter(
              (entry): entry is AcpRuntimeSessionRegistryEntry =>
                entry !== undefined,
            )
        : [],
      version: 1,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function writeRegistryStateAtomically(
  path: string,
  state: AcpRuntimeSessionRegistryState,
): Promise<void> {
  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function mergeRegistryState(
  latest: AcpRuntimeSessionRegistryState | undefined,
  next: AcpRuntimeSessionRegistryState,
  options?: { deletedSessionIds?: readonly string[] },
): AcpRuntimeSessionRegistryState {
  const sessions = new Map<string, AcpRuntimeSessionRegistryEntry>();
  for (const entry of latest?.sessions ?? []) {
    sessions.set(entry.snapshot.session.id, entry);
  }
  for (const sessionId of options?.deletedSessionIds ?? []) {
    sessions.delete(sessionId);
  }
  for (const entry of next.sessions) {
    const existing = sessions.get(entry.snapshot.session.id);
    if (!existing || existing.updatedAt <= entry.updatedAt) {
      sessions.set(entry.snapshot.session.id, entry);
    }
  }
  return {
    sessions: [...sessions.values()],
    version: 1,
  };
}

async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
        return await operation();
      } finally {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
      await removeStaleLock(lockPath);
      if (Date.now() - start >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for registry lock: ${lockPath}`);
      }
      await wait(LOCK_RETRY_MS);
    }
  }
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs >= LOCK_STALE_MS) {
      await rm(lockPath, { force: true });
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function normalizeRegistryEntry(
  value: unknown,
): AcpRuntimeSessionRegistryEntry | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  if ("snapshot" in value) {
    const entry = value as Partial<AcpRuntimeSessionRegistryEntry>;
    if (
      !entry.snapshot ||
      typeof entry.snapshot !== "object" ||
      !entry.snapshot.session ||
      typeof entry.snapshot.session !== "object" ||
      typeof entry.snapshot.session.id !== "string"
    ) {
      return undefined;
    }

    const fallback = new Date().toISOString();
    return {
      createdAt:
        typeof entry.createdAt === "string" ? entry.createdAt : fallback,
      snapshot: entry.snapshot,
      title: typeof entry.title === "string" ? entry.title : undefined,
      updatedAt:
        typeof entry.updatedAt === "string" ? entry.updatedAt : fallback,
    };
  }

  const snapshot = value as Partial<AcpRuntimeSessionRegistryEntry["snapshot"]>;
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    !snapshot.session ||
    typeof snapshot.session !== "object" ||
    typeof snapshot.session.id !== "string"
  ) {
    return undefined;
  }

  const fallback = new Date().toISOString();
  return {
    createdAt: fallback,
    snapshot: snapshot as AcpRuntimeSessionRegistryEntry["snapshot"],
    title: undefined,
    updatedAt: fallback,
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
