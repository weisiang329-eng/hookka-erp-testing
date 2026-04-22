// ---------------------------------------------------------------------------
// Backfill fabric cascade.
//
// For every raw_materials row with itemGroup in ('B.M-FABR','S.M-FABR','S-FABRIC'):
//   1. Ensure a matching row in `fabrics` (keyed by code).  INSERT OR IGNORE —
//      never overwrite existing priceSen.
//   2. Ensure a matching row in `fabric_trackings` (keyed by fabricCode).
//      INSERT OR IGNORE — never overwrite existing priceTier/price/usage.
//   3. Backfill `sales_order_items.fabricId` — for every item with fabricCode
//      but no fabricId, set fabricId = fabrics.id where fabrics.code = fabricCode.
//
// Targets REMOTE D1 via wrangler d1 execute. Idempotent — rerunning is safe.
//
// Category mapping (see src/api/routes-d1/_fabric-cascade.ts for rationale):
//   raw_materials.itemGroup  → fabrics.category   → fabric_trackings.fabricCategory
//   B.M-FABR                 → BM_FABRIC          → B.M-FABR
//   S.M-FABR                 → SM_FABRIC          → S.M-FABR
//   S-FABRIC                 → S_FABRIC           → S-FABR        (CHECK-enforced)
//
// Run: npx tsx scripts/backfill-fabric-cascade.ts
// ---------------------------------------------------------------------------
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type RmRow = {
  id: string;
  itemCode: string;
  description: string;
  itemGroup: string;
  balanceQty: number;
};

type FabricRow = { id: string; code: string };
type TrackingRow = { id: string; fabricCode: string };

function itemGroupToFabricCategory(g: string): string | null {
  if (g === "B.M-FABR") return "BM_FABRIC";
  if (g === "S.M-FABR") return "SM_FABRIC";
  if (g === "S-FABRIC") return "S_FABRIC";
  return null;
}
function itemGroupToTrackingCategory(g: string): string | null {
  if (g === "B.M-FABR") return "B.M-FABR";
  if (g === "S.M-FABR") return "S.M-FABR";
  if (g === "S-FABRIC") return "S-FABR"; // CHECK constraint quirk
  return null;
}

