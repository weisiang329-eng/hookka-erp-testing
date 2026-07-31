// ---------------------------------------------------------------------------
// Shared Purchase Return creation (owner 2026-07-30). The supplier-side mirror
// of delivery-return-create.ts: one place that writes a Purchase Return header
// + item snapshot from a source Purchase Invoice (PI). Slice 1 is header +
// items ONLY — status stays OPEN and NO inventory / AP ledger moves yet (those
// are slices 2 + 3, owner-verified). See docs/plans/2026-07-30-purchase-return.md.
//
// Tables are self-applied at runtime (deploy does not replay migration files).
// snake_case columns; every write is org-scoped by the caller.
// ---------------------------------------------------------------------------
import {
  buildJournalEntryStatements,
  ledgerHasSource,
  type LedgerEntryInput,
} from "./journal-hash";

export type PRCreateItem = {
  purchaseInvoiceItemId?: string;
  materialCode?: string | null;
  materialName?: string;
  supplierSku?: string | null;
  grnItemId?: string | null;
  quantity?: number;
  // Owner chose "negotiated return" — the return can post at a cost DIFFERENT
  // from the original PI line (a renegotiated credit). Defaults to the PI line's
  // unit cost; the operator may edit it. line_total_sen is derived qty × unit.
  unitCostSen?: number;
  problem?: string;
};

export type PRCreateInput = {
  purchaseInvoiceId: string;
  piNo?: string;
  supplierId?: string;
  supplierName?: string;
  reason?: string;
  notes?: string;
  // Owner: a Purchase Return against an ALREADY-PAID PI is a supplier refund.
  // Recorded on the header so slice 3 knows to raise a refund claim vs a credit
  // carried to the next PI. Slice 1 just stores it.
  resolution?: string; // "REFUND" | "CREDIT_NEXT_PI"
  createdBy?: string | null;
  orgId?: string | null;
  items: PRCreateItem[];
};

let tablesEnsured = false;
export async function ensurePurchaseReturnTables(db: D1Database): Promise<void> {
  if (tablesEnsured) return;
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS purchase_returns (
           id TEXT PRIMARY KEY, return_no TEXT NOT NULL,
           purchase_invoice_id TEXT, pi_no TEXT,
           supplier_id TEXT, supplier_name TEXT,
           status TEXT NOT NULL DEFAULT 'OPEN',
           resolution TEXT,
           debit_note_id TEXT, supplier_cn_ref TEXT,
           reason TEXT, notes TEXT, returned_at TEXT,
           created_by TEXT, created_at TEXT, updated_at TEXT, org_id TEXT )`,
      )
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS purchase_return_items (
           id TEXT PRIMARY KEY, purchase_return_id TEXT NOT NULL,
           purchase_invoice_item_id TEXT,
           material_code TEXT, material_name TEXT, supplier_sku TEXT,
           grn_item_id TEXT,
           quantity DOUBLE PRECISION NOT NULL DEFAULT 1,
           unit_cost_sen INTEGER NOT NULL DEFAULT 0,
           line_total_sen INTEGER NOT NULL DEFAULT 0,
           problem TEXT )`,
      )
      .run();
    tablesEnsured = true;
  } catch (err) {
    console.warn(
      "[purchase-return-create] ensure tables:",
      err instanceof Error ? err.message : err,
    );
  }
}

export function genPurchaseReturnId(): string {
  return `pr-${crypto.randomUUID().slice(0, 8)}`;
}
function genItemId(): string {
  return `pri-${crypto.randomUUID().slice(0, 8)}`;
}

