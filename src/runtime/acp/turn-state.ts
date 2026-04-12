import { randomUUID } from "node:crypto";

import type {
  AcpRuntimeOperation,
  AcpRuntimeOutputPart,
  AcpRuntimePermissionRequest,
} from "../types.js";

export type AcpRuntimeTurnState = {
  deniedOperationIds: Set<string>;
  nextOperationId: number;
  nextPermissionId: number;
  operations: Map<string, AcpRuntimeOperation>;
  output: AcpRuntimeOutputPart[];
  outputTextChunks: string[];
  permissionRequests: Map<string, AcpRuntimePermissionRequest>;
  timedOut: boolean;
  turnId: string;
  vendorToolCallToOperationId: Map<string, string>;
};

export function createTurnState(): AcpRuntimeTurnState {
  return {
    deniedOperationIds: new Set<string>(),
    nextOperationId: 1,
    nextPermissionId: 1,
    operations: new Map<string, AcpRuntimeOperation>(),
    output: [],
    outputTextChunks: [],
    permissionRequests: new Map<string, AcpRuntimePermissionRequest>(),
    timedOut: false,
    turnId: randomUUID(),
    vendorToolCallToOperationId: new Map<string, string>(),
  };
}

export function nextOperationId(state: AcpRuntimeTurnState): string {
  const value = `op-${state.nextOperationId}`;
  state.nextOperationId += 1;
  return value;
}

export function nextPermissionRequestId(state: AcpRuntimeTurnState): string {
  const value = `perm-${state.nextPermissionId}`;
  state.nextPermissionId += 1;
  return value;
}
