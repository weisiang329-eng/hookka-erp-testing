// ---------------------------------------------------------------------------
// intercompany-mirror-create.ts — Multi-Company Phase 3 DB side of the mirror.
//
// Given a Purchase Order that names a SISTER group company as the seller, this
// creates the mirror SALES ORDER under that sister company (one company's PO ⟷
// the other's SO). The PURE decision (does it fire / which sister) lives in
// src/lib/intercompany-mirror.ts; this file does only the DB work:
//
//   1. ensureMirrorLog — create the idempotency guard table (runtime self-apply,
//      like every other Phase 2/3 column; deploy does NOT replay migrations).
//   2. createPurchaseOrderMirror — idempotently insert one mirror SO:
//        • claim the (source_type, source_id) slot in intercompany_mirror_log
//          via INSERT ... ON CONFLICT DO NOTHING. If the slot was already taken
//          (a retry / re-save), we SKIP — never a second mirror SO. This is the
//          idempotency guard.
//        • resolve the buyer (HOOKKA) as a CUSTOMER of the sister company so the
//          mirror SO has a real customer row. If no such customer exists we SKIP
//          and record why (no back-door customer creation — surface the gap).
//        • insert a slim mirror SO + its lines, copying the PO lines 1:1
//          (quantity + unitPriceSen in sen). Booked under sales_org_code = the
//          sister company. status DRAFT — a document record, NOT a production
//          trigger (no BOM explosion / job cards; those belong to a real SO).
//
// NON-BLOCKING: the caller wraps this in try/catch and NEVER lets a mirror
// failure fail the PO create. External POs never reach here (the pure decision
// short-circuits). The existing DO/Invoice customer auto-send is untouched.
//
// TODO(intercompany-pnl-elimination): the mirror SO records the intra-group
// sale at PO cost. Consolidated group P&L must later ELIMINATE this intra-group
// revenue/COGS pair so a transfer between sisters is not double-counted as group
// profit. Not done here — see src/lib/intercompany-mirror.ts scope note.
//
// TODO(grn-mirror): mirror the goods-receipt (GRN) the same way (a sister's PO
// receipt ⟷ our delivery/dispatch). Deferred — GRN posts stock + cost ledger,
// so its mirror needs an inventory-safe design; the PO⟷SO document mirror here
// is the safe, side-effect-free foundation to build that on.
// ---------------------------------------------------------------------------

import {
  decidePurchaseOrderMirror,
  DEFAULT_COMPANY_CODE,
} from "../../lib/intercompany-mirror";
import { normalizeCompanyName } from "../../lib/company-name-match";

export type MirrorResult =
  | { created: false; reason: string; mirrorSoId?: undefined }
  | { created: true; reason: "created"; mirrorSoId: string; companySOId: string };

let mirrorLogPromise: Promise<void> | null = null;

/**
 * Idempotency guard table. UNIQUE (source_type, source_id) is what makes a
 * retry a no-op: the second attempt to claim the same source loses the
 * ON CONFLICT race and we skip creating a duplicate mirror. Runtime self-apply
 * (deploy does not replay migration files).
 */
export function ensureMirrorLog(db: D1Database): Promise<void> {
  if (mirrorLogPromise) return mirrorLogPromise;
  mirrorLogPromise = (async () => {
    const stmts = [
      `CREATE TABLE IF NOT EXISTS intercompany_mirror_log (
         id text PRIMARY KEY,
         org_id text NOT NULL DEFAULT 'hookka',
         source_type text NOT NULL,
         source_id text NOT NULL,
         mirror_type text NOT NULL,
         mirror_id text NOT NULL,
         sister_org_code text NOT NULL,
         buyer_org_code text NOT NULL,
         created_at text
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS intercompany_mirror_log_source_uniq
         ON intercompany_mirror_log (source_type, source_id)`,
    ];
    for (const sql of stmts) {
      try {
        await db.prepare(sql).run();
      } catch {
        // best-effort; table/index may already exist
      }
    }
  })();
  return mirrorLogPromise;
}

type GroupOrgRow = { code: string; name: string };

async function loadGroupOrgs(db: D1Database): Promise<GroupOrgRow[]> {
  try {
    // No WHERE on is_active (boolean vs int varies by env) — fetch all and let
    // the name-match uniqueness do the filtering. The registry is tiny.
    const res = await db
      .prepare("SELECT code, name FROM organisations")
      .all<GroupOrgRow>();
    return (res.results ?? []).filter((o) => o && o.code);
  } catch {
    return [];
  }
}

/**
 * Resolve HOOKKA (the buyer) as a CUSTOMER row of the sister company so the
 * mirror SO has a real customer. We match by the buyer org's registered name
 * against the customers table (tolerant, Sdn Bhd-agnostic). We do NOT create a
 * customer here (no back-door writes) — if the buyer isn't in the customer
 * catalog the caller records the gap and skips.
 */
