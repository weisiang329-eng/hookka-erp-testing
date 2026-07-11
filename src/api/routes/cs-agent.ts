// ---------------------------------------------------------------------------
// cs-agent.ts — Customer Service Agent HTTP surface (read-only).
//
// Mounted at /api/cs-agent in src/api/worker.ts.
//
//   GET /promise?soId=SO-2607-012            (or internal id)
//   GET /promise?productCode=X&qty=2&state=JHR   (ad-hoc what-if)
//       → promiseDelivery() reasoning chain materials → production → delivery
//         (see lib/cs-agent.ts).
//       RBAC: sales-orders:read (a promise is a sales-facing answer).
//
//   GET /procurement/readiness
//       → procurementReadiness() — the Procurement Agent's honesty gate
//       (data-prerequisite scoreboard from docs/AGENTS-BLUEPRINT.md).
//       RBAC: purchase-orders:read.
//
// Both endpoints are PURE READS — the CS Agent never writes documents
// (blueprint red line). No tables are created; no runtime self-apply needed.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { resolveStateCode } from "../../lib/malaysia-states";
import { promiseDelivery } from "../lib/cs-agent";
import { procurementReadiness } from "../lib/procurement-agent";

const app = new Hono<Env>();

// GET /api/cs-agent/promise?soId=... | ?productCode=...&qty=...&state=...
app.get("/promise", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);

  const soId = (c.req.query("soId") || "").trim();
  const productCode = (c.req.query("productCode") || "").trim();
  const qtyRaw = c.req.query("qty");
  const qty = qtyRaw ? parseInt(qtyRaw, 10) : 1;
  const stateRaw = (c.req.query("state") || "").trim();

  if (!soId && !productCode) {
    return c.json(
      { success: false, error: "Provide soId= or productCode= (with optional qty= and state=)" },
      400,
    );
  }
  if (productCode && (!Number.isFinite(qty) || qty < 1)) {
    return c.json({ success: false, error: "qty must be a positive integer" }, 400);
  }
  // Reject-don't-normalize on unknown states — but resolveStateCode DOES
  // accept documented legacy shorthand (KL/PG/JB…), same as the hub reader.
  let stateCode: string | null = null;
  if (stateRaw) {
    stateCode = resolveStateCode(stateRaw);
    if (!stateCode) {
      return c.json(
        { success: false, error: `Unknown state: ${stateRaw}. Use a canonical Malaysia state code (e.g. KUL, SGR, JHR).` },
        400,
      );
    }
  }

  const data = await promiseDelivery(c.var.DB, {
    soRef: soId || null,
    productCode: productCode || null,
    qty,
    stateCode,
    orgId,
  });
  return c.json({ success: true, data });
});

// GET /api/cs-agent/procurement/readiness
app.get("/procurement/readiness", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "read");
  if (denied) return denied;
  const data = await procurementReadiness(c.var.DB);
  return c.json({ success: true, data });
});

export default app;
