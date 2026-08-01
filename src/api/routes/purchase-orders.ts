// ---------------------------------------------------------------------------
// D1-backed purchase-orders route.
//
// Mirrors the old src/api/routes/purchase-orders.ts response shape so the SPA
// frontend does not need any changes. `items` is a nested array joined from
// the purchase_order_items table.
//
// Schema-note: D1 stores timestamps as `created_at`/`updated_at` (snake_case)
// but the TS type exposes `createdAt`/`updatedAt` (camelCase); the row->API
// mapper handles the rename.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { supplierPoEmailTemplate } from "../lib/email";
import { enqueueEmail } from "../lib/email-outbox";
import { emitAudit } from "../lib/audit";
import { availableQty as computeAvailableQty } from "../../lib/convert-chain";
import { createPurchaseOrderMirror } from "../lib/intercompany-mirror-create";

const app = new Hono<Env>();

type PurchaseOrderRow = {
  id: string;
  poNo: string;
  supplierId: string;
  supplierName: string | null;
  subtotalSen: number;
  totalSen: number;
  status: string;
  orderDate: string | null;
  expectedDate: string | null;
  receivedDate: string | null;
  notes: string | null;
  // 3.1 — manual "Email to Supplier" button stamps this on each send so
  // the FE can show "Last sent: …" + a Resend affordance. Nullable until
  // first send. Column added by ensurePendingMigrations() below.
  lastEmailedAt: string | null;
  // Per-document purchase company override (HOOKKA / OHANA / HOUZS …).
  // Defaults from the supplier's purchaseOrgCode on create when omitted,
  // backfilled to HOOKKA for legacy rows by ensurePendingMigrations().
  purchase_org_code?: string | null;
  purchaseOrgCode?: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type PurchaseOrderItemRow = {
  id: string;
  purchaseOrderId: string;
  materialCategory: string | null;
  // toCamel folds the snake_case DB column to materialCode on read; keep both
  // keys so the dual-key read works whether or not the adapter camel-cased it.
  material_code?: string | null;
  materialCode?: string | null;
  materialName: string | null;
  // The DB column was created as camelCase `supplierSKU` (migration 0001),
  // which Postgres folds to all-lowercase `suppliersku` (NO underscore). The
  // rename-map lists `supplier_sku` (wrong — that column never existed), so the
  // adapter can't restore the casing and `r.supplierSKU` was always undefined →
  // every PO showed a blank Supplier SKU though the value was stored fine. Keep
  // both keys so the dual-key read below works regardless of adapter casing.
  supplierSKU?: string | null;
  suppliersku?: string | null;
  quantity: number;
  unitPriceSen: number;
  totalSen: number;
  receivedQty: number;
  unit: string | null;
};

// PO lifecycle. RECEIVED → CLOSED added 2026-04-26 to match the
// frontend's "Close PO" action button on procurement/detail.tsx — the
// previous backend transition map ended at RECEIVED with no further
// allowed states, so clicking Close PO returned 400 (the audit caught
// this as a FE/BE drift). CLOSED is terminal: nothing more flows from
// it. CANCELLED is also terminal.
const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PARTIAL_RECEIVED", "RECEIVED", "CANCELLED"],
  PARTIAL_RECEIVED: ["RECEIVED", "CANCELLED"],
  RECEIVED: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
};

function rowToItem(r: PurchaseOrderItemRow) {
  // Convert-chain: per-line available-to-receive = quantity − receivedQty
  // (floored at 0). Exposed so the GRN convert picker can show remaining qty.
  const receivedQty = Number(r.receivedQty) || 0;
  return {
    id: r.id,
    materialCategory: r.materialCategory ?? "",
    materialCode: r.materialCode ?? r.material_code ?? "",
    materialName: r.materialName ?? "",
    supplierSKU: r.supplierSKU ?? r.suppliersku ?? "",
    quantity: r.quantity,
    unitPriceSen: r.unitPriceSen,
    totalSen: r.totalSen,
    receivedQty,
    availableQty: computeAvailableQty(Number(r.quantity) || 0, receivedQty),
    unit: r.unit ?? "pcs",
    // Document/paper order (2026-07-04) — the adapter camelCases line_no.
    lineNo: (r as { lineNo?: number | null }).lineNo ?? null,
  };
}

function rowToPO(row: PurchaseOrderRow, items: PurchaseOrderItemRow[] = []) {
  return {
    id: row.id,
    poNo: row.poNo,
    supplierId: row.supplierId,
    supplierName: row.supplierName ?? "",
    items: items.filter((i) => i.purchaseOrderId === row.id).map(rowToItem),
    subtotalSen: row.subtotalSen,
    totalSen: row.totalSen,
    status: row.status,
    orderDate: row.orderDate ?? "",
    expectedDate: row.expectedDate ?? "",
    receivedDate: row.receivedDate,
    notes: row.notes ?? "",
    lastEmailedAt: row.lastEmailedAt ?? null,
    // Dual-keyed read — Postgres folds snake_case to camelCase on some adapters
    // but raw rows stay snake_case. Default to HOOKKA when both are null.
    purchaseOrgCode: row.purchaseOrgCode ?? row.purchase_org_code ?? "HOOKKA",
    createdAt: row.createdAt ?? "",
    updatedAt: row.updatedAt ?? "",
  };
}

