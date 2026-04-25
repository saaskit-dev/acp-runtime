import type {
  AcpRuntimeDiffSnapshot,
  AcpRuntimeHistoryEntry,
  AcpRuntimeOperation,
  AcpRuntimeOperationBundle,
  AcpRuntimePermissionRequest,
  AcpRuntimeProjectionUpdate,
  AcpRuntimeReadModelUpdate,
  AcpRuntimeSessionMetadata,
  AcpRuntimeTerminalSnapshot,
  AcpRuntimeThreadEntry,
  AcpRuntimeToolCallBundle,
  AcpRuntimeToolCallSnapshot,
  AcpRuntimeUsage,
} from "@saaskit-dev/acp-runtime";

import {
  DEFAULT_EXAMPLE_AGENT_ID,
  createExampleHandlers,
  createExampleRuntime,
} from "./runtime-sdk-example-helpers.js";

export async function stage5ReadModelExample(input: {
  agentId?: string;
  cwd?: string;
} = {}): Promise<{
  diffs: readonly AcpRuntimeDiffSnapshot[];
  firstDiff?: AcpRuntimeDiffSnapshot;
  firstOperation?: AcpRuntimeOperation;
  firstOperationBundle?: AcpRuntimeOperationBundle;
  firstPermission?: AcpRuntimePermissionRequest;
  firstTerminal?: AcpRuntimeTerminalSnapshot;
  firstToolCall?: AcpRuntimeToolCallBundle;
  history: readonly AcpRuntimeHistoryEntry[];
  operations: readonly AcpRuntimeOperation[];
  permissions: readonly AcpRuntimePermissionRequest[];
  projectionMetadata?: Readonly<AcpRuntimeSessionMetadata>;
  projectionUsage?: AcpRuntimeUsage;
  projectionUpdates: readonly AcpRuntimeProjectionUpdate[];
  readModelUpdates: readonly AcpRuntimeReadModelUpdate[];
  terminals: readonly AcpRuntimeTerminalSnapshot[];
  thread: readonly AcpRuntimeThreadEntry[];
  toolCallSnapshots: readonly AcpRuntimeToolCallSnapshot[];
  toolCalls: readonly AcpRuntimeToolCallBundle[];
}> {
  const runtime = await createExampleRuntime({
    registryPath: ".tmp/runtime-sdk-stage-5-read-model.json",
  });
  const handlers = createExampleHandlers({
    files: {
      "/tmp/project/README.md": "hello from stage 5\n",
    },
  });
  const session = await runtime.sessions.registry.start({
    agentId: input.agentId ?? DEFAULT_EXAMPLE_AGENT_ID,
    cwd: input.cwd ?? process.cwd(),
    handlers,
  });

  const readModelUpdates: AcpRuntimeReadModelUpdate[] = [];
  const projectionUpdates: AcpRuntimeProjectionUpdate[] = [];
  const stopWatchingModel = session.model.watch((update) => {
    readModelUpdates.push(update);
  });
  const stopWatchingProjection = session.live.watch((update) => {
    projectionUpdates.push(update);
  });

  try {
    await session.turn.run("/scenario full-cycle /tmp/project/README.md git diff --stat");

    const thread = session.model.thread.entries();
    const history = session.model.history.drain();
    const diffs = session.model.diffs.list();
    const diffKeys = session.model.diffs.keys();
    const firstDiff = diffKeys[0]
      ? session.model.diffs.get(diffKeys[0])
      : undefined;

    const terminals = session.model.terminals.list();
    const terminalIds = session.model.terminals.ids();
    const firstTerminal = terminalIds[0]
      ? session.model.terminals.get(terminalIds[0])
      : undefined;

    const toolCalls = session.model.toolCalls.bundles();
    const toolCallSnapshots = session.model.toolCalls.list();
    const toolCallIds = session.model.toolCalls.ids();
    const firstToolCall = toolCallIds[0]
      ? session.model.toolCalls.bundle(toolCallIds[0])
      : undefined;

    const operationIds = session.model.operations.ids();
    const operations = session.model.operations.list();
    const firstOperation = operationIds[0]
      ? session.model.operations.get(operationIds[0])
      : undefined;
    const firstOperationBundle = operationIds[0]
      ? session.model.operations.bundle(operationIds[0])
      : undefined;

    const permissionIds = session.model.permissions.ids();
    const permissions = session.model.permissions.list();
    const firstPermission = permissionIds[0]
      ? session.model.permissions.get(permissionIds[0])
      : undefined;

    const cleanup: Array<() => void> = [];
    if (diffKeys[0]) {
      cleanup.push(session.model.diffs.watch(diffKeys[0], () => {}));
    }
    if (terminalIds[0]) {
      cleanup.push(session.model.terminals.watch(terminalIds[0], () => {}));
      await session.model.terminals.refresh(terminalIds[0]);
      await session.model.terminals.wait(terminalIds[0]);
      await session.model.terminals.kill(terminalIds[0]);
      await session.model.terminals.release(terminalIds[0]);
    }
    if (toolCallIds[0]) {
      cleanup.push(session.model.toolCalls.watch(toolCallIds[0], () => {}));
      cleanup.push(
        session.model.toolCalls.watchObjects(toolCallIds[0], () => {}),
      );
      session.model.toolCalls.get(toolCallIds[0]);
      session.model.toolCalls.diffs(toolCallIds[0]);
      session.model.toolCalls.terminals(toolCallIds[0]);
    }
    if (operationIds[0]) {
      cleanup.push(session.model.operations.watch(operationIds[0], () => {}));
      cleanup.push(
        session.model.operations.watchBundle(operationIds[0], () => {}),
      );
      session.model.operations.permissions(operationIds[0]);
    }
    if (permissionIds[0]) {
      cleanup.push(session.model.permissions.watch(permissionIds[0], () => {}));
    }

    for (const stop of cleanup) {
      stop();
    }

    return {
      diffs,
      firstDiff,
      firstOperation,
      firstOperationBundle,
      firstPermission,
      firstTerminal,
      firstToolCall,
      history,
      operations,
      permissions,
      projectionMetadata: session.live.metadata(),
      projectionUsage: session.live.usage(),
      projectionUpdates,
      readModelUpdates,
      terminals,
      thread,
      toolCallSnapshots,
      toolCalls,
    };
  } finally {
    stopWatchingModel();
    stopWatchingProjection();
    await session.lifecycle.close();
  }
}
