import type { AcpRuntimeSessionList } from "@saaskit-dev/acp-runtime";

import {
  DEFAULT_EXAMPLE_AGENT_ID,
  createExampleHandlers,
  createExampleRuntime,
  resolveExampleRegistryPath,
} from "./runtime-sdk-example-helpers.js";

export async function stage6StoredSessionsExample(input: {
  agentId?: string;
  cwd?: string;
} = {}): Promise<{
  allSessions: AcpRuntimeSessionList;
  localSessions: AcpRuntimeSessionList;
  remoteSessions: AcpRuntimeSessionList;
}> {
  const agentId = input.agentId ?? DEFAULT_EXAMPLE_AGENT_ID;
  const cwd = input.cwd ?? process.cwd();
  const runtime = await createExampleRuntime({
    registryPath: resolveExampleRegistryPath("runtime-sdk-stage-6-stored-sessions.json"),
  });
  const handlers = createExampleHandlers();

  const session = await runtime.sessions.start({
    agent: agentId,
    cwd,
    handlers,
  });

  try {
    const localSessions = await runtime.sessions.list({
      agent: agentId,
      cwd,
      source: "local",
    });
    const remoteSessions = await runtime.sessions.list({
      agent: agentId,
      cwd,
      handlers,
      source: "remote",
    });
    const allSessions = await runtime.sessions.list({
      agent: agentId,
      cwd,
      handlers,
      source: "all",
    });

    return {
      allSessions,
      localSessions,
      remoteSessions,
    };
  } finally {
    await session.close();
  }
}
