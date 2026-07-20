export async function issueStockAdjustmentNumber(
  db: D1Database,
  orgId: string,
  date = new Date(),
): Promise<string> {
  const yymm = `${String(date.getFullYear()).slice(2)}${String(
    date.getMonth() + 1,
  ).padStart(2, "0")}`;
  const row = await db
    .prepare(
      `INSERT INTO doc_no_counters (prefix, ym, next_no)
       VALUES (?, ?, 2)
       ON CONFLICT (prefix, ym)
       DO UPDATE SET next_no = doc_no_counters.next_no + 1
       RETURNING next_no`,
    )
    .bind(`${orgId}:ADJ`, yymm)
    .first<{ next_no?: number; nextNo?: number }>();
  const next = Number(row?.next_no ?? row?.nextNo ?? 2);
  return `ADJ-${yymm}-${String(next - 1).padStart(3, "0")}`;
}
