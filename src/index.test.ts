import { describe, expect, it } from "vitest";

import {
  ACP_RUNTIME_SNAPSHOT_VERSION,
  ACP_RUNTIME_AUTHENTICATION_DEFAULT_METHOD_META_KEY,
  ACP_RUNTIME_CACHE_DIR_ENV_VAR,
  ACP_RUNTIME_HOME_DIR_ENV_VAR,
  ACP_RUNTIME_TERMINAL_AUTH_SUCCESS_PATTERNS_META_KEY,
  ACP_REGISTRY_AGENT_ALIASES,
  ACP_PROTOCOL_ALIGNMENT_VERIFIED_AT,
  ACP_PROTOCOL_DOCS_SCHEMA_URL,
  ACP_PROTOCOL_DOCS_URL,
  ACP_PROTOCOL_SOURCE_REF,
  ACP_PROTOCOL_SOURCE_REPO,
  ACP_PROTOCOL_VERSION,
  CLAUDE_CODE_ACP_COMMAND,
  CLAUDE_CODE_ACP_PACKAGE,
  CURSOR_ACP_COMMAND,
  GITHUB_COPILOT_ACP_COMMAND,
  GITHUB_COPILOT_ACP_PACKAGE,
  LOCAL_SIMULATOR_AGENT_ACP_REGISTRY_ID,
  OPENCODE_ACP_COMMAND,
  OPENCODE_ACP_PACKAGE,
  PI_ACP_COMMAND,
  PI_ACP_PACKAGE,
  SIMULATOR_AGENT_ACP_COMMAND,
  AcpPermissionDeniedError,
  AcpRuntime,
  AcpRuntimeTurnEventType,
  createClaudeCodeAcpAgent,
  createCodexAcpAgent,
  createCursorAcpAgent,
  createGeminiCliAcpAgent,
  createGitHubCopilotAcpAgent,
  createOpenCodeAcpAgent,
  createPiAcpAgent,
  createSimulatorAgentAcpAgent,
  listRuntimeAgentModeKeys,
  resolveRuntimeCachePath,
  resolveRuntimeAgentId,
  resolveRuntimeAgentModeId,
  resolveRuntimeHomePath,
  runtimeAuthenticationTerminalSuccessPatterns,
  selectRuntimeAuthenticationMethod,
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
    expect(ACP_RUNTIME_AUTHENTICATION_DEFAULT_METHOD_META_KEY).toBe(
      "acp-runtime/default-auth-method",
    );
    expect(ACP_RUNTIME_TERMINAL_AUTH_SUCCESS_PATTERNS_META_KEY).toBe(
      "acp-runtime/terminal-success-patterns",
    );
    expect(ACP_RUNTIME_HOME_DIR_ENV_VAR).toBe("ACP_RUNTIME_HOME_DIR");
    expect(ACP_RUNTIME_CACHE_DIR_ENV_VAR).toBe("ACP_RUNTIME_CACHE_DIR");
    expect(ACP_REGISTRY_AGENT_ALIASES.claude).toBe("claude-acp");
    expect(CLAUDE_CODE_ACP_COMMAND).toBe("claude-agent-acp");
    expect(CLAUDE_CODE_ACP_PACKAGE).toBe("@agentclientprotocol/claude-agent-acp");
    expect(CURSOR_ACP_COMMAND).toBe("cursor-agent");
    expect(GITHUB_COPILOT_ACP_COMMAND).toBe("copilot");
    expect(GITHUB_COPILOT_ACP_PACKAGE).toBe("@github/copilot");
    expect(OPENCODE_ACP_COMMAND).toBe("opencode");
    expect(OPENCODE_ACP_PACKAGE).toBe("opencode");
    expect(PI_ACP_COMMAND).toBe("pi-acp");
    expect(PI_ACP_PACKAGE).toBe("pi-acp");
    expect(SIMULATOR_AGENT_ACP_COMMAND).toBe("simulator-agent-acp");
    expect(LOCAL_SIMULATOR_AGENT_ACP_REGISTRY_ID).toBe("simulator-agent-acp-local");
    expect(createClaudeCodeAcpAgent).toBeTypeOf("function");
    expect(createCodexAcpAgent).toBeTypeOf("function");
    expect(createCursorAcpAgent).toBeTypeOf("function");
    expect(createGeminiCliAcpAgent).toBeTypeOf("function");
    expect(createGitHubCopilotAcpAgent).toBeTypeOf("function");
    expect(createOpenCodeAcpAgent).toBeTypeOf("function");
    expect(createPiAcpAgent).toBeTypeOf("function");
    expect(createSimulatorAgentAcpAgent).toBeTypeOf("function");
    expect(resolveRuntimeHomePath).toBeTypeOf("function");
    expect(resolveRuntimeCachePath).toBeTypeOf("function");
    expect(resolveRuntimeAgentId("pi")).toBe("pi-acp");
    expect(listRuntimeAgentModeKeys).toBeTypeOf("function");
    expect(resolveRuntimeAgentModeId).toBeTypeOf("function");
    expect(selectRuntimeAuthenticationMethod).toBeTypeOf("function");
    expect(runtimeAuthenticationTerminalSuccessPatterns).toBeTypeOf("function");
  });

  it("keeps a narrow root runtime value export contract", () => {
    expect(Object.keys(publicSdk).sort()).toEqual([
      "ACP_PROTOCOL_ALIGNMENT_VERIFIED_AT",
      "ACP_PROTOCOL_DOCS_SCHEMA_URL",
      "ACP_PROTOCOL_DOCS_URL",
      "ACP_PROTOCOL_SOURCE_REF",
      "ACP_PROTOCOL_SOURCE_REPO",
      "ACP_PROTOCOL_VERSION",
      "ACP_REGISTRY_AGENT_ALIASES",
      "ACP_RUNTIME_AUTHENTICATION_DEFAULT_METHOD_META_KEY",
      "ACP_RUNTIME_CACHE_DIR_ENV_VAR",
      "ACP_RUNTIME_HOME_DIR_ENV_VAR",
      "ACP_RUNTIME_SNAPSHOT_VERSION",
      "ACP_RUNTIME_TERMINAL_AUTH_SUCCESS_PATTERNS_META_KEY",
      "AcpAuthenticationError",
      "AcpCreateError",
      "AcpError",
      "AcpForkError",
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
      "CURSOR_ACP_COMMAND",
      "CURSOR_ACP_REGISTRY_ID",
      "GEMINI_CLI_ACP_COMMAND",
      "GEMINI_CLI_ACP_PACKAGE",
      "GEMINI_CLI_ACP_REGISTRY_ID",
      "GITHUB_COPILOT_ACP_COMMAND",
      "GITHUB_COPILOT_ACP_PACKAGE",
      "GITHUB_COPILOT_ACP_REGISTRY_ID",
      "LOCAL_SIMULATOR_AGENT_ACP_REGISTRY_ID",
      "OPENCODE_ACP_COMMAND",
      "OPENCODE_ACP_PACKAGE",
      "OPENCODE_ACP_REGISTRY_ID",
      "PI_ACP_COMMAND",
      "PI_ACP_PACKAGE",
      "PI_ACP_REGISTRY_ID",
      "SIMULATOR_AGENT_ACP_COMMAND",
      "SIMULATOR_AGENT_ACP_PACKAGE",
      "SIMULATOR_AGENT_ACP_REGISTRY_ID",
      "createClaudeCodeAcpAgent",
      "createCodexAcpAgent",
      "createCursorAcpAgent",
      "createGeminiCliAcpAgent",
      "createGitHubCopilotAcpAgent",
      "createOpenCodeAcpAgent",
      "createPiAcpAgent",
      "createSimulatorAgentAcpAgent",
      "createStdioAcpConnectionFactory",
      "listRuntimeAgentModeKeys",
      "resolveRuntimeAgentFromRegistry",
      "resolveRuntimeAgentId",
      "resolveRuntimeAgentModeId",
      "resolveRuntimeCachePath",
      "resolveRuntimeHomePath",
      "resolveRuntimeTerminalAuthenticationRequest",
      "runtimeAgentModeKey",
      "runtimeAgentModeUriFragment",
      "runtimeAuthenticationTerminalSuccessPatterns",
      "selectRuntimeAuthenticationMethod",
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
