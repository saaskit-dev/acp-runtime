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
} from "./runtime-sdk-example-helpers.js";

export async function stage3RecoveryExample(input: {
  agentId?: string;
  cwd?: string;
} = {}) {
  const agentId = input.agentId ?? DEFAULT_EXAMPLE_AGENT_ID;
  const cwd = input.cwd ?? process.cwd();
  const runtime = await createExampleRuntime({
    registryPath: ".tmp/runtime-sdk-stage-3-recovery.json",
  });
  const handlers = createExampleHandlers();

  try {
    const agent = await resolveRuntimeAgentFromRegistry(agentId);
    const directSession = await runtime.sessions.start({
      agent,
      cwd,
      handlers,
    });
    const registrySession = await runtime.sessions.registry.start({
      agentId,
      cwd,
      handlers,
    });

    try {
      const snapshot = directSession.lifecycle.snapshot();
      const directRemoteSessions = await runtime.sessions.remote.list({
        agent,
        cwd,
        handlers,
      });
      const registryRemoteSessions =
        await runtime.sessions.registry.remote.list({
          agentId,
          cwd,
          handlers,
        });

      const sessionId =
        directRemoteSessions.sessions[0]?.id ??
        registryRemoteSessions.sessions[0]?.id ??
        directSession.metadata.id;

      const resumed = await runtime.sessions.resume({
        handlers,
        snapshot,
      });
      const loaded = await runtime.sessions.load({
        agent,
        cwd,
        handlers,
        sessionId,
      });
      const registryLoaded = await runtime.sessions.registry.load({
        agentId,
        cwd,
        handlers,
        sessionId,
      });

      try {
        return {
          directRemoteSessions,
          historyReplay: registryLoaded.model.history.drain(),
          loadedStatus: loaded.status,
          resumedStatus: resumed.status,
          registryRemoteSessions,
          sessionId,
          snapshot,
        };
      } finally {
        await Promise.all([
          resumed.lifecycle.close(),
          loaded.lifecycle.close(),
          registryLoaded.lifecycle.close(),
        ]);
      }
    } finally {
      await Promise.all([
        directSession.lifecycle.close(),
        registrySession.lifecycle.close(),
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
