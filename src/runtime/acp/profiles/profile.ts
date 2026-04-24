import type { ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";

import type {
  AcpRuntimeOperation,
  AcpRuntimeOperationKind,
  AcpRuntimeSessionMetadata,
} from "../../core/types.js";

export type AcpAgentProfile = {
  inferDeniedOperationFamily(input: {
    metadata: AcpRuntimeSessionMetadata;
    operation: AcpRuntimeOperation;
  }):
    | "mode_denied"
    | "permission_request_cancelled"
    | "permission_request_end_turn"
    | undefined;
  inferOperationTarget(input: {
    kind: ToolKind | null | undefined;
    locations: ToolCallLocation[] | null | undefined;
    rawInput: unknown;
  }): AcpRuntimeOperation["target"];
  mapOperationKind(kind: ToolKind | null | undefined): AcpRuntimeOperationKind;
};

type AgentProfileOverrides = Partial<AcpAgentProfile>;

export function createAgentProfile(
  overrides: AgentProfileOverrides,
): AcpAgentProfile {
  return {
    inferDeniedOperationFamily:
      overrides.inferDeniedOperationFamily ?? inferDeniedOperationFamily,
    inferOperationTarget: overrides.inferOperationTarget ?? inferOperationTarget,
    mapOperationKind: overrides.mapOperationKind ?? mapOperationKind,
  };
}

function inferDeniedOperationFamily(_input: {
  metadata: AcpRuntimeSessionMetadata;
  operation: AcpRuntimeOperation;
}):
  | "mode_denied"
  | "permission_request_cancelled"
  | "permission_request_end_turn"
  | undefined {
  return undefined;
}

function inferOperationTarget(input: {
  kind: ToolKind | null | undefined;
  locations: ToolCallLocation[] | null | undefined;
  rawInput: unknown;
}): AcpRuntimeOperation["target"] {
  const firstPath = input.locations?.[0]?.path;
  if (firstPath) {
    return {
      type: "path",
      value: firstPath,
    };
  }

  if (
    input.kind === "execute" &&
    isRecord(input.rawInput) &&
    typeof input.rawInput.command === "string"
  ) {
    const args = Array.isArray(input.rawInput.args)
      ? input.rawInput.args.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    return {
      type: "command",
      value: [input.rawInput.command, ...args].join(" "),
    };
  }

  if (
    input.kind === "fetch" &&
    isRecord(input.rawInput) &&
    typeof input.rawInput.url === "string"
  ) {
    return {
      type: "endpoint",
      value: input.rawInput.url,
    };
  }

  return undefined;
}

function mapOperationKind(
  kind: ToolKind | null | undefined,
): AcpRuntimeOperationKind {
  switch (kind) {
    case "read":
    case "search":
      return "read_file";
    case "edit":
    case "delete":
    case "move":
      return "write_file";
    case "execute":
      return "execute_command";
    case "fetch":
      return "network_request";
    default:
      return "unknown";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