// PR-YYMM-NNN, sequential within the current year-month (mirrors DR numbering).
export async function nextPurchaseReturnNo(db: D1Database): Promise<string> {
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const prefix = `PR-${yy}${mm}-`;
  const row = await db
    .prepare(
      `SELECT return_no AS "returnNo" FROM purchase_returns
        WHERE return_no LIKE ? ORDER BY return_no DESC LIMIT 1`,
    )
    .bind(`${prefix}%`)
    .first<{ returnNo: string }>();
  let n = 1;
  if (row?.returnNo) {
    const tail = Number(row.returnNo.slice(prefix.length));
    if (Number.isFinite(tail)) n = tail + 1;
  }
  return `${prefix}${String(n).padStart(3, "0")}`;
}

// Load a PI's stocked lines as return candidates. Only STOCKED lines (a real
// raw_material) can be physically returned — fee / tax / rebate lines are
// excluded. unitCostSen seeds the editable return cost.
export async function loadPiItemsForReturn(
  db: D1Database,
  piId: string,
): Promise<PRCreateItem[]> {
  // SELECT * and read dual-keyed (snake ?? camel) in JS — the PI item table has
  // runtime-added columns whose casing varies, so naming columns explicitly in
  // the SELECT risks referencing one that doesn't exist (a hard SQL error).
  const res = await db
    .prepare(
      `SELECT * FROM purchase_invoice_items WHERE pi_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .bind(piId)
    .all<Record<string, unknown>>();
  const pick = (r: Record<string, unknown>, snake: string, camel: string): unknown =>
    r[snake] ?? r[camel];
  const out: PRCreateItem[] = [];
  for (const r of res.results ?? []) {
    const lineType = String(pick(r, "line_type", "lineType") ?? "STOCKED");
    const materialCode = (pick(r, "material_code", "materialCode") ?? null) as string | null;
    // Only physical stocked lines are returnable.
    if (lineType !== "STOCKED" && !materialCode) continue;
    out.push({
      purchaseInvoiceItemId: String(r.id ?? ""),
      materialCode,
      materialName: String(pick(r, "material_name", "materialName") ?? ""),
      supplierSku: (pick(r, "supplier_sku", "supplierSku") ?? null) as string | null,
      grnItemId: (pick(r, "grn_item_id", "grnItemId") ?? null) as string | null,
      quantity: Number(pick(r, "qty", "qty") ?? 0),
      unitCostSen: Number(pick(r, "unit_price_sen", "unitPriceSen") ?? 0),
      problem: "",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Slice 2 — inventory reversal. On confirm, the returned goods LEAVE stock: for
// each item we FIFO-consume the material's rm_batches (oldest first — same
// costing basis as normal consumption), drop raw_materials.balanceQty, and emit
// one cost_ledger OUT row per layer. This mirrors stock-adjustments.ts's RM-OUT
// path exactly so sum(rm_batches.remainingQty) stays in lockstep with
// balanceQty. The whole thing runs in ONE db.batch (atomic) and is idempotent:
// it only fires while status = 'OPEN', flipping to 'STOCK_OUT'. The supplier
// Debit Note + AP posting (at the negotiated price) is slice 3 — this slice
// values the stock leaving at its FIFO batch cost only.
export async function applyPurchaseReturnStockOut(
  db: D1Database,
  returnId: string,
  orgId: string | null,
): Promise<{ ok: boolean; error?: string; reversedItems?: number }> {
  await ensurePurchaseReturnTables(db);
  const header = await db
    .prepare(
      "SELECT id, status FROM purchase_returns WHERE id = ? AND (org_id = ? OR org_id IS NULL)",
    )
    .bind(returnId, orgId)
    .first<{ id: string; status: string | null }>();
  if (!header) return { ok: false, error: "not found" };
  if ((header.status ?? "OPEN") !== "OPEN") {
    return { ok: false, error: "already processed — stock reverses only once" };
  }
  const itemsRes = await db
    .prepare("SELECT * FROM purchase_return_items WHERE purchase_return_id = ?")
    .bind(returnId)
    .all<Record<string, unknown>>();
  const items = itemsRes.results ?? [];
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const stmts: D1PreparedStatement[] = [];
  let ledgerN = 0;
  let reversedItems = 0;
  for (const it of items) {
    const materialCode = String((it.material_code ?? it.materialCode) ?? "").trim();
    const qty = Number(it.quantity ?? 0);
    if (!materialCode || !(qty > 0)) continue;
    const rm = await db
      .prepare("SELECT id FROM raw_materials WHERE itemCode = ? LIMIT 1")
      .bind(materialCode)
      .first<{ id: string }>();
    if (!rm) continue; // unresolvable material — skip (never guess which stock to move)

    // FIFO plan: oldest batches first, same as consumption.
    const batchesRes = await db
      .prepare(
        "SELECT id, remainingQty, unitCostSen FROM rm_batches WHERE rmId = ? AND remainingQty > 0 ORDER BY receivedDate ASC, id ASC",
      )
      .bind(rm.id)
      .all<{ id: string; remainingQty: number; unitCostSen: number }>();
    const plan: { batchId: string; qty: number; unitCostSen: number; totalCostSen: number }[] = [];
    let still = qty;
    for (const b of batchesRes.results ?? []) {
      if (still <= 0) break;
      const take = Math.min(b.remainingQty, still);
      if (take <= 0) continue;
      plan.push({ batchId: b.id, qty: take, unitCostSen: b.unitCostSen, totalCostSen: Math.round(take * b.unitCostSen) });
      still -= take;
    }
    // Residual (stock drifted below the return qty) — ledger-only, no batch
    // mutation, valued at the return's own unit cost. Mirrors stock-adjustments.
    if (still > 0) {
      const unit = Math.round(Number(it.unit_cost_sen ?? it.unitCostSen ?? 0));
      plan.push({ batchId: "", qty: still, unitCostSen: unit, totalCostSen: Math.round(still * unit) });
    }

    for (const layer of plan) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO cost_ledger (id, date, type, itemType, itemId, batchId,
               qty, direction, unitCostSen, totalCostSen, refType, refId, notes)
             VALUES (?, ?, 'ADJUSTMENT', 'RM', ?, ?, ?, 'OUT', ?, ?, 'PURCHASE_RETURN', ?, ?)`,
          )
          .bind(
            `cl-pr-${returnId}-${ledgerN++}`,
            today,
            rm.id,
            layer.batchId || null,
            layer.qty,
            layer.unitCostSen,
            layer.totalCostSen,
            returnId,
            `Purchase Return — goods returned to supplier${layer.batchId ? "" : " (residual, no batch)"}`,
          ),
      );
    }
    stmts.push(
      db.prepare("UPDATE raw_materials SET balanceQty = balanceQty - ? WHERE id = ?").bind(qty, rm.id),
    );
    for (const layer of plan) {
      if (!layer.batchId) continue;
      stmts.push(
        db.prepare("UPDATE rm_batches SET remainingQty = remainingQty - ? WHERE id = ?").bind(layer.qty, layer.batchId),
      );
    }
    reversedItems++;
  }
  // Idempotency + status flip in the SAME atomic batch as the stock moves.
  stmts.push(
    db.prepare("UPDATE purchase_returns SET status = 'STOCK_OUT', updated_at = ? WHERE id = ?").bind(now, returnId),
  );
  await db.batch(stmts);
  return { ok: true, reversedItems };
}

