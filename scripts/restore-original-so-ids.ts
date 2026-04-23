// Restore original Company SO / Customer PO / Customer SO IDs from the
// sheet. The earlier migration:
//   (a) let the API auto-generate companySOId like SO-2604-179 instead of
//       using the sheet's "Company SO" column (e.g. SO-2603-226).
//   (b) stored customerPOId / customerSOId with the -NN line-item suffix
//       baked into the base field ("PO-008521-01" instead of "PO-008521").
//
// This script re-reads the sheet, builds a mapping keyed by Customer PO
// base (col A), and UPDATEs each sales_orders row to the sheet's original
// triplet. Line suffixes continue to live on sales_order_items.lineSuffix
// and on the production_orders derived from each SO.
//
// Usage:
//   npx tsx scripts/restore-original-so-ids.ts [--dry-run]

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const xl = require("xlsx") as typeof import("xlsx");

const SHEET = "C:/Users/User/Downloads/Production Sheet (9).xlsx";
const DRY = process.argv.includes("--dry-run");

type SheetRow = Record<string, unknown>;

type Triplet = {
  customerPO: string;
  customerSO: string;
  companySO: string;
};

function str(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function stripSuffix(id: string): string {
  // "PO-008521-01" → "PO-008521",  "SO-2603-226-02" → "SO-2603-226".
  // Only strip trailing -NN where NN is 1-3 digits — leaves dates alone.
  return id.replace(/-\d{1,3}$/, "");
}

function readSheet(): Map<string, Triplet> {
  if (!fs.existsSync(SHEET)) throw new Error(`sheet missing: ${SHEET}`);
  const wb = xl.readFile(SHEET);
  const map = new Map<string, Triplet>();

  for (const tabName of ["BF Master Tracker", "SF Master Tracker"]) {
    const ws = wb.Sheets[tabName];
    if (!ws) {
      console.log(`[warn] tab missing: ${tabName}`);
      continue;
    }
    // Header is at row 11 (0-indexed 10). Data starts at row 12 (index 11).
    const aoa: unknown[][] = xl.utils.sheet_to_json(ws, {
      header: 1,
      defval: "",
    });
    const header = aoa[10] as string[];
    const headerMap = new Map<string, number>();
    header.forEach((h, i) => headerMap.set(String(h), i));
    const rows: SheetRow[] = [];
    for (let i = 11; i < aoa.length; i++) {
      const r = aoa[i];
      if (!r || r.every((c) => c === "" || c == null)) continue;
      const o: SheetRow = {};
      for (const [h, idx] of headerMap) o[h] = r[idx];
      rows.push(o);
    }

    for (const row of rows) {
      const customerPO = str(row["Customer PO"]);
      if (!customerPO) continue;
      const customerSO = str(row["Customer SO"]);
      const companySO = str(row["Company SO"]);
      // Use the FIRST encountered triplet for this base key (multi-line
      // rows share the same base values; suffix differs per line).
      if (!map.has(customerPO)) {
        map.set(customerPO, { customerPO, customerSO, companySO });
      }
    }
  }
  return map;
}

function d1(sql: string, { mutation = false }: { mutation?: boolean } = {}): {
  results?: Array<Record<string, unknown>>;
} {
  let cmd: string;
  let tmp = "";
  if (mutation) {
    tmp = path.join(os.tmpdir(), `rid-${Date.now()}-${Math.random()}.sql`);
    fs.writeFileSync(tmp, sql, "utf-8");
    cmd = `npx wrangler d1 execute hookka-erp-db --remote --json --file="${tmp.replace(/\\/g, "\\\\")}"`;
  } else {
    const esc = sql.replace(/"/g, '\\"');
    cmd = `npx wrangler d1 execute hookka-erp-db --remote --json --command="${esc}"`;
  }
  const r = spawnSync(cmd, {
    shell: true,
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true,
  });
  if (tmp) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
  if (r.status !== 0) {
    throw new Error(
      `wrangler exit ${r.status}: stderr=${r.stderr?.slice(0, 500) || "(empty)"} stdout=${r.stdout?.slice(0, 500) || "(empty)"}`,
    );
  }
  const out = r.stdout || "";
  const first = out.indexOf("[");
  if (first < 0) throw new Error(`no JSON: ${out.slice(0, 500)}`);
  const parsed = JSON.parse(out.slice(first));
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

function main() {
  const sheetMap = readSheet();
  console.log(`Sheet loaded: ${sheetMap.size} unique Customer PO base IDs`);

  // Pull all SOs from D1. We'll match by stripping the suffix from the
  // stored customerPOId.
  const res = d1(
    `SELECT id, companySOId, customerPOId, customerSOId FROM sales_orders`,
  );
  const dbRows = (res.results || []) as Array<{
    id: string;
    companySOId: string;
    customerPOId: string;
    customerSOId: string;
  }>;
  console.log(`DB rows: ${dbRows.length}\n`);

  const updates: Array<{
    id: string;
    fromCompany: string;
    toCompany: string;
    fromCustPO: string;
    toCustPO: string;
    fromCustSO: string;
    toCustSO: string;
  }> = [];
  let unmatched = 0;

  for (const so of dbRows) {
    const base = stripSuffix(so.customerPOId || "");
    const sheet = sheetMap.get(base);
    if (!sheet) {
      unmatched++;
      if (unmatched <= 5) console.log(`[no-match] SO ${so.id} customerPOId='${so.customerPOId}' base='${base}'`);
      continue;
    }
    const toCompany = sheet.companySO || so.companySOId;
    const toCustPO = sheet.customerPO;
    const toCustSO = sheet.customerSO || stripSuffix(so.customerSOId || "");

    if (
      so.companySOId === toCompany &&
      so.customerPOId === toCustPO &&
      so.customerSOId === toCustSO
    ) {
      continue; // already correct
    }
    updates.push({
      id: so.id,
      fromCompany: so.companySOId,
      toCompany,
      fromCustPO: so.customerPOId,
      toCustPO,
      fromCustSO: so.customerSOId,
      toCustSO,
    });
  }

  console.log(`Unmatched: ${unmatched}`);
  console.log(`Already correct: ${dbRows.length - unmatched - updates.length}`);
  console.log(`Will update: ${updates.length}\n`);

  for (const u of updates.slice(0, 10)) {
    console.log(
      `  ${u.id.slice(-8)}  company ${u.fromCompany} → ${u.toCompany}  custPO ${u.fromCustPO} → ${u.toCustPO}  custSO ${u.fromCustSO} → ${u.toCustSO}`,
    );
  }
  if (updates.length > 10) console.log(`  ... +${updates.length - 10} more`);

  if (DRY) {
    console.log(`\n--dry-run — no writes.`);
    return;
  }
  if (updates.length === 0) return;

  const stmts: string[] = [];
  for (const u of updates) {
    // 1. Update the SO row.
    stmts.push(
      `UPDATE sales_orders SET companySOId='${sqlEscape(u.toCompany)}', customerPOId='${sqlEscape(u.toCustPO)}', customerSOId='${sqlEscape(u.toCustSO)}' WHERE id='${sqlEscape(u.id)}';`,
    );
    // 2. Cascade to every production_orders row derived from this SO.
    //    companySOId → base (matches new SO), customerPOId → base (strip
    //    suffix — line identity lives on production_orders.lineNo).
    stmts.push(
      `UPDATE production_orders SET companySOId='${sqlEscape(u.toCompany)}', customerPOId='${sqlEscape(u.toCustPO)}', salesOrderNo='${sqlEscape(u.toCompany)}' WHERE salesOrderId='${sqlEscape(u.id)}';`,
    );
  }

  console.log(`\nApplying ${stmts.length} UPDATEs (SO + PO cascade)...`);
  d1(stmts.join("\n"), { mutation: true });
  console.log(`Done.`);
}

main();
