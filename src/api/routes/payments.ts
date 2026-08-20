// ---------------------------------------------------------------------------
// D1-backed payments route.
//
// Mirrors the old src/api/routes/payments.ts response shape so the SPA
// frontend doesn't need any changes. Payment "allocations" are stored as a
// JSON TEXT column on payment_records (per the schema). When a payment is
// created with allocations, we also insert an invoice_payments row per
// allocation and bump the target invoice's paidAmount/status — identical
// semantics to the old impl.
//
// Phase-3 scope: full CRUD + status transitions (RECEIVED → CLEARED/BOUNCED)
// with the BOUNCED rollback of invoice payments.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { emitAudit } from "../lib/audit";
import { previewCascadeSOClosed } from "./invoices";
import { readIdempotencyKey, withIdempotency } from "../lib/idempotency";
import {
  buildJournalEntryStatements,
  ledgerHasSource,
} from "../lib/journal-hash";
import { applyLifecycle } from "../lib/document-lifecycle";
import type { DocState, LifecycleAction } from "../../lib/lifecycle-machine";
import { parseDebtorCode } from "../../lib/debtor";
import { issueDocNumber } from "../lib/doc-number-service";

// Cash/bank account by payment method (CASH → cash-in-hand, else bank).
function bankAcct(method: string | null | undefined): string {
  return String(method ?? "").toUpperCase() === "CASH"
    ? "320-0000"
    : "310-0010";
}

const app = new Hono<Env>();

type PaymentRow = {
  id: string;
  receiptNumber: string;
  customerId: string;
  customerName: string;
  date: string;
  amount: number;
  method: string | null;
  reference: string | null;
  status: string | null;
  allocations: string | null;
};

type Allocation = { invoiceId: string; invoiceNumber: string; amount: number; invoiceDate?: string };

const VALID_TRANSITIONS: Record<string, string[]> = {
  RECEIVED: ["CLEARED", "BOUNCED"],
  CLEARED: [],
  BOUNCED: [],
};

// The aging snapshot probes kv_config, NOT payment_records — so a payment
// mutation that only rewrites payment_records (and bumps invoice paidAmount
// without touching updated_at) leaves the snapshot serving the old numbers
// until some unrelated write lands. The supplier side learned this on
// 2026-07-09 (BUG-2026-07-09-002, voiding an advance) and got
// bumpSupplierPaymentsRev; the customer side had the SAME hole — the owner
// re-allocated two receipts on 2026-08-06 and the Carress aging kept reading
// 140,473.32 when every live figure said 126,055.32. Same class, same cure.
function bumpPaymentRecordsRev(db: Env["Variables"]["DB"]): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO kv_config (key, value, updated_at)
       VALUES ('payment_records_rev', ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(Date.now()), new Date().toISOString());
}

// buildCustomerPaymentLifecycle — void/delete/unvoid core (mirrors the supplier
// one). applyLifecycle reverses the GL legs + sets hidden + records the
// document_lifecycle state; on leaving/returning to ACTIVE we also roll the
// paid invoices' paidAmount/status back/forward and adjust the customer's
// outstanding A/R. Per the owner's scope decision, the linked sales-order
// status is intentionally NOT touched — a void only reverses the receipt's own
// effects. The payment_records / invoice_payments rows are kept so unvoid can
// re-read them. Throws "PAYMENT_NOT_FOUND".
async function buildCustomerPaymentLifecycle(
  db: Env["Variables"]["DB"],
  orgId: string,
  id: string,
  action: LifecycleAction,
  actorUserId: string | null,
): Promise<{ statements: D1PreparedStatement[]; newState: DocState }> {
  const existing = await db
    .prepare("SELECT * FROM payment_records WHERE id = ?")
    .bind(id)
    .first<PaymentRow>();
  if (!existing) throw new Error("PAYMENT_NOT_FOUND");
  const allocs = parseAllocations(existing.allocations);

  const lc = await applyLifecycle(db, {
    orgId,
    baseSourceTypes: ["payment"],
    voidSourceType: "payment_void",
    sourceId: id,
    action,
    actorUserId,
    descriptionTag: `${action.toUpperCase()} · ${existing.receiptNumber ?? id}`,
  });
  const statements: D1PreparedStatement[] = [...lc.statements];

  const deactivated = lc.prevState === "ACTIVE" && lc.newState !== "ACTIVE";
  const reactivated = lc.prevState !== "ACTIVE" && lc.newState === "ACTIVE";
  // If the receipt was edited (restated), its live legs are
  // payment_restate_post:* — which the applyLifecycle exact-match on "payment"
  // doesn't cover. Hide the whole payment family on void/delete so the GL nets
  // to zero regardless of how many times it was edited.
  if (deactivated) {
    statements.push(
      db
        .prepare(
          `UPDATE ledger_journal_entries SET hidden = 1 WHERE sourceId = ? AND orgId = ? AND sourceType LIKE 'payment%'`,
        )
        .bind(id, orgId),
    );
  }
  if (deactivated || reactivated) {
    let totalAllocSen = 0;
    for (const a of allocs) {
      if (!a.invoiceId || !a.amount) continue;
      totalAllocSen += a.amount;
      if (deactivated) {
        statements.push(
          db
            .prepare(
              `UPDATE invoices
                 SET paidAmount = GREATEST(0, paidAmount - ?),
                     status = CASE
                       WHEN paidAmount - ? <= 0 THEN 'SENT'
                       WHEN paidAmount - ? < totalSen THEN 'PARTIAL_PAID'
                       ELSE 'PAID'
                     END
               WHERE id = ?`,
            )
            .bind(a.amount, a.amount, a.amount, a.invoiceId),
        );
      } else {
        statements.push(
          db
            .prepare(
              `UPDATE invoices
                 SET paidAmount = paidAmount + ?,
                     status = CASE
                       WHEN paidAmount + ? >= totalSen THEN 'PAID'
                       WHEN paidAmount + ? > 0 THEN 'PARTIAL_PAID'
                       ELSE status
                     END
               WHERE id = ?`,
            )
            .bind(a.amount, a.amount, a.amount, a.invoiceId),
        );
      }
    }
    if (totalAllocSen > 0 && existing.customerId) {
      statements.push(
        db
          .prepare(
            deactivated
              ? `UPDATE customers SET outstandingSen = outstandingSen + ? WHERE id = ?`
              : `UPDATE customers SET outstandingSen = GREATEST(0, outstandingSen - ?) WHERE id = ?`,
          )
          .bind(totalAllocSen, existing.customerId),
      );
    }
  }
  return { statements, newState: lc.newState };
}

