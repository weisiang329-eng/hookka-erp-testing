// ---------------------------------------------------------------------------
// D1-backed MRP route.
//
// Pure calculator — no dedicated table. Ports the logic from the old mock
// route at src/api/routes/mrp.ts, but reads from the real D1 tables:
//
//   production_orders   → active POs (PENDING / IN_PROGRESS)
//   job_cards           → per-PO, used to find the earliest pending due date
//   bom_templates       → wipComponents JSON drives the material explosion
//   raw_materials       → balanceQty → on-hand
//   supplier_material_bindings + suppliers
//                       → leadTimeDays, moq, preferred supplier
//   fabrics             → fabric SOH + demand breakdown (separate section of
//                         the response, same as the mock)
//
// Previous mock stored runs in-memory (`mrpRuns`) and returned the last one
// on GET. With no persistence, GET now returns `null` for data and 0 for
// allRuns so the UI still renders the "no runs yet" state. POST computes
// everything on the fly and returns the freshly-built MRPRun.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import { runSelfApply } from "../lib/self-apply";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import {
  expandMaterialQty,
  parseMaterialScaling,
  parseSofaSeatHeightInches,
  type ProductionDimensions,
} from "../lib/material-scaling";
import { computeFabricMetrics } from "../lib/fabric-usage";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Types mirroring src/lib/mock-data.ts so the response shape stays compatible
// with the existing UI pages.
// ---------------------------------------------------------------------------

type TimeBucket = "THIS_WEEK" | "NEXT_WEEK" | "WEEK_3_4" | "BEYOND";

const BUCKET_LABELS: Record<TimeBucket, string> = {
  THIS_WEEK: "This Week",
  NEXT_WEEK: "Next Week",
  WEEK_3_4: "2-4 Weeks",
  BEYOND: "Beyond 4 Weeks",
};

type MaterialRequirement = {
  id: string;
  // SKU code (raw_materials.itemCode). Different from materialName which is
  // the human-readable label. Persisted so /api/purchase-orders/from-mrp
  // (Phase A1.2) can look up supplier_material_bindings and prefill a draft
  // PO without re-running the MRP solver.
  materialCode: string;
  materialName: string;
  materialCategory: string;
  unit: string;
  grossRequired: number;
  onHand: number;
  onOrder: number;
  netRequired: number;
  status: "SUFFICIENT" | "LOW" | "SHORTAGE";
  suggestedPOQty: number;
  preferredSupplierId?: string;
  preferredSupplierName?: string;
  byBucket: Record<TimeBucket, number>;
  // `null` = the main supplier binding does not state one (BUG-2026-08-13-145).
  // supplier_material_bindings.moq / .leadTimeDays are `INTEGER NOT NULL
  // DEFAULT 0` (migrations/0001_init.sql:273,275), so 0 is what an unfilled
  // row carries — it is indistinguishable from a deliberate zero and must NOT
  // be rendered as a stated figure. `undefined` is not used for either: the FE
  // has to be able to tell "unstated" from "the field was dropped in transit".
  moq: number | null;
  leadTimeDays: number | null;
  suggestedOrderDate?: string;
};

type MRPRun = {
  id: string;
  runDate: string;
  planningHorizon: string;
  productionOrderCount: number;
  totalMaterials: number;
  shortageCount: number;
  status: "COMPLETED" | "IN_PROGRESS";
  requirements: MaterialRequirement[];
};

// ---------------------------------------------------------------------------
// BOM JSON shape — bom_templates.wipComponents is a JSON blob built by the
// BOM editor. We only need the nested material lists + quantities here.
// ---------------------------------------------------------------------------
type BomMaterial = {
  code?: string;
  inventoryCode?: string;
  name?: string;
  unit?: string;
  qty?: number;
  // Optional dimension scaling rule. Parsed via parseMaterialScaling at
  // use site so a malformed JSON blob doesn't poison the whole MRP run.
  scaling?: unknown;
};

type BomWipNode = {
  quantity?: number;
  materials?: BomMaterial[];
  children?: BomWipNode[];
};

type BomTemplateRow = {
  id: string;
  productCode: string;
  wipComponents: string | null; // JSON string
  versionStatus: string | null;
};

type ProductionOrderRow = {
  id: string;
  poNo: string;
  productCode: string | null;
  itemCategory: string | null;
  fabricCode: string | null;
  quantity: number;
  targetEndDate: string | null;
  status: string;
  // Snapshotted dimensions used by the BOM material scaling rule. All
  // optional — sofa seat height is parsed out of sizeCode at use time
  // (see parseSofaSeatHeightInches) since there's no dedicated INT
  // column on production_orders.
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  sizeCode: string | null;
  sizeLabel: string | null;
};

type JobCardRow = {
  productionOrderId: string;
  status: string;
  dueDate: string | null;
};

type RawMaterialRow = {
  itemCode: string;
  itemGroup: string;
  balanceQty: number;
};

type SupplierBindingRow = {
  supplierId: string;
  materialCode: string;
  leadTimeDays: number;
  moq: number;
  isMainSupplier: number;
};

type SupplierRow = {
  id: string;
  name: string;
};

type FabricRow = {
  id: string;
  code: string;
  name: string;
  category: string | null;
  sohMeters: number;
};

