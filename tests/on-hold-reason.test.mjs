// ---------------------------------------------------------------------------
// on-hold-reason.test.mjs — ON HOLD reason capture (0185).
//
// When an operator puts a Sales Order (or Consignment Order) ON HOLD, a
// non-empty reason is REQUIRED. The reason + who + when is stored on the order
// row (hold_reason / held_by / held_at, snake_case, runtime-ALTERed) and flows
// to the production grid via the same SO/CO → production_orders link the status
// already uses, where it shows as a faint reason line + an ON HOLD chip tooltip.
//
// Source-level structural pins (no DB / no worker runtime), matching the house
// style of production-fresh-po-direct-db.test.mjs + repair-scope.test.mjs Part
// 2. These invariants are easy to silently regress in a future refactor, so we
// pin them in CI. The behavioral contract verified here:
//   (i)   PUT → ON_HOLD with a blank reason is rejected with a 400 (FE + BE).
//   (ii)  The SO/CO UPDATE writes hold_reason/held_by/held_at, and NULLs them
//         on a transition out of / not into hold.
//   (iii) The so_status_changes audit note carries the reason.
//   (iv)  The production-orders list join (attachCustomerSO) carries
//         holdReason/heldBy/heldAt onto each PO row.
//   (v)   The runtime ensure-migration block adds the 3 snake_case columns.
//   (vi)  The production grid renders the reason (faint line + chip tooltip),
//         on BOTH the dept grid and the ALL-tab overview.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Dynamic import() of an absolute path needs a file:// URL on Windows
// (a bare "C:\..." path throws ERR_UNSUPPORTED_ESM_URL_SCHEME).
const PROD_API_URL = pathToFileURL(
  resolve(process.cwd(), "src/api/routes/production-orders.ts"),
).href;

const SO = resolve(process.cwd(), "src/api/routes/sales-orders.ts");
const CO = resolve(process.cwd(), "src/api/routes/consignment-orders.ts");
const PROD_API = resolve(process.cwd(), "src/api/routes/production-orders.ts");
const SO_DETAIL = resolve(process.cwd(), "src/pages/sales/detail.tsx");
const CO_DETAIL = resolve(process.cwd(), "src/pages/consignment/detail.tsx");
const PROD_FE = resolve(process.cwd(), "src/pages/production/index.tsx");
const BASEROWS = resolve(process.cwd(), "src/pages/production/baserows-core.ts");
const PROD_TYPES = resolve(process.cwd(), "src/pages/production/types.ts");

// The sales-orders / production-orders / delivery-orders route files keep their
// module-level helpers in a sibling <route>/_helpers.ts (moved verbatim by a
// refactor). Source-grep guards must see BOTH the route file and its _helpers.ts,
// so read() concatenates them for those three routes only.
const SPLIT_ROUTE_RE =
  /src[\\/]api[\\/]routes[\\/](sales-orders|production-orders|delivery-orders)\.ts$/;

function read(p) {
  let src = readFileSync(p, "utf8");
  if (SPLIT_ROUTE_RE.test(p)) {
    src += "\n\n" + readFileSync(p.replace(/\.ts$/, "/_helpers.ts"), "utf8");
  }
  return src;
}

// Collapse whitespace so multi-line SQL / JSX still matches a single regex.
function flat(p) {
  return read(p).replace(/\s+/g, " ");
}

// ===========================================================================
// (v) Runtime self-apply — the 3 snake_case columns. A migration file alone is
//     inert on this deploy (deploy.yml does NOT replay them); the columns must
//     reach prod via the awaited ensure block.
// ===========================================================================

test("SO ensurePendingMigrations ALTERs in the 3 snake_case hold columns", () => {
  const f = read(SO);
  for (const col of ["hold_reason", "held_by", "held_at"]) {
    assert.match(
      f,
      new RegExp(
        `ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS ${col}\\b`,
      ),
      `sales_orders.${col} must be runtime-ALTERed (snake_case) — a migration file alone is inert on this deploy.`,
    );
  }
});

