// ---------------------------------------------------------------------------
// wip-times-core.ts — the ONE place the "paper-style BOM reference" computation
// lives: load ACTIVE bom_templates (× products.defaultVariants), walk each
// wipComponents tree to one row per (WIP node × department), resolve variant
// tokens, then dedup + aggregate by (resolved wipLabel × dept).
//
// Extracted from routes/wip-times.ts (2026-06-26) so BOTH the dashboard
// endpoint (GET /api/wip-times, RBAC-gated) and the worker-portal endpoint
// (GET /api/worker/wip-times, X-Worker-Token, scoped to the worker's own
// department) compute identical numbers from ONE code path — no drift.
//
// Pure except for loadActiveBomRows (the single SQL read). Output identical to
// the previous inline implementation.
// ---------------------------------------------------------------------------
import { resolveWipTokens, type BomVariantContext } from "./bom-wip-breakdown";

// Minimal D1-ish DB surface so this lib needn't import Hono types.
type DbLike = {
  prepare: (sql: string) => {
    bind: (...args: unknown[]) => {
      all: <T>() => Promise<{ results?: T[] }>;
      // Added for countProductsWithoutActiveBom (BUG-2026-08-13-147), which
      // reads a single aggregate row rather than a result set.
      first: <T>() => Promise<T | null>;
    };
  };
};

export type BomRow = {
  productCode: string;
  baseModel: string | null;
  category: string | null;
  wipComponents: string | null;
  defaultVariants: string | null;
  sizeCode: string | null;
  sizeLabel: string | null;
};

type BomProcess = { deptCode?: string; category?: string; minutes?: number };

type BomWipNode = {
  wipCode?: string;
  wipLabel?: string;
  wipType?: string;
  quantity?: number;
  processes?: BomProcess[];
  children?: BomWipNode[];
};

type DefaultVariantsBlob = {
  fabricCode?: string;
  divanHeight?: string;
  legHeight?: string;
  gap?: string;
  seatHeight?: string;
  specials?: string[];
};

export type WipTimeAggRow = {
  wipLabel: string;
  departmentCode: string;
  wipType: string;
  itemCategory: string;
  itemCategories: string;
  bomMinMinutes: number;
  bomMaxMinutes: number;
  bomAvgMinutes: number;
  quantityMin: number;
  quantityMax: number;
  productCount: number;
  productCodes: string[];
  hasZeroMinutes: boolean;
};

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
  sizeCode: string | null,
  sizeLabel: string | null,
  blob: DefaultVariantsBlob | null,
): BomVariantContext {
  return {
    productCode,
    model: baseModel ?? productCode,
    sizeLabel: sizeLabel ?? null,
    sizeCode: sizeCode ?? null,
    fabricCode: blob?.fabricCode ?? null,
    divanHeightInches: parseInches(blob?.divanHeight),
    legHeightInches: parseInches(blob?.legHeight),
    gapInches: parseInches(blob?.gap),
  };
}

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

// LHF/RHF mirrors share a row (identical production time) — strip orientation
// from the dedup key + displayed label. Shared with the PUT matcher.
export function stripOrientation(s: string): string {
  return s.replace(/\s*\((LHF|RHF)\)/gi, "").replace(/\s+/g, " ").trim();
}

