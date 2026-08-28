// ---------------------------------------------------------------------------
// rounded-price-repair — find, and then repair, the purchase-invoice lines that
// an INTEGER-sen column rounded before 2026-08-28.
//
// Owner: 「你把之前的那个因为三位数、四位数不能填进去的问题，都帮我 backfill
// 回去」.
//
// ## The thing that makes this hard
//
// The rounding happened ON THE WAY IN. RM 0.055 became 6 sen before anything
// was written, so the true price is NOT recoverable from the invoice: the unit
// price says 6, and the line total was recomputed FROM that 6, so the document
// agrees with itself perfectly. Nothing inside the ERP disagrees.
//
// The evidence survives in exactly one place: `scan_queue.raw_json`, the
// scanner's structured reading of the supplier's own PDF. It records
// `unitPrice: 0.055` and `amount: 33.00` as printed. (The PDF bytes are NULLed
// on consume; this JSON is not.)
//
// So this endpoint COPIES the supplier's own number — the owner's standing rule
// for exactly this situation: a repair reads the source's value, it never infers
// one. A line with no surviving scan is REPORTED and left alone, not guessed at.
//
// ## The confidence gate
//
// A scan can misread. Before a line is eligible, the document must agree with
// ITSELF: `qty x unitPrice` must equal the `amount` the scanner read off the
// same row, to within one sen. That is two independently-read numbers on the
// supplier's paper confirming each other. Anything that fails it is reported
// with `whyNot` and never written.
//
//   GET  /api/import/rounded-unit-prices           — the report (read-only)
//   POST /api/import/repair-rounded-unit-prices    — dry-run by default
//
// Hand-typed purchase orders are deliberately out of scope: they never had a
// scan, so the only record of the true price is the paper on the owner's desk.
// The report says how many of those exist rather than pretending otherwise.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../../worker";
import { requirePermission } from "../../lib/rbac";
import { getOrgId } from "../../lib/tenant";
import { roundUnitPriceSen, lineTotalSen } from "../../../lib/unit-price";

const app = new Hono<Env>();

/** A price is "sub-cent" when whole sen cannot express it. */
function isSubCent(rm: number): boolean {
  const sen = rm * 100;
  return Number.isFinite(sen) && Math.abs(sen - Math.round(sen)) > 1e-9;
}

type OcrLine = {
  supplierCode: string | null;
  description: string | null;
  qty: number | null;
  unitPrice: number | null;
  amount: number | null;
};
type OcrDoc = { docNo: string | null; lines: OcrLine[] };

/** raw_json arrives as {docs:[...]} or, on the older sync path, one doc. */
function docsFrom(raw: unknown): OcrDoc[] {
  if (!raw || typeof raw !== "object") return [];
  const env = raw as Record<string, unknown>;
  const list = Array.isArray(env.docs) ? env.docs : [env];
  const out: OcrDoc[] = [];
  for (const d of list) {
    if (!d || typeof d !== "object") continue;
    const doc = d as Record<string, unknown>;
    const lines = Array.isArray(doc.lines) ? doc.lines : [];
    out.push({
      docNo: doc.docNo == null ? null : String(doc.docNo).trim() || null,
      lines: lines.map((l) => {
        const x = (l ?? {}) as Record<string, unknown>;
        const n = (v: unknown) => {
          const num = Number(v);
          return Number.isFinite(num) ? num : null;
        };
        return {
          supplierCode: x.supplierCode == null ? null : String(x.supplierCode).trim() || null,
          description: x.description == null ? null : String(x.description).trim() || null,
          qty: n(x.qty),
          unitPrice: n(x.unitPrice),
          amount: n(x.amount),
        };
      }),
    });
  }
  return out;
}

type Candidate = {
  piId: string;
  piNo: string | null;
  supplierInvoiceNo: string | null;
  supplierName: string | null;
  status: string | null;
  itemId: string;
  material: string | null;
  qty: number;
  storedUnitSen: number;
  storedLineSen: number;
  scannedUnitSen: number;
  scannedLineSen: number;
  deltaSen: number;
  eligible: boolean;
  whyNot?: string;
};

type Plan = {
  candidates: Candidate[];
  scansRead: number;
  scansTruncated: boolean;
  docsWithSubCent: number;
  noInvoiceMatch: string[];
};