// buildCustomerPaymentRestate — in-place EDIT. Keeps the same receipt row and
// number; reverses the currently-posted GL legs and re-posts the corrected ones
// (timestamped restate_rev/restate_post sourceTypes, then collapse so only the
// newest post stays visible — the invoice-restate pattern). Rolls the old
// allocations off the invoices / customer A/R and applies the new ones.
// Throws "PAYMENT_NOT_FOUND".
async function buildCustomerPaymentRestate(
  db: Env["Variables"]["DB"],
  orgId: string,
  id: string,
  body: {
    method?: string | null;
    reference?: string | null;
    bankAccount?: string;
    date?: string | null;
    allocations?: Allocation[];
    // What actually landed in the bank. Independent of the allocations since
    // 2026-08-06: a receipt may knock off less than it is worth, and the rest
    // sits on account as a customer advance. Older clients omit it and keep
    // the previous behaviour (receipt total = what was allocated).
    amountSen?: number;
  },
  actorUserId: string | null,
  stamp: number,
): Promise<D1PreparedStatement[]> {
  const existing = await db
    .prepare("SELECT * FROM payment_records WHERE id = ?")
    .bind(id)
    .first<PaymentRow>();
  if (!existing) throw new Error("PAYMENT_NOT_FOUND");
  const oldAllocs = parseAllocations(existing.allocations);
  const newAllocs = (body.allocations ?? []).filter(
    (a) => a.invoiceId && a.amount > 0,
  );
  // Resolve each allocation's invoice NUMBER here rather than trusting the
  // client to send it — the form sends {invoiceId, amount} only, so every
  // edited receipt stored its lines against a blank number and the detail
  // panel listed amounts against nothing (owner 2026-08-06: 「分配记录我要看
  //到」). The create path already resolves it the same way.
  if (newAllocs.length > 0) {
    const ids = [...new Set(newAllocs.map((a) => a.invoiceId))];
    const res = await db
      .prepare(`SELECT id, invoiceNo FROM invoices WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all<{ id: string; invoiceNo: string }>();
    const byId = new Map((res.results ?? []).map((r) => [r.id, r.invoiceNo] as const));
    for (const a of newAllocs) a.invoiceNumber = a.invoiceNumber || byId.get(a.invoiceId) || "";
  }
  const statements: D1PreparedStatement[] = [];

  // 1. Roll the OLD allocations off their invoices.
  let oldTotal = 0;
  for (const a of oldAllocs) {
    if (!a.invoiceId || !a.amount) continue;
    oldTotal += a.amount;
    statements.push(
      db
        .prepare(
          `UPDATE invoices SET paidAmount = GREATEST(0, paidAmount - ?),
             status = CASE
               WHEN paidAmount - ? <= 0 THEN 'SENT'
               WHEN paidAmount - ? < totalSen THEN 'PARTIAL_PAID'
               ELSE 'PAID'
             END
           WHERE id = ?`,
        )
        .bind(a.amount, a.amount, a.amount, a.invoiceId),
    );
  }
  // 2. Apply the NEW allocations.
  let newTotal = 0;
  for (const a of newAllocs) {
    newTotal += a.amount;
    statements.push(
      db
        .prepare(
          `UPDATE invoices SET paidAmount = paidAmount + ?,
             status = CASE
               WHEN paidAmount + ? >= totalSen THEN 'PAID'
               WHEN paidAmount + ? > 0 THEN 'PARTIAL_PAID'
               ELSE 'SENT'
             END
           WHERE id = ?`,
        )
        .bind(a.amount, a.amount, a.amount, a.invoiceId),
    );
  }
  // 3. Net the customer A/R (reverse old, apply new).
  if (existing.customerId && oldTotal !== newTotal) {
    const delta = oldTotal - newTotal;
    statements.push(
      delta > 0
        ? db
            .prepare(
              `UPDATE customers SET outstandingSen = outstandingSen + ? WHERE id = ?`,
            )
            .bind(delta, existing.customerId)
        : db
            .prepare(
              `UPDATE customers SET outstandingSen = GREATEST(0, outstandingSen - ?) WHERE id = ?`,
            )
            .bind(-delta, existing.customerId),
    );
  }

  // What the bank received. The GL and the receipt row follow THIS; the invoice
  // bumps and the customer counter above follow the ALLOCATIONS. When the two
  // differ, the gap is money on account — the debtor control is credited in
  // full (so the customer's balance goes into credit, exactly as an unapplied
  // supplier advance sits on 400-0000) while no invoice is marked paid for it.
  const newAmount = Math.max(0, Math.round(Number(body.amountSen ?? newTotal) || 0));
  if (newAmount < newTotal) {
    // Allocating more than was received would credit the invoices with money
    // that never arrived.
    throw new Error("ALLOCATIONS_EXCEED_AMOUNT");
  }

  // 4. GL: reverse the currently-visible payment legs + post the corrected
  //    legs in ONE buildJournalEntryStatements call (so rev + post chain off the
  //    same head), then collapse so only this restate_post stays visible.
  const cur =
    (
      await db
        .prepare(
          `SELECT accountCode, debitSen, creditSen FROM ledger_journal_entries
            WHERE sourceId = ? AND orgId = ? AND hidden = 0 AND sourceType LIKE 'payment%'`,
        )
        .bind(id, orgId)
        .all<{ accountCode: string; debitSen: number; creditSen: number }>()
    ).results ?? [];
  const revLegs = cur.map((l, i) => ({
    id: `lje-${crypto.randomUUID().slice(0, 12)}`,
    sourceType: `payment_restate_rev:${stamp}`,
    sourceId: id,
    legNo: i + 1,
    accountCode: l.accountCode,
    debitSen: l.creditSen,
    creditSen: l.debitSen,
    description: `Restate rev · ${existing.receiptNumber}`,
    actorUserId,
    orgId,
  }));
  const customer = await db
    .prepare("SELECT code FROM customers WHERE id = ?")
    .bind(existing.customerId)
    .first<{ code: string | null }>();
  const ctl = parseDebtorCode(customer?.code ?? null);
  const controlCode = ctl.ok ? ctl.controlCode : "300-0000";
  const depositAcct = body.bankAccount || bankAcct(body.method);
  const postLegs =
    newAmount > 0
      ? [
          {
            id: `lje-${crypto.randomUUID().slice(0, 12)}`,
            sourceType: `payment_restate_post:${stamp}`,
            sourceId: id,
            legNo: 1,
            accountCode: depositAcct,
            debitSen: newAmount,
            creditSen: 0,
            description: `Receipt ${existing.receiptNumber} (edited)`,
            actorUserId,
            orgId,
          },
          {
            id: `lje-${crypto.randomUUID().slice(0, 12)}`,
            sourceType: `payment_restate_post:${stamp}`,
            sourceId: id,
            legNo: 2,
            accountCode: controlCode,
            debitSen: 0,
            creditSen: newAmount,
            description: `Receipt ${existing.receiptNumber} (edited)`,
            actorUserId,
            orgId,
          },
        ]
      : [];
  const { statements: jeStmts } = await buildJournalEntryStatements(db, orgId, [
    ...revLegs,
    ...postLegs,
  ]);
  statements.push(...jeStmts);
  statements.push(
    db
      .prepare(
        `UPDATE ledger_journal_entries SET hidden = 1 WHERE sourceId = ? AND orgId = ? AND sourceType LIKE 'payment%' AND sourceType <> ?`,
      )
      .bind(id, orgId, `payment_restate_post:${stamp}`),
  );

  // 5. Update the receipt row in place (same id + receiptNumber). The document
  //    date is editable too (owner 2026-07-07) — the GL month follows it via
  //    the doc-date family (payment_records.date), no leg rewrite needed.
  const restateDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date ?? "").trim())
    ? String(body.date).trim()
    : existing.date;
  statements.push(
    db
      .prepare(
        `UPDATE payment_records SET amount = ?, method = ?, reference = ?, allocations = ?, date = ? WHERE id = ?`,
      )
      .bind(
        newAmount,
        body.method ?? existing.method,
        body.reference ?? existing.reference,
        JSON.stringify(newAllocs),
        restateDate,
        id,
      ),
  );

  return statements;
}

function parseAllocations(raw: string | null): Allocation[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((a: Record<string, unknown>) => ({
      invoiceId: (a.invoiceId as string) || "",
      invoiceNumber: (a.invoiceNumber as string) || "",
      amount: Number(a.amount) || 0,
    }));
  } catch {
    return [];
  }
}

function rowToPayment(row: PaymentRow) {
  return {
    id: row.id,
    receiptNumber: row.receiptNumber,
    customerId: row.customerId,
    customerName: row.customerName,
    date: row.date,
    amount: row.amount,
    method: row.method ?? "BANK_TRANSFER",
    reference: row.reference ?? "",
    allocations: parseAllocations(row.allocations),
    status: row.status ?? "RECEIVED",
  };
}

// Fill in each allocation's invoice NUMBER and DATE from the invoice itself.
//
// Owner 2026-08-06: 「分配记录我要看到」. Every allocation an EDIT had written
// carried an empty number — the create path resolves it, the restate path took
// whatever the client sent, and the client sends only {invoiceId, amount}. So a
// receipt that had ever been edited listed amounts against nothing, and
// reconciling it against the customer's statement meant matching by amount.
//
// Resolving on READ repairs the receipts already stored, not just the next one.
// The DATE comes from here too (owner 2026-08-06: 「这边也显示日期」) — an
// allocation stores only an id and an amount, and the date is what makes a
// receipt readable against a statement, which lists documents by date.
async function fillAllocationNumbers<T extends { allocations: Allocation[] }>(
  db: Env["Variables"]["DB"],
  rows: T[],
): Promise<T[]> {
  const wanted = [
    ...new Set(
      rows.flatMap((r) =>
        r.allocations.filter((a) => a.invoiceId && (!a.invoiceNumber || !a.invoiceDate)).map((a) => a.invoiceId),
      ),
    ),
  ];
  if (wanted.length === 0) return rows;
  const byId = new Map<string, { no: string; date: string }>();
  // Chunked: a receipt can carry dozens of lines and SQLite caps bound params.
  for (let i = 0; i < wanted.length; i += 100) {
    const slice = wanted.slice(i, i + 100);
    const res = await db
      .prepare(
        `SELECT id, invoiceNo, invoiceDate FROM invoices WHERE id IN (${slice.map(() => "?").join(",")})`,
      )
      .bind(...slice)
      .all<{ id: string; invoiceNo: string; invoiceDate: string | null }>();
    for (const r of res.results ?? []) {
      byId.set(r.id, { no: r.invoiceNo, date: String(r.invoiceDate ?? "").slice(0, 10) });
    }
  }
  for (const r of rows) {
    for (const a of r.allocations) {
      const hit = byId.get(a.invoiceId);
      if (!a.invoiceNumber) a.invoiceNumber = hit?.no ?? "";
      if (!a.invoiceDate) a.invoiceDate = hit?.date ?? "";
    }
    // Oldest first, matching the knock-off list the operator worked down.
    r.allocations.sort(
      (a, b) =>
        String(a.invoiceDate ?? "").localeCompare(String(b.invoiceDate ?? "")) ||
        String(a.invoiceNumber ?? "").localeCompare(String(b.invoiceNumber ?? "")),
    );
  }
  return rows;
}

function genPaymentId(): string {
  return `pay-${crypto.randomUUID().slice(0, 8)}`;
}

function genInvoicePaymentId(): string {
  return `invpay-${crypto.randomUUID().slice(0, 8)}`;
}


function genStatusChangeId(): string {
  return `sc-${crypto.randomUUID().slice(0, 8)}`;
}

// GET /api/payments — list all (optional ?customerId= / ?invoiceId= filters)
app.get("/", async (c) => {
  // RBAC gate (P3.3-followup) — payments:read.
  const denied = await requirePermission(c, "payments", "read");
  if (denied) return denied;
  const customerId = c.req.query("customerId");
  const invoiceId = c.req.query("invoiceId");

  const orgId = getOrgId(c);
  const where: string[] = ["orgId = ?"];
  const params: unknown[] = [orgId];
  if (customerId) {
    where.push("customerId = ?");
    params.push(customerId);
  }
  // invoiceId filter is a JSON LIKE since allocations is stored as JSON TEXT.
  // It's a rough match (substring on invoiceId) — good enough for a list view
  // and avoids exploding the schema at this phase.
  if (invoiceId) {
    where.push("allocations LIKE ?");
    params.push(`%"invoiceId":"${invoiceId}"%`);
  }
  const clause = `WHERE ${where.join(" AND ")}`;

  const res = await c.var.DB.prepare(
    `SELECT * FROM payment_records ${clause} ORDER BY date DESC, id DESC`,
  )
    .bind(...params)
    .all<PaymentRow>();

  const rows = res.results ?? [];
  // Attach lifecycle state (ACTIVE unless void/deleted) so the list can dim
  // voided receipts and drop them from the active totals.
  const lcMap = new Map<string, string>();
  if (rows.length > 0) {
    const ph = rows.map(() => "?").join(",");
    const lcRes = await c.var.DB.prepare(
      `SELECT sourceId, state FROM document_lifecycle WHERE sourceType = 'payment' AND orgId = ? AND sourceId IN (${ph})`,
    )
      .bind(orgId, ...rows.map((r) => r.id))
      .all<{ sourceId: string; state: string }>();
    for (const r of lcRes.results ?? []) lcMap.set(r.sourceId, r.state);
  }
  const data = await fillAllocationNumbers(
    c.var.DB,
    rows.map((r) => ({
      ...rowToPayment(r),
      lifecycleState: lcMap.get(r.id) ?? "ACTIVE",
    })),
  );
  return c.json({ success: true, data, total: data.length });
});

// POST /api/payments — create. If allocations reference invoices, also inserts
// matching invoice_payments rows and bumps the invoice paidAmount/status.
app.post("/", async (c) => {
  // RBAC gate (P3.3) — only roles with payments:create may record payments.
  const denied = await requirePermission(c, "payments", "create");
  if (denied) return denied;

  // Sprint 3 #4 — idempotency. Payment recording is the highest-risk
  // money endpoint: a duplicate retry double-collects from the customer
  // (in the books) and over-credits the AR balance. Wrap so a duplicate
  // retry returns the cached response instead of writing a second
  // payment_records row + invoice_payments rows + paid bumps.
  const idemKey = readIdempotencyKey(c);
  return withIdempotency(c, "payments", idemKey, async () => {
  try {
    const body = await c.req.json();
    const { customerId, amount, method, reference, allocations } = body;
    if (!customerId || amount === undefined || !method) {
      return c.json(
        { success: false, error: "customerId, amount, and method are required" },
        400,
      );
    }
    // Phase 3 follow-up (owner): the receipt deposits into a SPECIFIC
    // bank/cash account picked in the dialog, not a method-derived
    // default. Falls back to bankAcct(method) for older clients.
    let depositAcct = bankAcct(method);
    if (body.bankAccount) {
      const acct = await c.var.DB.prepare(
        "SELECT specialAccountType FROM chart_of_accounts WHERE code = ?",
      )
        .bind(String(body.bankAccount))
        .first<{ specialAccountType: string | null }>();
      if (!acct || (acct.specialAccountType !== "SBK" && acct.specialAccountType !== "SCH")) {
        return c.json(
          { success: false, error: "bankAccount must be a bank (SBK) or cash (SCH) account" },
          400,
        );
      }
      depositAcct = String(body.bankAccount);
    }

    const customer = await c.var.DB.prepare(
      "SELECT id, name, code FROM customers WHERE id = ?",
    )
      .bind(customerId)
      .first<{ id: string; name: string; code: string }>();
    if (!customer) {
      return c.json({ success: false, error: "Customer not found" }, 404);
    }

    const allocInput: Array<{ invoiceId: string; amount: number }> =
      Array.isArray(allocations) ? allocations : [];

    // Look up each invoice to grab the invoiceNo + current state for the
    // per-allocation side-effects (invoice_payments insert + paid bump).
    // Also pull salesOrderId so we can cascade the SO once the invoice is
    // fully paid (E3), and deliveryOrderId so we can reuse
    // previewCascadeSOClosed() from invoices.ts to flip the SO to CLOSED
    // when every sibling invoice is PAID.
    const invoiceSnapshots = new Map<
      string,
      {
        invoiceNo: string;
        paidAmount: number;
        totalSen: number;
        salesOrderId: string | null;
        deliveryOrderId: string | null;
      }
    >();
    if (allocInput.length > 0) {
      const ids = allocInput.map((a) => a.invoiceId);
      const placeholders = ids.map(() => "?").join(",");
      const invs = await c.var.DB.prepare(
        `SELECT id, invoiceNo, paidAmount, totalSen, salesOrderId, deliveryOrderId
           FROM invoices WHERE id IN (${placeholders})`,
      )
        .bind(...ids)
        .all<{
          id: string;
          invoiceNo: string;
          paidAmount: number;
          totalSen: number;
          salesOrderId: string | null;
          deliveryOrderId: string | null;
        }>();
      for (const i of invs.results ?? []) {
        invoiceSnapshots.set(i.id, {
          invoiceNo: i.invoiceNo,
          paidAmount: i.paidAmount,
          totalSen: i.totalSen,
          salesOrderId: i.salesOrderId,
          deliveryOrderId: i.deliveryOrderId,
        });
      }
    }

    const parsedAllocations: Allocation[] = allocInput.map((a) => ({
      invoiceId: a.invoiceId,
      invoiceNumber: invoiceSnapshots.get(a.invoiceId)?.invoiceNo ?? "",
      amount: Number(a.amount) || 0,
    }));

    // A receipt may knock off LESS than it is worth — the rest sits on account
    // as a customer advance (owner 2026-08-06). It may never knock off MORE:
    // that would credit invoices with money the bank never received.
    const receiptSen = Math.round(Number(amount) || 0);
    const allocSen = parsedAllocations.reduce((s, a) => s + a.amount, 0);
    if (allocSen > receiptSen) {
      return c.json(
        {
          success: false,
          error: `Allocated ${(allocSen / 100).toFixed(2)} against a receipt of ${(receiptSen / 100).toFixed(2)} — a receipt cannot pay out more than it received.`,
        },
        400,
      );
    }

    // PR 0 (2026-05-20, owner-confirmed) — Reject negative and overpayment
    // at the request boundary. Both were silent-money-bug paths:
    //   • amount < 0 let an "RM -5000" payment slip through and bypass the
    //     Credit Note workflow (no refund reason, no audit trail).
    //   • paidAmount + amount > totalSen flipped the invoice to PAID and
    //     left paidAmount above totalSen — the customer's overpayment
    //     vanished from the system instead of becoming a credit balance.
    // Race window note: this validation uses the snapshot read above, so a
    // second concurrent payment can still squeeze through. The atomic
    // UPDATE below caps the silent-loss damage to "paidAmount slightly
    // exceeds totalSen" — visibly wrong and easy for the operator to spot
    // and correct, vs the original silent-overwrite bug which the
    // operator could not see at all.
    for (const alloc of parsedAllocations) {
      if (alloc.amount < 0) {
        return c.json(
          {
            success: false,
            error: `Payment amount cannot be negative (received ${alloc.amount} for invoice ${alloc.invoiceNumber || alloc.invoiceId}). Use a Credit Note for refunds.`,
          },
          400,
        );
      }
      const snap = invoiceSnapshots.get(alloc.invoiceId);
      if (!snap) {
        return c.json(
          {
            success: false,
            error: `Invoice ${alloc.invoiceId} not found.`,
          },
          400,
        );
      }
      if (snap.paidAmount + alloc.amount > snap.totalSen) {
        const overshootSen = snap.paidAmount + alloc.amount - snap.totalSen;
        return c.json(
          {
            success: false,
            error: `Payment would overpay invoice ${snap.invoiceNo} by ${overshootSen} sen (already paid ${snap.paidAmount}, total ${snap.totalSen}, this payment ${alloc.amount}). Reduce the amount or issue a Credit Note first.`,
          },
          400,
        );
      }
    }

    const id = genPaymentId();
    // Document date (owner 2026-07-07): the operator dates the receipt (money
    // often lands days before it's keyed in) — falls back to today. Drives the
    // receipt number's month, payment_records/invoice_payments dates and the
    // GL month bucket (doc-date family 'payment' reads payment_records.date).
    const bodyDate = String(body.date ?? "").trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(bodyDate)
      ? bodyDate
      : new Date().toISOString().split("T")[0];
    const receiptNumber = body.receiptNumber || (await issueDocNumber(c.var.DB, {
      bankAccountCode: depositAcct,
      direction: "in",
      dateIso: date,
    }));
    const now = new Date().toISOString();

    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        `INSERT INTO payment_records (
           id, receiptNumber, customerId, customerName, date, amount, method,
           reference, status, allocations
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        receiptNumber,
        customer.id,
        customer.name,
        date,
        Number(amount),
        method,
        reference || "",
        "RECEIVED",
        JSON.stringify(parsedAllocations),
      ),
    ];

    // Per-allocation: add invoice_payments row and bump paidAmount/status.
    // Track total allocated to this customer so we can decrement their
    // outstandingSen in one statement (E3). Track fully-paid invoices so
    // we can cascade their linked SO to INVOICED (only from DELIVERED /
    // READY_TO_SHIP) *and* run previewCascadeSOClosed() to flip the SO to
    // CLOSED once every sibling invoice is PAID.
    let totalAllocatedSen = 0;
    const fullyPaidSOIds: string[] = [];
    const fullyPaidInvoices: Array<{
      invoiceId: string;
      deliveryOrderId: string | null;
    }> = [];
    for (const alloc of parsedAllocations) {
      const snap = invoiceSnapshots.get(alloc.invoiceId);
      if (!snap) continue;
      // newPaid here is the *expected* post-write value, used only for
      // the snapshot-based SO cascade detection below. The actual
      // paidAmount write is atomic SQL — see the UPDATE further down.
      // newStatus removed (PR 0 2026-05-20) — the CASE expression in
      // the UPDATE now computes status from the real post-increment
      // value instead of the snapshot-derived guess.
      const newPaid = snap.paidAmount + alloc.amount;
      const isFullyPaid = newPaid >= snap.totalSen;
      totalAllocatedSen += alloc.amount;
      if (isFullyPaid && snap.salesOrderId) {
        fullyPaidSOIds.push(snap.salesOrderId);
      }
      if (isFullyPaid) {
        fullyPaidInvoices.push({
          invoiceId: alloc.invoiceId,
          deliveryOrderId: snap.deliveryOrderId,
        });
      }
      statements.push(
        c.var.DB.prepare(
          `INSERT INTO invoice_payments (id, invoiceId, date, amountSen, method, reference)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(
          genInvoicePaymentId(),
          alloc.invoiceId,
          date,
          alloc.amount,
          method,
          reference || "",
        ),
      );
      // PR 0 (2026-05-20) — atomic increment. Original code wrote
      //   SET paidAmount = ?  (newPaid computed from snapshot)
      // which loses the second of two simultaneous payments — both
      // readers see the same snapshot, both compute the same newPaid
      // candidate against stale data, last UPDATE wins.
      // Atomic SQL += keeps both deltas. Status / paymentDate are
      // recomputed against the post-increment value so they stay
      // consistent. Pre-batch validation above already rejects negative
      // and overpayment from the same request; this guards the
      // concurrent-payment race.
      statements.push(
        c.var.DB.prepare(
          `UPDATE invoices
             SET paidAmount = paidAmount + ?,
                 status = CASE
                   WHEN paidAmount + ? >= totalSen THEN 'PAID'
                   WHEN paidAmount + ? > 0 THEN 'PARTIAL_PAID'
                   ELSE 'SENT'
                 END,
                 paymentDate = CASE
                   WHEN paidAmount + ? >= totalSen THEN ?
                   ELSE paymentDate
                 END,
                 updated_at = ?
           WHERE id = ?`,
        ).bind(
          alloc.amount,
          alloc.amount,
          alloc.amount,
          alloc.amount,
          date,
          now,
          alloc.invoiceId,
        ),
      );
    }

    // E3: decrement the customer's outstanding A/R by the total allocated.
    // GREATEST(0, ...) protects against over-allocation (rounding / partial
    // historical state). If the full invoice has just flipped to PAID,
    // cascade the linked SO from DELIVERED/READY_TO_SHIP → INVOICED and
    // append a so_status_changes audit row.
    if (totalAllocatedSen > 0) {
      statements.push(
        c.var.DB.prepare(
          `UPDATE customers SET outstandingSen = GREATEST(0, outstandingSen - ?) WHERE id = ?`,
        ).bind(totalAllocatedSen, customer.id),
      );
    }

    if (fullyPaidSOIds.length > 0) {
      const uniqueSOIds = [...new Set(fullyPaidSOIds)];
      const placeholders = uniqueSOIds.map(() => "?").join(",");
      const soRows = await c.var.DB.prepare(
        `SELECT id, status FROM sales_orders WHERE id IN (${placeholders})`,
      )
        .bind(...uniqueSOIds)
        .all<{ id: string; status: string }>();
      for (const so of soRows.results ?? []) {
        // 2026-05-26 audit fix — include SHIPPED. Canonical SO status
        // path is READY_TO_SHIP → SHIPPED → DELIVERED → INVOICED →
        // CLOSED. Previous guard excluded SHIPPED, so any SO that
        // dispatched but hadn't yet been marked DELIVERED at the moment
        // of payment silently failed to advance to INVOICED.
        if (
          so.status === "DELIVERED" ||
          so.status === "SHIPPED" ||
          so.status === "READY_TO_SHIP"
        ) {
          statements.push(
            c.var.DB.prepare(
              "UPDATE sales_orders SET status = 'INVOICED', updated_at = ? WHERE id = ?",
            ).bind(now, so.id),
            c.var.DB.prepare(
              `INSERT INTO so_status_changes
                 (id, soId, fromStatus, toStatus, changedBy, timestamp, notes, autoActions)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              genStatusChangeId(),
              so.id,
              so.status,
              "INVOICED",
              "System",
              now,
              "Invoice fully paid",
              JSON.stringify([`Payment ${receiptNumber} fully paid linked invoice`]),
            ),
          );
        }
      }
    }

    // Second SO cascade: if this payment pushed an invoice to PAID *and*
    // every sibling invoice attached to that SO (through every DO of the
    // SO) is also PAID, flip the SO to CLOSED. previewCascadeSOClosed()
    // treats the in-flight invoice as PAID (since the UPDATE is queued in
    // the same batch above) and ignores invoices already tagged CLOSED /
    // CANCELLED — so repeat POSTs or mixed-status SOs are safe. De-dupe
    // on salesOrderId because multiple allocations in the same payment
    // can target different invoices of the same SO; we only need to emit
    // one UPDATE + audit row per SO.
    const seenClosedSO = new Set<string>();
    for (const fp of fullyPaidInvoices) {
      if (!fp.deliveryOrderId) continue;
      const snap = invoiceSnapshots.get(fp.invoiceId);
      const soKey = snap?.salesOrderId;
      if (!soKey || seenClosedSO.has(soKey)) continue;
      const closeStmts = await previewCascadeSOClosed(
        c.var.DB,
        fp.invoiceId,
        fp.deliveryOrderId,
        now,
      );
      if (closeStmts.length === 0) continue;
      seenClosedSO.add(soKey);
      statements.push(...closeStmts);
    }

    // AR receipt → GL: DR bank/cash · CR debtor control. Idempotent via
    // the ledger unique key + HTTP idempotency wrapper; never blocks the
    // payment.
    try {
      const orgId = getOrgId(c);
      const actorUserId =
        (c as unknown as { get: (k: string) => string | undefined }).get(
          "userId",
        ) ?? null;
      const ctl = parseDebtorCode(customer.code);
      const controlCode = ctl.ok ? ctl.controlCode : "300-0000";
      const amtSen = Math.round(Number(amount) || 0);
      if (amtSen > 0) {
        const { statements: ledgerStmts } = await buildJournalEntryStatements(
          c.var.DB,
          orgId,
          [
            {
              id: `lje-${crypto.randomUUID().slice(0, 12)}`,
              sourceType: "payment",
              sourceId: id,
              legNo: 1,
              accountCode: depositAcct,
              debitSen: amtSen,
              creditSen: 0,
              description: `Receipt ${receiptNumber} · ${customer.name}`,
              actorUserId,
              orgId,
            },
            {
              id: `lje-${crypto.randomUUID().slice(0, 12)}`,
              sourceType: "payment",
              sourceId: id,
              legNo: 2,
              accountCode: controlCode,
              debitSen: 0,
              creditSen: amtSen,
              description: `Receipt ${receiptNumber} · ${customer.name}`,
              actorUserId,
              orgId,
            },
          ],
        );
        statements.push(...ledgerStmts);
      }
    } catch (e) {
      // Phase 1 (2026-06) — abort: a receipt must never apply its
      // paidAmount/outstanding cascade without DR bank / CR debtor legs.
      console.error(
        `[ledger] failed to BUILD payment ${id} post — aborting:`,
        e,
      );
      return c.json(
        {
          success: false,
          error:
            "Failed to build the GL posting for this payment — nothing was saved. Retry, and report if it persists.",
        },
        500,
      );
    }

    statements.push(bumpPaymentRecordsRev(c.var.DB));
    await c.var.DB.batch(statements);

    const created = await c.var.DB.prepare(
      "SELECT * FROM payment_records WHERE id = ?",
    )
      .bind(id)
      .first<PaymentRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create payment" },
        500,
      );
    }
    // Audit emit (P3.4) — payment is a high-sensitivity mutation that ops
    // and finance both audit forensically.  Capture full row state (incl.
    // allocations) so a forensic query can reconstruct what was settled.
    const paymentRow = rowToPayment(created);
    await emitAudit(c, {
      resource: "payments",
      resourceId: paymentRow.id,
      action: "create",
      after: paymentRow,
    });
    return c.json({ success: true, data: paymentRow }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/payments] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json({ success: false, error: msg || "Internal error creating payment" }, 500);
  }
  });
});

