// ---------------------------------------------------------------------------
// Sync fabrics from raw_materials + backfill sales_order_items.fabricId.
//
// Root issue: sales_order_items rows carry `fabricCode` values like "PC151-01"
// and "BO315-21" that come from the BF/SF Master Trackers. Those codes live
// in `raw_materials` (itemGroup IN 'B.M-FABR' / 'S.M-FABR' / 'S-FABRIC'), NOT
// in the `fabrics` master table that the sales form's Fabric dropdown reads.
// As a result the dropdown shows blank on every migrated SO.
//
// Fix (idempotent, all remote):
//   1. Pull raw_materials filtered to the 3 fabric itemGroups via the API.
//   2. Pull existing fabrics via the API.
//   3. For each fabric RM whose itemCode is NOT yet a fabrics.code, INSERT a
//      row into `fabrics` (category mapped B.M-FABR → BM_FABRIC, etc.).
//   4. Rebuild a code → fabricId map from the now-populated fabrics table.
//   5. Backfill sales_order_items.fabricId for rows where fabricCode is set
//      but fabricId is empty.
//
// Uses direct `wrangler d1 execute --remote --file <path>` calls because the
// fabrics and sales-orders routes don't expose the needed mutations and we
// don't want to add surface area just for this one-off sync.
//
// Run: npx tsx scripts/sync-fabrics-from-rm.ts
// ---------------------------------------------------------------------------
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROD = "https://hookka-erp-testing.pages.dev";
const EMAIL = "weisiang329@gmail.com";
const PASSWORD = "CbpxqJQpjy3VA5yd3Q";
const DB_NAME = "hookka-erp-db";

const FABRIC_ITEM_GROUPS = ["B.M-FABR", "S.M-FABR", "S-FABRIC"] as const;
type FabricItemGroup = typeof FABRIC_ITEM_GROUPS[number];

