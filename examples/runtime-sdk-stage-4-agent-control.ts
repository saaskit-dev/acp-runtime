import type {
  AcpRuntimeAgentConfigOption,
  AcpRuntimeAgentMode,
  AcpRuntimeAvailableCommand,
  AcpRuntimeSessionMetadata,
} from "@saaskit-dev/acp-runtime";

import {
  DEFAULT_EXAMPLE_AGENT_ID,
  startRegistryExampleSession,
} from "./runtime-sdk-example-helpers.js";

function pickConfigValue(option: AcpRuntimeAgentConfigOption): string {
  const candidate = option.options?.[0]?.value ?? option.value;
  return String(candidate);
}

export async function stage4AgentControlExample(input: {
  agentId?: string;
  cwd?: string;
} = {}): Promise<{
  availableCommands?: readonly AcpRuntimeAvailableCommand[];
  configOptions: readonly AcpRuntimeAgentConfigOption[];
  metadata: Readonly<AcpRuntimeSessionMetadata>;
  modes: readonly AcpRuntimeAgentMode[];
}> {
  const { session } = await startRegistryExampleSession({
    agentId: input.agentId ?? DEFAULT_EXAMPLE_AGENT_ID,
    cwd: input.cwd,
    registryPath: ".tmp/runtime-sdk-stage-4-agent-control.json",
  });

  try {
    const modes = await session.agent.listModes();
    const configOptions = await session.agent.listConfigOptions();

    if (modes[0]) {
      await session.agent.setMode(modes[0].id);
    }
    if (configOptions[0]) {
      await session.agent.setConfigOption(
        configOptions[0].id,
        pickConfigValue(configOptions[0]),
      );
    }

    return {
      availableCommands: session.metadata.availableCommands,
      configOptions,
      metadata: session.metadata,
      modes,
    };
  } finally {
    await session.lifecycle.close();
  }
}
