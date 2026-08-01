// ---------------------------------------------------------------------------
// sales-orders route — module-level helpers.
//
// Mechanically split out of src/api/routes/sales-orders.ts (behavior-preserving;
// every declaration below is verbatim from the route module — only `export`
// prefixes, one-level-deeper relative import paths, and this header were added).
// The route module re-exports the ones external importers / tests depend on.
// ---------------------------------------------------------------------------
import { readCompanyCode } from "../../../lib/company-dimension";
import {
  createProductionOrdersForOrder,
  type CreatedProductionOrder,
} from "../_shared/production-builder";
import { breakBomIntoWips } from "../../lib/bom-wip-breakdown";
import {
  parseRepairScope,
  serializeRepairScope,
  canonicalizeComponentPicks,
} from "../../../lib/repair-scope";

export type SalesOrderRow = {
  id: string;
  customerPO: string | null;
  customerPOId: string | null;
  customerPODate: string | null;
  customerSO: string | null;
  customerSOId: string | null;
  reference: string | null;
  customerId: string;
  customerName: string;
  customerState: string | null;
  hubId: string | null;
  hubName: string | null;
  companySO: string | null;
  companySOId: string | null;
  companySODate: string | null;
  customerDeliveryDate: string | null;
  hookkaExpectedDD: string | null;
  hookkaDeliveryOrder: string | null;
  subtotalSen: number;
  totalSen: number;
  status: string;
  overdue: string | null;
  notes: string | null;
  // Base64-encoded PNG of the original customer PO page(s) when this SO was
  // created from a Scan PO upload. Nullable — populated only by PO_SCAN_CLAUDE.
  customerPOImageB64: string | null;
  // Service-Order flag — 0134. TRUE marks this SO as an aftersales Service
  // Order (companySOId prefix `SV-...`, hidden from the normal Sales Orders
  // list, excluded from revenue later). FALSE = normal customer SO. The
  // column is NOT NULL DEFAULT FALSE in the DB; the type is nullable here
  // so old serialized rows / partial selects don't choke on absent values.
  isServiceOrder: boolean | null;
  // ON HOLD reason capture (0185). Snake_case DB columns hold_reason / held_by
  // / held_at; db-pg `toCamel` exposes them on SELECT * rows as holdReason /
  // heldBy / heldAt (true snake_case folds cleanly). Both keys typed for
  // dual-key safety. NULL on every order that is not (or was never) on hold.
  holdReason?: string | null;
  hold_reason?: string | null;
  heldBy?: string | null;
  held_by?: string | null;
  heldAt?: string | null;
  held_at?: string | null;
  // Multi-Company Phase 2 — the company this SO is booked under
  // (HOOKKA / OHANA / …). snake_case DB column; db-pg toCamel folds it to
  // salesOrgCode on SELECT *, so both keys are typed for dual-key reads.
  salesOrgCode?: string | null;
  sales_org_code?: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type SalesOrderItemRow = {
  id: string;
  salesOrderId: string;
  lineNo: number;
  lineSuffix: string | null;
  productId: string | null;
  productCode: string | null;
  productName: string | null;
  itemCategory: string | null;
  sizeCode: string | null;
  sizeLabel: string | null;
  fabricCode: string | null;
  quantity: number;
  gapInches: number | null;
  divanHeightInches: number | null;
  divanPriceSen: number;
  legHeightInches: number | null;
  legPriceSen: number;
  specialOrder: string | null;
  specialOrderPriceSen: number;
  totalHeightPriceSen: number;
  // Free-text custom specials per line. Stored as JSON string of
  // Array<{ description: string; surchargeSen: number }>. NULL/empty when
  // the operator hasn't attached any. The aggregate surcharge is folded
  // into specialOrderPriceSen at write time and the descriptions are
  // suffixed into `specialOrder` as "OTHER: <desc>" tokens so legacy
  // readers (DO print, invoice, detail page) still see the full list.
  // See migration 0074.
  customSpecials: string | null;
  basePriceSen: number;
  unitPriceSen: number;
  lineTotalSen: number;
  // Per-line discount (migration 0179). snake_case DB column `discount_sen`
  // mapped via column-rename-map.json → reads back as `discountSen`.
  discountSen: number;
  notes: string | null;
  // Service-order Repair Scope (0160). JSON
  // {"preset":"FULL|FABRIC|FRAME|FOAM|CUSTOM","depts":[...]} or NULL
  // (= FULL). Runtime-added column → Postgres folds the unquoted camelCase
  // ALTER to lowercase, so SELECT * rows carry the `repairscope` key
  // (BUG-2026-06-11-007). ALWAYS read dual-key:
  // `r.repairScope ?? r.repairscope`.
  repairScope?: string | null;
  repairscope?: string | null;
};

export type SOStatusChangeRow = {
  id: string;
  soId: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  changedBy: string | null;
  timestamp: string;
  notes: string | null;
  autoActions: string | null;
};

export type PriceOverrideRow = {
  id: string;
  soId: string | null;
  soNumber: string | null;
  lineIndex: number;
  originalPrice: number;
  overridePrice: number;
  reason: string | null;
  approvedBy: string | null;
  timestamp: string;
};

// Parse the customSpecials JSON column into a plain array. Always returns
// an array — invalid JSON / non-array shapes fall back to [] so the
// frontend can iterate without null checks. See migration 0074.
export function parseCustomSpecials(
  raw: string | null,
): Array<{ description: string; surchargeSen: number }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is { description: string; surchargeSen: number } =>
          !!e &&
          typeof e === "object" &&
          typeof (e as { description?: unknown }).description === "string" &&
          typeof (e as { surchargeSen?: unknown }).surchargeSen === "number",
      )
      .map((e) => ({
        description: e.description,
        surchargeSen: e.surchargeSen,
      }));
  } catch {
    return [];
  }
}

