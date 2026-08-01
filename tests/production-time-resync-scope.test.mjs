// Lock test for â‘£ â€” "change Production Times â†’ apply to in-progress orders".
//
// Guards two invariants:
//   1. The /api/bom/resync-job-card-times endpoint, BY DEFAULT, only touches
//      job cards that are NOT yet COMPLETED/TRANSFERRED â€” so a Production Times
//      change never rewrites the historical time of finished work. An
//      ?includeCompleted=true escape hatch must still exist for a deliberate
//      full backfill. The filter must apply to BOTH the dry-run and the
//      cursored real-run SELECT.
//   2. The BOM Production Times dialog auto-runs the resync after a successful
//      save (so the change takes effect on in-progress orders with no extra
//      click â€” the owner's "ä¸€æ”¹å°±ç”Ÿæ•ˆ").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const bomRoute = readFileSync("src/api/routes/bom.ts", "utf8");
const bomPage = readFileSync("src/pages/bom.tsx", "utf8");

test("resync defaults to incomplete-only (skips COMPLETED/TRANSFERRED)", () => {
  assert.match(
    bomRoute,
    /STATUS_FILTER\s*=\s*"jc\.status NOT IN \('COMPLETED','TRANSFERRED'\)"/,
    "the done-state status filter literal must be defined",
  );
  assert.match(
    bomRoute,
    /const includeCompleted = c\.req\.query\("includeCompleted"\) === "true"/,
    "includeCompleted escape hatch must exist (default off â†’ incomplete-only)",
  );
});

test("the status filter is wired into BOTH the dry-run and real-run SELECT", () => {
  // dry-run path: conditional WHERE using STATUS_FILTER
  assert.match(
    bomRoute,
    /includeCompleted \? "" : `WHERE \$\{STATUS_FILTER\}`/,
    "dry-run SELECT must gate the status filter on includeCompleted",
  );
  // real-run path: pushed into the combined WHERE conditions
  assert.match(
    bomRoute,
    /if \(!includeCompleted\) conds\.push\(STATUS_FILTER\)/,
    "real-run SELECT must add the status filter to its WHERE conds",
  );
});

test("the retired Production Times dialog stays retired", () => {
  // Not a behaviour test - a guard against silently resurrecting the dialog
  // without also restoring the resync it used to fire. If someone re-adds the
  // editor, this fails and forces the resync question to be answered again.
  assert.ok(
    !/function ProductionTimesDialog\(/.test(bomPage),
    "the inline Production Times dialog was retired - re-adding it must also restore runProductionTimeResync()",
  );
  // The matrix is still READ for BOM minute auto-fill; only the writer is gone.
  assert.match(bomPage, /cfg\?\.productionTimes\?\.\[deptCode\]/);
  // The endpoint itself is untouched by the UI change.
  assert.match(bomRoute, /resync-job-card-times/);
});