test("CO ensure block ALTERs in the same 3 snake_case hold columns", () => {
  const f = read(CO);
  for (const col of ["hold_reason", "held_by", "held_at"]) {
    assert.match(
      f,
      new RegExp(
        `ALTER TABLE consignment_orders ADD COLUMN IF NOT EXISTS ${col}\\b`,
      ),
      `consignment_orders.${col} must be runtime-ALTERed (snake_case).`,
    );
  }
});

test("hold columns are snake_case (no camelCase write that would need a rename-map entry)", () => {
  // The route SQL must reference the literal snake_case names. A camelCase
  // identifier in route SQL silently 400s unless it is in column-rename-map.json
  // — we deliberately avoid that whole class by using snake_case columns.
  for (const p of [SO, CO]) {
    const f = read(p);
    assert.doesNotMatch(
      f,
      /ADD COLUMN IF NOT EXISTS holdReason\b/,
      "hold column must be snake_case hold_reason, not camelCase holdReason",
    );
  }
});

// ===========================================================================
// (i) Required-reason gate — backend rejects a blank reason with 400.
// ===========================================================================

test("SO PUT rejects ON_HOLD with a blank reason (400, unified FE+BE rule)", () => {
  const f = flat(SO);
  // The gate fires when newStatus === "ON_HOLD" and the trimmed reason is empty.
  assert.match(
    f,
    /newStatus === "ON_HOLD"[\s\S]*?body\.holdReason[\s\S]*?A reason is required to put this order on hold\.[\s\S]*?400/,
    "SO PUT must reject a blank holdReason on → ON_HOLD with the required-reason 400.",
  );
});

test("CO PUT rejects ON_HOLD with a blank reason (400)", () => {
  const f = flat(CO);
  assert.match(
    f,
    /requested === "ON_HOLD"[\s\S]*?body\.holdReason[\s\S]*?A reason is required to put this order on hold\.[\s\S]*?400/,
    "CO PUT must reject a blank holdReason on → ON_HOLD with the required-reason 400.",
  );
});

// ===========================================================================
// (ii) The order UPDATE writes the 3 hold columns, and the write is wired to
//      set-on-hold / clear-otherwise (not a constant).
// ===========================================================================

test("SO UPDATE sets hold_reason / held_by / held_at", () => {
  const f = flat(SO);
  assert.match(
    f,
    /UPDATE sales_orders SET[\s\S]*?hold_reason = \?, held_by = \?, held_at = \?/,
    "The main SO UPDATE must persist the 3 hold columns.",
  );
  // The reason binding must NULL the fields on a transition out of / not into
  // hold (clearHoldFields), not leave a stale reason behind.
  assert.match(
    f,
    /clearHoldFields/,
    "SO must clear (NULL) the hold fields on resume / cancel via clearHoldFields.",
  );
});

test("CO UPDATE sets hold_reason / held_by / held_at and clears off-hold", () => {
  const f = flat(CO);
  assert.match(
    f,
    /UPDATE consignment_orders SET[\s\S]*?hold_reason = \?, held_by = \?, held_at = \?/,
    "The CO UPDATE must persist the 3 hold columns.",
  );
  // CO must GUARD the set: set the reason ONLY on a real transition INTO hold,
  // never just because merged.status is ON_HOLD — otherwise a header-only edit
  // to an ALREADY-on-hold CO dereferences an undefined body.holdReason and 500s.
  assert.match(
    f,
    /merged\.status === "ON_HOLD" && merged\.status !== existing\.status/,
    "CO must set the hold reason only on a real transition INTO hold (guarded against the undefined-deref crash on a header edit of an already-held CO).",
  );
  // CO clears on any status change that is not → ON_HOLD.
  assert.match(
    f,
    /merged\.status === "ON_HOLD"[\s\S]*?merged\.status !== existing\.status[\s\S]*?null/,
    "CO must NULL the hold fields on a transition out of / not into hold.",
  );
});

// ===========================================================================
// (iii) The audit row carries the reason (not the generic default).
// ===========================================================================

test("SO status-change audit note carries the hold reason", () => {
  const f = flat(SO);
  assert.match(
    f,
    /holdReason \? `On hold: \$\{holdReason\}`/,
    "so_status_changes.notes must read 'On hold: <reason>' so the status timeline is meaningful.",
  );
});

// ===========================================================================
// (iv) The reason flows to production via the SO/CO → PO join (attachCustomerSO).
// ===========================================================================