// Supplier SKU lives on the (supplier, material) binding in supplier_materials,
// but a single internal code can have SEVERAL supplier SKUs under one supplier
// (e.g. PC151-01 → "COMFY IVORY SAND" @ RM7.50, "VANILLA" @ RM12, "STONE" @
// RM12). PO lines were meant to snapshot the chosen SKU but every line came
// back blank on prod (BUG-2026-07-02-002). So on read we RECOVER the SKU from
// the binding using supplier + code + PRICE — a match is used only when it is
// UNAMBIGUOUS (exactly one binding for the code, OR exactly one at the line's
// price). Same-price variants (VANILLA/STONE both RM12) stay blank rather than
// risk showing the wrong colour. A non-blank stored value always wins.
type SkuBinding = { sku: string; priceSen: number };
async function loadSupplierSkuBindings(
  db: D1Database,
  supplierIds: string[],
): Promise<Map<string, SkuBinding[]>> {
  const m = new Map<string, SkuBinding[]>();
  const ids = Array.from(new Set(supplierIds.filter(Boolean)));
  if (ids.length === 0) return m;
  const ph = ids.map(() => "?").join(", ");
  const res = await db
    .prepare(`SELECT * FROM supplier_material_bindings WHERE supplierId IN (${ph})`)
    .bind(...ids)
    .all<Record<string, unknown>>();
  for (const r of res.results ?? []) {
    const sid = String(r.supplierId ?? r.supplier_id ?? "");
    const code = String(r.materialCode ?? r.material_code ?? "").trim().toUpperCase();
    const sku = String(r.supplierSku ?? r.supplierSKU ?? r.supplier_sku ?? "").trim();
    const priceSen = Number(r.unitPrice ?? r.unit_price ?? 0) || 0;
    if (!sid || !code || !sku) continue;
    const key = `${sid}::${code}`;
    const list = m.get(key);
    if (list) list.push({ sku, priceSen });
    else m.set(key, [{ sku, priceSen }]);
  }
  return m;
}

// Fill any BLANK line Supplier SKU from the bindings — only when the match is
// unambiguous (see loadSupplierSkuBindings). Mutates the built PO objects.
function fillBlankSupplierSku(
  pos: Array<ReturnType<typeof rowToPO>>,
  bindings: Map<string, SkuBinding[]>,
): void {
  for (const po of pos) {
    if (!po.supplierId) continue;
    for (const it of po.items) {
      if (it.supplierSKU) continue;
      const code = String(it.materialCode ?? "").trim().toUpperCase();
      if (!code) continue;
      const cands = bindings.get(`${po.supplierId}::${code}`);
      if (!cands || cands.length === 0) continue;
      let pick = "";
      if (cands.length === 1) {
        pick = cands[0].sku; // one binding for this code → unambiguous
      } else {
        const priceMatches = cands.filter((c) => c.priceSen === it.unitPriceSen);
        if (priceMatches.length === 1) pick = priceMatches[0].sku; // price disambiguates
      }
      if (pick) it.supplierSKU = pick;
    }
  }
}

function genPoId(): string {
  return `po-${crypto.randomUUID().slice(0, 8)}`;
}
function genItemId(): string {
  return `poi-${crypto.randomUUID().slice(0, 8)}`;
}