// The single SQL read: ACTIVE BOMs (optionally one category) joined to products
// for defaultVariants + size. Category UPPER-cased + validated by the caller.
export async function loadActiveBomRows(
  db: DbLike,
  // null = no org filter (the worker-portal endpoint is org-agnostic, like the
  // rest of routes/worker.ts; Hookka is single-org). The dashboard passes its
  // resolved orgId so it stays org-scoped.
  orgId: string | null,
  category?: string | null,
): Promise<BomRow[]> {
  const where = ["UPPER(bt.versionStatus) = 'ACTIVE'"];
  const bindings: unknown[] = [];
  if (orgId) {
    where.push("bt.orgId = ?");
    bindings.push(orgId);
  }
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
      p.defaultVariants   AS "defaultVariants",
      p.sizeCode          AS "sizeCode",
      p.sizeLabel         AS "sizeLabel"
    FROM bom_templates bt
    LEFT JOIN products p ON p.code = bt.productCode AND p.orgId = bt.orgId
    WHERE ${where.join(" AND ")}
  `;
  const result = await db.prepare(sql).bind(...bindings).all<BomRow>();
  return result.results ?? [];
}

// ---------------------------------------------------------------------------
// BUG-2026-08-13-147 coverage — the blind spot in "⚠️ Missing BOM time".
//
// `loadActiveBomRows` above reads ONLY `versionStatus = 'ACTIVE'` templates,
// and `walkTree` emits a row only for a `processes[]` entry that carries a
// `deptCode`. Between them, a product with NO active BOM template at all —
// which is the most complete form of "missing BOM time" — produces zero rows,
// so it can never be counted by the tile that exists to count exactly that.
// A tile reporting "0 missing" while structurally unable to observe the worst
// case is BUG-2026-08-13-096's shape.
//
// This counts what the walk cannot see, so the page can publish it beside the
// figure instead of implying full coverage. It is deliberately NOT folded into
// `missing`: these are different facts (a WIP whose process has 0 minutes vs a
// product with no template to hold a process at all) and adding them would
// launder one into the other.
//
// NOTE ON SCOPE: this count is category-scoped only, never dept-scoped. A
// product with no BOM has no process nodes, so it has no department — there is
// nothing to filter it by. Any caller narrowing to one dept must say that this
// figure is the whole category, not that dept.
export async function countProductsWithoutActiveBom(
  db: DbLike,
  orgId: string | null,
  category?: string | null,
): Promise<number> {
  const where = ["UPPER(COALESCE(p.status, '')) = 'ACTIVE'"];
  const bindings: unknown[] = [];
  if (orgId) {
    where.push("p.orgId = ?");
    bindings.push(orgId);
  }
  if (category) {
    where.push("UPPER(p.category) = ?");
    bindings.push(category);
  }
  const sql = `
    SELECT COUNT(*) AS n
      FROM products p
     WHERE ${where.join(" AND ")}
       AND NOT EXISTS (
         SELECT 1
           FROM bom_templates bt
          WHERE bt.productCode = p.code
            AND bt.orgId = p.orgId
            AND UPPER(COALESCE(bt.versionStatus, '')) = 'ACTIVE'
       )
  `;
  const row = await db.prepare(sql).bind(...bindings).first<{ n: number }>();
  return Number(row?.n) || 0;
}

// Walk + dedup + aggregate the BOM rows into the per-(wipLabel × dept) reference
// rows. `dept` (UPPER_SNAKE) narrows to one department's "paper sheet".
export function aggregateWipTimes(
  bomRows: BomRow[],
  opts?: { dept?: string | null },
): WipTimeAggRow[] {
  const dept = (opts?.dept || "").trim().toUpperCase() || null;

  const rows: EmittedRow[] = [];
  for (const row of bomRows) {
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
      row.sizeCode,
      row.sizeLabel,
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

  const filtered = dept
    ? rows.filter((r) => r.departmentCode === dept)
    : rows;

  type AggBucket = {
    wipLabel: string;
    departmentCode: string;
    wipType: string;
    minutes: number[];
    quantities: number[];
    productCodes: Set<string>;
    categories: Set<string>;
  };
  const buckets = new Map<string, AggBucket>();
  for (const r of filtered) {
    const dedupLabel = stripOrientation(r.wipLabel);
    const key = `${dedupLabel}::${r.departmentCode}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        wipLabel: dedupLabel,
        departmentCode: r.departmentCode,
        wipType: r.wipType,
        minutes: [],
        quantities: [],
        productCodes: new Set(),
        categories: new Set(),
      };
      buckets.set(key, b);
    }
    b.minutes.push(r.bomMinutes);
    b.quantities.push(r.quantity);
    b.productCodes.add(r.productCode);
    if (r.category) b.categories.add(r.category);
  }

  const agg: WipTimeAggRow[] = Array.from(buckets.values()).map((b) => {
    const min = b.minutes.length ? Math.min(...b.minutes) : 0;
    const max = b.minutes.length ? Math.max(...b.minutes) : 0;
    const avg = b.minutes.length
      ? Math.round(b.minutes.reduce((s, m) => s + m, 0) / b.minutes.length)
      : 0;
    const qMin = b.quantities.length ? Math.min(...b.quantities) : 1;
    const qMax = b.quantities.length ? Math.max(...b.quantities) : 1;
    const cats = Array.from(b.categories).sort();
    return {
      wipLabel: b.wipLabel,
      departmentCode: b.departmentCode,
      wipType: b.wipType,
      itemCategory: cats[0] ?? "",
      itemCategories: cats.join(", "),
      bomMinMinutes: min,
      bomMaxMinutes: max,
      bomAvgMinutes: avg,
      quantityMin: qMin,
      quantityMax: qMax,
      productCount: b.productCodes.size,
      productCodes: Array.from(b.productCodes).sort(),
      hasZeroMinutes: b.minutes.some((m) => m === 0),
    };
  });

  agg.sort((a, b) => {
    if (a.bomMaxMinutes !== b.bomMaxMinutes)
      return b.bomMaxMinutes - a.bomMaxMinutes;
    if (a.itemCategory !== b.itemCategory)
      return a.itemCategory.localeCompare(b.itemCategory);
    if (a.departmentCode !== b.departmentCode)
      return a.departmentCode.localeCompare(b.departmentCode);
    return a.wipLabel.localeCompare(b.wipLabel);
  });

  return agg;
}