// GET /api/payments/:id — single
app.get("/:id", async (c) => {
  const denied = await requirePermission(c, "payments", "read");
  if (denied) return denied;
  // Tenant-scoped like every other read here. Without the org predicate this
  // returned ANY tenant's payment to anyone who knew or guessed its id — and a
  // payment id is not a secret: it appears in exports, in URLs, and in the
  // allocation rows of documents the caller can legitimately see.
  //
  // A row belonging to someone else reads as 404, not 403: "not found" and
  // "not yours" must be indistinguishable, or the endpoint becomes a way to
  // confirm that a given id exists in another company's books.
  const row = await c.var.DB.prepare(
    "SELECT * FROM payment_records WHERE id = ? AND org_id = ?",
  )
    .bind(c.req.param("id"), getOrgId(c))
    .first<PaymentRow>();
  if (!row) {
    return c.json({ success: false, error: "Payment not found" }, 404);
  }
  const [one] = await fillAllocationNumbers(c.var.DB, [rowToPayment(row)]);
  return c.json({ success: true, data: one });
});

// PUT /api/payments/:id — status transitions (RECEIVED → CLEARED / BOUNCED).
// BOUNCED rolls back invoice paidAmount/status exactly like the old impl.
app.put("/:id", async (c) => {
  // RBAC gate (P3.3-followup) — payments:update for status transitions.
  const denied = await requirePermission(c, "payments", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM payment_records WHERE id = ?",
    )
      .bind(id)
      .first<PaymentRow>();
    if (!existing) {
      return c.json({ success: false, error: "Payment not found" }, 404);
    }

    const body = await c.req.json();
    const currentStatus = existing.status ?? "RECEIVED";

    if (!body.status || body.status === currentStatus) {
      return c.json({ success: true, data: rowToPayment(existing) });
    }

    const allowed = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(body.status)) {
      return c.json(
        {
          success: false,
          error: `Cannot transition from ${currentStatus} to ${body.status}. Allowed: ${allowed.join(", ") || "none"}`,
        },
        400,
      );
    }

    const allocs = parseAllocations(existing.allocations);
    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        "UPDATE payment_records SET status = ? WHERE id = ?",
      ).bind(body.status, id),
    ];

    if (body.status === "BOUNCED" && currentStatus !== "BOUNCED") {
      const now = new Date().toISOString();
      // Re-fetch current paidAmount for each allocated invoice so rollback
      // math is based on live state, not stale local state.
      const invoiceIds = [...new Set(allocs.map((a) => a.invoiceId))].filter(
        (id) => id,
      );
      let totalRolledBack = 0;
      if (invoiceIds.length > 0) {
        const placeholders = invoiceIds.map(() => "?").join(",");
        const invs = await c.var.DB.prepare(
          `SELECT id, paidAmount, totalSen FROM invoices WHERE id IN (${placeholders})`,
        )
          .bind(...invoiceIds)
          .all<{ id: string; paidAmount: number; totalSen: number }>();
        const invMap = new Map(
          (invs.results ?? []).map((i) => [i.id, i]),
        );
        // Sum allocations per invoice before applying.
        const deltaByInvoice = new Map<string, number>();
        for (const alloc of allocs) {
          deltaByInvoice.set(
            alloc.invoiceId,
            (deltaByInvoice.get(alloc.invoiceId) ?? 0) + alloc.amount,
          );
        }
        for (const [invoiceId, delta] of deltaByInvoice) {
          const inv = invMap.get(invoiceId);
          if (!inv) continue;
          // Tier D D1 fix 2026-05-21 — same atomic-SQL pattern as PR 0 #1.
          // Original code wrote `SET paidAmount = ?` with the snapshot-
          // computed newPaid, which lost the second of two concurrent
          // BOUNCED rollbacks (last-write-wins). Now uses atomic
          // SQL-side subtraction (GREATEST/MAX in DB so floors at 0)
          // so two simultaneous rollbacks both land cleanly. Status is
          // recomputed in CASE against the post-decrement value.
          // totalRolledBack still tracks the *intended* rollback for
          // the customer outstandingSen restore — capped at the
          // pre-decrement paid amount so we don't restore more than
          // was paid (same Math.min as before).
          totalRolledBack += Math.min(delta, inv.paidAmount);
          statements.push(
            c.var.DB.prepare(
              `UPDATE invoices
                 SET paidAmount = GREATEST(0, paidAmount - ?),
                     status = CASE
                       WHEN GREATEST(0, paidAmount - ?) <= 0 THEN 'SENT'
                       WHEN GREATEST(0, paidAmount - ?) < totalSen THEN 'PARTIAL_PAID'
                       ELSE 'PAID'
                     END,
                     updated_at = ?
               WHERE id = ?`,
            ).bind(delta, delta, delta, now, invoiceId),
          );
        }
      }
      // Restore the customer's A/R — bounce means the money never cleared.
      if (totalRolledBack > 0) {
        statements.push(
          c.var.DB.prepare(
            `UPDATE customers SET outstandingSen = outstandingSen + ? WHERE id = ?`,
          ).bind(totalRolledBack, existing.customerId),
        );
      }
      // GL reversal of the original receipt: DR debtor control · CR bank.
      // Idempotent — only if the receipt posted and not already reversed.
      try {
        const orgId = getOrgId(c);
        const actorUserId =
          (c as unknown as { get: (k: string) => string | undefined }).get(
            "userId",
          ) ?? null;
        const posted = await ledgerHasSource(c.var.DB, orgId, "payment", id);
        const reversed = await ledgerHasSource(
          c.var.DB,
          orgId,
          "payment_bounce",
          id,
        );
        const amtSen = Math.round(Number(existing.amount) || 0);
        if (posted && !reversed && amtSen > 0) {
          const cust = await c.var.DB.prepare(
            "SELECT code FROM customers WHERE id = ?",
          )
            .bind(existing.customerId)
            .first<{ code: string }>();
          const ctl = parseDebtorCode(cust?.code);
          const controlCode = ctl.ok ? ctl.controlCode : "300-0000";
          // Reverse the EXACT bank/cash account the receipt was posted to
          // (the dialog may have picked a non-default account) — fall back
          // to the method mapping only for legacy legs.
          const origLeg = await c.var.DB.prepare(
            `SELECT accountCode FROM ledger_journal_entries
              WHERE sourceType = 'payment' AND sourceId = ? AND orgId = ? AND debitSen > 0
              LIMIT 1`,
          )
            .bind(id, orgId)
            .first<{ accountCode: string }>();
          const reverseBankAcct = origLeg?.accountCode ?? bankAcct(existing.method);
          const { statements: revStmts } = await buildJournalEntryStatements(
            c.var.DB,
            orgId,
            [
              {
                id: `lje-${crypto.randomUUID().slice(0, 12)}`,
                sourceType: "payment_bounce",
                sourceId: id,
                legNo: 1,
                accountCode: controlCode,
                debitSen: amtSen,
                creditSen: 0,
                description: `REVERSAL · bounced receipt ${existing.receiptNumber}`,
                actorUserId,
                orgId,
              },
              {
                id: `lje-${crypto.randomUUID().slice(0, 12)}`,
                sourceType: "payment_bounce",
                sourceId: id,
                legNo: 2,
                accountCode: reverseBankAcct,
                debitSen: 0,
                creditSen: amtSen,
                description: `REVERSAL · bounced receipt ${existing.receiptNumber}`,
                actorUserId,
                orgId,
              },
            ],
          );
          statements.push(...revStmts);
        }
      } catch (e) {
        // Phase 1 (2026-06) — abort: a bounce must reverse both the
        // subledger AND the GL or the bank/debtor accounts go stale.
        console.error(
          `[ledger] failed to BUILD payment ${id} bounce — aborting:`,
          e,
        );
        return c.json(
          {
            success: false,
            error:
              "Failed to build the GL reversal for this bounce — nothing was saved. Retry, and report if it persists.",
          },
          500,
        );
      }
    }

    statements.push(bumpPaymentRecordsRev(c.var.DB));
    await c.var.DB.batch(statements);

    const updated = await c.var.DB.prepare(
      "SELECT * FROM payment_records WHERE id = ?",
    )
      .bind(id)
      .first<PaymentRow>();
    // Payment create was audited but the status transition was not — and this
    // is the handler where money actually moves back: BOUNCED reverses every
    // allocated invoice's paidAmount, restores the customer's outstandingSen
    // and posts a GL reversal. Snapshot both sides so the pre-bounce
    // allocations (the basis for the rollback maths) survive.
    await emitAudit(c, {
      resource: "payments",
      resourceId: id,
      action: "update",
      before: rowToPayment(existing),
      after: updated ? rowToPayment(updated) : null,
    });
    return c.json({
      success: true,
      data: updated ? rowToPayment(updated) : null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[PUT /api/payments/:id] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json({ success: false, error: msg || "Internal error updating payment" }, 500);
  }
});

