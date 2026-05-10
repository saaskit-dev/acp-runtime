import {
  AcpRuntimeContentPartType,
  AcpRuntimeThreadToolContentKind,
  type AcpRuntimeOutputPart,
  type AcpRuntimeThreadToolContent,
} from "../core/types.js";

export function mapRawToolOutputToOutputParts(
  value: unknown,
): readonly AcpRuntimeOutputPart[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (Array.isArray(value)) {
    const parts = value.flatMap((entry): AcpRuntimeOutputPart[] => {
      const part = mapKnownRawContentEntry(entry);
      return part ? [part] : [];
    });
    if (parts.length > 0) {
      return parts;
    }
  }

  if (typeof value === "string") {
    return [{ text: value, type: AcpRuntimeContentPartType.Text }];
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return [{ text: String(value), type: AcpRuntimeContentPartType.Text }];
  }

  return [{ type: AcpRuntimeContentPartType.Json, value }];
}

export function mapRawToolOutputToOutputText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  return prettyJson(value);
}

export function mapRawToolOutputToThreadContent(input: {
  idPrefix?: string;
  value: unknown;
}): readonly AcpRuntimeThreadToolContent[] {
  const parts = mapRawToolOutputToOutputParts(input.value);
  return parts.map((part, index): AcpRuntimeThreadToolContent => {
    const id = `${input.idPrefix ?? "raw-output"}-${index + 1}`;
    if (part.type === AcpRuntimeContentPartType.Text) {
      return {
        id,
        kind: AcpRuntimeThreadToolContentKind.Content,
        part,
        text: part.text,
      };
    }
    if (part.type === AcpRuntimeContentPartType.Image) {
      return {
        id,
        kind: AcpRuntimeThreadToolContentKind.Content,
        label: part.mediaType ?? "image",
        part,
      };
    }
    if (part.type === AcpRuntimeContentPartType.Json) {
      return {
        id,
        kind: AcpRuntimeThreadToolContentKind.Content,
        label: "Raw Output",
        part,
        text: prettyJson(part.value),
      };
    }
    return {
      id,
      kind: AcpRuntimeThreadToolContentKind.Content,
      part,
    };
  });
}

function mapKnownRawContentEntry(
  value: unknown,
): AcpRuntimeOutputPart | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.type === "text" && typeof value.text === "string") {
    return {
      text: value.text,
      type: AcpRuntimeContentPartType.Text,
    };
  }

  const imageUrl =
    value.type === "input_image" && typeof value.image_url === "string"
      ? value.image_url
      : value.type === "image" && typeof value.uri === "string"
        ? value.uri
        : undefined;
  if (imageUrl) {
    return {
      mediaType:
        typeof value.mimeType === "string"
          ? value.mimeType
          : imageUrl.startsWith("data:image/")
            ? imageUrl.slice("data:".length, imageUrl.indexOf(";"))
            : undefined,
      type: AcpRuntimeContentPartType.Image,
      uri: imageUrl,
    };
  }

  return undefined;
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