async function buildPlan(
  db: D1Database,
  orgId: string,
  scanLimit: number,
): Promise<Plan> {
  // 1. Every scan whose reading survives. `raw_json` outlives the PDF bytes.
  const SCANS = Math.min(2000, Math.max(1, scanLimit));
  const scanRes = await db
    .prepare(
      `SELECT id, raw_json AS "rawJson"
         FROM scan_queue
        WHERE raw_json IS NOT NULL
          AND (org_id = ? OR org_id IS NULL)
        ORDER BY created_at DESC
        LIMIT ${SCANS + 1}`,
    )
    .bind(orgId)
    .all<{ id: string; rawJson: unknown }>();
  const allScans = scanRes.results ?? [];
  const scansTruncated = allScans.length > SCANS;
  const scans = allScans.slice(0, SCANS);

  // 2. Keep only the SUB-CENT lines — the only ones an integer column could
  //    have damaged — keyed by the supplier's own document number.
  const byDocNo = new Map<string, OcrLine[]>();
  let docsWithSubCent = 0;
  for (const s of scans) {
    let raw: unknown = s.rawJson;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        continue;
      }
    }
    for (const doc of docsFrom(raw)) {
      if (!doc.docNo) continue;
      const hits = doc.lines.filter(
        (l) => l.unitPrice != null && isSubCent(l.unitPrice),
      );
      if (hits.length === 0) continue;
      docsWithSubCent++;
      const key = doc.docNo.toUpperCase();
      byDocNo.set(key, [...(byDocNo.get(key) ?? []), ...hits]);
    }
  }
  if (byDocNo.size === 0) {
    return { candidates: [], scansRead: scans.length, scansTruncated, docsWithSubCent, noInvoiceMatch: [] };
  }

  // 3. The invoices those documents became. PAID / PARTIAL_PAID are excluded by
  //    construction — money has changed hands against a document the supplier
  //    holds, and correcting it is a credit note, not an edit.
  const keys = [...byDocNo.keys()];
  const invRes = await db
    .prepare(
      `SELECT id, pi_no AS "piNo", supplier_invoice_no AS "supplierInvoiceNo",
              supplier_name AS "supplierName", status
         FROM purchase_invoices
        WHERE (org_id = ? OR org_id IS NULL)
          AND status IN ('DRAFT','CONFIRMED')
          AND supplier_invoice_no IS NOT NULL
          AND UPPER(supplier_invoice_no) IN (${keys.map(() => "?").join(",")})`,
    )
    .bind(orgId, ...keys)
    .all<{
      id: string;
      piNo: string | null;
      supplierInvoiceNo: string | null;
      supplierName: string | null;
      status: string | null;
    }>();
  const invoices = invRes.results ?? [];
  const matched = new Set(
    invoices.map((i) => String(i.supplierInvoiceNo ?? "").toUpperCase()),
  );
  const noInvoiceMatch = keys.filter((k) => !matched.has(k));
  if (invoices.length === 0) {
    return { candidates: [], scansRead: scans.length, scansTruncated, docsWithSubCent, noInvoiceMatch };
  }

  const invIds = invoices.map((i) => i.id);
  const itemRes = await db
    .prepare(
      `SELECT id, pi_id AS "piId", material_code AS "materialCode",
              material_name AS "materialName", supplier_sku AS "supplierSku",
              qty, unit_price_sen AS "unitPriceSen", line_total_sen AS "lineTotalSen",
              line_type AS "lineType"
         FROM purchase_invoice_items
        WHERE pi_id IN (${invIds.map(() => "?").join(",")})`,
    )
    .bind(...invIds)
    .all<Record<string, unknown>>();
  const itemsByInv = new Map<string, Record<string, unknown>[]>();
  for (const it of itemRes.results ?? []) {
    const k = String(it.piId ?? "");
    itemsByInv.set(k, [...(itemsByInv.get(k) ?? []), it]);
  }

  // 4. Pair each scanned sub-cent line with the invoice line it became.
  const candidates: Candidate[] = [];
  for (const inv of invoices) {
    const scanned = byDocNo.get(String(inv.supplierInvoiceNo ?? "").toUpperCase()) ?? [];
    const items = (itemsByInv.get(inv.id) ?? []).filter(
      (it) => String(it.lineType ?? "STOCKED") === "STOCKED",
    );
    for (const sl of scanned) {
      const qty = Number(sl.qty) || 0;
      const unitRm = Number(sl.unitPrice) || 0;
      if (qty <= 0 || unitRm <= 0) continue;
      const scannedUnitSen = roundUnitPriceSen(unitRm * 100);
      const scannedLineSen = lineTotalSen(qty, scannedUnitSen);

      // Identity: same quantity, and the code/description agrees if either
      // side carries one. If two invoice lines answer to that, the pairing is
      // ambiguous and the line is REFUSED — same rule the July/August backfill
      // settled on after nth-occurrence pairing turned out to be a guess.
      const code = (sl.supplierCode ?? "").toUpperCase();
      const desc = (sl.description ?? "").toUpperCase();
      const hits = items.filter((it) => {
        if (Math.abs((Number(it.qty) || 0) - qty) > 1e-9) return false;
        if (!code && !desc) return true;
        const hay = [
          String(it.materialCode ?? ""),
          String(it.materialName ?? ""),
          String(it.supplierSku ?? ""),
        ]
          .join(" ")
          .toUpperCase();
        return (code && hay.includes(code)) || (desc && hay.includes(desc.slice(0, 12)));
      });

      const base = {
        piId: inv.id,
        piNo: inv.piNo,
        supplierInvoiceNo: inv.supplierInvoiceNo,
        supplierName: inv.supplierName,
        status: inv.status,
        qty,
        scannedUnitSen,
        scannedLineSen,
      };

      if (hits.length !== 1) {
        candidates.push({
          ...base,
          itemId: "",
          material: sl.supplierCode ?? sl.description,
          storedUnitSen: 0,
          storedLineSen: 0,
          deltaSen: 0,
          eligible: false,
          whyNot:
            hits.length === 0
              ? "no invoice line matches this scanned line"
              : `${hits.length} invoice lines match — cannot tell which is which`,
        });
        continue;
      }

      const it = hits[0];
      const storedUnitSen = Number(it.unitPriceSen) || 0;
      const storedLineSen = Number(it.lineTotalSen) || 0;

      // The document must agree with ITSELF before we trust it: qty x unitPrice
      // has to equal the amount the scanner read off the same row.
      const amountRm = sl.amount == null ? null : Number(sl.amount);
      const selfConsistent =
        amountRm != null && Math.abs(Math.round(amountRm * 100) - scannedLineSen) <= 1;

      let whyNot: string | undefined;
      if (!selfConsistent) {
        whyNot =
          amountRm == null
            ? "the scan read no line amount — nothing corroborates the unit price"
            : `the scan disagrees with itself (${qty} x ${unitRm} != ${amountRm})`;
      } else if (storedUnitSen === scannedUnitSen) {
        whyNot = "already correct";
      } else if (Math.abs(storedUnitSen - scannedUnitSen) > 1) {
        // Rounding moves a price by less than one sen. A bigger gap is a
        // different edit — a renegotiated price, a corrected line — and is not
        // this bug's damage.
        whyNot = `stored price differs by more than a rounding (${storedUnitSen} vs ${scannedUnitSen} sen) — not this bug`;
      }

      candidates.push({
        ...base,
        itemId: String(it.id),
        material: String(it.materialCode ?? it.materialName ?? ""),
        storedUnitSen,
        storedLineSen,
        deltaSen: scannedLineSen - storedLineSen,
        eligible: !whyNot,
        whyNot,
      });
    }
  }

  // 5. ONE row per invoice line. The same supplier document is often scanned
  //    more than once — a retry, a re-upload, the cache path — and each of
  //    those readings matches the SAME invoice line. Left as-is the write is
  //    harmless (identical value written twice) but the REPORT double-counts
  //    the money, and the money is the thing being approved: measured on prod
  //    2026-08-28, 9 rows were only 7 lines, and -RM 24.50 was really -RM 14.50.
  //
  //    Two readings that DISAGREE about the same line is a genuine ambiguity,
  //    not a duplicate, so both are refused rather than one being picked.
  const byItem = new Map<string, Candidate[]>();
  const deduped: Candidate[] = [];
  for (const cd of candidates) {
    if (!cd.eligible || !cd.itemId) {
      deduped.push(cd);
      continue;
    }
    byItem.set(cd.itemId, [...(byItem.get(cd.itemId) ?? []), cd]);
  }
  for (const [, group] of byItem) {
    const prices = new Set(group.map((g) => g.scannedUnitSen));
    if (prices.size === 1) {
      deduped.push(group[0]);
      continue;
    }
    for (const g of group) {
      deduped.push({
        ...g,
        eligible: false,
        whyNot: `${prices.size} scans of this document disagree on the price (${[...prices].join(", ")} sen)`,
      });
    }
  }

  return { candidates: deduped, scansRead: scans.length, scansTruncated, docsWithSubCent, noInvoiceMatch };
}

