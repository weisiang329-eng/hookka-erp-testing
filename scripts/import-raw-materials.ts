// ---------------------------------------------------------------------------
// Import raw material master from AutoCount export (xlsx) → REMOTE D1.
//
// Source : C:/Users/User/Downloads/raw material.xlsx (single "Sheet" tab)
// Columns: Item Code | Base UOM | UOM Count | Description | Item Group |
//          Item Type | Stock Control | Is Active | Total Bal. Qty |
//          Main Supplier
//
// Strategy:
//   1. Login to REMOTE deployment → JWT token.
//   2. GET /api/raw-materials → map of existing itemCodes.
//   3. For each sheet row with a non-empty Item Code:
//        - existing  → PUT /api/raw-materials/:id   (idempotent update)
//        - new       → POST /api/raw-materials      (insert)
//   4. Report per-row ok / updated / failed counts.
//
// Run: npx tsx scripts/import-raw-materials.ts
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// xlsx is a CJS module — import via require so tsx doesn't choke on it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const xl = require("xlsx") as typeof import("xlsx");

const SHEET = "C:/Users/User/Downloads/raw material.xlsx";
const PROD = "https://hookka-erp-testing.pages.dev";
const EMAIL = "weisiang329@gmail.com";
const PASSWORD = "CbpxqJQpjy3VA5yd3Q";

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
};

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
  balanceQty: number;
  mainSupplierCode: string | null;
  minStock: number;
  maxStock: number;
};

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
  const balanceQty = n(row["Total Bal. Qty"]);
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
    balanceQty,
    mainSupplierCode,
    minStock: 0,
    maxStock: 0,
  };
}

async function listExisting(token: string): Promise<Map<string, string>> {
  const r = await fetch(`${PROD}/api/raw-materials`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const j = (await r.json()) as { success?: boolean; data?: RmApi[] };
  if (!j.success || !Array.isArray(j.data)) {
    throw new Error("list raw-materials failed: " + JSON.stringify(j).slice(0, 300));
  }
  const map = new Map<string, string>();
  for (const x of j.data) map.set(x.itemCode, x.id);
  return map;
}

async function postNew(token: string, p: Payload): Promise<{ ok: true } | { ok: false; err: string }> {
  const r = await fetch(`${PROD}/api/raw-materials`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(p),
  });
  if (r.ok) return { ok: true };
  const txt = await r.text();
  return { ok: false, err: `POST ${r.status} ${txt.slice(0, 200)}` };
}

async function putExisting(
  token: string,
  id: string,
  p: Payload,
): Promise<{ ok: true } | { ok: false; err: string }> {
  const r = await fetch(`${PROD}/api/raw-materials/${id}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(p),
  });
  if (r.ok) return { ok: true };
  const txt = await r.text();
  return { ok: false, err: `PUT ${r.status} ${txt.slice(0, 200)}` };
}

async function main() {
  console.log("Reading", SHEET);
  const wb = xl.readFile(SHEET);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xl.utils.sheet_to_json<SheetRow>(ws, { defval: "" });
  console.log(`Sheet has ${rows.length} data rows`);

  console.log("Logging in to", PROD);
  const token = await login();

  console.log("Fetching existing raw-materials…");
  const existing = await listExisting(token);
  console.log(`  ${existing.size} existing items in D1`);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const row of rows) {
    const p = rowToPayload(row);
    if (!p) { skipped++; continue; }
    const existingId = existing.get(p.itemCode);
    if (existingId) {
      const res = await putExisting(token, existingId, p);
      if (res.ok) {
        updated++;
      } else {
        failed++;
        errors.push(`[updated ${p.itemCode}] ${res.err}`);
      }
    } else {
      const res = await postNew(token, p);
      if (res.ok) {
        inserted++;
        // Don't re-POST if the same code appears again (shouldn't happen but be safe)
        existing.set(p.itemCode, "inserted");
      } else {
        failed++;
        errors.push(`[new ${p.itemCode}] ${res.err}`);
      }
    }
    if ((inserted + updated + failed) % 25 === 0) {
      console.log(`  progress: inserted=${inserted} updated=${updated} failed=${failed}`);
    }
  }

  console.log("---");
  console.log(`Inserted: ${inserted}`);
  console.log(`Updated : ${updated}`);
  console.log(`Skipped : ${skipped} (empty codes)`);
  console.log(`Failed  : ${failed}`);
  if (errors.length) {
    console.log("Errors (first 10):");
    for (const e of errors.slice(0, 10)) console.log(" -", e);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