// Sanitize an incoming `customSpecials` payload from a POST/PUT body. Drops
// entries with empty descriptions, coerces surchargeSen to a non-negative
// integer, and returns the cleaned list. Non-array input → [].
export type IncomingCustomSpecial = { description: string; surchargeSen: number };
export function sanitizeCustomSpecials(raw: unknown): IncomingCustomSpecial[] {
  if (!Array.isArray(raw)) return [];
  const out: IncomingCustomSpecial[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const obj = e as Record<string, unknown>;
    const desc =
      typeof obj.description === "string" ? obj.description.trim() : "";
    if (!desc) continue;
    const surcharge = Number(obj.surchargeSen);
    out.push({
      description: desc,
      surchargeSen: Number.isFinite(surcharge) && surcharge > 0
        ? Math.round(surcharge)
        : 0,
    });
  }
  return out;
}

// Serialize the cleaned customSpecials list for storage. Returns null when
// the list is empty so the column stays NULL rather than '"[]"' — keeps
// legacy reads (and the parser) cheap.
export function serializeCustomSpecials(list: IncomingCustomSpecial[]): string | null {
  return list.length === 0 ? null : JSON.stringify(list);
}

export function rowToItem(r: SalesOrderItemRow) {
  return {
    id: r.id,
    lineNo: r.lineNo,
    lineSuffix: r.lineSuffix ?? `-${String(r.lineNo).padStart(2, "0")}`,
    productId: r.productId ?? "",
    productCode: r.productCode ?? "",
    productName: r.productName ?? "",
    itemCategory: r.itemCategory ?? "BEDFRAME",
    sizeCode: r.sizeCode ?? "",
    sizeLabel: r.sizeLabel ?? "",
    fabricCode: r.fabricCode ?? "",
    quantity: r.quantity,
    gapInches: r.gapInches,
    divanHeightInches: r.divanHeightInches,
    divanPriceSen: r.divanPriceSen,
    legHeightInches: r.legHeightInches,
    legPriceSen: r.legPriceSen,
    specialOrder: r.specialOrder ?? "",
    specialOrderPriceSen: r.specialOrderPriceSen,
    totalHeightPriceSen: r.totalHeightPriceSen ?? 0,
    // Hand the parsed array to the frontend, not the raw JSON string.
    // The form pages mutate this list directly; serialization back to
    // JSON happens on the POST/PUT path.
    customSpecials: parseCustomSpecials(r.customSpecials),
    basePriceSen: r.basePriceSen,
    unitPriceSen: r.unitPriceSen,
    lineTotalSen: r.lineTotalSen,
    // Per-line discount (migration 0179). Default 0 for rows predating the column.
    discountSen: r.discountSen ?? 0,
    notes: r.notes ?? "",
    // Repair Scope (0160) — dual-key read; runtime-added column comes back
    // as the folded-lowercase key on SELECT * rows.
    repairScope: r.repairScope ?? r.repairscope ?? null,
  };
}

export function rowToSO(row: SalesOrderRow, items: SalesOrderItemRow[] = []) {
  return {
    id: row.id,
    customerPO: row.customerPO ?? "",
    customerPOId: row.customerPOId ?? "",
    customerPODate: row.customerPODate ?? "",
    customerSO: row.customerSO ?? "",
    customerSOId: row.customerSOId ?? "",
    reference: row.reference ?? "",
    customerId: row.customerId,
    customerName: row.customerName,
    customerState: row.customerState ?? "",
    hubId: row.hubId,
    hubName: row.hubName ?? "",
    companySO: row.companySO ?? "",
    companySOId: row.companySOId ?? "",
    companySODate: row.companySODate ?? "",
    customerDeliveryDate: row.customerDeliveryDate ?? "",
    hookkaExpectedDD: row.hookkaExpectedDD ?? "",
    hookkaDeliveryOrder: row.hookkaDeliveryOrder ?? "",
    items: items
      .filter((i) => i.salesOrderId === row.id)
      .sort((a, b) => a.lineNo - b.lineNo)
      .map(rowToItem),
    subtotalSen: row.subtotalSen,
    totalSen: row.totalSen,
    status: row.status,
    overdue: row.overdue ?? "PENDING",
    notes: row.notes ?? "",
    customerPOImageB64: row.customerPOImageB64 ?? null,
    // Service-order flag — 0134. Default FALSE when missing because the
    // column default is FALSE; only rows explicitly created via the new
    // Service Order module flip this to true.
    isServiceOrder: row.isServiceOrder === true,
    // ON HOLD reason capture (0185). Dual-key read — true snake_case columns
    // come back as holdReason/heldBy/heldAt via toCamel, but read the raw
    // snake_case key too in case a SELECT bypasses the adapter. NULL → "" so
    // the detail page can render without null checks.
    holdReason: row.holdReason ?? row.hold_reason ?? "",
    heldBy: row.heldBy ?? row.held_by ?? "",
    heldAt: row.heldAt ?? row.held_at ?? "",
    // Multi-Company Phase 2 — company code (dual-keyed). Defaults to HOOKKA so
    // rows from before the column existed (or partial selects) render as Hookka.
    salesOrgCode: readCompanyCode(row.salesOrgCode, row.sales_org_code),
    createdAt: row.createdAt ?? "",
    updatedAt: row.updatedAt ?? "",
  };
}

// ---------------------------------------------------------------------------
// rowToSOList — list-endpoint variant of rowToSO (GET /api/sales-orders).
// Drops ONLY the per-SO base64 customerPOImageB64 scan image — by far the
// biggest item in the list payload, and something the list grid never shows.
// Line items are kept in FULL: the Sales Orders list page prints SO PDFs
// straight from the list row (generateSOPdf — context-menu "Print / Preview"
// + "Bulk Print PDF"), and that PDF needs every per-item price / spec field.
// The detail endpoints keep the complete rowToSO payload (image included).
// ---------------------------------------------------------------------------
export function rowToSOList(row: SalesOrderRow, items: SalesOrderItemRow[] = []) {
  return {
    ...rowToSO(row, items),
    customerPOImageB64: null,
  };
}

