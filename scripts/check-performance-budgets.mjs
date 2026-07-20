#!/usr/bin/env node
import { gzipSync } from "node:zlib";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_DIST_DIR = join(REPO_ROOT, "dist");
const DEFAULT_BUDGET_PATH = join(REPO_ROOT, "config", "performance-budgets.json");

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2] ?? null;
}

function localAssetPath(distDir, publicPath) {
  if (!publicPath || /^(?:[a-z]+:)?\/\//i.test(publicPath)) return null;
  const cleanPath = decodeURIComponent(publicPath.split(/[?#]/, 1)[0]).replace(/^\/+/, "");
  const fullPath = resolve(distDir, cleanPath);
  const rel = relative(resolve(distDir), fullPath);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === "..") {
    throw new Error(`asset path escapes dist: ${publicPath}`);
  }
  return fullPath;
}

function publicAssetKey(publicPath) {
  if (!publicPath || /^(?:[a-z]+:)?\/\//i.test(publicPath)) return null;
  const cleanPath = decodeURIComponent(publicPath.split(/[?#]/, 1)[0]).replace(/^\/+/, "");
  return `/${cleanPath.replaceAll("\\", "/")}`;
}

function staticImportSpecifiers(source) {
  const specifiers = [];
  const pattern = /\b(?:import\s*(?:[^"'()]*?\bfrom\s*)?|export\s+[^"'()]*?\bfrom\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  return specifiers;
}

async function assetRecord(distDir, publicPath, kind) {
  const fullPath = localAssetPath(distDir, publicPath);
  if (!fullPath) return null;
  const bytes = await readFile(fullPath);
  return {
    path: publicPath,
    file: basename(fullPath),
    kind,
    bytes: bytes.byteLength,
    gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
  };
}

function uniqueByPath(records) {
  return [...new Map(records.map((record) => [record.path, record])).values()];
}

export async function analyzeBuild({ distDir = DEFAULT_DIST_DIR } = {}) {
  const html = await readFile(join(distDir, "index.html"), "utf8");
  const tags = html.match(/<(?:link|script)\b[^>]*>/gi) ?? [];
  const initial = [];

  const assetsDir = join(distDir, "assets");
  const allJavaScript = [];
  const javaScriptByPath = new Map();
  const staticImportsByPath = new Map();
  for (const file of await readdir(assetsDir)) {
    if (!file.endsWith(".js")) continue;
    const fullPath = join(assetsDir, file);
    if (!(await stat(fullPath)).isFile()) continue;
    const bytes = await readFile(fullPath);
    const publicPath = `/assets/${file}`;
    const record = {
      path: publicPath,
      file,
      kind: "javascript",
      bytes: bytes.byteLength,
      gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
    };
    allJavaScript.push(record);
    javaScriptByPath.set(publicPath, record);
    staticImportsByPath.set(publicPath, staticImportSpecifiers(bytes.toString("utf8")));
  }

  const addJavaScriptRoot = (publicPath) => {
    const key = publicAssetKey(publicPath);
    if (!key) return;
    const record = javaScriptByPath.get(key);
    if (!record) throw new Error(`JavaScript referenced by index.html is missing: ${publicPath}`);
    initial.push(record);
  };

  for (const tag of tags) {
    const tagName = tag.match(/^<([a-z]+)/i)?.[1]?.toLowerCase();
    if (tagName === "link") {
      const rel = (attribute(tag, "rel") ?? "").toLowerCase().split(/\s+/);
      if (rel.includes("modulepreload")) {
        addJavaScriptRoot(attribute(tag, "href"));
      } else if (rel.includes("stylesheet")) {
        const record = await assetRecord(distDir, attribute(tag, "href"), "css");
        if (record) initial.push(record);
      }
    } else if (tagName === "script" && attribute(tag, "type")?.toLowerCase() === "module") {
      addJavaScriptRoot(attribute(tag, "src"));
    }
  }

  // Modulepreload tags are hints, not the complete boot graph. Follow every
  // static import from the entry roots so a hidden `import "./charts.js"`
  // cannot pass merely because its preload tag was filtered out. Dynamic
  // import() expressions are intentionally excluded: they are page/interaction
  // work and are covered by the separate profile budgets below.
  const queue = uniqueByPath(initial.filter((asset) => asset.kind === "javascript"));
  const seenJavaScript = new Set(queue.map((asset) => asset.path));
  for (let index = 0; index < queue.length; index += 1) {
    const importer = queue[index];
    for (const specifier of staticImportsByPath.get(importer.path) ?? []) {
      const dependencyPath = new URL(specifier, `https://hookka.invalid${importer.path}`).pathname;
      const dependency = javaScriptByPath.get(dependencyPath);
      if (!dependency || seenJavaScript.has(dependency.path)) continue;
      seenJavaScript.add(dependency.path);
      queue.push(dependency);
      initial.push(dependency);
    }
  }

  return { initial: uniqueByPath(initial), allJavaScript };
}

function matchesStem(file, stem) {
  return file === `${stem}.js` || (file.startsWith(`${stem}-`) && file.endsWith(".js"));
}

function sum(records, field) {
  return records.reduce((total, record) => total + record[field], 0);
}

function formatKiB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function evaluateBudgets(report, budgets) {
  const failures = [];
  const bootJs = report.initial.filter((asset) => asset.kind === "javascript");
  const bootCss = report.initial.filter((asset) => asset.kind === "css");
  const bootJsGzipBytes = sum(bootJs, "gzipBytes");
  const bootCssGzipBytes = sum(bootCss, "gzipBytes");

  if (bootJsGzipBytes > budgets.boot.maxJavaScriptGzipBytes) {
    failures.push(`boot JavaScript is ${formatKiB(bootJsGzipBytes)}; budget is ${formatKiB(budgets.boot.maxJavaScriptGzipBytes)}`);
  }
  if (bootCssGzipBytes > budgets.boot.maxCssGzipBytes) {
    failures.push(`boot CSS is ${formatKiB(bootCssGzipBytes)}; budget is ${formatKiB(budgets.boot.maxCssGzipBytes)}`);
  }
  if (bootJs.length > budgets.boot.maxJavaScriptRequests) {
    failures.push(`boot JavaScript uses ${bootJs.length} requests; budget is ${budgets.boot.maxJavaScriptRequests}`);
  }
  if (bootCss.length > budgets.boot.maxCssRequests) {
    failures.push(`boot CSS uses ${bootCss.length} requests; budget is ${budgets.boot.maxCssRequests}`);
  }

  for (const stem of budgets.boot.forbiddenInitialStems) {
    const matches = bootJs.filter((asset) => matchesStem(asset.file, stem));
    if (matches.length > 0) {
      failures.push(`${stem} is interaction/page-specific but appears in the global boot graph: ${matches.map((asset) => asset.file).join(", ")}`);
    }
  }

  const profileResults = [];
  for (const profile of [...budgets.pageBudgets, ...budgets.deferredBudgets]) {
    for (const stem of profile.stems) {
      const assets = report.allJavaScript.filter((asset) => matchesStem(asset.file, stem));
      const gzipBytes = sum(assets, "gzipBytes");
      profileResults.push({ profile: profile.name, stem, gzipBytes, assets });
      if (assets.length === 0) {
        failures.push(`${profile.name}/${stem} has no matching build asset; the budget may be stale`);
      } else if (gzipBytes > profile.maxEachGzipBytes) {
        failures.push(`${profile.name}/${stem} is ${formatKiB(gzipBytes)} gzip; budget is ${formatKiB(profile.maxEachGzipBytes)}`);
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    boot: {
      javascriptGzipBytes: bootJsGzipBytes,
      cssGzipBytes: bootCssGzipBytes,
      javascriptRequests: bootJs.length,
      cssRequests: bootCss.length,
      assets: report.initial,
    },
    profiles: profileResults,
  };
}

export async function run({ distDir = DEFAULT_DIST_DIR, budgetPath = DEFAULT_BUDGET_PATH } = {}) {
  const budgets = JSON.parse(await readFile(budgetPath, "utf8"));
  const report = await analyzeBuild({ distDir });
  const result = evaluateBudgets(report, budgets);

  console.log(`[performance-budget] boot JS: ${formatKiB(result.boot.javascriptGzipBytes)} gzip across ${result.boot.javascriptRequests} request(s)`);
  console.log(`[performance-budget] boot CSS: ${formatKiB(result.boot.cssGzipBytes)} gzip across ${result.boot.cssRequests} request(s)`);
  for (const item of result.profiles) {
    console.log(`[performance-budget] ${item.profile}/${item.stem}: ${formatKiB(item.gzipBytes)} gzip`);
  }

  if (!result.ok) {
    console.error(`[performance-budget] FAIL (${result.failures.length}):`);
    for (const failure of result.failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log("[performance-budget] OK — boot, page, and deferred-interaction budgets passed.");
  }
  return result;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  run().catch((error) => {
    console.error(`[performance-budget] ERROR: ${error.message}`);
    process.exitCode = 2;
  });
}
