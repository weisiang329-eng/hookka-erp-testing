import { Hono } from 'hono';
import {
  deliveryOrders,
  productionOrders,
  salesOrders,
  customers,
  products,
  lorries,
  threePLProviders,
  soStatusChanges,
  costLedger,
  fgBatches,
  generateId,
  getNextDONo,
} from '../../lib/mock-data';
import type { DeliveryOrder, DeliveryOrderItem } from '../../lib/mock-data';
import { fifoConsumeFG, makeLedgerEntry } from '../../lib/costing';

const app = new Hono();

// Valid status transitions
const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['LOADED'],
  LOADED: ['DRAFT', 'IN_TRANSIT', 'DELIVERED'],
  IN_TRANSIT: ['DELIVERED'],
  DELIVERED: ['INVOICED'],
};

// ---------------------------------------------------------------
// DO delivered → FIFO-consume FG batches → post COGS (Phase 3b)
// ---------------------------------------------------------------
//
// Each DO line points at a productionOrderId, which during PO completion
// minted one FGBatch layer with material + labor cost. On delivery we
// pull from those layers FIFO (by completedDate) and emit one
// FG_DELIVERED ledger entry per slice. The ledger then carries the COGS
// total for this DO, which financials/accounting can slice by date.
//
// Idempotency: guarded by "does any FG_DELIVERED entry refer to this
// DO?" — re-entering the DELIVERED state is a no-op.
function postDeliveryOrderShipment(order: DeliveryOrder): {
  cogsTotalSen: number;
  shortageLines: string[];
} | undefined {
  const already = costLedger.some(
    (e) =>
      e.refType === 'DELIVERY_ORDER' &&
      e.refId === order.id &&
      e.type === 'FG_DELIVERED',
  );
  if (already) return;

  const deliveredIso = order.deliveredAt || new Date().toISOString();
  let cogsTotalSen = 0;
  const shortageLines: string[] = [];

  for (const item of order.items) {
    const qty = Number(item.quantity) || 0;
    if (qty <= 0 || !item.productionOrderId) continue;

    const layers = fgBatches.filter(
      (b) => b.productionOrderId === item.productionOrderId,
    );
    if (layers.length === 0) {
      shortageLines.push(`${item.productCode}: no FG layer (PO not yet completed?)`);
      continue;
    }

    const result = fifoConsumeFG(layers, qty);
    cogsTotalSen += result.totalCostSen;

    for (const slice of result.slices) {
      const layer = fgBatches.find((b) => b.id === slice.batchId);
      if (!layer) continue;
      costLedger.push(
        makeLedgerEntry({
          date: deliveredIso,
          type: 'FG_DELIVERED',
          itemType: 'FG',
          itemId: layer.productId,
          batchId: slice.batchId,
          qty: slice.qty,
          direction: 'OUT',
          unitCostSen: slice.unitCostSen,
          refType: 'DELIVERY_ORDER',
          refId: order.id,
          notes: `Delivered via ${order.doNo} (${item.productCode})`,
        }),
      );
    }

    if (result.shortageQty > 0) {
      shortageLines.push(
        `${item.productCode}: short ${result.shortageQty}`,
      );
    }
  }

  return { cogsTotalSen, shortageLines };
}

