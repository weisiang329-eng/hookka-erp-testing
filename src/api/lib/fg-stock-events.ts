// ---------------------------------------------------------------------------
// fg-stock-events.ts — the append-only finished-goods stock ledger.
//
// THE HOLE. Finished-goods on-hand was never a ledger. It is DERIVED at read
// time from job-card + delivery-order status (`src/lib/fg-stock.ts`
// deriveFGStock), `/api/inventory` deliberately returns `stockQty: 0` for FG,
// and the one per-piece table that exists (`fg_units`, 4,866 real rows with a
// serial, a PO, an SO and date stamps) is only ever OVERWRITTEN — a unit's
// status is UPDATEd in place by nine different writers and the previous state
// is gone. So there is no answer to "which production order did this piece come
// in on", "which delivery note took it out", or "what did the balance look like
// last Tuesday". `stock_movements` is not that ledger either: 12 columns, no
// cost, no unit, and its only link to a document is a free-text `reason` string
// ("DO-2607-018 dispatched") that nothing can join on.
//
// WHAT THIS IS. One immutable row per fg_unit state change: the unit, from →
// to, the server clock, who did it, and the document TYPE + ID that caused it —
// a real id you can click through to, not a sentence. Reversals are
// COUNTER-ROWS, never edits or deletes; that is the discipline
// `buildDoCancelReleaseStatements` already follows for stock_movements, and it
// is what makes the ledger evidence rather than a cache.
//
// THE ONE ARITHMETIC RULE
//   direction = onHand(to_status) − onHand(from_status)
// computed HERE, from the statuses, never chosen per call site. Two
// consequences fall out for free:
//   * Σ direction over one unit's events == 1 if that unit is on hand, else 0.
//     A call site cannot get the sign wrong, and a reversal is automatically
//     the mirror of the edge it undoes — the DO-cancel counter-row is an IN
//     because DELIVERED → PENDING is an IN, not because anyone typed "+1".
//   * Σ direction per product == the on-hand unit count. That is one half of
//     the reconciliation in fg-ledger-reconcile.ts.
//
// THE ON-HAND BOUNDARY IS DISPATCH, NOT DELIVERY. A unit stamped LOADED has
// physically left the rack: the DO dispatch writes a STOCK_OUT movement,
// deletes its rack_items, and `deriveFGStock` drops it. Several routes already
// spell the same set as `status NOT IN ('LOADED','DELIVERED','RETURNED')`. We
// match that, so the event ledger and the existing derivation agree.
//   RETURNED is the exception and IS on hand: the only writers of RETURNED are
// return-to-stock paths, each of which also credits `fg_batches.remaining_qty`
// back and writes a STOCK_IN movement. Calling those goods "out" would make the
// event ledger disagree with the cost ledger about the same physical piece.
//   `fg_batches` draws down one step LATER, at DELIVERED. That gap is real and
// is NOT papered over here — fg-ledger-reconcile.ts carries it as an explicit
// named bridging term rather than letting the two halves drift silently, which
// is exactly how Houzs' two ledgers diverged.
// ---------------------------------------------------------------------------
import type { D1Database } from "@cloudflare/workers-types";
import { runSelfApply, memoizeSelfApply } from "./self-apply";

// ---------------------------------------------------------------------------
// Runtime self-apply. Migration files are INERT on deploy in this repo, so this
// is the load-bearing copy of migrations-postgres/0221_fg_stock_events.sql. It
// MUST be awaited before the first write on every path that emits an event.
//
// It THROWS rather than degrading, and memoizeSelfApply drops the memo on
// failure so the next request retries instead of remembering a failed round as
// done. A silently-absent ledger table is the worst outcome available here: the
// writes would fail one by one inside caller try/catch blocks and the balance
// would quietly go wrong.
// ---------------------------------------------------------------------------
let _mig: Promise<void> | null = null;
export function ensureFgStockEventsSchema(db: D1Database): Promise<void> {
  return memoizeSelfApply(
    () => _mig,
    (p) => {
      _mig = p;
    },
    () =>
      runSelfApply(db, "fg-stock-events", [
        `CREATE TABLE IF NOT EXISTS fg_stock_events (
           id                TEXT PRIMARY KEY,
           org_id            TEXT NOT NULL DEFAULT 'hookka',
           fg_unit_id        TEXT NOT NULL REFERENCES fg_units(id) ON DELETE CASCADE,
           event_type        TEXT NOT NULL,
           direction         INTEGER NOT NULL,
           from_status       TEXT,
           to_status         TEXT NOT NULL,
           doc_type          TEXT NOT NULL,
           doc_id            TEXT,
           doc_no            TEXT,
           product_code      TEXT,
           batch_id          TEXT,
           unit_cost_sen     INTEGER,
           occurred_at       TEXT NOT NULL,
           actor_type        TEXT NOT NULL DEFAULT 'SYSTEM',
           actor_id          TEXT,
           actor_name        TEXT,
           reverses_doc_type TEXT,
           reverses_doc_id   TEXT,
           note              TEXT,
           created_at        TEXT NOT NULL
         )`,
        "CREATE INDEX IF NOT EXISTS idx_fg_stock_events_unit ON fg_stock_events (fg_unit_id, occurred_at)",
        "CREATE INDEX IF NOT EXISTS idx_fg_stock_events_product ON fg_stock_events (product_code, occurred_at)",
        "CREATE INDEX IF NOT EXISTS idx_fg_stock_events_doc ON fg_stock_events (doc_type, doc_id)",
        "CREATE INDEX IF NOT EXISTS idx_fg_stock_events_org ON fg_stock_events (org_id)",
      ]),
  );
}

