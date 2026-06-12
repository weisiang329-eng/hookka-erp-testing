// ---------------------------------------------------------------------------
// do-qr-token.ts — shared helpers for the QR dispatch/deliver scan flow.
//
// Both delivery_orders and packing_lists carry a lazily-generated qrtoken
// (migration 0167). The column name is deliberately all-lowercase: unquoted
// camelCase DDL folds to lowercase on Postgres anyway (BUG-2026-06-11-007),
// so spelling it folded keeps SQL, runtime ensure and the migration
// byte-identical.
//
// The token is the ONLY credential for the public /d/<token> page, so it
// must be unguessable: two UUIDs concatenated = 64 random hex chars
// (~244 bits of randomness). Tokens are minted lazily — a row has no public
// page until the office opens its QR dialog / prints a QR.
//
// Used by:
//   • routes/delivery-orders.ts  GET /:id/qr-token   (authed, lazy create)
//   • routes/packing-lists.ts    GET /:id/qr-token   (authed, lazy create)
//   • routes/public-do-qr.ts     GET/POST /:token…   (public resolve)
// ---------------------------------------------------------------------------

export type QrTokenTable = "delivery_orders" | "packing_lists";

export function newQrToken(): string {
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
}

// Runtime self-apply (same pattern as ensureNotifyEmailColumns in
// routes/delivery-orders.ts): deploy ordering can't break the QR endpoints —
// the columns land on first use, and migration 0167 makes them permanent.
let qrColumnsEnsured: Promise<void> | null = null;
export function ensureQrTokenColumns(db: D1Database): Promise<void> {
  if (qrColumnsEnsured) return qrColumnsEnsured;
  qrColumnsEnsured = (async () => {
    const stmts = [
      "ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS qrtoken TEXT",
      "ALTER TABLE packing_lists ADD COLUMN IF NOT EXISTS qrtoken TEXT",
      "CREATE INDEX IF NOT EXISTS ix_delivery_orders_qrtoken ON delivery_orders (qrtoken)",
      "CREATE INDEX IF NOT EXISTS ix_packing_lists_qrtoken ON packing_lists (qrtoken)",
    ];
    for (const sql of stmts) {
      try {
        await db.prepare(sql).run();
      } catch {
        // ignore — column/index may already exist or DDL transiently rejected
      }
    }
  })();
  return qrColumnsEnsured;
}

// Create-if-missing, atomically claimed (UPDATE … WHERE qrtoken IS NULL) so
// two parallel opens of the QR dialog can't mint two diverging tokens — the
// loser re-reads the winner's value. Returns null when the row itself is
// missing.
export async function getOrCreateQrToken(
  db: D1Database,
  table: QrTokenTable,
  id: string,
): Promise<string | null> {
  await ensureQrTokenColumns(db);
  // `table` is a closed union literal (never user input) — safe to inline.
  const read = () =>
    db
      .prepare(`SELECT qrtoken FROM ${table} WHERE id = ?`)
      .bind(id)
      .first<{ qrtoken: string | null }>();
  const row = await read();
  if (!row) return null;
  if (row.qrtoken) return row.qrtoken;
  const fresh = newQrToken();
  await db
    .prepare(
      `UPDATE ${table} SET qrtoken = ? WHERE id = ? AND (qrtoken IS NULL OR qrtoken = '')`,
    )
    .bind(fresh, id)
    .run();
  const after = await read();
  return after?.qrtoken ?? fresh;
}

// Public scan URL — origin comes from the live request so prod / preview /
// local dev each encode their own host into the printed QR.
export function qrScanUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/d/${token}`;
}
