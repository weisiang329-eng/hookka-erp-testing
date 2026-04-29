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
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import {
  expandMaterialQty,
  parseMaterialScaling,
  parseSofaSeatHeightInches,
  type ProductionDimensions,
} from "../lib/material-scaling";

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
  leadTimeDays?: number;
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
// Routes
// ---------------------------------------------------------------------------

// GET /api/mrp — legacy endpoint returns "latest run" state. No persistence
// now, so we always return data=null, allRuns=0 (UI handles the empty state).
app.get("/", (c) => {
  return c.json({ success: true, data: null, allRuns: 0 });
});

// POST /api/mrp — compute a fresh MRP run from live D1 data.
app.post("/", async (c) => {
  const denied = await requirePermission(c, "mrp", "create");
  if (denied) return denied;
  const now = new Date();
  const horizonParam = c.req.query("horizon") || "all";

  const [poRes, jcRes, bomRes, rmRes, bindRes, supRes, fabRes] = await Promise.all([
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
    c.var.DB.prepare(
      "SELECT id, code, name, category, sohMeters FROM fabrics",
    ).all<FabricRow>(),
  ]);

  const activeOrders = poRes.results ?? [];
  const allJobCards = jcRes.results ?? [];
  const templates = bomRes.results ?? [];
  const rawMaterials = rmRes.results ?? [];
  const bindings = bindRes.results ?? [];
  const suppliers = supRes.results ?? [];
  const fabrics = fabRes.results ?? [];

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
    const onOrder = 0;
    const netRequired = Math.max(0, grossRequired - onHand - onOrder);

    let status: MaterialRequirement["status"];
    if (netRequired > 0) status = "SHORTAGE";
    else if (onHand > 0 && onHand - grossRequired < onHand * 0.2) status = "LOW";
    else status = "SUFFICIENT";

    const mainBinding = mainBindingByCode.get(code);
    const moq = mainBinding?.moq || 50;
    const suggestedPOQty = netRequired > 0 ? Math.ceil(netRequired / moq) * moq : 0;
    const supplier = mainBinding ? supplierById.get(mainBinding.supplierId) : undefined;

    const leadTimeDays = mainBinding?.leadTimeDays || 14;
    const earliestNeedDate = demand.poSources
      .filter((s) => s.dueDate)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0]?.dueDate;
    let suggestedOrderDate: string | undefined;
    if (earliestNeedDate && netRequired > 0) {
      const needDate = new Date(earliestNeedDate);
      needDate.setDate(needDate.getDate() - leadTimeDays);
      suggestedOrderDate = needDate.toISOString().split("T")[0];
    }

    requirements.push({
      id: genId("mr"),
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
  const fabricDemand = new Map<
    string,
    { total: number; byBucket: Record<TimeBucket, number> }
  >();
  for (const order of activeOrders) {
    if (!order.fabricCode) continue;
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
    if (!fabricDemand.has(order.fabricCode)) {
      fabricDemand.set(order.fabricCode, {
        total: 0,
        byBucket: { THIS_WEEK: 0, NEXT_WEEK: 0, WEEK_3_4: 0, BEYOND: 0 },
      });
    }
    const usage = order.itemCategory === "SOFA" ? 5 : 3;
    const qty = usage * order.quantity;
    const fd = fabricDemand.get(order.fabricCode)!;
    fd.total += qty;
    fd.byBucket[bucket] += qty;
  }

  const fabricDetail = fabrics.map((fab) => {
    const fd = fabricDemand.get(fab.code);
    const totalUsage = fd?.total || 0;
    return {
      id: fab.id,
      code: fab.code,
      name: fab.name,
      category: fab.category ?? "",
      sohMeters: fab.sohMeters,
      poOutstanding: 0,
      weeklyUsage: Math.ceil(fd?.byBucket.THIS_WEEK || 0),
      twoWeekUsage: Math.ceil(
        (fd?.byBucket.THIS_WEEK || 0) + (fd?.byBucket.NEXT_WEEK || 0),
      ),
      monthlyUsage: Math.ceil(totalUsage),
      shortage: fab.sohMeters < totalUsage,
      byBucket:
        fd?.byBucket || {
          THIS_WEEK: 0,
          NEXT_WEEK: 0,
          WEEK_3_4: 0,
          BEYOND: 0,
        },
    };
  });

  return c.json({
    success: true,
    data: newRun,
    fabricDetail,
    bucketLabels: BUCKET_LABELS,
    meta: {
      matchedPOs,
      unmatchedPOs,
      horizon: horizonParam,
      note:
        unmatchedPOs > 0
          ? `${unmatchedPOs} POs had no BOM template — add materials to their BOM templates for complete MRP coverage`
          : "All POs matched to BOM templates",
    },
  });
});

export default app;