// Map raw_materials.itemGroup → fabrics.category enum used elsewhere in D1.
const CATEGORY_MAP: Record<FabricItemGroup, string> = {
  "B.M-FABR": "BM_FABRIC",
  "S.M-FABR": "SM_FABRIC",
  "S-FABRIC": "S_FABRIC",
};

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function login(): Promise<string> {
  const r = await fetch(`${PROD}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = (await r.json()) as { data?: { token?: string } };
  if (!j.data?.token) throw new Error("login failed");
  return j.data.token;
}

async function getJson<T>(token: string, path: string): Promise<T> {
  const r = await fetch(`${PROD}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return (await r.json()) as T;
}

type RawMaterial = {
  id: string;
  itemCode: string;
  description: string;
  itemGroup: string;
  balanceQty: number;
  minStock: number;
};

type Fabric = {
  id: string;
  code: string;
  name: string;
  category: string;
  priceSen: number;
  sohMeters: number;
  reorderLevel: number;
};

type SalesOrderItem = {
  id: string;
  fabricId: string;
  fabricCode: string;
};

type SalesOrder = {
  id: string;
  items: SalesOrderItem[];
};

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------
function sqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

function makeTmpFile(label: string): string {
  const dir = join(tmpdir(), "hookka-sync-fabrics");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${label}-${Date.now()}.sql`);
}

function execRemoteSqlFile(sqlFile: string, label: string): void {
  try {
    execSync(
      `npx wrangler d1 execute ${DB_NAME} --remote --file "${sqlFile}"`,
      { stdio: "pipe" },
    );
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const msg = (e.stderr?.toString() ?? "") + (e.stdout?.toString() ?? "") + (e.message ?? "");
    throw new Error(`wrangler d1 execute failed [${label}]: ${msg.slice(0, 1200)}`);
  }
}

function genFabricId(): string {
  // Match pattern used in other routes-d1 (e.g. "fab-<uuid8>"), mirrors the
  // existing seed rows that use "fab-1", "fab-2", etc.
  return `fab-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("Logging in…");
  const token = await login();

  console.log("Fetching /api/raw-materials …");
  const rmRes = await getJson<{ data: RawMaterial[] }>(token, "/api/raw-materials");
  const rmFabrics = (rmRes.data ?? []).filter((r) =>
    FABRIC_ITEM_GROUPS.includes(r.itemGroup as FabricItemGroup),
  );
  console.log(`  raw_materials fabric rows: ${rmFabrics.length}`);

  console.log("Fetching /api/fabrics …");
  const fabRes = await getJson<{ data: Fabric[] }>(token, "/api/fabrics");
  const existingFabrics = fabRes.data ?? [];
  console.log(`  fabrics existing rows: ${existingFabrics.length}`);
  const existingCodes = new Set(existingFabrics.map((f) => f.code));

  // ---- Step 1: sync missing fabrics ---------------------------------------
  const toInsert: Array<{
    id: string;
    code: string;
    name: string;
    category: string;
    sohMeters: number;
    reorderLevel: number;
  }> = [];
  for (const rm of rmFabrics) {
    if (existingCodes.has(rm.itemCode)) continue;
    const category = CATEGORY_MAP[rm.itemGroup as FabricItemGroup] ?? "";
    toInsert.push({
      id: genFabricId(),
      code: rm.itemCode,
      name: (rm.description || rm.itemCode).trim(),
      category,
      sohMeters: Number(rm.balanceQty) || 0,
      reorderLevel: Number(rm.minStock) > 0 ? Number(rm.minStock) : 100,
    });
  }
  console.log(`  fabrics to INSERT: ${toInsert.length}`);

  let insertedCount = 0;
  if (toInsert.length > 0) {
    const lines: string[] = [];
    for (const f of toInsert) {
      lines.push(
        `INSERT INTO fabrics (id, code, name, category, priceSen, sohMeters, reorderLevel) VALUES ('${sqlEscape(f.id)}', '${sqlEscape(f.code)}', '${sqlEscape(f.name)}', '${sqlEscape(f.category)}', 0, ${f.sohMeters}, ${f.reorderLevel});`,
      );
    }
    const sqlFile = makeTmpFile("insert-fabrics");
    writeFileSync(sqlFile, lines.join("\n") + "\n", "utf8");
    console.log(`  executing ${lines.length} INSERT statements via ${sqlFile}`);
    execRemoteSqlFile(sqlFile, "insert-fabrics");
    insertedCount = lines.length;
    try { unlinkSync(sqlFile); } catch { /* ignore */ }
  }

  // ---- Step 2: rebuild code → id map from fresh fabrics -------------------
  console.log("Fetching /api/fabrics (post-insert) …");
  const fab2Res = await getJson<{ data: Fabric[] }>(token, "/api/fabrics");
  const codeToFabricId = new Map<string, string>();
  for (const f of fab2Res.data ?? []) {
    // First one wins if duplicate codes exist; with idx_fabrics_code non-unique
    // index dupes are possible but we prefer the earliest row (usually seed).
    if (!codeToFabricId.has(f.code)) codeToFabricId.set(f.code, f.id);
  }
  console.log(`  code → id map size: ${codeToFabricId.size}`);

  // ---- Step 3: backfill sales_order_items.fabricId ------------------------
  console.log("Fetching /api/sales-orders …");
  const sosRes = await getJson<{ data: SalesOrder[] }>(token, "/api/sales-orders");
  const allSos = sosRes.data ?? [];

  type Update = { itemId: string; fabricId: string; fabricCode: string };
  const updates: Update[] = [];
  const unresolvedCodes = new Set<string>();
  for (const so of allSos) {
    for (const item of so.items ?? []) {
      const code = (item.fabricCode ?? "").trim();
      const existingFabId = (item.fabricId ?? "").trim();
      if (!code || existingFabId) continue;
      const fabricId = codeToFabricId.get(code);
      if (!fabricId) {
        unresolvedCodes.add(code);
        continue;
      }
      updates.push({ itemId: item.id, fabricId, fabricCode: code });
    }
  }
  console.log(`  sales_order_items to UPDATE: ${updates.length}`);
  if (unresolvedCodes.size > 0) {
    console.warn(`  ${unresolvedCodes.size} fabric codes still unresolved:`,
      Array.from(unresolvedCodes).slice(0, 20).join(", "),
      unresolvedCodes.size > 20 ? "…" : "");
  }

  let updatedCount = 0;
  if (updates.length > 0) {
    // Chunk into reasonable SQL files so wrangler doesn't choke on one giant batch.
    const CHUNK = 200;
    for (let i = 0; i < updates.length; i += CHUNK) {
      const chunk = updates.slice(i, i + CHUNK);
      const lines = chunk.map((u) =>
        `UPDATE sales_order_items SET fabricId = '${sqlEscape(u.fabricId)}' WHERE id = '${sqlEscape(u.itemId)}' AND (fabricId = '' OR fabricId IS NULL);`,
      );
      const sqlFile = makeTmpFile(`update-soitems-${i}`);
      writeFileSync(sqlFile, lines.join("\n") + "\n", "utf8");
      console.log(`  executing ${lines.length} UPDATE statements (chunk ${i / CHUNK + 1})`);
      execRemoteSqlFile(sqlFile, `update-soitems-${i}`);
      updatedCount += lines.length;
      try { unlinkSync(sqlFile); } catch { /* ignore */ }
    }
  }

  // ---- Step 4: verify ------------------------------------------------------
  console.log("\n=== Summary ===");
  console.log(`  fabrics synced (INSERTs):        ${insertedCount}`);
  console.log(`  sales_order_items backfilled:    ${updatedCount}`);
  console.log(`  unresolved fabric codes:         ${unresolvedCodes.size}`);

  // Sample SO check: find one SO whose items all now have fabricId set.
  const sampleSo = allSos.find(
    (so) => so.items.some((it) => it.fabricCode && !it.fabricId),
  );
  if (sampleSo) {
    console.log(`  sample SO checked: ${sampleSo.id}`);
    const afterRes = await getJson<{ success: boolean; data: SalesOrder }>(
      token,
      `/api/sales-orders/${sampleSo.id}`,
    );
    const after = afterRes.data;
    const firstWithFabric = after.items?.find((it) => it.fabricCode);
    if (firstWithFabric) {
      console.log(
        `    first fabric item: code=${firstWithFabric.fabricCode} fabricId=${firstWithFabric.fabricId || "(empty)"}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
