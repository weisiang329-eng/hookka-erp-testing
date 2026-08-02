// ---------------------------------------------------------------------------
// ci-failing-workflows.test.mjs — a workflow that has been failing for weeks
// must be impossible to miss.
//
// The daily Postgres backup failed 20 times in a row — EVERY run in its visible
// history — and nobody noticed, because there were no automated backups at all
// and the only place that would have shown it could not.
//
// /admin/health lists the latest ~20 runs. Hookka runs Keep-DB-warm, the scan
// sweep, mail sync, the audit-DLQ replay and the agent heartbeat on tight
// schedules, so a once-a-day job's failure is pushed out of that window within
// MINUTES. The panel was green while the backups were gone.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync("src/api/routes/admin-health.ts", "utf8");
const page = readFileSync("src/pages/admin/health.tsx", "utf8");
const deploy = readFileSync(".github/workflows/deploy.yml", "utf8");

test("failures are queried directly, not scavenged from the recent list", () => {
  assert.match(
    route,
    /actions\/runs\?status=failure&per_page=50/,
    "a failures-only query is the only way a daily job survives the 5-minute crons",
  );
  assert.match(route, /consecutive/, "one failure this morning != failing for weeks");
});

test("a workflow that has since gone green is not reported as failing", () => {
  // Otherwise the banner stays red forever and gets ignored, which is the same
  // failure mode by a different route.
  assert.match(route, /latestByName\.get\(w\.name\) \?\? "failure"\) === "failure"/);
});

test("the failures-only call can never break the main panel", () => {
  const block = route.slice(route.indexOf("let failing: FailingWorkflow[] = []"));
  assert.match(block.slice(0, 2200), /\} catch \{/, "must be best-effort");
});

test("the health page shows it, with how long it has been failing", () => {
  assert.match(page, /failing\?\.length \?\? 0\) > 0/);
  assert.match(page, /consecutive failure/);
  assert.match(page, /oldest seen/);
});

test("a manual re-run actually deploys", () => {
  // It was `push` only, so a manual dispatch built, tested, then SKIPPED the
  // deploy — which is how a staging merge that produced no push run at all left
  // staging undeployed with no way to kick it but an empty commit.
  assert.match(
    deploy,
    /if: github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'/,
  );
});