function d1ExecJson<T>(sql: string): T[] {
  const out = execSync(
    `npx wrangler d1 execute hookka-erp-db --remote --json --command ${JSON.stringify(sql)}`,
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  // wrangler d1 execute --json wraps results as [{ results: [...] }] or similar.
  const parsed = JSON.parse(out);
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const rows: T[] = [];
  for (const entry of arr) {
    if (Array.isArray(entry?.results)) rows.push(...(entry.results as T[]));
    else if (Array.isArray(entry?.result?.[0]?.results))
      rows.push(...(entry.result[0].results as T[]));
  }
  return rows;
}

function d1ExecFile(sqlLines: string[]): void {
  if (sqlLines.length === 0) return;
  const tmp = path.join(os.tmpdir(), `backfill-fabrics-${Date.now()}.sql`);
  fs.writeFileSync(tmp, sqlLines.join("\n") + "\n", "utf8");
  try {
    execSync(
      `npx wrangler d1 execute hookka-erp-db --remote --file ${JSON.stringify(tmp)}`,
      { stdio: "inherit" },
    );
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function sqlEscape(s: string | null | undefined): string {
  if (s === null || s === undefined) return "NULL";
  return `'${String(s).replace(/'/g, "''")}'`;
}

function genFabricId(): string {
  return `fab-${randomUUID().slice(0, 8)}`;
}
function genTrackingId(): string {
  return `ft-${randomUUID().slice(0, 8)}`;
}

function main(): void {
  console.log("[backfill] fetching raw_materials fabrics...");
  const rms = d1ExecJson<RmRow>(
    `SELECT id, itemCode, description, itemGroup, balanceQty FROM raw_materials WHERE itemGroup IN ('B.M-FABR','S.M-FABR','S-FABRIC')`,
  );
  console.log(`[backfill] ${rms.length} fabric raw_materials`);

  console.log("[backfill] fetching existing fabrics + fabric_trackings...");
  const fabricsExisting = d1ExecJson<FabricRow>(`SELECT id, code FROM fabrics`);
  const trackingsExisting = d1ExecJson<TrackingRow>(
    `SELECT id, fabricCode FROM fabric_trackings`,
  );
  const fabByCode = new Map<string, string>();
  for (const f of fabricsExisting) fabByCode.set(f.code, f.id);
  const trackByCode = new Set<string>(trackingsExisting.map((t) => t.fabricCode));
  console.log(
    `[backfill] existing fabrics=${fabricsExisting.length}, trackings=${trackingsExisting.length}`,
  );

  const sqlLines: string[] = [];
  let fabInserted = 0;
  let trackInserted = 0;

  for (const rm of rms) {
    const fabCat = itemGroupToFabricCategory(rm.itemGroup);
    const trackCat = itemGroupToTrackingCategory(rm.itemGroup);
    if (!fabCat || !trackCat) continue;
    const desc = rm.description || rm.itemCode;
    const balance = Number(rm.balanceQty) || 0;

    if (!fabByCode.has(rm.itemCode)) {
      const fid = genFabricId();
      sqlLines.push(
        `INSERT OR IGNORE INTO fabrics (id, code, name, category, priceSen, sohMeters, reorderLevel) VALUES (${sqlEscape(
          fid,
        )}, ${sqlEscape(rm.itemCode)}, ${sqlEscape(desc)}, ${sqlEscape(
          fabCat,
        )}, 0, ${balance}, 0);`,
      );
      fabByCode.set(rm.itemCode, fid);
      fabInserted++;
    }
    if (!trackByCode.has(rm.itemCode)) {
      const tid = genTrackingId();
      sqlLines.push(
        `INSERT OR IGNORE INTO fabric_trackings (id, fabricCode, fabricDescription, fabricCategory, priceTier, price, soh, poOutstanding, lastMonthUsage, oneWeekUsage, twoWeeksUsage, oneMonthUsage, shortage, reorderPoint, supplier, leadTimeDays) VALUES (${sqlEscape(
          tid,
        )}, ${sqlEscape(rm.itemCode)}, ${sqlEscape(desc)}, ${sqlEscape(
          trackCat,
        )}, 'PRICE_2', 0, ${balance}, 0, 0, 0, 0, 0, 0, 0, NULL, 0);`,
      );
      trackByCode.add(rm.itemCode);
      trackInserted++;
    }
  }

  // sales_order_items.fabricId backfill — set fabricId from fabrics.code match
  // for any item that has fabricCode but no fabricId.
  sqlLines.push(
    `UPDATE sales_order_items SET fabricId = (SELECT f.id FROM fabrics f WHERE f.code = sales_order_items.fabricCode LIMIT 1) WHERE fabricCode IS NOT NULL AND fabricCode != '' AND (fabricId IS NULL OR fabricId = '') AND EXISTS (SELECT 1 FROM fabrics f WHERE f.code = sales_order_items.fabricCode);`,
  );

  console.log(
    `[backfill] planned: ${fabInserted} fabrics + ${trackInserted} trackings + 1 SOI fabricId update`,
  );

  if (sqlLines.length === 0) {
    console.log("[backfill] nothing to do");
    return;
  }

  console.log("[backfill] applying to REMOTE...");
  d1ExecFile(sqlLines);

  console.log("[backfill] verifying...");
  const fabAfter = d1ExecJson<{ n: number }>(`SELECT COUNT(*) AS n FROM fabrics`);
  const trackAfter = d1ExecJson<{ n: number }>(
    `SELECT COUNT(*) AS n FROM fabric_trackings`,
  );
  const soiAfter = d1ExecJson<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sales_order_items WHERE fabricCode IS NOT NULL AND fabricCode != '' AND fabricId IS NOT NULL AND fabricId != ''`,
  );
  const soiMissing = d1ExecJson<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sales_order_items WHERE fabricCode IS NOT NULL AND fabricCode != '' AND (fabricId IS NULL OR fabricId = '')`,
  );
  console.log(
    `[backfill] AFTER: fabrics=${fabAfter[0]?.n ?? "?"}, trackings=${trackAfter[0]?.n ?? "?"}, SOI with fabricId=${soiAfter[0]?.n ?? "?"}, SOI missing fabricId=${soiMissing[0]?.n ?? "?"}`,
  );
  console.log(
    `[backfill] summary: fabrics inserted=${fabInserted}, trackings inserted=${trackInserted}`,
  );
}

main();
