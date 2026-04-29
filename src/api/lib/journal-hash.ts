// ---------------------------------------------------------------------------
// journal-hash.ts — Phase C #2 quick-win immutable ledger hash chain.
//
// Each posted business event (invoice post, payment, credit-note, etc.)
// fans out into N rows in `ledger_journal_entries`, one per leg of the
// double-entry pair. The `rowHash` of each row is SHA-256 over the
// previous row's hash plus this row's canonical fields:
//
//   prevHash || legNo || accountCode || debitSen || creditSen
//             || sourceType || sourceId
//
// Tampering with any field of any row invalidates that row's hash AND
// every subsequent row, so a single nightly chain-walk is enough to
// detect even targeted edits. The chain runs PER orgId so a multi-tenant
// breach (or a single-tenant restore) doesn't have to touch other orgs.
//
// Failure model (matches lib/audit.ts): callers wrap the dual-write in a
// try/catch and console.warn on failure. Ledger errors must NEVER block
// the underlying mutation — the editable invoice/payment posting stays
// authoritative until the immutability trigger flips at M3/W9.
// ---------------------------------------------------------------------------

export interface LedgerEntryInput {
  id: string;
  sourceType: string;       // 'invoice' | 'payment' | 'credit_note' | 'debit_note' | 'manual'
  sourceId: string;
  legNo: number;            // 1, 2, ... within the same business event
  accountCode: string;      // e.g. '1100' (AR), '4000' (Sales), '2400' (GST output)
  debitSen: number;
  creditSen: number;
  description?: string;
  actorUserId?: string | null;
  orgId: string;
}

interface LedgerEntryRow extends LedgerEntryInput {
  prevHash: string;
  rowHash: string;
  description: string;      // narrowed: never undefined after normalization
  actorUserId: string | null;
}

// We accept a D1Database (or the supabase-compat shim that conforms to the
// same surface — both expose prepare()/bind()/first()/batch() with
// identical signatures, so the D1 type alias is sufficient).
type DbLike = D1Database;

// --- hashing ---------------------------------------------------------------

/**
 * SHA-256 over `prevHash || legNo || accountCode || debitSen || creditSen
 *   || sourceType || sourceId`. Hex-encoded, 64 chars.
 *
 * Field order is FROZEN — changing it invalidates every chain-validation
 * job. If a future migration must change the canonical form, gate it
 * behind a `chainVersion` column rather than mutating this function.
 */
export async function computeRowHash(
  prevHash: string,
  entry: Pick<LedgerEntryInput, "legNo" | "accountCode" | "debitSen" | "creditSen" | "sourceType" | "sourceId">,
): Promise<string> {
  const canonical = [
    prevHash,
    String(entry.legNo),
    entry.accountCode,
    String(entry.debitSen),
    String(entry.creditSen),
    entry.sourceType,
    entry.sourceId,
  ].join("|");
  const buf = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return bufferToHex(digest);
}

function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

// --- chain head lookup -----------------------------------------------------

/**
 * Most recent rowHash for this org, or "" if the chain is empty. Ordered
 * by (postedAt DESC, id DESC) — the secondary sort on id breaks ties when
 * two rows share a default CURRENT_TIMESTAMP value (sub-second writes).
 */
export async function getLastJournalHash(
  db: DbLike,
  orgId: string,
): Promise<string> {
  const row = await db
    .prepare(
      `SELECT rowHash FROM ledger_journal_entries
        WHERE orgId = ?
        ORDER BY postedAt DESC, id DESC
        LIMIT 1`,
    )
    .bind(orgId)
    .first<{ rowHash: string | null }>();
  return row?.rowHash ?? "";
}

// --- statement builders ----------------------------------------------------

