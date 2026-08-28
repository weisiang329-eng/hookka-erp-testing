// ---------------------------------------------------------------------------
// unit-price-precision — the ONE definition of "a unit price is a rate with
// four decimals of sen", and the only thing that applies it to production.
//
// ## The money
//
// OCEAN SKY invoice 2608-461: "NAIL LEG 5/8 — 600 PCS @ 0.05500 = 33.00".
// Stored in an INTEGER sen column, RM 0.055 becomes 6 sen, and 600 x RM 0.06
// is RM 36.00 — RM 3.00 invented on one line. It is invisible on screen
// because the line total is recomputed FROM the rounded rate, so the document
// is internally consistent and disagrees only with the supplier's paper.
//
// Owner 2026-08-28: 「我需要给 rm0.055 然后变成给 0.06 不是代表给多了吗
// account 怎么能对账呢」 — 「全部啊 我们的 FE BE DB 都要可以」.
//
//   FE  MoneyInput step="0.0001"            — the keystroke is accepted
//   BE  lib/unit-price.ts lineTotalSen()    — multiply first, round ONCE
//   DB  this file                           — the column can hold it
//
// A rate carries the precision; an AMOUNT that changes hands stays integer
// sen. That asymmetry is deliberate and is why only these three columns move.
//
// ## Why it does not live in the three route files any more
//
// It did, as three copies of one ALTER inside each module's big self-apply
// block. Migrations are inert on deploy in this repo (CLAUDE.md) — schema
// reaches production only through a self-apply awaited at the top of a
// handler — and each of those blocks is awaited on WRITES only. So the fix
// shipped on 2026-08-28 and the column stayed INTEGER until somebody happened
// to save a purchase invoice. Nobody could say whether it had happened yet,
// which is the same "an absence read as a value" shape that has cost this repo
// three separate bugs this month.
//
// Now: one definition, applied from the READ paths as well, so merely opening
// the Purchase Invoice / PO / GRN list is enough. It costs one cheap
// information_schema SELECT per isolate and issues DDL only for a column that
// is actually still too narrow — so the steady state is a read, not a lock.
// ---------------------------------------------------------------------------
import { runSelfApply, memoizeSelfApply } from "./self-apply";
// The columns, the required scale and the "is it wide enough" decision live in
// the zero-import money module so a plain `node --test` can EXECUTE them; this
// file is the plumbing that carries the answer to the database.
import {
  UNIT_PRICE_COLUMNS,
  UNIT_PRICE_DECIMALS,
  precisionOk,
  widenUnitPriceSql,
} from "../../lib/unit-price";

export { UNIT_PRICE_COLUMNS, UNIT_PRICE_DECIMALS };

export type PrecisionRow = {
  table: string;
  column: string;
  /** null when the column is absent from this database. */
  dataType: string | null;
  /** null for a non-numeric type (integer reports no scale). */
  scale: number | null;
  ok: boolean;
};

/**
 * READ the live schema. This is the measurement — CLAUDE.md's rule is that a
 * claim about production state is either measured or carries the word
 * UNMEASURED, and "the migration says NUMERIC(14,4)" is a claim about history.
 *
 * information_schema identifiers are NOT in column-rename-map.json, so the SQL
 * passes through the supabase-compat rewriter unchanged; postgres.js camelCases
 * the RESULT keys, hence the dual-key reads.
 */
export async function readUnitPricePrecision(
  db: D1Database,
): Promise<PrecisionRow[]> {
  const tables = [...new Set(UNIT_PRICE_COLUMNS.map((c) => c.table))];
  const res = await db
    .prepare(
      `SELECT table_name, column_name, data_type, numeric_scale
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN (${tables.map(() => "?").join(",")})`,
    )
    .bind(...tables)
    .all<{
      tableName?: string;
      table_name?: string;
      columnName?: string;
      column_name?: string;
      dataType?: string;
      data_type?: string;
      numericScale?: number | null;
      numeric_scale?: number | null;
    }>();

  const found = new Map<string, { dataType: string; scale: number | null }>();
  for (const r of res.results ?? []) {
    const t = String(r.tableName ?? r.table_name ?? "");
    const col = String(r.columnName ?? r.column_name ?? "");
    if (!t || !col) continue;
    const rawScale = r.numericScale ?? r.numeric_scale;
    found.set(`${t}.${col}`, {
      dataType: String(r.dataType ?? r.data_type ?? ""),
      scale: rawScale == null ? null : Number(rawScale),
    });
  }

  return UNIT_PRICE_COLUMNS.map(({ table, column }) => {
    const hit = found.get(`${table}.${column}`);
    const scale = hit?.scale ?? null;
    return {
      table,
      column,
      dataType: hit?.dataType ?? null,
      scale,
      ok: precisionOk(hit?.dataType ?? null, scale),
    };
  });
}

let memo: Promise<void> | null = null;

/**
 * Widen any unit-price column that is still too narrow, once per isolate.
 *
 * integer → numeric is a WIDENING conversion: every existing value is already
 * a valid numeric, so no data moves and no USING clause is needed. Safe to
 * call from a read handler.
 *
 * Failures are not memoised as success (see self-apply.ts) — a transient blip
 * on a cold pool must not leave the column narrow for the life of the isolate,
 * which is exactly the failure mode the shared helper was written for.
 */
export function ensureUnitPricePrecision(db: D1Database): Promise<void> {
  return memoizeSelfApply(
    () => memo,
    (p) => {
      memo = p;
    },
    async () => {
      // Probe first. After the first application this is the whole cost of the
      // call — one indexed catalogue read, no ACCESS EXCLUSIVE lock, on a path
      // that now includes page loads.
      const rows = await readUnitPricePrecision(db);
      const narrow = rows.filter((r) => !r.ok && r.dataType != null);
      if (narrow.length === 0) return;
      await runSelfApply(
        db,
        "unit-price-precision",
        narrow.map((r) => widenUnitPriceSql(r.table, r.column)),
      );
    },
  );
}

/** Test seam only — lets a test observe a second call re-probing. */
export function __resetUnitPricePrecisionMemo(): void {
  memo = null;
}
