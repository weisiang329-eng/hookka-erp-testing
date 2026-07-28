// ---------------------------------------------------------------------------
// hub-vanishes-guard.test.mjs — structural pins for the recurring
// "delivery hub disappears after save" bug (2026-07-28).
//
// Symptom seen many times on the Houzs Century batch: an OCR'd SO showed the
// correct hub at scan time, but after save `sales_orders.hub_id` was NULL while
// `customer_state` still held a raw value ("Selangor") — so goods shipped to the
// wrong (or no) address. Three independent defects, fixed together:
//
//   1. create.tsx dropped the operator's picked hub — `deliveryHubId` was held
//      in state but NEVER sent in the SO-create body, so every created SO lost
//      its hub and the create->confirm chain landed a hub-less order.
//   2. The POST create persisted a raw `body.customerState` fallback with no hub
//      behind it (state-without-hub orphan).
//   3. Nothing stopped a hub-less SO from being CONFIRMED (confirm fans out
//      production + delivery). Owner rule 2026-07-28: draft may be hub-less;
//      confirm may not (when the customer has hubs).
//
// Structural tests (source-text assertions), same style as
// service-hub-chain.test.mjs — they pin each fix so a refactor can't silently
// drop one.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const soSrc = readFileSync(
  new URL("../src/api/routes/sales-orders.ts", import.meta.url),
  "utf8",
);
const createSrc = readFileSync(
  new URL("../src/pages/sales/create.tsx", import.meta.url),
  "utf8",
);

test("fix 1 — create.tsx sends the picked deliveryHubId in the SO-create body", () => {
  // The hub the operator chose must reach the server. Pinned to the create
  // POST body (right before companySODate) so it can't be dropped again.
  assert.match(
    createSrc,
    /deliveryHubId,\s*\n\s*companySODate, customerDeliveryDate/,
    "SO-create body must include deliveryHubId",
  );
});

test("fix 2 — POST create derives customer_state ONLY from the resolved hub", () => {
  // The invariant: no hub => no state. state must never come from raw OCR/body
  // on its own (that was the orphan "Selangor with no hub").
  assert.match(
    soSrc,
    /const customerState = chosenHub\?\.state \?\? "";/,
    "customerState must be `chosenHub?.state ?? \"\"`",
  );
  // The old orphan fallback (state <- body.customerState with no hub) is gone.
  assert.doesNotMatch(
    soSrc,
    /const customerState =\s*\n\s*chosenHub\?\.state \?\?\s*\n\s*\(typeof body\.customerState/,
    "the raw body.customerState fallback for stored state must be removed",
  );
});

test("fix 3 — confirm is blocked when the SO has no hub but the customer has hubs", () => {
  // The safety net: confirming fans out POs/DOs, so a hub-less confirm ships
  // wrong. Draft stays exempt (guard lives in /:id/confirm only).
  assert.match(
    soSrc,
    /const hubMissing = !existing\.hubId \|\| String\(existing\.hubId\)\.trim\(\) === "";/,
    "confirm must compute hubMissing from existing.hubId",
  );
  // Only enforced when the customer actually HAS hubs (external customers exempt).
  assert.match(
    soSrc,
    /SELECT id FROM delivery_hubs WHERE customerId = \? LIMIT 1/,
    "confirm guard must check whether the customer has any hub",
  );
  assert.match(
    soSrc,
    /has no delivery hub\. Select a hub before confirming/,
    "confirm guard must return the no-hub error",
  );
});