// Compute the next-suffix poNo for the current YYMM prefix. Pure scan-and-
// increment — concurrency safety lives in the retry wrapper below.
async function nextPoNoCandidate(db: D1Database): Promise<string> {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prefix = `PO-${yymm}-`;
  const res = await db
    .prepare(
      "SELECT poNo FROM purchase_orders WHERE poNo LIKE ? ORDER BY poNo DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ poNo: string }>();
  const seq = res?.poNo ? Number(res.poNo.split("-").pop()) + 1 : 1;
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

// 5.3 — concurrency-safe poNo generator. Two simultaneous POSTs in the
// same month would otherwise collide on the bare scan above — both see
// the same max suffix, both compute the same next number, the second
// INSERT trips the new ux_purchase_orders_po_no UNIQUE index. We catch
// that 23505 / "UNIQUE" error path, re-scan, and retry up to 5 times
// (each retry races against any other in-flight inserts so it's not a
// fixed answer — re-scan picks up whichever insert just landed).
//
// NOTE: callers consume this poNo immediately in the same INSERT. If
// the INSERT fails with a UNIQUE collision, the caller catches and
// retries via tryGeneratePoNoAndInsert below.
const generatePoNo = nextPoNoCandidate;

const PO_NO_RETRY_LIMIT = 5;

function isPoNoUniqueViolation(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  // Postgres 23505 / SQLite "UNIQUE constraint failed" / generic "duplicate"
  // are all surfaced through the same DB layer here.
  return (
    msg.includes("23505") ||
    msg.includes("UNIQUE constraint failed") ||
    /duplicate key/i.test(msg) ||
    /ux_purchase_orders_po_no/i.test(msg)
  );
}

// ── line_no: document/paper order for PO items (owner 2026-07-04) ──────────
// Item ids are RANDOM (`poi-<uuid8>`), so no existing column encodes the
// paper order, yet GRN receive matches lines positionally (poItemIndex).
// line_no is set from the request's array index on POST/PUT; pre-existing
// rows are backfilled in legacy id-order so saved GRN poItemIndex values keep
// pointing at the same lines. Runtime self-apply (migration files are inert
// on deploy). One DDL round-trip per isolate.
export const PO_ITEMS_ORDER = "ORDER BY line_no NULLS LAST, id";
let poItemLineNoEnsured = false;
export async function ensurePoItemLineNo(db: D1Database): Promise<void> {
  if (poItemLineNoEnsured) return;
  try {
    await db
      .prepare(
        "ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS line_no INTEGER",
      )
      .run();
    await db
      .prepare(
        `UPDATE purchase_order_items p
            SET line_no = r.rn
           FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY purchaseOrderId ORDER BY id) AS rn
                   FROM purchase_order_items
                  WHERE line_no IS NULL) r
          WHERE p.id = r.id AND p.line_no IS NULL`,
      )
      .run();
    poItemLineNoEnsured = true;
  } catch (err) {
    // Never block the request path — reads fall back to NULLS LAST, id.
    console.error("[purchase-orders] ensurePoItemLineNo failed:", err);
  }
}

async function fetchPOWithItems(db: D1Database, id: string) {
  await ensurePoItemLineNo(db);
  const [po, itemsRes] = await Promise.all([
    db
      .prepare("SELECT * FROM purchase_orders WHERE id = ?")
      .bind(id)
      .first<PurchaseOrderRow>(),
    db
      // Canonical item order (2026-07-04): line_no = document/paper order for
      // new POs; backfilled as the legacy id-order for pre-existing rows so
      // saved GRN poItemIndex values keep meaning the same lines. GRN receive
      // matches lines by poItemIndex against grn.ts reads using the SAME
      // ORDER BY — every consumer must agree or quantities land on the wrong
      // line. Postgres heap order is otherwise unguaranteed.
      .prepare(`SELECT * FROM purchase_order_items WHERE purchaseOrderId = ? ${PO_ITEMS_ORDER}`)
      .bind(id)
      .all<PurchaseOrderItemRow>(),
  ]);
  if (!po) return null;
  const built = rowToPO(po, itemsRes.results ?? []);
  // Recover blank line Supplier SKUs from the supplier binding (supplier + code
  // + price, unambiguous only). See loadSupplierSkuBindings / BUG-2026-07-02-002.
  const bindings = await loadSupplierSkuBindings(db, [built.supplierId]);
  fillBlankSupplierSku([built], bindings);
  return built;
}

// GET /api/purchase-orders — list all POs + items
app.get("/", async (c) => {
  // RBAC gate (P3.3-followup) — purchase-orders:read.
  const denied = await requirePermission(c, "purchase-orders", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  await ensurePoItemLineNo(c.var.DB);

  // Opt-in pagination (mirrors sales-orders.ts). `?page=N&limit=M` applies SQL
  // LIMIT/OFFSET and scopes items to the page's POs; the response then carries
  // { total, page, limit }. Omitting BOTH preserves the full-list behavior the
  // list page falls back to whenever a filter/search is active — so a search
  // always sees EVERY PO, never just the current page (the search-safe rule).
  // 2026-08-01.
  const pageParam = c.req.query("page");
  const limitParam = c.req.query("limit");
  const paginate = pageParam !== undefined || limitParam !== undefined;
  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(limitParam ?? "50", 10) || 50));

  let total: number | undefined;
  if (paginate) {
    const cnt = await c.var.DB
      .prepare("SELECT COUNT(*) AS n FROM purchase_orders WHERE orgId = ?")
      .bind(orgId)
      .first<{ n: number }>();
    total = Number(cnt?.n ?? 0);
  }

  const pos = paginate
    ? await c.var.DB
        .prepare(
          "SELECT * FROM purchase_orders WHERE orgId = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
        )
        .bind(orgId, limit, (page - 1) * limit)
        .all<PurchaseOrderRow>()
    : await c.var.DB
        .prepare(
          "SELECT * FROM purchase_orders WHERE orgId = ? ORDER BY created_at DESC, id DESC",
        )
        .bind(orgId)
        .all<PurchaseOrderRow>();
  const poRows = pos.results ?? [];
  // Scope items to the POs we return — was `WHERE orgId` with no LIMIT, loading
  // every item for the org on each render. Guard the "IN ()" case.
  const poIds = poRows.map((p) => p.id);
  const items = poIds.length
    ? await c.var.DB
        .prepare(
          `SELECT * FROM purchase_order_items WHERE purchaseOrderId IN (${poIds.map(() => "?").join(", ")}) ${PO_ITEMS_ORDER}`,
        )
        .bind(...poIds)
        .all<PurchaseOrderItemRow>()
    : { results: [] as PurchaseOrderItemRow[] };
  const data = poRows.map((p) =>
    rowToPO(p, items.results ?? []),
  );
  // Recover blank line Supplier SKUs from the supplier bindings (one query for
  // every supplier in the page). See loadSupplierSkuBindings / BUG-2026-07-02-002.
  const bindings = await loadSupplierSkuBindings(
    c.var.DB,
    poRows.map((p) => p.supplierId),
  );
  fillBlankSupplierSku(data, bindings);
  return c.json(
    paginate
      ? { success: true, data, total, page, limit }
      : { success: true, data },
  );
});

// GET /api/purchase-orders/stats — whole-dataset PO header rows (NO line items),
// so the list page's summary widgets (Draft / Confirmed counts, the overdue
// aging widget) always reflect EVERY PO even when the main list is showing a
// single paginated page. Items are the heavy, unbounded part and the widgets
// never need them — rowToPO reads status / expectedDate / totalSen straight
// off the PO row, so an items-less map is correct + cheap. The frontend reuses
// its existing isOverdue / aging logic over this payload unchanged. Registered
// BEFORE `/:id` so Hono doesn't route "stats" as an id. 2026-08-01.
app.get("/stats", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const pos = await c.var.DB
    .prepare(
      "SELECT * FROM purchase_orders WHERE orgId = ? ORDER BY created_at DESC, id DESC",
    )
    .bind(orgId)
    .all<PurchaseOrderRow>();
  const rows = (pos.results ?? []).map((p) => rowToPO(p));
  return c.json({ success: true, data: rows, total: rows.length });
});

