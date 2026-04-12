import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

async function main(): Promise<void> {
  const examplesDir = dirname(fileURLToPath(import.meta.url));
  const currentFile = fileURLToPath(import.meta.url);
  const entries = await readdir(examplesDir, { withFileTypes: true });
  const smokeFiles = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /^runtime-.*smoke\.js$/.test(entry.name) &&
        entry.name !== "runtime-smoke-all.js",
    )
    .map((entry) => join(examplesDir, entry.name))
    .sort();

  if (smokeFiles.length === 0) {
    throw new Error(
      `No runtime smoke files found next to ${currentFile}.`,
    );
  }

  for (const smokeFile of smokeFiles) {
    console.log(`[smoke:runtime] running ${smokeFile}`);
    await runSmoke(smokeFile);
  }
}

async function runSmoke(smokeFile: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [smokeFile], {
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `Smoke script failed: ${smokeFile} exited with ${signal ?? code}.`,
        ),
      );
    });
  });
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
