import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadHarnessCase } from "./case-loader.js";

type CaseLintResult = {
  file: string;
  id?: string;
  status: "PASS" | "FAIL";
  error?: string;
};

async function lintCases(casesRoot: string): Promise<CaseLintResult[]> {
  const entries = await readdir(casesRoot, { withFileTypes: true });
  const jsonFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort();

  const results: CaseLintResult[] = [];

  for (const name of jsonFiles) {
    const filePath = join(casesRoot, name);
    try {
      const harnessCase = await loadHarnessCase(filePath);
      results.push({ file: name, id: harnessCase.id, status: "PASS" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ file: name, status: "FAIL", error: message });
    }
  }

  return results;
}

async function main(): Promise<void> {
  const casesRoot = resolve("./harness/cases");
  const results = await lintCases(casesRoot);

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;

  for (const result of results) {
    const marker = result.status === "PASS" ? "✓" : "✗";
    const color = result.status === "PASS" ? "\x1b[32m" : "\x1b[31m";
    const reset = "\x1b[0m";
    const idPart = result.id ? ` (${result.id})` : "";
    const errorPart = result.error ? ` — ${result.error}` : "";
    console.log(`  ${color}${marker}${reset} ${result.file}${idPart}${errorPart}`);
  }

  console.log();
  console.log(`  ${passed} passed, ${failed} failed, ${results.length} total`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void main();
}
