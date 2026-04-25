import type { AuthMethod } from "@agentclientprotocol/sdk";

import type {
  AcpRuntimeAgent,
  AcpRuntimeAuthenticationMethod,
  AcpRuntimeTerminalAuthenticationRequest,
} from "../core/types.js";

export function mapRuntimeAuthMethods(input: {
  authMethods: readonly AuthMethod[] | undefined;
}): readonly AcpRuntimeAuthenticationMethod[] | undefined {
  return input.authMethods?.map((method) => {
    const meta = normalizeMeta(method._meta ?? undefined);
    const base = {
      description: method.description ?? undefined,
      id: method.id,
      meta,
      title: method.name,
    } as const;

    if (isEnvVarAuthMethod(method)) {
      return {
        ...base,
        link: method.link ?? undefined,
        type: "env_var",
        vars: method.vars.map((entry) => ({
          label: entry.label ?? undefined,
          name: entry.name,
          optional: entry.optional ?? undefined,
          secret: entry.secret ?? undefined,
        })),
      } satisfies AcpRuntimeAuthenticationMethod;
    }

    if (isTerminalAuthMethod(method)) {
      return {
        ...base,
        args: method.args ? [...method.args] : undefined,
        env: method.env ? { ...method.env } : undefined,
        type: "terminal",
      } satisfies AcpRuntimeAuthenticationMethod;
    }

    return {
      ...base,
      type: "agent",
    } satisfies AcpRuntimeAuthenticationMethod;
  });
}

export function resolveRuntimeTerminalAuthenticationRequest(input: {
  agent: AcpRuntimeAgent;
  method: AcpRuntimeAuthenticationMethod;
}): AcpRuntimeTerminalAuthenticationRequest | undefined {
  // This helper only resolves terminal execution details from ACP/runtime data.
  // Host-specific login success detection belongs in an adapter layer.
  if (input.method.type === "terminal") {
    return {
      args: [
        ...(input.agent.args ?? []),
        ...(input.method.args ? [...input.method.args] : []),
      ],
      command: input.agent.command,
      env: normalizeEnvRecord({
        ...input.agent.env,
        ...(input.method.env ?? {}),
      }),
      label: input.method.title,
      methodId: input.method.id,
    };
  }

  const legacy = resolveLegacyTerminalAuthenticationRequest(
    input.method,
    input.agent,
  );
  if (!legacy) {
    return undefined;
  }

  return {
    ...legacy,
    methodId: input.method.id,
  };
}

type LegacyTerminalAuthRequest = Omit<
  AcpRuntimeTerminalAuthenticationRequest,
  "methodId"
>;

function resolveLegacyTerminalAuthenticationRequest(
  method: AcpRuntimeAuthenticationMethod,
  agent: AcpRuntimeAgent,
): LegacyTerminalAuthRequest | undefined {
  const raw = method.meta?.["terminal-auth"];
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const value = raw as {
    args?: unknown;
    command?: unknown;
    env?: unknown;
    label?: unknown;
  };
  if (
    typeof value.label !== "string" ||
    typeof value.command !== "string" ||
    value.label.trim() === "" ||
    value.command.trim() === ""
  ) {
    return undefined;
  }

  return {
    args: Array.isArray(value.args)
      ? value.args.filter((entry): entry is string => typeof entry === "string")
      : [],
    command: value.command,
    env: normalizeEnvRecord({
      ...(agent.env ?? {}),
      ...(isStringRecord(value.env) ? value.env : {}),
    }),
    label: value.label,
  };
}

function normalizeMeta(
  meta: Record<string, unknown> | null | undefined,
): Readonly<Record<string, unknown>> | undefined {
  return meta ? { ...meta } : undefined;
}

function normalizeEnvRecord(
  env: Record<string, string | undefined> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!env) {
    return undefined;
  }

  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object") {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}

function isEnvVarAuthMethod(
  method: AuthMethod,
): method is Extract<AuthMethod, { type: "env_var" }> {
  return "type" in method && method.type === "env_var";
}

function isTerminalAuthMethod(
  method: AuthMethod,
): method is Extract<AuthMethod, { type: "terminal" }> {
  return "type" in method && method.type === "terminal";
}
