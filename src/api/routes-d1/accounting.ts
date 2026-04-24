// ---------------------------------------------------------------------------
// D1-backed accounting route.
//
// Mirrors the old src/api/routes/accounting.ts shape so the SPA frontend
// doesn't need any changes. Covers:
//   - Chart of Accounts  (GET/POST/PUT  /coa)
//   - Journal Entries    (GET/POST/PUT/DELETE  /journals, /journals/:id)
//   - AR/AP Aging        (GET/POST  /aging)
//   - P&L                (GET  /pl)
//
// DB columns are camelCase; response fields are also camelCase. Timestamp
// columns (`created_at`, `updated_at`) are snake_case per repo convention
// and are remapped to camelCase in the response.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------
type CoaRow = {
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  parentCode: string | null;
  balanceSen: number;
  isActive: number;
  created_at: string;
};

type JournalEntryRow = {
  id: string;
  entryNo: string;
  date: string;
  description: string;
  status: "DRAFT" | "POSTED" | "REVERSED";
  createdBy: string;
  created_at: string;
};

type JournalLineRow = {
  id: number;
  journalEntryId: string;
  lineOrder: number;
  accountCode: string;
  accountName: string;
  debitSen: number;
  creditSen: number;
  description: string;
};

type ArAgingRow = {
  customerId: string;
  customerName: string;
  currentSen: number;
  days30Sen: number;
  days60Sen: number;
  days90Sen: number;
  over90Sen: number;
};

type ApAgingRow = {
  supplierId: string;
  supplierName: string;
  currentSen: number;
  days30Sen: number;
  days60Sen: number;
  days90Sen: number;
  over90Sen: number;
};

type PlRow = {
  id: string;
  period: string;
  accountCode: string;
  accountName: string;
  category: "REVENUE" | "COGS" | "OPERATING_EXPENSE" | "OTHER_INCOME" | "OTHER_EXPENSE";
  amountSen: number;
  productCategory: string | null;
  customerId: string | null;
  customerName: string | null;
  state: string | null;
};

type BalanceSheetRow = {
  id: string;
  accountCode: string;
  accountName: string;
  category: "CURRENT_ASSET" | "FIXED_ASSET" | "CURRENT_LIABILITY" | "LONG_TERM_LIABILITY" | "EQUITY";
  balanceSen: number;
  asOfDate: string;
};

// ---------------------------------------------------------------------------
// Row mappers — match the legacy mock-data shapes
// ---------------------------------------------------------------------------
function rowToCoa(r: CoaRow) {
  return {
    code: r.code,
    name: r.name,
    type: r.type,
    parentCode: r.parentCode ?? undefined,
    balance: r.balanceSen,
    isActive: r.isActive === 1,
  };
}

function rowToJournal(e: JournalEntryRow, lines: JournalLineRow[]) {
  return {
    id: e.id,
    entryNo: e.entryNo,
    date: e.date,
    description: e.description,
    status: e.status,
    createdBy: e.createdBy,
    createdAt: e.created_at,
    lines: lines
      .filter((l) => l.journalEntryId === e.id)
      .sort((a, b) => a.lineOrder - b.lineOrder)
      .map((l) => ({
        accountCode: l.accountCode,
        accountName: l.accountName,
        debitSen: l.debitSen,
        creditSen: l.creditSen,
        description: l.description,
      })),
  };
}

function rowToPl(r: PlRow) {
  return {
    id: r.id,
    period: r.period,
    accountCode: r.accountCode,
    accountName: r.accountName,
    category: r.category,
    amount: r.amountSen,
    productCategory: r.productCategory ?? undefined,
    customerId: r.customerId ?? undefined,
    customerName: r.customerName ?? undefined,
    state: r.state ?? undefined,
  };
}

function rowToBalanceSheet(r: BalanceSheetRow) {
  return {
    id: r.id,
    accountCode: r.accountCode,
    accountName: r.accountName,
    category: r.category,
    balance: r.balanceSen,
    asOfDate: r.asOfDate,
  };
}

