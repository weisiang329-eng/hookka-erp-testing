import { Hono } from 'hono';
import {
  invoices,
  deliveryOrders,
  salesOrders,
  soStatusChanges,
  generateId,
  getNextInvoiceNo,
} from '../../lib/mock-data';
import type { Invoice, InvoiceItem } from '../../lib/mock-data';

const app = new Hono();

// GET /api/invoices
app.get('/', (c) => {
  return c.json({ success: true, data: invoices, total: invoices.length });
});

// POST /api/invoices
app.post('/', async (c) => {
  const body = await c.req.json();
  const { deliveryOrderId } = body;
  if (!deliveryOrderId) {
    return c.json({ success: false, error: 'deliveryOrderId is required' }, 400);
  }

  const deliveryOrder = deliveryOrders.find((d) => d.id === deliveryOrderId);
  if (!deliveryOrder) {
    return c.json({ success: false, error: 'Delivery order not found' }, 404);
  }

  const salesOrder = salesOrders.find((s) => s.id === deliveryOrder.salesOrderId);

  if (deliveryOrder.status !== 'DELIVERED') {
    return c.json(
      {
        success: false,
        error: `Cannot create invoice: Delivery Order is "${deliveryOrder.status}". Only DELIVERED delivery orders can be invoiced.`,
      },
      400
    );
  }

  const items: InvoiceItem[] = deliveryOrder.items.map((doItem) => {
    const soItem = salesOrder?.items.find((si) => si.productCode === doItem.productCode);
    const unitPriceSen = soItem?.unitPriceSen ?? 0;
    return {
      id: generateId(),
      productCode: doItem.productCode,
      productName: doItem.productName,
      sizeLabel: doItem.sizeLabel,
      fabricCode: doItem.fabricCode,
      quantity: doItem.quantity,
      unitPriceSen,
      totalSen: unitPriceSen * doItem.quantity,
    };
  });

  const subtotalSen = items.reduce((sum, i) => sum + i.totalSen, 0);
  const now = new Date().toISOString();
  const invoiceDate = new Date().toISOString().split('T')[0];
  const due = new Date();
  due.setDate(due.getDate() + 30);
  const dueDate = due.toISOString().split('T')[0];

  const newInvoice: Invoice = {
    id: generateId(),
    invoiceNo: getNextInvoiceNo(),
    deliveryOrderId: deliveryOrder.id,
    doNo: deliveryOrder.doNo,
    salesOrderId: deliveryOrder.salesOrderId,
    companySOId: deliveryOrder.companySOId,
    customerId: deliveryOrder.customerId,
    customerName: deliveryOrder.customerName,
    customerState: deliveryOrder.customerState,
    hubId: deliveryOrder.hubId ?? salesOrder?.hubId ?? null,
    hubName: deliveryOrder.hubName || '',
    items,
    subtotalSen,
    totalSen: subtotalSen,
    status: 'DRAFT',
    invoiceDate,
    dueDate,
    paidAmount: 0,
    paymentDate: null,
    paymentMethod: '',
    payments: [],
    notes: body.notes || '',
    createdAt: now,
    updatedAt: now,
  };

  invoices.unshift(newInvoice);
  deliveryOrder.status = 'INVOICED';
  deliveryOrder.overdue = 'INVOICED';
  deliveryOrder.updatedAt = now;

  return c.json({ success: true, data: newInvoice }, 201);
});

// GET /api/invoices/:id
app.get('/:id', (c) => {
  const id = c.req.param('id');
  const invoice = invoices.find((inv) => inv.id === id);
  if (!invoice) {
    return c.json({ success: false, error: 'Invoice not found' }, 404);
  }
  return c.json({ success: true, data: invoice });
});

