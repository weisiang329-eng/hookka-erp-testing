import { Hono } from 'hono';
import { calculateUnitPrice, calculateLineTotal } from '../../lib/pricing';
import {
  salesOrders,
  customers,
  products,
  productionOrders,
  soStatusChanges,
  priceOverrides,
  generateId,
  getNextSONo,
} from '../../lib/mock-data';
import type { SalesOrder, SalesOrderItem, SOStatus, ProductionOrder } from '../../lib/mock-data';
import { buildProductionOrderForSOItem } from '../../lib/production-order-builder';

const app = new Hono();

// GET /api/sales-orders
app.get('/', (c) => {
  return c.json({
    success: true,
    data: salesOrders,
    total: salesOrders.length,
  });
});

// POST /api/sales-orders
app.post('/', async (c) => {
  const body = await c.req.json();

  const customer = customers.find((cu) => cu.id === body.customerId);
  if (!customer) {
    return c.json({ success: false, error: 'Customer not found' }, 400);
  }

  const items: SalesOrderItem[] = (body.items || []).map(
    (item: Record<string, unknown>, idx: number) => {
      let resolvedProduct = null;
      const productCode = (item.productCode as string) || '';
      if (productCode) {
        resolvedProduct =
          products.find((p) => p.code === productCode) ||
          products.find((p) => p.code.toLowerCase() === productCode.toLowerCase());
      }

      let basePriceSen = Number(item.basePriceSen) || 0;
      if (basePriceSen === 0 && resolvedProduct) {
        const seatHeight = (item.seatHeight as string) || '';
        if (resolvedProduct.seatHeightPrices && seatHeight) {
          const shp = resolvedProduct.seatHeightPrices.find(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (p: any) => p.height === seatHeight || p.height === `${seatHeight}"`
          );
          basePriceSen = shp?.priceSen || resolvedProduct.basePriceSen || 0;
        } else {
          basePriceSen = resolvedProduct.basePriceSen || 0;
        }
      }

      const divanPriceSen = Number(item.divanPriceSen) || 0;
      const legPriceSen = Number(item.legPriceSen) || 0;
      const specialOrderPriceSen = Number(item.specialOrderPriceSen) || 0;
      const unitPriceSen = calculateUnitPrice({ basePriceSen, divanPriceSen, legPriceSen, specialOrderPriceSen });
      const quantity = Number(item.quantity) || 0;
      const lineTotalSen = calculateLineTotal(unitPriceSen, quantity);
      const lineNo = idx + 1;
      const lineSuffix = `-${String(lineNo).padStart(2, '0')}`;

      return {
        id: (item.id as string) || generateId(),
        lineNo,
        lineSuffix,
        productId: (item.productId as string) || resolvedProduct?.id || '',
        productCode,
        productName: (item.productName as string) || resolvedProduct?.name || productCode,
        itemCategory: item.itemCategory || resolvedProduct?.category || 'BEDFRAME',
        sizeCode: item.sizeCode || resolvedProduct?.sizeCode || '',
        sizeLabel: item.sizeLabel || resolvedProduct?.sizeLabel || item.sizeCode || '',
        fabricId: item.fabricId,
        fabricCode: item.fabricCode,
        quantity,
        gapInches: item.gapInches ?? null,
        divanHeightInches: item.divanHeightInches ?? null,
        divanPriceSen,
        legHeightInches: item.legHeightInches ?? null,
        legPriceSen,
        specialOrder: (item.specialOrder as string) || '',
        specialOrderPriceSen,
        basePriceSen,
        unitPriceSen,
        lineTotalSen,
        notes: (item.notes as string) || '',
      } as SalesOrderItem;
    }
  );

  const subtotalSen = items.reduce((sum, i) => sum + i.lineTotalSen, 0);
  const now = new Date().toISOString();
  const companySOId = getNextSONo();

  const hubIdField = body.hubId || body.deliveryHubId || '';
  const chosenHub =
    (hubIdField && customer.deliveryHubs?.find((h) => h.id === hubIdField)) ||
    customer.deliveryHubs?.[0] ||
    null;

  const newOrder: SalesOrder = {
    id: generateId(),
    customerPO: body.customerPO || '',
    customerPOId: body.customerPOId || '',
    customerPODate: body.customerPODate || new Date().toISOString().split('T')[0],
    customerSO: body.customerSO || '',
    customerSOId: body.customerSOId || '',
    reference: body.reference || '',
    customerId: customer.id,
    customerName: customer.name,
    customerState: chosenHub?.state || body.customerState || '',
    companySO: body.companySO || `Sales Order ${companySOId.split('-').pop()}`,
    companySOId,
    companySODate: body.companySODate || new Date().toISOString().split('T')[0],
    customerDeliveryDate: body.customerDeliveryDate || '',
    hookkaExpectedDD: body.hookkaExpectedDD || '',
    hookkaDeliveryOrder: body.hookkaDeliveryOrder || '',
    items,
    subtotalSen,
    totalSen: subtotalSen,
    status: 'DRAFT' as SOStatus,
    overdue: 'PENDING',
    notes: body.notes || '',
    createdAt: now,
    updatedAt: now,
  };

  salesOrders.unshift(newOrder);

  return c.json({ success: true, data: newOrder }, 201);
});

