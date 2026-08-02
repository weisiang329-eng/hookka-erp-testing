// ---------------------------------------------------------------------------
// jobcard-qr-token.ts — shared helpers for the PUBLIC packing-sticker rack
// scan flow (the ITEM→RACK direction).
//
// A storekeeper scans the QR printed on a Packing (FG) sticker with a normal
// phone camera — no Worker-Portal login — and lands on /p/<token>, where the
// ONLY action is to set/clear the warehouse rack number for that one piece.
//
// The token is the ONLY credential for that public page, so it must be
// unguessable: two UUIDs concatenated = 64 random hex chars (~244 bits). It is
// stamped onto the resolved PACKING job_card and minted LAZILY — a card has no
// public page until the office PRINTS its sticker (the authed mint endpoint on
// production-orders.ts). We deliberately do NOT put the bare job_card id in the
// public URL: ids are short + enumerable, and a guessed id would let anyone
// rewrite the rack on any card (unlike the rack-qr flow, where a bare rack id
// is acceptable because stock-in is additive/low-risk).
//
// Column name: snake_case `qr_token` (a NEW column → snake_case per the Hookka
// rule; no column-rename-map entry needed). Reads are dual-keyed
// (r.qr_token ?? r.qrtoken-style folding is unnecessary here since the name is
// already snake_case, but the public route still reads it defensively).
//
// Used by:
//   • routes/production-orders.ts  POST /packing-rack-tokens  (authed, lazy mint)
//   • routes/public-rack-write.ts  GET/POST /:token…          (public resolve)
// ---------------------------------------------------------------------------

import { runSelfApply } from "../lib/self-apply";

export function newJobCardQrToken(): string {
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
}

// Runtime self-apply (same pattern as ensureQrTokenColumns in do-qr-token.ts):
// deploy ordering can't break the endpoints — the column + index land on first
// use, and migration 0187 makes them permanent. A migration file alone is INERT
// on prod (deploys do NOT replay migrations-postgres/*.sql).
let jobCardQrColumnEnsured: Promise<void> | null = null;
export function ensureJobCardQrTokenColumn(db: D1Database): Promise<void> {
  if (jobCardQrColumnEnsured) return jobCardQrColumnEnsured;
  jobCardQrColumnEnsured = (async () => {
    const stmts = [
      "ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS qr_token TEXT",
      "CREATE INDEX IF NOT EXISTS ix_job_cards_qr_token ON job_cards (qr_token)",
    ];
    await runSelfApply(db, "jobcard-qr-token", stmts);
  })().catch((err) => {
    // A FAILED round must not be remembered as done — otherwise one
    // transient blip leaves the column unapplied for the life of this
    // isolate. Dropping the memo lets the next request retry.
    jobCardQrColumnEnsured = null;
    throw err;
  });
  return jobCardQrColumnEnsured;
}

// Create-if-missing, atomically claimed (UPDATE … WHERE qr_token IS NULL) so two
// parallel sticker prints can't mint two diverging tokens — the loser re-reads
// the winner's value. Returns null when the card itself is missing.
export async function getOrCreateJobCardQrToken(
  db: D1Database,
  jobCardId: string,
): Promise<string | null> {
  await ensureJobCardQrTokenColumn(db);
  const read = () =>
    db
      .prepare("SELECT qr_token FROM job_cards WHERE id = ?")
      .bind(jobCardId)
      .first<{ qr_token: string | null }>();
  const row = await read();
  if (!row) return null;
  if (row.qr_token) return row.qr_token;
  const fresh = newJobCardQrToken();
  await db
    .prepare(
      "UPDATE job_cards SET qr_token = ? WHERE id = ? AND (qr_token IS NULL OR qr_token = '')",
    )
    .bind(fresh, jobCardId)
    .run();
  // FIX 4 — never return an UNPERSISTED token. If the re-read confirms our
  // value (or a parallel print's winning value) is stored, return that. If the
  // row vanished (card deleted mid-flight) or the qr_token is still empty (the
  // UPDATE hit 0 rows — e.g. the row changed under us), re-read ONCE more to
  // settle a transient race; if it is STILL unresolved, return null so the
  // caller cleanly falls back (the mint omits the key → the client keeps the
  // /worker/scan fallback). Returning `fresh` here would print a token that no
  // card carries → a permanently dead /p/<token> page.
  const after = await read();
  if (after?.qr_token) return after.qr_token;
  const retry = await read();
  if (retry?.qr_token) return retry.qr_token;
  return null;
}

// Public scan URL — origin comes from the live request so prod / preview /
// local dev each encode their own host into the printed QR.
//
// `pieceNo` (optional) makes the link target ONE physical piece: a DIVAN of 2
// pieces prints 2 stickers that encode `/p/<token>?p=1` and `/p/<token>?p=2`, so
// each can be racked separately (the public route writes piece_pics.racking_number
// for that piece instead of the card-level job_cards.rackingNumber). ADDITIVE:
// when pieceNo is omitted/0 the URL is the bare `/p/<token>` form exactly as
// before — old prints + genuine single-piece cards keep card-level behavior.
export function packingRackScanUrl(
  origin: string,
  token: string,
  pieceNo?: number,
): string {
  const base = `${origin.replace(/\/+$/, "")}/p/${token}`;
  return pieceNo && pieceNo > 0
    ? `${base}?p=${encodeURIComponent(String(pieceNo))}`
    : base;
}