function summarise(plan: Plan) {
  const eligible = plan.candidates.filter((c) => c.eligible);
  const refused = plan.candidates.filter((c) => !c.eligible);
  const byReason: Record<string, number> = {};
  for (const r of refused) byReason[r.whyNot ?? "?"] = (byReason[r.whyNot ?? "?"] ?? 0) + 1;
  return {
    scansRead: plan.scansRead,
    scansTruncated: plan.scansTruncated,
    scannedDocsCarryingSubCentPrices: plan.docsWithSubCent,
    supplierInvoiceNosWithNoUnpaidInvoice: plan.noInvoiceMatch,
    linesToFix: eligible.length,
    invoicesAffected: new Set(eligible.map((c) => c.piId)).size,
    netChangeSen: eligible.reduce((s, c) => s + c.deltaSen, 0),
    refusedLines: refused.length,
    refusedByReason: byReason,
  };
}

// ---------------------------------------------------------------------------
// GET /rounded-unit-prices — the report. Writes nothing, ever.
// ---------------------------------------------------------------------------
app.get("/rounded-unit-prices", async (c) => {
  const denied = await requirePermission(c, "purchase-invoices", "read");
  if (denied) return denied;
  const plan = await buildPlan(
    c.var.DB,
    getOrgId(c),
    Number(c.req.query("scans")) || 500,
  );
  const show = Math.min(200, Math.max(1, Number(c.req.query("samples")) || 50));
  return c.json({
    success: true,
    summary: summarise(plan),
    lines: plan.candidates.slice(0, show),
    truncatedLines: Math.max(0, plan.candidates.length - show),
  });
});