// ---------------------------------------------------------------------------
// The on-hand status set. `fg_units.status` is CHECK-constrained to exactly
// these seven values (migrations/0001_init.sql).
// ---------------------------------------------------------------------------
export const FG_ONHAND_STATUSES: readonly string[] = [
  "PENDING",
  "PENDING_UPHOLSTERY",
  "UPHOLSTERED",
  "PACKED",
  // Returned goods are physically back and their cost has been credited back to
  // the lot by the same transaction — see the header note.
  "RETURNED",
];

/** The statuses a piece can hold while it is NOT ours to count. */
export const FG_OFFHAND_STATUSES: readonly string[] = ["LOADED", "DELIVERED"];

export function isOnHandStatus(status: string | null | undefined): boolean {
  return !!status && FG_ONHAND_STATUSES.includes(status);
}

/**
 * The ONE place a sign is decided. `from === null` means the piece did not
 * exist yet (production output, or the opening-balance seed).
 */
export function balanceDelta(
  fromStatus: string | null | undefined,
  toStatus: string,
): -1 | 0 | 1 {
  const before = isOnHandStatus(fromStatus) ? 1 : 0;
  const after = isOnHandStatus(toStatus) ? 1 : 0;
  return (after - before) as -1 | 0 | 1;
}

export type FgEventType = "IN" | "OUT" | "MOVE";

/**
 * MOVE is not filler. LOADED → DELIVERED changes nothing about whether we hold
 * the piece (it was already out at dispatch) but it is the edge that names the
 * delivery and drives FIFO COGS, so it has to be on the trail. Recording it as
 * an IN or an OUT would double-count the movement.
 */
export function eventTypeFor(delta: number): FgEventType {
  if (delta > 0) return "IN";
  if (delta < 0) return "OUT";
  return "MOVE";
}

// ---------------------------------------------------------------------------
// The document that caused the transition. Every value here is a REAL id on a
// real table — the point of the whole exercise is that the Inventory drawer can
// link straight to the production order or delivery note.
//
// FG_SCAN is the one non-document source: a warehouse worker scanning a sticker
// with no document behind the action (the standalone POST /api/fg-units/scan).
// Its doc_id is the fg_unit's own id, so the row is still joinable and never
// carries a null pretending to be a document.
// ---------------------------------------------------------------------------
export type FgDocType =
  | "PRODUCTION_ORDER"
  | "DELIVERY_ORDER"
  | "CONSIGNMENT_NOTE"
  | "DELIVERY_RETURN"
  | "FG_SCAN"
  | "OPENING_BALANCE";

export type FgEventDoc = {
  docType: FgDocType;
  docId: string | null;
  docNo?: string | null;
};

export type FgEventActor = {
  type: "USER" | "WORKER" | "SYSTEM";
  id?: string | null;
  name?: string | null;
};

export const SYSTEM_ACTOR: FgEventActor = { type: "SYSTEM", id: null, name: "System" };

/** Actor from a Hono context's authenticated user id, falling back to System. */
export function actorFromUserId(userId: string | null | undefined): FgEventActor {
  return userId ? { type: "USER", id: userId, name: null } : SYSTEM_ACTOR;
}

/**
 * The slice of an fg_unit an event needs. Read BEFORE the UPDATE that changes
 * the status — `status` here is the FROM side.
 */
export type FgUnitSnapshot = {
  id: string;
  status: string | null;
  productCode?: string | null;
  batchId?: string | null;
  poId?: string | null;
  poNo?: string | null;
  doId?: string | null;
  cnId?: string | null;
};

export type FgEventInput = {
  toStatus: string;
  doc: FgEventDoc;
  actor?: FgEventActor;
  occurredAt: string;
  note?: string | null;
  /** Set on a counter-row so the reversal points at what it undoes. */
  reverses?: { docType: FgDocType; docId: string | null } | null;
  /** Skip units already at toStatus. Default true — a no-op is not an event. */
  skipNoOp?: boolean;
  /**
   * For the once-per-unit-ever events ONLY (production output, opening-balance
   * seed): derive the row id from the unit id and let the primary key reject a
   * replay. Same trick `genFGUnitId` + `ON CONFLICT (id) DO NOTHING` already
   * uses to stop a concurrent generate stickering the same box twice — without
   * it, a replayed completion cascade would book the same piece into stock a
   * second time. Deliberately NOT used for dispatch/return edges: a unit can
   * legitimately be dispatched, un-dispatched and dispatched again, and
   * swallowing the second OUT would leave the balance overstated forever.
   */
  onceKey?: string;
};