// ---------------------------------------------------------------------------
// soListToDeliveryRefs — GET /api/sales-orders?fields=delivery-refs projection.
//
// The Delivery page (src/pages/delivery/index.tsx) fetches the whole SO list
// for two joins onto DO / PO rows:
//   1. Customer PO/SO numbers + reference + hookkaExpectedDD (the DO payload
//      doesn't carry these) — the ref scalars below.
//   2. A per-SO {productCode → unitPriceSen} price map, so the PO-based
//      Planning / Pending Delivery tabs can compute a Sales Figure when the
//      exact server value (/api/delivery-orders/po-values) hasn't been resolved
//      for a PO yet (soPriceByProduct fallback in delivery/index.tsx).
//
// So this projects the SAME cached snapshot list down to those ref scalars PLUS
// a SLIM items array carrying ONLY {productCode, unitPriceSen} (same shape as
// ?fields=price-index). That drops the per-SO base64 scan image AND the ~22
// other fields on every line item — a >90% payload cut vs the full list — while
// keeping BOTH joins byte-identical. Kept pure + exported so it's unit-testable.
//
// The four ref columns are dual-keyed (*Id + plain) because the DO grid prefers
// the far-better-populated *Id columns and falls back to the plain ones — see
// the soRefMap builder in delivery/index.tsx. Both keys are carried through.
// ---------------------------------------------------------------------------
export type SOListRefLike = {
  id: string;
  companySOId?: string;
  customerId?: string;
  customerSO?: string;
  customerSOId?: string;
  customerPO?: string;
  customerPOId?: string;
  reference?: string;
  hookkaExpectedDD?: string;
  items?: Array<{ productCode?: string; unitPriceSen?: number }>;
};
export function soListToDeliveryRefs(list: SOListRefLike[]) {
  return list.map((s) => ({
    id: s.id,
    companySOId: s.companySOId ?? "",
    customerId: s.customerId,
    customerSO: s.customerSO ?? "",
    customerSOId: s.customerSOId ?? "",
    customerPO: s.customerPO ?? "",
    customerPOId: s.customerPOId ?? "",
    reference: s.reference ?? "",
    hookkaExpectedDD: s.hookkaExpectedDD ?? "",
    // Slim items — product code + unit price ONLY (the price-fallback join),
    // never the full ~24-field line the grid doesn't read here.
    items: (s.items ?? []).map((it) => ({
      productCode: it.productCode,
      unitPriceSen: it.unitPriceSen,
    })),
  }));
}

export function parseAutoActions(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export type IncompleteProduct = {
  productCode: string;
  productName: string;
  reason: string;
};

// BOM completeness guard: a product is confirm-incomplete when its ACTIVE
// bom_templates row is missing OR both wipComponents[] AND l1Processes[] are
// empty. Accessory SKUs (pillows) legitimately have empty wipComponents but
// at least one l1Process (FAB_CUT/FAB_SEW/PACKING), so those pass. Falls back
// to the most recent version if no ACTIVE row exists — mirrors the cascade's
// reverse-schedule lookup.
export async function findIncompleteBomProducts(
  db: D1Database,
  items: SalesOrderItemRow[],
): Promise<IncompleteProduct[]> {
  const incomplete: IncompleteProduct[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const productCode = item.productCode ?? "";
    if (!item.productId || !productCode) continue;
    if (seen.has(productCode)) continue;
    seen.add(productCode);

    let bomRow = await db
      .prepare(
        `SELECT wipComponents, l1Processes FROM bom_templates
           WHERE productCode = ? AND versionStatus = 'ACTIVE'
           ORDER BY effectiveFrom DESC LIMIT 1`,
      )
      .bind(productCode)
      .first<{ wipComponents: string | null; l1Processes: string | null }>();
    if (!bomRow) {
      bomRow = await db
        .prepare(
          `SELECT wipComponents, l1Processes FROM bom_templates
             WHERE productCode = ? ORDER BY effectiveFrom DESC LIMIT 1`,
        )
        .bind(productCode)
        .first<{ wipComponents: string | null; l1Processes: string | null }>();
    }

    const parseLen = (raw: string | null): number => {
      if (!raw) return 0;
      try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.length : 0;
      } catch {
        return 0;
      }
    };

    const isIncomplete =
      !bomRow ||
      (parseLen(bomRow.wipComponents) === 0 &&
        parseLen(bomRow.l1Processes) === 0);

    if (isIncomplete) {
      incomplete.push({
        productCode,
        productName: item.productName ?? productCode,
        reason: !bomRow
          ? "No BOM template exists"
          : "BOM has no WIP components and no FG-level processes",
      });
    }
  }
  return incomplete;
}

export function rowToStatusChange(r: SOStatusChangeRow) {
  return {
    id: r.id,
    soId: r.soId ?? "",
    fromStatus: r.fromStatus ?? "",
    toStatus: r.toStatus ?? "",
    changedBy: r.changedBy ?? "",
    timestamp: r.timestamp,
    notes: r.notes ?? "",
    autoActions: parseAutoActions(r.autoActions),
  };
}

export function rowToPriceOverride(r: PriceOverrideRow) {
  return {
    id: r.id,
    soId: r.soId ?? "",
    soNumber: r.soNumber ?? "",
    lineIndex: r.lineIndex,
    originalPrice: r.originalPrice,
    overridePrice: r.overridePrice,
    reason: r.reason ?? "",
    approvedBy: r.approvedBy ?? "",
    timestamp: r.timestamp,
  };
}

export function genSoId(): string {
  return `so-${crypto.randomUUID().slice(0, 8)}`;
}
export function genItemId(): string {
  return `soi-${crypto.randomUUID().slice(0, 8)}`;
}

