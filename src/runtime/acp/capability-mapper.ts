import type {
  AuthMethod,
  Implementation,
  InitializeResponse,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";

import type {
  AcpRuntimeAgentConfigOption,
  AcpRuntimeAgentMode,
  AcpRuntimeAuthenticationMethod,
  AcpRuntimeCapabilities,
  AcpRuntimeConfigValue,
  AcpRuntimeSessionMetadata,
} from "../types.js";

export function mapInitializeResponseToCapabilities(input: {
  handlers?: import("../types.js").AcpRuntimeAuthorityHandlers;
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
    authMethods: mapAuthMethods(input.response.authMethods),
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

function mapAuthMethods(
  methods: AuthMethod[] | undefined,
): readonly AcpRuntimeAuthenticationMethod[] | undefined {
  return methods?.map((method) => ({
    description: method.description ?? undefined,
    id: method.id,
    title: method.name,
  }));
}

export function extractRuntimeConfig(
  options: SessionConfigOption[] | null | undefined,
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
  options: SessionConfigOption[] | null | undefined,
): readonly AcpRuntimeAgentConfigOption[] | undefined {
  if (!options?.length) {
    return undefined;
  }

  return options.map((option) => ({
    category: option.category ?? undefined,
    description: option.description ?? undefined,
    id: option.id,
    name: option.name,
    options:
      option.type === "select"
        ? option.options
            .filter(
              (
                entry,
              ): entry is {
                description?: string | null;
                name: string;
                value: string;
              } => "value" in entry,
            )
            .map((entry) => ({
              description: entry.description ?? undefined,
              name: entry.name,
              value: entry.value,
            }))
        : undefined,
    type: option.type,
    value: option.currentValue,
  }));
}