function genEventId(): string {
  return `fge-${crypto.randomUUID()}`;
}

// ---------------------------------------------------------------------------
// loadFgUnitsForEvent — read the FROM side.
//
// The caller passes the SAME predicate its UPDATE will use. That coupling is
// the whole correctness argument: a SELECT that matched a different set than
// the UPDATE would record a transition that did not happen (or miss one that
// did), and because the returned statements ride the caller's own db.batch()
// alongside the UPDATE, the two either both land or both roll back.
// ---------------------------------------------------------------------------
export async function loadFgUnitsForEvent(
  db: D1Database,
  whereSql: string,
  binds: unknown[],
): Promise<FgUnitSnapshot[]> {
  const res = await db
    .prepare(
      `SELECT id, status, productCode, batchId, poId, poNo, doId, cnId
         FROM fg_units WHERE ${whereSql}`,
    )
    .bind(...binds)
    .all<{
      id: string;
      status: string | null;
      productCode: string | null;
      batchId: string | null;
      poId: string | null;
      poNo: string | null;
      doId: string | null;
      cnId: string | null;
    }>();
  return res.results ?? [];
}

// ---------------------------------------------------------------------------
// buildFgStockEventStatements — one row per unit, returned as statements so the
// caller can append them to the batch that carries the UPDATE. This helper
// NEVER writes on its own; an event that could land without its status change
// (or vice versa) is the failure mode the whole table exists to prevent.
// ---------------------------------------------------------------------------
export function buildFgStockEventStatements(
  db: D1Database,
  units: FgUnitSnapshot[],
  evt: FgEventInput,
): D1PreparedStatement[] {
  const actor = evt.actor ?? SYSTEM_ACTOR;
  const skipNoOp = evt.skipNoOp !== false;
  const out: D1PreparedStatement[] = [];
  for (const u of units) {
    const from = u.status ?? null;
    if (skipNoOp && from === evt.toStatus) continue;
    const delta = balanceDelta(from, evt.toStatus);
    const id = evt.onceKey ? `fge-${evt.onceKey}-${u.id}` : genEventId();
    const conflict = evt.onceKey ? " ON CONFLICT (id) DO NOTHING" : "";
    out.push(
      db
        .prepare(
          `INSERT INTO fg_stock_events
             (id, fg_unit_id, event_type, direction, from_status, to_status,
              doc_type, doc_id, doc_no, product_code, batch_id,
              occurred_at, actor_type, actor_id, actor_name,
              reverses_doc_type, reverses_doc_id, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)${conflict}`,
        )
        .bind(
          id,
          u.id,
          eventTypeFor(delta),
          delta,
          from,
          evt.toStatus,
          evt.doc.docType,
          evt.doc.docId ?? null,
          evt.doc.docNo ?? null,
          u.productCode ?? null,
          u.batchId ?? null,
          evt.occurredAt,
          actor.type,
          actor.id ?? null,
          actor.name ?? null,
          evt.reverses?.docType ?? null,
          evt.reverses?.docId ?? null,
          evt.note ?? null,
          evt.occurredAt,
        ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// recordFgStockEvents — the convenience wrapper for the writers that do NOT
// build a batch (consignment-note-shared.ts runs sequential .run() calls, and
// changing that is a larger refactor than this earns).
//
// BEST-EFFORT ON PURPOSE, and only here: those call sites have already mutated
// fg_units by the time we are called, so throwing would abort a half-applied
// cascade. A missing event row is visible — the reconciliation check is what
// makes it visible — and a wedged consignment note is not.
// ---------------------------------------------------------------------------
export async function recordFgStockEvents(
  db: D1Database,
  units: FgUnitSnapshot[],
  evt: FgEventInput,
): Promise<void> {
  if (units.length === 0) return;
  try {
    await ensureFgStockEventsSchema(db);
    const stmts = buildFgStockEventStatements(db, units, evt);
    for (let i = 0; i < stmts.length; i += 50) {
      await db.batch(stmts.slice(i, i + 50));
    }
  } catch (e) {
    console.warn("[fg-stock-events] event write skipped:", e);
  }
}

// ---------------------------------------------------------------------------
// Which document a scan-driven transition belongs to. The standalone scan
// endpoint has no document of its own, but the unit knows which delivery note
// or consignment note claimed it — prefer that over an anonymous FG_SCAN so the
// row is still clickable.
// ---------------------------------------------------------------------------
export function docForScannedUnit(
  unit: FgUnitSnapshot,
  action: "PACK" | "LOAD" | "DELIVER" | "RETURN",
): FgEventDoc {
  if (action === "PACK") {
    if (unit.poId) {
      return { docType: "PRODUCTION_ORDER", docId: unit.poId, docNo: unit.poNo ?? null };
    }
    return { docType: "FG_SCAN", docId: unit.id, docNo: null };
  }
  if (unit.doId) return { docType: "DELIVERY_ORDER", docId: unit.doId, docNo: null };
  if (unit.cnId) return { docType: "CONSIGNMENT_NOTE", docId: unit.cnId, docNo: null };
  return { docType: "FG_SCAN", docId: unit.id, docNo: null };
}
