import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { HarnessSummary, TranscriptEntry } from "./types.js";
import { sanitizeHarnessSummary, sanitizeNotes, sanitizeTranscriptEntries } from "./output-sanitizer.js";

export async function writeTranscript(path: string, entries: TranscriptEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = sanitizeTranscriptEntries(entries).map((entry) => JSON.stringify(entry)).join("\n");
  await writeFile(path, body.length > 0 ? `${body}\n` : "", "utf8");
}

export async function writeSummary(path: string, summary: HarnessSummary): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(sanitizeHarnessSummary(summary), null, 2)}\n`, "utf8");
}

export async function writeNotes(path: string, notes: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const sanitizedNotes = sanitizeNotes(notes);
  const body = sanitizedNotes.length === 0
    ? "# Notes\n\n- none\n"
    : `# Notes\n\n${sanitizedNotes.map((note) => `- ${note}`).join("\n")}\n`;
  await writeFile(path, body, "utf8");
}

export function buildHarnessOutputPaths(baseDir: string): {
  transcriptPath: string;
  summaryPath: string;
  notesPath: string;
} {
  return {
    transcriptPath: join(baseDir, "transcript.jsonl"),
    summaryPath: join(baseDir, "summary.json"),
    notesPath: join(baseDir, "notes.md"),
  };
}
