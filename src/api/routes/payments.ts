import { Hono } from 'hono';
import {
  paymentRecords,
  invoices,
  customers,
  generateId,
  getNextReceiptNo,
} from '../../lib/mock-data';
import type { PaymentRecord } from '../../lib/mock-data';

const app = new Hono();

// GET /api/payments?customerId=xxx
app.get('/', (c) => {
  const customerId = c.req.query('customerId');
  let filtered = paymentRecords;
  if (customerId) {
    filtered = paymentRecords.filter((p) => p.customerId === customerId);
  }
  return c.json({ success: true, data: filtered, total: filtered.length });
});

// POST /api/payments
app.post('/', async (c) => {
  const body = await c.req.json();
  const { customerId, amount, method, reference, allocations } = body;

  if (!customerId || !amount || !method) {
    return c.json({ success: false, error: 'customerId, amount, and method are required' }, 400);
  }

  const customer = customers.find((cu) => cu.id === customerId);
  if (!customer) {
    return c.json({ success: false, error: 'Customer not found' }, 404);
  }

  const parsedAllocations = (allocations || []).map(
    (alloc: { invoiceId: string; amount: number }) => {
      const invoice = invoices.find((inv) => inv.id === alloc.invoiceId);
      return {
        invoiceId: alloc.invoiceId,
        invoiceNumber: invoice?.invoiceNo || '',
        amount: alloc.amount,
      };
    }
  );

  const newPayment: PaymentRecord = {
    id: generateId(),
    receiptNumber: getNextReceiptNo(),
    customerId: customer.id,
    customerName: customer.name,
    date: new Date().toISOString().split('T')[0],
    amount,
    method,
    reference: reference || '',
    allocations: parsedAllocations,
    status: 'RECEIVED',
  };

  paymentRecords.unshift(newPayment);

  for (const alloc of parsedAllocations) {
    const inv = invoices.find((i) => i.id === alloc.invoiceId);
    if (inv) {
      inv.paidAmount += alloc.amount;
      inv.payments.push({
        id: generateId(),
        date: newPayment.date,
        amountSen: alloc.amount,
        method: method as 'CASH' | 'CHEQUE' | 'BANK_TRANSFER' | 'CREDIT_CARD' | 'E_WALLET',
        reference: reference || '',
      });
      if (inv.paidAmount >= inv.totalSen) {
        inv.status = 'PAID';
        inv.paymentDate = newPayment.date;
      } else if (inv.paidAmount > 0) {
        inv.status = 'PARTIAL_PAID';
      }
    }
  }

  return c.json({ success: true, data: newPayment }, 201);
});

// GET /api/payments/:id
app.get('/:id', (c) => {
  const id = c.req.param('id');
  const payment = paymentRecords.find((p) => p.id === id);
  if (!payment) {
    return c.json({ success: false, error: 'Payment not found' }, 404);
  }
  return c.json({ success: true, data: payment });
});

// PUT /api/payments/:id
app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = paymentRecords.findIndex((p) => p.id === id);
  if (idx === -1) {
    return c.json({ success: false, error: 'Payment not found' }, 404);
  }

  const body = await c.req.json();
  const payment = paymentRecords[idx];

  const VALID_TRANSITIONS: Record<string, string[]> = {
    RECEIVED: ['CLEARED', 'BOUNCED'],
    CLEARED: [],
    BOUNCED: [],
  };

  if (body.status && body.status !== payment.status) {
    const allowed = VALID_TRANSITIONS[payment.status] || [];
    if (!allowed.includes(body.status)) {
      return c.json(
        {
          success: false,
          error: `Cannot transition from ${payment.status} to ${body.status}. Allowed: ${allowed.join(', ') || 'none'}`,
        },
        400
      );
    }
    const oldStatus = payment.status;
    payment.status = body.status;

    if (body.status === 'BOUNCED' && oldStatus !== 'BOUNCED') {
      for (const alloc of payment.allocations || []) {
        const inv = invoices.find((i) => i.id === alloc.invoiceId);
        if (inv) {
          inv.paidAmount = Math.max(0, inv.paidAmount - alloc.amount);
          if (inv.paidAmount <= 0) {
            inv.status = 'SENT';
            inv.paidAmount = 0;
          } else if (inv.paidAmount < inv.totalSen) {
            inv.status = 'PARTIAL_PAID';
          }
          inv.updatedAt = new Date().toISOString();
        }
      }
    }
  }

  paymentRecords[idx] = payment;
  return c.json({ success: true, data: payment });
});

export default app;