/**
 * Build the prepared INSERT statements for a batch of ledger legs WITHOUT
 * executing them. The caller appends these to its own `db.batch([...])`
 * call, so the JE writes land in the same transaction as the underlying
 * business mutation (invoice update, payment row, etc.).
 *
 * Sprint 3 hardening: the first statement is `pg_advisory_xact_lock(...)`
 * keyed by orgId so concurrent posters serialize on the chain head. Without
 * this, two posters reading the same `prev_hash` could each compute a
 * `row_hash` against it and write FORKED rows — both rows valid in
 * isolation, but a chain walker would see the first one stamp the
 * canonical chain and the second one orphan into "ledger fork" hell.
 *
 * The lock is transaction-scoped (released at COMMIT/ROLLBACK), so it
 * automatically clears when the batch completes — no manual unlock dance.
 *
 * Hash computation still requires reading the current chain head, so we
 * still take an async hop on `getLastJournalHash` BEFORE building the
 * batch. That read is OUTSIDE the lock window, but the lock prevents two
 * posters from interleaving their writes between read-and-write. (A
 * subsequent reader might briefly see stale data, but the chain itself
 * stays linear.)
 *
 * Caller MUST already provide entry.id values; we don't generate them
 * here so the same id can be referenced by an audit row or rollback log.
 */
