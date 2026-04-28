import { Hono } from 'hono';
import { creditNotes, invoices, generateId, getNextCNNo } from '../../lib/mock-data';
import type { CreditNote } from '../../lib/mock-data';

const app = new Hono();

app.get('/', (c) => c.json({ success: true, data: creditNotes, total: creditNotes.length }));

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
  const newCN: CreditNote = {
    id: generateId(), noteNumber: getNextCNNo(), invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNo, customerId: invoice.customerId,
    customerName: invoice.customerName,
    date: new Date().toISOString().split('T')[0],
    reason, reasonDetail: reasonDetail || '', items: parsedItems,
    totalAmount, status: 'DRAFT', approvedBy: null,
  };
  creditNotes.unshift(newCN);
  return c.json({ success: true, data: newCN }, 201);
});

app.get('/:id', (c) => {
  const id = c.req.param('id');
  const cn = creditNotes.find((n) => n.id === id);
  if (!cn) return c.json({ success: false, error: 'Credit note not found' }, 404);
  return c.json({ success: true, data: cn });
});

app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = creditNotes.findIndex((n) => n.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Credit note not found' }, 404);
  const body = await c.req.json();
  const cn = creditNotes[idx];
  if (body.status) {
    cn.status = body.status;
    if (body.status === 'APPROVED' || body.status === 'POSTED') cn.approvedBy = body.approvedBy || 'Admin';
  }
  creditNotes[idx] = cn;
  return c.json({ success: true, data: cn });
});

export default app;