// POST /api/purchase-orders — create PO + items atomically
app.post("/", async (c) => {
  // RBAC gate (P3.3-followup) — purchase-orders:create.
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;
  // line_no column must exist before the item INSERTs below (self-apply).
  await ensurePoItemLineNo(c.var.DB);
  // 5.3 — make sure the unique-poNo index exists before we rely on it for
  // concurrency safety. Idempotent + cheap; same one-shot promise pattern
  // as sales-orders.ts.
  await ensurePendingMigrations(c.var.DB);
  try {
    const body = await c.req.json();
    const { supplierId, supplierName } = body;
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!supplierId || !supplierName || rawItems.length === 0) {
      return c.json(
        {
          success: false,
          error: "supplierId, supplierName, and items are required",
        },
        400,
      );
    }

    // Validate supplier exists + grab its default purchase company code so
    // an omitted body field inherits from the supplier rather than nulling.
    // Also read the Phase 3 dual-identity flags (isGroupCompany / group_org_code)
    // so we can decide whether this PO's seller is a sister group company and a
    // mirror SO should be raised. SELECT * so both dual-keyed camel/snake
    // projections are available and a missing column can't break the SELECT.
    const supplier = await c.var.DB.prepare(
      "SELECT * FROM suppliers WHERE id = ?",
    )
      .bind(supplierId)
      .first<{
        id: string;
        name?: string | null;
        purchaseOrgCode?: string | null;
        purchase_org_code?: string | null;
        isGroupCompany?: number | boolean | null;
        is_group_company?: number | boolean | null;
        groupOrgCode?: string | null;
        group_org_code?: string | null;
      }>();
    if (!supplier) {
      return c.json({ success: false, error: "Supplier not found" }, 400);
    }
    // Resolve purchase company: body wins → supplier's → HOOKKA. Never null.
    const supplierOrgCode =
      supplier.purchaseOrgCode ?? supplier.purchase_org_code ?? null;
    const purchaseOrgCode =
      (typeof body.purchaseOrgCode === "string" && body.purchaseOrgCode.trim()
        ? body.purchaseOrgCode.trim()
        : supplierOrgCode && String(supplierOrgCode).trim()
          ? String(supplierOrgCode).trim()
          : "HOOKKA");

    const poId = genPoId();
    const now = new Date().toISOString();
    const today = now.split("T")[0];

    const poItems = rawItems as Array<Record<string, unknown>>;
    for (let i = 0; i < poItems.length; i++) {
      const q = Number(poItems[i].quantity);
      const p = Number(poItems[i].unitPriceSen);
      if (!Number.isFinite(q) || q < 0) {
        return c.json({ success: false, error: `items[${i}]: quantity must be a number >= 0` }, 400);
      }
      if (!Number.isFinite(p) || p < 0) {
        return c.json({ success: false, error: `items[${i}]: unitPriceSen must be a number >= 0` }, 400);
      }
    }
    const items = poItems.map((item) => {
      const quantity = Number(item.quantity) || 0;
      const unitPriceSen = Number(item.unitPriceSen) || 0;
      return {
        id: genItemId(),
        materialCategory: (item.materialCategory as string) ?? "",
        materialCode: (item.materialCode as string) ?? "",
        materialName: (item.materialName as string) ?? "",
        supplierSKU: (item.supplierSKU as string) ?? "",
        quantity,
        unitPriceSen,
        totalSen: quantity * unitPriceSen,
        receivedQty: 0,
        unit: (item.unit as string) ?? "pcs",
      };
    });
    const subtotalSen = items.reduce((sum, i) => sum + i.totalSen, 0);
    const status: string = body.status ?? "DRAFT";

    // 5.3 — retry-on-unique-collision. Two concurrent POSTs in the same
    // YYMM bucket would otherwise both compute the same suffix and the
    // second INSERT would trip ux_purchase_orders_po_no. We catch the
    // 23505 path, re-scan max+1 (which now includes whichever insert
    // just landed), and try again. After 5 attempts we give up and let
    // the operator retry — by then the contention storm is real.
    let poNo = await generatePoNo(c.var.DB);
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < PO_NO_RETRY_LIMIT; attempt++) {
      const statements = [
        c.var.DB.prepare(
          `INSERT INTO purchase_orders (id, poNo, supplierId, supplierName,
             subtotalSen, totalSen, status, orderDate, expectedDate, receivedDate,
             notes, purchase_org_code, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          poId,
          poNo,
          supplierId,
          supplierName,
          subtotalSen,
          subtotalSen,
          status,
          body.orderDate ?? today,
          body.expectedDate ?? "",
          null,
          body.notes ?? "",
          purchaseOrgCode,
          now,
          now,
        ),
        ...items.map((item, itemIdx) =>
          c.var.DB.prepare(
            `INSERT INTO purchase_order_items (id, purchaseOrderId,
               materialCategory, material_code, materialName, supplierSKU, quantity,
               unitPriceSen, totalSen, receivedQty, unit, line_no)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            item.id,
            poId,
            item.materialCategory,
            item.materialCode,
            item.materialName,
            item.supplierSKU,
            item.quantity,
            item.unitPriceSen,
            item.totalSen,
            item.receivedQty,
            item.unit,
            itemIdx + 1,
          ),
        ),
      ];

      try {
        await c.var.DB.batch(statements);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (!isPoNoUniqueViolation(err)) {
          throw err;
        }
        // Re-scan to pick up whichever concurrent insert just won.
        poNo = await generatePoNo(c.var.DB);
      }
    }
    if (lastErr) {
      throw new Error(
        "PO number generation failed after 5 retries — concurrent insert storm",
      );
    }

    const created = await fetchPOWithItems(c.var.DB, poId);
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create purchase order" },
        500,
      );
    }
    // Audit emit (P3.4) — PO create. Snapshot the after-state for the journal.
    await emitAudit(c, {
      resource: "purchase-orders",
      resourceId: poId,
      action: "create",
      after: created,
    });

    // Multi-Company Phase 3 — inter-company mirror. If this PO's seller is a
    // SISTER group company (supplier flagged group + its org code != the buyer)
    // and the global auto-mirror config is ON, raise a mirror SALES ORDER under
    // that sister with HOOKKA as the customer. ADDITIVE + non-blocking: any
    // failure here is logged and swallowed so a normal PO create is never
    // affected, and external POs never reach the DB work (the pure decision in
    // intercompany-mirror.ts short-circuits). Idempotent via
    // intercompany_mirror_log — a re-save/retry never double-creates.
    try {
      const cfgRow = await c.var.DB
        .prepare("SELECT auto_create_mirror_docs FROM inter_company_config WHERE id = 1")
        .first<{ auto_create_mirror_docs?: number | boolean | null }>()
        .catch(() => null);
      const autoCreateMirrorDocs =
        cfgRow?.auto_create_mirror_docs === 1 ||
        cfgRow?.auto_create_mirror_docs === true;
      if (autoCreateMirrorDocs) {
        const mirrorResult = await createPurchaseOrderMirror(
          c.var.DB,
          {
            id: poId,
            poNo,
            orderDate: body.orderDate ?? today,
            purchaseOrgCode,
            supplier: {
              isGroupCompany:
                supplier.isGroupCompany === 1 ||
                supplier.isGroupCompany === true ||
                supplier.is_group_company === 1 ||
                supplier.is_group_company === true,
              groupOrgCode:
                supplier.groupOrgCode ?? supplier.group_org_code ?? null,
              name: supplier.name ?? supplierName ?? null,
            },
            items: items.map((it) => ({
              materialCode: it.materialCode,
              materialName: it.materialName,
              quantity: it.quantity,
              unitPriceSen: it.unitPriceSen,
            })),
          },
          { autoCreateMirrorDocs },
        );
        if (mirrorResult.created) {
          console.log(
            `[intercompany-mirror] PO ${poNo} (${poId}) → mirror SO ${mirrorResult.companySOId} (${mirrorResult.mirrorSoId})`,
          );
        }
      }
    } catch (mirrorErr) {
      // Never let a mirror failure break the PO create — log only.
      console.error(
        "[intercompany-mirror] mirror creation failed for PO",
        poId,
        mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr),
      );
    }

    return c.json({ success: true, data: created }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/purchase-orders] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json({ success: false, error: msg || "Internal error creating purchase order" }, 500);
  }
});

