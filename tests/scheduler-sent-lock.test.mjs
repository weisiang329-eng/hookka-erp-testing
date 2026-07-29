// ---------------------------------------------------------------------------
// scheduler-sent-lock.test.mjs — the planning engine must NEVER change the due
// date of a job card already SENT to the floor (owner 2026-07-29:「sent 的不要
// 随意换 due date」). "Sent" = job_cards.distributedAt set. A generation-time
// guard existed, but BOTH due-date write paths (auto-approve drain + manual
// approve) only checked status='WAITING' — a proposal made while un-sent could
// still apply after the card was ticked Sent. This pins the guard on both
// writes. Structural pins (source assertions, the repo idiom).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const lib = readFileSync(
  new URL("../src/api/lib/schedule-proposals.ts", import.meta.url),
  "utf8",
);
const route = readFileSync(
  new URL("../src/api/routes/schedule-proposals.ts", import.meta.url),
  "utf8",
);

const GUARD = /AND \(distributedAt IS NULL OR distributedAt = ''\)/;

test("auto-approve drain (applyPendingProposals) locks Sent cards", () => {
  // The bulk UPDATE job_cards ... dueDate = CASE ... must carry the Sent guard.
  const anchor = lib.indexOf("dueDate = CASE id");
  assert.ok(anchor > -1, "auto-approve bulk UPDATE must exist");
  const upd = lib.slice(anchor, anchor + 220);
  assert.match(upd, /status = 'WAITING'/, "still only touches WAITING cards");
  assert.match(upd, GUARD, "auto-approve UPDATE must exclude Sent (distributedAt) cards");
});

test("manual approve (POST /proposals/approve) locks Sent cards", () => {
  const upd = route.slice(route.indexOf("UPDATE job_cards SET dueDate = ?"), route.indexOf("UPDATE job_cards SET dueDate = ?") + 220);
  assert.match(upd, /status = 'WAITING'/, "still only touches WAITING cards");
  assert.match(upd, GUARD, "manual approve UPDATE must exclude Sent (distributedAt) cards");
});