// Sofa combo pass — moved to src/api/lib/sofa-combo-pass.ts (2026-06-11) so
// Sales Orders AND Consignment Orders run the identical renegotiation.
export function genStatusId(): string {
  return `sc-${crypto.randomUUID().slice(0, 8)}`;
}
export function genOverrideId(): string {
  return `po-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// SO-flavoured wrapper for the shared production-order builder. The bulk of
// the cascade logic (idempotency guard, BOM lookup, WIP breakdown, dept
// scheduling, INSERT statements for production_orders + job_cards) lives
// in `_shared/production-builder.ts` so the consignment-order path
// (consignments.ts) can drive the same pipeline without duplication.
//
// This wrapper exists for backward compatibility — every SO call site
// (line ~1909 confirm-handler, line ~2557 admin backfill) keeps the same
// signature it had before the refactor. New CO call sites should call
// `createProductionOrdersForOrder` directly with `sourceType: 'CO'`.
// ---------------------------------------------------------------------------
export async function createProductionOrdersForSO(
  db: D1Database,
  so: SalesOrderRow,
  items: SalesOrderItemRow[],
  opts: { forceRebuild?: boolean; appendOnly?: boolean } = {},
): Promise<{ statements: D1PreparedStatement[]; created: CreatedProductionOrder[]; preExisting: boolean }> {
  return createProductionOrdersForOrder(
    db,
    {
      id: so.id,
      sourceType: "SO",
      companyOrderId: so.companySOId ?? "",
      companyOrderDate: so.companySODate,
      customerPOId: so.customerPOId,
      reference: so.reference,
      customerName: so.customerName,
      customerState: so.customerState,
      hookkaExpectedDD: so.hookkaExpectedDD,
      customerDeliveryDate: so.customerDeliveryDate,
    },
    items.map((it) => ({
      lineNo: it.lineNo,
      productId: it.productId,
      productCode: it.productCode,
      productName: it.productName,
      itemCategory: it.itemCategory,
      sizeCode: it.sizeCode,
      sizeLabel: it.sizeLabel,
      fabricCode: it.fabricCode,
      quantity: it.quantity,
      gapInches: it.gapInches,
      divanHeightInches: it.divanHeightInches,
      legHeightInches: it.legHeightInches,
      specialOrder: it.specialOrder,
      notes: it.notes,
      // Repair Scope (0160) — dual-key: rows fetched via SELECT * carry the
      // folded-lowercase key (runtime-added column, BUG-2026-06-11-007).
      repairScope: it.repairScope ?? it.repairscope ?? null,
    })),
    opts,
  );
}

// (Removed 2026-05-09) backfillJobCardsForPo + the ProductionOrderRow type +
// POST /api/sales-orders/backfill-job-cards endpoint were a parallel JC
// generator that diverged from createProductionOrdersForOrder over time
// (no FAB_CUT cross-PO merge, no CO source-context, ignored isProjectOrder).
// See DUP-004 in bug_audit_duplicate_logic.md for the full diff. The
// related regen endpoints in production-orders.ts have been deleted in the
// same commit. No frontend consumer was wired (verified by grep across
// src/), and the live data audit showed POs with zero JCs is currently
// empty, so deletion is safe. Future regen/backfill needs should route
// through createProductionOrdersForOrder({ appendOnly: true }) so all
// merge logic flows in.


// Generate next SO number by scanning existing companySOId values for the
// current YYMM prefix and incrementing the max sequence. Falls back to 001.
//
// 0134 — Service Orders use a distinct `SV-YYMM-NNN` prefix so the operator
// can tell them apart in any list / PO downstream that displays the SO id
// (production orders, delivery orders, invoices). The SV sequence is
// scanned INDEPENDENTLY of the SO sequence — first SV of the month is
// always SV-YYMM-001 even when SO-YYMM-007 already exists. (Avoid
// colliding with the older service_orders module's `SVC-` prefix, which
// is its own separate id space.)
export async function generateCompanySOId(
  db: D1Database,
  isServiceOrder = false,
  // The SO id's YYMM follows the ORDER DATE (companySODate = the customer's PO
  // date the operator entered), NOT the system clock (Wei Siang 2026-06-02). So
  // a customer PO dated 29 May, keyed in on 1 June, gets SO-2505-NNN — the
  // number reflects when the customer ordered, not when we keyed it. Falls back
  // to today's month when no valid order date is supplied.
  orderDate?: string | null,
): Promise<string> {
  let yymm: string;
  const m = typeof orderDate === "string" ? orderDate.match(/^(\d{4})-(\d{2})/) : null;
  if (m) {
    yymm = `${m[1].slice(2)}${m[2]}`;
  } else {
    const now = new Date();
    yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  }
  const prefix = isServiceOrder ? `SV-${yymm}-` : `SO-${yymm}-`;
  // MAX+1 read-then-write. Two concurrent creates both read the same maximum
  // and both mint the same number — the same race class as the double-invoice
  // bug (BUG-2026-07-14-006), which was closed with a storage-level unique
  // index. `ensureCompanySOIdUnique` below is that index for this column; the
  // INSERT is what actually fails on a collision, and the caller retries.
  //
  // Order by the sequence NUMERICALLY, not by the whole id as text. The ids are
  // zero-padded to 3, so a lexicographic sort agreed with a numeric one only up
  // to 999 — at the 1000th order in a month "SO-2608-1000" sorts BELOW
  // "SO-2608-999" and the next mint would collide with an existing number
  // instead of moving past it. Padding stays at 3 so existing ids are unchanged
  // and a 4-digit tail simply sorts after them.
  const res = await db
    .prepare(
      `SELECT companySOId FROM sales_orders
        WHERE companySOId LIKE ?
        ORDER BY CAST(NULLIF(regexp_replace(companySOId, '^.*-', ''), '') AS INTEGER) DESC
        LIMIT 1`,
    )
    .bind(`${prefix}%`)
    .first<{ companySOId: string }>();
  const seq = res?.companySOId
    ? Number(res.companySOId.split("-").pop()) + 1
    : 1;
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

// Storage-level guard for the MAX+1 race above (owner 2026-08-01). Without it
// the DB happily accepts two orders carrying the same companySOId — measured:
// the column had only a plain index, never a unique one. Idempotent, once per
// isolate, failure swallowed so a lingering duplicate can't block order entry.
let _soIdUniqueMig: Promise<void> | null = null;
export function ensureCompanySOIdUnique(db: D1Database): Promise<void> {
  if (!_soIdUniqueMig) {
    _soIdUniqueMig = db
      .prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS uniq_sales_orders_company_so_id
           ON sales_orders (company_so_id)
           WHERE company_so_id IS NOT NULL`,
      )
      .run()
      .then(() => undefined)
      .catch(() => undefined);
  }
  return _soIdUniqueMig;
}

