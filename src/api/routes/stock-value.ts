// ---------------------------------------------------------------------------
// D1-backed stock-value route.
//
// Mirrors src/api/routes/stock-value.ts. Reads/writes the monthly_stock_values
// table. POST seeds one row per stock_accounts entry for a new period,
// carrying over the prior period's closingValue as the new openingValue.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

type MonthlyStockValueRow = {
  id: string;
  period: string;
  accountCode: string;
  accountDescription: string | null;
  openingValue: number;
  purchasesValue: number;
  consumptionValue: number;
  closingValue: number;
  physicalCountValue: number | null;
  variancePercent: number | null;
  status: "DRAFT" | "REVIEWED" | "POSTED" | null;
  postedDate: string | null;
  postedBy: string | null;
};

type StockAccountRow = {
  code: string;
  description: string | null;
};

function rowToValue(r: MonthlyStockValueRow) {
  return {
    id: r.id,
    period: r.period,
    accountCode: r.accountCode,
    accountDescription: r.accountDescription ?? "",
    openingValue: r.openingValue,
    purchasesValue: r.purchasesValue,
    consumptionValue: r.consumptionValue,
    closingValue: r.closingValue,
    physicalCountValue: r.physicalCountValue,
    variancePercent: r.variancePercent,
    status: r.status ?? "DRAFT",
    postedDate: r.postedDate,
    postedBy: r.postedBy,
  };
}

function genId(): string {
  return `msv-${crypto.randomUUID().slice(0, 8)}`;
}

// GET /api/stock-value?period=2026-04 — optional period filter
app.get("/", async (c) => {
  const period = c.req.query("period");
  const sql = period
    ? "SELECT * FROM monthly_stock_values WHERE period = ? ORDER BY accountCode"
    : "SELECT * FROM monthly_stock_values ORDER BY period DESC, accountCode";
  const stmt = period
    ? c.var.DB.prepare(sql).bind(period)
    : c.var.DB.prepare(sql);
  const res = await stmt.all<MonthlyStockValueRow>();
  const data = (res.results ?? []).map(rowToValue);
  return c.json({ success: true, data });
});

