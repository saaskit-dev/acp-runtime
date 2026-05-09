import { createHash } from "node:crypto";

export type AcpRemotePayloadLogSummary = {
  payloadBytes?: number;
  payloadHash?: string;
  payloadPreview?: string;
  payloadPreviewTruncated?: boolean;
  promptBlockCount?: number;
  promptTextChars?: number;
  promptTextHash?: string;
  promptTextPreview?: string;
  promptTextPreviewTruncated?: boolean;
  responseHasError?: boolean;
  stopReason?: string;
  updateKind?: string;
  updateTextChars?: number;
  updateTextHash?: string;
  updateTextPreview?: string;
  updateTextPreviewTruncated?: boolean;
};

const DEFAULT_PREVIEW_LIMIT = 240;
const FULL_PREVIEW_LIMIT = 4_000;

export function summarizeAcpRemotePayloadForLog(
  payload: unknown,
): AcpRemotePayloadLogSummary {
  const serialized = serializePayload(payload);
  const summary: AcpRemotePayloadLogSummary = {
    payloadBytes: Buffer.byteLength(serialized),
    payloadHash: hashText(serialized),
  };
  const previewMode = readPayloadPreviewMode();
  if (previewMode !== "off") {
    Object.assign(
      summary,
      previewField(
        "payloadPreview",
        serialized,
        previewMode === "full" ? FULL_PREVIEW_LIMIT : DEFAULT_PREVIEW_LIMIT,
      ),
    );
  }

  if (!isRecord(payload)) {
    return summary;
  }

  const params = isRecord(payload.params) ? payload.params : undefined;
  const result = isRecord(payload.result) ? payload.result : undefined;
  summary.responseHasError = Object.prototype.hasOwnProperty.call(payload, "error")
    ? true
    : undefined;
  summary.stopReason = readString(result?.stopReason);

  if (payload.method === "session/prompt") {
    const prompt = params?.prompt;
    const promptText = collectText(prompt).join("\n");
    summary.promptBlockCount = Array.isArray(prompt)
      ? prompt.length
      : prompt === undefined
        ? 0
        : 1;
    if (promptText) {
      summary.promptTextChars = promptText.length;
      summary.promptTextHash = hashText(promptText);
      if (previewMode !== "off") {
        Object.assign(
          summary,
          previewField(
            "promptTextPreview",
            promptText,
            previewMode === "full" ? FULL_PREVIEW_LIMIT : DEFAULT_PREVIEW_LIMIT,
          ),
        );
      }
    }
  }

  if (payload.method === "session/update") {
    const update = isRecord(params?.update) ? params.update : undefined;
    summary.updateKind =
      readString(update?.sessionUpdate) ??
      readString(update?.kind) ??
      readString(update?.type);
    const updateText = collectText(update ?? params?.update).join("\n");
    if (updateText) {
      summary.updateTextChars = updateText.length;
      summary.updateTextHash = hashText(updateText);
      if (previewMode !== "off") {
        Object.assign(
          summary,
          previewField(
            "updateTextPreview",
            updateText,
            previewMode === "full" ? FULL_PREVIEW_LIMIT : DEFAULT_PREVIEW_LIMIT,
          ),
        );
      }
    }
  }

  return summary;
}

function serializePayload(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function collectText(value: unknown): string[] {
  const texts: string[] = [];
  const visit = (candidate: unknown, key?: string): void => {
    if (texts.length >= 64 || candidate === undefined || candidate === null) {
      return;
    }
    if (typeof candidate === "string") {
      if (!key || key === "text" || key === "content" || key === "message") {
        texts.push(candidate);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        visit(entry);
      }
      return;
    }
    if (!isRecord(candidate)) {
      return;
    }
    for (const [entryKey, entryValue] of Object.entries(candidate)) {
      visit(entryValue, entryKey);
    }
  };
  visit(value);
  return texts;
}

function previewField<Key extends string>(
  key: Key,
  text: string,
  limit: number,
): Record<Key | `${Key}Truncated`, string | boolean> {
  const truncated = text.length > limit;
  return {
    [key]: truncated ? text.slice(0, limit) : text,
    [`${key}Truncated`]: truncated,
  } as Record<Key | `${Key}Truncated`, string | boolean>;
}

function readPayloadPreviewMode(): "off" | "summary" | "full" {
  const raw =
    process.env.ACP_REMOTE_DEBUG_PAYLOAD ??
    process.env.ACP_REMOTE_LOG_PAYLOAD ??
    "";
  if (/^(1|true|yes|summary)$/i.test(raw)) {
    return "summary";
  }
  return /^full$/i.test(raw) ? "full" : "off";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
