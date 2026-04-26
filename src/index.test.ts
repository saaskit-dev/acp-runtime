import { describe, expect, it } from "vitest";

import {
  ACP_RUNTIME_SNAPSHOT_VERSION,
  ACP_RUNTIME_CACHE_DIR_ENV_VAR,
  ACP_RUNTIME_HOME_DIR_ENV_VAR,
  ACP_PROTOCOL_ALIGNMENT_VERIFIED_AT,
  ACP_PROTOCOL_DOCS_SCHEMA_URL,
  ACP_PROTOCOL_DOCS_URL,
  ACP_PROTOCOL_SOURCE_REF,
  ACP_PROTOCOL_SOURCE_REPO,
  ACP_PROTOCOL_VERSION,
  CLAUDE_CODE_ACP_COMMAND,
  CLAUDE_CODE_ACP_PACKAGE,
  LOCAL_SIMULATOR_AGENT_ACP_REGISTRY_ID,
  SIMULATOR_AGENT_ACP_COMMAND,
  AcpPermissionDeniedError,
  AcpRuntime,
  AcpRuntimeTurnEventType,
  createClaudeCodeAcpAgent,
  createCodexAcpAgent,
  createGeminiCliAcpAgent,
  createSimulatorAgentAcpAgent,
  resolveRuntimeCachePath,
  resolveRuntimeHomePath,
} from "./index.js";
import * as publicSdk from "./index.js";