// Valid status transitions
const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['IN_PRODUCTION', 'ON_HOLD', 'CANCELLED'],
  IN_PRODUCTION: ['READY_TO_SHIP', 'ON_HOLD', 'CANCELLED'],
  READY_TO_SHIP: ['SHIPPED', 'ON_HOLD'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: ['INVOICED'],
  INVOICED: ['CLOSED'],
  ON_HOLD: ['CONFIRMED', 'IN_PRODUCTION', 'CANCELLED'],
  CLOSED: [],
  CANCELLED: [],
};

// GET /api/sales-orders/status-changes
app.get('/status-changes', (c) => {
  return c.json({
    success: true,
    data: soStatusChanges,
    total: soStatusChanges.length,
  });
});

// POST /api/sales-orders/:id/confirm
app.post('/:id/confirm', async (c) => {
  const id = c.req.param('id');
  const order = salesOrders.find((o) => o.id === id);

  if (!order) {
    return c.json({ success: false, error: 'Order not found' }, 404);
  }

  if (order.status !== 'DRAFT') {
    return c.json(
      {
        success: false,
        error: `Cannot confirm order with status ${order.status}. Only DRAFT orders can be confirmed.`,
      },
      400
    );
  }

  // Check customer PO uniqueness (BR-SO-010)
  if (order.customerPOId) {
    const duplicate = salesOrders.find(
      (o) =>
        o.id !== order.id &&
        o.customerPOId === order.customerPOId &&
        o.customerId === order.customerId &&
        o.status !== 'CANCELLED'
    );
    if (duplicate) {
      return c.json(
        {
          success: false,
          error: `Customer PO ${order.customerPOId} already exists on ${duplicate.companySOId}. Each customer PO must be unique.`,
        },
        400
      );
    }
  }

  const body = await c.req.json().catch(() => ({}));
  const now = new Date().toISOString();
  const fromStatus = order.status;

  const createdPOs: ProductionOrder[] = [];
  const bomFallbacks: string[] = [];
  const bomWarningMessages: string[] = [];

  try {
    for (const item of order.items) {
      const existingPO = productionOrders.find(
        (po) => po.salesOrderId === order.id && po.lineNo === item.lineNo
      );
      if (existingPO) continue;

      const { po, usedBom, warnings } = buildProductionOrderForSOItem(order, item);
      if (!usedBom) bomFallbacks.push(item.productCode);
      bomWarningMessages.push(...warnings);
      createdPOs.push(po);
    }
  } catch (e) {
    return c.json(
      { success: false, error: `PO build failed: ${(e as Error).message}` },
      500
    );
  }

  for (const po of createdPOs) productionOrders.push(po);
  order.status = 'CONFIRMED';
  order.updatedAt = now;

  const autoActions = createdPOs.map((po) => `Created PO ${po.poNo}`);
  autoActions.push(...bomWarningMessages);

  soStatusChanges.push({
    id: generateId(),
    soId: order.id,
    fromStatus,
    toStatus: 'CONFIRMED',
    changedBy: body.changedBy || 'Admin',
    timestamp: now,
    notes: body.notes || 'Order confirmed',
    autoActions,
  });

  const fromBom = createdPOs.length - bomFallbacks.length;
  return c.json({
    success: true,
    data: order,
    productionOrders: createdPOs.map((po) => ({
      id: po.id,
      poNo: po.poNo,
      productName: po.productName,
      quantity: po.quantity,
      status: po.status,
    })),
    bomFallbacks,
    bomWarnings: bomWarningMessages,
    message:
      `Order confirmed. ${createdPOs.length} production order(s) created ` +
      `(${fromBom} from BOM, ${bomFallbacks.length} fallback).`,
  });
});

