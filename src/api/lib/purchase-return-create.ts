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
