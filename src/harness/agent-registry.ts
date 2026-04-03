import { readFile } from "node:fs/promises";

import type { HarnessAgentDefinition, HarnessClassification, HarnessProbeProfile } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((item) => typeof item === "string");
}

function isProbeProfile(value: unknown): value is HarnessProbeProfile {
  return isPlainObject(value) &&
    (value.modeId === undefined || typeof value.modeId === "string") &&
    (value.prompt === undefined || typeof value.prompt === "string");
}

function isProbeProfileRecord(value: unknown): value is Record<string, HarnessProbeProfile> {
  return isPlainObject(value) && Object.values(value).every((item) => isProbeProfile(item));
}

function isClassification(value: unknown): value is HarnessClassification {
  if (!isPlainObject(value)) return false;
  const validStatuses = new Set(["failed", "not-applicable", "not-observed", "mismatch"]);
  for (const key of ["assertionFailureStatus", "timeoutStatus", "executionErrorStatus"]) {
    if (value[key] !== undefined && !validStatuses.has(value[key] as string)) return false;
  }
  return true;
}

function isCaseClassificationsRecord(value: unknown): value is Record<string, HarnessClassification> {
  return isPlainObject(value) && Object.values(value).every((item) => isClassification(item));
}

export function isHarnessAgentDefinition(value: unknown): value is HarnessAgentDefinition {
  return isPlainObject(value) &&
    value.version === 1 &&
    typeof value.id === "string" &&
    typeof value.displayName === "string" &&
    value.transport === "stdio" &&
    isPlainObject(value.launch) &&
    typeof value.launch.command === "string" &&
    (value.launch.args === undefined ||
      (Array.isArray(value.launch.args) && value.launch.args.every((item) => typeof item === "string"))) &&
    (value.launch.env === undefined || isStringRecord(value.launch.env)) &&
    isPlainObject(value.auth) &&
    (value.auth.mode === "none" || value.auth.mode === "optional" || value.auth.mode === "required") &&
    (value.probes === undefined || isProbeProfileRecord(value.probes)) &&
    (value.caseClassifications === undefined || isCaseClassificationsRecord(value.caseClassifications));
}

export function parseHarnessAgentDefinition(value: unknown): HarnessAgentDefinition {
  if (!isHarnessAgentDefinition(value)) {
    throw new Error("Invalid harness agent definition");
  }

  return value;
}

export async function loadHarnessAgentDefinition(path: string): Promise<HarnessAgentDefinition> {
  const content = await readFile(path, "utf8");
  return parseHarnessAgentDefinition(JSON.parse(content) as unknown);
}
