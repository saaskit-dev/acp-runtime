import type { AcpRuntimeAgent } from "../../core/types.js";
import { createAgentProfile, type AcpAgentProfile } from "./profile.js";

export function createCodexAgentProfile(
  _agent: AcpRuntimeAgent,
): AcpAgentProfile {
  return createAgentProfile({
    applySystemPromptToAgent({ agent, systemPrompt }) {
      return {
        ...agent,
        args: [
          ...(agent.args ?? []),
          "-c",
          `developer_instructions=${JSON.stringify(systemPrompt)}`,
        ],
      };
    },
    createInitialConfigAliases({ key, value }) {
      if (key === "effort") {
        return createEffortAliases(value);
      }
      if (key === "model") {
        return createCodexModelAliases(value);
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
            categories: ["thought_level", "effort"],
            ids: ["reasoning_effort", "effort"],
          };
      }
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

function createCodexModelAliases(value: unknown): readonly string[] {
  const normalized = String(value).toLowerCase();
  if (!normalized.startsWith("gpt-")) {
    return [];
  }
  return [normalized, normalized.toUpperCase()];
}
