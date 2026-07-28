import type { Env } from "../worker";
import { reverseLegs } from "../../lib/other-party-bill";
import { buildJournalEntryStatements, ledgerHasSource, type LedgerEntryInput } from "./journal-hash";
import { nextState, hiddenTargets, needsReversal, type DocState, type LifecycleAction } from "../../lib/lifecycle-machine";

export async function getDocState(
  db: Env["Variables"]["DB"],
  orgId: string,
  sourceType: string,
  sourceId: string,
): Promise<DocState> {
  const row = await db
    .prepare("SELECT state FROM document_lifecycle WHERE orgId = ? AND sourceType = ? AND sourceId = ?")
    .bind(orgId, sourceType, sourceId)
    .first<{ state: DocState }>();
  return row?.state ?? "ACTIVE";
}

/**
 * Build the statements (NOT executed) to apply a lifecycle action to a document:
 *   - ensure the reversal entry exists (void/delete only; once per doc, idempotent)
 *   - set `hidden` on original + reversal legs per the target state
 *   - upsert document_lifecycle.state
 * Caller appends these to its own batch (with the doc-specific side effects) and
 * runs one c.var.DB.batch(...). Throws on an illegal transition (caller → 400).
 *
 * `baseSourceTypes` is the array of original leg sourceTypes (first element is
 * also the lifecycle key); `voidSourceType` is the reversal legs' sourceType
 * (e.g. "payment_voucher_void").
 *
 * Returns `prevState` (the state BEFORE this action) alongside `newState` so
 * callers can apply boundary-aware side effects — adjusting an aggregate (e.g.
 * legacy balanceSen) only when crossing the ACTIVE boundary, never on a
 * non-active → non-active transition such as VOID → DELETED.
 */
export async function applyLifecycle(
  db: Env["Variables"]["DB"],
  opts: {
    orgId: string;
    baseSourceTypes: string[];
    voidSourceType: string;
    sourceId: string;
    action: LifecycleAction;
    actorUserId: string | null;
    descriptionTag: string;
  },
): Promise<{ statements: D1PreparedStatement[]; newState: DocState; prevState: DocState }> {
  const { orgId, baseSourceTypes, voidSourceType, sourceId, action, actorUserId, descriptionTag } = opts;
  const primarySourceType = baseSourceTypes[0];
  const cur = await getDocState(db, orgId, primarySourceType, sourceId);
  const target = nextState(cur, action);
  if (!target) throw new Error(`Illegal lifecycle action '${action}' from state '${cur}'`);

  const statements: D1PreparedStatement[] = [];

  // ⚠️ LATENT (BUG-2026-07-24-001 class): every sourceId match below is EXACT.
  // Purchase-invoice EDITS post correction legs under sourceId
  // '<docId>:edit-<stamp>' — exact matches would neither reverse nor hide
  // them. Unreachable today (PIs don't use applyLifecycle; PI delete is
  // DRAFT-only = no legs). If a doc type with ':<tag>' sourceId legs is ever
  // wired here, widen the reversal SELECT and both hidden UPDATEs with
  // `OR sourceId LIKE '<id>:%'` and renumber reversal legNos.

  // 1. ensure reversal exists (void/delete only; idempotent via ledgerHasSource)
  if (needsReversal(action) && !(await ledgerHasSource(db, orgId, voidSourceType, sourceId))) {
    const placeholders = baseSourceTypes.map(() => "?").join(", ");
    const orig =
      (
        await db
          .prepare(
            `SELECT accountCode, debitSen, creditSen, legNo FROM ledger_journal_entries WHERE sourceType IN (${placeholders}) AND sourceId = ? AND orgId = ? ORDER BY legNo`,
          )
          .bind(...baseSourceTypes, sourceId, orgId)
          .all<{ accountCode: string; debitSen: number; creditSen: number; legNo: number }>()
      ).results ?? [];
    const rev = reverseLegs(
      orig.map((l) => ({ legNo: l.legNo, accountCode: l.accountCode, debitSen: l.debitSen, creditSen: l.creditSen, description: descriptionTag })),
    );
    const legs: LedgerEntryInput[] = rev.map((l) => ({
      id: `lje-${crypto.randomUUID().slice(0, 12)}`,
      sourceType: voidSourceType,
      sourceId,
      legNo: l.legNo,
      accountCode: l.accountCode,
      debitSen: l.debitSen,
      creditSen: l.creditSen,
      description: l.description,
      actorUserId,
      orgId,
    }));
    const { statements: ls } = await buildJournalEntryStatements(db, orgId, legs);
    statements.push(...ls);
  }

  // 2. set hidden flags per target state
  const h = hiddenTargets(target);
  // one UPDATE per base sourceType
  for (const baseSourceType of baseSourceTypes) {
    statements.push(
      db
        .prepare("UPDATE ledger_journal_entries SET hidden = ? WHERE sourceType = ? AND sourceId = ? AND orgId = ?")
        .bind(h.original, baseSourceType, sourceId, orgId),
    );
  }
  statements.push(
    db
      .prepare("UPDATE ledger_journal_entries SET hidden = ? WHERE sourceType = ? AND sourceId = ? AND orgId = ?")
      .bind(h.reversal, voidSourceType, sourceId, orgId),
  );

  // 3. upsert lifecycle state (key = primarySourceType)
  const now = new Date().toISOString();
  statements.push(
    db
      .prepare(
        `INSERT INTO document_lifecycle (id, sourceType, sourceId, state, actionAt, actorUserId, orgId)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (orgId, sourceType, sourceId) DO UPDATE SET state = ?, actionAt = ?, actorUserId = ?`,
      )
      .bind(`dl-${crypto.randomUUID().slice(0, 10)}`, primarySourceType, sourceId, target, now, actorUserId, orgId, target, now, actorUserId),
  );

  // NOTE on freshness: accounting_aging_snapshot reads document_lifecycle (via
  // loadUnappliedSupplierAdvances) ONLY for supplier-advance void state.
  // document_lifecycle has no updated_at/created_at the freshness probe can
  // track — BUT every supplier_payments mutation (create/void/restate) also
  // runs bumpSupplierPaymentsRev(), which bumps kv_config('supplier_payments_rev').
  // accounting_aging_snapshot lists kv_config in its sourceTables, so a supplier
  // advance void already invalidates the aging snapshot through that rev bump.
  // No separate wipe needed here (an in-builder wipe would also mis-order,
  // running before the caller commits these statements).
  return { statements, newState: target, prevState: cur };
}
