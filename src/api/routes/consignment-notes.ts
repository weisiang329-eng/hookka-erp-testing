import { Hono } from 'hono';
import { consignmentNotes, generateId } from '../../lib/mock-data';
import type { ConsignmentNote, ConsignmentItem } from '../../lib/mock-data';

const app = new Hono();

// GET /api/consignment-notes — list consignment notes with optional filters
app.get('/', (c) => {
  const status = c.req.query('status');
  const customerId = c.req.query('customerId');
  let filtered = [...consignmentNotes];
  if (status) filtered = filtered.filter((n) => n.status === status);
  if (customerId) filtered = filtered.filter((n) => n.customerId === customerId);
  return c.json({ success: true, data: filtered, total: filtered.length });
});

// POST /api/consignment-notes — create a new consignment note
app.post('/', async (c) => {
  const body = await c.req.json();
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const existingCount = consignmentNotes.filter((n) => n.noteNumber.startsWith(`CON-${yy}${mm}`)).length;
  const noteNumber = `CON-${yy}${mm}-${String(existingCount + 1).padStart(3, '0')}`;
  const items: ConsignmentItem[] = (body.items || []).map((item: Record<string, unknown>) => ({
    id: generateId(),
    productId: (item.productId as string) || '',
    productName: (item.productName as string) || '',
    productCode: (item.productCode as string) || '',
    quantity: Number(item.quantity) || 1,
    unitPrice: Number(item.unitPrice) || 0,
    status: 'AT_BRANCH' as const,
    soldDate: null,
    returnedDate: null,
  }));
  const totalValue = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const newNote: ConsignmentNote = {
    id: generateId(),
    noteNumber,
    type: (body.type as 'OUT' | 'RETURN') || 'OUT',
    customerId: body.customerId || '',
    customerName: body.customerName || '',
    branchName: body.branchName || '',
    items,
    sentDate: body.sentDate || now.toISOString().split('T')[0],
    status: 'ACTIVE',
    totalValue,
    notes: body.notes || '',
  };
  consignmentNotes.unshift(newNote);
  return c.json({ success: true, data: newNote }, 201);
});

// PATCH /api/consignment-notes — update status and fields on a consignment note
// Body: { id, status?, notes?, branchName? }
app.patch('/', async (c) => {
  const body = await c.req.json();
  const idx = consignmentNotes.findIndex((n) => n.id === body.id);
  if (idx === -1) return c.json({ success: false, error: 'Consignment note not found' }, 404);
  const cn = consignmentNotes[idx];
  if (body.status !== undefined) cn.status = body.status;
  if (body.notes !== undefined) cn.notes = body.notes;
  if (body.branchName !== undefined) cn.branchName = body.branchName;
  consignmentNotes[idx] = cn;
  return c.json({ success: true, data: cn });
});

export default app;
