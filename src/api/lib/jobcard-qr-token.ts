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
    for (const sql of stmts) {
      try {
        await db.prepare(sql).run();
      } catch {
        // ignore — column/index may already exist or DDL transiently rejected
      }
    }
  })();
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
  const after = await read();
  return after?.qr_token ?? fresh;
}

// Public scan URL — origin comes from the live request so prod / preview /
// local dev each encode their own host into the printed QR.
export function packingRackScanUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/p/${token}`;
}
