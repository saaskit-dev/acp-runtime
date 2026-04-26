import { AcpProtocolError } from "./errors.js";
import type {
  AcpRuntimeAgentConfigOption,
  AcpRuntimeAgentConfigOptionChoice,
  AcpRuntimeConfigValue,
} from "./types.js";

export function resolveRuntimeConfigOption(
  options: readonly AcpRuntimeAgentConfigOption[],
  idOrCategory: string,
): AcpRuntimeAgentConfigOption {
  const byId = options.find((option) => option.id === idOrCategory);
  if (byId) {
    return byId;
  }

  const byCategory = options.filter((option) => option.category === idOrCategory);
  if (byCategory.length === 1 && byCategory[0]) {
    return byCategory[0];
  }

  if (byCategory.length > 1) {
    throw new AcpProtocolError(
      `Ambiguous ACP agent config category: ${idOrCategory}. Use one of: ${byCategory
        .map((option) => option.id)
        .join(", ")}`,
    );
  }

  const available = options
    .map((option) =>
      option.category && option.category !== option.id
        ? `${option.id} (${option.category})`
        : option.id,
    )
    .join(", ");
  throw new AcpProtocolError(
    `Unknown ACP agent config option: ${idOrCategory}${available ? `. Available options: ${available}` : ""}`,
  );
}

export function normalizeRuntimeConfigValue(
  option: AcpRuntimeAgentConfigOption,
  value: AcpRuntimeConfigValue,
): AcpRuntimeConfigValue {
  if (option.type === "boolean") {
    return normalizeBooleanConfigValue(option, value);
  }

  if (option.type === "number") {
    return normalizeNumberConfigValue(option, value);
  }

  if (option.type === "select") {
    return normalizeSelectConfigValue(option, value);
  }

  return String(value);
}

export function formatRuntimeConfigChoices(
  option: AcpRuntimeAgentConfigOption,
): string {
  if (option.type === "boolean") {
    return "true, false";
  }
  if (option.options?.length) {
    return option.options.map((choice) => String(choice.value)).join(", ");
  }
  return "<any string>";
}

function normalizeBooleanConfigValue(
  option: AcpRuntimeAgentConfigOption,
  value: AcpRuntimeConfigValue,
): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  throw new AcpProtocolError(
    `Invalid value for ACP agent config option ${option.id}: ${String(value)}. Valid values: true, false`,
  );
}

function normalizeNumberConfigValue(
  option: AcpRuntimeAgentConfigOption,
  value: AcpRuntimeConfigValue,
): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  throw new AcpProtocolError(
    `Invalid value for ACP agent config option ${option.id}: ${String(value)}. Expected a number.`,
  );
}

function normalizeSelectConfigValue(
  option: AcpRuntimeAgentConfigOption,
  value: AcpRuntimeConfigValue,
): AcpRuntimeConfigValue {
  if (!option.options?.length) {
    return String(value);
  }

  const raw = String(value).trim();
  const lower = raw.toLowerCase();
  const choices = option.options;

  const exactValue = choices.find((choice) => String(choice.value) === raw);
  if (exactValue) {
    return exactValue.value;
  }

  const exactName = choices.find((choice) => choice.name === raw);
  if (exactName) {
    return exactName.value;
  }

  const foldedValue = choices.find(
    (choice) => String(choice.value).toLowerCase() === lower,
  );
  if (foldedValue) {
    return foldedValue.value;
  }

  const foldedName = choices.find((choice) => choice.name.toLowerCase() === lower);
  if (foldedName) {
    return foldedName.value;
  }

  throw new AcpProtocolError(
    `Invalid value for ACP agent config option ${option.id}: ${raw}. Valid values: ${formatRuntimeConfigChoiceList(choices)}`,
  );
}

function formatRuntimeConfigChoiceList(
  choices: readonly AcpRuntimeAgentConfigOptionChoice[],
): string {
  return choices
    .map((choice) =>
      choice.name === String(choice.value)
        ? String(choice.value)
        : `${String(choice.value)} (${choice.name})`,
    )
    .join(", ");
}