async function resolveBuyerAsCustomer(
  db: D1Database,
  buyerOrgCode: string,
  groupOrgs: GroupOrgRow[],
): Promise<{ id: string; name: string } | null> {
  const buyerOrg = groupOrgs.find(
    (o) => o.code.trim().toUpperCase() === buyerOrgCode,
  );
  const buyerName = buyerOrg?.name ?? buyerOrgCode;
  const target = normalizeCompanyName(buyerName);
  if (!target) return null;
  let custs: Array<{ id: string; name: string }> = [];
  try {
    const res = await db
      .prepare("SELECT id, name FROM customers")
      .all<{ id: string; name: string }>();
    custs = res.results ?? [];
  } catch {
    return null;
  }
  let hit: { id: string; name: string } | null = null;
  for (const cu of custs) {
    if (normalizeCompanyName(cu.name) === target) {
      if (hit) return null; // ambiguous — refuse to guess
      hit = cu;
    }
  }
  return hit;
}

function genSoId(): string {
  return `so-${crypto.randomUUID().slice(0, 8)}`;
}
function genItemId(): string {
  return `soi-${crypto.randomUUID().slice(0, 8)}`;
}
function genLogId(): string {
  return `icm-${crypto.randomUUID().slice(0, 8)}`;
}

async function nextMirrorCompanySOId(
  db: D1Database,
  orderDate: string | null,
): Promise<string> {
  let yymm: string;
  const m =
    typeof orderDate === "string" ? orderDate.match(/^(\d{4})-(\d{2})/) : null;
  if (m) {
    yymm = `${m[1].slice(2)}${m[2]}`;
  } else {
    const now = new Date();
    yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  }
  const prefix = `SO-${yymm}-`;
  const res = await db
    .prepare(
      "SELECT companySOId FROM sales_orders WHERE companySOId LIKE ? ORDER BY companySOId DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ companySOId: string }>();
  const seq = res?.companySOId
    ? Number(res.companySOId.split("-").pop()) + 1
    : 1;
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

export type PoForMirror = {
  id: string;
  poNo: string;
  orderDate: string | null;
  purchaseOrgCode: string | null;
  supplier: {
    isGroupCompany: boolean;
    groupOrgCode?: string | null;
    name?: string | null;
  };
  items: Array<{
    materialCode?: string | null;
    materialName?: string | null;
    quantity: number;
    unitPriceSen: number;
  }>;
};

/**
 * Idempotently create the mirror SO for a PO whose supplier is a sister group
 * company. Returns a MirrorResult describing what happened (created / skipped +
 * why). NEVER throws for a business-rule skip — the caller treats any throw as a
 * non-fatal mirror failure and continues.
 */
export async function createPurchaseOrderMirror(
  db: D1Database,
  po: PoForMirror,
  cfg: { autoCreateMirrorDocs: boolean },
): Promise<MirrorResult> {
  const groupOrgs = await loadGroupOrgs(db);
  const decision = decidePurchaseOrderMirror({
    autoCreateMirrorDocs: cfg.autoCreateMirrorDocs,
    purchaseOrgCode: po.purchaseOrgCode,
    supplier: po.supplier,
    groupOrgs,
  });
  if (!decision.mirror) {
    return { created: false, reason: "not-a-sister-company-po" };
  }

  await ensureMirrorLog(db);

  // Idempotency guard: claim the slot. If a mirror for this PO already exists
  // (retry / re-save), the ON CONFLICT loses and we skip — no duplicate SO.
  const mirrorSoId = genSoId();
  const now = new Date().toISOString();
  let claimed = false;
  try {
    const res = await db
      .prepare(
        `INSERT INTO intercompany_mirror_log
           (id, org_id, source_type, source_id, mirror_type, mirror_id,
            sister_org_code, buyer_org_code, created_at)
         VALUES (?, 'hookka', 'PO', ?, 'SO', ?, ?, ?, ?)
         ON CONFLICT (source_type, source_id) DO NOTHING`,
      )
      .bind(
        genLogId(),
        po.id,
        mirrorSoId,
        decision.sisterOrgCode,
        decision.buyerOrgCode,
        now,
      )
      .run();
    const changes =
      (res as unknown as { meta?: { changes?: number }; rowCount?: number })
        .meta?.changes ??
      (res as unknown as { rowCount?: number }).rowCount ??
      0;
    claimed = changes > 0;
  } catch {
    // If the log write itself failed, don't risk a duplicate — skip.
    return { created: false, reason: "mirror-log-write-failed" };
  }
  if (!claimed) {
    return { created: false, reason: "already-mirrored" };
  }

  // Resolve the buyer (HOOKKA) as a customer of the sister so the mirror SO has
  // a real customer. No back-door customer creation — skip + surface the gap.
  const buyerCustomer = await resolveBuyerAsCustomer(
    db,
    decision.buyerOrgCode,
    groupOrgs,
  );
  if (!buyerCustomer) {
    // Release the claim so a later run (after the customer is added) can retry.
    try {
      await db
        .prepare(
          "DELETE FROM intercompany_mirror_log WHERE source_type = 'PO' AND source_id = ?",
        )
        .bind(po.id)
        .run();
    } catch {
      /* best-effort release */
    }
    return { created: false, reason: "buyer-not-in-sister-customer-catalog" };
  }

  const items = po.items.map((it, i) => {
    const quantity = Number(it.quantity) || 0;
    const unitPriceSen = Math.round(Number(it.unitPriceSen) || 0);
    return {
      id: genItemId(),
      lineNo: i + 1,
      productCode: it.materialCode ?? "",
      productName: it.materialName ?? "",
      quantity,
      unitPriceSen,
      lineTotalSen: quantity * unitPriceSen,
    };
  });
  const subtotalSen = items.reduce((s, it) => s + it.lineTotalSen, 0);
  const companySOId = await nextMirrorCompanySOId(db, po.orderDate);
  const today = now.split("T")[0];
  const notes = `Inter-company mirror of ${po.purchaseOrgCode ?? DEFAULT_COMPANY_CODE} purchase order ${po.poNo} (${po.id}). Auto-generated — Multi-Company Phase 3.`;

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO sales_orders (id, customerPO, customerPOId, customerPODate,
           customerSO, customerSOId, reference, customerId, customerName,
           customerState, hubId, hubName, companySO, companySOId, companySODate,
           customerDeliveryDate, hookkaExpectedDD, hookkaDeliveryOrder,
           subtotalSen, totalSen, status, overdue, notes,
           customerPOImageB64, is_service_order, caseid, sales_org_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        mirrorSoId,
        po.poNo, // customerPO — the sister sees Hookka's PO number as the customer PO
        po.poNo, // customerPOId
        po.orderDate ?? today,
        "", // customerSO
        "", // customerSOId
        po.poNo, // reference
        buyerCustomer.id,
        buyerCustomer.name,
        "", // customerState
        null, // hubId
        null, // hubName
        `Sales Order ${companySOId.split("-").pop()}`,
        companySOId,
        po.orderDate ?? today,
        "", // customerDeliveryDate
        "", // hookkaExpectedDD
        "", // hookkaDeliveryOrder
        subtotalSen,
        subtotalSen,
        "DRAFT",
        "PENDING",
        notes,
        null, // customerPOImageB64
        0, // is_service_order
        null, // caseid
        decision.sisterOrgCode,
        now,
        now,
      ),
    ...items.map((item) =>
      db
        .prepare(
          `INSERT INTO sales_order_items (id, salesOrderId, lineNo, lineSuffix,
             productId, productCode, productName, itemCategory, sizeCode, sizeLabel,
             fabricCode, quantity, gapInches, divanHeightInches,
             divanPriceSen, legHeightInches, legPriceSen, specialOrder,
             specialOrderPriceSen, customSpecials, basePriceSen, unitPriceSen, discountSen, lineTotalSen, notes, repairScope)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          item.id,
          mirrorSoId,
          item.lineNo,
          "", // lineSuffix
          "", // productId
          item.productCode,
          item.productName,
          "ACCESSORY", // itemCategory — mirror lines are raw material lines, not sofa/bedframe
          "", // sizeCode
          "", // sizeLabel
          "", // fabricCode
          item.quantity,
          0, // gapInches
          0, // divanHeightInches
          0, // divanPriceSen
          0, // legHeightInches
          0, // legPriceSen
          0, // specialOrder
          0, // specialOrderPriceSen
          null, // customSpecials
          item.unitPriceSen, // basePriceSen
          item.unitPriceSen,
          0, // discountSen
          item.lineTotalSen,
          "", // notes
          null, // repairScope
        ),
    ),
  ];

  try {
    await db.batch(statements);
  } catch (e) {
    // Insert failed after claiming the slot — release the claim so a retry can
    // rebuild the mirror cleanly, then re-throw so the caller logs it.
    try {
      await db
        .prepare(
          "DELETE FROM intercompany_mirror_log WHERE source_type = 'PO' AND source_id = ?",
        )
        .bind(po.id)
        .run();
    } catch {
      /* best-effort release */
    }
    throw e;
  }

  return {
    created: true,
    reason: "created",
    mirrorSoId,
    companySOId,
  };
}
