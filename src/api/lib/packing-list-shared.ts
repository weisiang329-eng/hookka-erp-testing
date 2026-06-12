// ---------------------------------------------------------------------------
// packing-list-shared.ts — helpers shared by the two truck-run "packing list"
// families:
//   • DELIVERY packing lists  — table packing_lists,    do_ids → delivery_orders
//     (routes/packing-lists.ts, migration 0139)
//   • CONSIGNMENT packing lists — table cn_packing_lists, cn_ids → consignment_notes
//     (routes/cn-packing-lists.ts, migration 0170)
//
// Both group several shipping documents going on ONE truck run into a single
// saved record the warehouse prints. The id-array parse + the running-number
// generator + the address-normaliser are byte-identical between the two, so
// they live here once instead of drifting across two copies.
//
// NOTE: routes/packing-lists.ts (the DO side) predates this module and keeps
// its OWN private copies of parseIds / genNextPackingNo (the CN/DO parity
// project must not touch the DO route). The CN route uses THESE shared ones.
// If the DO route is ever refactored, point it here too — the behaviour is
// identical by construction (the DO copies were the template for these).
// ---------------------------------------------------------------------------

// Parse a stored JSON-array-of-ids column (do_ids / cn_ids) into a string[].
// Tolerant: a NULL / malformed / non-array value yields []. Non-string
// elements are dropped.
export function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

// Normalise a delivery address for DISTINCT-stop counting: trim, collapse
// internal whitespace, lowercase. Used only for comparison (4 docs to the
// SAME address = 1 stop), never for display.
export function normAddr(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

// Next running packing number for a table, scoped per org + prefix.
//   prefix "PL"  → PL-YYMM-NNN  (delivery packing lists)
//   prefix "CPL" → CPL-YYMM-NNN (consignment packing lists)
// `table` and the `packing_no` column are inlined into the SQL — both are
// closed literals chosen by the caller, never user input.
//
// The query reads the highest existing number for THIS org + THIS YYMM prefix
// and increments its 3-digit tail (back to 001 on the first of a month or a
// malformed tail). Columns are snake_case in the SQL; the single result is
// read as camelCase (packingNo) — the postgres adapter rewrites identifiers IN
// and camelCases result keys OUT (same convention as the DO route).
export async function genNextPackingNo(
  db: D1Database,
  table: "packing_lists" | "cn_packing_lists",
  prefix: "PL" | "CPL",
  orgId: string,
  now: Date = new Date(),
): Promise<string> {
  const yymm = `${String(now.getFullYear()).slice(2)}${String(
    now.getMonth() + 1,
  ).padStart(2, "0")}`;
  const full = `${prefix}-${yymm}-`;
  const res = await db
    .prepare(
      `SELECT packing_no FROM ${table} WHERE org_id = ? AND packing_no LIKE ? ORDER BY packing_no DESC LIMIT 1`,
    )
    .bind(orgId, `${full}%`)
    .first<{ packingNo: string }>();
  if (!res || !res.packingNo) return `${full}001`;
  const seq = parseInt(res.packingNo.replace(full, ""), 10);
  if (!Number.isFinite(seq)) return `${full}001`;
  return `${full}${String(seq + 1).padStart(3, "0")}`;
}
