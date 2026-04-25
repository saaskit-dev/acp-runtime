import {
  createSimulatorAgentAcpAgent,
  type AcpRuntimeCapabilities,
  type AcpRuntimeDiagnostics,
  type AcpRuntimeSessionMetadata,
  type AcpRuntimeSessionStatus,
  type AcpRuntimeSnapshot,
} from "@saaskit-dev/acp-runtime";

import {
  DEFAULT_EXAMPLE_AGENT_ID,
  createExampleHandlers,
  createExampleRuntime,
  startRegistryExampleSession,
} from "./runtime-sdk-example-helpers.js";

export async function stage1RegistryMinimalExample(input: {
  agentId?: string;
  cwd?: string;
} = {}): Promise<{
  capabilities: Readonly<AcpRuntimeCapabilities>;
  diagnostics: Readonly<AcpRuntimeDiagnostics>;
  metadata: Readonly<AcpRuntimeSessionMetadata>;
  outputText: string;
  snapshot: AcpRuntimeSnapshot;
  status: AcpRuntimeSessionStatus;
}> {
  const { session } = await startRegistryExampleSession({
    agentId: input.agentId ?? DEFAULT_EXAMPLE_AGENT_ID,
    cwd: input.cwd,
    registryPath: ".tmp/runtime-sdk-stage-1-registry.json",
  });

  try {
    const outputText = await session.turn.run(
      "Summarize the current workspace in one short sentence.",
    );

    return {
      capabilities: session.capabilities,
      diagnostics: session.diagnostics,
      metadata: session.metadata,
      outputText,
      snapshot: session.lifecycle.snapshot(),
      status: session.status,
    };
  } finally {
    await session.lifecycle.close();
  }
}

export async function stage1ExplicitAgentExample(input: {
  cwd?: string;
} = {}): Promise<{
  outputText: string;
  snapshot: AcpRuntimeSnapshot;
}> {
  const runtime = await createExampleRuntime({
    registryPath: ".tmp/runtime-sdk-stage-1-explicit.json",
  });
  const session = await runtime.sessions.start({
    agent: createSimulatorAgentAcpAgent({ via: "npx" }),
    cwd: input.cwd ?? process.cwd(),
    handlers: createExampleHandlers(),
  });

  try {
    return {
      outputText: await session.turn.run("Say hello from the explicit agent path."),
      snapshot: session.lifecycle.snapshot(),
    };
  } finally {
    await session.lifecycle.close();
  }
}
