import { AcpInitialConfigError } from "./errors.js";
import { normalizeRuntimeConfigValue } from "./config-options.js";
import type { AcpSessionDriver } from "./session-driver.js";
import {
  resolveAcpAgentProfile,
  type AcpAgentProfile,
} from "../acp/profiles/index.js";
import type {
  AcpRuntimeAgentConfigOption,
  AcpRuntimeConfigValue,
  AcpRuntimeInitialConfig,
  AcpRuntimeInitialConfigReport,
  AcpRuntimeInitialConfigReportItem,
  AcpRuntimeInitialConfigValue,
} from "./types.js";

type InitialConfigItem = {
  aliases: readonly AcpRuntimeConfigValue[];
  key: string;
  required: boolean;
  value: AcpRuntimeConfigValue;
};

type ApplyConfigOptionInput = {
  item: InitialConfigItem;
  option?: AcpRuntimeAgentConfigOption | undefined;
  resolveOption?: () => AcpRuntimeAgentConfigOption | undefined;
};

export async function applyRuntimeInitialConfig(
  driver: AcpSessionDriver,
  config: AcpRuntimeInitialConfig | undefined,
): Promise<AcpRuntimeInitialConfigReport | undefined> {
  if (!config || !hasInitialConfigWork(config)) {
    return undefined;
  }

  const items: AcpRuntimeInitialConfigReportItem[] = [];
  const profile = resolveAcpAgentProfile(driver.snapshot().agent);
  const strict = Boolean(config.strict);

  if (config.mode) {
    items.push(
      ...(await applyInitialMode(
        driver,
        normalizeModeItem(config.mode, strict, profile),
      )),
    );
  }

  if (config.model) {
    items.push(
      await applyInitialConfigOption(driver, {
        item: normalizeConfigItem("model", config.model, strict, profile),
        resolveOption: () =>
          findInitialConfigOption(driver, profile, "model"),
      }),
    );
  }

  if (config.effort) {
    items.push(
      await applyInitialConfigOption(driver, {
        item: normalizeConfigItem(
          "effort",
          config.effort,
          strict,
          profile,
        ),
        resolveOption: () =>
          findInitialConfigOption(driver, profile, "effort"),
      }),
    );
  }

  const failedRequired = items.find(
    (item) =>
      (item.status === "failed" || item.status === "skipped") &&
      isRequired(config, item.key, item.requestedValue),
  );
  const ok = items.every(
    (item) => item.status === "applied" || item.status === "already-set",
  );
  const report = { items, ok } satisfies AcpRuntimeInitialConfigReport;

  if (failedRequired) {
    throw new AcpInitialConfigError(
      `Failed to apply required initial config ${failedRequired.key}: ${failedRequired.reason ?? "unknown reason"}.`,
    );
  }

  return report;
}

async function applyInitialMode(
  driver: AcpSessionDriver,
  item: InitialConfigItem,
): Promise<AcpRuntimeInitialConfigReportItem[]> {
  const reports: AcpRuntimeInitialConfigReportItem[] = [];
  const modeId = findAvailableModeId(driver, item);
  const profile = resolveAcpAgentProfile(driver.snapshot().agent);
  const modeOption = findInitialConfigOption(driver, profile, "mode");

  if (!modeId && !modeOption) {
    return [
      skipped(
        item,
        driver.listAgentModes().length
          ? "Requested mode is not available."
          : "ACP agent does not expose a mode setting.",
      ),
    ];
  }

  if (modeOption) {
    reports.push(
      await applyInitialConfigOption(driver, {
        item,
        option: modeOption,
      }),
    );
  }

  if (modeId) {
    if (driver.metadata.currentModeId === modeId) {
      reports.push(alreadySet(item, modeId, "currentModeId"));
    } else {
      try {
        await driver.setAgentMode(modeId);
        reports.push(applied(item, modeId, "currentModeId"));
      } catch (error) {
        reports.push(failed(item, formatUnknownError(error), "currentModeId"));
      }
    }
  } else if (!modeOption) {
    reports.push(skipped(item, "Requested mode is not available."));
  }

  return reports;
}

async function applyInitialConfigOption(
  driver: AcpSessionDriver,
  input: ApplyConfigOptionInput,
): Promise<AcpRuntimeInitialConfigReportItem> {
  const option = input.option ?? input.resolveOption?.();
  if (!option) {
    return skipped(input.item, "ACP agent does not expose this config option.");
  }

  const normalized = normalizeFirstSupportedValue(option, input.item);
  if (!normalized.ok) {
    return skipped(input.item, normalized.reason, option.id);
  }

  if (sameConfigValue(option.value, normalized.value)) {
    return alreadySet(input.item, normalized.value, option.id);
  }

  try {
    await driver.setAgentConfigOption(option.id, normalized.value);
    return applied(input.item, normalized.value, option.id);
  } catch (error) {
    return failed(input.item, formatUnknownError(error), option.id);
  }
}

