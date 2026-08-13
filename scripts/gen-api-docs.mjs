#!/usr/bin/env node
// ---------------------------------------------------------------------------
// gen-api-docs.mjs — regenerate docs/API.md from the source of truth.
//
// Why this exists: docs/API.md was hand-written in April 2026, documented 4
// endpoints out of 136 route files, and named three files that do not exist
// (`src/api/index.ts`, `routes/portal.ts`, `routes/dev.ts`). A hand-written
// API reference in a repo shipping ~1,300 commits/month is guaranteed to lie.
// This script derives the reference mechanically instead.
//
// What it reads:
//   src/api/worker.ts     — `import <ident> from "./routes/<file>"` +
//                           `app.route("<prefix>", <ident>)`  → the mount table
//   src/api/routes/*.ts   — top-level `app.<method>("<path>", …)` → handlers
//
// What it cannot see (stated as such in the generated doc rather than guessed):
//   - handlers registered inside helper functions or sub-routers mounted with
//     a computed prefix
//   - request/response body shapes (no schema layer covers every route)
//
// Usage:  node scripts/gen-api-docs.mjs          # writes docs/API.md
//         node scripts/gen-api-docs.mjs --check  # exit 1 if API.md is stale
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = join(ROOT, "src/api/worker.ts");
const ROUTES_DIR = join(ROOT, "src/api/routes");
const OUT = join(ROOT, "docs/API.md");

const worker = readFileSync(WORKER, "utf8");

// ident -> route file (relative to src/api/routes). Handles both the default
// form (`import x from "./routes/x"`) and the named form
// (`import { a, b as c } from "./routes/x"`), which announcements uses.
// Value is { file, exportName } where exportName is "default" for a default import.
const imports = new Map();
for (const m of worker.matchAll(/^import\s+([^;]+?)\s+from\s+"\.\/routes\/([^"]+)"/gm)) {
  const clause = m[1].trim();
  const file = m[2];
  const named = clause.match(/\{([^}]*)\}/);
  if (named) {
    for (const part of named[1].split(",")) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if (orig) imports.set((alias ?? orig).trim(), { file, exportName: orig.trim() });
    }
  }
  const def = clause.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim();
  if (def) imports.set(def, { file, exportName: "default" });
}

// mounts in source order: [prefix, ident]
const mounts = [];
for (const m of worker.matchAll(/^app\.route\(\s*"([^"]+)"\s*,\s*(\w+)\s*\)/gm)) {
  const imp = imports.get(m[2]) ?? null;
  mounts.push({ prefix: m[1], ident: m[2], file: imp?.file ?? null, exportName: imp?.exportName ?? null });
}

function resolveRouteFile(rel) {
  if (!rel) return null;
  for (const cand of [`${rel}.ts`, join(rel, "index.ts")]) {
    const p = join(ROUTES_DIR, cand);
    if (existsSync(p)) return p;
  }
  return null;
}

// Resolve the export name a mount uses back to the local `const <x> = new Hono()`
// binding inside the route file, so multi-router files (announcements exports
// `admin` and `worker`; delivery-agent and reports export an extra `internal`)
// report each router's own paths instead of nothing.
function localBindingFor(src, exportName) {
  if (!exportName || exportName === "default") {
    const d = src.match(/^export\s+default\s+(\w+)\s*;/m);
    return d ? d[1] : "app";
  }
  // `export const internal = ...`
  if (new RegExp(`^export\\s+const\\s+${exportName}\\b`, "m").test(src)) return exportName;
  // `export { admin as announcementsAdmin, worker as announcementsWorker }`
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if ((alias ?? orig)?.trim() === exportName) return orig.trim();
    }
  }
  return exportName;
}

// Top-level handler registrations for one router binding in a route file.
function handlersOf(file, exportName) {
  if (!file) return [];
  const src = readFileSync(file, "utf8");
  const binding = localBindingFor(src, exportName);
  const out = [];
  const re = new RegExp(`^${binding}\\.(get|post|put|patch|delete|all)\\(\\s*"([^"]*)"`, "gm");
  for (const m of src.matchAll(re)) {
    // 1-based line of the registration, so a reader can Read at the offset.
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ method: m[1].toUpperCase(), path: m[2], line });
  }
  return out;
}

// Auth tier. Two independent ways a mount escapes the gate:
//   (a) it is mounted BEFORE `app.use("/api/*", authMiddleware)` (order wins in Hono)
//   (b) authMiddleware itself allow-lists it in PUBLIC_PATHS / PUBLIC_PREFIXES
const authLine = worker.split("\n").findIndex((l) => /^app\.use\("\/api\/\*",\s*authMiddleware\)/.test(l));

