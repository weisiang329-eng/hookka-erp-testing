// ---------------------------------------------------------------------------
// crm-followups.test.mjs — pins the "follow-ups due" surfacing on the pipeline
// (owner 2026-07-30: who to contact now). Reuses the /follow-ups endpoint built
// in slice 1. Structural pin; live UX verified on staging.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../src/pages/leads/index.tsx", import.meta.url), "utf8");

test("pipeline surfaces due follow-ups from the customer activity timelines", () => {
  assert.match(page, /\/api\/customer-crm\/follow-ups/, "must read the follow-ups endpoint");
  assert.match(page, /follow-up.{0,4} due/i, "must show a 'follow-ups due' strip");
  assert.match(page, /getFollowUps/, "must fetch follow-ups alongside leads");
});
