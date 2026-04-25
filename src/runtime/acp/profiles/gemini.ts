import type {
  AuthMethod,
  PromptResponse,
} from "@agentclientprotocol/sdk";

import type { AcpRuntimeAgent } from "../../core/types.js";
import { createAgentProfile, type AcpAgentProfile } from "./profile.js";

export const GEMINI_TERMINAL_AUTH_METHOD_ID = "spawn-gemini-cli";

export function createGeminiAgentProfile(
  _agent: AcpRuntimeAgent,
): AcpAgentProfile {
  return createAgentProfile({
    normalizeInitializeAuthMethods({ agent, authMethods }) {
      if (authMethods && authMethods.length > 0) {
        return authMethods;
      }

      // Gemini CLI has historically omitted initialize auth methods. Keep this
      // fallback in the profile layer as explicit compatibility policy rather
      // than treating it as generic ACP behavior.
      const args = (agent.args ?? []).filter(
        (value) => value !== "--experimental-acp" && value !== "--acp",
      );

      return [
        {
          _meta: {
            "acp-runtime/profile-policy": {
              kind: "synthetic-auth-method",
              profile: "gemini",
              reason: "missing-initialize-auth-methods",
            },
            "terminal-auth": {
              args,
              command: agent.command,
              env: agent.env ?? {},
              label: "gemini /auth",
            },
          },
          description: "Login with your Google or Vertex AI account",
          id: GEMINI_TERMINAL_AUTH_METHOD_ID,
          name: "Login",
        } satisfies AuthMethod,
      ];
    },
    normalizePromptError({ error, turn }) {
      if (!turn.cancelRequested) {
        return undefined;
      }

      if (!isGeminiAbortInternalError(error)) {
        return undefined;
      }

      return {
        stopReason: "cancelled",
      } satisfies PromptResponse;
    },
  });
}

function isGeminiAbortInternalError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const value = error as {
    code?: unknown;
    data?: unknown;
    message?: unknown;
  };
  const details = extractAbortDetails(value.data);
  if (details) {
    return (
      details.includes("This operation was aborted") ||
      details.includes("The user aborted a request")
    );
  }

  if (typeof value.message === "string") {
    return value.message.toLowerCase().includes("aborted");
  }

  return false;
}

function extractAbortDetails(data: unknown): string | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }

  const value = data as { details?: unknown };
  return typeof value.details === "string" ? value.details : undefined;
}