describe("public protocol alignment exports", () => {
  it("exports ACP protocol alignment metadata", () => {
    expect(ACP_PROTOCOL_VERSION).toBe(1);
    expect(ACP_PROTOCOL_SOURCE_REPO).toBe("https://github.com/agentclientprotocol/agent-client-protocol");
    expect(ACP_PROTOCOL_SOURCE_REF).toBe("v0.11.4");
    expect(ACP_PROTOCOL_DOCS_URL).toBe("https://agentclientprotocol.com/protocol/overview");
    expect(ACP_PROTOCOL_DOCS_SCHEMA_URL).toBe("https://agentclientprotocol.com/protocol/draft/schema");
    expect(ACP_PROTOCOL_ALIGNMENT_VERIFIED_AT).toBe("2026-04-08");
  });

  it("exports the new runtime SDK surface", () => {
    expect(AcpRuntime).toBeTypeOf("function");
    expect(AcpRuntimeTurnEventType.UsageUpdated).toBe("usage_updated");
    expect(AcpPermissionDeniedError).toBeTypeOf("function");
    expect(ACP_RUNTIME_SNAPSHOT_VERSION).toBe(1);
    expect(ACP_RUNTIME_HOME_DIR_ENV_VAR).toBe("ACP_RUNTIME_HOME_DIR");
    expect(ACP_RUNTIME_CACHE_DIR_ENV_VAR).toBe("ACP_RUNTIME_CACHE_DIR");
    expect(CLAUDE_CODE_ACP_COMMAND).toBe("claude-agent-acp");
    expect(CLAUDE_CODE_ACP_PACKAGE).toBe("@agentclientprotocol/claude-agent-acp");
    expect(SIMULATOR_AGENT_ACP_COMMAND).toBe("simulator-agent-acp");
    expect(LOCAL_SIMULATOR_AGENT_ACP_REGISTRY_ID).toBe("simulator-agent-acp-local");
    expect(createClaudeCodeAcpAgent).toBeTypeOf("function");
    expect(createCodexAcpAgent).toBeTypeOf("function");
    expect(createGeminiCliAcpAgent).toBeTypeOf("function");
    expect(createSimulatorAgentAcpAgent).toBeTypeOf("function");
    expect(resolveRuntimeHomePath).toBeTypeOf("function");
    expect(resolveRuntimeCachePath).toBeTypeOf("function");
  });

  it("keeps a narrow root runtime value export contract", () => {
    expect(Object.keys(publicSdk).sort()).toEqual([
      "ACP_PROTOCOL_ALIGNMENT_VERIFIED_AT",
      "ACP_PROTOCOL_DOCS_SCHEMA_URL",
      "ACP_PROTOCOL_DOCS_URL",
      "ACP_PROTOCOL_SOURCE_REF",
      "ACP_PROTOCOL_SOURCE_REPO",
      "ACP_PROTOCOL_VERSION",
      "ACP_RUNTIME_CACHE_DIR_ENV_VAR",
      "ACP_RUNTIME_HOME_DIR_ENV_VAR",
      "ACP_RUNTIME_SNAPSHOT_VERSION",
      "AcpAuthenticationError",
      "AcpCreateError",
      "AcpError",
      "AcpInitialConfigError",
      "AcpListError",
      "AcpLoadError",
      "AcpPermissionDeniedError",
      "AcpPermissionError",
      "AcpProcessError",
      "AcpProtocolError",
      "AcpResumeError",
      "AcpRuntime",
      "AcpRuntimeAgentConfigOptionType",
      "AcpRuntimeAuthenticationMethodType",
      "AcpRuntimeChangeType",
      "AcpRuntimeContentPartType",
      "AcpRuntimeMcpTransportType",
      "AcpRuntimeObservabilityCaptureContent",
      "AcpRuntimeObservabilityRedactionKind",
      "AcpRuntimeOperationFailureReason",
      "AcpRuntimeOperationKind",
      "AcpRuntimeOperationPermissionFamily",
      "AcpRuntimeOperationPhase",
      "AcpRuntimeOperationProjectionLifecycle",
      "AcpRuntimeOperationTargetType",
      "AcpRuntimePermissionDecisionValue",
      "AcpRuntimePermissionKind",
      "AcpRuntimePermissionProjectionLifecycle",
      "AcpRuntimePermissionRequestPhase",
      "AcpRuntimePermissionResolution",
      "AcpRuntimePermissionScope",
      "AcpRuntimePlanPriority",
      "AcpRuntimePlanStatus",
      "AcpRuntimeProjectionUpdateType",
      "AcpRuntimePromptMessageRole",
      "AcpRuntimeQueueDelivery",
      "AcpRuntimeQueuedTurnStatus",
      "AcpRuntimeReadModelUpdateType",
      "AcpRuntimeSession",
      "AcpRuntimeSessionListSource",
      "AcpRuntimeSessionReferenceSource",
      "AcpRuntimeSessionStatus",
      "AcpRuntimeStoredSessionUpdateType",
      "AcpRuntimeTerminalStatus",
      "AcpRuntimeThreadEntryKind",
      "AcpRuntimeThreadEntryStatus",
      "AcpRuntimeThreadToolContentKind",
      "AcpRuntimeTurnEventType",
      "AcpSystemPromptError",
      "AcpTurnCancelledError",
      "AcpTurnCoalescedError",
      "AcpTurnTimeoutError",
      "AcpTurnWithdrawnError",
      "CLAUDE_CODE_ACP_COMMAND",
      "CLAUDE_CODE_ACP_PACKAGE",
      "CLAUDE_CODE_ACP_REGISTRY_ID",
      "CODEX_ACP_COMMAND",
      "CODEX_ACP_PACKAGE",
      "CODEX_ACP_REGISTRY_ID",
      "GEMINI_CLI_ACP_COMMAND",
      "GEMINI_CLI_ACP_PACKAGE",
      "GEMINI_CLI_ACP_REGISTRY_ID",
      "LOCAL_SIMULATOR_AGENT_ACP_REGISTRY_ID",
      "SIMULATOR_AGENT_ACP_COMMAND",
      "SIMULATOR_AGENT_ACP_PACKAGE",
      "SIMULATOR_AGENT_ACP_REGISTRY_ID",
      "createClaudeCodeAcpAgent",
      "createCodexAcpAgent",
      "createGeminiCliAcpAgent",
      "createSimulatorAgentAcpAgent",
      "createStdioAcpConnectionFactory",
      "resolveRuntimeAgentFromRegistry",
      "resolveRuntimeCachePath",
      "resolveRuntimeHomePath",
      "resolveRuntimeTerminalAuthenticationRequest",
    ]);
  });

  it("does not leak internal runtime implementation types from the package root", () => {
    expect("AcpSessionDriver" in publicSdk).toBe(false);
    expect("AcpSessionService" in publicSdk).toBe(false);
    expect("createAcpSessionService" in publicSdk).toBe(false);
    expect("AcpConnectionFactory" in publicSdk).toBe(false);
    expect("AcpConnection" in publicSdk).toBe(false);
    expect("AcpClientInfo" in publicSdk).toBe(false);
    expect("AcpOptions" in publicSdk).toBe(false);
    expect("AcpSessionBootstrap" in publicSdk).toBe(false);
    expect("createExitWatcher" in publicSdk).toBe(false);
    expect("formatUnexpectedStdioExitError" in publicSdk).toBe(false);
  });
});
