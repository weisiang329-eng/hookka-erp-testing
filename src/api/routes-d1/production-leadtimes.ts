// ---------------------------------------------------------------------------
// D1-backed Production Lead Times.
//
// GET / — returns the full (category → deptCode → days) map.
// PUT / — accepts { BEDFRAME: {...}, SOFA: {...} } and upserts each entry.
//
// Response shape matches the original mock route so the Planning page
// (src/pages/planning/index.tsx) doesn't need changes:
//   { success: true, data: { BEDFRAME: { FAB_CUT: 7, ... }, SOFA: {...} } }
//
// Seeding: on the first GET/PUT after deploy the table may be empty —
// `ensureLeadTimesSeeded` inserts safe defaults (see ../lib/lead-times.ts).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import {
  ensureLeadTimesSeeded,
  loadLeadTimes,
  type LeadTimeMap,
} from "../lib/lead-times";

const app = new Hono<Env>();

const CATEGORIES = ["BEDFRAME", "SOFA"] as const;
type Category = (typeof CATEGORIES)[number];

// GET /
app.get("/", async (c) => {
  await ensureLeadTimesSeeded(c.env.DB);
  const data = await loadLeadTimes(c.env.DB);
  return c.json({ success: true, data });
});

// PUT /
app.put("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ success: false, error: "Body must be an object" }, 400);
  }

  await ensureLeadTimesSeeded(c.env.DB);

  const statements: D1PreparedStatement[] = [];
  for (const cat of CATEGORIES) {
    const incoming = (body as Record<string, unknown>)[cat];
    if (!incoming || typeof incoming !== "object") continue;
    for (const [deptCode, raw] of Object.entries(
      incoming as Record<string, unknown>,
    )) {
      const n = Number(raw);
      // Preserve original validation: reject non-finite and negative; coerce to int.
      if (!Number.isFinite(n) || n < 0) continue;
      const days = Math.round(n);
      statements.push(
        c.env.DB.prepare(
          "INSERT OR REPLACE INTO production_lead_times (category, deptCode, days) VALUES (?, ?, ?)",
        ).bind(cat as Category, deptCode, days),
      );
    }
  }

  if (statements.length > 0) {
    await c.env.DB.batch(statements);
  }

  const data: LeadTimeMap = await loadLeadTimes(c.env.DB);
  return c.json({ success: true, data });
});

export default app;