// Aliased shape returned by the fabric_trackings SELECT below.
type FabricTrackingRowMrp = {
  id: string;
  fabricCode: string;
  fabricDescription: string | null;
  fabricCategory: string | null;
  soh: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normCode(s: string | null | undefined): string {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function findBomTemplate(
  productCode: string | null,
  templates: BomTemplateRow[],
): BomTemplateRow | undefined {
  if (!productCode) return undefined;
  const want = normCode(productCode);
  return (
    templates.find((t) => t.productCode === productCode && t.versionStatus === "ACTIVE") ||
    templates.find((t) => normCode(t.productCode) === want && t.versionStatus === "ACTIVE") ||
    templates.find((t) => t.productCode === productCode) ||
    templates.find((t) => normCode(t.productCode) === want)
  );
}

function dateToBucket(dateStr: string | null, now: Date): TimeBucket {
  if (!dateStr) return "THIS_WEEK";
  const d = new Date(dateStr);
  const diffMs = d.getTime() - now.getTime();
  const diffDays = diffMs / 86400000;
  if (diffDays <= 7) return "THIS_WEEK";
  if (diffDays <= 14) return "NEXT_WEEK";
  if (diffDays <= 28) return "WEEK_3_4";
  return "BEYOND";
}

type MatDemand = {
  code: string;
  name: string;
  unit: string;
  totalQty: number;
  byBucket: Record<TimeBucket, number>;
  poSources: {
    poNo: string;
    productCode: string;
    qty: number;
    dueDate: string;
    bucket: TimeBucket;
  }[];
};

function collectMaterials(
  node: BomWipNode,
  poQty: number,
  parentQty: number,
  poNo: string,
  productCode: string,
  dueDate: string,
  bucket: TimeBucket,
  demandMap: Map<string, MatDemand>,
  // PO line dimensions used to expand each material's scaling rule (if
  // present). expandMaterialQty falls back to the unscaled qty when no
  // rule is attached or the relevant dimension is missing on the PO.
  dims: ProductionDimensions,
): void {
  const effectiveQty = (node.quantity || 1) * parentQty;
  for (const mat of node.materials || []) {
    const key = mat.inventoryCode || mat.code;
    if (!key) continue;
    const baseQty = mat.qty || 0;
    const scaledQty = expandMaterialQty(baseQty, parseMaterialScaling(mat.scaling), dims);
    const matQty = scaledQty * effectiveQty * poQty;
    if (matQty <= 0) continue;

    if (!demandMap.has(key)) {
      demandMap.set(key, {
        code: key,
        name: mat.name || key,
        unit: mat.unit || "PCS",
        totalQty: 0,
        byBucket: { THIS_WEEK: 0, NEXT_WEEK: 0, WEEK_3_4: 0, BEYOND: 0 },
        poSources: [],
      });
    }
    const entry = demandMap.get(key)!;
    entry.totalQty += matQty;
    entry.byBucket[bucket] += matQty;
    entry.poSources.push({ poNo, productCode, qty: matQty, dueDate, bucket });
  }
  for (const child of node.children || []) {
    collectMaterials(child, poQty, effectiveQty, poNo, productCode, dueDate, bucket, demandMap, dims);
  }
}

function genId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Self-applying schema migrations.
//
// migrations-postgres/0112_mrp_persistence.sql is the canonical source — but
// the prod deploy pipeline runs SQL migrations out-of-band. Self-apply on
// first request per isolate so the route never 500s against an old schema
// during a partial deploy. ALTER ... IF NOT EXISTS is idempotent so re-runs
// are cheap. Mirrors src/api/routes/production-orders.ts:83.
// ---------------------------------------------------------------------------
let pendingMigrations: Promise<void> | null = null;
function ensurePendingMigrations(db: D1Database): Promise<void> {
  if (pendingMigrations) return pendingMigrations;
  pendingMigrations = (async () => {
    const stmts = [
      "ALTER TABLE mrp_runs ADD COLUMN IF NOT EXISTS org_id TEXT",
      "ALTER TABLE mrp_runs ADD COLUMN IF NOT EXISTS created_by TEXT",
      "ALTER TABLE mrp_runs ADD COLUMN IF NOT EXISTS fabric_detail TEXT",
      "ALTER TABLE mrp_runs ADD COLUMN IF NOT EXISTS matched_pos INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE mrp_runs ADD COLUMN IF NOT EXISTS unmatched_pos INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE mrp_requirements ADD COLUMN IF NOT EXISTS material_code TEXT",
      "ALTER TABLE mrp_requirements ADD COLUMN IF NOT EXISTS bucket_this_week DOUBLE PRECISION NOT NULL DEFAULT 0",
      "ALTER TABLE mrp_requirements ADD COLUMN IF NOT EXISTS bucket_next_week DOUBLE PRECISION NOT NULL DEFAULT 0",
      "ALTER TABLE mrp_requirements ADD COLUMN IF NOT EXISTS bucket_week34 DOUBLE PRECISION NOT NULL DEFAULT 0",
      "ALTER TABLE mrp_requirements ADD COLUMN IF NOT EXISTS bucket_beyond DOUBLE PRECISION NOT NULL DEFAULT 0",
      "ALTER TABLE mrp_requirements ADD COLUMN IF NOT EXISTS lead_time_days INTEGER",
      "ALTER TABLE mrp_requirements ADD COLUMN IF NOT EXISTS suggested_order_date TEXT",
      // BUG-2026-08-13-145. Nullable ON PURPOSE — NULL is "the supplier
      // binding does not state an MOQ", which is a different fact from 0 and
      // from 50. A NOT NULL DEFAULT here would recreate the bug in the schema.
      "ALTER TABLE mrp_requirements ADD COLUMN IF NOT EXISTS moq INTEGER",
      // BUG-2026-08-13-144 coverage. How many OPEN purchase-order lines could
      // not be resolved to a material code at all, so their inbound quantity
      // was credited to nothing. Persisted with the run so a reloaded snapshot
      // carries its own caveat instead of looking complete.
      "ALTER TABLE mrp_runs ADD COLUMN IF NOT EXISTS on_order_unresolved_lines INTEGER",
      "CREATE INDEX IF NOT EXISTS idx_mrp_runs_org_run_date ON mrp_runs(org_id, run_date DESC)",
      "CREATE INDEX IF NOT EXISTS idx_mrp_requirements_run ON mrp_requirements(mrp_run_id)",
    ];
    await runSelfApply(db, "mrp", stmts);
  })().catch((err) => {
    // A FAILED round must not be remembered as done — otherwise one
    // transient blip leaves the column unapplied for the life of this
    // isolate. Dropping the memo lets the next request retry.
    pendingMigrations = null;
    throw err;
  });
  return pendingMigrations;
}

// ---------------------------------------------------------------------------
// DB row shapes for persistence
// ---------------------------------------------------------------------------
type MrpRunRow = {
  id: string;
  runDate: string;
  planningHorizon: string | null;
  productionOrderCount: number;
  totalMaterials: number;
  shortageCount: number;
  status: string;
  fabricDetail: string | null;
  matchedPos: number;
  unmatchedPos: number;
  // NULL on any run persisted before BUG-2026-08-13-144 — that run never
  // counted them, which is not the same fact as "there were none".
  onOrderUnresolvedLines: number | null;
};

type MrpRequirementRow = {
  id: string;
  mrpRunId: string;
  materialCode: string | null;
  materialName: string | null;
  materialCategory: string | null;
  unit: string | null;
  grossRequired: number;
  onHand: number;
  onOrder: number;
  netRequired: number;
  status: string;
  suggestedPOQty: number;
  preferredSupplierId: string | null;
  preferredSupplierName: string | null;
  bucketThisWeek: number;
  bucketNextWeek: number;
  bucketWeek34: number;
  bucketBeyond: number;
  leadTimeDays: number | null;
  moq: number | null;
  suggestedOrderDate: string | null;
};

// Reconstruct the MRPRun shape the FE expects from the persisted rows.
function rowsToMRPRun(
  runRow: MrpRunRow,
  reqRows: MrpRequirementRow[],
): MRPRun {
  const requirements: MaterialRequirement[] = reqRows.map((r) => ({
    id: r.id,
    materialCode: r.materialCode || "",
    materialName: r.materialName || "",
    materialCategory: r.materialCategory || "",
    unit: r.unit || "",
    grossRequired: Number(r.grossRequired) || 0,
    onHand: Number(r.onHand) || 0,
    onOrder: Number(r.onOrder) || 0,
    netRequired: Number(r.netRequired) || 0,
    status: (r.status as MaterialRequirement["status"]) || "SUFFICIENT",
    suggestedPOQty: Number(r.suggestedPOQty) || 0,
    preferredSupplierId: r.preferredSupplierId ?? undefined,
    preferredSupplierName: r.preferredSupplierName ?? undefined,
    byBucket: {
      THIS_WEEK: Number(r.bucketThisWeek) || 0,
      NEXT_WEEK: Number(r.bucketNextWeek) || 0,
      WEEK_3_4: Number(r.bucketWeek34) || 0,
      BEYOND: Number(r.bucketBeyond) || 0,
    },
    // `?? null`, never `?? undefined` and never `?? 14` / `?? 50`: a run
    // persisted before BUG-2026-08-13-145 has NULL here and must reload as
    // "unstated", not as the literal it used to print.
    leadTimeDays: r.leadTimeDays ?? null,
    moq: r.moq ?? null,
    suggestedOrderDate: r.suggestedOrderDate ?? undefined,
  }));
  return {
    id: runRow.id,
    runDate: runRow.runDate,
    planningHorizon: runRow.planningHorizon || "All",
    productionOrderCount: Number(runRow.productionOrderCount) || 0,
    totalMaterials: Number(runRow.totalMaterials) || 0,
    shortageCount: Number(runRow.shortageCount) || 0,
    status: (runRow.status as MRPRun["status"]) || "COMPLETED",
    requirements,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /api/mrp — return the most recent persisted run for this org so the FE
// lands on something useful instead of an empty dashboard. Phase A1.1
// (2026-05-09) replaces the prior data=null stub.
app.get("/", async (c) => {
  await ensurePendingMigrations(c.var.DB);
  const orgId = getOrgId(c);
  const latestRun = await c.var.DB
    .prepare(
      `SELECT id, runDate, planningHorizon, productionOrderCount, totalMaterials,
              shortageCount, status,
              fabric_detail, matched_pos, unmatched_pos, on_order_unresolved_lines
         FROM mrp_runs
        WHERE orgId = ?
        ORDER BY runDate DESC
        LIMIT 1`,
    )
    .bind(orgId)
    .first<MrpRunRow>();
  const totalRuns = await c.var.DB
    .prepare(`SELECT COUNT(*) AS n FROM mrp_runs WHERE orgId = ?`)
    .bind(orgId)
    .first<{ n: number }>();
  if (!latestRun) {
    return c.json({ success: true, data: null, allRuns: 0 });
  }
  const reqRes = await c.var.DB
    .prepare(
      `SELECT id, mrpRunId, materialCode, materialName, materialCategory, unit,
              grossRequired, onHand, onOrder, netRequired, status,
              suggested_po_qty AS suggested_po_qty,
              preferredSupplierId, preferredSupplierName,
              bucket_this_week, bucket_next_week, bucket_week34, bucket_beyond,
              leadTimeDays, moq, suggested_order_date
         FROM mrp_requirements
        WHERE mrpRunId = ?`,
    )
    .bind(latestRun.id)
    .all<MrpRequirementRow>();
  const data = rowsToMRPRun(latestRun, reqRes.results ?? []);
  let fabricDetail: unknown = null;
  if (latestRun.fabricDetail) {
    try {
      fabricDetail = JSON.parse(latestRun.fabricDetail);
    } catch {
      fabricDetail = null;
    }
  }
  return c.json({
    success: true,
    data,
    fabricDetail,
    bucketLabels: BUCKET_LABELS,
    meta: {
      matchedPOs: Number(latestRun.matchedPos) || 0,
      unmatchedPOs: Number(latestRun.unmatchedPos) || 0,
      // `?? null`, not `|| 0`: a run persisted before BUG-2026-08-13-144 has
      // NULL here — nobody counted the unresolved lines on that run — and
      // "nobody counted" must not reload as a clean "0 unresolved".
      onOrderUnresolvedLines:
        latestRun.onOrderUnresolvedLines == null
          ? null
          : Number(latestRun.onOrderUnresolvedLines),
    },
    allRuns: Number(totalRuns?.n) || 0,
  });
});

// GET /api/mrp/runs?limit=30 — paginated history for this org. Defaults to
// 30 most recent (matches the "30 runs / 90 days" retention guidance — actual
// pruning lives in a separate cron, not yet wired). Returns header metadata
// only; full requirement detail loads via /api/mrp/runs/:id.
app.get("/runs", async (c) => {
  await ensurePendingMigrations(c.var.DB);
  const orgId = getOrgId(c);
  const rawLimit = parseInt(c.req.query("limit") ?? "30", 10) || 30;
  const limit = Math.min(100, Math.max(1, rawLimit));
  const res = await c.var.DB
    .prepare(
      `SELECT id, runDate, planningHorizon, productionOrderCount, totalMaterials,
              shortageCount, status,
              matched_pos, unmatched_pos, created_by
         FROM mrp_runs
        WHERE orgId = ?
        ORDER BY runDate DESC
        LIMIT ?`,
    )
    .bind(orgId, limit)
    .all<MrpRunRow & { createdBy: string | null }>();
  return c.json({ success: true, data: res.results ?? [] });
});

// GET /api/mrp/runs/:id — reload a stored snapshot in full MRPRun shape.
app.get("/runs/:id", async (c) => {
  await ensurePendingMigrations(c.var.DB);
  const orgId = getOrgId(c);
  const id = c.req.param("id");
  const runRow = await c.var.DB
    .prepare(
      `SELECT id, runDate, planningHorizon, productionOrderCount, totalMaterials,
              shortageCount, status,
              fabric_detail, matched_pos, unmatched_pos, on_order_unresolved_lines
         FROM mrp_runs
        WHERE id = ? AND orgId = ?`,
    )
    .bind(id, orgId)
    .first<MrpRunRow>();
  if (!runRow) {
    return c.json({ success: false, error: "MRP run not found" }, 404);
  }
  const reqRes = await c.var.DB
    .prepare(
      `SELECT id, mrpRunId, materialCode, materialName, materialCategory, unit,
              grossRequired, onHand, onOrder, netRequired, status,
              suggested_po_qty AS suggested_po_qty,
              preferredSupplierId, preferredSupplierName,
              bucket_this_week, bucket_next_week, bucket_week34, bucket_beyond,
              leadTimeDays, moq, suggested_order_date
         FROM mrp_requirements
        WHERE mrpRunId = ?`,
    )
    .bind(runRow.id)
    .all<MrpRequirementRow>();
  const data = rowsToMRPRun(runRow, reqRes.results ?? []);
  let fabricDetail: unknown = null;
  if (runRow.fabricDetail) {
    try {
      fabricDetail = JSON.parse(runRow.fabricDetail);
    } catch {
      fabricDetail = null;
    }
  }
  return c.json({
    success: true,
    data,
    fabricDetail,
    bucketLabels: BUCKET_LABELS,
    meta: {
      matchedPOs: Number(runRow.matchedPos) || 0,
      unmatchedPOs: Number(runRow.unmatchedPos) || 0,
    },
  });
});

// POST /api/mrp — compute a fresh MRP run from live data and persist it.
//
// Phase A1.1 (2026-05-09): now writes the computed MRPRun + fabric panel
// state into mrp_runs / mrp_requirements (best-effort — a write failure
// logs a warning but doesn't fail the response, since the FE still gets
// the in-memory result and the operator can re-run if needed).
app.post("/", async (c) => {
  const denied = await requirePermission(c, "mrp", "create");
  if (denied) return denied;
  await ensurePendingMigrations(c.var.DB);
  const orgId = getOrgId(c);
  const now = new Date();
  const horizonParam = c.req.query("horizon") || "all";

  const [poRes, jcRes, bomRes, rmRes, bindRes, supRes, fabRes, fabricMetrics, onOrderRes] = await Promise.all([
    c.var.DB.prepare(
      `SELECT id, poNo, productCode, itemCategory, fabricCode, quantity,
              targetEndDate, status, gapInches, divanHeightInches,
              legHeightInches, sizeCode, sizeLabel
         FROM production_orders
        WHERE status IN ('PENDING','IN_PROGRESS')`,
    ).all<ProductionOrderRow>(),
    c.var.DB.prepare(
      "SELECT productionOrderId, status, dueDate FROM job_cards",
    ).all<JobCardRow>(),
    c.var.DB.prepare(
      "SELECT id, productCode, wipComponents, versionStatus FROM bom_templates",
    ).all<BomTemplateRow>(),
    c.var.DB.prepare(
      "SELECT itemCode, itemGroup, balanceQty FROM raw_materials",
    ).all<RawMaterialRow>(),
    c.var.DB.prepare(
      `SELECT supplierId, materialCode, leadTimeDays, moq, isMainSupplier
         FROM supplier_material_bindings`,
    ).all<SupplierBindingRow>(),
    c.var.DB.prepare("SELECT id, name FROM suppliers").all<SupplierRow>(),
    // 2026-05-09: switched from `fabrics` (legacy, has stale duplicates) to
    // `fabric_trackings` (raw_materials-derived mirror, same source pickers
    // use). Output shape adapted to the legacy FabricRow at the boundary so
    // the rest of this handler is unchanged.
    c.var.DB.prepare(
      // Bare camelCase column refs — translateSql() rewrites to snake_case
      // via the rename map. Quoting them (e.g. "fabricCode") would make the
      // adapter pass them through verbatim and Postgres would error with
      // `column "fabricCode" does not exist` (real column is fabric_code).
      `SELECT id, fabricCode, fabricDescription, fabricCategory, soh FROM fabric_trackings`,
    ).all<FabricTrackingRowMrp>(),
    // Single source of truth for per-fabric demand: walks active FAB_CUT
    // JCs (Fab Cut sheet's view), computes per-JC fabric meters via BOM +
    // cross-PO siblings, buckets by FC dueDate. MRP and Inventory > Fabrics
    // both consume this same Map so the three pages always agree.
    computeFabricMetrics(c.var.DB),
    // BUG-2026-08-13-144 — ON ORDER. Until 2026-08-14 this route did
    // `const onOrder = 0;`, so every kilo already on an open purchase order
    // reported as a full shortage and the page recommended re-ordering
    // inbound stock.
    //
    // Definition is deliberately the SAME one the Fabric tab of this very page
    // already uses (`computeFabricMetrics`, src/api/lib/fabric-usage.ts:539-566
    // "PO Outstanding"): open PO = `purchase_orders.status NOT IN
    // ('RECEIVED','CANCELLED','CLOSED')`, per-line outstanding =
    // `quantity − COALESCE(receivedQty, 0)` floored at 0 (a GRN over-receipt
    // must not create negative demand). Two tabs of one page disagreeing about
    // what "on order" means would be a new defect, so this reuses the in-house
    // definition rather than inventing a second one. Whether DRAFT POs — placed
    // with nobody — should count is a judgement call, recorded as an owner
    // decision in docs/DASHBOARD-DATA-AUDIT.md Part 6 and NOT decided here.
    //
    // Code resolution: `purchase_order_items.material_code` (migration 0103,
    // written by purchase-orders.ts:555) when present; otherwise the legacy
    // `materialName` convention `"<itemCode> - <description>"` that the Create
    // PO modal authored before 0103 — SPLIT_PART returns the whole string when
    // the separator is absent, so a plain-itemCode legacy row also matches.
    // Lines that resolve to neither are counted separately (see
    // onOrderUnresolvedLines) instead of being silently dropped, because a
    // dropped line is exactly the "clean number means cannot see" failure
    // (BUG-2026-08-13-096).
    c.var.DB.prepare(
      `SELECT COALESCE(
                NULLIF(TRIM(poi.material_code), ''),
                NULLIF(TRIM(SPLIT_PART(poi.materialName, ' - ', 1)), ''),
                ''
              ) AS code,
              SUM(GREATEST(poi.quantity - COALESCE(poi.receivedQty, 0), 0)) AS qty,
              COUNT(*) AS lines
         FROM purchase_order_items poi
         INNER JOIN purchase_orders po ON po.id = poi.purchaseOrderId
        WHERE po.status NOT IN ('RECEIVED', 'CANCELLED', 'CLOSED')
        GROUP BY 1`,
    ).all<{ code: string; qty: number; lines: number }>(),
  ]);

  const activeOrders = poRes.results ?? [];
  const allJobCards = jcRes.results ?? [];
  const templates = bomRes.results ?? [];
  const rawMaterials = rmRes.results ?? [];
  const bindings = bindRes.results ?? [];
  const suppliers = supRes.results ?? [];
  // On-order, keyed by resolved material code. The `""` bucket is the group of
  // open PO lines that carry NEITHER a material_code NOR a parseable
  // materialName — their inbound quantity belongs to nothing and is published
  // as a coverage caveat rather than folded into a number.
  const onOrderByCode = new Map<string, number>();
  let onOrderUnresolvedLines = 0;
  for (const r of onOrderRes.results ?? []) {
    const code = String(r.code ?? "");
    if (!code) {
      onOrderUnresolvedLines += Number(r.lines) || 0;
      continue;
    }
    onOrderByCode.set(code, Number(r.qty) || 0);
  }
  // Adapt fabric_trackings shape to legacy FabricRow shape so the existing
  // detail-builder below (fab.code, fab.name, fab.category, fab.sohMeters)
  // doesn't need to be rewritten.
  const fabrics: FabricRow[] = (fabRes.results ?? []).map((r) => ({
    id: r.id,
    code: r.fabricCode,
    name: r.fabricDescription ?? "",
    category: r.fabricCategory,
    sohMeters: Number(r.soh) || 0,
  }));

  // Index job cards by production order id for earliest-dueDate lookups.
  const jcByPO = new Map<string, JobCardRow[]>();
  for (const jc of allJobCards) {
    const list = jcByPO.get(jc.productionOrderId) ?? [];
    list.push(jc);
    jcByPO.set(jc.productionOrderId, list);
  }

  const demandMap = new Map<string, MatDemand>();
  let matchedPOs = 0;
  let unmatchedPOs = 0;

  for (const order of activeOrders) {
    const bom = findBomTemplate(order.productCode, templates);
    if (!bom) {
      unmatchedPOs++;
      continue;
    }

    // Parse wipComponents JSON defensively — BOM editor sometimes stores
    // either `[node, ...]` or `{ components: [...] }`. Default to [].
    let wipComponents: BomWipNode[] = [];
    try {
      const parsed = bom.wipComponents ? JSON.parse(bom.wipComponents) : null;
      if (Array.isArray(parsed)) {
        wipComponents = parsed as BomWipNode[];
      } else if (parsed && Array.isArray((parsed as { components?: unknown }).components)) {
        wipComponents = (parsed as { components: BomWipNode[] }).components;
      }
    } catch {
      wipComponents = [];
    }
    if (wipComponents.length === 0) {
      unmatchedPOs++;
      continue;
    }
    matchedPOs++;

    const jcs = jcByPO.get(order.id) ?? [];
    const pendingJcs = jcs.filter(
      (jc) => jc.status !== "COMPLETED" && jc.status !== "TRANSFERRED",
    );
    const earliestDue =
      pendingJcs.length > 0
        ? pendingJcs.reduce<string>((min, jc) => {
            if (!jc.dueDate) return min;
            if (!min || jc.dueDate < min) return jc.dueDate;
            return min;
          }, "")
        : order.targetEndDate || "";
    const bucket = dateToBucket(earliestDue, now);

    if (horizonParam === "1w" && bucket !== "THIS_WEEK") continue;
    if (horizonParam === "2w" && bucket !== "THIS_WEEK" && bucket !== "NEXT_WEEK") continue;
    if (horizonParam === "1m" && bucket === "BEYOND") continue;

    // Build the dimension snapshot for this PO. Sofa seat height is
    // parsed from sizeCode (or sizeLabel as a fallback) — see
    // parseSofaSeatHeightInches for the format. Bedframe size codes
    // ("Q" / "K" / "S") return null so we don't mistake them for inches.
    const dims: ProductionDimensions = {
      gapInches: order.gapInches,
      divanHeightInches: order.divanHeightInches,
      legHeightInches: order.legHeightInches,
      seatHeightInches:
        order.itemCategory === "SOFA"
          ? parseSofaSeatHeightInches(order.sizeCode, order.sizeLabel)
          : null,
    };

    for (const wip of wipComponents) {
      collectMaterials(
        wip,
        order.quantity,
        1,
        order.poNo,
        order.productCode ?? "",
        earliestDue,
        bucket,
        demandMap,
        dims,
      );
    }
  }

  // --- Build requirements -------------------------------------------------
  const rmByCode = new Map<string, RawMaterialRow>();
  for (const r of rawMaterials) rmByCode.set(r.itemCode, r);
  const mainBindingByCode = new Map<string, SupplierBindingRow>();
  for (const b of bindings) {
    if (b.isMainSupplier === 1) mainBindingByCode.set(b.materialCode, b);
  }
  const supplierById = new Map<string, SupplierRow>();
  for (const s of suppliers) supplierById.set(s.id, s);

  const requirements: MaterialRequirement[] = [];
  for (const [code, demand] of demandMap) {
    const rm = rmByCode.get(code);
    const onHand = rm ? rm.balanceQty : 0;
    const grossRequired = Math.ceil(demand.totalQty);
    // Was `const onOrder = 0;` until 2026-08-14 (BUG-2026-08-13-144). Exact-code
    // lookup, matching how `onHand` above resolves `rmByCode` — a normCode
    // fallback on one column and not the other would net a found on-order
    // against a missed on-hand and produce a worse number than either.
    // (The exact-string on-hand lookup is its own open row in
    // docs/DASHBOARD-DATA-AUDIT.md and is deliberately not changed here.)
    const onOrder = onOrderByCode.get(code) ?? 0;
    const netRequired = Math.max(0, grossRequired - onHand - onOrder);

    let status: MaterialRequirement["status"];
    if (netRequired > 0) status = "SHORTAGE";
    else if (onHand > 0 && onHand - grossRequired < onHand * 0.2) status = "LOW";
    else status = "SUFFICIENT";

    const mainBinding = mainBindingByCode.get(code);
    // BUG-2026-08-13-145. Was `mainBinding?.moq || 50` and
    // `mainBinding?.leadTimeDays || 14` — two literals rendered on the row that
    // carries the supplier's NAME, so the screen read as though the supplier
    // had stated them. Neither is a measurement and neither has a source.
    //
    // Why 0 counts as unstated: both columns are `INTEGER NOT NULL DEFAULT 0`
    // (migrations/0001_init.sql:273,275), so an untouched binding row holds 0.
    // The column cannot express "genuinely zero" separately from "nobody ever
    // filled this in", so 0 is UNMEASURED and renders "—". Note the create
    // route writes its own invented defaults (`Number(body.leadTimeDays) || 7`,
    // `Number(body.moq) || 1`, supplier-materials.ts:206,208) — a separate
    // write-side instance of this class, reported in
    // docs/DASHBOARD-DATA-AUDIT.md Part 4, not fixed here.
    const rawMoq = Number(mainBinding?.moq);
    const moq = Number.isFinite(rawMoq) && rawMoq > 0 ? rawMoq : null;
    // No MOQ stated → suggest exactly the shortage. That is arithmetic over a
    // measured figure, not a rounding rule attributed to a supplier.
    const suggestedPOQty =
      netRequired > 0 ? (moq == null ? netRequired : Math.ceil(netRequired / moq) * moq) : 0;
    const supplier = mainBinding ? supplierById.get(mainBinding.supplierId) : undefined;

    const rawLead = Number(mainBinding?.leadTimeDays);
    const leadTimeDays = Number.isFinite(rawLead) && rawLead > 0 ? rawLead : null;
    const earliestNeedDate = demand.poSources
      .filter((s) => s.dueDate)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0]?.dueDate;
    let suggestedOrderDate: string | undefined;
    // No lead time stated → no deadline. The "Order By" cell used to turn RED
    // on a date computed by subtracting a literal 14 days; a deadline with no
    // input is not a late warning, it is a guess wearing one.
    if (earliestNeedDate && netRequired > 0 && leadTimeDays != null) {
      const needDate = new Date(earliestNeedDate);
      needDate.setDate(needDate.getDate() - leadTimeDays);
      suggestedOrderDate = needDate.toISOString().split("T")[0];
    }

    requirements.push({
      id: genId("mr"),
      materialCode: code,
      materialName: demand.name,
      materialCategory: rm?.itemGroup || code,
      unit: demand.unit,
      grossRequired,
      onHand,
      onOrder,
      netRequired,
      status,
      suggestedPOQty,
      preferredSupplierId: supplier?.id,
      preferredSupplierName: supplier?.name,
      byBucket: {
        THIS_WEEK: Math.ceil(demand.byBucket.THIS_WEEK),
        NEXT_WEEK: Math.ceil(demand.byBucket.NEXT_WEEK),
        WEEK_3_4: Math.ceil(demand.byBucket.WEEK_3_4),
        BEYOND: Math.ceil(demand.byBucket.BEYOND),
      },
      moq,
      leadTimeDays,
      suggestedOrderDate,
    });
  }

  const statusOrder = { SHORTAGE: 0, LOW: 1, SUFFICIENT: 2 };
  requirements.sort((a, b) => {
    if (statusOrder[a.status] !== statusOrder[b.status])
      return statusOrder[a.status] - statusOrder[b.status];
    return (b.byBucket?.THIS_WEEK || 0) - (a.byBucket?.THIS_WEEK || 0);
  });

  const shortageCount = requirements.filter((r) => r.status === "SHORTAGE").length;

  const newRun: MRPRun = {
    id: `mrp-run-${Date.now()}`,
    runDate: new Date().toISOString(),
    planningHorizon:
      horizonParam === "1w"
        ? "1 week"
        : horizonParam === "2w"
          ? "2 weeks"
          : horizonParam === "1m"
            ? "1 month"
            : "All",
    productionOrderCount: activeOrders.length,
    totalMaterials: requirements.length,
    shortageCount,
    status: "COMPLETED",
    requirements,
  };

  // --- Fabric planning ----------------------------------------------------
  // Architecture: Fab Cut JC is the single source of truth for fabric
  // demand. computeFabricMetrics walks every active FC JC, calls
  // computeFcFabricUsageMeters (BOM tree + cross-PO sibling sum for sofa),
  // and returns per-fabricCode aggregates. MRP just consumes those numbers
  // — no independent BOM walk here. Inventory > Fabrics page (via
  // /api/fabric-tracking) reads from the SAME helper, so MRP and Fabrics
  // module always show identical demand figures.
  //
  // Bucket mapping from computeFabricMetrics → MRP TimeBucket:
  //   oneWeekUsage      → THIS_WEEK (≤ 7 days)
  //   twoWeeksUsage − oneWeekUsage → NEXT_WEEK (8-14 days)
  //   oneMonthUsage − twoWeeksUsage → WEEK_3_4 (15-30 days)
  //   totalActiveUsage − oneMonthUsage → BEYOND (> 30 days)
  const fabricDetail = fabrics.map((fab) => {
    const m = fabricMetrics.get(fab.code);
    const total = m?.totalActiveUsage ?? 0;
    const week1 = m?.oneWeekUsage ?? 0;
    const week2 = m?.twoWeeksUsage ?? 0;
    const month = m?.oneMonthUsage ?? 0;
    const byBucket: Record<TimeBucket, number> = {
      THIS_WEEK: week1,
      NEXT_WEEK: Math.max(0, week2 - week1),
      WEEK_3_4: Math.max(0, month - week2),
      BEYOND: Math.max(0, total - month),
    };
    return {
      id: fab.id,
      code: fab.code,
      name: fab.name,
      category: fab.category ?? "",
      sohMeters: fab.sohMeters,
      poOutstanding: m?.poOutstanding ?? 0,
      weeklyUsage: Math.ceil(week1),
      twoWeekUsage: Math.ceil(week2),
      monthlyUsage: Math.ceil(month),
      shortage: fab.sohMeters + (m?.poOutstanding ?? 0) < month,
      byBucket,
    };
  });

  // Persist the run. Best-effort — a DB write failure logs and falls through
  // to the response so the FE still gets the in-memory result. Mrp_runs +
  // mrp_requirements have an ON DELETE CASCADE FK so a partial failure of
  // requirement inserts followed by a rollback would just leave the run
  // header — re-running picks up a fresh ID. Sequential INSERTs because the
  // D1 shim (src/api/lib/supabase-compat.ts) doesn't expose a transaction
  // helper; concurrency on a single isolated write isn't worth the complexity.
  try {
    const userId = (c.get as unknown as (k: string) => unknown)("userId") as
      | string
      | undefined;
    await c.var.DB
      .prepare(
        `INSERT INTO mrp_runs
           (id, orgId, runDate, planningHorizon, productionOrderCount,
            totalMaterials, shortageCount, status,
            fabric_detail, matched_pos, unmatched_pos, created_by,
            on_order_unresolved_lines)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newRun.id,
        orgId,
        newRun.runDate,
        newRun.planningHorizon,
        newRun.productionOrderCount,
        newRun.totalMaterials,
        newRun.shortageCount,
        newRun.status,
        JSON.stringify(fabricDetail),
        matchedPOs,
        unmatchedPOs,
        userId ?? null,
        onOrderUnresolvedLines,
      )
      .run();
    for (const req of newRun.requirements) {
      await c.var.DB
        .prepare(
          `INSERT INTO mrp_requirements
             (id, mrpRunId, materialCode, materialName, materialCategory, unit,
              grossRequired, onHand, onOrder, netRequired, status,
              suggested_po_qty, preferredSupplierId, preferredSupplierName,
              bucket_this_week, bucket_next_week, bucket_week34, bucket_beyond,
              leadTimeDays, moq, suggested_order_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          req.id,
          newRun.id,
          req.materialCode,
          req.materialName,
          req.materialCategory,
          req.unit,
          req.grossRequired,
          req.onHand,
          req.onOrder,
          req.netRequired,
          req.status,
          req.suggestedPOQty,
          req.preferredSupplierId ?? null,
          req.preferredSupplierName ?? null,
          req.byBucket.THIS_WEEK,
          req.byBucket.NEXT_WEEK,
          req.byBucket.WEEK_3_4,
          req.byBucket.BEYOND,
          req.leadTimeDays ?? null,
          req.moq ?? null,
          req.suggestedOrderDate ?? null,
        )
        .run();
    }
  } catch (err) {
    console.warn("[mrp] persist failed — returning in-memory result", {
      runId: newRun.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return c.json({
    success: true,
    data: newRun,
    fabricDetail,
    bucketLabels: BUCKET_LABELS,
    meta: {
      matchedPOs,
      unmatchedPOs,
      // BUG-2026-08-13-144 coverage. Open PO lines that resolve to no material
      // code at all — their inbound quantity is credited to nothing, so every
      // "On Order" on this run is a floor, not a total. Published so the page
      // can say that rather than looking complete.
      onOrderUnresolvedLines,
      horizon: horizonParam,
      note:
        unmatchedPOs > 0
          ? `${unmatchedPOs} POs had no BOM template — add materials to their BOM templates for complete MRP coverage`
          : "All POs matched to BOM templates",
    },
  });
});

export default app;
