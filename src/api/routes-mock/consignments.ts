import { Hono } from 'hono';
import { consignmentNotes, customers, generateId } from '../../lib/mock-data';
import type { ConsignmentNote, ConsignmentItem } from '../../lib/mock-data';

const app = new Hono();

// GET /api/consignments
app.get('/', (c) => {
  const status = c.req.query('status');
  const customerId = c.req.query('customerId');
  let filtered = [...consignmentNotes];
  if (status) filtered = filtered.filter((n) => n.status === status);
  if (customerId) filtered = filtered.filter((n) => n.customerId === customerId);
  return c.json({ success: true, data: filtered, total: filtered.length });
});

// POST /api/consignments
app.post('/', async (c) => {
  const body = await c.req.json();
  const customer = customers.find((cu) => cu.id === body.customerId);
  if (!customer) return c.json({ success: false, error: 'Customer not found' }, 400);
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const existingCount = consignmentNotes.filter((n) => n.noteNumber.startsWith(`CON-${yy}${mm}`)).length;
  const noteNumber = `CON-${yy}${mm}-${String(existingCount + 1).padStart(3, '0')}`;
  const items: ConsignmentItem[] = (body.items || []).map((item: Record<string, unknown>) => ({
    id: generateId(), productId: (item.productId as string) || '',
    productName: (item.productName as string) || '', productCode: (item.productCode as string) || '',
    quantity: Number(item.quantity) || 1, unitPrice: Number(item.unitPrice) || 0,
    status: 'AT_BRANCH' as const, soldDate: null, returnedDate: null,
  }));
  const totalValue = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const newNote: ConsignmentNote = {
    id: generateId(), noteNumber, type: (body.type as 'OUT' | 'RETURN') || 'OUT',
    customerId: customer.id, customerName: customer.name,
    branchName: body.branchName || customer.name, items,
    sentDate: body.sentDate || now.toISOString().split('T')[0],
    status: 'ACTIVE', totalValue, notes: body.notes || '',
  };
  consignmentNotes.unshift(newNote);
  return c.json({ success: true, data: newNote }, 201);
});

// GET /api/consignments/:id
app.get('/:id', (c) => {
  const id = c.req.param('id');
  const note = consignmentNotes.find((n) => n.id === id);
  if (!note) return c.json({ success: false, error: 'Consignment not found' }, 404);
  return c.json({ success: true, data: note });
});

// PUT /api/consignments/:id
app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = consignmentNotes.findIndex((n) => n.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Consignment not found' }, 404);
  const body = await c.req.json();
  const note = consignmentNotes[idx];
  if (body.status !== undefined) note.status = body.status;
  if (body.notes !== undefined) note.notes = body.notes;
  if (body.branchName !== undefined) note.branchName = body.branchName;
  if (body.items) {
    note.items = body.items;
    note.totalValue = note.items.reduce((sum: number, i: ConsignmentItem) => sum + i.unitPrice * i.quantity, 0);
  }
  consignmentNotes[idx] = note;
  return c.json({ success: true, data: note });
});

// DELETE /api/consignments/:id
app.delete('/:id', (c) => {
  const id = c.req.param('id');
  const idx = consignmentNotes.findIndex((n) => n.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Consignment not found' }, 404);
  consignmentNotes.splice(idx, 1);
  return c.json({ success: true });
});

export default app;
