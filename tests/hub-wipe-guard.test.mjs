// ---------------------------------------------------------------------------
// hub-wipe-guard.test.mjs — structural pins for BUG-2026-07-27-002.
//
// Three coupled defects let the SO-2607-19x Houzs batch ship hub-less with
// State = raw PDF text ("Selangor"):
//   1. customers.ts PUT replace-diff DELETED every hub missing from the
//      incoming array — any save from a stale tab/cached page silently wiped
//      hubs added elsewhere (the owner's new hub kept vanishing).
//   2. The scan-PO create loop proceeded silently when no hub matched.
//   3. The hub forms had no Selangor option at all (canonical code SGR).
// These tests pin the fixes so a refactor can't quietly reintroduce any.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync(
  new URL("../src/api/routes/customers.ts", import.meta.url),
  "utf8",
);
const page = readFileSync(
  new URL("../src/pages/customers.tsx", import.meta.url),
  "utf8",
);
const modal = readFileSync(
  new URL("../src/components/scan-po-modal.tsx", import.meta.url),
  "utf8",
);

test("customers.ts: hub deletions are explicit-only (no replace-diff wipe)", () => {
  assert.doesNotMatch(
    route,
    /incomingIds\.has\(oldId\)/,
    "the blanket diff-delete must stay gone",
  );
  assert.match(route, /deletedHubIds/, "explicit deletedHubIds contract must exist");
  assert.match(
    route,
    /DELETE FROM delivery_hubs WHERE id = \? AND customerId = \?/,
    "deletes must be scoped to the named hub AND the customer",
  );
  // New hubs inherit the customer's org (org-scoped readers must see them).
  assert.match(
    route,
    /email, isDefault, orgId\)/,
    "hub INSERT must carry orgId",
  );
});

test("customers.tsx: delete names the hub id; SGR selectable in both hub forms", () => {
  assert.match(
    page,
    /deletedHubIds: \[hub\.id\]/,
    "the delete button must send the explicit id",
  );
  assert.match(page, /"KL","SGR","PG"/, "edit-form state list must include SGR");
  assert.match(
    page,
    /<option value="SGR">SGR<\/option>/,
    "add-form state dropdown must include SGR",
  );
});

test("scan-po-modal.tsx: hub-less create requires explicit operator confirm", () => {
  assert.match(modal, /matched NO delivery hub/, "hub-less gate message must exist");
  assert.match(
    modal,
    /Create WITHOUT hub anyway\?/,
    "the gate must ask before creating hub-less SOs",
  );
  // The gate must sit BEFORE the creating state flips on.
  const gateIdx = modal.indexOf("matched NO delivery hub");
  const creatingIdx = modal.indexOf("setCreating(true)");
  assert.ok(
    gateIdx > -1 && creatingIdx > -1 && gateIdx < creatingIdx,
    "gate must run before setCreating(true)",
  );
});
