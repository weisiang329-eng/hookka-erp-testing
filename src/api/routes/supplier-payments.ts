// ---------------------------------------------------------------------------
// D1-backed supplier-payments route (Task 5 — the money-critical core).
//
// Pay a supplier's purchase invoices (PIs) with PARTIAL + multi-PI
// allocation, in MYR or foreign currency (FX). Mirrors the customer payment
// route (payments.ts) and the PI Mark-Paid GL leg construction in
// purchase-invoices.ts.
//
// AP (400-0000) is cleared at the PI's BOOKED MYR; the bank pays the ACTUAL
// MYR; the difference posts to realised FX (530-0000). The per-allocation
// math lives in src/lib/supplier-payment-alloc.ts (computeAlloc).
//
// GL on create: DR 400-0000 (Σ booked) · CR bank (Σ bank) · ±530-0000 (Σ FX).
// Since per-alloc bookedSen − bankSen = fxDiffSen, Σbooked = Σbank + ΣfxDiff,
// so the journal always balances.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { readIdempotencyKey, withIdempotency } from "../lib/idempotency";
import {
  buildJournalEntryStatements,
  ledgerHasSource,
} from "../lib/journal-hash";
import { computeAlloc } from "../../lib/supplier-payment-alloc";
import { issueDocNumber } from "../lib/doc-number-service";
import { applyLifecycle } from "../lib/document-lifecycle";
import type { DocState, LifecycleAction } from "../../lib/lifecycle-machine";

const AP_CONTROL = "400-0000"; // Trade Creditors
const FX_GAIN_ACCT = "530-0000"; // GAIN ON FOREIGN EXCHANGE (realised; debit = loss)

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// GET / — list supplier payments grouped by payment_no (newest first).
// ---------------------------------------------------------------------------
type SupplierPaymentRow = {
  id: string;
  payment_no: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  purchase_invoice_id: string | null;
  date: string | null;
  amount_sen: number | null;
  booked_sen: number | null;
};

type PaymentLine = {
  purchaseInvoiceId: string;
  piNo?: string;
  amountSen: number;
  bookedSen: number;
};

type PaymentGroup = {
  paymentNo: string;
  supplierId: string;
  supplierName: string;
  date: string;
  totalBankSen: number;
  totalBookedSen: number;
  lines: PaymentLine[];
  lifecycleState: string;
};

app.get("/", async (c) => {
  const denied = await requirePermission(c, "invoices", "read");
  if (denied) return denied;

  const orgId = getOrgId(c);
  // Join purchase_invoices for the pi_no (cheap LEFT JOIN). Column names are
  // surfaced snake_case by the d1-compat adapter on read.
  const res = await c.var.DB.prepare(
    `SELECT sp.id           AS id,
            sp.payment_no   AS payment_no,
            sp.supplier_id  AS supplier_id,
            sp.supplier_name AS supplier_name,
            sp.purchase_invoice_id AS purchase_invoice_id,
            sp.date         AS date,
            sp.amount_sen   AS amount_sen,
            sp.booked_sen   AS booked_sen,
            pi.pi_no        AS pi_no,
            dl.state        AS lifecycleState
       FROM supplier_payments sp
       LEFT JOIN purchase_invoices pi ON pi.id = sp.purchase_invoice_id
       LEFT JOIN document_lifecycle dl
              ON dl.sourceType = 'supplier_payment'
             AND dl.sourceId = sp.payment_no
             AND dl.orgId = sp.org_id
      WHERE sp.org_id = ? AND (dl.state IS NULL OR dl.state <> 'DELETED')
      ORDER BY sp.date DESC, sp.payment_no DESC, sp.id DESC`,
  )
    .bind(orgId)
    .all<SupplierPaymentRow & { pi_no: string | null; lifecycleState: string | null }>();

  const groups = new Map<string, PaymentGroup>();
  for (const row of res.results ?? []) {
    const payNo = row.payment_no ?? "";
    if (!payNo) continue;
    let g = groups.get(payNo);
    if (!g) {
      g = {
        paymentNo: payNo,
        supplierId: row.supplier_id ?? "",
        supplierName: row.supplier_name ?? "",
        date: row.date ?? "",
        totalBankSen: 0,
        totalBookedSen: 0,
        lines: [],
        lifecycleState: row.lifecycleState ?? "ACTIVE",
      };
      groups.set(payNo, g);
    }
    const amountSen = Number(row.amount_sen) || 0;
    const bookedSen = Number(row.booked_sen) || 0;
    g.totalBankSen += amountSen;
    g.totalBookedSen += bookedSen;
    g.lines.push({
      purchaseInvoiceId: row.purchase_invoice_id ?? "",
      piNo: row.pi_no ?? undefined,
      amountSen,
      bookedSen,
    });
  }

  // Map iteration order preserves first-seen, which (given the ORDER BY) is
  // already newest-first.
  return c.json({ success: true, data: [...groups.values()] });
});

