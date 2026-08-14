// ---------------------------------------------------------------------------
// reports-brief-json-removed.test.mjs — BUG-2026-08-13-143.
//
// `GET /api/reports/brief.json` had no caller. It was built for a Command
// Center card that was deleted on 2026-08-05, and it kept a snapshot table hot
// (`warmBriefReport`, on the warm-lists cron) for a reader that no longer
// existed. Dead surface on an authenticated API is not free: it is a route
// somebody has to reason about, a cache key somebody has to keep warm, and — as
// the audit that found it shows — a thing that gets confused with a live one.
//
// THE TRAP THIS FILE EXISTS TO PREVENT is that confusion, in both directions:
//
//   * `/api/delivery-agent/brief.json` is a DIFFERENT, LIVE endpoint on a
//     different router, fetched by `src/pages/delivery/agent-tab.tsx`. A
//     careless grep for "brief.json" hits it. It must not be removed.
//   * `GET /api/reports/brief` — the HTML one — is LIVE and load-bearing: it is
//     emailed at 07:00 MYT by .github/workflows/daily-reports.yml via
//     brief-trigger, and people open it in a tab to read and print. An earlier
//     audit wrote it off as "a cron nobody waits on" off the strength of a code
//     comment; it was in fact the worst user-facing wait in the app
//     (docs/context-packs/HOOKKA-GOTCHAS.md).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const read = (rel) =>
  readFileSync(join(root, rel), "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");

const REPORTS = "src/api/routes/reports.ts";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

test("the dead JSON brief and its warmer are gone", () => {
  const src = read(REPORTS);
  assert.ok(
    !/app\.get\("\/brief\.json"/.test(src),
    "GET /api/reports/brief.json is back and still has no page consumer",
  );
  assert.ok(
    !/buildBriefJsonCached/.test(src),
    "its snapshot wrapper became dead with it — nothing else called it",
  );
  assert.ok(
    !/export async function warmBriefReport/.test(src),
    "and its cron warmer, which kept the `<date>` cache key hot for a reader " +
      "that no longer exists",
  );
  assert.ok(
    !/warmBriefReport/.test(read("src/api/worker.ts")),
    "the warm-lists cron must not call a warmer that is gone",
  );
});

test("the HTML brief — emailed at 07:00 MYT — is untouched", () => {
  const src = read(REPORTS);
  assert.ok(
    /app\.get\("\/brief",/.test(src),
    "GET /api/reports/brief is LIVE: people open it in a tab, and the daily " +
      "cron emails it. Deleting it is a different change entirely",
  );
  assert.ok(
    /buildBriefHtmlCached/.test(src),
    "and it keeps its own `<date>|html` snapshot key",
  );
  assert.ok(
    /app\.post\("\/brief\/send"/.test(src) &&
      /dispatchReport\(c, "brief"\)/.test(src),
    "the manual send-now and the cron dispatch both stay",
  );
  // The workflow builds its URL as `${kind}-trigger`, so "brief-trigger" never
  // appears literally — asserting on that string is how this guard would pass
  // over a workflow that had stopped firing.
  const wf = read(".github/workflows/daily-reports.yml");
  assert.ok(
    /kinds=brief\b/.test(wf) &&
      /\/api\/internal\/reports\/\$\{kind\}-trigger/.test(wf),
    "the workflow still schedules the brief and posts it to " +
      "/api/internal/reports/<kind>-trigger — if this ever stops being true, " +
      "the HTML brief's liveness argument changes and so does this test",
  );
  assert.ok(
    /internal\.post\("\/brief-trigger"/.test(src),
    "…and the endpoint it posts to must exist",
  );
});

test("the delivery-agent brief.json — a different endpoint — is untouched", () => {
  const agent = read("src/api/routes/delivery-agent.ts");
  assert.ok(
    /app\.get\("\/brief\.json"/.test(agent),
    "GET /api/delivery-agent/brief.json is live and fetched by the Delivery " +
      "agent tab. It shares only a filename with the endpoint removed here",
  );
  assert.ok(
    /\/api\/delivery-agent\/brief\.json/.test(read("src/pages/delivery/agent-tab.tsx")),
    "…by this exact caller",
  );
});

test("nothing in the app fetches /api/reports/brief.json", () => {
  const offenders = [];
  for (const file of walk(join(root, "src"))) {
    const src = readFileSync(file, "utf8");
    if (/["'`]\/api\/reports\/brief\.json/.test(src)) {
      offenders.push(relative(root, file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a caller appeared for a route that no longer exists: " + offenders.join(", "),
  );
});
