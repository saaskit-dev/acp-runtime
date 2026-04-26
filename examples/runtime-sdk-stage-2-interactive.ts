import {
  AcpRuntimeContentPartType,
  AcpPermissionDeniedError,
  AcpProtocolError,
  AcpRuntimeProjectionUpdateType,
  AcpRuntimePromptMessageRole,
  AcpTurnCancelledError,
  AcpTurnTimeoutError,
  type AcpRuntimeProjectionUpdate,
  type AcpRuntimeSessionMetadata,
  type AcpRuntimeStateUpdate,
  type AcpRuntimeTurnCompletion,
  type AcpRuntimeTurnEvent,
  type AcpRuntimeUsage,
} from "@saaskit-dev/acp-runtime";

import {
  DEFAULT_EXAMPLE_AGENT_ID,
  collectTurnEvents,
  resolveExampleRegistryPath,
  startRegistryExampleSession,
} from "./runtime-sdk-example-helpers.js";

export async function stage2SendExample(input: {
  agentId?: string;
  cwd?: string;
} = {}): Promise<{
  completion: AcpRuntimeTurnCompletion;
  events: readonly AcpRuntimeTurnEvent[];
  stateMetadata?: Readonly<AcpRuntimeSessionMetadata>;
  stateUsage?: AcpRuntimeUsage;
  projectionUpdates: readonly AcpRuntimeProjectionUpdate[];
}> {
  const { session } = await startRegistryExampleSession({
    agentId: input.agentId ?? DEFAULT_EXAMPLE_AGENT_ID,
    cwd: input.cwd,
    registryPath: resolveExampleRegistryPath("runtime-sdk-stage-2-send.json"),
  });
  const events: AcpRuntimeTurnEvent[] = [];
  const projectionUpdates: AcpRuntimeProjectionUpdate[] = [];
  const stopWatchingProjection = session.state.watch((update) => {
    if (!isProjectionUpdate(update)) {
      return;
    }
    projectionUpdates.push(update);
  });

  try {
    const completion = await session.turn.send(
      [
        {
          content: "Answer in one short paragraph.",
          role: AcpRuntimePromptMessageRole.System,
        },
        {
          content: [
            {
              text: "What does this repository do?",
              type: AcpRuntimeContentPartType.Text,
            },
          ],
          role: AcpRuntimePromptMessageRole.User,
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
      stateMetadata: session.state.metadata(),
      stateUsage: session.state.usage(),
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
    await session.close();
  }
}

function isProjectionUpdate(
  update: AcpRuntimeStateUpdate,
): update is AcpRuntimeProjectionUpdate {
  return Object.values(AcpRuntimeProjectionUpdateType).includes(
    update.type as AcpRuntimeProjectionUpdate["type"],
  );
}

export async function stage2StreamExample(input: {
  agentId?: string;
  cwd?: string;
} = {}): Promise<readonly AcpRuntimeTurnEvent[]> {
  const { session } = await startRegistryExampleSession({
    agentId: input.agentId ?? DEFAULT_EXAMPLE_AGENT_ID,
    cwd: input.cwd,
    registryPath: resolveExampleRegistryPath("runtime-sdk-stage-2-stream.json"),
  });

  try {
    return await collectTurnEvents(
      session,
      [
        {
          text: "Inspect the workspace and answer with one useful next step.",
          type: AcpRuntimeContentPartType.Text,
        },
        {
          type: AcpRuntimeContentPartType.Json,
          value: { source: "runtime-sdk-stage-2-interactive" },
        },
      ],
      { timeoutMs: 15_000 },
    );
  } finally {
    await session.close();
  }
}

export async function stage2CancelExample(input: {
  agentId?: string;
  cwd?: string;
} = {}): Promise<readonly AcpRuntimeTurnEvent[]> {
  const { session } = await startRegistryExampleSession({
    agentId: input.agentId ?? DEFAULT_EXAMPLE_AGENT_ID,
    cwd: input.cwd,
    registryPath: resolveExampleRegistryPath("runtime-sdk-stage-2-cancel.json"),
  });
  try {
    const turn = session.turn.start(
      "Keep working until the host cancels this turn.",
    );
    setTimeout(() => {
      void session.turn.cancel(turn.turnId);
    }, 250);

    const events: AcpRuntimeTurnEvent[] = [];
    try {
      for await (const event of turn.events) {
        events.push(event);
      }
    } catch (error) {
      if (error instanceof AcpTurnCancelledError) {
        return events;
      }
      throw error;
    }

    return events;
  } catch (error) {
    if (error instanceof AcpTurnCancelledError) {
      return [];
    }
    throw error;
  } finally {
    await session.close();
  }
}