// GET /api/delivery-orders
app.get('/', (c) => {
  // One-time cleanup
  const cleanupFlag = '__hookka_doCleanupDone__';
  const g = globalThis as Record<string, unknown>;
  if (!g[cleanupFlag]) {
    for (let i = deliveryOrders.length - 1; i >= 0; i--) {
      const r = deliveryOrders[i]?.remarks || '';
      if (
        r === 'Auto-created on Upholstery completion' ||
        r === 'Auto-created — all SO upholstery complete'
      ) {
        deliveryOrders.splice(i, 1);
      }
    }
    g[cleanupFlag] = true;
  }

  const coveredPOIds = new Set<string>();
  for (const d of deliveryOrders) {
    for (const item of d.items || []) {
      if (item.productionOrderId) coveredPOIds.add(item.productionOrderId);
    }
  }

  const virtualPending: DeliveryOrder[] = [];

  for (const po of productionOrders) {
    if (coveredPOIds.has(po.id)) continue;

    const uphCards = po.jobCards.filter((j) => j.departmentCode === 'UPHOLSTERY');
    if (uphCards.length === 0) continue;
    const allDone = uphCards.every(
      (j) => j.status === 'COMPLETED' || j.status === 'TRANSFERRED'
    );
    if (!allDone) continue;

    const so = salesOrders.find((s) => s.id === po.salesOrderId);
    const customer = so ? customers.find((cu) => cu.id === so.customerId) : null;
    const soHub =
      customer?.deliveryHubs?.find((h) => h.id === so?.hubId) ||
      customer?.deliveryHubs?.[0] ||
      null;
    const product =
      products.find((pr) => pr.id === po.productId) ||
      products.find((pr) => pr.code === po.productCode);

    const item: DeliveryOrderItem = {
      id: `virt-doi-${po.id}`,
      productionOrderId: po.id,
      salesOrderNo: so?.companySOId || '',
      poNo: po.poNo || '',
      productCode: po.productCode || '',
      productName: po.productName || '',
      sizeLabel: po.sizeLabel || '',
      fabricCode: po.fabricCode || '',
      quantity: po.quantity || 1,
      itemM3: product?.unitM3 ?? 0,
      rackingNumber: po.rackingNumber || '',
      packingStatus: 'READY',
    };

    const totalM3 = item.itemM3 * item.quantity;

    virtualPending.push({
      id: `virt-po-${po.id}`,
      doNo: '',
      salesOrderId: po.salesOrderId,
      companySO: so?.companySO || '',
      companySOId: so?.companySOId || '',
      customerId: so?.customerId || '',
      customerPOId: so?.customerPOId || '',
      customerName: so?.customerName || po.customerName || '',
      customerState: so?.customerState || po.customerState || '',
      deliveryAddress: soHub?.address || '',
      hubId: soHub?.id || null,
      hubName: soHub?.shortName || '',
      contactPerson: customer?.contactName || '',
      contactPhone: customer?.phone || '',
      deliveryDate: so?.customerDeliveryDate || '',
      hookkaExpectedDD: so?.hookkaExpectedDD || '',
      driverId: null,
      driverName: '',
      vehicleNo: '',
      dropPoints: 1,
      deliveryCostSen: 0,
      items: [item],
      totalM3: Math.round(totalM3 * 100) / 100,
      totalItems: item.quantity,
      status: 'DRAFT',
      overdue: 'PENDING',
      dispatchedAt: null,
      deliveredAt: null,
      remarks: 'Virtual — awaiting packing list / dispatch',
      createdAt: so?.updatedAt || new Date().toISOString(),
      updatedAt: so?.updatedAt || new Date().toISOString(),
    });
  }

  const combined = [...virtualPending, ...deliveryOrders];
  return c.json({
    success: true,
    data: combined,
    total: combined.length,
  });
});

