import { Hono } from 'hono';
import { eInvoices, invoices, generateId, generateEInvoiceXml } from '../../lib/mock-data';
import type { EInvoice } from '../../lib/mock-data';

const app = new Hono();

// GET /api/e-invoices
app.get('/', (c) => c.json({ success: true, data: eInvoices, total: eInvoices.length }));

// POST /api/e-invoices
app.post('/', async (c) => {
  const body = await c.req.json();
  const { invoiceId } = body;

  if (!invoiceId) {
    return c.json({ success: false, error: 'invoiceId is required' }, 400);
  }

  const invoice = invoices.find((inv) => inv.id === invoiceId);
  if (!invoice) {
    return c.json({ success: false, error: 'Invoice not found' }, 404);
  }

  const existing = eInvoices.find((e) => e.invoiceId === invoiceId);
  if (existing) {
    return c.json({ success: false, error: 'e-Invoice already exists for this invoice' }, 409);
  }

  const totalIncludingTax = invoice.totalSen / 100;
  const totalExcludingTax = totalIncludingTax;
  const taxAmount = 0;
  const now = new Date().toISOString();

  const xmlContent = generateEInvoiceXml(
    invoice.invoiceNo,
    invoice.invoiceDate,
    invoice.customerName,
    body.customerTIN,
    totalExcludingTax,
    taxAmount,
    totalIncludingTax
  );

  const newEInvoice: EInvoice = {
    id: generateId(),
    invoiceId: invoice.id,
    invoiceNo: invoice.invoiceNo,
    customerName: invoice.customerName,
    customerTIN: body.customerTIN || undefined,
    status: 'PENDING',
    xmlContent,
    totalExcludingTax,
    taxAmount,
    totalIncludingTax,
    createdAt: now,
  };

  eInvoices.unshift(newEInvoice);

  return c.json({ success: true, data: newEInvoice }, 201);
});

// GET /api/e-invoices/:id
app.get('/:id', (c) => {
  const id = c.req.param('id');
  const eInvoice = eInvoices.find((e) => e.id === id);
  if (!eInvoice) {
    return c.json({ success: false, error: 'e-Invoice not found' }, 404);
  }
  return c.json({ success: true, data: eInvoice });
});

// PUT /api/e-invoices/:id
app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = eInvoices.findIndex((e) => e.id === id);
  if (idx === -1) {
    return c.json({ success: false, error: 'e-Invoice not found' }, 404);
  }

  const body = await c.req.json();
  const eInvoice = eInvoices[idx];
  const now = new Date().toISOString();

  if (body.action === 'submit') {
    if (eInvoice.status !== 'PENDING' && eInvoice.status !== 'INVALID') {
      return c.json({ success: false, error: 'Only PENDING or INVALID e-invoices can be submitted' }, 400);
    }

    eInvoice.status = 'SUBMITTED';
    eInvoice.submittedAt = now;
    eInvoice.submissionId = `LHDN-SUB-${now.slice(0, 10).replace(/-/g, '')}-${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`;
    eInvoice.uuid = Array.from({ length: 15 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]
    ).join('');
    eInvoice.errorMessage = undefined;

    // Mock auto-validation
    eInvoice.status = 'VALID';
    eInvoice.validatedAt = now;

    eInvoices[idx] = eInvoice;
    return c.json({ success: true, data: eInvoice });
  }

  if (body.action === 'cancel') {
    if (eInvoice.status !== 'VALID' && eInvoice.status !== 'SUBMITTED') {
      return c.json({ success: false, error: 'Only SUBMITTED or VALID e-invoices can be cancelled' }, 400);
    }

    eInvoice.status = 'CANCELLED';
    eInvoices[idx] = eInvoice;
    return c.json({ success: true, data: eInvoice });
  }

  return c.json({ success: false, error: "Invalid action. Use 'submit' or 'cancel'." }, 400);
});

export default app;
