import type {
  Implementation,
  InitializeResponse,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";

import type {
  AcpRuntimeAgentConfigOption,
  AcpRuntimeAgentMode,
  AcpRuntimeCapabilities,
  AcpRuntimeConfigValue,
  AcpRuntimeSessionMetadata,
} from "../core/types.js";
import { mapRuntimeAuthMethods } from "./auth-methods.js";

export function mapInitializeResponseToCapabilities(input: {
  handlers?: import("../core/types.js").AcpRuntimeAuthorityHandlers;
  response: InitializeResponse;
}): AcpRuntimeCapabilities {
  const agentCapabilities = input.response.agentCapabilities;
  return {
    agent: {
      authentication: Boolean(input.response.authMethods?.length),
      load: Boolean(agentCapabilities?.loadSession),
      mcp: Boolean(agentCapabilities?.mcpCapabilities),
      prompt: true,
      resume: Boolean(agentCapabilities?.sessionCapabilities?.resume),
      sessionList: Boolean(agentCapabilities?.sessionCapabilities?.list),
    },
    agentInfo: mapImplementationInfo(input.response.agentInfo ?? undefined),
    authMethods: mapRuntimeAuthMethods({
      authMethods: input.response.authMethods ?? undefined,
    }),
    client: {
      authentication: Boolean(input.handlers?.authentication),
      filesystem: input.handlers?.filesystem
        ? {
            readTextFile: true,
            writeTextFile: true,
          }
        : undefined,
      mcp: false,
      terminal: Boolean(input.handlers?.terminal),
    },
  };
}

export function createInitialMetadata(input: {
  configOptions?: SessionConfigOption[] | null | undefined;
  modes?:
    | {
        availableModes?: Array<{
          description?: string | null;
          id: string;
          name: string;
        }> | null;
        currentModeId: string;
      }
    | null
    | undefined;
  sessionId: string;
}): AcpRuntimeSessionMetadata {
  return {
    agentConfigOptions: mapSessionConfigOptions(input.configOptions),
    agentModes: mapSessionModes(input.modes),
    config: extractRuntimeConfig(input.configOptions),
    currentModeId: input.modes?.currentModeId ?? undefined,
    id: input.sessionId,
  };
}

function mapImplementationInfo(
  info: Implementation | undefined,
): AcpRuntimeCapabilities["agentInfo"] | undefined {
  if (!info) {
    return undefined;
  }

  return {
    name: info.name,
    title: info.title ?? undefined,
    version: info.version ?? undefined,
  };
}

export function extractRuntimeConfig(
  options: readonly SessionConfigOption[] | null | undefined,
): Readonly<Record<string, AcpRuntimeConfigValue>> | undefined {
  if (!options || options.length === 0) {
    return undefined;
  }

  const entries: Record<string, AcpRuntimeConfigValue> = {};
  for (const option of options) {
    entries[option.id] = option.currentValue;
  }
  return entries;
}

export function mapSessionModes(
  modes:
    | {
        availableModes?: Array<{
          description?: string | null;
          id: string;
          name: string;
        }> | null;
      }
    | null
    | undefined,
): readonly AcpRuntimeAgentMode[] | undefined {
  if (!modes?.availableModes?.length) {
    return undefined;
  }

  return modes.availableModes.map((mode) => ({
    description: mode.description ?? undefined,
    id: mode.id,
    name: mode.name,
  }));
}

export function mapSessionConfigOptions(
  options: readonly SessionConfigOption[] | null | undefined,
): readonly AcpRuntimeAgentConfigOption[] | undefined {
  if (!options?.length) {
    return undefined;
  }

  return options.map((option) => ({
    category: option.category ?? undefined,
    description: option.description ?? undefined,
    id: option.id,
    name: option.name,
    options: mapSessionConfigOptionChoices(option),
    type: option.type,
    value: option.currentValue,
  }));
}

function mapSessionConfigOptionChoices(
  option: SessionConfigOption,
): AcpRuntimeAgentConfigOption["options"] {
  if (option.type !== "select") {
    return undefined;
  }

  return option.options.flatMap((entry) => {
    if ("value" in entry) {
      return [
        {
          description: entry.description ?? undefined,
          name: entry.name,
          value: entry.value,
        },
      ];
    }

    return entry.options.map((choice) => ({
      description: choice.description ?? undefined,
      name: choice.name,
      value: choice.value,
    }));
  });
}
