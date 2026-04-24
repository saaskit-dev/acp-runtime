import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
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
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
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

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
