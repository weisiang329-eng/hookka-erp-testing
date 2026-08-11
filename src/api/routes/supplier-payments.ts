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
import {
  computeAlloc,
  piOutstandingSen,
  readBookedSen,
  restateHeadroom,
  groupSupplierPaymentRows,
  latestRestatePostType,
  type RawSupplierPaymentRow,
} from "../../lib/supplier-payment-alloc";
import { looksTechnical } from "../../lib/humanize-error";
import { issueDocNumber } from "../lib/doc-number-service";
import { ensurePartialPaymentColumns } from "../lib/ensure-partial-payment";
import { applyLifecycle, getDocState } from "../lib/document-lifecycle";
import { ensureTfTables, getTfSources, loadTfDraws } from "../lib/trade-finance";
import { clampRepayAlloc, addDays } from "../../lib/trade-finance";
import type { DocState, LifecycleAction } from "../../lib/lifecycle-machine";
import { emitAudit } from "../lib/audit";

const AP_CONTROL = "400-0000"; // Trade Creditors
const FX_GAIN_ACCT = "530-0000"; // GAIN ON FOREIGN EXCHANGE (realised; debit = loss)

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// GET / — list supplier payments grouped by payment_no (newest first).
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const denied = await requirePermission(c, "invoices", "read");
  if (denied) return denied;

  const orgId = getOrgId(c);
  // Join purchase_invoices for the pi_no (cheap LEFT JOIN). BUG-2026-07-01-003:
  // Postgres adapter camelCases every result column (db-pg.ts
  // transform.column.from) regardless of this SQL's snake_case aliases, so a
  // bare `row.payment_no` read was ALWAYS undefined — GET /api/supplier-payments
  // always returned an empty list on Postgres. Fixed per docs/PLAYBOOKS.md P2:
  // dual-key the reads (`r.camelCase ?? r.snake_case`), extracted to
  // groupSupplierPaymentRows so it's unit-testable against the adapter's real
  // (camelCase-only) row shape.
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
            pi.supplier_invoice_no AS supplier_invoice_no,
            dl.state        AS lifecycleState
       FROM supplier_payments sp
       LEFT JOIN purchase_invoices pi ON pi.id = sp.purchase_invoice_id
       LEFT JOIN document_lifecycle dl
              ON dl.sourceType = 'supplier_payment'
             AND dl.sourceId = sp.payment_no
             AND dl.orgId = sp.org_id
      WHERE sp.org_id = ? AND (dl.state IS NULL OR dl.state <> 'DELETED')
        AND COALESCE(sp.method, '') <> 'CREDIT_NOTE'
      ORDER BY sp.date DESC, sp.payment_no DESC, sp.id DESC`,
  )
    .bind(orgId)
    .all<RawSupplierPaymentRow>();

  // Map iteration order (inside groupSupplierPaymentRows) preserves
  // first-seen, which (given the ORDER BY) is already newest-first.
  return c.json({ success: true, data: groupSupplierPaymentRows(res.results ?? []) });
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
  piNo: string | null;
  pi_no: string | null;
  amountSen: number | null;
  amount_sen: number | null;
  paidAmountSen: number | null;
  paid_amount_sen: number | null;
  status: string | null;
  currency: string | null;
  fxRate: number | null;
  fx_rate: number | null;
  supplierId: string | null;
  supplier_id: string | null;
  supplierName: string | null;
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

      // Supplier advance / prepayment: an amount paid that ISN'T allocated to a
      // PI. Booked as a debit to AP control (400-0000) under the supplier, so it
      // shows as a prepaid (negative) balance on the creditor ledger. The owner
      // knocks it off against invoices MANUALLY later — never auto-applied.
      const advanceSen = Math.max(0, Math.round(Number(body.advanceSen) || 0));
      // Trade-finance repayment allocations (owner 2026-08-11) — honoured only
      // when the selected supplier IS a configured TF lender (branch below).
      const tfAllocations: { drawSourceId?: string; paySen?: number }[] = Array.isArray(body.tfAllocations)
        ? body.tfAllocations
        : [];

      if (!supplierId || !payFrom || !date) {
        return c.json(
          { success: false, error: "supplierId, payFrom, and date are required" },
          400,
        );
      }
      if (allocations.length === 0 && advanceSen <= 0 && tfAllocations.length === 0) {
        return c.json(
          { success: false, error: "at least one allocation or an advance amount is required" },
          400,
        );
      }

      // Self-apply the partial-payment schema (migration-7 columns +
      // PARTIAL_PAID status CHECK relax) before any PI read/write — without this
      // the paid_amount_sen write or the PARTIAL_PAID status flip fails on a
      // prod that never ran migration 7 / still has the original 0057 CHECK.
      await ensurePartialPaymentColumns(c.var.DB);

      // 1. Validate payFrom is a postable SBK/SCH bank/cash account — or a
      //    configured trade-finance source (paying from it IS a draw).
      const tfSources = await getTfSources(c.var.DB);
      const isTfSource = tfSources.some((s) => s.accountCode === payFrom);
      const acct = await c.var.DB.prepare(
        "SELECT specialAccountType FROM chart_of_accounts WHERE code = ?",
      )
        .bind(payFrom)
        .first<{ specialAccountType: string | null }>();
      if (
        !acct ||
        (acct.specialAccountType !== "SBK" && acct.specialAccountType !== "SCH" && !isTfSource)
      ) {
        return c.json(
          {
            success: false,
            error: "payFrom must be a bank (SBK), cash (SCH), or trade-finance account",
          },
          400,
        );
      }

      // 1b. Trade-finance REPAYMENT (owner 2026-08-11): the selected supplier
      // IS the lender → this payment pays DOWN the TF liability, allocated to
      // specific draws. GL: DR TF account / CR the chosen bank. The payment
      // stays an ordinary supplier_payment for lifecycle/voucher purposes;
      // method 'TF_REPAYMENT' keeps it out of the advance machinery.
      const lenderCfg = tfSources.find((s) => s.lenderSupplierId === supplierId);
      if (lenderCfg) {
        await ensureTfTables(c.var.DB);
        if (isTfSource) {
          return c.json(
            { success: false, error: "A trade-finance repayment cannot be paid FROM the trade-finance account" },
            400,
          );
        }
        if (tfAllocations.length === 0) {
          return c.json({ success: false, error: "Pick at least one draw to repay" }, 400);
        }
        const { draws } = await loadTfDraws(c.var.DB, lenderCfg);
        const byId = new Map(draws.map((d) => [d.drawSourceId, d] as const));
        let totalTf = 0;
        const cleanAllocs: { drawSourceId: string; paySen: number }[] = [];
        for (const a of tfAllocations) {
          const drawSourceId = String(a.drawSourceId ?? "").trim();
          const paySen = Math.round(Number(a.paySen) || 0);
          if (!drawSourceId || paySen === 0) continue;
          const d = byId.get(drawSourceId);
          if (!d) return c.json({ success: false, error: `Unknown draw ${drawSourceId}` }, 400);
          const chk = clampRepayAlloc(d.outstandingSen, paySen);
          if (!chk.ok) return c.json({ success: false, error: `${drawSourceId}: ${chk.error}` }, 400);
          cleanAllocs.push({ drawSourceId, paySen });
          totalTf += paySen;
        }
        if (totalTf <= 0) return c.json({ success: false, error: "Pick at least one draw to repay" }, 400);
        const tfPayNo = await issueDocNumber(c.var.DB, {
          bankAccountCode: payFrom,
          direction: "out",
          dateIso: date,
        });
        const tfStatements: D1PreparedStatement[] = [];
        tfStatements.push(
          c.var.DB.prepare(
            `INSERT INTO supplier_payments (
               id, paymentNo, supplierId, supplierName, purchaseInvoiceId,
               date, amountSen, bookedSen, foreignSen, payFxRate,
               method, reference, notes, orgId
             ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, 'TF_REPAYMENT', ?, ?, ?)`,
          ).bind(
            `sp-${crypto.randomUUID().slice(0, 8)}`,
            tfPayNo,
            supplierId,
            lenderCfg.lenderName,
            date,
            totalTf,
            totalTf,
            reference ?? "",
            `Trade finance repayment ${tfPayNo}`,
            orgId,
          ),
        );
        for (const a of cleanAllocs) {
          tfStatements.push(
            c.var.DB.prepare(
              `INSERT INTO trade_finance_repay_allocs (id, repay_payment_no, draw_source_id, amount_sen, org_id)
               VALUES (?, ?, ?, ?, ?)`,
            ).bind(`tfa-${crypto.randomUUID().slice(0, 8)}`, tfPayNo, a.drawSourceId, a.paySen, orgId),
          );
        }
        const { statements: tfLegs } = await buildJournalEntryStatements(c.var.DB, orgId, [
          {
            id: `lje-${crypto.randomUUID().slice(0, 12)}`,
            sourceType: "supplier_payment",
            sourceId: tfPayNo,
            legNo: 1,
            accountCode: lenderCfg.accountCode,
            debitSen: totalTf,
            creditSen: 0,
            description: `TF repayment ${tfPayNo} — ${lenderCfg.lenderName}`,
            actorUserId,
            orgId,
          },
          {
            id: `lje-${crypto.randomUUID().slice(0, 12)}`,
            sourceType: "supplier_payment",
            sourceId: tfPayNo,
            legNo: 2,
            accountCode: payFrom,
            debitSen: 0,
            creditSen: totalTf,
            description: `TF repayment ${tfPayNo}`,
            actorUserId,
            orgId,
          },
        ]);
        tfStatements.push(...tfLegs);
        tfStatements.push(bumpSupplierPaymentsRev(c.var.DB));
        await c.var.DB.batch(tfStatements);
        await emitAudit(c, {
          resource: "supplier-payments",
          resourceId: tfPayNo,
          action: "create",
          after: { paymentNo: tfPayNo, payFrom, tfRepayment: true, totalSen: totalTf, allocations: cleanAllocs },
        });
        return c.json({ success: true, data: { paymentNo: tfPayNo, totalBankSen: totalTf } });
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
          (pi.status !== "CONFIRMED" && pi.status !== "APPROVED" && pi.status !== "PARTIAL_PAID")
        ) {
          return c.json(
            {
              success: false,
              error: `PI ${piId} not found or not in a payable status (APPROVED / PARTIAL_PAID)`,
            },
            400,
          );
        }

        const outstandingBookedSen = piOutstandingSen(pi);
        const currency = pi.currency ? String(pi.currency) : "MYR";
        const isForeign = !!pi.currency && currency.toUpperCase() !== "MYR";
        const fxRate = Number(pi.fxRate ?? pi.fx_rate) || 1;

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
            pi.supplierId ?? pi.supplier_id ?? supplierId,
            pi.supplierName ?? pi.supplier_name ?? "",
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

      // 4b. Supplier advance — one unallocated row (no PI). Flows into the GL
      // totals below (DR 400-0000 / CR bank), so it lands on the supplier's
      // creditor ledger as a prepaid (debit) balance to knock off manually later.
      if (advanceSen > 0) {
        const supRow = await c.var.DB
          .prepare("SELECT name FROM suppliers WHERE id = ?")
          .bind(supplierId)
          .first<{ name: string }>();
        statements.push(
          c.var.DB.prepare(
            `INSERT INTO supplier_payments (
               id, paymentNo, supplierId, supplierName, purchaseInvoiceId,
               date, amountSen, bookedSen, foreignSen, payFxRate,
               method, reference, notes, orgId
             ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
          ).bind(
            `sp-${crypto.randomUUID().slice(0, 8)}`,
            payNo,
            supplierId,
            supRow?.name ?? "",
            date,
            advanceSen,
            advanceSen,
            "BANK_TRANSFER",
            reference ?? "",
            `Advance ${payNo}`,
            orgId,
          ),
        );
        totalBooked += advanceSen;
        totalBank += advanceSen;
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
      statements.push(bumpSupplierPaymentsRev(c.var.DB));

      // 7. Execute the whole batch atomically (mirror purchase-invoices.ts).
      await c.var.DB.batch(statements);

      // 7b. Paying from a trade-finance source account IS a draw (owner
      // 2026-08-11) — record its due-date meta. Amounts stay ledger-derived;
      // the aging block's self-heal would recreate this row anyway, so a miss
      // here can never lose money — only a default due date.
      if (isTfSource) {
        const src = tfSources.find((s) => s.accountCode === payFrom);
        if (src) {
          await ensureTfTables(c.var.DB);
          await c.var.DB.prepare(
            `INSERT INTO trade_finance_draws (draw_source_id, account_code, draw_date, due_date, org_id)
             VALUES (?, ?, ?, ?, ?) ON CONFLICT (draw_source_id) DO NOTHING`,
          ).bind(payNo, payFrom, date, addDays(date, src.tenorDays), orgId).run();
        }
      }

      // 8. Audit. This module — the highest-risk money path in the system,
      // where cash leaves the bank to a supplier — had ZERO audit coverage
      // across all seven of its mutating endpoints. `before` is null for a
      // create; `after` is every persisted allocation row under this payNo so
      // the original per-PI split and FX rates stay recoverable.
      const createdRows = await c.var.DB.prepare(
        "SELECT * FROM supplier_payments WHERE paymentNo = ? AND orgId = ?",
      )
        .bind(payNo, orgId)
        .all<RawSupplierPaymentRow>();
      await emitAudit(c, {
        resource: "supplier-payments",
        resourceId: payNo,
        action: "create",
        after: {
          paymentNo: payNo,
          payFrom,
          totalBookedSen: totalBooked,
          totalBankSen: totalBank,
          totalFxSen: totalFx,
          rows: createdRows.results ?? [],
        },
      });

      // 9. Done.
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
// POST /knock-off — manually apply part (or all) of an unapplied supplier
// ADVANCE against an open purchase invoice (owner rule 2026-06-30: "可以，我
// 要手动去knock off啊，不是自动knock off"). The advance's cash already moved
// and its AP-control (400-0000) debit already posted at creation time — this
// is a pure SUBSIDIARY reattribution (which invoice the debit is "for"), so it
// writes NO new GL journal entry: it only (a) reduces the advance row's own
// amount, (b) inserts a new supplier_payments row tying that amount to the
// chosen PI (mirrors the normal allocation row shape exactly, so it shows up
// identically in the creditor ledger / PI history), and (c) bumps the PI's
// paid_amount_sen + status, same as a normal payment allocation.
// ---------------------------------------------------------------------------
app.post("/knock-off", async (c) => {
  const denied = await requirePermission(c, "invoices", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  try {
    const body = (await c.req.json()) as {
      advanceRowId?: unknown;
      purchaseInvoiceId?: unknown;
      amountSen?: unknown;
    };
    const advanceRowId = String(body.advanceRowId ?? "").trim();
    const piId = String(body.purchaseInvoiceId ?? "").trim();
    const amountSen = Math.round(Number(body.amountSen) || 0);
    if (!advanceRowId || !piId) {
      return c.json({ success: false, error: "advanceRowId and purchaseInvoiceId are required" }, 400);
    }
    if (!Number.isFinite(amountSen) || amountSen <= 0) {
      return c.json({ success: false, error: "amountSen must be a positive amount" }, 400);
    }

    await ensurePartialPaymentColumns(c.var.DB);

    const advance = await c.var.DB
      .prepare(
        `SELECT id, paymentNo, supplierId, supplierName, date, amountSen, purchaseInvoiceId
           FROM supplier_payments WHERE id = ? AND orgId = ?`,
      )
      .bind(advanceRowId, orgId)
      .first<{
        id: string; paymentNo: string; supplierId: string; supplierName: string;
        date: string; amountSen: number; purchaseInvoiceId: string | null;
      }>();
    if (!advance) return c.json({ success: false, error: "Advance row not found" }, 404);
    if (advance.purchaseInvoiceId) {
      return c.json({ success: false, error: "This row is already tied to an invoice — not an unapplied advance" }, 400);
    }
    // BUG-2026-07-08-003 family: rows of voided/deleted payments stay in the
    // table (for unvoid) but must never be knocked off — the cash never
    // "exists" while the voucher is inactive.
    const advLc = await c.var.DB
      .prepare(
        `SELECT state FROM document_lifecycle
          WHERE sourceType = 'supplier_payment' AND sourceId = ? AND orgId = ?`,
      )
      .bind(advance.paymentNo, orgId)
      .first<{ state: string }>();
    if (advLc && advLc.state !== "ACTIVE") {
      return c.json(
        { success: false, error: `Payment ${advance.paymentNo} is ${advLc.state} — unvoid it before knocking off its advance` },
        400,
      );
    }
    const remainingAdvanceSen = Number(advance.amountSen) || 0;
    if (amountSen > remainingAdvanceSen) {
      return c.json({ success: false, error: `Amount exceeds the unapplied advance balance (RM ${(remainingAdvanceSen / 100).toFixed(2)})` }, 400);
    }

    const pi = await c.var.DB
      .prepare(
        `SELECT id, pi_no, amount_sen, paid_amount_sen, status, supplier_id, supplier_name
           FROM purchase_invoices WHERE id = ?`,
      )
      .bind(piId)
      .first<{
        id: string; piNo: string | null; pi_no: string | null;
        amountSen: number | null; amount_sen: number | null;
        paidAmountSen: number | null; paid_amount_sen: number | null;
        status: string | null; supplierId: string | null; supplier_id: string | null;
        supplierName: string | null; supplier_name: string | null;
      }>();
    if (!pi || (pi.status !== "CONFIRMED" && pi.status !== "APPROVED" && pi.status !== "PARTIAL_PAID")) {
      return c.json({ success: false, error: "Purchase invoice not found or not in a payable status" }, 400);
    }
    if ((pi.supplierId ?? pi.supplier_id) !== advance.supplierId) {
      return c.json({ success: false, error: "That invoice belongs to a different supplier" }, 400);
    }
    const outstandingSen = piOutstandingSen(pi);
    if (amountSen > outstandingSen) {
      return c.json({ success: false, error: `Amount exceeds the invoice's outstanding balance (RM ${(outstandingSen / 100).toFixed(2)})` }, 400);
    }

    const statements: D1PreparedStatement[] = [
      c.var.DB
        .prepare(`UPDATE supplier_payments SET amountSen = amountSen - ?, bookedSen = bookedSen - ? WHERE id = ?`)
        .bind(amountSen, amountSen, advanceRowId),
      c.var.DB.prepare(
        `INSERT INTO supplier_payments (
           id, paymentNo, supplierId, supplierName, purchaseInvoiceId,
           date, amountSen, bookedSen, foreignSen, payFxRate,
           method, reference, notes, orgId
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      ).bind(
        `sp-${crypto.randomUUID().slice(0, 8)}`,
        advance.paymentNo,
        advance.supplierId,
        advance.supplierName,
        piId,
        advance.date,
        amountSen,
        amountSen,
        "BANK_TRANSFER",
        "",
        `Knock-off from advance ${advance.paymentNo}`,
        orgId,
      ),
      c.var.DB
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
        .bind(amountSen, amountSen, amountSen, piId),
    ];
    statements.push(bumpSupplierPaymentsRev(c.var.DB));
    await c.var.DB.batch(statements);

    // Knock-off reattributes real cash from an unapplied advance to a specific
    // purchase invoice and bumps that PI's paid_amount_sen — the advance row is
    // decremented in place, so nothing else records how much came off it or
    // where it went.
    await emitAudit(c, {
      resource: "supplier-payments",
      resourceId: advance.paymentNo,
      action: "knock-off",
      before: { advance, purchaseInvoice: pi },
      after: {
        advanceRowId,
        remainingAdvanceSen: remainingAdvanceSen - amountSen,
        purchaseInvoiceId: piId,
        piNo: pi.piNo ?? pi.pi_no,
        knockedOffSen: amountSen,
      },
    });

    return c.json({
      success: true,
      data: { remainingAdvanceSen: remainingAdvanceSen - amountSen, piNo: pi.piNo ?? pi.pi_no },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/supplier-payments/knock-off] failed:", msg, err);
    return c.json({ success: false, error: msg || "Internal error applying the advance" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /un-knock — reverse of /knock-off: detach an allocation row from its
// PI so the money returns to "unapplied advance" (owner case 2026-07-09: GVP
// 950 sat allocated to an opening-EXCLUDED PI, so it showed neither as an
// advance nor as a bill — the aging must show the advance again). Pure
// subsidiary reattribution, exactly like knock-off: NO GL legs move (the
// DR 400-0000 · CR bank posted at payment time stays put). The detached row
// itself becomes the advance (purchaseInvoiceId → NULL; its amountSen is
// already the bank amount); the PI's paid_amount_sen is re-derived absolutely
// via the same truth-guard SQL the restate uses.
// ---------------------------------------------------------------------------
app.post("/un-knock", async (c) => {
  const denied = await requirePermission(c, "invoices", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  try {
    const body = (await c.req.json()) as { rowId?: unknown };
    const rowId = String(body.rowId ?? "").trim();
    if (!rowId) return c.json({ success: false, error: "rowId is required" }, 400);

    await ensurePartialPaymentColumns(c.var.DB);

    const row = await c.var.DB
      .prepare(
        `SELECT id, paymentNo, supplierName, purchaseInvoiceId, amountSen, method
           FROM supplier_payments WHERE id = ? AND orgId = ?`,
      )
      .bind(rowId, orgId)
      .first<{
        id: string; paymentNo: string; supplierName: string;
        purchaseInvoiceId: string | null; amountSen: number; method: string | null;
      }>();
    if (!row) return c.json({ success: false, error: "Payment row not found" }, 404);
    if ((row.method ?? "") === "CREDIT_NOTE") {
      return c.json({ success: false, error: "This is a credit-note marker — void the purchase CN instead" }, 400);
    }
    const piId = row.purchaseInvoiceId;
    if (!piId) {
      return c.json({ success: false, error: "This row is already an unapplied advance" }, 400);
    }
    const lc = await c.var.DB
      .prepare(
        `SELECT state FROM document_lifecycle
          WHERE sourceType = 'supplier_payment' AND sourceId = ? AND orgId = ?`,
      )
      .bind(row.paymentNo, orgId)
      .first<{ state: string }>();
    if (lc && lc.state !== "ACTIVE") {
      return c.json({ success: false, error: `Payment ${row.paymentNo} is ${lc.state} — unvoid it first` }, 400);
    }

    await c.var.DB.batch([
      c.var.DB
        .prepare(`UPDATE supplier_payments SET purchaseInvoiceId = NULL WHERE id = ?`)
        .bind(rowId),
      buildPiPaidTruthStatement(c.var.DB, piId),
      bumpSupplierPaymentsRev(c.var.DB),
    ]);
    const pi = await c.var.DB
      .prepare("SELECT pi_no, paid_amount_sen, status FROM purchase_invoices WHERE id = ?")
      .bind(piId)
      .first<{ piNo?: string; pi_no?: string; paidAmountSen?: number; paid_amount_sen?: number; status: string }>();

    // Un-knock detaches cash from a purchase invoice and re-derives that PI's
    // paid_amount_sen absolutely — the link to the invoice is nulled in place,
    // so without `before` there is no record of which PI the money was against.
    await emitAudit(c, {
      resource: "supplier-payments",
      resourceId: row.paymentNo,
      action: "un-knock",
      before: row,
      after: {
        rowId,
        detachedFromPurchaseInvoiceId: piId,
        restoredAdvanceSen: Number(row.amountSen) || 0,
        piPaidSen: Number(pi?.paidAmountSen ?? pi?.paid_amount_sen) || 0,
        piStatus: pi?.status ?? "",
      },
    });
    return c.json({
      success: true,
      data: {
        paymentNo: row.paymentNo,
        restoredAdvanceSen: Number(row.amountSen) || 0,
        piNo: pi?.piNo ?? pi?.pi_no ?? "",
        piPaidSen: Number(pi?.paidAmountSen ?? pi?.paid_amount_sen) || 0,
        piStatus: pi?.status ?? "",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/supplier-payments/un-knock] failed:", msg, err);
    return c.json({ success: false, error: msg || "Internal error detaching the allocation" }, 500);
  }
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
  // Void/unvoid flips PI status to PARTIAL_PAID/APPROVED → ensure the schema
  // (migration-7 columns + relaxed status CHECK) before those writes.
  await ensurePartialPaymentColumns(db);
  const rows =
    (
      await db
        .prepare(
          // Exclude #6 supplier-discount markers (method='CREDIT_NOTE') —
          // they carry a non-zero booked_sen, so a real payment that ever
          // shared this payment_no would double-roll-back the PI. Defensive.
          "SELECT purchaseInvoiceId, booked_sen FROM supplier_payments WHERE payment_no = ? AND COALESCE(method,'') <> 'CREDIT_NOTE'",
        )
        .bind(paymentNo)
        .all<{ purchaseInvoiceId: string | null; bookedSen: number | null; booked_sen: number | null }>()
    ).results ?? [];
  if (rows.length === 0) throw new Error("PAYMENT_NOT_FOUND");

  // Trade-finance guards (owner 2026-08-11):
  //  - a DRAW with repayments allocated cannot leave ACTIVE (the repayments
  //    would point at a dead draw) — void the repayment first;
  //  - a voided REPAYMENT cannot be restored (its allocations were released
  //    at void; re-applying them blind could overpay a since-repaid draw) —
  //    record it again instead.
  await ensureTfTables(db);
  if (action === "void" || action === "delete") {
    const allocSum = await db
      .prepare(`SELECT COALESCE(SUM(amount_sen),0) AS s FROM trade_finance_repay_allocs WHERE draw_source_id = ?`)
      .bind(paymentNo)
      .first<{ s: number | null }>();
    if ((Number(allocSum?.s) || 0) > 0) throw new Error("TF_DRAW_HAS_REPAYMENTS");
  }
  const isTfRepayment = !!(await db
    .prepare(`SELECT 1 AS x FROM supplier_payments WHERE payment_no = ? AND method = 'TF_REPAYMENT' LIMIT 1`)
    .bind(paymentNo)
    .first());
  if (isTfRepayment && action === "unvoid") throw new Error("TF_REPAYMENT_NO_UNVOID");

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
  // An edited (restated) payment's live legs are supplier_payment_restate_post:* —
  // the applyLifecycle exact-match on "supplier_payment" misses them, so hide the
  // whole family on void/delete to keep the GL net at zero.
  if (deactivated) {
    statements.push(
      db
        .prepare(
          `UPDATE ledger_journal_entries SET hidden = 1 WHERE sourceId = ? AND orgId = ? AND sourceType LIKE 'supplier_payment%'`,
        )
        .bind(paymentNo, orgId),
    );
    // Voiding a TF repayment releases its draw allocations in the same batch —
    // the draws' outstanding balances spring back with the GL.
    if (isTfRepayment) {
      statements.push(
        db.prepare(`DELETE FROM trade_finance_repay_allocs WHERE repay_payment_no = ?`).bind(paymentNo),
      );
    }
  }
  if (reactivated) {
    // BUG-2026-07-24-002 (class C5): an EDITED payment's live legs are its
    // newest supplier_payment_restate_post:<stamp> family — applyLifecycle's
    // exact match above just unhid the ORIGINAL (pre-edit) legs instead, so an
    // unvoid after an edit resurrected the STALE pre-edit numbers in the GL
    // while the subledger carried the edited ones. Re-hide the whole family,
    // then unhide the true live set.
    const fams =
      (
        await db
          .prepare(
            `SELECT DISTINCT sourceType FROM ledger_journal_entries WHERE sourceId = ? AND orgId = ? AND sourceType LIKE 'supplier_payment_restate_post:%'`,
          )
          .bind(paymentNo, orgId)
          .all<{ sourceType: string }>()
      ).results ?? [];
    const live = latestRestatePostType(fams.map((f) => String(f.sourceType)));
    if (live) {
      statements.push(
        db
          .prepare(
            `UPDATE ledger_journal_entries SET hidden = 1 WHERE sourceId = ? AND orgId = ? AND sourceType LIKE 'supplier_payment%'`,
          )
          .bind(paymentNo, orgId),
      );
      statements.push(
        db
          .prepare(
            `UPDATE ledger_journal_entries SET hidden = 0 WHERE sourceId = ? AND orgId = ? AND sourceType = ?`,
          )
          .bind(paymentNo, orgId, live),
      );
    }
  }
  if (deactivated || reactivated) {
    for (const row of rows) {
      const piId = row.purchaseInvoiceId;
      if (!piId) continue;
      const bookedSen = readBookedSen(row);
      if (deactivated) {
        // Roll back the PI to its pre-payment paid_amount_sen + status (same
        // SQL the legacy void used).
        statements.push(
          db
            .prepare(
              `UPDATE purchase_invoices
                 SET paid_amount_sen = GREATEST(0, paid_amount_sen - ?),
                     status = CASE
                       WHEN paid_amount_sen - ? <= 0 THEN 'CONFIRMED'
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
  statements.push(bumpSupplierPaymentsRev(db));
  return { statements, newState: lc.newState };
}

// buildSupplierPaymentRestate — in-place EDIT (same voucher number). Rolls the
// old PI paid amounts back, drops the old sub-ledger rows, re-runs the per-PI FX
// allocation (same logic as POST) for the new data, and on the GL reverses the
// live legs + posts the corrected ones (supplier_payment_restate_rev/post:<stamp>),
// then collapses to the newest post. Throws "PAYMENT_NOT_FOUND" / a validation msg.
async function buildSupplierPaymentRestate(
  db: Env["Variables"]["DB"],
  orgId: string,
  paymentNo: string,
  body: { supplierId?: string; payFrom?: string; date?: string; reference?: string; allocations?: CreateAllocation[]; advanceSen?: number },
  actorUserId: string | null,
  stamp: number,
): Promise<D1PreparedStatement[]> {
  // Restate rolls PI paid amounts to PARTIAL_PAID/APPROVED → ensure the schema
  // (migration-7 columns + relaxed status CHECK) before those writes.
  await ensurePartialPaymentColumns(db);
  // A trade-finance repayment cannot be edited in place (v1, owner-approved
  // design 2026-08-11): its draw allocations live outside the payment rows and
  // a restate would rebuild past them — void it and record it again.
  const tfRepayRow = await db
    .prepare(`SELECT 1 AS x FROM supplier_payments WHERE payment_no = ? AND method = 'TF_REPAYMENT' LIMIT 1`)
    .bind(paymentNo)
    .first();
  if (tfRepayRow) {
    throw new Error(
      `Payment ${paymentNo} is a trade-finance repayment — void it and record it again instead of editing.`,
    );
  }
  // Lifecycle guard: restating a VOID/DELETED payment would post live GL legs
  // while every subledger reader excludes the payment's rows (document_lifecycle
  // filter, incl. the truth guard below) — instant control-vs-subledger drift.
  const lcState = await getDocState(db, orgId, "supplier_payment", paymentNo);
  if (lcState !== "ACTIVE") {
    throw new Error(
      lcState === "VOID"
        ? `Payment ${paymentNo} is voided — press Restore first, then edit it.`
        : `Payment ${paymentNo} is deleted — record a new payment instead.`,
    );
  }
  const oldRows =
    (
      await db
        // Exclude #6 supplier-discount markers (method='CREDIT_NOTE') from the
        // rollback set — defensive against a future payment_no collision.
        .prepare("SELECT purchaseInvoiceId, booked_sen, amount_sen, supplierId, supplierName FROM supplier_payments WHERE payment_no = ? AND COALESCE(method,'') <> 'CREDIT_NOTE'")
        .bind(paymentNo)
        .all<{ purchaseInvoiceId: string | null; bookedSen: number | null; booked_sen: number | null; amountSen?: number | null; amount_sen?: number | null; supplierId?: string | null; supplier_id?: string | null; supplierName?: string | null; supplier_name?: string | null }>()
    ).results ?? [];
  if (oldRows.length === 0) throw new Error("PAYMENT_NOT_FOUND");

  // ADVANCE rows (no PI): two modes.
  //  - body.advanceSen ABSENT (legacy callers): rows PRESERVED untouched —
  //    without this a restate silently DROPPED the advance and shrank the GL
  //    bank/control legs (HPV-2607-020: RM 1,619 would have vanished).
  //  - body.advanceSen PRESENT (edit form, owner 2026-07-24): it is the
  //    voucher's unapplied-advance REMAINDER after this edit — the form's
  //    invoice grid doubles as a bulk knock-off workbench, so allocating
  //    invoices shrinks the advance (0 = fully applied). Rows are replaced by
  //    ONE fresh advance row at the new remainder (or none at 0).
  const advTargetSen =
    body.advanceSen === undefined ? null : Math.max(0, Math.round(Number(body.advanceSen) || 0));
  const advanceKeepSen =
    advTargetSen !== null
      ? advTargetSen
      : oldRows
          .filter((r) => !r.purchaseInvoiceId)
          .reduce((s, r) => s + (Number(r.amountSen ?? r.amount_sen) || 0), 0);

  const payFrom = String(body.payFrom ?? "");
  const date = String(body.date ?? "");
  const reference: string | undefined = body.reference;
  const supplierId = String(body.supplierId ?? "");
  const allocations: CreateAllocation[] = Array.isArray(body.allocations) ? body.allocations : [];
  const statements: D1PreparedStatement[] = [];
  // This payment's own bookings are rolled back inside this same batch — the
  // NEW allocations must validate against the PI as it will be AFTER that
  // rollback (restateHeadroom, BUG-2026-07-09-001), or a payment that fully
  // paid its PI could never be edited.
  const oldBookedByPi = new Map<string, number>();
  for (const r of oldRows) {
    if (!r.purchaseInvoiceId) continue;
    const k = String(r.purchaseInvoiceId);
    oldBookedByPi.set(k, (oldBookedByPi.get(k) ?? 0) + readBookedSen(r));
  }

  // 1. Roll the OLD PI paid amounts back.
  for (const r of oldRows) {
    if (!r.purchaseInvoiceId) continue;
    const b = readBookedSen(r);
    statements.push(
      db
        .prepare(
          `UPDATE purchase_invoices SET paid_amount_sen = GREATEST(0, paid_amount_sen - ?),
             status = CASE WHEN paid_amount_sen - ? <= 0 THEN 'CONFIRMED' WHEN paid_amount_sen - ? < amount_sen THEN 'PARTIAL_PAID' ELSE 'PAID' END
           WHERE id = ?`,
        )
        .bind(b, b, b, r.purchaseInvoiceId),
    );
  }
  // 2. Drop the old ALLOCATION rows (never the #6 CREDIT_NOTE markers). The
  // advance rows: replaced when the edit sets a new remainder, preserved
  // (date-following) otherwise.
  statements.push(
    db.prepare("DELETE FROM supplier_payments WHERE payment_no = ? AND COALESCE(method,'') <> 'CREDIT_NOTE' AND purchaseInvoiceId IS NOT NULL").bind(paymentNo),
  );
  if (advTargetSen !== null) {
    statements.push(
      db.prepare("DELETE FROM supplier_payments WHERE payment_no = ? AND COALESCE(method,'') <> 'CREDIT_NOTE' AND purchaseInvoiceId IS NULL").bind(paymentNo),
    );
    if (advTargetSen > 0) {
      const anyRow = oldRows[0] ?? {};
      statements.push(
        db.prepare(
          `INSERT INTO supplier_payments (
             id, paymentNo, supplierId, supplierName, purchaseInvoiceId,
             date, amountSen, bookedSen, foreignSen, payFxRate,
             method, reference, notes, orgId
           ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
        ).bind(
          `sp-${crypto.randomUUID().slice(0, 8)}`,
          paymentNo,
          anyRow.supplierId ?? anyRow.supplier_id ?? supplierId,
          anyRow.supplierName ?? anyRow.supplier_name ?? "",
          date,
          advTargetSen,
          advTargetSen,
          "BANK_TRANSFER",
          reference ?? "",
          `Advance ${paymentNo}`,
          orgId,
        ),
      );
    }
  } else if (advanceKeepSen > 0 && date) {
    // The preserved advance follows the voucher's edited date (aging buckets
    // advances by their payment date — owner rule 2026-07-08).
    statements.push(
      db.prepare("UPDATE supplier_payments SET date = ? WHERE payment_no = ? AND purchaseInvoiceId IS NULL AND COALESCE(method,'') <> 'CREDIT_NOTE'").bind(date, paymentNo),
    );
  }

  // 3. Re-run the per-PI FX allocation for the NEW data (mirrors the POST loop).
  let totalBooked = 0, totalBank = 0, totalFx = 0;
  for (const a of allocations) {
    const piId = String(a.piId ?? "");
    if (!piId) continue;
    const pi = await db
      .prepare(
        `SELECT id, pi_no, amount_sen, paid_amount_sen, status, currency, fx_rate, supplier_id, supplier_name FROM purchase_invoices WHERE id = ?`,
      )
      .bind(piId)
      .first<PiRow>();
    const headroom = pi ? restateHeadroom(pi, oldBookedByPi.get(piId) ?? 0) : null;
    if (!pi || !headroom?.payable) {
      throw new Error(`PI ${piId} not found or not in a payable status (APPROVED / PARTIAL_PAID)`);
    }
    const outstandingBookedSen = headroom.outstandingBookedSen;
    const currency = pi.currency ? String(pi.currency) : "MYR";
    const isForeign = !!pi.currency && currency.toUpperCase() !== "MYR";
    const fxRate = Number(pi.fxRate ?? pi.fx_rate) || 1;
    const r = computeAlloc({
      outstandingBookedSen, isForeign, fxRate,
      payMyrSen: a.payMyrSen, foreignSen: a.foreignSen, payRate: a.payRate, full: !!a.full,
    });
    if (!r.ok) throw new Error(r.error);
    if (r.bookedSen <= 0) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO supplier_payments (
             id, paymentNo, supplierId, supplierName, purchaseInvoiceId,
             date, amountSen, bookedSen, foreignSen, payFxRate, method, reference, notes, orgId
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `sp-${crypto.randomUUID().slice(0, 8)}`, paymentNo, pi.supplierId ?? pi.supplier_id ?? supplierId, pi.supplierName ?? pi.supplier_name ?? "",
          piId, date, r.bankSen, r.bookedSen, isForeign ? (Number(a.foreignSen) || 0) : null,
          isForeign ? (Number(a.payRate) || 0) : null, "BANK_TRANSFER", reference ?? "", `Payment ${paymentNo}`, orgId,
        ),
    );
    statements.push(
      db
        .prepare(
          `UPDATE purchase_invoices SET paid_amount_sen = paid_amount_sen + ?,
             status = CASE WHEN paid_amount_sen + ? >= amount_sen THEN 'PAID' WHEN paid_amount_sen + ? > 0 THEN 'PARTIAL_PAID' ELSE status END
           WHERE id = ?`,
        )
        .bind(r.bookedSen, r.bookedSen, r.bookedSen, piId),
    );
    totalBooked += r.bookedSen;
    totalBank += r.bankSen;
    totalFx += r.fxDiffSen;
  }
  // The preserved advance's remaining amount stays part of the voucher's GL
  // (DR 400-0000 · CR bank), exactly as it was posted at creation.
  totalBooked += advanceKeepSen;
  totalBank += advanceKeepSen;
  if (totalBooked <= 0) throw new Error("no allocations");

  // 4. GL: reverse the live legs + post the corrected legs in ONE call, collapse.
  const cur =
    (
      await db
        .prepare(
          `SELECT accountCode, debitSen, creditSen FROM ledger_journal_entries
            WHERE sourceId = ? AND orgId = ? AND hidden = 0 AND sourceType LIKE 'supplier_payment%'`,
        )
        .bind(paymentNo, orgId)
        .all<{ accountCode: string; debitSen: number; creditSen: number }>()
    ).results ?? [];
  const revLegs = cur.map((l, i) => ({
    id: `lje-${crypto.randomUUID().slice(0, 12)}`,
    sourceType: `supplier_payment_restate_rev:${stamp}`,
    sourceId: paymentNo,
    legNo: i + 1,
    accountCode: l.accountCode,
    debitSen: l.creditSen,
    creditSen: l.debitSen,
    description: `Restate rev · ${paymentNo}`,
    actorUserId,
    orgId,
  }));
  const postSource = `supplier_payment_restate_post:${stamp}`;
  const newLegs: Parameters<typeof buildJournalEntryStatements>[2] = [
    { id: `lje-${crypto.randomUUID().slice(0, 12)}`, sourceType: postSource, sourceId: paymentNo, legNo: 1, accountCode: AP_CONTROL, debitSen: totalBooked, creditSen: 0, description: `Supplier payment ${paymentNo} (edited)`, actorUserId, orgId },
    { id: `lje-${crypto.randomUUID().slice(0, 12)}`, sourceType: postSource, sourceId: paymentNo, legNo: 2, accountCode: payFrom, debitSen: 0, creditSen: totalBank, description: `Supplier payment ${paymentNo} (edited)`, actorUserId, orgId },
  ];
  if (totalFx !== 0) {
    newLegs.push({ id: `lje-${crypto.randomUUID().slice(0, 12)}`, sourceType: postSource, sourceId: paymentNo, legNo: 3, accountCode: FX_GAIN_ACCT, debitSen: totalFx < 0 ? -totalFx : 0, creditSen: totalFx > 0 ? totalFx : 0, description: `Realised FX · ${paymentNo}`, actorUserId, orgId });
  }
  const { statements: jeStmts } = await buildJournalEntryStatements(db, orgId, [...revLegs, ...newLegs]);
  statements.push(...jeStmts);
  statements.push(
    db
      .prepare(
        `UPDATE ledger_journal_entries SET hidden = 1 WHERE sourceId = ? AND orgId = ? AND sourceType LIKE 'supplier_payment%' AND sourceType <> ?`,
      )
      .bind(paymentNo, orgId, postSource),
  );

  // 5. TRUTH GUARD (owner rule 2026-07-08 「确保以后没有这问题」/
  //    BUG-2026-07-08-002: PI-2606-041 showed paid 836 on a 418 bill with
  //    exactly ONE 418 payment row — a restate double-bump). The incremental
  //    ± updates above can silently double-count if any read goes wrong, so
  //    the batch ENDS by re-deriving each touched PI's paid_amount_sen
  //    ABSOLUTELY from its live payment rows (rows of VOIDED/DELETED payments
  //    excluded via document_lifecycle). Statements run in order, so this
  //    final write wins no matter what the arithmetic before it did.
  const touchedPiIds = new Set<string>();
  for (const r of oldRows) if (r.purchaseInvoiceId) touchedPiIds.add(String(r.purchaseInvoiceId));
  for (const a of allocations) if (a.piId) touchedPiIds.add(String(a.piId));
  for (const piId of touchedPiIds) statements.push(buildPiPaidTruthStatement(db, piId));
  statements.push(bumpSupplierPaymentsRev(db));

  return statements;
}

// The aging snapshot's freshness probe rides on tables with an updated_at
// column; supplier_payments has none, and a lifecycle void/unvoid of an
// advance-only payment writes NO probed source table at all — so the cached
// aging kept showing a voided advance forever (BUG-2026-07-09-002). Every
// payment mutation batch therefore bumps this kv row: kv_config IS in the
// aging snapshot's sourceTables (same trick /opening-balance/ap-exclude uses).
function bumpSupplierPaymentsRev(db: Env["Variables"]["DB"]): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO kv_config (key, value, updated_at)
       VALUES ('supplier_payments_rev', ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(Date.now()), new Date().toISOString());
}

// Re-derive ONE PI's paid_amount_sen + status from its live supplier_payments
// rows (CN markers included — they legitimately count as applied; rows of
// non-ACTIVE payments excluded via document_lifecycle). Pure snake_case SQL so
// the adapter passes it through untranslated. Shared by the restate truth
// guard and POST /recompute-pi-paid.
function buildPiPaidTruthStatement(db: Env["Variables"]["DB"], piId: string): D1PreparedStatement {
  const PAID_SQL = `(
    SELECT COALESCE(SUM(sp.booked_sen), 0) FROM supplier_payments sp
     WHERE sp.purchase_invoice_id = purchase_invoices.id
       AND NOT EXISTS (
         SELECT 1 FROM document_lifecycle dl
          WHERE dl.source_type = 'supplier_payment'
            AND dl.source_id = sp.payment_no
            AND dl.state <> 'ACTIVE'
       )
  )`;
  return db
    .prepare(
      `UPDATE purchase_invoices SET
         paid_amount_sen = ${PAID_SQL},
         status = CASE
           WHEN ${PAID_SQL} >= amount_sen THEN 'PAID'
           WHEN ${PAID_SQL} > 0 THEN 'PARTIAL_PAID'
           ELSE (CASE WHEN status IN ('PAID','PARTIAL_PAID') THEN 'CONFIRMED' ELSE status END)
         END
       WHERE id = ?`,
    )
    .bind(piId);
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

    // Pre-state for the audit snapshot — voiding reverses the GL and rolls
    // back paid_amount_sen on every PI this voucher touched, so the allocation
    // rows as they stood are the only basis for reconstructing the reversal.
    const beforeRows = await c.var.DB
      .prepare("SELECT * FROM supplier_payments WHERE paymentNo = ? AND orgId = ?")
      .bind(paymentNo, orgId)
      .all<RawSupplierPaymentRow>();
    const { statements } = await buildSupplierPaymentLifecycle(
      c.var.DB,
      orgId,
      paymentNo,
      "void",
      actorUserId,
    );
    await c.var.DB.batch(statements);
    await emitAudit(c, {
      resource: "supplier-payments",
      resourceId: paymentNo,
      action: "void",
      before: { rows: beforeRows.results ?? [] },
      after: { state: await getDocState(c.var.DB, orgId, "supplier_payment", paymentNo) },
    });
    return c.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "PAYMENT_NOT_FOUND") {
      return c.json(
        { success: false, error: `No supplier payment found for ${paymentNo}` },
        404,
      );
    }
    if (msg === "TF_DRAW_HAS_REPAYMENTS") {
      return c.json(
        { success: false, error: "This payment is a trade-finance draw with repayments allocated to it — void the repayment first." },
        400,
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
    // void/delete roll paid_amount_sen back off every PI this voucher paid;
    // unvoid re-applies it. Either way real AP balances move, and the header
    // comment's claim that delete is "audit-traceable" was not actually true
    // until this emit existed.
    const beforeState = await getDocState(
      c.var.DB,
      orgId,
      "supplier_payment",
      paymentNo,
    );
    const beforeRows = await c.var.DB
      .prepare("SELECT * FROM supplier_payments WHERE paymentNo = ? AND orgId = ?")
      .bind(paymentNo, orgId)
      .all<RawSupplierPaymentRow>();
    const { statements, newState } = await buildSupplierPaymentLifecycle(
      c.var.DB,
      orgId,
      paymentNo,
      action,
      actorUserId,
    );
    await c.var.DB.batch(statements);
    await emitAudit(c, {
      resource: "supplier-payments",
      resourceId: paymentNo,
      action,
      before: { state: beforeState, rows: beforeRows.results ?? [] },
      after: { state: newState },
    });
    return c.json({ success: true, data: { state: newState } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "PAYMENT_NOT_FOUND") {
      return c.json(
        { success: false, error: `No supplier payment found for ${paymentNo}` },
        404,
      );
    }
    if (msg === "TF_DRAW_HAS_REPAYMENTS") {
      return c.json(
        { success: false, error: "This payment is a trade-finance draw with repayments allocated to it — void the repayment first." },
        400,
      );
    }
    if (msg === "TF_REPAYMENT_NO_UNVOID") {
      return c.json(
        { success: false, error: "A voided trade-finance repayment cannot be restored — record it again." },
        400,
      );
    }
    return c.json({ success: false, error: msg }, 400);
  }
});

// Edit a supplier payment IN PLACE — same voucher number; GL reversed +
// re-posted (see buildSupplierPaymentRestate). Body mirrors the POST:
// { supplierId, payFrom, date, reference, allocations }.
// POST /recompute-pi-paid — one-shot repair: re-derive a PI's paid_amount_sen
// from its live payment rows (the same truth-guard SQL the restate now ends
// with). Owner-triggered for corrupted rows (e.g. PI-2606-041, BUG-2026-07-08-002).
app.post("/recompute-pi-paid", async (c) => {
  const denied = await requirePermission(c, "invoices", "update");
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { piId?: string };
  const piId = String(body.piId ?? "").trim();
  if (!piId) return c.json({ success: false, error: "piId is required" }, 400);
  const before = await c.var.DB
    .prepare("SELECT pi_no, amount_sen, paid_amount_sen, status FROM purchase_invoices WHERE id = ?")
    .bind(piId)
    .first<{ pi_no?: string; piNo?: string; amount_sen?: number; amountSen?: number; paid_amount_sen?: number; paidAmountSen?: number; status: string }>();
  if (!before) return c.json({ success: false, error: "PI not found" }, 404);
  await ensurePartialPaymentColumns(c.var.DB);
  await c.var.DB.batch([buildPiPaidTruthStatement(c.var.DB, piId)]);
  const after = await c.var.DB
    .prepare("SELECT paid_amount_sen, status FROM purchase_invoices WHERE id = ?")
    .bind(piId)
    .first<{ paid_amount_sen?: number; paidAmountSen?: number; status: string }>();

  // An owner-triggered repair that overwrites a purchase invoice's
  // paid_amount_sen and status outright. It is exactly the kind of manual
  // correction that must be attributable, and it had no record at all.
  await emitAudit(c, {
    resource: "supplier-payments",
    resourceId: piId,
    action: "recompute-pi-paid",
    before,
    after,
  });
  return c.json({
    success: true,
    data: {
      piNo: before.piNo ?? before.pi_no ?? "",
      beforePaidSen: Number(before.paidAmountSen ?? before.paid_amount_sen) || 0,
      afterPaidSen: Number(after?.paidAmountSen ?? after?.paid_amount_sen) || 0,
      status: after?.status ?? "",
    },
  });
});

app.post("/:paymentNo/restate", async (c) => {
  const denied = await requirePermission(c, "invoices", "update");
  if (denied) return denied;
  const paymentNo = c.req.param("paymentNo");
  let body: {
    supplierId?: string;
    payFrom?: string;
    date?: string;
    reference?: string;
    allocations?: CreateAllocation[];
    advanceSen?: number;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid body" }, 400);
  }
  if (!body.payFrom || !body.date) {
    return c.json({ success: false, error: "payFrom and date are required" }, 400);
  }
  // advanceSen present = the edit sets the voucher's unapplied-advance
  // REMAINDER (0 = fully allocated below). An advance-only voucher is
  // therefore editable with zero allocations (owner 2026-07-24 — before this,
  // such vouchers could only be voided + re-recorded, minting twin PVs).
  const advanceEditSen =
    body.advanceSen === undefined ? undefined : Math.max(0, Math.round(Number(body.advanceSen) || 0));
  if (!Array.isArray(body.allocations)) body.allocations = [];
  if (body.allocations.length === 0 && !(advanceEditSen !== undefined && advanceEditSen > 0)) {
    return c.json({ success: false, error: "at least one allocation (or an advance amount) is required" }, 400);
  }
  const acct = await c.var.DB.prepare(
    "SELECT specialAccountType FROM chart_of_accounts WHERE code = ?",
  )
    .bind(String(body.payFrom))
    .first<{ specialAccountType: string | null }>();
  if (!acct || (acct.specialAccountType !== "SBK" && acct.specialAccountType !== "SCH")) {
    return c.json(
      { success: false, error: "payFrom must be a bank (SBK) or cash (SCH) account" },
      400,
    );
  }
  try {
    const orgId = getOrgId(c);
    const actorUserId =
      (c as unknown as { get: (k: string) => string | undefined }).get(
        "userId",
      ) ?? null;
    const stamp = Date.now();
    // Restate rewrites the voucher IN PLACE under the same PV number: the old
    // allocation rows and GL legs are replaced by new ones. Only a `before`
    // snapshot preserves what the voucher paid, to which invoices, at which
    // FX rate, before the edit.
    const beforeRows = await c.var.DB
      .prepare("SELECT * FROM supplier_payments WHERE paymentNo = ? AND orgId = ?")
      .bind(paymentNo, orgId)
      .all<RawSupplierPaymentRow>();
    const statements = await buildSupplierPaymentRestate(
      c.var.DB,
      orgId,
      paymentNo,
      body,
      actorUserId,
      stamp,
    );
    await c.var.DB.batch(statements);
    const afterRows = await c.var.DB
      .prepare("SELECT * FROM supplier_payments WHERE paymentNo = ? AND orgId = ?")
      .bind(paymentNo, orgId)
      .all<RawSupplierPaymentRow>();
    await emitAudit(c, {
      resource: "supplier-payments",
      resourceId: paymentNo,
      action: "restate",
      before: { rows: beforeRows.results ?? [] },
      after: { rows: afterRows.results ?? [] },
    });
    return c.json({ success: true, data: { paymentNo } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "PAYMENT_NOT_FOUND") {
      return c.json(
        { success: false, error: `No supplier payment found for ${paymentNo}` },
        404,
      );
    }
    if (looksTechnical(msg)) {
      // The operator toast deliberately hides technical text (owner directive
      // 2026-06-08), which made the 2026-07-24 PV-2607-001 edit failure
      // undiagnosable ("Something went wrong" ×2, real reason lost). Persist
      // the raw failure where support can read it back.
      console.error("[supplier-payment restate]", paymentNo, msg);
      try {
        await c.var.DB
          .prepare(
            `INSERT INTO kv_config (key, value, updated_at) VALUES ('last_supplier_restate_error', ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .bind(
            JSON.stringify({ paymentNo, msg: msg.slice(0, 2000), at: new Date().toISOString() }),
            new Date().toISOString(),
          )
          .run();
      } catch {
        /* diagnostic only — never mask the real failure */
      }
      return c.json(
        { success: false, error: "The update couldn't be saved — nothing was changed. The details were logged for support." },
        500,
      );
    }
    return c.json({ success: false, error: msg }, 400);
  }
});

// The raw text of the last failed edit (restate) — written by the catch above.
// Support-facing: the operator toast intentionally shows only a clean line.
app.get("/debug/last-restate-error", async (c) => {
  const denied = await requirePermission(c, "invoices", "read");
  if (denied) return denied;
  const row = await c.var.DB
    .prepare("SELECT value, updated_at FROM kv_config WHERE key = 'last_supplier_restate_error'")
    .first<{ value: string; updated_at: string }>();
  return c.json({ success: true, data: row ?? null });
});

export default app;