// PUT /api/invoices/:id
app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = invoices.findIndex((inv) => inv.id === id);
  if (idx === -1) {
    return c.json({ success: false, error: 'Invoice not found' }, 404);
  }

  const body = await c.req.json();
  const invoice = invoices[idx];

  const INV_VALID_TRANSITIONS: Record<string, string[]> = {
    DRAFT: ['SENT', 'CANCELLED'],
    SENT: ['PAID', 'PARTIAL_PAID', 'OVERDUE', 'CANCELLED'],
    PARTIAL_PAID: ['PAID', 'OVERDUE', 'CANCELLED'],
    OVERDUE: ['PAID', 'PARTIAL_PAID', 'CANCELLED'],
    PAID: [],
    CANCELLED: [],
  };

  if (body.status && body.status !== invoice.status) {
    const allowed = INV_VALID_TRANSITIONS[invoice.status] || [];
    if (!allowed.includes(body.status)) {
      return c.json(
        {
          success: false,
          error: `Cannot transition from ${invoice.status} to ${body.status}. Allowed: ${allowed.join(', ') || 'none'}`,
        },
        400
      );
    }
    invoice.status = body.status;
  }

  if (body.paidAmount !== undefined) {
    const paymentAmountSen = body.paidAmount - invoice.paidAmount;
    if (paymentAmountSen > 0) {
      if (!invoice.payments) invoice.payments = [];
      invoice.payments.push({
        id: generateId(),
        date: body.paymentDate || new Date().toISOString().split('T')[0],
        amountSen: paymentAmountSen,
        method: body.paymentMethod || 'BANK_TRANSFER',
        reference: body.paymentReference || '',
      });
    }
    invoice.paidAmount = body.paidAmount;
    if (body.paidAmount >= invoice.totalSen) {
      invoice.status = 'PAID';
    } else if (body.paidAmount > 0) {
      invoice.status = 'PARTIAL_PAID';
    }
  }

  if (body.paymentDate !== undefined) invoice.paymentDate = body.paymentDate;
  if (body.paymentMethod !== undefined) invoice.paymentMethod = body.paymentMethod;
  if (body.notes !== undefined) invoice.notes = body.notes;
  if (body.dueDate !== undefined) invoice.dueDate = body.dueDate;

  invoice.updatedAt = new Date().toISOString();
  invoices[idx] = invoice;

  // Cascade PAID to SO
  if (invoice.status === 'PAID') {
    const linkedSO = salesOrders.find((s) => s.id === invoice.salesOrderId);
    if (linkedSO) {
      const cascadeNow = new Date().toISOString();
      if (linkedSO.status === 'DELIVERED') {
        linkedSO.status = 'INVOICED';
        linkedSO.updatedAt = cascadeNow;
        soStatusChanges.push({
          id: generateId(),
          soId: linkedSO.id,
          fromStatus: 'DELIVERED',
          toStatus: 'INVOICED',
          changedBy: 'System',
          timestamp: cascadeNow,
          notes: 'Auto-advanced: invoice paid',
          autoActions: ['INVOICE_PAID_CASCADE'],
        });
        linkedSO.status = 'CLOSED';
        linkedSO.updatedAt = cascadeNow;
        soStatusChanges.push({
          id: generateId(),
          soId: linkedSO.id,
          fromStatus: 'INVOICED',
          toStatus: 'CLOSED',
          changedBy: 'System',
          timestamp: cascadeNow,
          notes: 'Auto-advanced: invoice paid (full close)',
          autoActions: ['INVOICE_PAID_CASCADE'],
        });
      } else if (linkedSO.status === 'INVOICED') {
        linkedSO.status = 'CLOSED';
        linkedSO.updatedAt = cascadeNow;
        soStatusChanges.push({
          id: generateId(),
          soId: linkedSO.id,
          fromStatus: 'INVOICED',
          toStatus: 'CLOSED',
          changedBy: 'System',
          timestamp: cascadeNow,
          notes: 'Auto-advanced: invoice paid',
          autoActions: ['INVOICE_PAID_CASCADE'],
        });
      }
    }
  }

  return c.json({ success: true, data: invoice });
});

// DELETE /api/invoices/:id
app.delete('/:id', (c) => {
  const id = c.req.param('id');
  const idx = invoices.findIndex((inv) => inv.id === id);
  if (idx === -1) {
    return c.json({ success: false, error: 'Invoice not found' }, 404);
  }
  if (invoices[idx].status !== 'DRAFT') {
    return c.json({ success: false, error: 'Only DRAFT invoices can be deleted' }, 400);
  }
  invoices.splice(idx, 1);
  return c.json({ success: true });
});

export default app;
