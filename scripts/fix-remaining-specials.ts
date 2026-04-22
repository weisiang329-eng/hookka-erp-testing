// Fix remaining unmatched specialOrder tokens:
//   1) `1" LEG` / `1"LEG` / `1 LEG` → move to legHeightInches=1, strip token
//   2) `REPLACE 5537 BACKREST` → `5537 Backrest` (canonical sofaSpecials value)
// Uses wrangler d1 execute like scripts/normalize-special-orders.ts does.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PROD = "https://hookka-erp-testing.pages.dev";
const EMAIL = "weisiang329@gmail.com";
const PASSWORD = "CbpxqJQpjy3VA5yd3Q";
const DRY = process.argv.includes("--dry-run");

type Row = {
  id: string;
  specialOrder: string | null;
  legHeightInches: number | null;
};

function d1(sql: string, { mutation = false }: { mutation?: boolean } = {}): {
  results?: Array<Record<string, unknown>>;
} {
  let cmd: string;
  let tmp = "";
  if (mutation) {
    tmp = path.join(os.tmpdir(), `d1-${Date.now()}-${Math.random()}.sql`);
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
      `wrangler exit ${r.status}: stderr=${r.stderr?.slice(0, 500)} stdout=${r.stdout?.slice(0, 500)}`,
    );
  }
  const out = r.stdout || "";
  const first = out.indexOf("[");
  if (first < 0) throw new Error(`no JSON in output: ${out.slice(0, 500)}`);
  const parsed = JSON.parse(out.slice(first));
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

function analyze(raw: string): { tokens: string[]; oneInchLeg: boolean } {
  const parts = raw.split(/[;,\/]+/).map((s) => s.trim()).filter(Boolean);
  const kept: string[] = [];
  let oneInchLeg = false;
  for (const p of parts) {
    const up = p.toUpperCase().replace(/\s+/g, " ").trim();
    if (/^1\s*"?\s*LEG$/.test(up) || /^1\s*"\s*LEG$/.test(up)) {
      oneInchLeg = true;
      continue;
    }
    if (/REPLACE\s+5537\s+BACKREST/.test(up)) {
      kept.push("5537 Backrest");
      continue;
    }
    kept.push(p);
  }
  return { tokens: kept, oneInchLeg };
}

function main() {
  const res = d1(
    "SELECT id, specialOrder, legHeightInches FROM sales_order_items WHERE specialOrder IS NOT NULL AND specialOrder != '';",
  );
  const rows = (res.results || []) as unknown as Row[];
  console.log(`Scanning ${rows.length} rows with non-empty specialOrder...`);

  const updates: Array<{
    id: string;
    newSpecial: string;
    newLeg: number | null;
    reasons: string[];
  }> = [];

  for (const r of rows) {
    const raw = (r.specialOrder || "").trim();
    if (!raw) continue;
    const { tokens, oneInchLeg } = analyze(raw);
    const newSpecial = tokens.join("; ");
    const hadReplace = /REPLACE\s+5537\s+BACKREST/i.test(raw);
    if (!oneInchLeg && !hadReplace && newSpecial === raw) continue;

    const reasons: string[] = [];
    if (oneInchLeg) reasons.push(`1" LEG→legHeightInches=1`);
    if (hadReplace) reasons.push(`REPLACE 5537 BACKREST→5537 Backrest`);
    if (newSpecial !== raw && !oneInchLeg && !hadReplace) reasons.push(`rejoin`);

    const newLeg =
      oneInchLeg && (r.legHeightInches == null || r.legHeightInches === 0)
        ? 1
        : r.legHeightInches;
    updates.push({ id: r.id, newSpecial, newLeg, reasons });
  }

  console.log(`\nPlanned ${updates.length} updates:`);
  for (const u of updates.slice(0, 20)) {
    console.log(`  ${u.id}: ${u.reasons.join(" + ")} → special='${u.newSpecial}', leg=${u.newLeg}`);
  }
  if (updates.length > 20) console.log(`  ... +${updates.length - 20} more`);

  if (DRY) {
    console.log(`\n--dry-run — no writes.`);
    return;
  }

  if (updates.length === 0) return;

  const stmts = updates
    .map(
      (u) =>
        `UPDATE sales_order_items SET specialOrder='${sqlEscape(u.newSpecial)}', legHeightInches=${u.newLeg == null ? "NULL" : u.newLeg} WHERE id='${sqlEscape(u.id)}';`,
    )
    .join("\n");

  console.log(`\nApplying ${updates.length} UPDATEs...`);
  d1(stmts, { mutation: true });
  console.log(`Done.`);
}

main();
