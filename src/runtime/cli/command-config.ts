import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { cwd } from "node:process";
import { dirname, join } from "node:path";

import {
  type AcpRuntimeAgentInput,
  type AcpRuntimeAuthorityHandlers,
  type AcpRuntime,
} from "../index.js";
import type { RuntimeCliOptions } from "./command-options.js";

export type RuntimeCliSessionConfig = {
  agent: AcpRuntimeAgentInput;
  agentId: string;
  cwd: string;
  cleanup(): Promise<void>;
  handlers?: AcpRuntimeAuthorityHandlers;
  label: string;
};

function isLocalSimulatorAgent(agentId: string): boolean {
  return agentId === "simulator-agent-acp-local";
}

function createFilesystemHandlers(): AcpRuntimeAuthorityHandlers["filesystem"] {
  return {
    async readTextFile(path) {
      const { readFile } = await import("node:fs/promises");
      return readFile(path, "utf8");
    },
    async writeTextFile(entry) {
      await mkdir(dirname(entry.path), { recursive: true });
      await writeFile(entry.path, entry.content, "utf8");
    },
  };
}

async function createRuntimeCliSessionConfig(
  agentId: string,
): Promise<RuntimeCliSessionConfig> {
  if (!isLocalSimulatorAgent(agentId)) {
    return {
      agent: agentId,
      agentId,
      cleanup: async () => {},
      cwd: cwd(),
      label: agentId,
    };
  }

  const root = await mkdtemp(join(tmpdir(), "acp-runtime-cli-"));
  const projectDir = join(root, "project");
  const readmePath = join(projectDir, "README.md");

  await mkdir(projectDir, { recursive: true });
  await writeFile(readmePath, "hello from runtime stdio smoke\n", "utf8");

  return {
    agent: agentId,
    agentId,
    cleanup: async () => {
      await rm(root, { force: true, recursive: true });
    },
    cwd: projectDir,
    handlers: {
      filesystem: createFilesystemHandlers(),
    },
    label: "simulator",
  };
}

async function findLocalSessionReference(
  runtime: AcpRuntime,
  sessionId: string,
): Promise<{ agentType?: string; cwd: string; id: string } | undefined> {
  let cursor: string | undefined;
  do {
    const page = await runtime.sessions.list({
      cursor,
      limit: 100,
      source: "local",
    });
    const match = page.sessions.find((session) => session.id === sessionId);
    if (match) {
      return match;
    }
    cursor = page.nextCursor;
  } while (cursor);
  return undefined;
}

export async function findSimilarLocalSessionReferences(
  runtime: AcpRuntime,
  sessionId: string,
): Promise<readonly { agentType?: string; cwd: string; id: string }[]> {
  const prefix = sessionId.slice(0, 8);
  const matches: { agentType?: string; cwd: string; id: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await runtime.sessions.list({
      cursor,
      limit: 100,
      source: "local",
    });
    for (const session of page.sessions) {
      if (
        session.id.startsWith(prefix) ||
        levenshteinDistance(session.id, sessionId) <= 2
      ) {
        matches.push(session);
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  return matches.slice(0, 5);
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? Number.MAX_SAFE_INTEGER;
}

async function inferAgentIdForStoredSession(
  runtime: AcpRuntime,
  sessionId: string,
): Promise<string | undefined> {
  const reference = await findLocalSessionReference(runtime, sessionId);
  return reference?.agentType;
}

export async function resolveRuntimeCliConfig(
  runtime: AcpRuntime,
  options: RuntimeCliOptions,
): Promise<RuntimeCliSessionConfig | undefined> {
  if (options.agentId) {
    return createRuntimeCliSessionConfig(options.agentId);
  }
  const sessionId = options.loadSessionId ?? options.resumeSessionId;
  if (sessionId) {
    const agentId = await inferAgentIdForStoredSession(runtime, sessionId);
    if (agentId) {
      return createRuntimeCliSessionConfig(agentId);
    }
  }
  if (options.resumeLast) {
    const latest = await runtime.sessions.list({
      limit: 1,
      source: "local",
    });
    const agentId = latest.sessions[0]?.agentType;
    if (agentId) {
      return createRuntimeCliSessionConfig(agentId);
    }
  }
  return undefined;
}
