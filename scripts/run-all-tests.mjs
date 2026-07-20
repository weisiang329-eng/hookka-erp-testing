import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const testDir = resolve(process.cwd(), "tests");
const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => resolve(testDir, name));

if (files.length === 0) {
  console.error("No tests/*.test.mjs files found");
  process.exit(1);
}

console.log(`Running all ${files.length} test files`);
const result = spawnSync(process.execPath, ["--import", "tsx/esm", "--test", ...files], {
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
