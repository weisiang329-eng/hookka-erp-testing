import { Hono } from 'hono';
import {
  arAging, apAging, chartOfAccounts, journalEntries, plEntries, balanceSheetEntries,
  generateId, getNextJENo,
} from '../../lib/mock-data';
import type { ChartOfAccount, JournalEntry } from '../../lib/mock-data';

const app = new Hono();

// --- Aging ---
app.get('/aging', (c) => c.json({ success: true, data: { ar: arAging, ap: apAging } }));

app.post('/aging', async (c) => {
  const body = await c.req.json();
  const { type, id, amountSen } = body;
  if (!type || !id || !amountSen || amountSen <= 0) {
    return c.json({ success: false, error: 'type (ar|ap), id, and amountSen are required' }, 400);
  }
  if (type === 'ar') {
    const entry = arAging.find((a) => a.customerId === id);
    if (!entry) return c.json({ success: false, error: 'Customer not found in AR' }, 404);
    let remaining = amountSen;
    const buckets: (keyof typeof entry)[] = ['over90Sen', 'days90Sen', 'days60Sen', 'days30Sen', 'currentSen'];
    for (const bucket of buckets) {
      if (remaining <= 0) break;
      const val = entry[bucket] as number;
      const apply = Math.min(remaining, val);
      (entry[bucket] as number) -= apply;
      remaining -= apply;
    }
    return c.json({ success: true, data: entry });
  }
  if (type === 'ap') {
    const entry = apAging.find((a) => a.supplierId === id);
    if (!entry) return c.json({ success: false, error: 'Supplier not found in AP' }, 404);
    let remaining = amountSen;
    const buckets: (keyof typeof entry)[] = ['over90Sen', 'days90Sen', 'days60Sen', 'days30Sen', 'currentSen'];
    for (const bucket of buckets) {
      if (remaining <= 0) break;
      const val = entry[bucket] as number;
      const apply = Math.min(remaining, val);
      (entry[bucket] as number) -= apply;
      remaining -= apply;
    }
    return c.json({ success: true, data: entry });
  }
  return c.json({ success: false, error: "type must be 'ar' or 'ap'" }, 400);
});

// --- COA ---
app.get('/coa', (c) => {
  const active = chartOfAccounts.filter((a) => a.isActive);
  return c.json({ success: true, data: active, total: active.length });
});

app.post('/coa', async (c) => {
  const body = await c.req.json();
  const { code, name, type, parentCode } = body;
  if (!code || !name || !type) return c.json({ success: false, error: 'code, name, and type are required' }, 400);
  if (chartOfAccounts.find((a) => a.code === code)) return c.json({ success: false, error: 'Account code already exists' }, 400);
  const validTypes = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];
  if (!validTypes.includes(type)) return c.json({ success: false, error: 'Invalid account type' }, 400);
  const newAccount: ChartOfAccount = { code, name, type, parentCode: parentCode || undefined, balance: 0, isActive: true };
  chartOfAccounts.push(newAccount);
  return c.json({ success: true, data: newAccount }, 201);
});

app.put('/coa', async (c) => {
  const body = await c.req.json();
  const { code } = body;
  const idx = chartOfAccounts.findIndex((a) => a.code === code);
  if (idx === -1) return c.json({ success: false, error: 'Account not found' }, 404);
  if (body.name !== undefined) chartOfAccounts[idx].name = body.name;
  if (body.isActive !== undefined) chartOfAccounts[idx].isActive = body.isActive;
  if (body.parentCode !== undefined) chartOfAccounts[idx].parentCode = body.parentCode;
  return c.json({ success: true, data: chartOfAccounts[idx] });
});

// --- Journals ---
app.get('/journals', (c) => c.json({ success: true, data: journalEntries, total: journalEntries.length }));

app.post('/journals', async (c) => {
  const body = await c.req.json();
  const { date, description, lines } = body;
  if (!date || !description || !lines || !Array.isArray(lines) || lines.length === 0) {
    return c.json({ success: false, error: 'date, description, and lines are required' }, 400);
  }
  const totalDebit = lines.reduce((s: number, l: { debitSen: number }) => s + (l.debitSen || 0), 0);
  const totalCredit = lines.reduce((s: number, l: { creditSen: number }) => s + (l.creditSen || 0), 0);
  if (totalDebit !== totalCredit) return c.json({ success: false, error: `Debits (${totalDebit}) must equal Credits (${totalCredit})` }, 400);
  if (totalDebit === 0) return c.json({ success: false, error: 'Journal entry must have non-zero amounts' }, 400);
  const now = new Date().toISOString();
  const newEntry: JournalEntry = {
    id: generateId(), entryNo: getNextJENo(), date, description, lines,
    status: 'DRAFT', createdBy: body.createdBy || 'admin', createdAt: now,
  };
  journalEntries.unshift(newEntry);
  return c.json({ success: true, data: newEntry }, 201);
});

app.get('/journals/:id', (c) => {
  const id = c.req.param('id');
  const entry = journalEntries.find((je) => je.id === id);
  if (!entry) return c.json({ success: false, error: 'Journal entry not found' }, 404);
  return c.json({ success: true, data: entry });
});

