import {
  ACP_RUNTIME_AUTHENTICATION_DEFAULT_METHOD_META_KEY,
  type AcpRuntimeAgent,
} from "../../core/types.js";
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
    normalizeRuntimeAuthenticationMethods({ methods }) {
      const defaultMethod = selectDefaultCodexAuthenticationMethod(methods);
      if (!defaultMethod) {
        return methods;
      }

      return methods.map((method) =>
        method.id === defaultMethod.id
          ? {
              ...method,
              meta: {
                ...(method.meta ?? {}),
                [ACP_RUNTIME_AUTHENTICATION_DEFAULT_METHOD_META_KEY]: true,
              },
            }
          : method,
      );
    },
  });
}

function selectDefaultCodexAuthenticationMethod<
  T extends { id: string; title: string; type: string },
>(methods: readonly T[]): T | undefined {
  return (
    methods.find(
      (method) =>
        method.type === "agent" && /login|chatgpt/i.test(method.title),
    ) ?? methods.find((method) => method.type === "agent")
  );
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