// POST /api/delivery-orders
app.post('/', async (c) => {
  const body = await c.req.json();

  // New mode: create from production order IDs
  if (body.productionOrderIds && Array.isArray(body.productionOrderIds)) {
    const poIds: string[] = body.productionOrderIds;
    const matchedPOs = productionOrders.filter((po) => poIds.includes(po.id));

    if (matchedPOs.length === 0) {
      return c.json({ success: false, error: 'No matching production orders found' }, 400);
    }

    const firstPO = matchedPOs[0];
    const salesOrder = salesOrders.find((so) => so.id === firstPO.salesOrderId);
    const customer = salesOrder ? customers.find((cu) => cu.id === salesOrder.customerId) : null;
    const newHub =
      customer?.deliveryHubs?.find((h) => h.id === salesOrder?.hubId) ||
      customer?.deliveryHubs?.[0] ||
      null;

    const items: DeliveryOrderItem[] = (
      body.items && body.items.length > 0
        ? body.items
        : matchedPOs.map((po) => {
            const product = products.find((p) => p.id === po.productId);
            const poSO = salesOrders.find((s) => s.id === po.salesOrderId);
            return {
              productionOrderId: po.id,
              salesOrderNo: poSO?.companySOId || '',
              poNo: po.poNo,
              productCode: po.productCode,
              productName: po.productName,
              sizeLabel: po.sizeLabel,
              fabricCode: po.fabricCode,
              quantity: po.quantity,
              itemM3: product?.unitM3 ?? 0.85,
              rackingNumber: po.rackingNumber || '',
              packingStatus: 'PACKED',
            };
          })
    ).map((item: Record<string, unknown>) => ({
      id: (item.id as string) || generateId(),
      productionOrderId: (item.productionOrderId as string) || '',
      salesOrderNo: (item.salesOrderNo as string) || '',
      poNo: (item.poNo as string) || '',
      productCode: (item.productCode as string) || '',
      productName: (item.productName as string) || '',
      sizeLabel: (item.sizeLabel as string) || '',
      fabricCode: (item.fabricCode as string) || '',
      quantity: Number(item.quantity) || 0,
      itemM3: Number(item.itemM3) || 0,
      rackingNumber: (item.rackingNumber as string) || '',
      packingStatus: (item.packingStatus as string) || 'PACKED',
    }));

    const totalM3 = items.reduce((sum, i) => sum + i.itemM3, 0);
    const totalItems = items.reduce((sum, i) => sum + i.quantity, 0);
    const now = new Date().toISOString();
    const doNo = getNextDONo();

    const newDO: DeliveryOrder = {
      id: generateId(),
      doNo,
      salesOrderId: salesOrder?.id || firstPO.salesOrderId,
      companySO: salesOrder?.companySO || firstPO.companySOId || '',
      companySOId: salesOrder?.companySOId || firstPO.companySOId,
      customerId: salesOrder?.customerId || '',
      customerPOId: salesOrder?.customerPOId || '',
      customerName: salesOrder?.customerName || firstPO.customerName,
      customerState: salesOrder?.customerState || firstPO.customerState,
      deliveryAddress: body.deliveryAddress || newHub?.address || '',
      hubId: newHub?.id || null,
      hubName: newHub?.shortName || '',
      contactPerson: customer?.contactName || body.contactPerson || '',
      contactPhone: customer?.phone || body.contactPhone || '',
      deliveryDate: body.deliveryDate || '',
      hookkaExpectedDD: salesOrder?.hookkaExpectedDD || '',
      driverId: body.driverId || null,
      driverName: body.driverName || '',
      vehicleNo: body.vehicleNo || '',
      dropPoints: Number(body.dropPoints) || 1,
      deliveryCostSen: Number(body.deliveryCostSen) || 0,
      items,
      totalM3: Math.round(totalM3 * 100) / 100,
      totalItems,
      status: 'DRAFT',
      overdue: 'PENDING',
      dispatchedAt: null,
      deliveredAt: null,
      remarks: body.remarks || '',
      createdAt: now,
      updatedAt: now,
    };

    if (newDO.driverId) {
      const provider = threePLProviders.find((p) => p.id === newDO.driverId);
      if (provider) {
        newDO.driverName = provider.name;
        newDO.vehicleNo = newDO.vehicleNo || provider.vehicleNo || '';
        const drops = newDO.dropPoints ?? 1;
        newDO.deliveryCostSen =
          provider.ratePerTripSen + Math.max(0, drops - 1) * provider.ratePerExtraDropSen;
      }
    }

    deliveryOrders.unshift(newDO);
    return c.json({ success: true, data: newDO }, 201);
  }

  // Legacy mode: create from salesOrderId
  const salesOrder = salesOrders.find((so) => so.id === body.salesOrderId);
  if (!salesOrder) {
    return c.json({ success: false, error: 'Sales order not found' }, 400);
  }

  const customer = customers.find((cu) => cu.id === salesOrder.customerId);
  const legacyHub =
    customer?.deliveryHubs?.find((h) => h.id === salesOrder.hubId) ||
    customer?.deliveryHubs?.[0] ||
    null;

  const items: DeliveryOrderItem[] = (body.items || []).map(
    (item: Record<string, unknown>) => ({
      id: (item.id as string) || generateId(),
      productionOrderId: item.productionOrderId || '',
      salesOrderNo: (item.salesOrderNo as string) || '',
      poNo: item.poNo || '',
      productCode: item.productCode || '',
      productName: item.productName || '',
      sizeLabel: item.sizeLabel || '',
      fabricCode: item.fabricCode || '',
      quantity: Number(item.quantity) || 0,
      itemM3: Number(item.itemM3) || 0,
      rackingNumber: (item.rackingNumber as string) || '',
      packingStatus: (item.packingStatus as string) || 'PENDING',
    })
  );

  const totalM3 = items.reduce((sum, i) => sum + i.itemM3, 0);
  const totalItems = items.reduce((sum, i) => sum + i.quantity, 0);
  const now = new Date().toISOString();
  const doNo = getNextDONo();

  const newDO: DeliveryOrder = {
    id: generateId(),
    doNo,
    salesOrderId: salesOrder.id,
    companySO: salesOrder.companySO,
    companySOId: salesOrder.companySOId,
    customerId: salesOrder.customerId,
    customerPOId: salesOrder.customerPOId,
    customerName: salesOrder.customerName,
    customerState: salesOrder.customerState,
    deliveryAddress: body.deliveryAddress || legacyHub?.address || '',
    hubId: legacyHub?.id || null,
    hubName: legacyHub?.shortName || '',
    contactPerson: customer?.contactName || body.contactPerson || '',
    contactPhone: customer?.phone || body.contactPhone || '',
    deliveryDate: body.deliveryDate || '',
    hookkaExpectedDD: salesOrder.hookkaExpectedDD,
    driverId: body.driverId || null,
    driverName: body.driverName || '',
    vehicleNo: body.vehicleNo || '',
    dropPoints: Number(body.dropPoints) || 1,
    deliveryCostSen: Number(body.deliveryCostSen) || 0,
    items,
    totalM3: Math.round(totalM3 * 100) / 100,
    totalItems,
    status: 'DRAFT',
    overdue: 'PENDING',
    dispatchedAt: null,
    deliveredAt: null,
    remarks: body.remarks || '',
    createdAt: now,
    updatedAt: now,
  };

  if (newDO.driverId) {
    const provider = threePLProviders.find((p) => p.id === newDO.driverId);
    if (provider) {
      newDO.driverName = provider.name;
      newDO.vehicleNo = newDO.vehicleNo || provider.vehicleNo || '';
      const drops = newDO.dropPoints ?? 1;
      newDO.deliveryCostSen =
        provider.ratePerTripSen + Math.max(0, drops - 1) * provider.ratePerExtraDropSen;
    }
  }

  deliveryOrders.unshift(newDO);
  salesOrder.hookkaDeliveryOrder = doNo;

  return c.json({ success: true, data: newDO }, 201);
});