// ---------------------------------------------------------------------------
// Slice 3 — supplier Debit Note + AP. Owner 2026-07-30. Once a return's stock is
// reversed (STOCK_OUT), issuing the DN debits the supplier: it reduces our AP
// AND posts a balanced GL journal. The GL posting is the SAFE kind — it reuses
// the source PI's OWN accounts: DR the PI's AP-control account, CR the PI's main
// expense/inventory account, both = the DN amount. Because it uses the accounts
// the PI actually posted to and both legs equal the same amount, the journal is
// balanced by construction (no invented accounts, no rounding drift). If the PI
// never hit the GL (e.g. a DRAFT PI), the GL step is skipped and only the AP
// subledger + DN record move. Idempotent: fires only from STOCK_OUT, flips to
// DN_ISSUED, and the journal is guarded by ledgerHasSource. All in one db.batch.
async function ensureSupplierDebitNoteTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS supplier_debit_notes (
         id TEXT PRIMARY KEY, note_number TEXT, purchase_return_id TEXT,
         supplier_id TEXT, supplier_name TEXT, purchase_invoice_id TEXT,
         amount_sen INTEGER, status TEXT NOT NULL DEFAULT 'ISSUED',
         created_by TEXT, org_id TEXT, created_at TEXT )`,
    )
    .run();
}

async function nextSupplierDnNo(db: D1Database): Promise<string> {
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const prefix = `SDN-${yy}${mm}-`;
  const row = await db
    .prepare(
      `SELECT note_number AS "noteNumber" FROM supplier_debit_notes
        WHERE note_number LIKE ? ORDER BY note_number DESC LIMIT 1`,
    )
    .bind(`${prefix}%`)
    .first<{ noteNumber: string }>();
  let n = 1;
  if (row?.noteNumber) {
    const tail = Number(row.noteNumber.slice(prefix.length));
    if (Number.isFinite(tail)) n = tail + 1;
  }
  return `${prefix}${String(n).padStart(3, "0")}`;
}

export async function issuePurchaseReturnDebitNote(
  db: D1Database,
  returnId: string,
  orgId: string | null,
  actorUserId: string | null,
): Promise<{ ok: boolean; error?: string; noteNumber?: string; amountSen?: number }> {
  await ensurePurchaseReturnTables(db);
  await ensureSupplierDebitNoteTable(db);
  const header = await db
    .prepare(
      "SELECT * FROM purchase_returns WHERE id = ? AND (org_id = ? OR org_id IS NULL)",
    )
    .bind(returnId, orgId)
    .first<Record<string, unknown>>();
  if (!header) return { ok: false, error: "not found" };
  if (String(header.status ?? "OPEN") !== "STOCK_OUT") {
    return { ok: false, error: "confirm the stock reversal first (must be STOCK_OUT)" };
  }
  if (header.debit_note_id) return { ok: false, error: "a debit note was already issued" };

  const agg = await db
    .prepare("SELECT COALESCE(SUM(line_total_sen),0) AS total FROM purchase_return_items WHERE purchase_return_id = ?")
    .bind(returnId)
    .first<{ total: number }>();
  const amountSen = Math.round(Number(agg?.total ?? 0));
  if (!(amountSen > 0)) return { ok: false, error: "nothing to debit (0 amount)" };

  const piId = String(header.purchase_invoice_id ?? "");
  const supplierId = String(header.supplier_id ?? "");
  const supplierName = String(header.supplier_name ?? "");
  const org = orgId ?? "";
  const now = new Date().toISOString();
  const dnId = `sdn-${crypto.randomUUID().slice(0, 8)}`;
  const noteNumber = await nextSupplierDnNo(db);
  const stmts: D1PreparedStatement[] = [];

  // GL — reverse the PI's posting via its OWN accounts (balanced by construction).
  if (piId && !(await ledgerHasSource(db, org, "purchase_return", returnId))) {
    const piLegs =
      (
        await db
          .prepare(
            "SELECT accountCode, debitSen, creditSen FROM ledger_journal_entries WHERE sourceType = 'purchase_invoice' AND sourceId = ? AND orgId = ? AND (hidden IS NULL OR hidden = 0)",
          )
          .bind(piId, org)
          .all<{ accountCode: string; debitSen: number; creditSen: number }>()
      ).results ?? [];
    let apCode = "";
    let expenseCode = "";
    let maxDebit = -1;
    for (const l of piLegs) {
      if (Number(l.creditSen) > 0 && !apCode) apCode = String(l.accountCode); // AP-control = the PI's credit leg
      if (Number(l.debitSen) > maxDebit) { maxDebit = Number(l.debitSen); expenseCode = String(l.accountCode); }
    }
    if (apCode && expenseCode && apCode !== expenseCode) {
      const legs: LedgerEntryInput[] = [
        { id: `lje-${crypto.randomUUID().slice(0, 12)}`, sourceType: "purchase_return", sourceId: returnId, legNo: 1, accountCode: apCode, debitSen: amountSen, creditSen: 0, description: `${noteNumber} · AP debit (goods returned)`, actorUserId, orgId: org },
        { id: `lje-${crypto.randomUUID().slice(0, 12)}`, sourceType: "purchase_return", sourceId: returnId, legNo: 2, accountCode: expenseCode, debitSen: 0, creditSen: amountSen, description: `${noteNumber} · purchase return`, actorUserId, orgId: org },
      ];
      const { statements: ls } = await buildJournalEntryStatements(db, org, legs);
      stmts.push(...ls);
    }
  }

  // AP subledger — reduce what we owe the supplier by the DN amount.
  if (supplierId) {
    stmts.push(
      db.prepare("UPDATE suppliers SET outstandingSen = outstandingSen - ? WHERE id = ?").bind(amountSen, supplierId),
    );
  }
  // The DN document.
  stmts.push(
    db
      .prepare(
        `INSERT INTO supplier_debit_notes
           (id, note_number, purchase_return_id, supplier_id, supplier_name,
            purchase_invoice_id, amount_sen, status, created_by, org_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ISSUED', ?, ?, ?)`,
      )
      .bind(dnId, noteNumber, returnId, supplierId, supplierName, piId, amountSen, actorUserId, org, now),
  );
  // Stamp the return + flip status (idempotency).
  stmts.push(
    db.prepare("UPDATE purchase_returns SET debit_note_id = ?, status = 'DN_ISSUED', updated_at = ? WHERE id = ?").bind(dnId, now, returnId),
  );

  await db.batch(stmts);
  return { ok: true, noteNumber, amountSen };
}

