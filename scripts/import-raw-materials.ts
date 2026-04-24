// ---------------------------------------------------------------------------
// Import raw material master from AutoCount export (xlsx) → REMOTE D1.
//
// Source : C:/Users/User/Downloads/raw material.xlsx (single "Sheet" tab)
// Columns: Item Code | Base UOM | UOM Count | Description | Item Group |
//          Item Type | Stock Control | Is Active | Total Bal. Qty |
//          Main Supplier
//
// IMPORTANT behaviours (per user amendment):
//   * `Total Bal. Qty` is IGNORED. D1 `balanceQty` is the source of truth
//     (kept fresh by GRN receipts). On INSERT the server defaults it to 0;
//     on UPDATE the server leaves it alone (bulk-import endpoint).
//   * After the upsert, any raw_materials row whose `itemCode` is NOT in
//     the sheet (case-insensitive, trimmed) is DELETED, EXCEPT fabric
//     groups (`B.M-FABR`, `S.M-FABR`, `S-FABRIC`) which live in the Fab
//     Maint tab of Production Sheet (preserved).
//   * FK-safe deletion: cost_ledger rows referencing the stale rm/batches
//     are wiped first, then rm_batches (FK cascade handles this once
//     raw_materials goes, but we do it explicitly to keep the window
//     clean), then raw_materials.
//
// Run: npx tsx scripts/import-raw-materials.ts
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
// xlsx is a CJS module — import via require so tsx doesn't choke on it.
 
const xl = require("xlsx") as typeof import("xlsx");

const SHEET = "C:/Users/User/Downloads/raw material.xlsx";
const PROD = "https://hookka-erp-testing.pages.dev";
const EMAIL = "weisiang329@gmail.com";
const PASSWORD = "CbpxqJQpjy3VA5yd3Q";

// Fabric item groups — these codes live in the Fab Maint tab of Production
// Sheet, not in raw material.xlsx. NEVER delete them even if they're missing
// from raw material.xlsx.
const FABRIC_GROUPS = new Set(["B.M-FABR", "S.M-FABR", "S-FABRIC"]);

type SheetRow = {
  "Item Code"?: unknown;
  "Base UOM"?: unknown;
  "UOM Count"?: unknown;
  Description?: unknown;
  "Item Group"?: unknown;
  "Item Type"?: unknown;
  "Stock Control"?: unknown;
  "Is Active"?: unknown;
  "Total Bal. Qty"?: unknown;
  "Main Supplier"?: unknown;
};

type RmApi = {
  id: string;
  itemCode: string;
  itemGroup: string;
};