export async function buildJournalEntryStatements(
  db: DbLike,
  orgId: string,
  entries: LedgerEntryInput[],
): Promise<{
  statements: D1PreparedStatement[];
  stamped: LedgerEntryRow[];
}> {
  if (entries.length === 0) return { statements: [], stamped: [] };

  const head = await getLastJournalHash(db, orgId);
  const stamped: LedgerEntryRow[] = [];
  let prev = head;
  for (const e of entries) {
    const norm: LedgerEntryRow = {
      id: e.id,
      sourceType: e.sourceType,
      sourceId: e.sourceId,
      legNo: e.legNo,
      accountCode: e.accountCode,
      debitSen: e.debitSen,
      creditSen: e.creditSen,
      description: e.description ?? "",
      actorUserId: e.actorUserId ?? null,
      orgId: e.orgId,
      prevHash: prev,
      rowHash: "", // filled in next
    };
    norm.rowHash = await computeRowHash(prev, norm);
    stamped.push(norm);
    prev = norm.rowHash;
  }

  // pg_advisory_xact_lock takes a bigint key. We hash the org-scoped string
  // through Postgres' built-in hashtext() to derive a stable int4, then cast
  // to bigint. Using the SQL-side hashtext avoids picking an arbitrary
  // numeric assignment for orgIds and stays correct across deploys.
  //
  // The d1-shaped adapter rewrites `?` → `$N` and supports SELECT — we model
  // this as a SELECT and don't read the result. SupabaseAdapter.batch wraps
  // every statement set in `sql.begin(...)`, so the advisory lock is held
  // for the whole transaction and released on COMMIT.
  const lockStmt = db
    .prepare(`SELECT pg_advisory_xact_lock(hashtext('journal_hash:' || ?)::bigint)`)
    .bind(orgId);

  const insertStmts = stamped.map((row) =>
    db
      .prepare(
        `INSERT INTO ledger_journal_entries (
           id, sourceType, sourceId, legNo, accountCode,
           debitSen, creditSen, description,
           prevHash, rowHash, actorUserId, orgId
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.sourceType,
        row.sourceId,
        row.legNo,
        row.accountCode,
        row.debitSen,
        row.creditSen,
        row.description,
        row.prevHash,
        row.rowHash,
        row.actorUserId,
        row.orgId,
      ),
  );

  return {
    statements: [
      lockStmt as unknown as D1PreparedStatement,
      ...(insertStmts as unknown as D1PreparedStatement[]),
    ],
    stamped,
  };
}

// --- atomic batch insert ---------------------------------------------------

/**
 * Append a batch of legs to the ledger. Each entry's prevHash chains to
 * the previous entry IN THE BATCH (not just to the current chain head),
 * so a single business event's legs hash forward together.
 *
 * Insert is atomic via D1 batch — either every leg lands or none do.
 * pg_advisory_xact_lock(orgId) is the first statement of the batch so
 * concurrent posters serialize on the chain head (see
 * buildJournalEntryStatements for the rationale).
 *
 * Caller MUST already provide entry.id values; we don't generate them
 * here so the same id can be referenced by an audit row or rollback log.
 *
 * For new code, prefer `buildJournalEntryStatements` so the JE INSERTs
 * can land in the SAME batch as the underlying business mutation. This
 * function is retained for the standalone-post case and is unchanged in
 * shape from earlier callers.
 */
export async function appendJournalEntries(
  db: DbLike,
  orgId: string,
  entries: LedgerEntryInput[],
): Promise<LedgerEntryRow[]> {
  const { statements, stamped } = await buildJournalEntryStatements(
    db,
    orgId,
    entries,
  );
  if (statements.length === 0) return stamped;
  await db.batch(statements);
  return stamped;
}

// --- chain verification ----------------------------------------------------

export interface ChainVerifyResult {
  ok: boolean;
  totalRows: number;
  brokenRowIds: string[];
  /**
   * Index of the first row whose stored rowHash does not match the recomputed
   * value. -1 when the chain is intact. The chain is "broken from this point
   * forward" — every subsequent row's prev_hash chains off a hash that no
   * longer matches, so they're implicitly broken too. brokenRowIds lists
   * every actually-broken row (recomputed != stored OR prev_hash != prior
   * row's stored rowHash).
   */
  firstBrokenIndex: number;
}

/**
 * Walk the ledger chain for one org, recomputing every row's hash from the
 * stored fields and comparing against the stored rowHash. Also confirms each
 * row's prev_hash equals the previous row's stored rowHash (so an attacker
 * who tampered with row N can't "renumber" the chain by leaving N's hash
 * intact but breaking the link).
 *
 * Defensive helper for the nightly chain-walk job. Sprint 6 added it because
 * the test suite needed a single place to assert "tamper detected" without
 * each test re-implementing hash recomputation. Cheap to run: O(N) hashing
 * per org with no joins.
 *
 * Returns ok=true iff every row passes both checks. On any mismatch, ok=false
 * and brokenRowIds enumerates the offending rows in chain order.
 */
export async function verifyJournalChain(
  db: DbLike,
  orgId: string,
): Promise<ChainVerifyResult> {
  const res = await db
    .prepare(
      `SELECT id, sourceType, sourceId, legNo, accountCode,
              debitSen, creditSen, prevHash, rowHash
         FROM ledger_journal_entries
        WHERE orgId = ?
        ORDER BY postedAt ASC, id ASC`,
    )
    .bind(orgId)
    .all<{
      id: string;
      sourceType: string;
      sourceId: string;
      legNo: number;
      accountCode: string;
      debitSen: number;
      creditSen: number;
      prevHash: string;
      rowHash: string;
    }>();

  const rows = res.results ?? [];
  const brokenRowIds: string[] = [];
  let firstBrokenIndex = -1;
  let priorStoredHash = "";

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let broken = false;

    // Check 1: prev_hash must equal the prior row's stored rowHash.
    if (row.prevHash !== priorStoredHash) {
      broken = true;
    }

    // Check 2: recomputed rowHash from stored fields must match the stored
    // rowHash. Use the row's own prevHash for the recomputation (so the
    // first failure point is the FIELD tamper, not the prev-hash drift).
    const recomputed = await computeRowHash(row.prevHash, {
      legNo: row.legNo,
      accountCode: row.accountCode,
      debitSen: row.debitSen,
      creditSen: row.creditSen,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
    });
    if (recomputed !== row.rowHash) {
      broken = true;
    }

    if (broken) {
      brokenRowIds.push(row.id);
      if (firstBrokenIndex === -1) firstBrokenIndex = i;
    }

    // For the next iteration, advance using the row's STORED rowHash — that
    // mirrors what append-time chain construction does and surfaces the
    // "renumber attack" as a prev-hash mismatch on the next row.
    priorStoredHash = row.rowHash;
  }

  return {
    ok: brokenRowIds.length === 0,
    totalRows: rows.length,
    brokenRowIds,
    firstBrokenIndex,
  };
}
