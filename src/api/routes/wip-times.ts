// ---------------------------------------------------------------------------
// /api/wip-times — WIP catalog sourced from BOM templates (canonical recipe
// times), NOT job_cards.
//
// Why BOM, not JC: fabric cutting (and most multi-WIP depts) merge several
// WIPs into one JC, so jc.estMinutes is the JC TOTAL — meaningless per-WIP.
// BOM stores `processes[].minutes` per-WIP per-dept, which IS the per-WIP
// canonical time everyone wants to see ("how long does cutting one 8" Divan
// 5ft take?" — BOM answer is 10 min, JC source would inflate by wipQty).
//
// Aggregation: walk every ACTIVE bom_template's wipComponents JSON tree,
// emit one (wipLabel, deptCode, minutes, productCode, category) entry per
// process node, then GROUP BY (wipLabel × deptCode). Min/Max/Avg surface
// the spread across BOMs (e.g. Headboard FC ranges 30–90 min between
// products). Zero-minute entries are KEPT (per Wei Siang 2026-05-11) so
// gaps in BOM data are visible — `hasZeroMinutes` flag drives a UI badge.
//
// GET /api/wip-times?dept=FAB_SEW&category=SOFA
//   - dept: optional, UPPER_SNAKE. Narrows to that dept.
//   - category: optional, SOFA | BEDFRAME | ACCESSORY. Narrows by the BOM
//     template's category column.
//
// Response: { success: true, data: WipTimeRow[] } sorted by bomMaxMinutes
// descending (longest BOM times first — what planners scan for).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";

const app = new Hono<Env>();

// Raw SELECT row shape — wipComponents arrives as TEXT JSON.
type BomRow = {
  productCode: string;
  category: string | null;
  wipComponents: string | null;
  versionStatus: string | null;
};

// Process node inside a BOM's wipComponents tree.
type BomProcess = {
  deptCode?: string;
  category?: string;
  minutes?: number;
};

type BomWipNode = {
  wipCode?: string;
  wipLabel?: string;
  wipType?: string;
  processes?: BomProcess[];
  children?: BomWipNode[];
};

// Accumulator per (wipLabel × deptCode).
type AggBucket = {
  wipLabel: string;
  departmentCode: string;
  minutes: number[];           // all minutes values across BOMs
  productCodes: Set<string>;
  categories: Set<string>;
};

function walkTree(
  nodes: BomWipNode[] | undefined,
  productCode: string,
  productCategory: string,
  buckets: Map<string, AggBucket>,
): void {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const label = (node.wipLabel || node.wipCode || "").trim();
    const procs = Array.isArray(node.processes) ? node.processes : [];
    for (const p of procs) {
      if (!p || !p.deptCode) continue;
      const minutes = Number(p.minutes);
      if (!Number.isFinite(minutes)) continue;
      // wipLabel may be empty for stub nodes; skip those — they'd alias
      // unrelated processes under "" otherwise.
      if (!label) continue;
      const key = `${label}::${p.deptCode}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          wipLabel: label,
          departmentCode: p.deptCode,
          minutes: [],
          productCodes: new Set(),
          categories: new Set(),
        };
        buckets.set(key, bucket);
      }
      bucket.minutes.push(minutes);
      bucket.productCodes.add(productCode);
      if (productCategory) bucket.categories.add(productCategory);
    }
    if (Array.isArray(node.children)) {
      walkTree(node.children, productCode, productCategory, buckets);
    }
  }
}

app.get("/", async (c) => {
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;

  const orgId = getOrgId(c);

  const deptParam = (c.req.query("dept") || "").trim().toUpperCase();
  const dept = deptParam.length > 0 ? deptParam : null;

  const categoryParam = (c.req.query("category") || "")
    .trim()
    .toUpperCase();
  const category =
    categoryParam === "SOFA" ||
    categoryParam === "BEDFRAME" ||
    categoryParam === "ACCESSORY"
      ? categoryParam
      : null;

  // Pull ACTIVE BOMs only — drafts and obsolete versions aren't canonical.
  // Quote camelCase aliases (Postgres lowercases unquoted ones) — same
  // pattern as the old JC route documented in commit f5c6238.
  const where: string[] = ["orgId = ?", "UPPER(versionStatus) = 'ACTIVE'"];
  const bindings: unknown[] = [orgId];
  if (category) {
    where.push("UPPER(category) = ?");
    bindings.push(category);
  }
  const sql = `
    SELECT
      productCode  AS "productCode",
      category     AS "category",
      wipComponents AS "wipComponents",
      versionStatus AS "versionStatus"
    FROM bom_templates
    WHERE ${where.join(" AND ")}
  `;

  const result = await c.var.DB.prepare(sql)
    .bind(...bindings)
    .all<BomRow>();

  // Walk every BOM tree into the bucket map.
  const buckets = new Map<string, AggBucket>();
  for (const row of result.results ?? []) {
    if (!row.wipComponents) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.wipComponents);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    walkTree(
      parsed as BomWipNode[],
      row.productCode,
      (row.category || "").toUpperCase(),
      buckets,
    );
  }

  // Flatten + apply dept filter + sort by max minutes desc (longest WIPs
  // surface first — matches the old "scan from worst → best" planner UX).
  const rows = Array.from(buckets.values())
    .filter((b) => !dept || b.departmentCode === dept)
    .map((b) => {
      const mins = b.minutes;
      const min = mins.length ? Math.min(...mins) : 0;
      const max = mins.length ? Math.max(...mins) : 0;
      const avg = mins.length
        ? Math.round(mins.reduce((s, m) => s + m, 0) / mins.length)
        : 0;
      const cats = Array.from(b.categories).sort();
      return {
        wipLabel: b.wipLabel,
        departmentCode: b.departmentCode,
        itemCategory: cats[0] ?? "",
        itemCategories: cats.join(", "),
        // Three minute fields — the UI shows range when min != max, else
        // the single value. Keep all three so consumers (export, future
        // sort columns) can pick.
        bomMinMinutes: min,
        bomMaxMinutes: max,
        bomAvgMinutes: avg,
        // # of distinct products whose BOM contributes to this bucket.
        // Replaces the old "Sample (JCs)" column.
        productCount: b.productCodes.size,
        // True when ANY contributing BOM has minutes=0. Drives the ⚠️
        // "BOM missing" badge — Wei Siang 2026-05-11 wants gaps visible
        // so they can be filled in.
        hasZeroMinutes: mins.some((m) => m === 0),
      };
    })
    .sort((a, b) => b.bomMaxMinutes - a.bomMaxMinutes);

  return c.json({ success: true, data: rows });
});

export default app;