// GET /api/sales-orders/:id
app.get('/:id', (c) => {
  const id = c.req.param('id');
  const order = salesOrders.find((o) => o.id === id);
  if (!order) {
    return c.json({ success: false, error: 'Order not found' }, 404);
  }

  const linkedPOs = productionOrders
    .filter((po) => po.salesOrderId === id)
    .map((po) => ({
      id: po.id,
      poNo: po.poNo,
      productName: po.productName,
      productCode: po.productCode,
      quantity: po.quantity,
      status: po.status,
      progress: po.progress,
      currentDepartment: po.currentDepartment,
    }));

  const statusHistory = soStatusChanges
    .filter((sc) => sc.soId === id)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const overrideHistory = priceOverrides.filter((po) => po.soId === id);

  return c.json({
    success: true,
    data: order,
    linkedPOs,
    statusHistory,
    priceOverrides: overrideHistory,
  });
});

// PUT /api/sales-orders/:id
app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = salesOrders.findIndex((o) => o.id === id);
  if (idx === -1) {
    return c.json({ success: false, error: 'Order not found' }, 404);
  }

  const body = await c.req.json();
  const order = salesOrders[idx];
  const now = new Date().toISOString();

  // --- Status change with validation ---
  if (body.status && body.status !== order.status) {
    const newStatus = body.status as SOStatus;
    const validNext = VALID_TRANSITIONS[order.status] || [];

    if (!validNext.includes(newStatus)) {
      return c.json(
        {
          success: false,
          error: `Invalid status transition: ${order.status} -> ${newStatus}. Valid transitions: ${validNext.join(', ') || 'none'}`,
        },
        400
      );
    }

    const fromStatus = order.status;

    if (newStatus === 'ON_HOLD') {
      order.preHoldStatus = fromStatus;
    }

    if (fromStatus === 'ON_HOLD' && order.preHoldStatus && newStatus !== 'CANCELLED') {
      const restored = order.preHoldStatus;
      const validFromHold = VALID_TRANSITIONS['ON_HOLD'] || [];
      if (validFromHold.includes(restored)) {
        order.status = restored;
      } else {
        order.status = newStatus;
      }
      delete order.preHoldStatus;
    } else {
      order.status = newStatus;
    }

    const autoActions: string[] = [];

    if (newStatus === 'CANCELLED') {
      const linkedProdOrders = productionOrders.filter((po) => po.salesOrderId === order.id);
      for (const po of linkedProdOrders) {
        if (po.status !== 'COMPLETED') {
          po.status = 'CANCELLED' as typeof po.status;
          autoActions.push(`Production order ${po.poNo} cancelled`);
          if (po.jobCards) {
            for (const jc of po.jobCards) {
              if (jc.status !== 'COMPLETED') {
                jc.status = 'BLOCKED' as typeof jc.status;
              }
            }
          }
        }
      }
    }

    soStatusChanges.push({
      id: generateId(),
      soId: order.id,
      fromStatus,
      toStatus: order.status,
      changedBy: body.changedBy || 'Admin',
      timestamp: now,
      notes: body.statusNotes || `Status changed to ${order.status}`,
      autoActions,
    });
  }

  if (body.customerId) {
    const customer = customers.find((cu) => cu.id === body.customerId);
    if (customer) {
      order.customerId = customer.id;
      order.customerName = customer.name;
      order.customerState = customer.deliveryHubs?.[0]?.state || '';
    }
  }

  if (body.hubId !== undefined) {
    const customer = customers.find((cu) => cu.id === (body.customerId || order.customerId));
    if (customer) {
      const hub =
        customer.deliveryHubs?.find((h) => h.id === body.hubId) ||
        customer.deliveryHubs?.[0] ||
        null;
      order.hubId = hub?.id ?? null;
      order.customerState = hub?.state || order.customerState;
    }
  }

  if (body.customerPO !== undefined) order.customerPO = body.customerPO;
  if (body.customerPOId !== undefined) order.customerPOId = body.customerPOId;
  if (body.customerPODate !== undefined) order.customerPODate = body.customerPODate;
  if (body.customerSO !== undefined) order.customerSO = body.customerSO;
  if (body.customerSOId !== undefined) order.customerSOId = body.customerSOId;
  if (body.reference !== undefined) order.reference = body.reference;
  if (body.companySO !== undefined) order.companySO = body.companySO;
  if (body.companySODate !== undefined) order.companySODate = body.companySODate;
  if (body.customerDeliveryDate !== undefined) order.customerDeliveryDate = body.customerDeliveryDate;
  if (body.hookkaExpectedDD !== undefined) order.hookkaExpectedDD = body.hookkaExpectedDD;
  if (body.hookkaDeliveryOrder !== undefined) order.hookkaDeliveryOrder = body.hookkaDeliveryOrder;
  if (body.overdue !== undefined) order.overdue = body.overdue;
  if (body.notes !== undefined) order.notes = body.notes;

  if (body.items) {
    const oldItems = [...order.items];

    order.items = body.items.map((item: Record<string, unknown>, idx: number) => {
      const basePriceSen = Number(item.basePriceSen) || 0;
      const divanPriceSen = Number(item.divanPriceSen) || 0;
      const legPriceSen = Number(item.legPriceSen) || 0;
      const specialOrderPriceSen = Number(item.specialOrderPriceSen) || 0;
      const unitPriceSen = calculateUnitPrice({ basePriceSen, divanPriceSen, legPriceSen, specialOrderPriceSen });
      const quantity = Number(item.quantity) || 0;
      const lineTotalSen = calculateLineTotal(unitPriceSen, quantity);
      const lineNo = idx + 1;
      const lineSuffix = `-${String(lineNo).padStart(2, '0')}`;

      const oldItem = oldItems.find(
        (oi) => oi.id === item.id || (oi.productId === item.productId && oi.lineNo === lineNo)
      );
      if (oldItem && oldItem.unitPriceSen !== unitPriceSen) {
        const reason = (item.priceOverrideReason as string) || '';
        priceOverrides.push({
          id: generateId(),
          soId: order.id,
          soNumber: order.companySOId,
          lineIndex: idx,
          originalPrice: oldItem.unitPriceSen,
          overridePrice: unitPriceSen,
          reason: reason || 'No reason provided',
          approvedBy: (body.changedBy as string) || 'Admin',
          timestamp: now,
        });
      }

      return {
        id: (item.id as string) || generateId(),
        lineNo,
        lineSuffix,
        productId: item.productId,
        productCode: item.productCode,
        productName: item.productName,
        itemCategory: item.itemCategory,
        sizeCode: item.sizeCode,
        sizeLabel: item.sizeLabel,
        fabricId: item.fabricId,
        fabricCode: item.fabricCode,
        quantity,
        gapInches: item.gapInches ?? null,
        divanHeightInches: item.divanHeightInches ?? null,
        divanPriceSen,
        legHeightInches: item.legHeightInches ?? null,
        legPriceSen,
        specialOrder: (item.specialOrder as string) || '',
        specialOrderPriceSen,
        basePriceSen,
        unitPriceSen,
        lineTotalSen,
        notes: (item.notes as string) || '',
      } as SalesOrderItem;
    });
    order.subtotalSen = order.items.reduce((sum, i) => sum + i.lineTotalSen, 0);
    order.totalSen = order.subtotalSen;
  }

  order.updatedAt = now;
  salesOrders[idx] = order;

  const linkedPOs = productionOrders
    .filter((po) => po.salesOrderId === id)
    .map((po) => ({
      id: po.id,
      poNo: po.poNo,
      productName: po.productName,
      quantity: po.quantity,
      status: po.status,
      progress: po.progress,
    }));

  return c.json({ success: true, data: order, linkedPOs });
});

// DELETE /api/sales-orders/:id
app.delete('/:id', (c) => {
  const id = c.req.param('id');
  const idx = salesOrders.findIndex((o) => o.id === id);
  if (idx === -1) {
    return c.json({ success: false, error: 'Order not found' }, 404);
  }
  salesOrders.splice(idx, 1);
  return c.json({ success: true });
});

export default app;