// Write a Purchase Return header + its item snapshot. Returns the new id +
// return_no. No ledger movement (slice 1).
export async function createPurchaseReturn(
  db: D1Database,
  input: PRCreateInput,
): Promise<{ id: string; returnNo: string }> {
  await ensurePurchaseReturnTables(db);
  const id = genPurchaseReturnId();
  const returnNo = await nextPurchaseReturnNo(db);
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO purchase_returns
         (id, return_no, purchase_invoice_id, pi_no, supplier_id, supplier_name,
          status, resolution, reason, notes, returned_at, created_by,
          created_at, updated_at, org_id)
       VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      returnNo,
      input.purchaseInvoiceId,
      input.piNo ?? "",
      input.supplierId ?? "",
      input.supplierName ?? "",
      input.resolution ?? "REFUND",
      input.reason ?? "",
      input.notes ?? "",
      now,
      input.createdBy ?? null,
      now,
      now,
      input.orgId ?? null,
    )
    .run();
  for (const it of input.items) {
    const qty = Number(it.quantity ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) continue; // skip zero/blank lines
    const unit = Math.round(Number(it.unitCostSen ?? 0));
    await db
      .prepare(
        `INSERT INTO purchase_return_items
           (id, purchase_return_id, purchase_invoice_item_id, material_code,
            material_name, supplier_sku, grn_item_id, quantity, unit_cost_sen,
            line_total_sen, problem)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        genItemId(),
        id,
        it.purchaseInvoiceItemId ?? null,
        it.materialCode ?? null,
        it.materialName ?? "",
        it.supplierSku ?? null,
        it.grnItemId ?? null,
        qty,
        unit,
        Math.round(qty * unit),
        it.problem ?? "",
      )
      .run();
  }
  return { id, returnNo };
}
