// Flip SOs with unmatched specialOrder tokens (CSL / STOOL / 1NA / HEADREST /
// BACK REST 5537 / ADD 1" INFRONT LSHAPE) to ON_HOLD status so they can't
// ship until user reviews. ON_HOLD has proper cascade wiring so POs also lock.
//
// Rationale for ON_HOLD over DRAFT:
//   - CONFIRMED → DRAFT would orphan already-generated POs
//   - ON_HOLD cascade is live (src/api/routes-d1/sales-orders.ts) and locks
//     all descendant POs + job cards automatically
//   - User can "Resume" once fixed → reverts to CONFIRMED + unlocks POs
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DRY = process.argv.includes("--dry-run");

// Substrings that mark a specialOrder as "unmatched / needs review"
const BAD_PATTERNS = [
  /\bCSL\b/i,
  /\bSTOOL\b/i,
  /\b1NA\s*:/i,
  /\b2A\s*:/i,
  /HEADREST\s+MODEL/i,
  /BACK\s+REST\s+5537/i,
  /ADD\s+1"?\s*INFRONT\s+LSHAPE/i,
];

type Row = {
  soId: string;
  soStatus: string;
  companySOId: string;
  specialOrder: string;
};

function d1(sql: string, { mutation = false }: { mutation?: boolean } = {}): {
  results?: Array<Record<string, unknown>>;
} {
  let cmd: string;
  let tmp = "";
  if (mutation) {
    tmp = path.join(os.tmpdir(), `hold-${Date.now()}-${Math.random()}.sql`);
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
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
  if (r.status !== 0) {
    throw new Error(`wrangler exit ${r.status}: stderr=${r.stderr?.slice(0, 800) || "(empty)"} stdout=${r.stdout?.slice(0, 800) || "(empty)"}`);
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
  const res = d1(
    `SELECT soi.salesOrderId AS soId, so.status AS soStatus, so.companySOId AS companySOId, soi.specialOrder FROM sales_order_items soi JOIN sales_orders so ON so.id = soi.salesOrderId WHERE soi.specialOrder IS NOT NULL AND soi.specialOrder != ''`,
  );
  const rows = (res.results || []) as unknown as Row[];
  console.log(`Raw row count: ${rows.length}`);
  if (rows.length > 0) console.log(`First row shape:`, JSON.stringify(rows[0]).slice(0, 300));

  const problematic = new Map<string, { companySOId: string; currentStatus: string; tokens: Set<string> }>();
  for (const r of rows) {
    const so = r.specialOrder || "";
    if (!so) continue;
    const tokens: string[] = [];
    for (const pat of BAD_PATTERNS) {
      const m = so.match(pat);
      if (m) tokens.push(m[0]);
    }
    if (tokens.length > 0) {
      const prev = problematic.get(r.soId) || { companySOId: r.companySOId, currentStatus: r.soStatus, tokens: new Set<string>() };
      tokens.forEach((t) => prev.tokens.add(t));
      problematic.set(r.soId, prev);
    }
  }

  // Skip SOs already in terminal/locked states (can't revert easily)
  const SKIP_STATUS = new Set(["CANCELLED", "DELIVERED", "INVOICED", "CLOSED", "DRAFT"]);

  const toFlip = Array.from(problematic.entries()).filter(([, v]) => !SKIP_STATUS.has(v.currentStatus));

  console.log(`Found ${problematic.size} SOs with problematic specialOrder tokens`);
  console.log(`  Already skipped (draft/done/cancelled): ${problematic.size - toFlip.length}`);
  console.log(`  Will flip to DRAFT: ${toFlip.length}\n`);

  for (const [, info] of toFlip) {
    console.log(`  ${info.companySOId.padEnd(15)} [${info.currentStatus}→DRAFT]  tokens: ${Array.from(info.tokens).join(", ")}`);
  }

  if (DRY) {
    console.log(`\n--dry-run — no writes.`);
    return;
  }

  if (toFlip.length === 0) return;

  // Flip SO to DRAFT + log to so_status_changes.
  // POs generated from prior CONFIRMED state are left in place but their SO is
  // now DRAFT so nothing downstream (invoice, DO) can proceed. User fixes the
  // specialOrder, edits in DRAFT, then re-confirms → cascade resyncs POs.
  const stmts: string[] = [];
  const ts = new Date().toISOString();
  for (const [soId, info] of toFlip) {
    stmts.push(
      `UPDATE sales_orders SET status='DRAFT' WHERE id='${sqlEscape(soId)}';`,
    );
    const changeId = `soc-${soId.slice(-8)}-${Date.now()}`;
    stmts.push(
      `INSERT INTO so_status_changes (id, soId, fromStatus, toStatus, changedBy, timestamp, notes, autoActions) VALUES ('${sqlEscape(changeId)}', '${sqlEscape(soId)}', '${sqlEscape(info.currentStatus)}', 'DRAFT', 'system', '${ts}', 'Auto-draft: specialOrder contains unmatched tokens (${Array.from(info.tokens).join(", ")}) — needs review per docs/DRAFTS.md', '[]');`,
    );
  }

  console.log(`\nApplying ${toFlip.length} SO flips to DRAFT...`);
  d1(stmts.join("\n"), { mutation: true });
  console.log(`Done. Flipped SOs are now DRAFT; edit and re-confirm after fixing specialOrder.`);
}

main();
