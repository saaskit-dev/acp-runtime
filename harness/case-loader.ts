import { readFile } from "node:fs/promises";

import type { HarnessCase } from "./types.js";
import { parseHarnessCase } from "./validators.js";

export async function loadHarnessCase(path: string): Promise<HarnessCase> {
  const content = await readFile(path, "utf8");
  return parseHarnessCase(JSON.parse(content) as unknown);
}