/** True when an error is the unique-violation from the index above. */
export function isDuplicateSoIdError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    /uniq_sales_orders_company_so_id/i.test(msg) ||
    (/duplicate key|unique constraint|23505/i.test(msg) &&
      /company_so_id|companySOId/i.test(msg))
  );
}

export async function fetchSOWithItems(
  db: D1Database,
  id: string,
): Promise<ReturnType<typeof rowToSO> | null> {
  const [so, itemsRes] = await Promise.all([
    db
      .prepare("SELECT * FROM sales_orders WHERE id = ?")
      .bind(id)
      .first<SalesOrderRow>(),
    db
      .prepare("SELECT * FROM sales_order_items WHERE salesOrderId = ?")
      .bind(id)
      .all<SalesOrderItemRow>(),
  ]);
  if (!so) return null;
  return rowToSO(so, itemsRes.results ?? []);
}

// ---------------------------------------------------------------------------
// cascadeSOStatusToPOs — ON_HOLD / CANCELLED / RESUME cascade.
//
// When an SO flips to ON_HOLD or CANCELLED, every downstream production_order
// that isn't already in a terminal state (COMPLETED / CANCELLED) must follow.
// Likewise, when an ON_HOLD SO resumes (→ CONFIRMED / IN_PRODUCTION), every
// ON_HOLD PO under that SO flips back to PENDING so the shop floor can
// continue. job_cards follow the same policy:
//
//   SO → CANCELLED  : cascade CANCELLED to all non-terminal POs. Also flip
//                     every job_card under those POs that isn't
//                     COMPLETED/TRANSFERRED to CANCELLED.
//   SO → ON_HOLD    : cascade ON_HOLD to all non-terminal POs. job_cards are
//                     NOT mutated — the scan-complete + PATCH guards block
//                     writes against ON_HOLD POs, so existing WAITING /
//                     IN_PROGRESS states survive the pause untouched and
//                     resume naturally when the SO comes back.
//   SO → RESUME     : flip every ON_HOLD PO back to PENDING. job_cards are
//                     left as-is (WAITING stays WAITING, etc).
//
// The returned `statements` are prepended to the caller's batch so the
// cascade lands atomically with the SO UPDATE + status_changes INSERT.
// `actions` is a human-readable log appended to the status-change row's
// autoActions JSON array ("3 production orders moved to ON_HOLD").
// ---------------------------------------------------------------------------
export type SOCascadeResult = {
  statements: D1PreparedStatement[];
  actions: string[];
  affectedPoCount: number;
  affectedJcCount: number;
};

