import { Hono } from 'hono';
import {
  mrpRuns,
  productionOrders,
  bomTemplates,
  rawMaterials,
  fabrics,
  supplierMaterialBindings,
  suppliers,
  generateId,
  type MaterialRequirement,
  type MRPRun,
  type BOMTemplateWIP,
  type BOMTemplate,
} from '../../lib/mock-data';

const app = new Hono();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normCode(s: string): string {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function findBomTemplate(productCode: string): BOMTemplate | undefined {
  const want = normCode(productCode);
  return (
    bomTemplates.find((t) => t.productCode === productCode && t.versionStatus === 'ACTIVE') ||
    bomTemplates.find((t) => normCode(t.productCode) === want && t.versionStatus === 'ACTIVE') ||
    bomTemplates.find((t) => t.productCode === productCode) ||
    bomTemplates.find((t) => normCode(t.productCode) === want)
  );
}

/** Time bucket label */
type TimeBucket = 'THIS_WEEK' | 'NEXT_WEEK' | 'WEEK_3_4' | 'BEYOND';

const BUCKET_LABELS: Record<TimeBucket, string> = {
  THIS_WEEK: 'This Week',
  NEXT_WEEK: 'Next Week',
  WEEK_3_4: '2-4 Weeks',
  BEYOND: 'Beyond 4 Weeks',
};

function dateToBucket(dateStr: string, now: Date): TimeBucket {
  if (!dateStr) return 'THIS_WEEK'; // no date = urgent
  const d = new Date(dateStr);
  const diffMs = d.getTime() - now.getTime();
  const diffDays = diffMs / 86400000;
  if (diffDays <= 7) return 'THIS_WEEK';
  if (diffDays <= 14) return 'NEXT_WEEK';
  if (diffDays <= 28) return 'WEEK_3_4';
  return 'BEYOND';
}

type MatDemand = {
  code: string;
  name: string;
  unit: string;
  totalQty: number;
  byBucket: Record<TimeBucket, number>;
  poSources: { poNo: string; productCode: string; qty: number; dueDate: string; bucket: TimeBucket }[];
};

/**
 * Recursively collect materials from a BOM WIP node.
 * Uses the earliest job card dueDate matching this WIP's deptCode to determine
 * WHEN the material is needed.
 */
function collectMaterials(
  node: BOMTemplateWIP,
  poQty: number,
  parentQty: number,
  poNo: string,
  productCode: string,
  dueDate: string,
  bucket: TimeBucket,
  demandMap: Map<string, MatDemand>,
): void {
  const effectiveQty = (node.quantity || 1) * parentQty;

  for (const mat of node.materials || []) {
    const key = mat.inventoryCode || mat.code;
    if (!key) continue;
    const matQty = (mat.qty || 0) * effectiveQty * poQty;
    if (matQty <= 0) continue;

    if (!demandMap.has(key)) {
      demandMap.set(key, {
        code: key,
        name: mat.name || key,
        unit: mat.unit || 'PCS',
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
    collectMaterials(child, poQty, effectiveQty, poNo, productCode, dueDate, bucket, demandMap);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/', (c) => {
  const latest = mrpRuns.length > 0 ? mrpRuns[mrpRuns.length - 1] : null;
  return c.json({ success: true, data: latest, allRuns: mrpRuns.length });
});

// POST /api/mrp — run MRP with time-bucketed demand
app.post('/', (c) => {
  const now = new Date();

  // Planning horizon filter (optional query param: "1w", "2w", "1m", "all")
  const horizonParam = c.req.query('horizon') || 'all';

  const activeOrders = productionOrders.filter(
    (po) => po.status === 'PENDING' || po.status === 'IN_PROGRESS'
  );

  const demandMap = new Map<string, MatDemand>();
  let matchedPOs = 0;
  let unmatchedPOs = 0;

  for (const order of activeOrders) {
    const bom = findBomTemplate(order.productCode);
    if (!bom) { unmatchedPOs++; continue; }
    matchedPOs++;

    // Determine when this PO's materials are needed:
    // Use the earliest non-completed job card's dueDate
    const pendingJcs = order.jobCards.filter(
      (jc) => jc.status !== 'COMPLETED' && jc.status !== 'TRANSFERRED'
    );
    const earliestDue = pendingJcs.length > 0
      ? pendingJcs.reduce((min, jc) => (!min || (jc.dueDate && jc.dueDate < min) ? jc.dueDate : min), '')
      : order.targetEndDate || '';
    const bucket = dateToBucket(earliestDue, now);

    // Filter by horizon
    if (horizonParam === '1w' && bucket !== 'THIS_WEEK') continue;
    if (horizonParam === '2w' && bucket !== 'THIS_WEEK' && bucket !== 'NEXT_WEEK') continue;
    if (horizonParam === '1m' && bucket === 'BEYOND') continue;

    for (const wip of bom.wipComponents) {
      collectMaterials(wip, order.quantity, 1, order.poNo, order.productCode, earliestDue, bucket, demandMap);
    }
  }

  // Build requirements with time breakdown
  const requirements: (MaterialRequirement & {
    byBucket: Record<TimeBucket, number>;
    leadTimeDays?: number;
    suggestedOrderDate?: string;
  })[] = [];

  for (const [code, demand] of demandMap) {
    const rm = rawMaterials.find((r) => r.itemCode === code);
    const onHand = rm ? rm.balanceQty : 0;
    const grossRequired = Math.ceil(demand.totalQty);
    const onOrder = 0;
    const netRequired = Math.max(0, grossRequired - onHand - onOrder);

    let status: 'SUFFICIENT' | 'LOW' | 'SHORTAGE';
    if (netRequired > 0) {
      status = 'SHORTAGE';
    } else if (onHand > 0 && (onHand - grossRequired) < onHand * 0.2) {
      status = 'LOW';
    } else {
      status = 'SUFFICIENT';
    }

    const mainBinding = supplierMaterialBindings.find(
      (b) => b.materialCode === code && b.isMainSupplier
    );
    const moq = mainBinding?.moq || 50;
    const suggestedPOQty = netRequired > 0 ? Math.ceil(netRequired / moq) * moq : 0;

    const supplier = mainBinding
      ? suppliers.find((s) => s.id === mainBinding.supplierId)
      : undefined;

    // Calculate when to order: earliest need date - supplier lead time
    const leadTimeDays = mainBinding?.leadTimeDays || 14;
    const earliestNeedDate = demand.poSources
      .filter((s) => s.dueDate)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0]?.dueDate;
    let suggestedOrderDate: string | undefined;
    if (earliestNeedDate && netRequired > 0) {
      const needDate = new Date(earliestNeedDate);
      needDate.setDate(needDate.getDate() - leadTimeDays);
      suggestedOrderDate = needDate.toISOString().split('T')[0];
    }

    requirements.push({
      id: generateId(),
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

  // Sort: SHORTAGE first, then by urgency (this week demand first)
  const statusOrder = { SHORTAGE: 0, LOW: 1, SUFFICIENT: 2 };
  requirements.sort((a, b) => {
    if (statusOrder[a.status] !== statusOrder[b.status])
      return statusOrder[a.status] - statusOrder[b.status];
    return (b.byBucket?.THIS_WEEK || 0) - (a.byBucket?.THIS_WEEK || 0);
  });

  const shortageCount = requirements.filter((r) => r.status === 'SHORTAGE').length;

  const newRun: MRPRun = {
    id: `mrp-run-${String(mrpRuns.length + 1).padStart(3, '0')}`,
    runDate: new Date().toISOString(),
    planningHorizon: horizonParam === '1w' ? '1 week' : horizonParam === '2w' ? '2 weeks' : horizonParam === '1m' ? '1 month' : 'All',
    productionOrderCount: activeOrders.length,
    totalMaterials: requirements.length,
    shortageCount,
    status: 'COMPLETED',
    requirements,
  };

  mrpRuns.push(newRun);

  // Fabric planning
  const fabricDemand = new Map<string, { total: number; byBucket: Record<TimeBucket, number> }>();
  for (const order of activeOrders) {
    if (!order.fabricCode) continue;
    const pendingJcs = order.jobCards.filter(
      (jc) => jc.status !== 'COMPLETED' && jc.status !== 'TRANSFERRED'
    );
    const earliestDue = pendingJcs.length > 0
      ? pendingJcs.reduce((min, jc) => (!min || (jc.dueDate && jc.dueDate < min) ? jc.dueDate : min), '')
      : order.targetEndDate || '';
    const bucket = dateToBucket(earliestDue, now);

    if (!fabricDemand.has(order.fabricCode)) {
      fabricDemand.set(order.fabricCode, { total: 0, byBucket: { THIS_WEEK: 0, NEXT_WEEK: 0, WEEK_3_4: 0, BEYOND: 0 } });
    }
    const usage = order.itemCategory === 'SOFA' ? 5 : 3;
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
      category: fab.category,
      sohMeters: fab.sohMeters,
      poOutstanding: 0,
      weeklyUsage: Math.ceil(fd?.byBucket.THIS_WEEK || 0),
      twoWeekUsage: Math.ceil((fd?.byBucket.THIS_WEEK || 0) + (fd?.byBucket.NEXT_WEEK || 0)),
      monthlyUsage: Math.ceil(totalUsage),
      shortage: fab.sohMeters < totalUsage,
      byBucket: fd?.byBucket || { THIS_WEEK: 0, NEXT_WEEK: 0, WEEK_3_4: 0, BEYOND: 0 },
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
      note: unmatchedPOs > 0
        ? `${unmatchedPOs} POs had no BOM template — add materials to their BOM templates for complete MRP coverage`
        : 'All POs matched to BOM templates',
    },
  });
});

export default app;