app.put('/journals/:id', async (c) => {
  const id = c.req.param('id');
  const idx = journalEntries.findIndex((je) => je.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Journal entry not found' }, 404);
  const body = await c.req.json();
  const entry = journalEntries[idx];
  if (body.status === 'POSTED' && entry.status === 'DRAFT') {
    entry.status = 'POSTED';
    for (const line of entry.lines) {
      const account = chartOfAccounts.find((a) => a.code === line.accountCode);
      if (account) {
        if (account.type === 'ASSET' || account.type === 'EXPENSE') account.balance += line.debitSen - line.creditSen;
        else account.balance += line.creditSen - line.debitSen;
      }
    }
  }
  if (body.status === 'REVERSED' && entry.status === 'POSTED') {
    entry.status = 'REVERSED';
    for (const line of entry.lines) {
      const account = chartOfAccounts.find((a) => a.code === line.accountCode);
      if (account) {
        if (account.type === 'ASSET' || account.type === 'EXPENSE') account.balance -= line.debitSen - line.creditSen;
        else account.balance -= line.creditSen - line.debitSen;
      }
    }
  }
  if (entry.status === 'DRAFT') {
    if (body.date !== undefined) entry.date = body.date;
    if (body.description !== undefined) entry.description = body.description;
    if (body.lines !== undefined) {
      const totalDebit = body.lines.reduce((s: number, l: { debitSen: number }) => s + (l.debitSen || 0), 0);
      const totalCredit = body.lines.reduce((s: number, l: { creditSen: number }) => s + (l.creditSen || 0), 0);
      if (totalDebit !== totalCredit) return c.json({ success: false, error: 'Debits must equal Credits' }, 400);
      entry.lines = body.lines;
    }
  }
  journalEntries[idx] = entry;
  return c.json({ success: true, data: entry });
});

app.delete('/journals/:id', (c) => {
  const id = c.req.param('id');
  const idx = journalEntries.findIndex((je) => je.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Journal entry not found' }, 404);
  if (journalEntries[idx].status !== 'DRAFT') return c.json({ success: false, error: 'Only DRAFT entries can be deleted' }, 400);
  journalEntries.splice(idx, 1);
  return c.json({ success: true });
});

// --- P&L ---
app.get('/pl', (c) => {
  const period = c.req.query('period');
  const productCategory = c.req.query('productCategory');
  const customerId = c.req.query('customerId');
  const state = c.req.query('state');
  let filtered = [...plEntries];
  if (period) {
    if (period.includes('Q')) {
      const [year, q] = period.split('-Q');
      const qNum = parseInt(q, 10);
      const startMonth = (qNum - 1) * 3 + 1;
      const months = [startMonth, startMonth + 1, startMonth + 2].map((m) => `${year}-${m.toString().padStart(2, '0')}`);
      filtered = filtered.filter((e) => months.includes(e.period));
    } else if (period.length === 4) {
      filtered = filtered.filter((e) => e.period.startsWith(period));
    } else {
      filtered = filtered.filter((e) => e.period === period);
    }
  }
  if (productCategory) filtered = filtered.filter((e) => e.category !== 'REVENUE' || e.productCategory === productCategory);
  if (customerId) filtered = filtered.filter((e) => e.category !== 'REVENUE' || e.customerId === customerId);
  if (state) filtered = filtered.filter((e) => e.category !== 'REVENUE' || e.state === state);
  const totalRevenue = filtered.filter((e) => e.category === 'REVENUE').reduce((s, e) => s + e.amount, 0);
  const totalCOGS = filtered.filter((e) => e.category === 'COGS').reduce((s, e) => s + e.amount, 0);
  const totalOpex = filtered.filter((e) => e.category === 'OPERATING_EXPENSE').reduce((s, e) => s + e.amount, 0);
  const grossProfit = totalRevenue - totalCOGS;
  const grossProfitPct = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
  const netProfit = grossProfit - totalOpex;
  const netProfitPct = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;
  const revenueByProduct: Record<string, number> = {};
  filtered.filter((e) => e.category === 'REVENUE').forEach((e) => { const key = e.productCategory || 'OTHER'; revenueByProduct[key] = (revenueByProduct[key] || 0) + e.amount; });
  const revenueByCustomer: Record<string, number> = {};
  filtered.filter((e) => e.category === 'REVENUE').forEach((e) => { const key = e.customerName || 'Unknown'; revenueByCustomer[key] = (revenueByCustomer[key] || 0) + e.amount; });
  const cogsByAccount: Record<string, number> = {};
  filtered.filter((e) => e.category === 'COGS').forEach((e) => { cogsByAccount[e.accountName] = (cogsByAccount[e.accountName] || 0) + e.amount; });
  const opexByAccount: Record<string, number> = {};
  filtered.filter((e) => e.category === 'OPERATING_EXPENSE').forEach((e) => { opexByAccount[e.accountName] = (opexByAccount[e.accountName] || 0) + e.amount; });
  return c.json({
    success: true,
    data: {
      entries: filtered,
      totals: { revenue: totalRevenue, cogs: totalCOGS, grossProfit, grossProfitPct: Math.round(grossProfitPct * 100) / 100, operatingExpenses: totalOpex, netProfit, netProfitPct: Math.round(netProfitPct * 100) / 100 },
      revenueByProduct, revenueByCustomer, cogsByAccount, opexByAccount, balanceSheet: balanceSheetEntries,
    },
  });
});

export default app;