export async function cascadeSOStatusToPOs(
  db: D1Database,
  soId: string,
  newStatus: string,
  fromStatus: string,
  now: string,
): Promise<SOCascadeResult> {
  const result: SOCascadeResult = {
    statements: [],
    actions: [],
    affectedPoCount: 0,
    affectedJcCount: 0,
  };

  // Only cascade on these transitions — all others no-op.
  const isHold = newStatus === "ON_HOLD";
  const isCancel = newStatus === "CANCELLED";
  const isResume =
    fromStatus === "ON_HOLD" &&
    (newStatus === "CONFIRMED" || newStatus === "IN_PRODUCTION");
  if (!isHold && !isCancel && !isResume) return result;

  // Load downstream POs for this SO.
  const posRes = await db
    .prepare(
      "SELECT id, poNo, status FROM production_orders WHERE salesOrderId = ?",
    )
    .bind(soId)
    .all<{ id: string; poNo: string; status: string }>();
  const pos = posRes.results ?? [];
  if (pos.length === 0) return result;

  if (isHold) {
    const affected = pos.filter(
      (p) => p.status !== "COMPLETED" && p.status !== "CANCELLED",
    );
    if (affected.length === 0) {
      result.actions.push("No active production orders to hold.");
      return result;
    }
    for (const p of affected) {
      result.statements.push(
        db
          .prepare(
            "UPDATE production_orders SET status = 'ON_HOLD', updated_at = ? WHERE id = ?",
          )
          .bind(now, p.id),
      );
    }
    result.affectedPoCount = affected.length;
    result.actions.push(
      `${affected.length} production order(s) moved to ON_HOLD: ${affected.map((p) => p.poNo).join(", ")}`,
    );
    return result;
  }

  if (isCancel) {
    const affected = pos.filter(
      (p) => p.status !== "COMPLETED" && p.status !== "CANCELLED",
    );
    if (affected.length === 0) {
      result.actions.push("No active production orders to cancel.");
      return result;
    }
    const poIds = affected.map((p) => p.id);
    for (const p of affected) {
      result.statements.push(
        db
          .prepare(
            "UPDATE production_orders SET status = 'CANCELLED', updated_at = ? WHERE id = ?",
          )
          .bind(now, p.id),
      );
    }
    // Cascade CANCELLED to any non-terminal job_cards under those POs.
    // Uses placeholders so D1 parameter binding is safe against the id list.
    const placeholders = poIds.map(() => "?").join(", ");
    const jcRes = await db
      .prepare(
        `SELECT id FROM job_cards
           WHERE productionOrderId IN (${placeholders})
             AND status NOT IN ('COMPLETED', 'TRANSFERRED', 'CANCELLED')`,
      )
      .bind(...poIds)
      .all<{ id: string }>();
    const jcIds = (jcRes.results ?? []).map((r) => r.id);
    for (const jcId of jcIds) {
      result.statements.push(
        db
          .prepare("UPDATE job_cards SET status = 'CANCELLED' WHERE id = ?")
          .bind(jcId),
      );
    }

    // PR 0 (2026-05-20, owner-confirmed) — reverse cost_ledger entries
    // for the cancelled JCs so P&L doesn't carry WIP cost forever after
    // a cancel. Memory rule (feedback_protect_completed_work): COMPLETED
    // JC ledger refs stay inviolate, so we ONLY reverse refType='JOB_CARD'
    // entries on the JUST-cancelled JCs (they were WAITING / IN_PROGRESS /
    // PAUSED — not COMPLETED — per the SELECT filter above).
    //
    // refType='PRODUCTION_ORDER' entries (RM_ISSUE that fired from already-
    // completed FAB_CUT JCs, FG_DELIVERED from shipped units) are NOT
    // touched. Those represent real consumption / delivery and the memory
    // rule says we don't unwind real work — operator must use stock
    // adjustments if they actually want to claw material back.
    //
    // Reversal pattern: write a matching ADJUSTMENT row with the OPPOSITE
    // direction ('IN' instead of 'OUT' or vice versa). Same magnitude on
    // qty + totalCostSen so running totals net to zero. ADJUSTMENT is
    // an allowed type per the CHECK constraint at
    // migrations-postgres/0001_init.sql:838.
    if (jcIds.length > 0) {
      const ledgerToReverse = await db
        .prepare(
          `SELECT id, type, itemType, itemId, batchId, qty, direction,
                  unitCostSen, totalCostSen, refType, refId, notes
             FROM cost_ledger
            WHERE refType = 'JOB_CARD'
              AND refId IN (${jcIds.map(() => "?").join(",")})`,
        )
        .bind(...jcIds)
        .all<{
          id: string;
          type: string;
          itemType: string;
          itemId: string;
          batchId: string | null;
          qty: number;
          direction: string;
          unitCostSen: number;
          totalCostSen: number;
          refType: string;
          refId: string;
          notes: string | null;
        }>();
      for (const entry of ledgerToReverse.results ?? []) {
        const oppositeDirection = entry.direction === "OUT" ? "IN" : "OUT";
        result.statements.push(
          db
            .prepare(
              `INSERT INTO cost_ledger
                 (id, date, type, itemType, itemId, batchId, qty, direction,
                  unitCostSen, totalCostSen, refType, refId, notes)
               VALUES (?, ?, 'ADJUSTMENT', ?, ?, ?, ?, ?, ?, ?, 'JOB_CARD', ?, ?)`,
            )
            .bind(
              `cl-rev-${crypto.randomUUID().slice(0, 12)}`,
              now,
              entry.itemType,
              entry.itemId,
              entry.batchId,
              entry.qty,
              oppositeDirection,
              entry.unitCostSen,
              entry.totalCostSen,
              entry.refId,
              `Reversal of ${entry.type} (cl=${entry.id}) — JC ${entry.refId} cancelled via SO cancel cascade`,
            ),
        );
      }
      result.actions.push(
        `${ledgerToReverse.results?.length ?? 0} cost_ledger entry/entries reversed (ADJUSTMENT) for cancelled JCs.`,
      );
    }

    result.affectedPoCount = affected.length;
    result.affectedJcCount = jcIds.length;
    result.actions.push(
      `${affected.length} production order(s) CANCELLED: ${affected.map((p) => p.poNo).join(", ")}`,
    );
    if (jcIds.length > 0) {
      result.actions.push(`${jcIds.length} job card(s) CANCELLED under those POs.`);
    }
    return result;
  }

  // Resume path: ON_HOLD → CONFIRMED / IN_PRODUCTION.
  const affected = pos.filter((p) => p.status === "ON_HOLD");
  if (affected.length === 0) {
    result.actions.push("No ON_HOLD production orders to resume.");
    return result;
  }
  for (const p of affected) {
    result.statements.push(
      db
        .prepare(
          "UPDATE production_orders SET status = 'PENDING', updated_at = ? WHERE id = ?",
        )
        .bind(now, p.id),
    );
  }
  result.affectedPoCount = affected.length;
  result.actions.push(
    `${affected.length} production order(s) resumed to PENDING: ${affected.map((p) => p.poNo).join(", ")}`,
  );
  return result;
}

// Valid status transitions — mirrors the in-memory route.
//
// 2026-04-28 semantics shift: confirming an SO now lands directly at
// IN_PRODUCTION because PO auto-creation kicks off lead-time scheduling the
// instant confirm runs — there is no meaningful "confirmed but not in
// production" steady state. CONFIRMED is kept as a vestigial node only so
// legacy rows still in that status (or any in-flight transient between the
// confirm POST and the PO cascade) remain transition-able. The cascade
// rollback path (READY_TO_SHIP undo) now drops back to IN_PRODUCTION rather
// than CONFIRMED.
export const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["CONFIRMED", "IN_PRODUCTION", "CANCELLED"],
  CONFIRMED: ["IN_PRODUCTION", "ON_HOLD", "CANCELLED"],
  IN_PRODUCTION: ["READY_TO_SHIP", "ON_HOLD", "CANCELLED"],
  READY_TO_SHIP: ["SHIPPED", "ON_HOLD", "IN_PRODUCTION"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: ["INVOICED"],
  INVOICED: ["CLOSED"],
  ON_HOLD: ["CONFIRMED", "IN_PRODUCTION", "CANCELLED"],
  CLOSED: [],
  CANCELLED: [],
};

export const CS_STATUSES = new Set([
  "CONFIRMED",
  "IN_PRODUCTION",
  "READY_TO_SHIP",
  "SHIPPED",
  "DELIVERED",
  "INVOICED",
  "CLOSED",
]);

