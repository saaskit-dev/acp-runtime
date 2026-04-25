import {
  AcpPermissionDeniedError,
  AcpProtocolError,
  AcpTurnCancelledError,
  AcpTurnTimeoutError,
  type AcpRuntimeProjectionUpdate,
  type AcpRuntimeSessionMetadata,
  type AcpRuntimeTurnCompletion,
  type AcpRuntimeTurnEvent,
  type AcpRuntimeUsage,
} from "@saaskit-dev/acp-runtime";

import {
  DEFAULT_EXAMPLE_AGENT_ID,
  collectTurnEvents,
  startRegistryExampleSession,
} from "./runtime-sdk-example-helpers.js";

export async function stage2SendExample(input: {
  agentId?: string;
  cwd?: string;
} = {}): Promise<{
  completion: AcpRuntimeTurnCompletion;
  events: readonly AcpRuntimeTurnEvent[];
  liveMetadata?: Readonly<AcpRuntimeSessionMetadata>;
  liveUsage?: AcpRuntimeUsage;
  projectionUpdates: readonly AcpRuntimeProjectionUpdate[];
}> {
  const { session } = await startRegistryExampleSession({
    agentId: input.agentId ?? DEFAULT_EXAMPLE_AGENT_ID,
    cwd: input.cwd,
    registryPath: ".tmp/runtime-sdk-stage-2-send.json",
  });
  const events: AcpRuntimeTurnEvent[] = [];
  const projectionUpdates: AcpRuntimeProjectionUpdate[] = [];
  const stopWatchingProjection = session.live.watch((update) => {
    projectionUpdates.push(update);
  });

  try {
    const completion = await session.turn.send(
      [
        {
          content: "Answer in one short paragraph.",
          role: "system",
        },
        {
          content: [{ text: "What does this repository do?", type: "text" }],
          role: "user",
        },
      ],
      {
        onEvent(event) {
          events.push(event);
        },
      },
      { timeoutMs: 15_000 },
    );

    return {
      completion,
      events,
      liveMetadata: session.live.metadata(),
      liveUsage: session.live.usage(),
      projectionUpdates,
    };
  } catch (error) {
    if (
      error instanceof AcpPermissionDeniedError ||
      error instanceof AcpProtocolError ||
      error instanceof AcpTurnCancelledError ||
      error instanceof AcpTurnTimeoutError
    ) {
      throw error;
    }
    throw error;
  } finally {
    stopWatchingProjection();
    await session.lifecycle.close();
  }
}

export async function stage2StreamExample(input: {
  agentId?: string;
  cwd?: string;
} = {}): Promise<readonly AcpRuntimeTurnEvent[]> {
  const { session } = await startRegistryExampleSession({
    agentId: input.agentId ?? DEFAULT_EXAMPLE_AGENT_ID,
    cwd: input.cwd,
    registryPath: ".tmp/runtime-sdk-stage-2-stream.json",
  });

  try {
    return await collectTurnEvents(
      session,
      [
        {
          text: "Inspect the workspace and answer with one useful next step.",
          type: "text",
        },
        {
          type: "json",
          value: { source: "runtime-sdk-stage-2-interactive" },
        },
      ],
      { timeoutMs: 15_000 },
    );
  } finally {
    await session.lifecycle.close();
  }
}

export async function stage2CancelExample(input: {
  agentId?: string;
  cwd?: string;
} = {}): Promise<readonly AcpRuntimeTurnEvent[]> {
  const { session } = await startRegistryExampleSession({
    agentId: input.agentId ?? DEFAULT_EXAMPLE_AGENT_ID,
    cwd: input.cwd,
    registryPath: ".tmp/runtime-sdk-stage-2-cancel.json",
  });
  const controller = new AbortController();

  try {
    setTimeout(() => {
      controller.abort();
      void session.lifecycle.cancel();
    }, 250);

    return await collectTurnEvents(
      session,
      "Keep working until the host cancels this turn.",
      { signal: controller.signal },
    );
  } catch (error) {
    if (error instanceof AcpTurnCancelledError) {
      return [];
    }
    throw error;
  } finally {
    await session.lifecycle.close();
  }
}
