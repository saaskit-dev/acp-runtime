import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  AcpRuntimeAgent,
  AcpRuntimeAuthenticationMethod,
} from "../../core/types.js";
import { createAgentProfile, type AcpAgentProfile } from "./profile.js";

export function createGitHubCopilotAgentProfile(
  _agent: AcpRuntimeAgent,
): AcpAgentProfile {
  return createAgentProfile({
    async normalizeRuntimeAuthenticationMethods({ methods }) {
      if (!(await hasCopilotLoggedInUser(resolveCopilotConfigDir(methods)))) {
        return methods;
      }

      return methods.map((method) =>
        method.id === "copilot-login"
          ? {
              ...method,
              meta: stripTerminalAuthMeta(method.meta),
            }
          : method,
      );
    },
  });
}

function resolveCopilotConfigDir(
  methods: readonly AcpRuntimeAuthenticationMethod[],
): string {
  for (const method of methods) {
    const request = method.meta?.["terminal-auth"];
    if (!request || typeof request !== "object") {
      continue;
    }

    const args = (request as { args?: unknown }).args;
    if (!Array.isArray(args)) {
      continue;
    }

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--config-dir" && typeof args[index + 1] === "string") {
        return args[index + 1];
      }
      if (typeof arg === "string" && arg.startsWith("--config-dir=")) {
        return arg.slice("--config-dir=".length);
      }
    }
  }

  return join(homedir(), ".copilot");
}

async function hasCopilotLoggedInUser(configDir: string): Promise<boolean> {
  try {
    const rawConfig = await readFile(join(configDir, "config.json"), "utf8");
    const config = JSON.parse(stripJsonComments(rawConfig)) as {
      lastLoggedInUser?: unknown;
      loggedInUsers?: unknown;
    };
    if (Array.isArray(config.loggedInUsers)) {
      return config.loggedInUsers.some(isCopilotLoggedInUser);
    }
    return isCopilotLoggedInUser(config.lastLoggedInUser);
  } catch {
    return false;
  }
}

function stripTerminalAuthMeta(
  meta: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!meta?.["terminal-auth"]) {
    return meta;
  }

  const next = { ...meta };
  delete next["terminal-auth"];
  return Object.keys(next).length > 0 ? next : undefined;
}

function stripJsonComments(input: string): string {
  return input
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function isCopilotLoggedInUser(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { login?: unknown }).login === "string" &&
    (value as { login: string }).login.trim().length > 0
  );
}
