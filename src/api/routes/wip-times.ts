// ---------------------------------------------------------------------------
// /api/wip-times — Paper-style BOM reference: one row per
// (productCode × BOM WIP node × department), with WIP labels resolved
// against each product's defaultVariants (so `{DIVAN_HEIGHT} Divan- {SIZE}`
// renders as `8" Divan- 5FT` etc.).
//
// Why paper-style: Wei Siang 2026-05-11 — current ops uses paper sheets
// like "Sofa Fabric Cutting" / "Headboard Foam Bonding" / "Divan Framing"
// with one row per product + variant. This page replaces those papers.
// Filter by department to get the equivalent of one sheet.
//
// Source = bom_templates × products.defaultVariants. NOT job_cards.
// (See commit 5c35600 for the JC-vs-BOM rationale: fabric cutting is
// merged across WIPs so JC totals can't tell per-WIP truth.)
//
// GET /api/wip-times?dept=FAB_CUT&category=BEDFRAME
//   - dept: optional, UPPER_SNAKE. Narrows to that dept (= one paper sheet).
//   - category: optional, SOFA | BEDFRAME | ACCESSORY. Narrows to BOM
//     template's category column.
//
// Response: { success: true, data: WipTimeRow[] }
// Each row = one process node in one BOM. Same product may emit 5–10 rows
// (one per WIP-node × dept). Sort: productCode asc → dept asc → wipLabel asc.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import {
  resolveWipTokens,
  type BomVariantContext,
} from "../lib/bom-wip-breakdown";

const app = new Hono<Env>();

// Raw row from the SELECT — wipComponents + defaultVariants arrive as TEXT.
type BomRow = {
  productCode: string;
  baseModel: string | null;
  category: string | null;
  wipComponents: string | null;
  defaultVariants: string | null;
};

type BomProcess = {
  deptCode?: string;
  category?: string;
  minutes?: number;
};

type BomWipNode = {
  wipCode?: string;
  wipLabel?: string;
  wipType?: string;
  quantity?: number;
  processes?: BomProcess[];
  children?: BomWipNode[];
};

// Shape of defaultVariants JSON on products (set by migration 0102).
// Two flavors: bedframe carries divanHeight + gap, sofa carries seatHeight —
// resolveWipTokens reads numeric *Inches fields, so we parse `"8\""` → 8.
type DefaultVariantsBlob = {
  fabricCode?: string;
  divanHeight?: string;
  legHeight?: string;
  gap?: string;
  seatHeight?: string;
  specials?: string[];
};