// Collapse a FULL component pick to "no components" (= full repair) before a
// service order's lines are stored (Wei Siang 2026-06-16): if a repair scope's
// components cover EVERY top-level BOM component at full qty, it's the whole
// unit, so the DO / list badge should treat it as a complete unit, not a parts
// breakdown. Runs canonicalizeComponentPicks against the SAME options the
// /repair-components picker offers. Mutates items[].repairScope in place;
// best-effort — a missing/unusable BOM leaves the scope untouched.
export async function canonicalizeRepairScopesAgainstBom(
  db: D1Database,
  items: Array<{
    productCode: string;
    sizeLabel: string;
    sizeCode: string;
    fabricCode: string;
    gapInches: unknown;
    divanHeightInches: unknown;
    legHeightInches: unknown;
    repairScope: string | null;
  }>,
): Promise<void> {
  const toNum = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const targets = items.filter((it) => {
    const s = it.repairScope ? parseRepairScope(it.repairScope) : null;
    return !!(s?.components && s.components.length > 0);
  });
  if (targets.length === 0) return;
  const codes = [
    ...new Set(targets.map((it) => it.productCode).filter(Boolean)),
  ];
  if (codes.length === 0) return;
  const ph = codes.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT productCode, wipComponents, baseModel, versionStatus, effectiveFrom
         FROM bom_templates WHERE productCode IN (${ph})`,
    )
    .bind(...codes)
    .all<{
      productCode: string | null;
      wipComponents: string | null;
      baseModel: string | null;
      versionStatus: string | null;
      effectiveFrom: string | null;
    }>();
  // Best BOM per code — ACTIVE preferred, then newest effectiveFrom (same
  // two-step rule as GET /repair-components, so options match the picker).
  const best = new Map<
    string,
    { wipComponents: string; baseModel: string | null; active: boolean; eff: string }
  >();
  for (const r of rows.results ?? []) {
    const code = (r.productCode || "").trim();
    if (!code || !r.wipComponents) continue;
    const active = (r.versionStatus || "").toUpperCase() === "ACTIVE";
    const eff = r.effectiveFrom || "";
    const prev = best.get(code);
    if (
      !prev ||
      (active && !prev.active) ||
      (active === prev.active && eff > prev.eff)
    ) {
      best.set(code, {
        wipComponents: r.wipComponents,
        baseModel: r.baseModel,
        active,
        eff,
      });
    }
  }
  for (const it of targets) {
   try {
    const bom = best.get(it.productCode);
    if (!bom) continue;
    const scope = parseRepairScope(it.repairScope);
    if (!scope?.components) continue;
    const wips = breakBomIntoWips(bom.wipComponents, it.productCode, {
      productCode: it.productCode,
      model: bom.baseModel || it.productCode,
      sizeLabel: it.sizeLabel,
      sizeCode: it.sizeCode,
      fabricCode: it.fabricCode,
      divanHeightInches: toNum(it.divanHeightInches),
      legHeightInches: toNum(it.legHeightInches),
      gapInches: toNum(it.gapInches),
    });
    if (wips.length === 1 && wips[0].wipKey === `${it.productCode}::FG_MAIN`) {
      continue; // unusable BOM — leave the scope alone
    }
    const options = wips.map((w) => ({
      key: w.wipKey,
      label: w.wipLabel || w.wipCode,
      qty: w.quantityMultiplier,
    }));
    const canon = canonicalizeComponentPicks(options, scope.components);
    // undefined = every component picked at full qty → it's a FULL repair: drop
    // components so the DO/badge render it as the whole unit.
    it.repairScope = serializeRepairScope(
      canon === undefined
        ? { preset: scope.preset, depts: scope.depts }
        : { ...scope, components: canon },
    );
   } catch {
     // best-effort — leave this line's scope untouched on any BOM/serialize error
   }
  }
}

// Self-applying migrations — columns added at first POST per isolate.
// `ALTER ... ADD COLUMN IF NOT EXISTS` is idempotent + cheap, so running it
// here removes the deploy ordering footgun where new columns aren't applied
// to Supabase yet (the legacy `migrations/` D1 folder doesn't auto-replay
// on Postgres). Module-level promise ensures one round of ALTERs per
// isolate boot, not per request.
export let pendingMigrations: Promise<void> | null = null;
export function ensurePendingMigrations(db: D1Database): Promise<void> {
  if (pendingMigrations) return pendingMigrations;
  pendingMigrations = (async () => {
    // Each ALTER runs independently so a permission failure on one doesn't
    // mask the others. Best-effort: a real schema-mismatch error will
    // resurface on the INSERT below with a clearer message.
    const stmts = [
      // 0108 — customer PO PNG attachment for dispute proof.
      "ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS customerPOImageB64 TEXT",
      // 0113 — drop fabric_id (UI-only artifact; canonical reference is
      // fabric_code). See migrations-postgres/0113_drop_fabric_id_from_order_items.sql
      // for the full rationale. Idempotent — DROP IF EXISTS no-ops once applied.
      "ALTER TABLE sales_order_items DROP COLUMN IF EXISTS fabric_id",
      "ALTER TABLE consignment_order_items DROP COLUMN IF EXISTS fabric_id",
      // 0114 — drop sales_orders.is_project_order. Toggle removed 2026-05-09
      // because SOFA qty>1 is now rejected (commit 7302f0f) so the per-piece
      // SOFA fan-out the toggle controlled is moot; FAB_CUT cross-PO merge
      // becomes unconditional. See migrations-postgres/0114_drop_so_is_project_order.sql.
      "ALTER TABLE sales_orders DROP COLUMN IF EXISTS is_project_order",
      // 0160 — Service-order Repair Scope, per line. ⚠ ADAPTER RULE
      // (BUG-2026-06-10-001 / BUG-2026-06-11-007): the unquoted camelCase
      // identifier is folded to lowercase `repairscope` by Postgres; the
      // migration file uses the folded name so a tool apply no-ops, and
      // every read is dual-key (`row.repairScope ?? row.repairscope`).
      // production_orders gets the same column via the builder's own
      // ensure (production-builder.ts) so CO confirms are covered too;
      // duplicated here so a POST-then-confirm on a fresh isolate can
      // never race the column into existence mid-request.
      "ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS repairScope TEXT",
      "ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS repairScope TEXT",
      // 0165 — Service Case linkage for SV orders spawned from
      // /service-order/create?fromCase=… . Lowercase on purpose (adapter
      // rule); service-cases.ts reads it to merge SV orders into the case's
      // "Service Orders" panel. NULL on every normal sales order.
      "ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS caseid TEXT",
      // 0179 — Per-line discount (RM amount in sen) on the three price-bearing
      // line tables. snake_case column (no rename-map dependency on the column
      // itself; the route SQL's camelCase `discountSen` maps via the adapter).
      // Applied here at runtime because Postgres migration files are applied
      // MANUALLY (deploy.yml does NOT auto-replay them) — without this the
      // INSERTs that now write discountSen would fail against prod. All three
      // tables are altered here so an SO request warms the column for CO/Invoice
      // too; CO + Invoice routes also self-apply their own (no cross-route race).
      "ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS discount_sen INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE consignment_order_items ADD COLUMN IF NOT EXISTS discount_sen INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS discount_sen INTEGER NOT NULL DEFAULT 0",
      // 0209 — total-height surcharge (gap+divan+leg → variants-config.totalHeights)
      // gets its own stored column so it is derivable server-side, itemised on
      // the PDF, and editable on the invoice — the 4th price component finally
      // treated like the others. Was folded into unitPriceSen with no column,
      // so it landed in 0/125 eligible lines (BUG-CLASSES C1).
      "ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS total_height_price_sen INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE consignment_order_items ADD COLUMN IF NOT EXISTS total_height_price_sen INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS total_height_price_sen INTEGER NOT NULL DEFAULT 0",
      // 0185 — ON HOLD reason capture. When an SO is put on hold the operator
      // must enter a reason; it is stored here (+ who put it on hold and when)
      // so the production grid can surface "why is this paused" at-a-glance.
      // snake_case columns (no rename-map dependency — the route SQL references
      // the literal snake_case names directly). NULLed again on resume/cancel so
      // a re-activated order never shows a stale reason. Runtime self-apply
      // because deploy.yml does NOT replay Postgres migration files — the
      // migration file alone would be inert (see the discount_sen note above).
      "ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS hold_reason TEXT",
      "ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS held_by TEXT",
      "ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS held_at TEXT",
      // Multi-Company Phase 2 — the "company" a Sales Order is booked under
      // (HOOKKA / OHANA / HOUZS / HKMFG …). DELIBERATELY a NEW snake_case
      // column, NOT the existing `orgId`: orgId is the tenant-isolation
      // boundary (the SO list is scoped `WHERE orgId = <users.orgId>` via
      // withOrgScope, always 'hookka' today) — writing a sister-company value
      // into orgId would HIDE the SO from the default all-companies list. This
      // mirrors purchase_orders.purchase_org_code exactly: a display/filter
      // dimension that is independent of the tenant scope. DEFAULT 'HOOKKA'
      // backfills every existing row so the default list view is byte-identical
      // (every SO reads as Hookka until an operator picks otherwise). Runtime
      // self-apply because deploy.yml does NOT replay migration files.
      "ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS sales_org_code TEXT NOT NULL DEFAULT 'HOOKKA'",
      "UPDATE sales_orders SET sales_org_code = 'HOOKKA' WHERE sales_org_code IS NULL OR sales_org_code = ''",
    ];
    for (const sql of stmts) {
      try {
        await db.prepare(sql).run();
      } catch {
        // ignore — column may already exist or DDL transiently rejected
      }
    }
  })();
  return pendingMigrations;
}

// ---------------------------------------------------------------------------
// Sheets-sync helper — load every JC for the freshly-created POs and push
// them to the matching dept tab. Lives in this file (instead of the lib)
// because it joins production_orders + sales_orders + job_cards in one
// shot, which is specific to the SO-confirm fanout path.
// ---------------------------------------------------------------------------
export async function pushNewlyCreatedJobCardsToSheet(
  env: {
    GOOGLE_SHEETS_SA_KEY?: string;
    SHEETS_SPREADSHEET_ID?: string;
  },
  db: D1Database,
  poIds: string[],
): Promise<void> {
  if (poIds.length === 0) return;
  const placeholders = poIds.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT jc.id          AS id,
              jc.departmentCode AS departmentCode,
              jc.status      AS status,
              jc.dueDate     AS dueDate,
              jc.completedDate AS completedDate,
              jc.pic1Name    AS pic1Name,
              jc.pic2Name    AS pic2Name,
              jc.wipLabel    AS wipLabel,
              jc.category    AS category,
              jc.wipQty      AS wipQty,
              po.poNo        AS poNo,
              po.customerName AS customerName,
              po.productCode AS productCode,
              so.customerPOId AS customerPOId,
              so.reference   AS "soReference"
         FROM job_cards jc
         JOIN production_orders po ON po.id = jc.productionOrderId
    LEFT JOIN sales_orders so ON so.id = po.salesOrderId
        WHERE po.id IN (${placeholders})`,
    )
    .bind(...poIds)
    .all<{
      id: string;
      departmentCode: string | null;
      status: string | null;
      dueDate: string | null;
      completedDate: string | null;
      pic1Name: string | null;
      pic2Name: string | null;
      wipLabel: string | null;
      category: string | null;
      wipQty: number | null;
      poNo: string | null;
      customerName: string | null;
      productCode: string | null;
      customerPOId: string | null;
      soReference: string | null;
    }>();

  const { syncJobCardToSheet } = await import("../../lib/sheets-sync");
  for (const r of rows.results ?? []) {
    await syncJobCardToSheet(
      env,
      {
        id: r.id,
        departmentCode: r.departmentCode,
        status: r.status,
        dueDate: r.dueDate,
        completedDate: r.completedDate,
        pic1Name: r.pic1Name,
        pic2Name: r.pic2Name,
        wipLabel: r.wipLabel,
        category: r.category,
        wipQty: r.wipQty,
      },
      {
        poNo: r.poNo,
        customerName: r.customerName,
        productCode: r.productCode,
      },
      {
        customerPOId: r.customerPOId,
        reference: r.soReference,
      },
    );
  }
}

