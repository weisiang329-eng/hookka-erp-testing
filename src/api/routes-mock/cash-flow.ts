import { Hono } from 'hono';
import {
  invoices,
  purchaseOrders,
  bankAccounts,
  bankTransactions,
  journalEntries,
  generateId,
  type BankTransaction,
} from '../../lib/mock-data';

const app = new Hono();

function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().split('T')[0];
}

function getNextWeeks(count: number): string[] {
  const weeks: string[] = [];
  const today = new Date();
  const day = today.getDay();
  const diff = today.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(today);
  monday.setDate(diff);

  for (let i = 0; i < count; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i * 7);
    weeks.push(d.toISOString().split('T')[0]);
  }
  return weeks;
}

// GET /api/cash-flow
app.get('/', (c) => {
  const totalCashSen = bankAccounts.reduce((s, a) => s + a.balanceSen, 0);
  const weeks = getNextWeeks(12);

  const arByWeek: Record<string, number> = {};
  invoices.forEach((inv) => {
    if (inv.status === 'PAID' || inv.status === 'CANCELLED') return;
    const remaining = inv.totalSen - inv.paidAmount;
    if (remaining <= 0) return;
    const weekKey = getWeekStart(inv.dueDate);
    arByWeek[weekKey] = (arByWeek[weekKey] || 0) + remaining;
  });

  const apByWeek: Record<string, number> = {};
  purchaseOrders.forEach((po) => {
    if (po.status === 'RECEIVED' || po.status === 'CANCELLED') return;
    apByWeek[getWeekStart(po.expectedDate)] =
      (apByWeek[getWeekStart(po.expectedDate)] || 0) + po.totalSen;
  });

  let runningBalance = totalCashSen;
  const forecast = weeks.map((weekStart) => {
    const arInflow = arByWeek[weekStart] || 0;
    const apOutflow = apByWeek[weekStart] || 0;
    const net = arInflow - apOutflow;
    runningBalance += net;
    return {
      weekStart,
      arInflowSen: arInflow,
      apOutflowSen: apOutflow,
      netSen: net,
      runningBalanceSen: runningBalance,
    };
  });

  const totalInflows = forecast.reduce((s, w) => s + w.arInflowSen, 0);
  const totalOutflows = forecast.reduce((s, w) => s + w.apOutflowSen, 0);

  return c.json({
    bankAccounts,
    bankTransactions,
    journalEntries: journalEntries.map((je) => ({
      id: je.id,
      entryNo: je.entryNo,
      date: je.date,
      description: je.description,
      lines: je.lines,
      status: je.status,
    })),
    forecast,
    summary: {
      currentCashSen: totalCashSen,
      totalInflowsSen: totalInflows,
      totalOutflowsSen: totalOutflows,
      netCashFlowSen: totalInflows - totalOutflows,
    },
  });
});

// POST /api/cash-flow
app.post('/', async (c) => {
  const body = await c.req.json();
  const { action } = body;

  if (action === 'add-transaction') {
    const { bankAccountId, date, description, amountSen, type, reference } = body;
    const newTx: BankTransaction = {
      id: generateId(),
      bankAccountId,
      date,
      description,
      amountSen,
      type,
      reference,
      isReconciled: false,
    };
    bankTransactions.unshift(newTx);
    const account = bankAccounts.find((a) => a.id === bankAccountId);
    if (account) account.balanceSen += amountSen;
    return c.json({ success: true, transaction: newTx });
  }

  if (action === 'reconcile') {
    const { bankTransactionId, journalEntryId } = body;
    const tx = bankTransactions.find((t) => t.id === bankTransactionId);
    if (tx) {
      tx.isReconciled = true;
      tx.matchedJournalId = journalEntryId;
    }
    return c.json({ success: true });
  }

  return c.json({ error: 'Unknown action' }, 400);
});

export default app;