// `"8\""` / `"8"` / `8` → 8. Anything else → null.
function parseInches(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const s = String(raw).trim().replace(/["']/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function buildVariantContext(
  productCode: string,
  baseModel: string | null,
  blob: DefaultVariantsBlob | null,
): BomVariantContext {
  return {
    productCode,
    model: baseModel ?? productCode,
    sizeLabel: null,
    sizeCode: null,
    fabricCode: blob?.fabricCode ?? null,
    divanHeightInches: parseInches(blob?.divanHeight),
    legHeightInches: parseInches(blob?.legHeight),
    gapInches: parseInches(blob?.gap),
  };
}

type EmittedRow = {
  productCode: string;
  baseModel: string;
  category: string;
  wipLabel: string;
  wipType: string;
  quantity: number;
  departmentCode: string;
  bomMinutes: number;
  hasZeroMinutes: boolean;
};

function walkTree(
  nodes: BomWipNode[] | undefined,
  ctx: BomVariantContext,
  productCode: string,
  baseModel: string,
  category: string,
  out: EmittedRow[],
): void {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const rawCode = String(node.wipCode || "");
    const rawLabel = String(node.wipLabel || rawCode || "");
    const wipLabel = rawLabel
      ? resolveWipTokens(rawLabel, ctx)
      : resolveWipTokens(rawCode, ctx);
    const wipType = String(node.wipType || "").toUpperCase();
    const quantity = Number(node.quantity) > 0 ? Number(node.quantity) : 1;
    const procs = Array.isArray(node.processes) ? node.processes : [];
    for (const p of procs) {
      const dept = String(p?.deptCode || "").toUpperCase();
      if (!dept) continue;
      const minutes = Number(p?.minutes);
      const m = Number.isFinite(minutes) ? minutes : 0;
      // Skip rows with no label at all — they'd render as orphans. Keep
      // 0-minute rows though: per Wei Siang 2026-05-11 Q2=A, gaps in
      // BOM data must be visible so they can be filled.
      if (!wipLabel) continue;
      out.push({
        productCode,
        baseModel,
        category,
        wipLabel,
        wipType,
        quantity,
        departmentCode: dept,
        bomMinutes: m,
        hasZeroMinutes: m === 0,
      });
    }
    if (Array.isArray(node.children)) {
      walkTree(node.children, ctx, productCode, baseModel, category, out);
    }
  }
}

app.get("/", async (c) => {
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;

  const orgId = getOrgId(c);

  const deptParam = (c.req.query("dept") || "").trim().toUpperCase();
  const dept = deptParam.length > 0 ? deptParam : null;

  const categoryParam = (c.req.query("category") || "").trim().toUpperCase();
  const category =
    categoryParam === "SOFA" ||
    categoryParam === "BEDFRAME" ||
    categoryParam === "ACCESSORY"
      ? categoryParam
      : null;

  // Pull ACTIVE BOMs only, LEFT JOIN to products for defaultVariants. Some
  // products may not have defaults set yet — those rows keep raw tokens
  // in the WIP label (still useful as "BOM exists but no defaults").
  // Quote camelCase aliases (Postgres lowercases unquoted ones).
  const where: string[] = [
    "bt.orgId = ?",
    "UPPER(bt.versionStatus) = 'ACTIVE'",
  ];
  const bindings: unknown[] = [orgId];
  if (category) {
    where.push("UPPER(bt.category) = ?");
    bindings.push(category);
  }
  const sql = `
    SELECT
      bt.productCode      AS "productCode",
      bt.baseModel        AS "baseModel",
      bt.category         AS "category",
      bt.wipComponents    AS "wipComponents",
      p.defaultVariants   AS "defaultVariants"
    FROM bom_templates bt
    LEFT JOIN products p ON p.code = bt.productCode AND p.orgId = bt.orgId
    WHERE ${where.join(" AND ")}
  `;

  const result = await c.var.DB.prepare(sql)
    .bind(...bindings)
    .all<BomRow>();

  const rows: EmittedRow[] = [];
  for (const row of result.results ?? []) {
    if (!row.wipComponents) continue;
    let tree: unknown;
    try {
      tree = JSON.parse(row.wipComponents);
    } catch {
      continue;
    }
    if (!Array.isArray(tree)) continue;
    let defaults: DefaultVariantsBlob | null = null;
    if (row.defaultVariants) {
      try {
        defaults = JSON.parse(row.defaultVariants) as DefaultVariantsBlob;
      } catch {
        defaults = null;
      }
    }
    const ctx = buildVariantContext(
      row.productCode,
      row.baseModel,
      defaults,
    );
    walkTree(
      tree as BomWipNode[],
      ctx,
      row.productCode,
      row.baseModel ?? "",
      (row.category ?? "").toUpperCase(),
      rows,
    );
  }

  // Apply dept filter post-walk (cheaper than re-walking the tree).
  const filtered = dept
    ? rows.filter((r) => r.departmentCode === dept)
    : rows;

  // Stable sort: category → productCode → dept → wipLabel. Matches the
  // paper sheet ordering (planners scan by product within a dept).
  filtered.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    if (a.productCode !== b.productCode)
      return a.productCode.localeCompare(b.productCode);
    if (a.departmentCode !== b.departmentCode)
      return a.departmentCode.localeCompare(b.departmentCode);
    return a.wipLabel.localeCompare(b.wipLabel);
  });

  return c.json({ success: true, data: filtered });
});

export default app;
