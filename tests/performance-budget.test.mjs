import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  analyzeBuild,
  evaluateBudgets,
} from "../scripts/check-performance-budgets.mjs";

function fixtureBudgets() {
  return {
    boot: {
      maxJavaScriptGzipBytes: 1000,
      maxCssGzipBytes: 1000,
      maxJavaScriptRequests: 3,
      maxCssRequests: 1,
      forbiddenInitialStems: ["charts", "pdf", "xlsx"],
    },
    pageBudgets: [
      { name: "login-page", stems: ["login"], maxEachGzipBytes: 100 },
    ],
    deferredBudgets: [
      { name: "charts", stems: ["charts"], maxEachGzipBytes: 200 },
    ],
  };
}

test("page-specific chunks cannot leak into the global boot preload", () => {
  const report = {
    initial: [
      { file: "index-12345678.js", kind: "javascript", gzipBytes: 20 },
      { file: "charts-12345678.js", kind: "javascript", gzipBytes: 50 },
    ],
    allJavaScript: [
      { file: "login-12345678.js", gzipBytes: 50 },
      { file: "charts-12345678.js", gzipBytes: 50 },
    ],
  };
  const result = evaluateBudgets(report, fixtureBudgets());
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /charts.+global boot graph/);
});

test("page and deferred budgets are evaluated independently", () => {
  const report = {
    initial: [{ file: "index-12345678.js", kind: "javascript", gzipBytes: 20 }],
    allJavaScript: [
      { file: "login-12345678.js", gzipBytes: 101 },
      { file: "charts-12345678.js", gzipBytes: 201 },
    ],
  };
  const result = evaluateBudgets(report, fixtureBudgets());
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /login-page\/login/);
  assert.match(result.failures.join("\n"), /charts\/charts/);
});

test("build analysis follows entry static imports missing from HTML preload tags", async () => {
  const distDir = await mkdtemp(join(tmpdir(), "hookka-performance-budget-"));
  try {
    await mkdir(join(distDir, "assets"));
    await writeFile(
      join(distDir, "index.html"),
      '<link rel="stylesheet" href="/assets/index-12345678.css"><script type="module" src="/assets/index-12345678.js"></script>',
    );
    await writeFile(join(distDir, "assets", "charts-12345678.js"), "export const chart = true;");
    await writeFile(join(distDir, "assets", "index-12345678.js"), "import './charts-12345678.js';");
    await writeFile(join(distDir, "assets", "index-12345678.css"), "body{color:black}");

    const report = await analyzeBuild({ distDir });
    assert.deepEqual(
      report.initial.map((asset) => [asset.file, asset.kind]).sort(),
      [
        ["index-12345678.css", "css"],
        ["index-12345678.js", "javascript"],
        ["charts-12345678.js", "javascript"],
      ].sort(),
    );
    assert.equal(report.allJavaScript.length, 2);
    const budgets = fixtureBudgets();
    budgets.pageBudgets = [];
    const result = evaluateBudgets(report, budgets);
    assert.match(result.failures.join("\n"), /charts.+global boot graph/);
  } finally {
    await rm(distDir, { recursive: true, force: true });
  }
});

test("worker-only UI remains lazy and Vite 8 uses native code splitting", async () => {
  const [router, workerSession, viteConfig] = await Promise.all([
    readFile(new URL("../src/router.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/worker-session.ts", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
  ]);
  assert.match(router, /const WorkerLayout = lazy\(\(\) => import\('\.\/layouts\/WorkerLayout'\)\)/);
  assert.doesNotMatch(router, /import WorkerLayout from/);
  assert.doesNotMatch(workerSession, /from\s+["'][^"']*(?:WorkerLayout|react|lucide-react)/i);
  assert.match(viteConfig, /rolldownOptions:\s*\{/);
  assert.match(viteConfig, /codeSplitting:\s*\{/);
  assert.doesNotMatch(viteConfig, /\bmanualChunks\s*:/);
});