// Void / delete / unvoid a receipt — reverses the GL, reopens the paid
// invoices, and restores the customer's outstanding A/R (see
// buildCustomerPaymentLifecycle). The payment row is kept so it can be unvoided.
app.post("/:id/lifecycle", async (c) => {
  const denied = await requirePermission(c, "payments", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  let action: LifecycleAction;
  try {
    action = ((await c.req.json()) as { action: string }).action as LifecycleAction;
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
    // Pre-state for the audit snapshot. void/delete reverse the GL, reopen
    // every paid invoice and restore the customer's A/R — the row itself is
    // kept (so it can be unvoided) but its allocations and status are what
    // the reversal was computed from, and nothing else records them.
    const before = await c.var.DB.prepare(
      "SELECT * FROM payment_records WHERE id = ?",
    )
      .bind(id)
      .first<PaymentRow>();
    const { statements, newState } = await buildCustomerPaymentLifecycle(
      c.var.DB,
      orgId,
      id,
      action,
      actorUserId,
    );
    statements.push(bumpPaymentRecordsRev(c.var.DB));
    await c.var.DB.batch(statements);
    const after = await c.var.DB.prepare(
      "SELECT * FROM payment_records WHERE id = ?",
    )
      .bind(id)
      .first<PaymentRow>();
    await emitAudit(c, {
      resource: "payments",
      resourceId: id,
      action,
      before: before ? rowToPayment(before) : null,
      after: after ? rowToPayment(after) : null,
    });
    return c.json({ success: true, data: { state: newState } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "PAYMENT_NOT_FOUND") {
      return c.json({ success: false, error: `No payment found for ${id}` }, 404);
    }
    return c.json({ success: false, error: msg }, 400);
  }
});

// Edit a receipt IN PLACE — keeps the same number; reverses the posted GL legs
// and re-posts the corrected ones (see buildCustomerPaymentRestate). Body is the
// corrected receipt: { method, reference, bankAccount, allocations }.
app.post("/:id/restate", async (c) => {
  const denied = await requirePermission(c, "payments", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  let body: {
    method?: string | null;
    reference?: string | null;
    bankAccount?: string;
    allocations?: Allocation[];
    amountSen?: number;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid body" }, 400);
  }
  const allocs = (body.allocations ?? []).filter(
    (a) => a.invoiceId && a.amount > 0,
  );
  // Zero allocations used to be rejected outright. It is now the legitimate
  // way to un-knock a receipt back to a pure advance — as long as the edit
  // still says how much money is being held (owner 2026-08-06).
  if (allocs.length === 0 && !(Number(body.amountSen) > 0)) {
    return c.json(
      {
        success: false,
        error: "A receipt must either allocate to an invoice or carry an amount to hold on account",
      },
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
    // Restate rewrites a receipt IN PLACE, keeping the same receipt number —
    // the original method, reference and allocations are overwritten and the
    // posted GL legs are reversed and re-posted. Without a `before` snapshot
    // there is no way to tell what the receipt originally said.
    const before = await c.var.DB.prepare(
      "SELECT * FROM payment_records WHERE id = ?",
    )
      .bind(id)
      .first<PaymentRow>();
    const statements = await buildCustomerPaymentRestate(
      c.var.DB,
      orgId,
      id,
      body,
      actorUserId,
      stamp,
    );
    statements.push(bumpPaymentRecordsRev(c.var.DB));
    await c.var.DB.batch(statements);
    const after = await c.var.DB.prepare(
      "SELECT * FROM payment_records WHERE id = ?",
    )
      .bind(id)
      .first<PaymentRow>();
    await emitAudit(c, {
      resource: "payments",
      resourceId: id,
      action: "restate",
      before: before ? rowToPayment(before) : null,
      after: after ? rowToPayment(after) : null,
    });
    return c.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "PAYMENT_NOT_FOUND") {
      return c.json({ success: false, error: `No payment found for ${id}` }, 404);
    }
    if (msg === "ALLOCATIONS_EXCEED_AMOUNT") {
      return c.json(
        {
          success: false,
          error: "The invoices allocated add up to more than the receipt — reduce them, or raise the amount received.",
        },
        400,
      );
    }
    return c.json({ success: false, error: msg }, 400);
  }
});

export default app;