// GET /api/purchase-orders/:id — single PO + items + downstream documents
//
// Reverse links (owner 2026-08-01). grns.po_id and purchase_invoices.
// purchase_order_id both point AT this PO, so the relationship was only
// discoverable from the child. The PO detail page compensated by downloading
// the ENTIRE /api/grn and /api/purchase-invoices lists on every render and
// filtering client-side — two unbounded payloads to answer "what came off
// this PO". Both columns are already indexed (idx_grns_po_id,
// idx_purchase_invoices_purchase_order_id), so the reverse lookup here is two
// index seeks. Same `Promise.all` + `linkedX` shape as sales-orders.ts.
app.get("/:id", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "read");
  if (denied) return denied;
  const id = c.req.param("id");
  const [po, grnRes, piRes] = await Promise.all([
    fetchPOWithItems(c.var.DB, id),
    c.var.DB.prepare(
      `SELECT id, grnNumber, status, receiveDate, totalAmount
         FROM grns
        WHERE poId = ?
        ORDER BY grnNumber`,
    )
      .bind(id)
      .all<{
        id: string;
        grnNumber: string | null;
        status: string | null;
        receiveDate: string | null;
        totalAmount: number | null;
      }>(),
    c.var.DB.prepare(
      `SELECT id, piNo, status, invoiceDate, amountSen
         FROM purchase_invoices
        WHERE purchaseOrderId = ?
        ORDER BY piNo`,
    )
      .bind(id)
      .all<{
        id: string;
        piNo: string | null;
        status: string | null;
        invoiceDate: string | null;
        amountSen: number | null;
      }>(),
  ]);
  if (!po) {
    return c.json({ success: false, error: "Purchase order not found" }, 404);
  }
  return c.json({
    success: true,
    data: po,
    linkedGRNs: (grnRes.results ?? []).map((g) => ({
      id: g.id,
      grnNumber: g.grnNumber ?? "",
      status: g.status ?? "",
      receiveDate: g.receiveDate ?? null,
      totalAmount: g.totalAmount ?? 0,
    })),
    linkedPIs: (piRes.results ?? []).map((p) => ({
      id: p.id,
      piNo: p.piNo ?? "",
      status: p.status ?? "",
      invoiceDate: p.invoiceDate ?? null,
      amountSen: p.amountSen ?? 0,
    })),
  });
});

