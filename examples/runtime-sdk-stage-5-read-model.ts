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
import { AcpRuntimeProjectionUpdateType } from "@saaskit-dev/acp-runtime";

import {
  DEFAULT_EXAMPLE_AGENT_ID,
  createExampleHandlers,
  createExampleRuntime,
  resolveExampleRegistryPath,
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
    registryPath: resolveExampleRegistryPath("runtime-sdk-stage-5-read-model.json"),
  });
  const handlers = createExampleHandlers({
    files: {
      "/tmp/project/README.md": "hello from stage 5\n",
    },
  });
  const session = await runtime.sessions.start({
    agent: input.agentId ?? DEFAULT_EXAMPLE_AGENT_ID,
    cwd: input.cwd ?? process.cwd(),
    handlers,
  });

  const readModelUpdates: AcpRuntimeReadModelUpdate[] = [];
  const projectionUpdates: AcpRuntimeProjectionUpdate[] = [];
  const stopWatchingState = session.state.watch((update) => {
    if (isProjectionUpdate(update)) {
      projectionUpdates.push(update);
      return;
    }
    readModelUpdates.push(update);
  });

  try {
    await session.turn.run("/scenario full-cycle /tmp/project/README.md git diff --stat");

    const thread = session.state.thread.entries();
    const history = session.state.history.drain();
    const diffs = session.state.diffs.list();
    const diffKeys = session.state.diffs.keys();
    const firstDiff = diffKeys[0]
      ? session.state.diffs.get(diffKeys[0])
      : undefined;

    const terminals = session.state.terminals.list();
    const terminalIds = session.state.terminals.ids();
    const firstTerminal = terminalIds[0]
      ? session.state.terminals.get(terminalIds[0])
      : undefined;

    const toolCalls = session.state.toolCalls.bundles();
    const toolCallSnapshots = session.state.toolCalls.list();
    const toolCallIds = session.state.toolCalls.ids();
    const firstToolCall = toolCallIds[0]
      ? session.state.toolCalls.bundle(toolCallIds[0])
      : undefined;

    const operationIds = session.state.operations.ids();
    const operations = session.state.operations.list();
    const firstOperation = operationIds[0]
      ? session.state.operations.get(operationIds[0])
      : undefined;
    const firstOperationBundle = operationIds[0]
      ? session.state.operations.bundle(operationIds[0])
      : undefined;

    const permissionIds = session.state.permissions.ids();
    const permissions = session.state.permissions.list();
    const firstPermission = permissionIds[0]
      ? session.state.permissions.get(permissionIds[0])
      : undefined;

    const cleanup: Array<() => void> = [];
    if (diffKeys[0]) {
      cleanup.push(session.state.diffs.watch(diffKeys[0], () => {}));
    }
    if (terminalIds[0]) {
      cleanup.push(session.state.terminals.watch(terminalIds[0], () => {}));
      await session.state.terminals.refresh(terminalIds[0]);
      await session.state.terminals.wait(terminalIds[0]);
      await session.state.terminals.kill(terminalIds[0]);
      await session.state.terminals.release(terminalIds[0]);
    }
    if (toolCallIds[0]) {
      cleanup.push(session.state.toolCalls.watch(toolCallIds[0], () => {}));
      cleanup.push(
        session.state.toolCalls.watchObjects(toolCallIds[0], () => {}),
      );
      session.state.toolCalls.get(toolCallIds[0]);
      session.state.toolCalls.diffs(toolCallIds[0]);
      session.state.toolCalls.terminals(toolCallIds[0]);
    }
    if (operationIds[0]) {
      cleanup.push(session.state.operations.watch(operationIds[0], () => {}));
      cleanup.push(
        session.state.operations.watchBundle(operationIds[0], () => {}),
      );
      session.state.operations.permissions(operationIds[0]);
    }
    if (permissionIds[0]) {
      cleanup.push(session.state.permissions.watch(permissionIds[0], () => {}));
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
      projectionMetadata: session.state.metadata(),
      projectionUsage: session.state.usage(),
      projectionUpdates,
      readModelUpdates,
      terminals,
      thread,
      toolCallSnapshots,
      toolCalls,
    };
  } finally {
    stopWatchingState();
    await session.close();
  }
}

function isProjectionUpdate(
  update: AcpRuntimeProjectionUpdate | AcpRuntimeReadModelUpdate,
): update is AcpRuntimeProjectionUpdate {
  return Object.values(AcpRuntimeProjectionUpdateType).includes(
    update.type as AcpRuntimeProjectionUpdate["type"],
  );
}
