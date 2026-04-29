// ---------------------------------------------------------------------------
// D1-backed cash-flow route.
//
// Mirrors the old src/api/routes/cash-flow.ts shape:
//   GET  /api/cash-flow            → { bankAccounts, bankTransactions,
//                                       journalEntries, forecast, summary }
//   POST /api/cash-flow            → { action: "add-transaction" | "reconcile" }
//
// The 12-week AR/AP forecast joins invoices + purchase_orders (already D1-
// backed). Response keys match the legacy route so the frontend stays intact.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------
type BankAccountRow = {
  id: string;
  bankName: string;
  accountNo: string;
  accountName: string;
  balanceSen: number;
  currency: string;
};

type BankTxRow = {
  id: string;
  bankAccountId: string;
  date: string;
  description: string;
  amountSen: number;
  type: "DEPOSIT" | "WITHDRAWAL" | "TRANSFER";
  reference: string;
  isReconciled: number;
  matchedJournalId: string | null;
};

type JournalEntryRow = {
  id: string;
  entryNo: string;
  date: string;
  description: string;
  status: string;
};

type JournalLineRow = {
  journalEntryId: string;
  accountCode: string;
  accountName: string;
  debitSen: number;
  creditSen: number;
  description: string;
};

type InvoiceRow = {
  id: string;
  status: string;
  dueDate: string;
  totalSen: number;
  paidAmount: number;
};

type PoRow = {
  id: string;
  status: string;
  expectedDate: string;
  totalSen: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().split("T")[0];
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
    weeks.push(d.toISOString().split("T")[0]);
  }
  return weeks;
}

function genId(): string {
  return `tx-${crypto.randomUUID().slice(0, 8)}`;
}

function rowToBankAccount(r: BankAccountRow) {
  return {
    id: r.id,
    bankName: r.bankName,
    accountNo: r.accountNo,
    accountName: r.accountName,
    balanceSen: r.balanceSen,
    currency: r.currency,
  };
}

function rowToBankTx(r: BankTxRow) {
  return {
    id: r.id,
    bankAccountId: r.bankAccountId,
    date: r.date,
    description: r.description,
    amountSen: r.amountSen,
    type: r.type,
    reference: r.reference,
    isReconciled: r.isReconciled === 1,
    matchedJournalId: r.matchedJournalId ?? undefined,
  };
}

// Safe SELECTs that don't explode if the source table hasn't been created yet
// (e.g. first deploy before invoice/PO routes are applied).
async function safeAll<T>(db: D1Database, sql: string): Promise<T[]> {
  try {
    const res = await db.prepare(sql).all<T>();
    return res.results ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// GET /api/cash-flow
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const [accountsRes, txsRes, entriesRes, linesRes, invoices, pos] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM bank_accounts").all<BankAccountRow>(),
    c.var.DB.prepare("SELECT * FROM bank_transactions ORDER BY date DESC").all<BankTxRow>(),
    safeAll<JournalEntryRow>(
      c.var.DB,
      "SELECT id, entryNo, date, description, status FROM journal_entries ORDER BY date DESC",
    ),
    safeAll<JournalLineRow>(c.var.DB, "SELECT * FROM journal_lines"),
    safeAll<InvoiceRow>(
      c.var.DB,
      `SELECT id, status, dueDate, totalSen, COALESCE(paidAmount, 0) AS "paidAmount" FROM invoices`,
    ),
    safeAll<PoRow>(
      c.var.DB,
      "SELECT id, status, expectedDate, totalSen FROM purchase_orders",
    ),
  ]);

  const bankAccounts = (accountsRes.results ?? []).map(rowToBankAccount);
  const bankTransactions = (txsRes.results ?? []).map(rowToBankTx);

  const journalEntries = entriesRes.map((e) => ({
    id: e.id,
    entryNo: e.entryNo,
    date: e.date,
    description: e.description,
    status: e.status,
    lines: linesRes
      .filter((l) => l.journalEntryId === e.id)
      .map((l) => ({
        accountCode: l.accountCode,
        accountName: l.accountName,
        debitSen: l.debitSen,
        creditSen: l.creditSen,
        description: l.description,
      })),
  }));

  const totalCashSen = bankAccounts.reduce((s, a) => s + a.balanceSen, 0);
  const weeks = getNextWeeks(12);

  const arByWeek: Record<string, number> = {};
  invoices.forEach((inv) => {
    if (inv.status === "PAID" || inv.status === "CANCELLED") return;
    const remaining = (inv.totalSen || 0) - (inv.paidAmount || 0);
    if (remaining <= 0) return;
    const wk = getWeekStart(inv.dueDate);
    arByWeek[wk] = (arByWeek[wk] || 0) + remaining;
  });

  const apByWeek: Record<string, number> = {};
  pos.forEach((po) => {
    if (po.status === "RECEIVED" || po.status === "CANCELLED") return;
    const wk = getWeekStart(po.expectedDate);
    apByWeek[wk] = (apByWeek[wk] || 0) + (po.totalSen || 0);
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
    journalEntries,
    forecast,
    summary: {
      currentCashSen: totalCashSen,
      totalInflowsSen: totalInflows,
      totalOutflowsSen: totalOutflows,
      netCashFlowSen: totalInflows - totalOutflows,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/cash-flow — add-transaction | reconcile
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  const denied = await requirePermission(c, "cash-flow", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const { action } = body;

    if (action === "add-transaction") {
      const { bankAccountId, date, description, amountSen, type, reference } = body;
      if (!bankAccountId || !date || typeof amountSen !== "number" || !type) {
        return c.json(
          { error: "bankAccountId, date, amountSen, and type are required" },
          400,
        );
      }

      const id = genId();
      await c.var.DB.prepare(
        `INSERT INTO bank_transactions
           (id, bankAccountId, date, description, amountSen, type, reference, isReconciled)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      )
        .bind(id, bankAccountId, date, description ?? "", amountSen, type, reference ?? "")
        .run();

      // Adjust bank account balance.
      await c.var.DB.prepare(
        "UPDATE bank_accounts SET balanceSen = balanceSen + ? WHERE id = ?",
      )
        .bind(amountSen, bankAccountId)
        .run();

      const tx = await c.var.DB.prepare(
        "SELECT * FROM bank_transactions WHERE id = ?",
      )
        .bind(id)
        .first<BankTxRow>();
      return c.json({ success: true, transaction: rowToBankTx(tx!) });
    }

    if (action === "reconcile") {
      const { bankTransactionId, journalEntryId } = body;
      if (!bankTransactionId) {
        return c.json({ error: "bankTransactionId is required" }, 400);
      }
      await c.var.DB.prepare(
        "UPDATE bank_transactions SET isReconciled = 1, matchedJournalId = ? WHERE id = ?",
      )
        .bind(journalEntryId ?? null, bankTransactionId)
        .run();
      return c.json({ success: true });
    }

    return c.json({ error: "Unknown action" }, 400);
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }
});

export default app;
