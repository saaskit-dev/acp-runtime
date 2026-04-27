import type { AcpRuntimeAgentMode } from "./types.js";

export function runtimeAgentModeKey(mode: Pick<AcpRuntimeAgentMode, "id" | "name">): string {
  return runtimeAgentModeUriFragment(mode.id) ?? mode.name.toLowerCase().replace(/\s+/g, "-");
}

export function runtimeAgentModeUriFragment(value: string): string | undefined {
  const index = value.lastIndexOf("#");
  if (index < 0 || index === value.length - 1) {
    return undefined;
  }
  return value.slice(index + 1);
}

export function listRuntimeAgentModeKeys(
  modes: readonly AcpRuntimeAgentMode[],
): string[] {
  const keys = new Set<string>();
  for (const mode of modes) {
    keys.add(runtimeAgentModeKey(mode));
    keys.add(mode.id);
  }
  return [...keys];
}

export function resolveRuntimeAgentModeId(
  modes: readonly AcpRuntimeAgentMode[],
  input: string,
): {
  error?: string;
  modeId?: string;
} {
  const raw = input.trim();
  if (!raw) {
    return { error: "usage: mode <id|name>" };
  }

  const lower = raw.toLowerCase();
  const matches = modes.filter((mode) => {
    const key = runtimeAgentModeKey(mode);
    const fragment = runtimeAgentModeUriFragment(mode.id);
    return (
      mode.id === raw ||
      mode.name === raw ||
      key === raw ||
      fragment === raw ||
      mode.id.toLowerCase() === lower ||
      mode.name.toLowerCase() === lower ||
      key.toLowerCase() === lower ||
      fragment?.toLowerCase() === lower
    );
  });

  if (matches.length === 1 && matches[0]) {
    return { modeId: matches[0].id };
  }

  if (matches.length > 1) {
    return {
      error: `ambiguous mode: ${input}. Use one of: ${matches
        .map((mode) => runtimeAgentModeKey(mode))
        .join(", ")}`,
    };
  }

  return {
    error: `unknown mode: ${input}. Valid values: ${listRuntimeAgentModeKeys(modes).join(", ")}`,
  };
}