// ---------------------------------------------------------------------------
// POST /repair-rounded-unit-prices?dryRun=false — the write.
//
// Idempotent: a repaired line reports "already correct" on the next run and is
// skipped, so re-running is the resume strategy. Only the LINE moves; the
// invoice header is re-derived from its own lines afterwards so subtotal, tax
// and total cannot drift away from what they sum to.
// ---------------------------------------------------------------------------
app.post("/repair-rounded-unit-prices", async (c) => {
  const denied = await requirePermission(c, "purchase-invoices", "update");
  if (denied) return denied;
  const dryRun = c.req.query("dryRun") !== "false";
  const db = c.var.DB;
  const orgId = getOrgId(c);
  const plan = await buildPlan(db, orgId, Number(c.req.query("scans")) || 500);
  const eligible = plan.candidates.filter((cd) => cd.eligible);
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50));
  const batch = eligible.slice(0, limit);

  if (dryRun || batch.length === 0) {
    return c.json({
      success: true,
      dryRun,
      summary: summarise(plan),
      wouldFix: batch,
      remaining: Math.max(0, eligible.length - batch.length),
    });
  }

  for (const cd of batch) {
    await db
      .prepare(
        `UPDATE purchase_invoice_items
            SET unit_price_sen = ?, line_total_sen = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(cd.scannedUnitSen, cd.scannedLineSen, new Date().toISOString(), cd.itemId)
      .run();
  }

  // Re-derive each touched invoice's header from its OWN lines. Recomputing
  // beats adjusting by a delta: it cannot accumulate an error, and it is
  // correct even if a line was edited by hand between the plan and the write.
  const touched = [...new Set(batch.map((cd) => cd.piId))];
  const restated: Array<{ piId: string; subtotalSen: number; taxSen: number; totalSen: number }> = [];
  for (const piId of touched) {
    const sums = await db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN line_type = 'TAX' THEN 0 ELSE line_total_sen END), 0) AS "subtotalSen",
                COALESCE(SUM(tax_sen), 0) AS "taxSen"
           FROM purchase_invoice_items
          WHERE pi_id = ?`,
      )
      .bind(piId)
      .first<{ subtotalSen: number; taxSen: number }>();
    const subtotalSen = Math.round(Number(sums?.subtotalSen) || 0);
    const taxSen = Math.round(Number(sums?.taxSen) || 0);
    const totalSen = subtotalSen + taxSen;
    await db
      .prepare(
        `UPDATE purchase_invoices
            SET subtotal_sen = ?, tax_sen = ?, amount_sen = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(subtotalSen, taxSen, totalSen, new Date().toISOString(), piId)
      .run();
    restated.push({ piId, subtotalSen, taxSen, totalSen });
  }

  return c.json({
    success: true,
    dryRun: false,
    summary: summarise(plan),
    fixed: batch,
    invoicesRestated: restated,
    remaining: Math.max(0, eligible.length - batch.length),
    note:
      "Ledger legs are NOT rewritten here. Any invoice already posted must be " +
      "re-posted through its own Edit action so the GL restatement runs on the " +
      "hash chain — this endpoint reports which ones (invoicesRestated).",
  });
});

export default app;