// ---------------------------------------------------------------------------
// POST / — create a supplier payment (partial + multi-PI + FX).
// ---------------------------------------------------------------------------
type CreateAllocation = {
  piId: string;
  payMyrSen?: number;
  foreignSen?: number;
  payRate?: number;
  full?: boolean;
};

type PiRow = {
  id: string;
  pi_no: string | null;
  amount_sen: number | null;
  paid_amount_sen: number | null;
  status: string | null;
  currency: string | null;
  fx_rate: number | null;
  supplier_id: string | null;
  supplier_name: string | null;
};

app.post("/", async (c) => {
  const denied = await requirePermission(c, "invoices", "update");
  if (denied) return denied;

  // Highest-risk money endpoint — wrap in the same idempotency mechanism the
  // customer payment route uses so a duplicate retry returns the cached
  // response instead of double-paying the supplier.
  const idemKey = readIdempotencyKey(c);
  return withIdempotency(c, "supplier-payments", idemKey, async () => {
    try {
      const orgId = getOrgId(c);
      const actorUserId =
        (c as unknown as { get: (k: string) => string | undefined }).get(
          "userId",
        ) ?? null;
      const body = await c.req.json();
      const supplierId = String(body.supplierId ?? "");
      const payFrom = String(body.payFrom ?? "");
      const date = String(body.date ?? "");
      const reference: string | undefined = body.reference;
      const allocations: CreateAllocation[] = Array.isArray(body.allocations)
        ? body.allocations
        : [];

      if (!supplierId || !payFrom || !date) {
        return c.json(
          { success: false, error: "supplierId, payFrom, and date are required" },
          400,
        );
      }
      if (allocations.length === 0) {
        return c.json(
          { success: false, error: "at least one allocation is required" },
          400,
        );
      }

      // 1. Validate payFrom is a postable SBK/SCH bank/cash account.
      const acct = await c.var.DB.prepare(
        "SELECT specialAccountType FROM chart_of_accounts WHERE code = ?",
      )
        .bind(payFrom)
        .first<{ specialAccountType: string | null }>();
      if (
        !acct ||
        (acct.specialAccountType !== "SBK" && acct.specialAccountType !== "SCH")
      ) {
        return c.json(
          {
            success: false,
            error: "payFrom must be a bank (SBK) or cash (SCH) account",
          },
          400,
        );
      }

      // 2. Issue the payment voucher number (one number for the whole batch).
      const payNo = await issueDocNumber(c.var.DB, {
        bankAccountCode: payFrom,
        direction: "out",
        dateIso: date,
      });

      // 3. Accumulate statements + GL totals across all allocations.
      const statements: D1PreparedStatement[] = [];
      let totalBooked = 0;
      let totalBank = 0;
      let totalFx = 0;

      // 4. Per-allocation: fetch PI, compute, push sub-ledger + PI bump.
      for (const a of allocations) {
        const piId = String(a.piId ?? "");
        if (!piId) continue;
        const pi = await c.var.DB.prepare(
          `SELECT id, pi_no, amount_sen, paid_amount_sen, status, currency,
                  fx_rate, supplier_id, supplier_name
             FROM purchase_invoices WHERE id = ?`,
        )
          .bind(piId)
          .first<PiRow>();
        if (
          !pi ||
          (pi.status !== "APPROVED" && pi.status !== "PARTIAL_PAID")
        ) {
          return c.json(
            {
              success: false,
              error: `PI ${piId} not found or not in a payable status (APPROVED / PARTIAL_PAID)`,
            },
            400,
          );
        }

        const outstandingBookedSen =
          (Number(pi.amount_sen) || 0) - (Number(pi.paid_amount_sen) || 0);
        const currency = pi.currency ? String(pi.currency) : "MYR";
        const isForeign = !!pi.currency && currency.toUpperCase() !== "MYR";
        const fxRate = Number(pi.fx_rate) || 1;

        const r = computeAlloc({
          outstandingBookedSen,
          isForeign,
          fxRate,
          payMyrSen: a.payMyrSen,
          foreignSen: a.foreignSen,
          payRate: a.payRate,
          full: !!a.full,
        });
        if (!r.ok) {
          return c.json({ success: false, error: r.error }, 400);
        }

        // Skip empty rows (operator left this PI blank in a multi-PI dialog).
        if (r.bookedSen <= 0) continue;

        const spId = `sp-${crypto.randomUUID().slice(0, 8)}`;
        statements.push(
          c.var.DB.prepare(
            `INSERT INTO supplier_payments (
               id, paymentNo, supplierId, supplierName, purchaseInvoiceId,
               date, amountSen, bookedSen, foreignSen, payFxRate,
               method, reference, notes, orgId
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            spId,
            payNo,
            pi.supplier_id ?? supplierId,
            pi.supplier_name ?? "",
            piId,
            date,
            r.bankSen,
            r.bookedSen,
            isForeign ? (Number(a.foreignSen) || 0) : null,
            isForeign ? (Number(a.payRate) || 0) : null,
            "BANK_TRANSFER",
            reference ?? "",
            `Payment ${payNo}`,
            orgId,
          ),
        );

        statements.push(
          c.var.DB.prepare(
            `UPDATE purchase_invoices
               SET paid_amount_sen = paid_amount_sen + ?,
                   status = CASE
                     WHEN paid_amount_sen + ? >= amount_sen THEN 'PAID'
                     WHEN paid_amount_sen + ? > 0 THEN 'PARTIAL_PAID'
                     ELSE status
                   END
             WHERE id = ?`,
          ).bind(r.bookedSen, r.bookedSen, r.bookedSen, piId),
        );

        totalBooked += r.bookedSen;
        totalBank += r.bankSen;
        totalFx += r.fxDiffSen;
      }

      // 5. Nothing to pay (every allocation resolved to 0).
      if (totalBooked <= 0) {
        return c.json({ success: false, error: "no allocations" }, 400);
      }

      // 6. Build the GL legs — ONE entry group keyed by payNo.
      //    DR 400-0000 (Σ booked) · CR bank (Σ bank) · ±530-0000 (Σ FX).
      //    fxDiff > 0 → paid less → GAIN → credit 530; < 0 → loss → debit 530.
      const legs: Parameters<typeof buildJournalEntryStatements>[2] = [
        {
          id: `lje-${crypto.randomUUID().slice(0, 12)}`,
          sourceType: "supplier_payment",
          sourceId: payNo,
          legNo: 1,
          accountCode: AP_CONTROL,
          debitSen: totalBooked,
          creditSen: 0,
          description: `Supplier payment ${payNo}`,
          actorUserId,
          orgId,
        },
        {
          id: `lje-${crypto.randomUUID().slice(0, 12)}`,
          sourceType: "supplier_payment",
          sourceId: payNo,
          legNo: 2,
          accountCode: payFrom,
          debitSen: 0,
          creditSen: totalBank,
          description: `Supplier payment ${payNo}`,
          actorUserId,
          orgId,
        },
      ];
      if (totalFx !== 0) {
        legs.push({
          id: `lje-${crypto.randomUUID().slice(0, 12)}`,
          sourceType: "supplier_payment",
          sourceId: payNo,
          legNo: 3,
          accountCode: FX_GAIN_ACCT,
          debitSen: totalFx < 0 ? -totalFx : 0,
          creditSen: totalFx > 0 ? totalFx : 0,
          description: `Realised FX · ${payNo}`,
          actorUserId,
          orgId,
        });
      }
      const { statements: ls } = await buildJournalEntryStatements(
        c.var.DB,
        orgId,
        legs,
      );
      statements.push(...ls);

      // 7. Execute the whole batch atomically (mirror purchase-invoices.ts).
      await c.var.DB.batch(statements);

      // 8. Done.
      return c.json({
        success: true,
        data: { paymentNo: payNo, totalBankSen: totalBank },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[POST /api/supplier-payments] failed:", msg, err);
      if (err instanceof SyntaxError) {
        return c.json(
          { success: false, error: "Invalid JSON in request body" },
          400,
        );
      }
      return c.json(
        { success: false, error: msg || "Internal error creating supplier payment" },
        500,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// buildSupplierPaymentLifecycle — shared core for void/delete/unvoid (F3).
// applyLifecycle (GL reversal + hidden flags + document_lifecycle state) plus
// boundary-aware paid_amount_sen on each PI: rolled back when leaving ACTIVE
// (void/delete), re-applied when returning to ACTIVE (unvoid). The
// supplier_payments rows are KEPT (never deleted) so unvoid can re-read the
// booked amounts. Caller batches the returned statements. Throws
// "PAYMENT_NOT_FOUND" when no rows exist for the paymentNo.
// ---------------------------------------------------------------------------
async function buildSupplierPaymentLifecycle(
  db: Env["Variables"]["DB"],
  orgId: string,
  paymentNo: string,
  action: LifecycleAction,
  actorUserId: string | null,
): Promise<{ statements: D1PreparedStatement[]; newState: DocState }> {
  const rows =
    (
      await db
        .prepare(
          "SELECT purchaseInvoiceId, booked_sen FROM supplier_payments WHERE payment_no = ?",
        )
        .bind(paymentNo)
        .all<{ purchaseInvoiceId: string | null; booked_sen: number | null }>()
    ).results ?? [];
  if (rows.length === 0) throw new Error("PAYMENT_NOT_FOUND");

  const lc = await applyLifecycle(db, {
    orgId,
    baseSourceTypes: ["supplier_payment"],
    voidSourceType: "supplier_payment_void",
    sourceId: paymentNo,
    action,
    actorUserId,
    descriptionTag: `${action.toUpperCase()} · ${paymentNo}`,
  });
  const statements: D1PreparedStatement[] = [...lc.statements];

  const deactivated = lc.prevState === "ACTIVE" && lc.newState !== "ACTIVE";
  const reactivated = lc.prevState !== "ACTIVE" && lc.newState === "ACTIVE";
  if (deactivated || reactivated) {
    for (const row of rows) {
      const piId = row.purchaseInvoiceId;
      if (!piId) continue;
      const bookedSen = Number(row.booked_sen) || 0;
      if (deactivated) {
        // Roll back the PI to its pre-payment paid_amount_sen + status (same
        // SQL the legacy void used).
        statements.push(
          db
            .prepare(
              `UPDATE purchase_invoices
                 SET paid_amount_sen = GREATEST(0, paid_amount_sen - ?),
                     status = CASE
                       WHEN paid_amount_sen - ? <= 0 THEN 'APPROVED'
                       WHEN paid_amount_sen - ? < amount_sen THEN 'PARTIAL_PAID'
                       ELSE 'PAID'
                     END
               WHERE id = ?`,
            )
            .bind(bookedSen, bookedSen, bookedSen, piId),
        );
      } else {
        // Re-apply the booked amount (mirrors the create-apply SQL).
        statements.push(
          db
            .prepare(
              `UPDATE purchase_invoices
                 SET paid_amount_sen = paid_amount_sen + ?,
                     status = CASE
                       WHEN paid_amount_sen + ? >= amount_sen THEN 'PAID'
                       WHEN paid_amount_sen + ? > 0 THEN 'PARTIAL_PAID'
                       ELSE status
                     END
               WHERE id = ?`,
            )
            .bind(bookedSen, bookedSen, bookedSen, piId),
        );
      }
    }
  }
  return { statements, newState: lc.newState };
}

// ---------------------------------------------------------------------------
// POST /:paymentNo/void — reverse a supplier payment (legacy alias for the
// lifecycle "void"). Idempotent; soft (rows kept), paid_amount_sen rolled back.
// ---------------------------------------------------------------------------
app.post("/:paymentNo/void", async (c) => {
  const denied = await requirePermission(c, "invoices", "update");
  if (denied) return denied;

  const paymentNo = c.req.param("paymentNo");
  try {
    const orgId = getOrgId(c);
    const actorUserId =
      (c as unknown as { get: (k: string) => string | undefined }).get(
        "userId",
      ) ?? null;

    // Idempotency guard — already voided?
    if (await ledgerHasSource(c.var.DB, orgId, "supplier_payment_void", paymentNo)) {
      return c.json({ success: true, data: { alreadyVoided: true } });
    }

    const { statements } = await buildSupplierPaymentLifecycle(
      c.var.DB,
      orgId,
      paymentNo,
      "void",
      actorUserId,
    );
    await c.var.DB.batch(statements);
    return c.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "PAYMENT_NOT_FOUND") {
      return c.json(
        { success: false, error: `No supplier payment found for ${paymentNo}` },
        404,
      );
    }
    console.error("[POST /api/supplier-payments/:paymentNo/void] failed:", msg, err);
    return c.json(
      { success: false, error: msg || "Internal error voiding supplier payment" },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// POST /:paymentNo/lifecycle — unified void / delete / unvoid (F3).
//   void   = visible reversal (stays in GL, paid_amount_sen rolled back)
//   delete = hidden from GL (paid_amount_sen rolled back; audit-traceable)
//   unvoid = restore (paid_amount_sen re-applied)
// ---------------------------------------------------------------------------
app.post("/:paymentNo/lifecycle", async (c) => {
  const denied = await requirePermission(c, "invoices", "update");
  if (denied) return denied;

  const paymentNo = c.req.param("paymentNo");
  let action: LifecycleAction;
  try {
    action = ((await c.req.json()) as { action: string })
      .action as LifecycleAction;
  } catch {
    return c.json({ success: false, error: "Invalid body" }, 400);
  }
  if (!["void", "delete", "unvoid"].includes(action)) {
    return c.json(
      { success: false, error: "action must be void|delete|unvoid" },
      400,
    );
  }

  try {
    const orgId = getOrgId(c);
    const actorUserId =
      (c as unknown as { get: (k: string) => string | undefined }).get(
        "userId",
      ) ?? null;
    const { statements, newState } = await buildSupplierPaymentLifecycle(
      c.var.DB,
      orgId,
      paymentNo,
      action,
      actorUserId,
    );
    await c.var.DB.batch(statements);
    return c.json({ success: true, data: { state: newState } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "PAYMENT_NOT_FOUND") {
      return c.json(
        { success: false, error: `No supplier payment found for ${paymentNo}` },
        404,
      );
    }
    return c.json({ success: false, error: msg }, 400);
  }
});

export default app;
