import { Hono } from 'hono';
import { debitNotes, invoices, generateId, getNextDNNo } from '../../lib/mock-data';
import type { DebitNote } from '../../lib/mock-data';

const app = new Hono();

app.get('/', (c) => c.json({ success: true, data: debitNotes, total: debitNotes.length }));

app.post('/', async (c) => {
  const body = await c.req.json();
  const { invoiceId, reason, reasonDetail, items } = body;
  if (!invoiceId || !reason || !items || items.length === 0) {
    return c.json({ success: false, error: 'invoiceId, reason, and items are required' }, 400);
  }
  const invoice = invoices.find((inv) => inv.id === invoiceId);
  if (!invoice) return c.json({ success: false, error: 'Invoice not found' }, 404);
  const parsedItems = items.map((item: { description: string; quantity: number; unitPrice: number }) => ({
    description: item.description, quantity: item.quantity, unitPrice: item.unitPrice,
    total: item.quantity * item.unitPrice,
  }));
  const totalAmount = parsedItems.reduce((sum: number, item: { total: number }) => sum + item.total, 0);
  const newDN: DebitNote = {
    id: generateId(), noteNumber: getNextDNNo(), invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNo, customerId: invoice.customerId,
    customerName: invoice.customerName,
    date: new Date().toISOString().split('T')[0],
    reason, reasonDetail: reasonDetail || '', items: parsedItems,
    totalAmount, status: 'DRAFT', approvedBy: null,
  };
  debitNotes.unshift(newDN);
  return c.json({ success: true, data: newDN }, 201);
});

app.get('/:id', (c) => {
  const id = c.req.param('id');
  const dn = debitNotes.find((n) => n.id === id);
  if (!dn) return c.json({ success: false, error: 'Debit note not found' }, 404);
  return c.json({ success: true, data: dn });
});

app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = debitNotes.findIndex((n) => n.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Debit note not found' }, 404);
  const body = await c.req.json();
  const dn = debitNotes[idx];
  if (body.status) {
    dn.status = body.status;
    if (body.status === 'APPROVED' || body.status === 'POSTED') dn.approvedBy = body.approvedBy || 'Admin';
  }
  debitNotes[idx] = dn;
  return c.json({ success: true, data: dn });
});

export default app;
