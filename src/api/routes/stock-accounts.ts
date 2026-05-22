// ---------------------------------------------------------------------------
// D1-backed stock-accounts route.
//
// Mirrors src/api/routes/stock-accounts.ts — read-only list of the chart of
// stock accounts (FG/WIP/RAW_MATERIAL). Columns in `stock_accounts` match the
// StockAccount TS type directly.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

type StockAccountRow = {
  code: string;
  description: string | null;
  category: "FG" | "WIP" | "RAW_MATERIAL" | null;
};

function rowToAccount(r: StockAccountRow) {
  return {
    code: r.code,
    description: r.description ?? "",
    category: r.category ?? "RAW_MATERIAL",
  };
}

// GET /api/stock-accounts — list all stock accounts
app.get("/", async (c) => {
  // stock_accounts is the FG/WIP/RAW_MATERIAL chart — warehouse/inventory
  // domain, gate with the same inventory-read permission as inventory.ts.
  const denied = await requirePermission(c, "inventory", "read");
  if (denied) return denied;

  const res = await c.var.DB.prepare(
    "SELECT * FROM stock_accounts ORDER BY code",
  ).all<StockAccountRow>();
  const data = (res.results ?? []).map(rowToAccount);
  return c.json({ success: true, data });
});

export default app;