const authMw = readFileSync(join(ROOT, "src/api/lib/auth-middleware.ts"), "utf8");
function stringList(name) {
  const m = authMw.match(new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\n\\];`));
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
}
const PUBLIC_PATHS = stringList("PUBLIC_PATHS");
const PUBLIC_PREFIXES = stringList("PUBLIC_PREFIXES");
// Regex allow-lists in isPublicPath() that open individual paths under an
// otherwise-gated mount. Derived from the regex literals so the doc cannot
// drift from the middleware.
const PUBLIC_REGEXES = [...authMw.matchAll(/_RE\s*=\s*\n?\s*\/\^([^;]+?)\/;/g)].map((m) =>
  m[1].replace(/\\\//g, "/").replace(/\[\^\/\]\+/g, ":id").replace(/\$$/, ""),
);
const PUBLIC_REGEX_MOUNTS = new Set(
  PUBLIC_REGEXES.map((r) => "/" + r.split("/").filter(Boolean).slice(0, 2).join("/")),
);
function authTier(prefix, mountedBeforeGate) {
  if (mountedBeforeGate) return "**public** (mounted before the gate)";
  // Compare with the trailing slash intact, or `/api/workers` falsely matches
  // the `/api/worker/` prefix.
  if (PUBLIC_PREFIXES.some((p) => (prefix + "/").startsWith(p))) return "**public** (PUBLIC_PREFIXES)";
  if (PUBLIC_REGEX_MOUNTS.has(prefix)) return "gated (some paths public)";
  if (PUBLIC_PATHS.some((p) => p.startsWith(prefix + "/") || p === prefix)) return "gated (some paths public)";
  return "gated";
}
const mountLineOf = new Map();
worker.split("\n").forEach((l, i) => {
  const m = l.match(/^app\.route\(\s*"([^"]+)"\s*,\s*(\w+)\s*\)/);
  if (m) mountLineOf.set(`${m[1]}|${m[2]}`, i);
});

const rows = mounts.map((mt) => {
  const file = resolveRouteFile(mt.file);
  const handlers = handlersOf(file, mt.exportName);
  const line = mountLineOf.get(`${mt.prefix}|${mt.ident}`) ?? Infinity;
  return {
    ...mt,
    fileRel: file ? file.slice(ROOT.length + 1).replaceAll("\\", "/") : null,
    handlers,
    auth: authTier(mt.prefix, authLine >= 0 && line < authLine),
  };
});

const routeFiles = readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"));
const mounted = new Set(rows.map((r) => r.fileRel).filter(Boolean));
const unmounted = routeFiles
  .map((f) => `src/api/routes/${f}`)
  .filter((f) => !mounted.has(f));

const totalHandlers = rows.reduce((n, r) => n + r.handlers.length, 0);
const stamp = new Date().toISOString().slice(0, 10);

let md = `# API — generated reference

> **GENERATED FILE — do not hand-edit.** Regenerate with \`node scripts/gen-api-docs.mjs\`.
> **Last generated: ${stamp}** from \`src/api/worker.ts\` + \`src/api/routes/*.ts\`.

The backend is a single [Hono](https://hono.dev) app in \`src/api/worker.ts\`, served
as a Cloudflare Pages Function via \`functions/api/[[route]].ts\`. There is no
\`src/api/index.ts\` and no standalone Node API server.

- **Data source** — Supabase Postgres, reached through a Cloudflare Hyperdrive
  binding. Routes call \`c.var.DB\`, a \`SupabaseAdapter\` that presents the
  SQLite-flavoured \`prepare/bind/all\` interface over Postgres
  (\`src/api/lib/db-pg.ts\`, \`src/api/lib/supabase-compat.ts\`). The D1 binding was
  retired 2026-04-27 — see \`docs/archive/d1-retirement-plan.md\`.
- **Auth** — \`app.use("/api/*", authMiddleware)\` gates the API
  (\`src/api/lib/auth-middleware.ts\`). A mount escapes the gate two ways: it is
  mounted *before* that line (Hono applies middleware in registration order), or
  the middleware allow-lists it in \`PUBLIC_PATHS\` / \`PUBLIC_PREFIXES\`. The Auth
  column below reports which. Downstream of auth: \`customerScopeMiddleware\`,
  \`tenantMiddleware\`, \`apiRateLimit\`. Route-level permissions come from
  \`src/api/lib/rbac.ts\` / \`role-policy.ts\` and are **not** shown here — a mount
  marked "gated" still enforces its own permission checks.
- **Public surface at generation time** — PUBLIC_PATHS: ${PUBLIC_PATHS.map((p) => `\`${p}\``).join(", ")}.
  PUBLIC_PREFIXES: ${PUBLIC_PREFIXES.map((p) => `\`${p}\``).join(", ")}.
  Plus these individual paths, opened by regex allow-lists in \`isPublicPath()\`
  (each handler re-checks a worker token / dept restriction itself):
  ${PUBLIC_REGEXES.map((p) => `\`${p}\``).join(", ")}.
