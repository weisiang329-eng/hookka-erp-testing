// ---------------------------------------------------------------------------
// supplier-price-refresh — bring the supplier price list up to what we ACTUALLY
// paid, so the next purchase order copies a current number.
//
// Owner 2026-08-28: 「把我们的价目表也更新去最新价钱」.
//
// ## Why this matters more than the invoices it reads
//
// Every PO autofills its unit price from `supplier_material_bindings`. Measured
// the same day: OCEAN SKY's three fastener lines were stamped 2026-05-05 and had
// not moved since, while August invoices paid something different on all three —
// two UP, one DOWN. A stale list is not a rounding bug; it silently prices every
// future order off a number nobody has agreed to in three months.
//
// ## Where "latest price" comes from, and where it does NOT
//
// The source is the most recent PURCHASE INVOICE line for that supplier +
// material. Not the scan (unreviewed), not the PO (what we asked for, not what
// we were charged), not an average (nobody agreed to an average). It is the
// document a person accepted, so the repair copies it verbatim — the same rule
// the whole sub-cent repair ran on.
//
// `effectiveFrom` is copied from that invoice's own date. Inventing today's date
// would claim the price changed when the paperwork was corrected rather than
// when the supplier changed it.
//
// ## What it refuses
//
//   · an invoice OLDER than the binding's current effective date — the list is
//     already ahead of the evidence, and moving it back would undo a decision
//   · two different prices on the SAME latest invoice date — genuinely
//     ambiguous, so neither is picked
//   · a zero-priced line — that is a delivery note or a free item, never a price
//   · a CANCELLED invoice, and any non-stocked line
//
// The write SELF-CALLS `PUT /api/supplier-materials/:id`, which appends the
// append-only `price_histories` row and stamps the effective date. Copying that
// here would give the Price Change Log two writers that can disagree.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../../worker";
import { requirePermission } from "../../lib/rbac";
import { getOrgId } from "../../lib/tenant";

const app = new Hono<Env>();

type Drift = {
  bindingId: string;
  supplierId: string;
  supplierName: string | null;
  materialCode: string;
  materialName: string | null;
  listSen: number;
  listEffectiveFrom: string | null;
  paidSen: number;
  paidOn: string | null;
  sourcePiNo: string | null;
  deltaSen: number;
  eligible: boolean;
  whyNot?: string;
};

async function buildDrift(db: D1Database, orgId: string): Promise<Drift[]> {
  // 1. Every stocked, priced invoice line, with the document's supplier + date.
  const lineRes = await db
    .prepare(
      `SELECT pi.supplier_id AS "supplierId", pi.supplier_name AS "supplierName",
              pi.invoice_date AS "invoiceDate", pi.pi_no AS "piNo",
              pii.material_code AS "materialCode",
              pii.unit_price_sen AS "unitPriceSen"
         FROM purchase_invoice_items pii
         JOIN purchase_invoices pi ON pi.id = pii.pi_id
        WHERE (pi.org_id = ? OR pi.org_id IS NULL)
          AND pi.status <> 'CANCELLED'
          AND COALESCE(pii.line_type, 'STOCKED') = 'STOCKED'
          AND pii.material_code IS NOT NULL
          AND pii.material_code <> ''
          AND pii.unit_price_sen > 0`,
    )
    .bind(orgId)
    .all<{
      supplierId: string | null;
      supplierName: string | null;
      invoiceDate: string | null;
      piNo: string | null;
      materialCode: string | null;
      unitPriceSen: number | null;
    }>();

  // 2. Per supplier+material, keep only the lines on the LATEST invoice date.
  type Latest = {
    date: string;
    prices: Set<number>;
    piNo: string | null;
    supplierName: string | null;
  };
  const latest = new Map<string, Latest>();
  for (const r of lineRes.results ?? []) {
    const sid = String(r.supplierId ?? "");
    const code = String(r.materialCode ?? "");
    const date = String(r.invoiceDate ?? "").slice(0, 10);
    const price = Number(r.unitPriceSen);
    if (!sid || !code || !date || !Number.isFinite(price) || price <= 0) continue;
    const key = `${sid}\u0000${code}`;
    const cur = latest.get(key);
    if (!cur || date > cur.date) {
      latest.set(key, {
        date,
        prices: new Set([price]),
        piNo: r.piNo,
        supplierName: r.supplierName,
      });
    } else if (date === cur.date) {
      cur.prices.add(price);
    }
  }

  // 3. Compare against the list.
  const bindRes = await db
    .prepare(
      `SELECT id, supplier_id AS "supplierId", material_code AS "materialCode",
              material_name AS "materialName", unit_price AS "unitPrice",
              effective_from AS "effectiveFrom", price_valid_from AS "priceValidFrom"
         FROM supplier_material_bindings
        WHERE (org_id = ? OR org_id IS NULL)`,
    )
    .bind(orgId)
    .all<Record<string, unknown>>();

  const out: Drift[] = [];
  for (const b of bindRes.results ?? []) {
    const sid = String(b.supplierId ?? "");
    const code = String(b.materialCode ?? "");
    const hit = latest.get(`${sid}\u0000${code}`);
    if (!hit) continue; // never invoiced — nothing to copy from, and no news

    const listSen = Number(b.unitPrice) || 0;
    const listFrom = String(b.effectiveFrom ?? b.priceValidFrom ?? "").slice(0, 10) || null;
    const base = {
      bindingId: String(b.id),
      supplierId: sid,
      supplierName: hit.supplierName,
      materialCode: code,
      materialName: (b.materialName as string | null) ?? null,
      listSen,
      listEffectiveFrom: listFrom,
      paidOn: hit.date,
      sourcePiNo: hit.piNo,
    };

    if (hit.prices.size > 1) {
      out.push({
        ...base,
        paidSen: 0,
        deltaSen: 0,
        eligible: false,
        whyNot: `two prices on the same invoice date (${[...hit.prices].join(", ")} sen) — cannot tell which is current`,
      });
      continue;
    }
    const paidSen = [...hit.prices][0];
    let whyNot: string | undefined;
    if (paidSen === listSen) {
      whyNot = "already current";
    } else if (listFrom && hit.date < listFrom) {
      // The list is AHEAD of the evidence: somebody set a price effective later
      // than the newest invoice. Moving it back would undo that decision.
      whyNot = `the list is dated ${listFrom}, newer than the last invoice (${hit.date}) — leaving the newer decision alone`;
    }
    out.push({
      ...base,
      paidSen,
      deltaSen: paidSen - listSen,
      eligible: !whyNot,
      whyNot,
    });
  }
  return out;
}