function normalizeFirstSupportedValue(
  option: AcpRuntimeAgentConfigOption,
  item: InitialConfigItem,
):
  | { ok: true; value: AcpRuntimeConfigValue }
  | { ok: false; reason: string } {
  for (const value of [item.value, ...item.aliases]) {
    try {
      return {
        ok: true,
        value: normalizeRuntimeConfigValue(option, value),
      };
    } catch {
      continue;
    }
  }

  return {
    ok: false,
    reason: "Requested value is not supported by the current ACP agent config.",
  };
}

function findAvailableModeId(
  driver: AcpSessionDriver,
  item: InitialConfigItem,
): string | undefined {
  const values = [item.value, ...item.aliases].map(String);
  return driver.listAgentModes().find((mode) => values.includes(mode.id))?.id;
}

function findConfigOption(
  options: readonly AcpRuntimeAgentConfigOption[],
  input: { categories: readonly string[]; ids: readonly string[] },
): AcpRuntimeAgentConfigOption | undefined {
  return (
    input.ids.map((id) => options.find((option) => option.id === id)).find(Boolean) ??
    input.categories
      .map((category) =>
        options.find((option) => option.category === category),
      )
      .find(Boolean)
  );
}

function findInitialConfigOption(
  driver: AcpSessionDriver,
  profile: AcpAgentProfile,
  key: "mode" | "model" | "effort",
): AcpRuntimeAgentConfigOption | undefined {
  return findConfigOption(
    driver.listAgentConfigOptions(),
    profile.createInitialConfigOptionSelector?.({ key }) ?? {
      categories: [],
      ids: [],
    },
  );
}

function normalizeModeItem(
  value: NonNullable<AcpRuntimeInitialConfig["mode"]>,
  strict: boolean,
  profile: AcpAgentProfile,
): InitialConfigItem {
  if (typeof value === "string") {
    return {
      aliases: profile.createInitialConfigAliases?.({
        key: "mode",
        value,
      }) ?? [],
      key: "mode",
      required: strict,
      value,
    };
  }
  return {
    aliases: [
      ...(value.aliases ?? []),
      ...(profile.createInitialConfigAliases?.({
        key: "mode",
        value: value.value,
      }) ?? []),
    ],
    key: "mode",
    required: value.required ?? strict,
    value: value.value,
  };
}

function normalizeConfigItem(
  key: string,
  value: AcpRuntimeInitialConfigValue,
  strict: boolean,
  profile?: AcpAgentProfile,
): InitialConfigItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    const scalarValue = value as AcpRuntimeConfigValue;
    return {
      aliases: createProfileAliases(profile, key, scalarValue),
      key,
      required: strict,
      value: scalarValue,
    };
  }
  const configValue = value.value;
  return {
    aliases: [
      ...(value.aliases ?? []),
      ...createProfileAliases(profile, key, configValue),
    ],
    key,
    required: value.required ?? strict,
    value: configValue,
  };
}

function createProfileAliases(
  profile: AcpAgentProfile | undefined,
  key: string,
  value: AcpRuntimeConfigValue,
): readonly AcpRuntimeConfigValue[] {
  if (key !== "model" && key !== "effort") {
    return [];
  }
  return profile?.createInitialConfigAliases?.({
    key,
    value,
  }) ?? [];
}

function isRequired(
  config: AcpRuntimeInitialConfig,
  key: string,
  _requestedValue: AcpRuntimeConfigValue,
): boolean {
  if (config.strict) {
    return true;
  }
  if (key === "mode" && typeof config.mode === "object") {
    return Boolean(config.mode.required);
  }
  if (key === "model") {
    return isConfigValueRequired(config.model);
  }
  if (key === "effort") {
    return isConfigValueRequired(config.effort);
  }
  return false;
}

function isConfigValueRequired(
  value: AcpRuntimeInitialConfigValue | undefined,
): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Boolean(value.required)
    : false;
}

function hasInitialConfigWork(config: AcpRuntimeInitialConfig): boolean {
  return Boolean(
    config.mode ||
      config.model ||
      config.effort,
  );
}

function applied(
  item: InitialConfigItem,
  value: AcpRuntimeConfigValue,
  optionId?: string,
): AcpRuntimeInitialConfigReportItem {
  return {
    appliedValue: value,
    key: item.key,
    optionId,
    requestedValue: item.value,
    status: "applied",
  };
}

function alreadySet(
  item: InitialConfigItem,
  value: AcpRuntimeConfigValue,
  optionId?: string,
): AcpRuntimeInitialConfigReportItem {
  return {
    appliedValue: value,
    key: item.key,
    optionId,
    requestedValue: item.value,
    status: "already-set",
  };
}

function skipped(
  item: InitialConfigItem,
  reason: string,
  optionId?: string,
): AcpRuntimeInitialConfigReportItem {
  return {
    key: item.key,
    optionId,
    reason,
    requestedValue: item.value,
    status: "skipped",
  };
}

function failed(
  item: InitialConfigItem,
  reason: string,
  optionId?: string,
): AcpRuntimeInitialConfigReportItem {
  return {
    key: item.key,
    optionId,
    reason,
    requestedValue: item.value,
    status: "failed",
  };
}

function sameConfigValue(
  left: AcpRuntimeConfigValue,
  right: AcpRuntimeConfigValue,
): boolean {
  return String(left) === String(right);
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