- **CSRF** — the browser side is automatic: \`src/lib/api-client.ts\` patches
  \`window.fetch\` to attach \`X-CSRF-Token\` to every mutating \`/api/*\` call.
- **Health** — \`GET /api/health\` is registered directly on the app (not via a
  route module) and is exempt from the rate limiter.

**Counts at generation time:** ${rows.length} mounts, ${routeFiles.length} route files in
\`src/api/routes/\`, ${totalHandlers} top-level handler registrations discovered.

## Scope and limits of this file

This reference is derived by static scan. It lists **where each router is mounted
and which paths it registers at the top level**. It deliberately does *not*
document request/response bodies: there is no single schema layer covering every
route, so any body shape written here would be a guess. For the contract of a
specific endpoint, open the handler — the file:line is one \`Read\` away from the
table below.

Handlers registered inside helper functions, or on sub-routers mounted with a
computed prefix, will not appear. Where a mount shows no paths, read the file.

---

## Mount table

The small number after each path is the **line in that route file where the handler is
registered**, so you can Read straight at the offset. It is regenerated with the file,
which is the whole point — the hand-maintained predecessor of this table
(\`docs/SYMBOLS.md\`, deleted 2026-08-13) had drifted to 25% accuracy, with 94 of its 891
offsets pointing past the end of their own file.

| Mount prefix | Route file | Paths registered (with :line) | Auth |
|---|---|---|---|
`;

for (const r of rows) {
  const paths = r.handlers.length
    ? r.handlers.map((h) => `\`${h.method} ${h.path}\` <sub>:${h.line}</sub>`).join("<br>")
    : "_(none found by static scan — read the file)_";
  md += `| \`${r.prefix}\` | \`${r.fileRel ?? "?"}\` | ${paths} | ${r.auth} |\n`;
}

md += `
---

## Route files present but not mounted in \`worker.ts\`

These are imported elsewhere, mounted conditionally, or dead. ${unmounted.length} file(s):

${unmounted.length ? unmounted.map((f) => `- \`${f}\``).join("\n") : "_(none)_"}

---

## Conventions that are actually enforced

- **Money is integer sen** (RM × 100). Never floats. See \`roundSen\` in
  \`src/lib/utils.ts\` and \`src/components/ui/money-input.tsx\`.
- **New DB columns are snake_case.** A camelCase column named in route SQL needs
  an entry in \`src/api/lib/column-rename-map.json\` or the request 400s. Read rows
  dual-keyed: \`r.camelCase ?? r.snake_case\`.
- **Migrations do not auto-apply on deploy.** A new column reaches production only
  via runtime self-apply (\`ALTER TABLE … ADD COLUMN IF NOT EXISTS\`, awaited before
  the first write). See \`src/api/lib/self-apply.ts\`.
- **Validation** is per-route. Shared Zod schemas live in \`src/lib/validation.ts\`
  and \`src/lib/schemas/\`; many routes still do ad-hoc checks.

## Regenerating

\`\`\`bash
node scripts/gen-api-docs.mjs          # rewrite docs/API.md
node scripts/gen-api-docs.mjs --check  # non-zero exit if API.md is out of date
\`\`\`
`;

if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  // Ignore the generation date when comparing.
  const strip = (s) => s.replace(/\*\*Last generated: \d{4}-\d{2}-\d{2}\*\*/, "");
  if (strip(current) !== strip(md)) {
    console.error("docs/API.md is stale — run: node scripts/gen-api-docs.mjs");
    process.exit(1);
  }
  console.log("docs/API.md is up to date.");
} else {
  writeFileSync(OUT, md);
  console.log(
    `Wrote docs/API.md — ${rows.length} mounts, ${totalHandlers} handlers, ${unmounted.length} unmounted route files.`,
  );
}