type Payload = {
  itemCode: string;
  description: string;
  baseUOM: string;
  unit: string;
  uomCount: number;
  itemGroup: string;
  itemType: string | null;
  stockControl: boolean;
  isActive: boolean;
  status: "ACTIVE" | "INACTIVE";
  mainSupplierCode: string | null;
  minStock: number;
  maxStock: number;
  // NOTE: balanceQty is DELIBERATELY omitted — server defaults to 0 on insert
  // and leaves existing rows untouched on update (bulk-import endpoint).
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function login(): Promise<string> {
  const r = await fetch(`${PROD}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = (await r.json()) as { data?: { token?: string } };
  if (!j.data?.token) throw new Error("login failed: " + JSON.stringify(j));
  return j.data.token;
}

function s(v: unknown): string {
  return (v == null ? "" : String(v)).trim();
}

function n(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }
  return 0;
}

function checked(v: unknown): boolean {
  return s(v).toLowerCase() === "checked";
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

function rowToPayload(row: SheetRow): Payload | null {
  const itemCode = s(row["Item Code"]);
  if (!itemCode) return null;
  const baseUOM = s(row["Base UOM"]) || "PCS";
  const uomCount = n(row["UOM Count"]) || 1;
  const description = s(row["Description"]) || itemCode;
  const itemGroup = s(row["Item Group"]) || "OTHERS";
  const itemType = s(row["Item Type"]) || null;
  const stockControl = checked(row["Stock Control"]);
  const isActive = checked(row["Is Active"]);
  const mainSupplierCode = s(row["Main Supplier"]) || null;
  return {
    itemCode,
    description,
    baseUOM,
    unit: baseUOM,
    uomCount,
    itemGroup,
    itemType,
    stockControl,
    isActive,
    status: isActive ? "ACTIVE" : "INACTIVE",
    mainSupplierCode,
    minStock: 0,
    maxStock: 0,
  };
}

async function listExisting(token: string): Promise<RmApi[]> {
  const r = await fetch(`${PROD}/api/raw-materials`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const j = (await r.json()) as { success?: boolean; data?: RmApi[] };
  if (!j.success || !Array.isArray(j.data)) {
    throw new Error("list raw-materials failed: " + JSON.stringify(j).slice(0, 300));
  }
  return j.data;
}

async function bulkImport(
  token: string,
  rows: Payload[],
): Promise<{ created: number; updated: number }> {
  const r = await fetch(`${PROD}/api/raw-materials/bulk-import`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ rows }),
  });
  if (!r.ok) {
    throw new Error(`bulk-import ${r.status} ${(await r.text()).slice(0, 400)}`);
  }
  const j = (await r.json()) as {
    success?: boolean;
    data?: { created: number; updated: number };
  };
  if (!j.success || !j.data) {
    throw new Error("bulk-import returned non-ok: " + JSON.stringify(j).slice(0, 300));
  }
  return j.data;
}

// Run a SQL command against remote D1 via wrangler. stdout captured so we
// don't flood the terminal; we throw if wrangler exits non-zero.
function execRemoteSql(sql: string, label: string): void {
  const oneLine = sql.replace(/\s+/g, " ").trim();
  console.log(`  SQL [${label}]: ${oneLine.slice(0, 140)}${oneLine.length > 140 ? "…" : ""}`);
  try {
    execSync(
      `npx wrangler d1 execute hookka-erp-db --remote --command "${oneLine.replace(/"/g, '\\"')}"`,
      { stdio: "pipe" },
    );
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const msg = (e.stderr?.toString() ?? "") + (e.stdout?.toString() ?? "") + (e.message ?? "");
    throw new Error(`wrangler d1 execute failed [${label}]: ${msg.slice(0, 600)}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("Reading", SHEET);
  const wb = xl.readFile(SHEET);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xl.utils.sheet_to_json<SheetRow>(ws, { defval: "" });
  console.log(`Sheet has ${rows.length} data rows`);

  const payloads: Payload[] = [];
  const sheetCodesNorm = new Set<string>();
  let skipped = 0;
  for (const row of rows) {
    const p = rowToPayload(row);
    if (!p) { skipped++; continue; }
    payloads.push(p);
    sheetCodesNorm.add(normalizeCode(p.itemCode));
  }
  console.log(`Parsed ${payloads.length} payloads (skipped ${skipped} empty codes)`);

  console.log("Logging in to", PROD);
  const token = await login();

  console.log("Fetching existing raw-materials…");
  const beforeList = await listExisting(token);
  console.log(`  ${beforeList.length} existing items in D1`);

  console.log("POST /api/raw-materials/bulk-import");
  const { created, updated } = await bulkImport(token, payloads);
  console.log(`  inserted=${created} updated=${updated}`);

  console.log("Fetching post-import raw-materials for stale-scan…");
  const afterList = await listExisting(token);

  const stale: RmApi[] = [];
  const preservedFabric: RmApi[] = [];
  for (const rm of afterList) {
    const norm = normalizeCode(rm.itemCode);
    if (sheetCodesNorm.has(norm)) continue;
    if (FABRIC_GROUPS.has(rm.itemGroup)) {
      preservedFabric.push(rm);
      continue;
    }
    stale.push(rm);
  }
  console.log(`  stale (to delete): ${stale.length}`);
  console.log(`  fabric preserved:  ${preservedFabric.length}`);

  let deletedCount = 0;
  if (stale.length > 0) {
    const ids = stale.map((r) => `'${r.id.replace(/'/g, "''")}'`).join(",");

    // 1. Wipe cost_ledger rows that reference the stale raw_materials or
    //    their child batches. cost_ledger has no FK, so SQLite won't
    //    cascade; we must clean it up before the rm_batches rows vanish.
    execRemoteSql(
      `DELETE FROM cost_ledger WHERE (itemType='RM' AND itemId IN (${ids})) OR batchId IN (SELECT id FROM rm_batches WHERE rmId IN (${ids}))`,
      "cost_ledger",
    );

    // 2. Wipe rm_batches for stale rm ids. (FK cascade from raw_materials
    //    would also clean these up, but we want the cleanup to be visible
    //    and deterministic.)
    execRemoteSql(
      `DELETE FROM rm_batches WHERE rmId IN (${ids})`,
      "rm_batches",
    );

    // 3. Wipe the raw_materials rows themselves.
    execRemoteSql(
      `DELETE FROM raw_materials WHERE id IN (${ids})`,
      "raw_materials",
    );

    deletedCount = stale.length;
  }

  console.log("\n==================== IMPORT REPORT ====================");
  console.log(`Sheet rows parsed:       ${payloads.length}`);
  console.log(`D1 before:               ${beforeList.length}`);
  console.log(`Inserted:                ${created}`);
  console.log(`Updated:                 ${updated}`);
  console.log(`Deleted (stale):         ${deletedCount}`);
  console.log(`Fabric preserved:        ${preservedFabric.length}`);
  console.log(`Skipped (empty codes):   ${skipped}`);
  if (stale.length > 0) {
    console.log("\nDeleted itemCodes:");
    for (const r of stale) console.log(`  - ${r.itemCode}  (${r.itemGroup})`);
  }
  if (preservedFabric.length > 0) {
    console.log("\nPreserved fabric itemCodes (missing from raw material.xlsx):");
    for (const r of preservedFabric) console.log(`  - ${r.itemCode}  (${r.itemGroup})`);
  }
  console.log("========================================================\n");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
