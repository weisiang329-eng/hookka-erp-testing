// ---------------------------------------------------------------------------
// Pay-rule versions — storage + loader.
//
// Columns are deliberately ALL-LOWERCASE: runtime DDL goes through the
// d1-compat adapter whose identifier rewrite only knows the static rename map,
// so unknown camelCase identifiers get folded to lowercase by Postgres anyway
// (BUG-2026-06-11-007). Naming them lowercase from the start keeps DDL, DML
// and SELECT * keys identical — no dual-key reads needed.
// ---------------------------------------------------------------------------
import {
  type PayRuleVersion,
  normalizePayRules,
} from "../../lib/pay-rules";

let _mig = false;
export async function ensurePayRuleVersions(db: D1Database): Promise<void> {
  if (_mig) return;

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS pay_rule_versions (
         id TEXT PRIMARY KEY,
         effectivefrom TEXT NOT NULL,
         rulesjson TEXT NOT NULL,
         note TEXT,
         createdat TEXT,
         createdby TEXT
       )`,
    )
    .run();
  _mig = true;
}

type Row = {
  id: string;
  effectivefrom: string;
  rulesjson: string;
  note: string | null;
  createdat: string | null;
  createdby: string | null;
};

/** All versions, defaults-normalised, unsorted. Resilient: any failure →
 *  empty list → every consumer falls back to DEFAULT_PAY_RULES. */
export async function loadPayRuleVersions(
  db: D1Database,
): Promise<PayRuleVersion[]> {
  try {
    await ensurePayRuleVersions(db);
    const res = await db
      .prepare("SELECT * FROM pay_rule_versions")
      .all<Row>();
    return (res.results ?? []).map((r) => {
      let raw: unknown = {};
      try {
        raw = JSON.parse(r.rulesjson || "{}");
      } catch {
        raw = {};
      }
      return {
        id: r.id,
        effectiveFrom: r.effectivefrom,
        rules: normalizePayRules(raw),
        createdAt: r.createdat ?? undefined,
        createdBy: r.createdby ?? null,
        note: r.note ?? null,
      };
    });
  } catch (e) {
    console.warn("[pay-rules] load skipped (defaults apply):", e);
    return [];
  }
}
