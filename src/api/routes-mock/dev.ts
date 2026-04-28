import { Hono } from 'hono';
import { salesOrders, productionOrders, soStatusChanges } from '../../lib/mock-data';

const app = new Hono();

// POST /api/dev/reset-imported-sos
app.post('/reset-imported-sos', (c) => {
  let resetCount = 0;
  for (const so of salesOrders) {
    if (so.id.startsWith('so-bf-')) {
      so.status = 'DRAFT';
      so.updatedAt = new Date().toISOString();
      resetCount++;
    }
  }

  const poBefore = productionOrders.length;
  for (let i = productionOrders.length - 1; i >= 0; i--) {
    if (productionOrders[i].salesOrderId?.startsWith('so-bf-')) {
      productionOrders.splice(i, 1);
    }
  }
  const poRemoved = poBefore - productionOrders.length;

  const scBefore = soStatusChanges.length;
  for (let i = soStatusChanges.length - 1; i >= 0; i--) {
    if (soStatusChanges[i].soId?.startsWith('so-bf-')) {
      soStatusChanges.splice(i, 1);
    }
  }
  const scRemoved = scBefore - soStatusChanges.length;

  return c.json({
    success: true,
    resetCount,
    poRemoved,
    statusChangesRemoved: scRemoved,
    message: `Reset ${resetCount} BF SOs back to DRAFT, removed ${poRemoved} PO(s) and ${scRemoved} status change(s).`,
  });
});

export default app;
