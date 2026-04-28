// ---------------------------------------------------------------------------
// Cost ledger API
//
// Exposes the in-memory FIFO cost ledger (entries, batches, rollups). All
// entries are appended by grn.ts (RM_RECEIPT), production-orders.ts
// (RM_ISSUE, LABOR_POSTED, FG_COMPLETED), and delivery-orders.ts
// (FG_DELIVERED). This route is read-only — writes happen side-effectually
// from the triggering business routes, so the ledger stays audit-ordered.
//
// Endpoints
//   GET /api/cost-ledger                → all entries
//   GET /api/cost-ledger?itemType=FG&itemId=prod-42
//   GET /api/cost-ledger?refType=DELIVERY_ORDER&refId=do-123
//   GET /api/cost-ledger/rm-batches     → all RMBatch layers (optionally ?rmId=…)
//   GET /api/cost-ledger/fg-batches     → all FGBatch layers (optionally ?productId=…)
//   GET /api/cost-ledger/summary        → quick dashboard numbers
// ---------------------------------------------------------------------------
import { Hono } from 'hono';
import {
  costLedger,
  rmBatches,
  fgBatches,
} from '../../lib/mock-data';
import {
  laborRateForDate,
  totalBatchValueSen,
} from '../../lib/costing';

const app = new Hono();

app.get('/', (c) => {
  const itemType = c.req.query('itemType');
  const itemId = c.req.query('itemId');
  const refType = c.req.query('refType');
  const refId = c.req.query('refId');
  const type = c.req.query('type');

  let rows = costLedger;
  if (itemType) rows = rows.filter((r) => r.itemType === itemType);
  if (itemId) rows = rows.filter((r) => r.itemId === itemId);
  if (refType) rows = rows.filter((r) => r.refType === refType);
  if (refId) rows = rows.filter((r) => r.refId === refId);
  if (type) rows = rows.filter((r) => r.type === type);

  return c.json({
    success: true,
    data: rows,
    total: rows.length,
  });
});

app.get('/rm-batches', (c) => {
  const rmId = c.req.query('rmId');
  const rows = rmId ? rmBatches.filter((b) => b.rmId === rmId) : rmBatches;
  return c.json({
    success: true,
    data: rows,
    total: rows.length,
    totalValueSen: totalBatchValueSen(rows),
  });
});

app.get('/fg-batches', (c) => {
  const productId = c.req.query('productId');
  const productionOrderId = c.req.query('productionOrderId');
  let rows = fgBatches;
  if (productId) rows = rows.filter((b) => b.productId === productId);
  if (productionOrderId) {
    rows = rows.filter((b) => b.productionOrderId === productionOrderId);
  }
  const onHandValueSen = rows.reduce(
    (s, b) => s + Math.max(0, b.remainingQty) * b.unitCostSen,
    0,
  );
  return c.json({
    success: true,
    data: rows,
    total: rows.length,
    onHandValueSen,
  });
});

app.get('/summary', (c) => {
  const now = new Date();
  const rmOnHandSen = totalBatchValueSen(rmBatches);
  const fgOnHandSen = fgBatches.reduce(
    (s, b) => s + Math.max(0, b.remainingQty) * b.unitCostSen,
    0,
  );
  const cogsThisMonthSen = costLedger
    .filter((e) => e.type === 'FG_DELIVERED')
    .filter((e) => {
      const d = new Date(e.date);
      return (
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth()
      );
    })
    .reduce((s, e) => s + e.totalCostSen, 0);
  const laborPostedThisMonthSen = costLedger
    .filter((e) => e.type === 'LABOR_POSTED')
    .filter((e) => {
      const d = new Date(e.date);
      return (
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth()
      );
    })
    .reduce((s, e) => s + e.totalCostSen, 0);

  return c.json({
    success: true,
    data: {
      asOf: now.toISOString(),
      laborRatePerMinuteSen: laborRateForDate(now),
      rmOnHandSen,
      fgOnHandSen,
      totalLedgerEntries: costLedger.length,
      cogsThisMonthSen,
      laborPostedThisMonthSen,
    },
  });
});

export default app;
