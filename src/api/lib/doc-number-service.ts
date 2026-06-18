import type { Env } from "../worker";
import { formatDocNo, ymFromDate, resolveDocPrefix } from "../../lib/doc-number";
import type { DocDirection, DocPrefixMap } from "../../lib/doc-number";

export async function getDocNumberPrefixes(db: Env["Variables"]["DB"]): Promise<DocPrefixMap> {
  try {
    const row = await db.prepare("SELECT value FROM kv_config WHERE key = 'doc_number_prefixes'").first<{ value: string | null }>();
    if (row?.value) return JSON.parse(row.value) as DocPrefixMap;
  } catch { /* absent → empty */ }
  return {};
}

export async function issueDocNumber(
  db: Env["Variables"]["DB"],
  opts: { bankAccountCode: string; direction: DocDirection; dateIso: string },
): Promise<string> {
  const cfg = await getDocNumberPrefixes(db);
  const prefix = resolveDocPrefix(cfg, opts.bankAccountCode, opts.direction);
  const ym = ymFromDate(opts.dateIso);
  const row = await db
    .prepare(
      `INSERT INTO doc_no_counters (prefix, ym, next_no) VALUES (?, ?, 2)
       ON CONFLICT (prefix, ym) DO UPDATE SET next_no = doc_no_counters.next_no + 1
       RETURNING next_no`,
    )
    .bind(prefix, ym)
    .first<{ next_no?: number; nextNo?: number }>();
  const newNext = Number(row?.next_no ?? row?.nextNo ?? 2);
  return formatDocNo(prefix, ym, newNext - 1);
}

/**
 * Like issueDocNumber but the caller supplies the prefix directly (no
 * bank-account resolution). Used by features with a fixed prefix per
 * document kind, e.g. Other Party Bills: OCB (creditor) / ODB (debtor).
 * Same atomic counter on doc_no_counters(prefix, ym).
 */
export async function issueDocNumberWithPrefix(
  db: Env["Variables"]["DB"],
  prefix: string,
  dateIso: string,
): Promise<string> {
  const ym = ymFromDate(dateIso);
  const row = await db
    .prepare(
      `INSERT INTO doc_no_counters (prefix, ym, next_no) VALUES (?, ?, 2)
       ON CONFLICT (prefix, ym) DO UPDATE SET next_no = doc_no_counters.next_no + 1
       RETURNING next_no`,
    )
    .bind(prefix, ym)
    .first<{ next_no?: number; nextNo?: number }>();
  const newNext = Number(row?.next_no ?? row?.nextNo ?? 2);
  return formatDocNo(prefix, ym, newNext - 1);
}
