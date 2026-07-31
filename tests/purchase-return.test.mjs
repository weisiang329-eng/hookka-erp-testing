// ---------------------------------------------------------------------------
// purchase-return.test.mjs — Purchase Return module, slice 1 (owner 2026-07-30).
// The supplier-side mirror of Delivery Return: create a Purchase Return from a
// Purchase Invoice (pick lines, qty, editable return cost, reason), PR
// numbering, list/detail. NO stock / AP movement in slice 1 (status OPEN).
// See docs/plans/2026-07-30-purchase-return.md.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CREATE = resolve(process.cwd(), "src/api/lib/purchase-return-create.ts");
const ROUTES = resolve(process.cwd(), "src/api/routes/purchase-returns.ts");
const WORKER = resolve(process.cwd(), "src/api/worker.ts");
const PAGE = resolve(process.cwd(), "src/pages/purchase-returns/index.tsx");
const SIDEBAR = resolve(process.cwd(), "src/components/layout/sidebar.tsx");
const ROUTESX = resolve(process.cwd(), "src/dashboard-routes.tsx");

const read = (p) => readFileSync(p, "utf8");
const flat = (p) => read(p).replace(/\s+/g, " ");

// ===========================================================================
// Create lib
// ===========================================================================

test("tables are runtime self-applied (header + items)", () => {
  const f = flat(CREATE);
  assert.match(f, /CREATE TABLE IF NOT EXISTS purchase_returns \(/);
  assert.match(f, /CREATE TABLE IF NOT EXISTS purchase_return_items \(/);
  // slice-2/3 fields exist on the header now so later slices don't re-migrate.
  assert.match(f, /debit_note_id TEXT/);
  assert.match(f, /resolution TEXT/);
});

test("PR numbering is PR-YYMM-NNN, sequential", () => {
  const f = flat(CREATE);
  assert.match(f, /`PR-\$\{yy\}\$\{mm\}-`/);
  assert.match(f, /FROM purchase_returns WHERE return_no LIKE \? ORDER BY return_no DESC/);
});

test("line total is derived qty × unit cost; CREATE itself moves no ledger", () => {
  const f = flat(CREATE);
  assert.match(f, /VALUES \(\?, \?, \?, \?, \?, \?, 'OPEN', \?, \?, \?, \?, \?, \?, \?, \?\)/);
  assert.match(f, /Math\.round\(qty \* unit\)/);
  // createPurchaseReturn ITSELF only writes the header + items — the stock/AP
  // moves live in the separate applyPurchaseReturnStockOut (slice 2) so a plain
  // create never touches inventory or the cost ledger.
  const src = read(CREATE);
  const start = src.indexOf("export async function createPurchaseReturn");
  const body = src.slice(start);
  assert.doesNotMatch(body, /rm_batches|balanceQty|cost_ledger|accounts_payable/i);
});

test("returnable lines come from the PI, SELECT * dual-keyed, stocked-only", () => {
  const f = flat(CREATE);
  assert.match(f, /SELECT \* FROM purchase_invoice_items WHERE pi_id = \?/);
  assert.match(f, /lineType !== "STOCKED" && !materialCode\) continue/);
  // Editable return cost seeds from the PI unit price (owner: negotiated return).
  assert.match(f, /unitCostSen: Number\(pick\(r, "unit_price_sen", "unitPriceSen"\)/);
});

// ===========================================================================
// Routes
// ===========================================================================

test("routes: list / source-pi / detail / create / delete, RBAC-gated", () => {
  const f = flat(ROUTES);
  assert.match(f, /app\.get\("\/"/);
  assert.match(f, /app\.get\("\/source\/pi\/:piId"/);
  assert.match(f, /app\.get\("\/:id"/);
  assert.match(f, /app\.post\("\/"/);
  assert.match(f, /app\.delete\("\/:id"/);
  assert.match(f, /requirePermission\(c, "purchase-invoices", "create"\)/);
  // DELETE only while OPEN (contract kept for slices 2/3).
  assert.match(f, /only OPEN returns can be deleted/);
  // Create requires at least one line with qty > 0.
  assert.match(f, /at least one line with quantity > 0 is required/);
});

test("worker mounts /api/purchase-returns", () => {
  const f = flat(WORKER);
  assert.match(f, /import purchaseReturns from "\.\/routes\/purchase-returns"/);
  assert.match(f, /app\.route\("\/api\/purchase-returns", purchaseReturns\)/);
});

// ===========================================================================
// UI wiring
// ===========================================================================

test("page + sidebar + route are wired", () => {
  const page = flat(PAGE);
  assert.match(page, /\/api\/purchase-returns\/source\/pi\//, "loads the PI lines picker");
  assert.match(page, /method: "POST"/, "creates the return");
  assert.match(page, /Supplier refund/, "resolution choice surfaced");
  assert.match(flat(SIDEBAR), /name: "Purchase Return", href: "\/purchase-returns"/);
  assert.match(flat(ROUTESX), /path: '\/purchase-returns'/);
});

// ===========================================================================
// Slice 2 — inventory reversal (owner-verified; mirrors stock-adjustments RM-OUT)
// ===========================================================================

test("stock reversal is FIFO oldest-first, idempotent, atomic", () => {
  const f = flat(CREATE);
  assert.match(f, /export async function applyPurchaseReturnStockOut/);
  // Idempotent: only fires while OPEN, flips to STOCK_OUT.
  assert.match(f, /already processed — stock reverses only once/);
  assert.match(f, /UPDATE purchase_returns SET status = 'STOCK_OUT'/);
  // FIFO oldest-first (same costing basis as consumption).
  assert.match(f, /FROM rm_batches WHERE rmId = \? AND remainingQty > 0 ORDER BY receivedDate ASC/);
  // Whole thing is one atomic batch (status flip + stock moves together).
  assert.match(f, /await db\.batch\(stmts\)/);
});

test("stock reversal drops balanceQty + batch remainingQty + emits OUT ledger", () => {
  const f = flat(CREATE);
  assert.match(f, /UPDATE raw_materials SET balanceQty = balanceQty - \? WHERE id = \?/);
  assert.match(f, /UPDATE rm_batches SET remainingQty = remainingQty - \? WHERE id = \?/);
  // cost_ledger OUT, tagged to the return so the trail is auditable.
  assert.match(f, /'OUT', \?, \?, 'PURCHASE_RETURN', \?, \?/);
  // Residual (stock drifted below the return qty) → ledger-only, no batch move.
  assert.match(f, /residual, no batch/);
});

test("confirm route fires the reversal, RBAC-gated; UI has the confirm action", () => {
  const f = flat(ROUTES);
  assert.match(f, /app\.post\("\/:id\/confirm"/);
  assert.match(f, /applyPurchaseReturnStockOut\(c\.var\.DB, id, getOrgId\(c\)\)/);
  assert.match(f, /app\.post\("\/:id\/confirm"[\s\S]*?requirePermission\(c, "purchase-invoices", "update"\)/);
  const page = flat(PAGE);
  assert.match(page, /\/api\/purchase-returns\/\$\{r\.id\}\/confirm/);
  assert.match(page, /Confirm \(remove stock\)/);
});