test("production list join selects the hold columns from SO and CO", () => {
  const f = flat(PROD_API);
  assert.match(
    f,
    /SELECT id, customerSOId, customerPOId, customerPO, reference, customerDeliveryDate, hookkaExpectedDD, hold_reason, held_by, held_at FROM sales_orders/,
    "The SO batch-join must add hold_reason/held_by/held_at to its SELECT.",
  );
  assert.match(
    f,
    /SELECT id, customerCOId, hold_reason, held_by, held_at FROM consignment_orders/,
    "The CO batch-join must add the same hold columns to its SELECT.",
  );
});

test("production list join copies holdReason/heldBy/heldAt onto each PO row", () => {
  const f = flat(PROD_API);
  assert.match(
    f,
    /p\.holdReason =/,
    "attachCustomerSO must stamp holdReason onto each PO row so it rides to the grid.",
  );
  assert.match(f, /p\.heldBy =/, "attachCustomerSO must stamp heldBy onto each PO row.");
  assert.match(f, /p\.heldAt =/, "attachCustomerSO must stamp heldAt onto each PO row.");
});

test("DeptRow carries the hold reason (copied from the parent order)", () => {
  const types = read(PROD_TYPES);
  assert.match(types, /holdReason: string;/, "DeptRow type must carry holdReason.");
  const base = flat(BASEROWS);
  assert.match(
    base,
    /holdReason: o\.holdReason \|\| ""/,
    "baserows-core must copy holdReason from the ProductionOrder onto each DeptRow.",
  );
});

// ===========================================================================
// (vi) The grid renders the reason — faint line + ON HOLD chip tooltip — on
//      BOTH the dept grid SO-ID cell and the ALL-tab overview.
// ===========================================================================