function genId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function nextJeNo(db: D1Database): Promise<string> {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const res = await db
    .prepare(
      "SELECT COUNT(*) AS c FROM journal_entries WHERE entryNo LIKE ?",
    )
    .bind(`JE-${yymm}-%`)
    .first<{ c: number }>();
  const seq = (res?.c ?? 0) + 1;
  return `JE-${yymm}-${String(seq).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// AGING
// ---------------------------------------------------------------------------
app.get("/aging", async (c) => {
  const [ar, ap] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM ar_aging ORDER BY customerName").all<ArAgingRow>(),
    c.var.DB.prepare("SELECT * FROM ap_aging ORDER BY supplierName").all<ApAgingRow>(),
  ]);
  return c.json({
    success: true,
    data: {
      ar: ar.results ?? [],
      ap: ap.results ?? [],
    },
  });
});

app.post("/aging", async (c) => {
  try {
    const body = await c.req.json();
    const { type, id, amountSen } = body;
    if (!type || !id || !amountSen || amountSen <= 0) {
      return c.json(
        { success: false, error: "type (ar|ap), id, and amountSen are required" },
        400,
      );
    }

    if (type !== "ar" && type !== "ap") {
      return c.json({ success: false, error: "type must be 'ar' or 'ap'" }, 400);
    }

    const table = type === "ar" ? "ar_aging" : "ap_aging";
    const idCol = type === "ar" ? "customerId" : "supplierId";

    const row = await c.var.DB.prepare(
      `SELECT * FROM ${table} WHERE ${idCol} = ?`,
    )
      .bind(id)
      .first<ArAgingRow | ApAgingRow>();
    if (!row) {
      return c.json(
        { success: false, error: type === "ar" ? "Customer not found in AR" : "Supplier not found in AP" },
        404,
      );
    }

    // Drain oldest → newest buckets.
    const buckets: Array<keyof (ArAgingRow | ApAgingRow)> = [
      "over90Sen",
      "days90Sen",
      "days60Sen",
      "days30Sen",
      "currentSen",
    ];
    let remaining = amountSen;
    const updated: Record<string, number> = {};
    for (const b of buckets) {
      const val = row[b] as number;
      const apply = Math.min(remaining, val);
      updated[b as string] = val - apply;
      remaining -= apply;
      if (remaining <= 0) {
        // fill the rest unchanged
        const idx = buckets.indexOf(b);
        for (let i = idx + 1; i < buckets.length; i++) {
          updated[buckets[i] as string] = row[buckets[i]] as number;
        }
        break;
      }
    }

    await c.var.DB.prepare(
      `UPDATE ${table}
         SET currentSen = ?, days30Sen = ?, days60Sen = ?, days90Sen = ?, over90Sen = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE ${idCol} = ?`,
    )
      .bind(
        updated.currentSen ?? row.currentSen,
        updated.days30Sen ?? row.days30Sen,
        updated.days60Sen ?? row.days60Sen,
        updated.days90Sen ?? row.days90Sen,
        updated.over90Sen ?? row.over90Sen,
        id,
      )
      .run();

    const after = await c.var.DB.prepare(
      `SELECT * FROM ${table} WHERE ${idCol} = ?`,
    )
      .bind(id)
      .first<ArAgingRow | ApAgingRow>();
    return c.json({ success: true, data: after });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// CHART OF ACCOUNTS
// ---------------------------------------------------------------------------
app.get("/coa", async (c) => {
  const res = await c.var.DB.prepare(
    "SELECT * FROM chart_of_accounts WHERE isActive = 1 ORDER BY code",
  ).all<CoaRow>();
  const data = (res.results ?? []).map(rowToCoa);
  return c.json({ success: true, data, total: data.length });
});

app.post("/coa", async (c) => {
  try {
    const body = await c.req.json();
    const { code, name, type, parentCode } = body;
    if (!code || !name || !type) {
      return c.json(
        { success: false, error: "code, name, and type are required" },
        400,
      );
    }
    const validTypes = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"];
    if (!validTypes.includes(type)) {
      return c.json({ success: false, error: "Invalid account type" }, 400);
    }
    const dup = await c.var.DB.prepare(
      "SELECT code FROM chart_of_accounts WHERE code = ?",
    )
      .bind(code)
      .first();
    if (dup) {
      return c.json({ success: false, error: "Account code already exists" }, 400);
    }

    await c.var.DB.prepare(
      `INSERT INTO chart_of_accounts (code, name, type, parentCode, balanceSen, isActive)
       VALUES (?, ?, ?, ?, 0, 1)`,
    )
      .bind(code, name, type, parentCode ?? null)
      .run();

    const created = await c.var.DB.prepare(
      "SELECT * FROM chart_of_accounts WHERE code = ?",
    )
      .bind(code)
      .first<CoaRow>();
    return c.json({ success: true, data: rowToCoa(created!) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

app.put("/coa", async (c) => {
  try {
    const body = await c.req.json();
    const { code } = body;
    if (!code) {
      return c.json({ success: false, error: "code is required" }, 400);
    }
    const existing = await c.var.DB.prepare(
      "SELECT * FROM chart_of_accounts WHERE code = ?",
    )
      .bind(code)
      .first<CoaRow>();
    if (!existing) {
      return c.json({ success: false, error: "Account not found" }, 404);
    }
    const merged = {
      name: body.name ?? existing.name,
      parentCode:
        body.parentCode === undefined ? existing.parentCode : body.parentCode ?? null,
      isActive:
        body.isActive === undefined
          ? existing.isActive
          : body.isActive
            ? 1
            : 0,
    };
    await c.var.DB.prepare(
      `UPDATE chart_of_accounts SET name = ?, parentCode = ?, isActive = ? WHERE code = ?`,
    )
      .bind(merged.name, merged.parentCode, merged.isActive, code)
      .run();
    const updated = await c.var.DB.prepare(
      "SELECT * FROM chart_of_accounts WHERE code = ?",
    )
      .bind(code)
      .first<CoaRow>();
    return c.json({ success: true, data: rowToCoa(updated!) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// JOURNALS
// ---------------------------------------------------------------------------
app.get("/journals", async (c) => {
  const [entries, lines] = await Promise.all([
    c.var.DB.prepare(
      "SELECT * FROM journal_entries ORDER BY date DESC, entryNo DESC",
    ).all<JournalEntryRow>(),
    c.var.DB.prepare("SELECT * FROM journal_lines").all<JournalLineRow>(),
  ]);
  const data = (entries.results ?? []).map((e) =>
    rowToJournal(e, lines.results ?? []),
  );
  return c.json({ success: true, data, total: data.length });
});

app.post("/journals", async (c) => {
  try {
    const body = await c.req.json();
    const { date, description, lines } = body;
    if (!date || !description || !lines || !Array.isArray(lines) || lines.length === 0) {
      return c.json(
        { success: false, error: "date, description, and lines are required" },
        400,
      );
    }
    const totalDebit = lines.reduce(
      (s: number, l: { debitSen?: number }) => s + (l.debitSen || 0),
      0,
    );
    const totalCredit = lines.reduce(
      (s: number, l: { creditSen?: number }) => s + (l.creditSen || 0),
      0,
    );
    if (totalDebit !== totalCredit) {
      return c.json(
        { success: false, error: `Debits (${totalDebit}) must equal Credits (${totalCredit})` },
        400,
      );
    }
    if (totalDebit === 0) {
      return c.json({ success: false, error: "Journal entry must have non-zero amounts" }, 400);
    }

    const id = genId("je");
    const entryNo = await nextJeNo(c.var.DB);
    const createdBy = body.createdBy || "admin";

    await c.var.DB.prepare(
      `INSERT INTO journal_entries (id, entryNo, date, description, status, createdBy)
       VALUES (?, ?, ?, ?, 'DRAFT', ?)`,
    )
      .bind(id, entryNo, date, description, createdBy)
      .run();

    const inserts = lines.map(
      (l: {
        accountCode: string;
        accountName?: string;
        debitSen?: number;
        creditSen?: number;
        description?: string;
      }, idx: number) =>
        c.var.DB.prepare(
          `INSERT INTO journal_lines
             (journalEntryId, lineOrder, accountCode, accountName, debitSen, creditSen, description)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          id,
          idx,
          l.accountCode,
          l.accountName ?? "",
          l.debitSen ?? 0,
          l.creditSen ?? 0,
          l.description ?? "",
        ),
    );
    await c.var.DB.batch(inserts);

    const entry = await c.var.DB.prepare(
      "SELECT * FROM journal_entries WHERE id = ?",
    )
      .bind(id)
      .first<JournalEntryRow>();
    const lineRows = await c.var.DB.prepare(
      "SELECT * FROM journal_lines WHERE journalEntryId = ? ORDER BY lineOrder",
    )
      .bind(id)
      .all<JournalLineRow>();
    return c.json(
      { success: true, data: rowToJournal(entry!, lineRows.results ?? []) },
      201,
    );
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

