// ---------------------------------------------------------------------------
// D1-backed departments route.
//
// Read-only lookup table. Mirrors src/api/routes/departments.ts exactly.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

type DepartmentRow = {
  id: string;
  code: string;
  name: string;
  shortName: string;
  sequence: number;
  color: string;
  workingHoursPerDay: number;
};

// GET /api/departments
app.get("/", async (c) => {
  const res = await c.var.DB.prepare(
    "SELECT * FROM departments ORDER BY sequence",
  ).all<DepartmentRow>();
  return c.json({ success: true, data: res.results ?? [] });
});

export default app;
