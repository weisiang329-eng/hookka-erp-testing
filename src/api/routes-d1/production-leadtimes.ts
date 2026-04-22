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
  ensureHookkaDDBufferSeeded,
  loadHookkaDDBuffer,
  type LeadTimeMap,
  type HookkaDDBuffer,
} from "../lib/lead-times";

const app = new Hono<Env>();

const CATEGORIES = ["BEDFRAME", "SOFA"] as const;
type Category = (typeof CATEGORIES)[number];

type LeadTimesResponse = LeadTimeMap & {
  hookkaDDBuffer: HookkaDDBuffer;
};

async function buildResponsePayload(db: D1Database): Promise<LeadTimesResponse> {
  const [lead, buffer] = await Promise.all([
    loadLeadTimes(db),
    loadHookkaDDBuffer(db),
  ]);
  return { ...lead, hookkaDDBuffer: buffer };
}

// GET /
app.get("/", async (c) => {
  await ensureLeadTimesSeeded(c.env.DB);
  await ensureHookkaDDBufferSeeded(c.env.DB);
  const data = await buildResponsePayload(c.env.DB);
  return c.json({ success: true, data });
});

// PUT /
// Accepts { BEDFRAME: { DEPT: n, ... }, SOFA: {...}, hookkaDDBuffer: { BEDFRAME: n, SOFA: n } }
// All three top-level keys are optional — any missing key is left unchanged.
app.put("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ success: false, error: "Body must be an object" }, 400);
  }

  await ensureLeadTimesSeeded(c.env.DB);
  await ensureHookkaDDBufferSeeded(c.env.DB);

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

  // Hookka Expected DD buffer — accepts { BEDFRAME: n, SOFA: n }.
  const bufferBody = (body as Record<string, unknown>).hookkaDDBuffer;
  if (bufferBody && typeof bufferBody === "object") {
    for (const cat of CATEGORIES) {
      const raw = (bufferBody as Record<string, unknown>)[cat];
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) continue;
      const days = Math.round(n);
      statements.push(
        c.env.DB.prepare(
          "INSERT OR REPLACE INTO hookka_dd_buffer (category, days) VALUES (?, ?)",
        ).bind(cat as Category, days),
      );
    }
  }

  if (statements.length > 0) {
    await c.env.DB.batch(statements);
  }

  const data = await buildResponsePayload(c.env.DB);
  return c.json({ success: true, data });
});

export default app;