// PUT /api/purchase-orders/:id — update scalar fields + optionally replace items
app.put("/:id", async (c) => {
  // RBAC gate (P3.3-followup) — base check is purchase-orders:update.
  // Status transitions get stricter row-level checks below:
  //   • SUBMITTED → CONFIRMED  ⇒ purchase-orders:approve
  //   • *         → RECEIVED   ⇒ purchase-orders:receive
  //   • *         → PARTIAL_RECEIVED ⇒ purchase-orders:receive
  const baseDenied = await requirePermission(c, "purchase-orders", "update");
  if (baseDenied) return baseDenied;
  const id = c.req.param("id");
  // line_no column must exist before the item re-INSERTs below (self-apply).
  await ensurePoItemLineNo(c.var.DB);
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM purchase_orders WHERE id = ?",
    )
      .bind(id)
      .first<PurchaseOrderRow>();
    if (!existing) {
      return c.json(
        { success: false, error: "Purchase order not found" },
        404,
      );
    }
    const body = await c.req.json();
    const now = new Date().toISOString();

    // Lock supplier + line items once goods have been received against this PO.
    // A POSTED/CONFIRMED GRN has written rm_batches + cost_ledger against the
    // original supplier and prices; editing them here would desync stock/cost
    // from the document (and re-reading receivedQty from the body can even zero
    // it). Status / notes / date edits still flow through.
    const wantsSupplierChange =
      body.supplierId !== undefined && body.supplierId !== existing.supplierId;
    const wantsItemChange = body.items !== undefined;
    if (wantsSupplierChange || wantsItemChange) {
      const postedGrn = await c.var.DB.prepare(
        `SELECT id FROM grns WHERE poId = ? AND status IN ('POSTED','CONFIRMED') LIMIT 1`,
      )
        .bind(id)
        .first<{ id: string }>();
      if (postedGrn) {
        return c.json(
          {
            success: false,
            error: "This PO already has a posted goods receipt — its supplier and line items are locked. Reverse/cancel the GRN first.",
          },
          409,
        );
      }
    }

    // Status transition validation
    if (body.status && body.status !== existing.status) {
      const allowed = VALID_TRANSITIONS[existing.status] || [];
      if (!allowed.includes(body.status)) {
        return c.json(
          {
            success: false,
            error: `Cannot transition from ${existing.status} to ${body.status}. Allowed: ${allowed.join(", ") || "none"}`,
          },
          400,
        );
      }

      // Row-level RBAC for the high-impact status flips.
      if (existing.status === "SUBMITTED" && body.status === "CONFIRMED") {
        const denied = await requirePermission(c, "purchase-orders", "approve");
        if (denied) return denied;
      }
      if (body.status === "RECEIVED" || body.status === "PARTIAL_RECEIVED") {
        const denied = await requirePermission(c, "purchase-orders", "receive");
        if (denied) return denied;
      }

      // 2.3 — Block direct PO→RECEIVED unless a POSTED GRN exists. The
      // previous behaviour auto-created an empty DRAFT GRN here as a
      // cascade, but that's worse than useful: it lets operators flip
      // RECEIVED without ever posting receipts to inventory, leaving
      // rm_batches + cost_ledger empty. Now: requires the operator to
      // create + post a GRN first. CONFIRMED is treated as committed
      // for this check (rare but legal — see grn.ts COMMITTED_STATUSES).
      if (body.status === "RECEIVED") {
        const postedGrn = await c.var.DB.prepare(
          `SELECT id FROM grns
            WHERE poId = ?
              AND status IN ('POSTED','CONFIRMED')
            LIMIT 1`,
        )
          .bind(id)
          .first<{ id: string }>();
        if (!postedGrn) {
          return c.json(
            {
              success: false,
              error: "Create + post a GRN before marking received",
              requiresGrn: true,
            },
            412,
          );
        }
      }
    }

    const statements: D1PreparedStatement[] = [];
    let subtotalSen = existing.subtotalSen;
    let totalSen = existing.totalSen;

    // If items provided, replace them entirely and recompute totals
    if (body.items !== undefined) {
      const rawItems: Array<Record<string, unknown>> = Array.isArray(body.items)
        ? body.items
        : [];
      for (let i = 0; i < rawItems.length; i++) {
        const q = Number(rawItems[i].quantity);
        const p = Number(rawItems[i].unitPriceSen);
        if (!Number.isFinite(q) || q < 0) {
          return c.json({ success: false, error: `items[${i}]: quantity must be a number >= 0` }, 400);
        }
        if (!Number.isFinite(p) || p < 0) {
          return c.json({ success: false, error: `items[${i}]: unitPriceSen must be a number >= 0` }, 400);
        }
      }
      const newItems = rawItems.map((item) => {
        const quantity = Number(item.quantity) || 0;
        const unitPriceSen = Number(item.unitPriceSen) || 0;
        return {
          id: (item.id as string) || genItemId(),
          materialCategory: (item.materialCategory as string) ?? "",
          materialCode: (item.materialCode as string) ?? "",
          materialName: (item.materialName as string) ?? "",
          supplierSKU: (item.supplierSKU as string) ?? "",
          quantity,
          unitPriceSen,
          totalSen: quantity * unitPriceSen,
          receivedQty: Number(item.receivedQty) || 0,
          unit: (item.unit as string) ?? "pcs",
        };
      });

      statements.push(
        c.var.DB.prepare(
          "DELETE FROM purchase_order_items WHERE purchaseOrderId = ?",
        ).bind(id),
      );
      let putLineNo = 0;
      for (const item of newItems) {
        putLineNo += 1;
        statements.push(
          c.var.DB.prepare(
            `INSERT INTO purchase_order_items (id, purchaseOrderId,
               materialCategory, material_code, materialName, supplierSKU, quantity,
               unitPriceSen, totalSen, receivedQty, unit, line_no)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            item.id,
            id,
            item.materialCategory,
            item.materialCode,
            item.materialName,
            item.supplierSKU,
            item.quantity,
            item.unitPriceSen,
            item.totalSen,
            item.receivedQty,
            item.unit,
            putLineNo,
          ),
        );
      }
      subtotalSen = body.subtotalSen ?? newItems.reduce((s, i) => s + i.totalSen, 0);
      totalSen = body.totalSen ?? subtotalSen;
    } else {
      subtotalSen = body.subtotalSen ?? existing.subtotalSen;
      totalSen = body.totalSen ?? existing.totalSen;
    }

    const existingOrgCode =
      existing.purchaseOrgCode ?? existing.purchase_org_code ?? "HOOKKA";
    const merged = {
      supplierId: body.supplierId ?? existing.supplierId,
      supplierName: body.supplierName ?? existing.supplierName ?? "",
      status: body.status ?? existing.status,
      orderDate: body.orderDate ?? existing.orderDate ?? "",
      expectedDate: body.expectedDate ?? existing.expectedDate ?? "",
      receivedDate:
        body.receivedDate !== undefined
          ? body.receivedDate
          : existing.receivedDate,
      notes: body.notes ?? existing.notes ?? "",
      purchaseOrgCode:
        typeof body.purchaseOrgCode === "string" && body.purchaseOrgCode.trim()
          ? body.purchaseOrgCode.trim()
          : existingOrgCode,
    };

    statements.push(
      c.var.DB.prepare(
        `UPDATE purchase_orders SET
           supplierId = ?, supplierName = ?, subtotalSen = ?, totalSen = ?,
           status = ?, orderDate = ?, expectedDate = ?, receivedDate = ?,
           notes = ?, purchase_org_code = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(
        merged.supplierId,
        merged.supplierName,
        subtotalSen,
        totalSen,
        merged.status,
        merged.orderDate,
        merged.expectedDate,
        merged.receivedDate,
        merged.notes,
        merged.purchaseOrgCode,
        now,
        id,
      ),
    );

    // 2.3 — Procurement cascade removed (formerly auto-created an empty
    // DRAFT GRN on PO→RECEIVED). The pre-flight check above now requires
    // a POSTED GRN before RECEIVED is allowed at all, so the auto-create
    // cascade was a no-op in practice and misleading in code: removed
    // to keep the receipt path single-sourced through grn.ts.

    await c.var.DB.batch(statements);

    // Sprint 4: enqueue supplier notification on the DRAFT/etc → SUBMITTED
    // transition. The cron drain (.github/workflows/process-email-outbox.yml)
    // is what actually contacts Resend, so a Resend outage doesn't backpressure
    // the PO submit. Failures (no email on file, INSERT failure) are logged
    // only and never roll back the PO update.
    if (body.status === "SUBMITTED" && existing.status !== "SUBMITTED") {
      try {
        const supplierRow = await c.var.DB.prepare(
          "SELECT email FROM suppliers WHERE id = ? LIMIT 1",
        )
          .bind(merged.supplierId)
          .first<{ email: string | null }>();
        if (supplierRow?.email) {
          const tpl = supplierPoEmailTemplate({
            poNo: existing.poNo,
            supplierName: merged.supplierName,
          });
          await enqueueEmail(c, {
            to: supplierRow.email,
            subject: tpl.subject,
            html: tpl.html,
            text: tpl.text,
          });
        } else {
          console.log(
            `[purchase-orders] PO ${existing.poNo}: skipped — supplier ${merged.supplierName} (${merged.supplierId}) has no email on file`,
          );
        }
      } catch (err) {
        console.warn(
          "[purchase-orders] supplier notification failed",
          err instanceof Error ? err.message : err,
        );
      }
    }

    const updated = await fetchPOWithItems(c.var.DB, id);
    // PO create was audited but the edit path was not, even though this same
    // handler drives the status transitions that commit us to buying (SUBMITTED
    // → CONFIRMED → RECEIVED) and can rewrite supplier, prices and line items.
    // Snapshot both sides so a changed unit price or a re-pointed supplier is
    // traceable to who did it.
    await emitAudit(c, {
      resource: "purchase-orders",
      resourceId: id,
      action: "update",
      before: existing,
      after: updated,
    });
    return c.json({ success: true, data: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[PUT /api/purchase-orders/:id] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json({ success: false, error: msg || "Internal error updating purchase order" }, 500);
  }
});

// 3.1 — Self-applying migration for the lastEmailedAt column. Same module-
// level promise pattern as sales-orders.ts:1531. Idempotent ALTER so the
// column appears on first POST per isolate without a separate migration
// deploy. Translated by supabase-compat: lastEmailedAt → last_emailed_at
// (added to column-rename-map.json).
//
// 5.3 — additionally creates the UNIQUE index ux_purchase_orders_po_no so
// concurrent POSTs collide cleanly instead of double-issuing the same
// poNo. CREATE UNIQUE INDEX IF NOT EXISTS is idempotent on Postgres + D1.
// IMPORTANT: this will fail loudly on first run if duplicate poNos already
// exist on the table — that's intentional. The probe at GET
// /api/import/po-no-duplicates must return zero before this rolls out;
// otherwise the catch below swallows the error (best-effort) and the
// subsequent INSERT will keep working without uniqueness protection. To
// detect that case, call the probe explicitly before relying on retry
// behaviour.
let pendingMigrations: Promise<void> | null = null;
function ensurePendingMigrations(db: D1Database): Promise<void> {
  if (pendingMigrations) return pendingMigrations;
  pendingMigrations = (async () => {
    const stmts = [
      "ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS lastEmailedAt TEXT",
      // 5.3 — concurrency guard for generatePoNo. The retry wrapper in
      // POST / depends on this index existing.
      "CREATE UNIQUE INDEX IF NOT EXISTS ux_purchase_orders_po_no ON purchase_orders(poNo)",
      // 0181 — real material_code column so new POs don't mash code into name.
      "ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS material_code TEXT",
      // 0200 — per-document purchase company override. Defaulted from the
      // supplier on create; never null in writes (HOOKKA fallback).
      "ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS purchase_org_code TEXT",
      "UPDATE purchase_orders SET purchase_org_code = 'HOOKKA' WHERE purchase_org_code IS NULL",
      // Multi-Company Phase 3 — dual-identity link on the supplier side. A
      // supplier that IS one of our group companies carries its org code here
      // (snake_case, default '' = a normal external supplier → nothing changes).
      // Paired with customers.group_org_code (ensured in customers.ts). This is
      // what lets the PO→SO mirror know the seller is a sister group company.
      "ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS group_org_code TEXT NOT NULL DEFAULT ''",
    ];
    for (const sql of stmts) {
      try {
        await db.prepare(sql).run();
      } catch (err) {
        console.warn(
          "[purchase-orders] migration: CREATE UNIQUE INDEX failed " +
            "(usually means duplicate poNos exist — run /api/import/po-no-duplicates to investigate). " +
            "Worker will continue without uniqueness enforcement.",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  })();
  return pendingMigrations;
}

// POST /api/purchase-orders/:id/email — manual "Email to Supplier" send.
// Reuses the same enqueueEmail flow as the auto-cascade on DRAFT→SUBMITTED
// (line ~488 above). The cron drain (.github/workflows/process-email-outbox.yml)
// is what actually contacts Resend, so this returns immediately on the
// outbox INSERT — no Resend round-trip on the user's request thread.
//
// Visible on SUBMITTED+ statuses (gate enforced at the FE; backend is
// permissive — even DRAFT can be emailed manually if a permission grant
// reaches here).
app.post("/:id/email", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "update");
  if (denied) return denied;
  await ensurePendingMigrations(c.var.DB);

  const id = c.req.param("id");
  const po = await c.var.DB
    .prepare("SELECT * FROM purchase_orders WHERE id = ?")
    .bind(id)
    .first<PurchaseOrderRow>();
  if (!po) {
    return c.json({ success: false, error: "Purchase order not found" }, 404);
  }

  const supplierRow = await c.var.DB
    .prepare("SELECT email FROM suppliers WHERE id = ? LIMIT 1")
    .bind(po.supplierId)
    .first<{ email: string | null }>();
  if (!supplierRow?.email) {
    return c.json(
      {
        success: false,
        error: `Supplier ${po.supplierName ?? po.supplierId} has no email on file`,
      },
      400,
    );
  }

  try {
    const tpl = supplierPoEmailTemplate({
      poNo: po.poNo,
      supplierName: po.supplierName ?? "",
    });
    await enqueueEmail(c, {
      to: supplierRow.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    });
    const now = new Date().toISOString();
    await c.var.DB
      .prepare(
        "UPDATE purchase_orders SET lastEmailedAt = ?, updated_at = ? WHERE id = ?",
      )
      .bind(now, now, id)
      .run();
    return c.json({
      success: true,
      data: { lastEmailedAt: now, to: supplierRow.email },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/purchase-orders/:id/email] failed:", msg, err);
    return c.json(
      { success: false, error: msg || "Failed to enqueue email" },
      500,
    );
  }
});

// DELETE /api/purchase-orders/:id — cascades to items via FK
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await fetchPOWithItems(c.var.DB, id);
  if (!existing) {
    return c.json({ success: false, error: "Purchase order not found" }, 404);
  }
  await c.var.DB.prepare("DELETE FROM purchase_orders WHERE id = ?")
    .bind(id)
    .run();

  // The delete cascades to purchase_order_items via FK, so the whole document —
  // supplier, prices, quantities — is destroyed in one statement with nothing
  // left behind. This event is the only surviving copy; snapshot the full
  // pre-state including items, not just the id.
  await emitAudit(c, {
    resource: "purchase-orders",
    resourceId: id,
    action: "delete",
    before: existing,
  });
  return c.json({ success: true, data: existing });
});

export default app;
