import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const ACP_RUNTIME_HOME_DIR_ENV_VAR = "ACP_RUNTIME_HOME_DIR" as const;
export const ACP_RUNTIME_CACHE_DIR_ENV_VAR = "ACP_RUNTIME_CACHE_DIR" as const;

function resolveRoot(
  envVar: string,
  fallback: string,
): string {
  const override = process.env[envVar]?.trim();
  return override ? resolve(override) : fallback;
}

export function resolveRuntimeHomePath(...segments: string[]): string {
  const root = resolveRoot(
    ACP_RUNTIME_HOME_DIR_ENV_VAR,
    join(homedir(), ".acp-runtime"),
  );
  return segments.length > 0 ? join(root, ...segments) : root;
}

export function resolveRuntimeCachePath(...segments: string[]): string {
  const root = resolveRoot(
    ACP_RUNTIME_CACHE_DIR_ENV_VAR,
    resolveRuntimeHomePath("cache"),
  );
  return segments.length > 0 ? join(root, ...segments) : root;
}