test("dept grid renders a faint reason line + chip tooltip on ON HOLD rows", () => {
  const f = flat(PROD_FE);
  // The faint italic reason line under the SO ID.
  assert.match(
    f,
    /italic text-\[#9C6F1E\]\/70 truncate/,
    "Dept grid must render a faint italic truncated reason line for ON HOLD rows.",
  );
  // The full reason + who + when goes into a tooltip.
  assert.match(
    f,
    /On hold: \$\{holdReason\}\$\{[\s\S]*?row\.heldBy[\s\S]*?row\.heldAt/,
    "Dept grid chip tooltip must reveal the full reason + who + when.",
  );
});

test("ALL-tab overview renders the reason line + chip tooltip", () => {
  const f = flat(PROD_FE);
  assert.match(
    f,
    /ovHoldTooltip/,
    "Overview pill must carry the hold tooltip.",
  );
  assert.match(
    f,
    /On hold: \$\{ovHoldReason\}\$\{[\s\S]*?order\.heldBy[\s\S]*?order\.heldAt/,
    "Overview tooltip must reveal the full reason + who + when.",
  );
});

// ===========================================================================
// FE capture — the SO/CO detail Put-On-Hold modal REQUIRES a non-empty reason
// (the FE half of the unified FE+BE input-rejection rule) and sends it.
// ===========================================================================

test("SO detail hold modal requires a reason and sends holdReason + changedBy", () => {
  const f = flat(SO_DETAIL);
  // The Put On Hold button opens the dedicated reason modal (not a plain confirm).
  assert.match(
    f,
    /setHoldModal\(\{ open: true, reason: "", error: "" \}\)/,
    "Put On Hold must open the reason-capture modal.",
  );
  // Confirm is disabled while the reason is empty (required-reason gate, FE side).
  assert.match(
    f,
    /disabled=\{updating \|\| holdModal\.reason\.trim\(\)\.length === 0\}/,
    "The hold modal's Confirm button must be disabled until a non-empty reason is typed.",
  );
  // updateStatus sends holdReason + the logged-in user (not the 'Admin' literal).
  assert.match(
    f,
    /status: newStatus, holdReason: \(holdReason \|\| ""\)\.trim\(\), changedBy: actor/,
    "On ON_HOLD the PUT body must carry holdReason + changedBy(actor).",
  );
  assert.match(
    f,
    /getCurrentUser\(\)\?\.displayName/,
    "The actor must come from the logged-in user, not a hardcoded 'Admin'.",
  );
});

test("CO detail hold modal requires a reason and sends holdReason + changedBy", () => {
  const f = flat(CO_DETAIL);
  assert.match(
    f,
    /setHoldModal\(\{ open: true, reason: "", error: "" \}\)/,
    "CO Put On Hold must open the reason-capture modal.",
  );
  assert.match(
    f,
    /disabled=\{updating \|\| holdModal\.reason\.trim\(\)\.length === 0\}/,
    "CO hold modal's Confirm button must be disabled until a non-empty reason is typed.",
  );
  assert.match(
    f,
    /status: newStatus, holdReason: \(holdReason \|\| ""\)\.trim\(\), changedBy: actor/,
    "CO ON_HOLD PUT body must carry holdReason + changedBy(actor).",
  );
});

// ===========================================================================
// BEHAVIORAL (runtime) — the bit the structural pins above MISSED.
//
// The structural tests only prove `p.holdReason =` appears in the source.
// They CANNOT catch the real BUG-2026-06-24-001 failure mode: the production
// grid fetches /api/production-orders?fields=minimal, whose rows are built by
// rowToMinimalPO. Before the fix, holdReason was NOT a declared key in that
// projection — it only existed if attachCustomerSO's late mutation happened to
// survive. customerSO survived (declared "" in the literal) but holdReason
// did NOT, so an ON_HOLD row's reason never reached the FE — not even "".
//
// This test runs the REAL row→minimal projection (rowToMinimalPO) + the REAL
// SO-join enrich (attachCustomerSO, against a fake D1) the endpoint uses, then
// JSON-round-trips the row (exactly what the wire / list snapshot does) and
// asserts the reason is present and correct.
// ===========================================================================

// Minimal fake D1 — just enough of prepare().bind().all()/first() for
// attachCustomerSO. It returns a single SO row carrying the snake_case
// hold columns (mirrors the real SELECT in attachCustomerSO).
function makeFakeDb(soRow) {
  return {
    prepare(sql) {
      return {
        _sql: sql,
        bind() {
          return this;
        },
        async all() {
          // attachCustomerSO fires one SELECT against sales_orders and one
          // against consignment_orders. Only the SO query has a match here.
          if (/FROM sales_orders/.test(this._sql)) {
            return { results: [soRow] };
          }
          return { results: [] };
        },
        async first() {
          return null;
        },
      };
    },
  };
}

test("BEHAVIORAL: minimal projection + SO-join enrich carries holdReason to the grid row", async () => {
  const { rowToMinimalPO, attachCustomerSO } = await import(PROD_API_URL);

  const SO_ID = "so_hold_1";
  const REASON = "Customer requested fabric change";
  const HELD_BY = "Wei Siang";
  const HELD_AT = "2026-06-24T09:30:00.000Z";

  // An ON_HOLD production order linked to the SO above.
  const poRow = {
    id: "po_hold_1",
    poNo: "PO-2606-001",
    salesOrderId: SO_ID,
    salesOrderNo: "SO-2606-001",
    companySOId: "SO-2606-001",
    consignmentOrderId: "",
    companyCOId: "",
    customerPOId: "",
    customerReference: "",
    customerName: "Houzs",
    customerState: "Selangor",
    productId: "p1",
    productCode: "BO315-02",
    productName: "Bedframe",
    itemCategory: "BEDFRAME",
    sizeCode: "Q",
    sizeLabel: "Queen",
    fabricCode: "M2402-4",
    quantity: 1,
    gapInches: null,
    divanHeightInches: null,
    legHeightInches: null,
    specialOrder: "",
    status: "ON_HOLD",
    currentDepartment: "WOOD_CUT",
    progress: 0,
    completedDate: null,
    lineNo: 1,
    targetEndDate: "",
  };

  // 1) Build the minimal grid row the same way the endpoint does.
  const minimal = rowToMinimalPO(poRow);

  // The projection alone must ALREADY carry the key (even before the join) —
  // this is the anchor that lets it survive the list snapshot.
  assert.equal(
    minimal.holdReason,
    "",
    "rowToMinimalPO must emit holdReason as a declared '' default (the snapshot-safe anchor).",
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(minimal, "heldBy"),
    "rowToMinimalPO must emit heldBy as an own key.",
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(minimal, "heldAt"),
    "rowToMinimalPO must emit heldAt as an own key.",
  );

  // 1b) SNAPSHOT-SAFETY — the exact live failure mode. The production grid is
  //     served from production_orders_list_snapshot, a JSON blob that
  //     writeSnapshot() captures via JSON.stringify and readSnapshot() returns
  //     via JSON.parse. Round-trip the bare projection (no join) and confirm the
  //     keys survive. Before the fix holdReason was NOT an own-property of the
  //     projection, so a snapshot blob (or KV body) captured around the deploy
  //     window had NO holdReason key for ANY row — "not even an empty string"
  //     — which is precisely what was observed on prod.
  const snapshotBlob = JSON.parse(JSON.stringify(minimal));
  for (const key of ["holdReason", "heldBy", "heldAt"]) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(snapshotBlob, key),
      `The list-snapshot blob must contain '${key}' even before the SO join — the key must be a declared own-property of rowToMinimalPO, not a post-hoc mutation the cache can drop.`,
    );
  }

  // 2) Run the REAL SO-join enrich against a fake SO row that is ON HOLD.
  const soRow = {
    id: SO_ID,
    customerSOId: "CUST-SO-77",
    customerPOId: null,
    customerPO: null,
    reference: null,
    customerDeliveryDate: null,
    hookkaExpectedDD: null,
    hold_reason: REASON,
    held_by: HELD_BY,
    held_at: HELD_AT,
  };
  const rows = [minimal];
  await attachCustomerSO(makeFakeDb(soRow), rows);

  // 3) JSON round-trip — exactly what the wire AND the list snapshot blob do.
  const onWire = JSON.parse(JSON.stringify(rows[0]));

  // The grid MUST receive the reason (this is the live symptom that was broken).
  assert.equal(
    onWire.holdReason,
    REASON,
    "The minimal payload for an ON_HOLD order whose SO has hold_reason MUST carry holdReason === the SO reason.",
  );
  assert.equal(onWire.heldBy, HELD_BY, "The minimal payload must carry heldBy from the SO.");
  assert.equal(
    onWire.heldAt,
    HELD_AT.slice(0, 16).replace("T", " "),
    "The minimal payload must carry heldAt (trimmed to minute, space-separated) from the SO.",
  );

  // Regression guard: customerSO must still resolve from the same join.
  assert.equal(
    onWire.customerSO,
    "CUST-SO-77",
    "customerSO must still resolve from the SO join (don't regress the existing field).",
  );
});

test("BEHAVIORAL: a NON-hold order still exposes the key as '' (present, not missing)", async () => {
  const { rowToMinimalPO, attachCustomerSO } = await import(PROD_API_URL);

  const SO_ID = "so_nohold_1";
  const poRow = {
    id: "po_nohold_1",
    poNo: "PO-2606-002",
    salesOrderId: SO_ID,
    salesOrderNo: "SO-2606-002",
    companySOId: "SO-2606-002",
    consignmentOrderId: "",
    companyCOId: "",
    quantity: 2,
    lineNo: 1,
    status: "IN_PROGRESS",
  };

  const minimal = rowToMinimalPO(poRow);
  // SO row with NO hold reason (resumed / never held).
  const soRow = {
    id: SO_ID,
    customerSOId: "CUST-SO-99",
    customerPOId: null,
    customerPO: null,
    reference: null,
    customerDeliveryDate: null,
    hookkaExpectedDD: null,
    hold_reason: null,
    held_by: null,
    held_at: null,
  };
  const rows = [minimal];
  await attachCustomerSO(makeFakeDb(soRow), rows);
  const onWire = JSON.parse(JSON.stringify(rows[0]));

  // The key must be PRESENT as "" — not absent. "Not even an empty string for
  // ANY row" was the precise live symptom; this pins the always-present invariant.
  assert.equal(
    onWire.holdReason,
    "",
    "A non-hold order's holdReason must be present as '' (key never missing).",
  );
  assert.equal(onWire.heldBy, "", "heldBy must be present as '' on a non-hold order.");
  assert.equal(onWire.heldAt, "", "heldAt must be present as '' on a non-hold order.");
});
