import type {
  AcpRuntimeSessionList,
  AcpRuntimeStoredSessionListUpdate,
} from "@saaskit-dev/acp-runtime";

import {
  DEFAULT_EXAMPLE_AGENT_ID,
  createExampleHandlers,
  createExampleRuntime,
} from "./runtime-sdk-example-helpers.js";

export async function stage6StoredSessionsExample(input: {
  agentId?: string;
  cwd?: string;
} = {}): Promise<{
  afterDelete: AcpRuntimeSessionList;
  beforeDelete: AcpRuntimeSessionList;
  deletedCount: number;
  updates: readonly AcpRuntimeStoredSessionListUpdate[];
}> {
  const runtime = await createExampleRuntime({
    registryPath: ".tmp/runtime-sdk-stage-6-stored-sessions.json",
  });
  const handlers = createExampleHandlers();
  const updates: AcpRuntimeStoredSessionListUpdate[] = [];
  const stopWatching = runtime.sessions.stored.watch((update) => {
    updates.push(update);
  });

  try {
    const session = await runtime.sessions.registry.start({
      agentId: input.agentId ?? DEFAULT_EXAMPLE_AGENT_ID,
      cwd: input.cwd ?? process.cwd(),
      handlers,
    });

    try {
      const beforeDelete = await runtime.sessions.stored.list({
        agentType: input.agentId ?? DEFAULT_EXAMPLE_AGENT_ID,
        cwd: input.cwd ?? process.cwd(),
      });
      runtime.sessions.stored.refresh();
      await runtime.sessions.stored.delete(session.metadata.id);
      const deletedCount = await runtime.sessions.stored.deleteMany({
        cwd: input.cwd ?? process.cwd(),
        limit: 10,
      });
      const afterDelete = await runtime.sessions.stored.list({
        cwd: input.cwd ?? process.cwd(),
      });

      return {
        afterDelete,
        beforeDelete,
        deletedCount,
        updates,
      };
    } finally {
      await session.lifecycle.close();
    }
  } finally {
    stopWatching();
  }
}
