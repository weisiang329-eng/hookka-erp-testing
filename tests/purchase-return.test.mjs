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
  assert.match(f, /VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, 'OPEN', \?, \?, \?, \?, \?, \?, \?, \?\)/);
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

// ===========================================================================
// Slice 4 — create straight from a PI (deep link)
// ===========================================================================

test("PI detail has a Create Purchase Return button that deep-links with the PI", () => {
  const pi = readFileSync(resolve(process.cwd(), "src/pages/procurement/PurchaseInvoiceDetail.tsx"), "utf8").replace(/\s+/g, " ");
  assert.match(pi, /Create Purchase Return/);
  assert.match(pi, /navigate\(`\/purchase-returns\?pi=\$\{encodeURIComponent\(pi\.id\)\}`\)/);
});

test("Purchase Returns page reads ?pi= and preselects that PI", () => {
  const page = flat(PAGE);
  assert.match(page, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(page, /q\.get\("pi"\)/);
  assert.match(page, /useState\(!!initialPiId \|\| !!initialGrnId\)/);
  assert.match(page, /initialPiId=\{initialPiId\}/);
  // The dialog auto-loads the PI's returnable lines when deep-linked.
  assert.match(page, /if \(initialPiId\) void loadLines\(initialPiId\)/);
});

// ===========================================================================
// Slice 3 — supplier Debit Note + AP + balanced GL (accounting; owner-verified)
// ===========================================================================

test("issue-DN is STOCK_OUT-only, once, atomic, and flips to DN_ISSUED", () => {
  const f = flat(CREATE);
  assert.match(f, /export async function issuePurchaseReturnDebitNote/);
  assert.match(f, /must be STOCK_OUT/);
  assert.match(f, /a debit note was already issued/);
  assert.match(f, /UPDATE purchase_returns SET debit_note_id = \?, status = 'DN_ISSUED'/);
  assert.match(f, /await db\.batch\(stmts\)/);
});

test("GL reverses the PI's OWN accounts and is balanced by construction", () => {
  const f = flat(CREATE);
  // Read the PI's non-hidden legs; AP-control = its credit leg, expense = its
  // biggest debit leg.
  assert.match(f, /sourceType = 'purchase_invoice' AND sourceId = \? AND orgId = \? AND \(hidden IS NULL OR hidden = 0\)/);
  assert.match(f, /if \(Number\(l\.creditSen\) > 0 && !apCode\) apCode = String\(l\.accountCode\)/);
  // Two legs, BOTH = amountSen → balanced. DR AP-control, CR expense.
  assert.match(f, /accountCode: apCode, debitSen: amountSen, creditSen: 0/);
  assert.match(f, /accountCode: expenseCode, debitSen: 0, creditSen: amountSen/);
  // Guarded from double-posting.
  assert.match(f, /ledgerHasSource\(db, org, "purchase_return", returnId\)/);
});

test("issue-DN reduces the supplier AP subledger + writes the DN document", () => {
  const f = flat(CREATE);
  assert.match(f, /UPDATE suppliers SET outstandingSen = outstandingSen - \? WHERE id = \?/);
  assert.match(f, /CREATE TABLE IF NOT EXISTS supplier_debit_notes/);
  assert.match(f, /`SDN-\$\{yy\}\$\{mm\}-`/);
  assert.match(f, /INSERT INTO supplier_debit_notes/);
});

// ===========================================================================
// Create from a GRN (goods receipt), not just a PI — owner "convert from PI or GR"
// ===========================================================================

test("a Purchase Return can be sourced from a GRN (stock only, no DN)", () => {
  const f = flat(CREATE);
  // GRN loader + self-applied grn_id/grn_no columns on the header.
  assert.match(f, /export async function loadGrnItemsForReturn/);
  assert.match(f, /ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS \$\{col\}/);
  assert.match(f, /"grn_id TEXT", "grn_no TEXT"/);
  // A GRN-sourced return (no PI) is blocked from issuing a Debit Note.
  assert.match(f, /this return is from a Goods Receipt \(not invoiced\) — no supplier Debit Note/);
});

test("routes accept a GRN source; GRN detail + page deep-link it", () => {
  const f = flat(ROUTES);
  assert.match(f, /app\.get\("\/source\/grn\/:grnId"/);
  assert.match(f, /a source purchaseInvoiceId or grnId is required/);
  assert.match(f, /loadGrnItemsForReturn\(c\.var\.DB, grnId\)/);
  const page = flat(PAGE);
  assert.match(page, /q\.get\("grn"\)/, "page reads ?grn=");
  assert.match(page, /grnMode \? \{ grnId \} : \{ purchaseInvoiceId: piId \}/, "submit posts the right source");
  const grn = readFileSync(resolve(process.cwd(), "src/pages/procurement/grn-detail.tsx"), "utf8").replace(/\s+/g, " ");
  assert.match(grn, /navigate\(`\/purchase-returns\?grn=\$\{encodeURIComponent\(grn\.id\)\}`\)/);
});

test("issue-DN route + UI action exist, RBAC-gated", () => {
  const f = flat(ROUTES);
  assert.match(f, /app\.post\("\/:id\/issue-dn"/);
  assert.match(f, /issuePurchaseReturnDebitNote\(c\.var\.DB, id, getOrgId\(c\), userId\)/);
  assert.match(f, /app\.post\("\/:id\/issue-dn"[\s\S]*?requirePermission\(c, "purchase-invoices", "update"\)/);
  const page = flat(PAGE);
  assert.match(page, /\/api\/purchase-returns\/\$\{r\.id\}\/issue-dn/);
  assert.match(page, /Issue Debit Note/);
});