function summarise(rows: Drift[]) {
  const eligible = rows.filter((r) => r.eligible);
  const byReason: Record<string, number> = {};
  for (const r of rows.filter((x) => !x.eligible)) {
    const k = (r.whyNot ?? "?").replace(/\(.*\)/, "(…)");
    byReason[k] = (byReason[k] ?? 0) + 1;
  }
  return {
    bindingsWithInvoiceHistory: rows.length,
    toUpdate: eligible.length,
    goingUp: eligible.filter((r) => r.deltaSen > 0).length,
    goingDown: eligible.filter((r) => r.deltaSen < 0).length,
    suppliersAffected: new Set(eligible.map((r) => r.supplierId)).size,
    skipped: rows.length - eligible.length,
    skippedByReason: byReason,
  };
}

// ---------------------------------------------------------------------------
// GET /supplier-price-drift — the report. Writes nothing.
// ---------------------------------------------------------------------------
app.get("/supplier-price-drift", async (c) => {
  const denied = await requirePermission(c, "supplier-materials", "read");
  if (denied) return denied;
  const rows = await buildDrift(c.var.DB, getOrgId(c));
  const show = Math.min(500, Math.max(1, Number(c.req.query("samples")) || 100));
  const eligible = rows.filter((r) => r.eligible);
  return c.json({
    success: true,
    summary: summarise(rows),
    changes: eligible.slice(0, show),
    truncated: Math.max(0, eligible.length - show),
  });
});

// ---------------------------------------------------------------------------
// POST /refresh-supplier-price-list?dryRun=false
// ---------------------------------------------------------------------------
app.post("/refresh-supplier-price-list", async (c) => {
  const denied = await requirePermission(c, "supplier-materials", "update");
  if (denied) return denied;
  const dryRun = c.req.query("dryRun") !== "false";
  const rows = await buildDrift(c.var.DB, getOrgId(c));
  const eligible = rows.filter((r) => r.eligible);
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 200));
  const batch = eligible.slice(0, limit);
  const supplierId = (c.req.query("supplierId") || "").trim();
  const scoped = supplierId ? batch.filter((r) => r.supplierId === supplierId) : batch;

  if (dryRun || scoped.length === 0) {
    return c.json({
      success: true,
      dryRun,
      summary: summarise(rows),
      wouldUpdate: scoped,
      remaining: Math.max(0, eligible.length - scoped.length),
    });
  }

  // Self-call the binding's own update path: it appends the append-only
  // price_histories row and stamps the effective date. Two writers for one log
  // is how a Price Change Log stops being auditable.
  const cookie = c.req.header("cookie") ?? "";
  const csrf = c.req.header("x-csrf-token") ?? "";
  const origin = new URL(c.req.url).origin;
  const applied: Array<{ bindingId: string; materialCode: string; ok: boolean; status: number; error?: string }> = [];
  for (const r of scoped) {
    try {
      const res = await fetch(`${origin}/api/supplier-materials/${r.bindingId}`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
        body: JSON.stringify({
          unitPrice: r.paidSen,
          // The supplier's own date, not today's — the price changed when they
          // charged it, not when we caught up with the paperwork.
          effectiveFrom: r.paidOn,
          changedBy: `Price refresh · ${r.sourcePiNo ?? "invoice"}`,
        }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      applied.push({
        bindingId: r.bindingId,
        materialCode: r.materialCode,
        ok: res.ok,
        status: res.status,
        error: res.ok ? undefined : body?.error ?? `HTTP ${res.status}`,
      });
    } catch (err) {
      applied.push({
        bindingId: r.bindingId,
        materialCode: r.materialCode,
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    summary: summarise(rows),
    updated: applied.filter((a) => a.ok).length,
    failed: applied.filter((a) => !a.ok),
    applied,
    remaining: Math.max(0, eligible.length - scoped.length),
  });
});

export default app;