// POST /api/stock-value — seed rows for a new period, carrying prior closings
app.post("/", async (c) => {
  const denied = await requirePermission(c, "stock-value", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const { period } = body;
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      return c.json(
        { success: false, error: "Valid period (YYYY-MM) is required" },
        400,
      );
    }

    const existing = await c.var.DB.prepare(
      "SELECT id FROM monthly_stock_values WHERE period = ? LIMIT 1",
    )
      .bind(period)
      .first<{ id: string }>();
    if (existing) {
      return c.json(
        { success: false, error: "Entries already exist for this period" },
        409,
      );
    }

    const [year, month] = period.split("-").map(Number);
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const prevPeriod = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;

    const [accountsRes, prevEntriesRes] = await Promise.all([
      c.var.DB.prepare(
        "SELECT code, description FROM stock_accounts ORDER BY code",
      ).all<StockAccountRow>(),
      c.var.DB.prepare(
        "SELECT * FROM monthly_stock_values WHERE period = ?",
      )
        .bind(prevPeriod)
        .all<MonthlyStockValueRow>(),
    ]);
    const prevEntries = prevEntriesRes.results ?? [];

    const newEntries = (accountsRes.results ?? []).map((acct) => {
      const prev = prevEntries.find((e) => e.accountCode === acct.code);
      const openingValue = prev ? prev.closingValue : 0;
      return {
        id: genId(),
        period,
        accountCode: acct.code,
        accountDescription: acct.description ?? "",
        openingValue,
        purchasesValue: 0,
        consumptionValue: 0,
        closingValue: openingValue,
        physicalCountValue: null as number | null,
        variancePercent: null as number | null,
        status: "DRAFT" as const,
        postedDate: null as string | null,
        postedBy: null as string | null,
      };
    });

    if (newEntries.length === 0) {
      return c.json({ success: true, data: [] }, 201);
    }

    const statements = newEntries.map((e) =>
      c.var.DB.prepare(
        `INSERT INTO monthly_stock_values (id, period, accountCode,
           accountDescription, openingValue, purchasesValue, consumptionValue,
           closingValue, physicalCountValue, variancePercent, status,
           postedDate, postedBy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        e.id,
        e.period,
        e.accountCode,
        e.accountDescription,
        e.openingValue,
        e.purchasesValue,
        e.consumptionValue,
        e.closingValue,
        e.physicalCountValue,
        e.variancePercent,
        e.status,
        e.postedDate,
        e.postedBy,
      ),
    );
    await c.var.DB.batch(statements);

    return c.json({ success: true, data: newEntries.map(rowToValue) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/stock-value/:id — single entry by id
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.var.DB.prepare(
    "SELECT * FROM monthly_stock_values WHERE id = ?",
  )
    .bind(id)
    .first<MonthlyStockValueRow>();
  if (!row) {
    return c.json({ success: false, error: "Stock value entry not found" }, 404);
  }
  return c.json({ success: true, data: rowToValue(row) });
});

// PUT /api/stock-value/:id — partial update; recomputes closingValue when
// purchases/consumption change, and variancePercent when physicalCount set.
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "stock-value", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM monthly_stock_values WHERE id = ?",
  )
    .bind(id)
    .first<MonthlyStockValueRow>();
  if (!existing) {
    return c.json({ success: false, error: "Stock value entry not found" }, 404);
  }
  try {
    const body = await c.req.json();
    const merged = {
      purchasesValue:
        body.purchasesValue !== undefined
          ? Number(body.purchasesValue)
          : existing.purchasesValue,
      consumptionValue:
        body.consumptionValue !== undefined
          ? Number(body.consumptionValue)
          : existing.consumptionValue,
      closingValue:
        body.closingValue !== undefined
          ? Number(body.closingValue)
          : existing.closingValue,
      physicalCountValue:
        body.physicalCountValue !== undefined
          ? body.physicalCountValue === null
            ? null
            : Number(body.physicalCountValue)
          : existing.physicalCountValue,
      variancePercent:
        body.variancePercent !== undefined
          ? body.variancePercent === null
            ? null
            : Number(body.variancePercent)
          : existing.variancePercent,
      status: body.status ?? existing.status ?? "DRAFT",
      postedDate:
        body.postedDate !== undefined ? body.postedDate : existing.postedDate,
      postedBy:
        body.postedBy !== undefined ? body.postedBy : existing.postedBy,
    };

    // Recompute closing if purchases/consumption changed (same logic as
    // in-memory route).
    if (body.purchasesValue !== undefined || body.consumptionValue !== undefined) {
      merged.closingValue =
        existing.openingValue + merged.purchasesValue - merged.consumptionValue;
    }

    if (
      merged.physicalCountValue !== null &&
      merged.closingValue !== 0
    ) {
      merged.variancePercent =
        Math.round(
          ((merged.physicalCountValue - merged.closingValue) /
            merged.closingValue) *
            10000,
        ) / 100;
    }

    await c.var.DB.prepare(
      `UPDATE monthly_stock_values SET
         purchasesValue = ?, consumptionValue = ?, closingValue = ?,
         physicalCountValue = ?, variancePercent = ?, status = ?,
         postedDate = ?, postedBy = ?
       WHERE id = ?`,
    )
      .bind(
        merged.purchasesValue,
        merged.consumptionValue,
        merged.closingValue,
        merged.physicalCountValue,
        merged.variancePercent,
        merged.status,
        merged.postedDate,
        merged.postedBy,
        id,
      )
      .run();

    const updated = await c.var.DB.prepare(
      "SELECT * FROM monthly_stock_values WHERE id = ?",
    )
      .bind(id)
      .first<MonthlyStockValueRow>();
    if (!updated) {
      return c.json(
        { success: false, error: "Failed to reload stock value entry" },
        500,
      );
    }
    return c.json({ success: true, data: rowToValue(updated) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

export default app;