app.get("/journals/:id", async (c) => {
  const id = c.req.param("id");
  const entry = await c.var.DB.prepare(
    "SELECT * FROM journal_entries WHERE id = ?",
  )
    .bind(id)
    .first<JournalEntryRow>();
  if (!entry) {
    return c.json({ success: false, error: "Journal entry not found" }, 404);
  }
  const lines = await c.var.DB.prepare(
    "SELECT * FROM journal_lines WHERE journalEntryId = ? ORDER BY lineOrder",
  )
    .bind(id)
    .all<JournalLineRow>();
  return c.json({
    success: true,
    data: rowToJournal(entry, lines.results ?? []),
  });
});

app.put("/journals/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const entry = await c.var.DB.prepare(
      "SELECT * FROM journal_entries WHERE id = ?",
    )
      .bind(id)
      .first<JournalEntryRow>();
    if (!entry) {
      return c.json({ success: false, error: "Journal entry not found" }, 404);
    }
    const body = await c.req.json();

    // Status transitions — post or reverse the entry and adjust account balances.
    if (body.status === "POSTED" && entry.status === "DRAFT") {
      await c.var.DB.prepare(
        "UPDATE journal_entries SET status = 'POSTED' WHERE id = ?",
      )
        .bind(id)
        .run();
      const lines = await c.var.DB.prepare(
        "SELECT * FROM journal_lines WHERE journalEntryId = ?",
      )
        .bind(id)
        .all<JournalLineRow>();
      for (const l of lines.results ?? []) {
        const acct = await c.var.DB.prepare(
          "SELECT * FROM chart_of_accounts WHERE code = ?",
        )
          .bind(l.accountCode)
          .first<CoaRow>();
        if (!acct) continue;
        const delta =
          acct.type === "ASSET" || acct.type === "EXPENSE"
            ? l.debitSen - l.creditSen
            : l.creditSen - l.debitSen;
        await c.var.DB.prepare(
          "UPDATE chart_of_accounts SET balanceSen = balanceSen + ? WHERE code = ?",
        )
          .bind(delta, l.accountCode)
          .run();
      }
    } else if (body.status === "REVERSED" && entry.status === "POSTED") {
      await c.var.DB.prepare(
        "UPDATE journal_entries SET status = 'REVERSED' WHERE id = ?",
      )
        .bind(id)
        .run();
      const lines = await c.var.DB.prepare(
        "SELECT * FROM journal_lines WHERE journalEntryId = ?",
      )
        .bind(id)
        .all<JournalLineRow>();
      for (const l of lines.results ?? []) {
        const acct = await c.var.DB.prepare(
          "SELECT * FROM chart_of_accounts WHERE code = ?",
        )
          .bind(l.accountCode)
          .first<CoaRow>();
        if (!acct) continue;
        const delta =
          acct.type === "ASSET" || acct.type === "EXPENSE"
            ? -(l.debitSen - l.creditSen)
            : -(l.creditSen - l.debitSen);
        await c.var.DB.prepare(
          "UPDATE chart_of_accounts SET balanceSen = balanceSen + ? WHERE code = ?",
        )
          .bind(delta, l.accountCode)
          .run();
      }
    } else if (entry.status === "DRAFT") {
      // Draft-only edits of header + lines.
      if (body.date !== undefined || body.description !== undefined) {
        await c.var.DB.prepare(
          "UPDATE journal_entries SET date = ?, description = ? WHERE id = ?",
        )
          .bind(body.date ?? entry.date, body.description ?? entry.description, id)
          .run();
      }
      if (body.lines !== undefined && Array.isArray(body.lines)) {
        const totalDebit = body.lines.reduce(
          (s: number, l: { debitSen?: number }) => s + (l.debitSen || 0),
          0,
        );
        const totalCredit = body.lines.reduce(
          (s: number, l: { creditSen?: number }) => s + (l.creditSen || 0),
          0,
        );
        if (totalDebit !== totalCredit) {
          return c.json(
            { success: false, error: "Debits must equal Credits" },
            400,
          );
        }
        await c.var.DB.prepare(
          "DELETE FROM journal_lines WHERE journalEntryId = ?",
        )
          .bind(id)
          .run();
        const inserts = body.lines.map(
          (l: {
            accountCode: string;
            accountName?: string;
            debitSen?: number;
            creditSen?: number;
            description?: string;
          }, idx: number) =>
            c.var.DB.prepare(
              `INSERT INTO journal_lines
                 (journalEntryId, lineOrder, accountCode, accountName, debitSen, creditSen, description)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              id,
              idx,
              l.accountCode,
              l.accountName ?? "",
              l.debitSen ?? 0,
              l.creditSen ?? 0,
              l.description ?? "",
            ),
        );
        if (inserts.length) await c.var.DB.batch(inserts);
      }
    }

    const updated = await c.var.DB.prepare(
      "SELECT * FROM journal_entries WHERE id = ?",
    )
      .bind(id)
      .first<JournalEntryRow>();
    const lines = await c.var.DB.prepare(
      "SELECT * FROM journal_lines WHERE journalEntryId = ? ORDER BY lineOrder",
    )
      .bind(id)
      .all<JournalLineRow>();
    return c.json({
      success: true,
      data: rowToJournal(updated!, lines.results ?? []),
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

app.delete("/journals/:id", async (c) => {
  const id = c.req.param("id");
  const entry = await c.var.DB.prepare(
    "SELECT * FROM journal_entries WHERE id = ?",
  )
    .bind(id)
    .first<JournalEntryRow>();
  if (!entry) {
    return c.json({ success: false, error: "Journal entry not found" }, 404);
  }
  if (entry.status !== "DRAFT") {
    return c.json({ success: false, error: "Only DRAFT entries can be deleted" }, 400);
  }
  await c.var.DB.prepare("DELETE FROM journal_entries WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// P&L
// ---------------------------------------------------------------------------
app.get("/pl", async (c) => {
  const period = c.req.query("period");
  const productCategory = c.req.query("productCategory");
  const customerId = c.req.query("customerId");
  const state = c.req.query("state");

  const res = await c.var.DB.prepare("SELECT * FROM pl_entries").all<PlRow>();
  let entries = (res.results ?? []).slice();

  if (period) {
    if (period.includes("Q")) {
      const [year, q] = period.split("-Q");
      const qNum = parseInt(q, 10);
      const startMonth = (qNum - 1) * 3 + 1;
      const months = [startMonth, startMonth + 1, startMonth + 2].map(
        (m) => `${year}-${m.toString().padStart(2, "0")}`,
      );
      entries = entries.filter((e) => months.includes(e.period));
    } else if (period.length === 4) {
      entries = entries.filter((e) => e.period.startsWith(period));
    } else {
      entries = entries.filter((e) => e.period === period);
    }
  }
  if (productCategory)
    entries = entries.filter(
      (e) => e.category !== "REVENUE" || e.productCategory === productCategory,
    );
  if (customerId)
    entries = entries.filter(
      (e) => e.category !== "REVENUE" || e.customerId === customerId,
    );
  if (state)
    entries = entries.filter(
      (e) => e.category !== "REVENUE" || e.state === state,
    );

  const mapped = entries.map(rowToPl);

  const totalRevenue = mapped
    .filter((e) => e.category === "REVENUE")
    .reduce((s, e) => s + e.amount, 0);
  const totalCOGS = mapped
    .filter((e) => e.category === "COGS")
    .reduce((s, e) => s + e.amount, 0);
  const totalOpex = mapped
    .filter((e) => e.category === "OPERATING_EXPENSE")
    .reduce((s, e) => s + e.amount, 0);
  const grossProfit = totalRevenue - totalCOGS;
  const grossProfitPct = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
  const netProfit = grossProfit - totalOpex;
  const netProfitPct = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

  const revenueByProduct: Record<string, number> = {};
  mapped
    .filter((e) => e.category === "REVENUE")
    .forEach((e) => {
      const key = e.productCategory || "OTHER";
      revenueByProduct[key] = (revenueByProduct[key] || 0) + e.amount;
    });
  const revenueByCustomer: Record<string, number> = {};
  mapped
    .filter((e) => e.category === "REVENUE")
    .forEach((e) => {
      const key = e.customerName || "Unknown";
      revenueByCustomer[key] = (revenueByCustomer[key] || 0) + e.amount;
    });
  const cogsByAccount: Record<string, number> = {};
  mapped
    .filter((e) => e.category === "COGS")
    .forEach((e) => {
      cogsByAccount[e.accountName] = (cogsByAccount[e.accountName] || 0) + e.amount;
    });
  const opexByAccount: Record<string, number> = {};
  mapped
    .filter((e) => e.category === "OPERATING_EXPENSE")
    .forEach((e) => {
      opexByAccount[e.accountName] = (opexByAccount[e.accountName] || 0) + e.amount;
    });

  const bsRes = await c.var.DB.prepare("SELECT * FROM balance_sheet_entries").all<BalanceSheetRow>();
  const balanceSheet = (bsRes.results ?? []).map(rowToBalanceSheet);

  return c.json({
    success: true,
    data: {
      entries: mapped,
      totals: {
        revenue: totalRevenue,
        cogs: totalCOGS,
        grossProfit,
        grossProfitPct: Math.round(grossProfitPct * 100) / 100,
        operatingExpenses: totalOpex,
        netProfit,
        netProfitPct: Math.round(netProfitPct * 100) / 100,
      },
      revenueByProduct,
      revenueByCustomer,
      cogsByAccount,
      opexByAccount,
      balanceSheet,
    },
  });
});

export default app;
