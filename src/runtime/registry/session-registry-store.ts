import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  AcpRuntimeSessionRegistryEntry,
  AcpRuntimeSessionRegistryState,
  AcpRuntimeSessionRegistryStore,
} from "./session-registry.js";

export class AcpRuntimeJsonSessionRegistryStore implements AcpRuntimeSessionRegistryStore {
  constructor(readonly path: string) {}

  async load(): Promise<AcpRuntimeSessionRegistryState | undefined> {
    try {
      const raw = await readFile(this.path, "utf8");
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

  async save(state: AcpRuntimeSessionRegistryState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempPath, this.path);
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
