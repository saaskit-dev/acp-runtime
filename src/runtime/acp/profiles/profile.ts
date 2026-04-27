import type {
  AuthMethod,
  PromptResponse,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";

import type {
  AcpRuntimeOperation,
  AcpRuntimeOperationKind,
  AcpRuntimeConfigValue,
  AcpRuntimeAuthenticationMethod,
  AcpRuntimeSessionMetadata,
  AcpRuntimeSystemPrompt,
} from "../../core/types.js";
import type { AcpRuntimeAgent } from "../../core/types.js";
import type { AcpRuntimeTurnState } from "../turn-state.js";

export type AcpRuntimeInitialConfigKey = "mode" | "model" | "effort";

export type AcpRuntimeInitialConfigOptionSelector = {
  categories: readonly string[];
  ids: readonly string[];
};

export type AcpAgentProfile = {
  applySystemPromptToAgent?(input: {
    agent: AcpRuntimeAgent;
    systemPrompt: AcpRuntimeSystemPrompt;
  }): AcpRuntimeAgent;
  createSystemPromptSessionMeta?(input: {
    systemPrompt: AcpRuntimeSystemPrompt;
  }): Record<string, unknown> | undefined;
  createInitialConfigAliases?(input: {
    key: AcpRuntimeInitialConfigKey;
    value: AcpRuntimeConfigValue;
  }): readonly AcpRuntimeConfigValue[];
  createInitialConfigOptionSelector?(input: {
    key: AcpRuntimeInitialConfigKey;
  }): AcpRuntimeInitialConfigOptionSelector;
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
  // Profile-level compatibility policy for agents that omit or mis-shape
  // initialize auth methods. This is a semantic fallback hook, not a host-side
  // login execution strategy.
  normalizeInitializeAuthMethods?(input: {
    agent: AcpRuntimeAgent;
    authMethods: readonly AuthMethod[] | undefined;
  }): readonly AuthMethod[] | undefined;
  normalizeRuntimeAuthenticationMethods?(input: {
    agent: AcpRuntimeAgent;
    methods: readonly AcpRuntimeAuthenticationMethod[];
  }):
    | Promise<readonly AcpRuntimeAuthenticationMethod[]>
    | readonly AcpRuntimeAuthenticationMethod[];
  normalizePromptError?(input: {
    error: unknown;
    turn: AcpRuntimeTurnState;
  }): PromptResponse | undefined;
};

type AgentProfileOverrides = Partial<AcpAgentProfile>;

export function createAgentProfile(
  overrides: AgentProfileOverrides,
): AcpAgentProfile {
  return {
    applySystemPromptToAgent: overrides.applySystemPromptToAgent,
    createSystemPromptSessionMeta: overrides.createSystemPromptSessionMeta,
    createInitialConfigAliases: overrides.createInitialConfigAliases,
    createInitialConfigOptionSelector:
      overrides.createInitialConfigOptionSelector ??
      createInitialConfigOptionSelector,
    inferDeniedOperationFamily:
      overrides.inferDeniedOperationFamily ?? inferDeniedOperationFamily,
    inferOperationTarget: overrides.inferOperationTarget ?? inferOperationTarget,
    mapOperationKind: overrides.mapOperationKind ?? mapOperationKind,
    normalizeInitializeAuthMethods:
      overrides.normalizeInitializeAuthMethods ?? normalizeInitializeAuthMethods,
    normalizeRuntimeAuthenticationMethods:
      overrides.normalizeRuntimeAuthenticationMethods ??
      normalizeRuntimeAuthenticationMethods,
    normalizePromptError:
      overrides.normalizePromptError ?? normalizePromptError,
  };
}

function createInitialConfigOptionSelector(input: {
  key: AcpRuntimeInitialConfigKey;
}): AcpRuntimeInitialConfigOptionSelector {
  switch (input.key) {
    case "mode":
      return {
        categories: ["mode"],
        ids: ["mode"],
      };
    case "model":
      return {
        categories: ["model"],
        ids: ["model"],
      };
    case "effort":
      return {
        categories: ["effort", "thought_level"],
        ids: ["effort", "reasoning_effort"],
      };
  }
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

function normalizeInitializeAuthMethods(_input: {
  agent: AcpRuntimeAgent;
  authMethods: readonly AuthMethod[] | undefined;
}): readonly AuthMethod[] | undefined {
  return _input.authMethods;
}

function normalizeRuntimeAuthenticationMethods(input: {
  agent: AcpRuntimeAgent;
  methods: readonly AcpRuntimeAuthenticationMethod[];
}): readonly AcpRuntimeAuthenticationMethod[] {
  return input.methods;
}

function normalizePromptError(_input: {
  error: unknown;
  turn: AcpRuntimeTurnState;
}): PromptResponse | undefined {
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