// GET /api/delivery-orders/:id
app.get('/:id', (c) => {
  const id = c.req.param('id');
  const order = deliveryOrders.find((o) => o.id === id);
  if (!order) {
    return c.json({ success: false, error: 'Delivery order not found' }, 404);
  }
  return c.json({ success: true, data: order });
});

// PUT /api/delivery-orders/:id
app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = deliveryOrders.findIndex((o) => o.id === id);
  if (idx === -1) {
    return c.json({ success: false, error: 'Delivery order not found' }, 404);
  }

  const body = await c.req.json();
  const order = deliveryOrders[idx];

  // Proof of delivery
  if (body.proofOfDelivery) {
    const pod = body.proofOfDelivery;
    order.proofOfDelivery = {
      receiverName: pod.receiverName,
      receiverIC: pod.receiverIC,
      signatureDataUrl: pod.signatureDataUrl,
      photoDataUrls: Array.isArray(pod.photoDataUrls) ? pod.photoDataUrls.slice(0, 5) : [],
      remarks: pod.remarks,
      deliveredAt: pod.deliveredAt || new Date().toISOString(),
      capturedBy: pod.capturedBy,
    };
  }

  // Status transition
  if (body.status) {
    const currentStatus = order.status;
    const targetStatus = body.status;
    const allowed = VALID_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.includes(targetStatus)) {
      return c.json(
        {
          success: false,
          error: `Invalid status transition: ${currentStatus} → ${targetStatus}. Allowed transitions from ${currentStatus}: ${allowed?.join(', ') || 'none'}`,
        },
        400
      );
    }

    order.status = targetStatus;

    if (targetStatus === 'LOADED') order.dispatchedAt = new Date().toISOString();
    if (targetStatus === 'DRAFT') order.dispatchedAt = null;
    if (targetStatus === 'IN_TRANSIT' && !order.dispatchedAt) order.dispatchedAt = new Date().toISOString();
    if (targetStatus === 'DELIVERED') {
      order.deliveredAt =
        order.proofOfDelivery?.deliveredAt || order.deliveredAt || new Date().toISOString();
      order.overdue = 'COMPLETED';
      // FIFO-consume FG batches and emit COGS ledger entries (Phase 3b).
      postDeliveryOrderShipment(order);
    }
    if (targetStatus === 'INVOICED') {
      order.overdue = 'INVOICED';
      const linkedSO = salesOrders.find((s) => s.id === order.salesOrderId);
      if (linkedSO && linkedSO.status === 'SHIPPED') {
        const fromStatus = linkedSO.status;
        linkedSO.status = 'DELIVERED';
        linkedSO.updatedAt = new Date().toISOString();
        soStatusChanges.push({
          id: generateId(),
          soId: linkedSO.id,
          fromStatus,
          toStatus: 'DELIVERED',
          changedBy: 'System',
          timestamp: new Date().toISOString(),
          notes: 'Auto-advanced: DO invoiced',
          autoActions: ['DO_INVOICED_CASCADE'],
        });
      }
    }
    if (targetStatus === 'DELIVERED') {
      const linkedSO = salesOrders.find((s) => s.id === order.salesOrderId);
      if (
        linkedSO &&
        (linkedSO.status === 'IN_PRODUCTION' || linkedSO.status === 'READY_TO_SHIP')
      ) {
        const fromStatus = linkedSO.status;
        linkedSO.status = 'SHIPPED';
        linkedSO.updatedAt = new Date().toISOString();
        soStatusChanges.push({
          id: generateId(),
          soId: linkedSO.id,
          fromStatus,
          toStatus: 'SHIPPED',
          changedBy: 'System',
          timestamp: new Date().toISOString(),
          notes: 'Auto-advanced: DO delivered',
          autoActions: ['DO_DELIVERED_CASCADE'],
        });
      }
    }
  }

  if (body.deliveryDate !== undefined) order.deliveryDate = body.deliveryDate;
  if (body.driverId !== undefined) {
    order.driverId = body.driverId;
    if (body.driverId) {
      const provider = threePLProviders.find((p) => p.id === body.driverId);
      if (provider) {
        order.driverName = provider.name;
        if (provider.vehicleNo) order.vehicleNo = provider.vehicleNo;
      }
    }
  }
  if (body.driverName !== undefined) order.driverName = body.driverName;
  if (body.vehicleNo !== undefined) order.vehicleNo = body.vehicleNo;
  if (body.deliveryAddress !== undefined) order.deliveryAddress = body.deliveryAddress;
  if (body.contactPerson !== undefined) order.contactPerson = body.contactPerson;
  if (body.contactPhone !== undefined) order.contactPhone = body.contactPhone;
  if (body.remarks !== undefined) order.remarks = body.remarks;
  if (body.dropPoints !== undefined) order.dropPoints = Number(body.dropPoints) || 1;

  if (body.items !== undefined && Array.isArray(body.items)) {
    order.items = body.items.map((item: Record<string, unknown>) => ({
      id: (item.id as string) || generateId(),
      productionOrderId: (item.productionOrderId as string) || '',
      salesOrderNo: (item.salesOrderNo as string) || '',
      poNo: (item.poNo as string) || '',
      productCode: (item.productCode as string) || '',
      productName: (item.productName as string) || '',
      sizeLabel: (item.sizeLabel as string) || '',
      fabricCode: (item.fabricCode as string) || '',
      quantity: Number(item.quantity) || 0,
      itemM3: Number(item.itemM3) || 0,
      rackingNumber: (item.rackingNumber as string) || '',
      packingStatus: (item.packingStatus as string) || 'PACKED',
    }));
    order.totalM3 =
      Math.round(
        order.items.reduce(
          (s: number, i: { itemM3: number; quantity: number }) => s + i.itemM3 * i.quantity,
          0
        ) * 100
      ) / 100;
    order.totalItems = order.items.reduce(
      (s: number, i: { quantity: number }) => s + i.quantity,
      0
    );
  }

  if (body.driverId !== undefined || body.dropPoints !== undefined) {
    const providerId = order.driverId;
    if (providerId) {
      const provider = threePLProviders.find((p) => p.id === providerId);
      if (provider) {
        const drops = order.dropPoints || 1;
        order.deliveryCostSen =
          provider.ratePerTripSen + Math.max(0, drops - 1) * provider.ratePerExtraDropSen;
      }
    }
  }
  if (body.deliveryCostSen !== undefined) order.deliveryCostSen = Number(body.deliveryCostSen);

  if (body.lorryId !== undefined) {
    const lorry = lorries.find((l) => l.id === body.lorryId);
    if (lorry) {
      (order as Record<string, unknown>).lorryId = lorry.id;
      (order as Record<string, unknown>).lorryName = lorry.name;
      order.driverName = lorry.driverName;
      order.vehicleNo = lorry.plateNumber;
    } else if (body.lorryId === null) {
      (order as Record<string, unknown>).lorryId = null;
      (order as Record<string, unknown>).lorryName = '';
    }
  }

  order.updatedAt = new Date().toISOString();
  deliveryOrders[idx] = order;

  return c.json({ success: true, data: order });
});

export default app;
