import {
  ACP_RUNTIME_TERMINAL_AUTH_SUCCESS_PATTERNS_META_KEY,
  type AcpRuntimeAgent,
} from "../../core/types.js";
import { createAgentProfile, type AcpAgentProfile } from "./profile.js";

export function createClaudeCodeAgentProfile(
  _agent: AcpRuntimeAgent,
): AcpAgentProfile {
  return createAgentProfile({
    createSystemPromptSessionMeta({ systemPrompt }) {
      return { systemPrompt };
    },
    createInitialConfigAliases({ key, value }) {
      if (key === "effort") {
        return createEffortAliases(value);
      }
      if (key === "model") {
        return createClaudeModelAliases(value);
      }
      return [];
    },
    createInitialConfigOptionSelector({ key }) {
      switch (key) {
        case "mode":
          return { categories: ["mode"], ids: ["mode"] };
        case "model":
          return { categories: ["model"], ids: ["model"] };
        case "effort":
          return {
            categories: ["effort", "thought_level"],
            ids: ["effort", "reasoning_effort"],
          };
      }
    },
    normalizeRuntimeAuthenticationMethods({ methods }) {
      return methods.map((method) =>
        method.id === "claude-login"
          ? {
              ...method,
              meta: {
                ...(method.meta ?? {}),
                [ACP_RUNTIME_TERMINAL_AUTH_SUCCESS_PATTERNS_META_KEY]: [
                  "Login successful",
                  "Type your message",
                ],
              },
            }
          : method,
      );
    },
    inferDeniedOperationFamily({ metadata, operation }) {
      if (
        metadata.currentModeId === "dontAsk" &&
        (operation.kind === "write_file" || operation.kind === "execute_command")
      ) {
        return "mode_denied";
      }
      return undefined;
    },
  });
}

function createEffortAliases(value: unknown): readonly string[] {
  switch (String(value).toLowerCase()) {
    case "xhigh":
    case "extra-high":
    case "extra_high":
    case "max":
      return ["xhigh", "extra-high", "extra_high", "max"];
    case "high":
      return ["high"];
    case "medium":
      return ["medium"];
    case "low":
      return ["low"];
    default:
      return [];
  }
}

function createClaudeModelAliases(value: unknown): readonly string[] {
  const normalized = String(value).toLowerCase();
  if (normalized === "opus" || normalized.includes("opus")) {
    return ["opus", "claude-opus", "claude-sonnet-4-5-opus"];
  }
  if (normalized === "sonnet" || normalized.includes("sonnet")) {
    return ["sonnet", "claude-sonnet", "claude-sonnet-4-5"];
  }
  return [];
}
