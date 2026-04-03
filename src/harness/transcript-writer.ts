import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { TranscriptEntry } from "./types.js";
import { sanitizeTranscriptEntries } from "./output-sanitizer.js";

export async function writeTranscript(path: string, entries: TranscriptEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = sanitizeTranscriptEntries(entries).map((entry) => JSON.stringify(entry)).join("\n");
  await writeFile(path, body.length > 0 ? `${body}\n` : "", "utf8");
}

export function buildTranscriptPath(baseDir: string, agentId: string, caseId: string): string {
  return join(baseDir, agentId, `${caseId}.jsonl`);
}
