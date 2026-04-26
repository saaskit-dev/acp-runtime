import {
  AcpAuthenticationError,
  AcpCreateError,
  AcpError,
  AcpListError,
  AcpLoadError,
  AcpProcessError,
  AcpResumeError,
  resolveRuntimeAgentFromRegistry,
} from "@saaskit-dev/acp-runtime";

import {
  DEFAULT_EXAMPLE_AGENT_ID,
  createExampleHandlers,
  createExampleRuntime,
  resolveExampleRegistryPath,
} from "./runtime-sdk-example-helpers.js";

export async function stage3RecoveryExample(input: {
  agentId?: string;
  cwd?: string;
} = {}) {
  const agentId = input.agentId ?? DEFAULT_EXAMPLE_AGENT_ID;
  const cwd = input.cwd ?? process.cwd();
  const runtime = await createExampleRuntime({
    registryPath: resolveExampleRegistryPath("runtime-sdk-stage-3-recovery.json"),
  });
  const handlers = createExampleHandlers();

  try {
    const agent = await resolveRuntimeAgentFromRegistry(agentId);
    const directSession = await runtime.sessions.start({
      agent,
      cwd,
      handlers,
    });
    const registrySession = await runtime.sessions.start({
      agent: agentId,
      cwd,
      handlers,
    });

    try {
      const snapshot = directSession.snapshot();
      const directRemoteSessions = await runtime.sessions.list({
        agent,
        cwd,
        handlers,
        source: "remote",
      });
      const registryRemoteSessions =
        await runtime.sessions.list({
          agent: agentId,
          cwd,
          handlers,
          source: "remote",
        });

      const sessionId =
        directRemoteSessions.sessions[0]?.id ??
        registryRemoteSessions.sessions[0]?.id ??
        directSession.metadata.id;

      const resumed = await runtime.sessions.resume({
        agent,
        cwd,
        handlers,
        sessionId: snapshot.session.id,
      });
      const loaded = await runtime.sessions.load({
        agent,
        cwd,
        handlers,
        sessionId,
      });
      const registryLoaded = await runtime.sessions.load({
        agent: agentId,
        cwd,
        handlers,
        sessionId,
      });

      try {
        return {
          directRemoteSessions,
          historyReplay: registryLoaded.state.history.drain(),
          loadedStatus: loaded.status,
          resumedStatus: resumed.status,
          registryRemoteSessions,
          sessionId,
          snapshot,
        };
      } finally {
        await Promise.all([
          resumed.close(),
          loaded.close(),
          registryLoaded.close(),
        ]);
      }
    } finally {
      await Promise.all([
        directSession.close(),
        registrySession.close(),
      ]);
    }
  } catch (error) {
    if (
      error instanceof AcpAuthenticationError ||
      error instanceof AcpCreateError ||
      error instanceof AcpListError ||
      error instanceof AcpLoadError ||
      error instanceof AcpProcessError ||
      error instanceof AcpResumeError ||
      error instanceof AcpError
    ) {
      throw error;
    }
    throw error;
  }
}
