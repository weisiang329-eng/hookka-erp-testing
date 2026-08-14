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
import {
  loadActiveBomRows,
  aggregateWipTimes,
  countProductsWithoutActiveBom,
} from "../lib/wip-times-core";

const app = new Hono<Env>();

// Raw row from the SELECT — wipComponents + defaultVariants arrive as TEXT.
// sizeCode / sizeLabel live on `products` as scalar columns (not nested in
// defaultVariants), and they hold the canonical size for the SKU — e.g.
// `1003-(K)` has sizeCode="K" / sizeLabel="King". Needed so the {SIZE}
// token in wipCode templates resolves to something meaningful.
type BomRow = {
  productCode: string;
  baseModel: string | null;
  category: string | null;
  wipComponents: string | null;
  defaultVariants: string | null;
  sizeCode: string | null;
  sizeLabel: string | null;
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
  sizeCode: string | null,
  sizeLabel: string | null,
  blob: DefaultVariantsBlob | null,
): BomVariantContext {
  return {
    productCode,
    model: baseModel ?? productCode,
    // Size comes from products.sizeCode / sizeLabel — NOT defaultVariants,
    // which doesn't carry size (size is a product attribute, not a per-line
    // option). resolveWipTokens reads sizeLabel first then falls back to
    // sizeCode, so passing both means `{SIZE}` always resolves when either
    // is populated. Bedframe products like `1003-(K)` have sizeCode="K".
    sizeLabel: sizeLabel ?? null,
    sizeCode: sizeCode ?? null,
    fabricCode: blob?.fabricCode ?? null,
    divanHeightInches: parseInches(blob?.divanHeight),
    legHeightInches: parseInches(blob?.legHeight),
    gapInches: parseInches(blob?.gap),
  };
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

  // Walk + dedup + aggregate now live in lib/wip-times-core (shared with the
  // worker-portal endpoint so both compute identical numbers — no drift).
  const bomRows = await loadActiveBomRows(c.var.DB, orgId, category);
  const agg = aggregateWipTimes(bomRows, { dept });

  // BUG-2026-08-13-147 coverage. `agg` can only ever describe products that
  // HAVE an active BOM template — a product with none produces no row, so the
  // "⚠️ Missing BOM time" tile was structurally blind to the most complete
  // form of the thing it counts. Publish the blind spot beside the figure.
  //
  // Best-effort: a failure here must not take the whole page down, but it must
  // also not report 0. `null` = could not measure, and the tile says so rather
  // than claiming full coverage.
  let productsWithoutActiveBom: number | null = null;
  try {
    productsWithoutActiveBom = await countProductsWithoutActiveBom(
      c.var.DB,
      orgId,
      category,
    );
  } catch (err) {
    console.error("[wip-times] coverage count failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return c.json({
    success: true,
    data: agg,
    coverage: {
      // Category-scoped, NEVER dept-scoped — a product with no BOM has no
      // process node and therefore no department to be filtered by. The page
      // states this so the number is not read as "in this dept".
      productsWithoutActiveBom,
      productsWithoutActiveBomScope: category ? `${category} products` : "all products",
      deptFilterApplied: dept != null,
    },
  });
});

// ---------------------------------------------------------------------------
// PUT /api/wip-times — bulk update BOM minutes by (wipLabel, deptCode)
//
// The list page dedupes by resolved (wipLabel × deptCode); one row often
// represents many products that share the same WIP. To let operators fix
// "BOM hasn't set a time" gaps (175+ rows across sofa Back Cushion / Arm)
// without clicking into each product's BOM page, this endpoint:
//
// 1. Walks every ACTIVE bom_template the user can see (org-scoped).
// 2. Re-resolves wipLabel tokens against each product's variants (same
//    logic as the GET path).
// 3. For every process node whose (resolvedLabel, deptCode) matches the
//    request, overwrites process.minutes.
// 4. Stringifies the modified tree back into wipComponents and UPDATEs
//    the bom_templates row.
//
// Body: { wipLabel: string, deptCode: string, minutes: number }
// Response: { success, updatedBomCount, updatedNodeCount }
//
// Safety: requires permission "bom:update". The frontend confirms
// "Updating N products" before calling — see /production/wip-times.tsx.
// ---------------------------------------------------------------------------
type PutBody = {
  wipLabel?: unknown;
  deptCode?: unknown;
  minutes?: unknown;
};

// Same orientation-stripping rule as the GET dedup pass — LHF/RHF mirrors
// share a row so an inline edit on `5530-1A -Base (FC)` must also match
// the BOM nodes that resolve to `5530-1A(LHF) -Base (FC)` and the RHF.
const stripOrientationForMatch = (s: string): string =>
  s.replace(/\s*\((LHF|RHF)\)/gi, "").replace(/\s+/g, " ").trim();

// Walk a wip subtree and mutate every process.minutes where the node's
// resolved label + dept matches the target. Returns # nodes updated in
// this subtree so the caller can decide whether to write the BOM back.
function mutateMatchingNodes(
  nodes: BomWipNode[] | undefined,
  ctx: BomVariantContext,
  targetLabel: string,
  targetDept: string,
  newMinutes: number,
): number {
  if (!Array.isArray(nodes)) return 0;
  let count = 0;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const rawCode = String(node.wipCode || "");
    const rawLabel = String(node.wipLabel || rawCode || "");
    const resolved = rawLabel
      ? resolveWipTokens(rawLabel, ctx)
      : resolveWipTokens(rawCode, ctx);
    // Match on the stripped form so 5530-1A(LHF) and 5530-1A(RHF) both
    // match a target of "5530-1A -Base (FC)".
    if (stripOrientationForMatch(resolved) === targetLabel) {
      const procs = Array.isArray(node.processes) ? node.processes : [];
      for (const p of procs) {
        if (!p || !p.deptCode) continue;
        if (String(p.deptCode).toUpperCase() === targetDept) {
          p.minutes = newMinutes;
          count++;
        }
      }
    }
    if (Array.isArray(node.children)) {
      count += mutateMatchingNodes(
        node.children,
        ctx,
        targetLabel,
        targetDept,
        newMinutes,
      );
    }
  }
  return count;
}

app.put("/", async (c) => {
  const denied = await requirePermission(c, "bom", "update");
  if (denied) return denied;

  const orgId = getOrgId(c);
  let body: PutBody;
  try {
    body = (await c.req.json()) as PutBody;
  } catch {
    return c.json({ success: false, error: "invalid json" }, 400);
  }

  // Strip orientation on intake too — if a caller posts the raw
  // `5530-1A(LHF) -Base (FC)` instead of the stripped form, we still
  // want to match every (LHF, RHF) sibling.
  const wipLabelRaw =
    typeof body.wipLabel === "string" ? body.wipLabel.trim() : "";
  const wipLabel = stripOrientationForMatch(wipLabelRaw);
  const deptCode =
    typeof body.deptCode === "string" ? body.deptCode.trim().toUpperCase() : "";
  const minutesRaw = Number(body.minutes);
  // Cap at a sane upper bound — typo "1000" should not silently land in BOM.
  // 8h (480 min) is already extreme for a single per-unit operation; we
  // accept up to 24h (1440) so legitimate long bake/cure steps work, then
  // hard-reject anything bigger.
  if (!wipLabel) {
    return c.json({ success: false, error: "wipLabel required" }, 400);
  }
  if (!deptCode) {
    return c.json({ success: false, error: "deptCode required" }, 400);
  }
  if (!Number.isFinite(minutesRaw) || minutesRaw < 0 || minutesRaw > 1440) {
    return c.json(
      { success: false, error: "minutes must be 0–1440 (24h cap)" },
      400,
    );
  }
  const minutes = Math.round(minutesRaw);

  // Pull every ACTIVE BOM in the org with the joined products row so we
  // can rebuild the variant context exactly like the GET path does.
  const result = await c.var.DB.prepare(
    `SELECT
       bt.id               AS "id",
       bt.productCode      AS "productCode",
       bt.baseModel        AS "baseModel",
       bt.category         AS "category",
       bt.wipComponents    AS "wipComponents",
       p.defaultVariants   AS "defaultVariants",
       p.sizeCode          AS "sizeCode",
       p.sizeLabel         AS "sizeLabel"
     FROM bom_templates bt
     LEFT JOIN products p ON p.code = bt.productCode AND p.orgId = bt.orgId
     WHERE bt.orgId = ? AND UPPER(bt.versionStatus) = 'ACTIVE'`,
  )
    .bind(orgId)
    .all<BomRow & { id: string }>();

  let updatedBomCount = 0;
  let updatedNodeCount = 0;

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
      row.sizeCode,
      row.sizeLabel,
      defaults,
    );

    const nodesUpdated = mutateMatchingNodes(
      tree as BomWipNode[],
      ctx,
      wipLabel,
      deptCode,
      minutes,
    );
    if (nodesUpdated > 0) {
      const newJson = JSON.stringify(tree);
      await c.var.DB.prepare(
        `UPDATE bom_templates SET wipComponents = ? WHERE id = ? AND orgId = ?`,
      )
        .bind(newJson, row.id, orgId)
        .run();
      updatedBomCount++;
      updatedNodeCount += nodesUpdated;
    }
  }

  return c.json({
    success: true,
    updatedBomCount,
    updatedNodeCount,
    wipLabel,
    deptCode,
    minutes,
  });
});

// ---------------------------------------------------------------------------
// POST /api/wip-times/bulk-import — apply many (wipLabel × deptCode → minutes)
// updates in one request.
//
// Operator workflow: hit "Export Excel" on the WIP Production Times page,
// edit the 'BOM Avg Minutes' column in the spreadsheet, save, then "Import
// Excel" → preview → apply. The FE parses the .xlsx itself (xlsx lib is
// already in the bundle for the export side) and posts an array of
// {wipLabel, deptCode, minutes} entries to this endpoint.
//
// Body: {
//   items: Array<{ wipLabel: string, deptCode: string, minutes: number }>,
//   dryRun?: boolean   // if true, returns the would-update counts WITHOUT
//                       // touching the DB. The FE calls dryRun:true first
//                       // and renders a preview; only on operator confirm
//                       // does it call again with dryRun:false.
// }
//
// Response: {
//   success: true,
//   mode: "dry-run" | "executed",
//   totalItems, applied, skipped, errors,
//   perItem: [{ wipLabel, deptCode, minutes, updatedBomCount, updatedNodeCount, error? }, …]
// }
//
// Idempotent: re-running with the same items is a no-op (matching processes
// already have those minutes, mutateMatchingNodes returns 0 changes). Same
// permission gate as PUT (bom:update). Same minutes range guard (0-1440).
// One UPDATE per affected bom_template per item — heavy on row count but
// each statement is small. Sequential to keep the order predictable in the
// per-item result list. For Hookka scale (~120 active BOM templates, ~150
// rows per import) this completes in a couple seconds.
// ---------------------------------------------------------------------------
type BulkImportItem = {
  wipLabel?: unknown;
  deptCode?: unknown;
  minutes?: unknown;
};

type BulkImportBody = {
  items?: unknown;
  dryRun?: unknown;
};

app.post("/bulk-import", async (c) => {
  const denied = await requirePermission(c, "bom", "update");
  if (denied) return denied;

  const orgId = getOrgId(c);
  let body: BulkImportBody;
  try {
    body = (await c.req.json()) as BulkImportBody;
  } catch {
    return c.json({ success: false, error: "invalid json" }, 400);
  }
  const dryRun = body.dryRun === true;
  const rawItems = Array.isArray(body.items) ? body.items : null;
  if (!rawItems) {
    return c.json(
      { success: false, error: "items must be an array" },
      400,
    );
  }
  if (rawItems.length === 0) {
    return c.json(
      { success: false, error: "items array is empty" },
      400,
    );
  }
  if (rawItems.length > 5000) {
    return c.json(
      { success: false, error: "max 5000 items per import" },
      400,
    );
  }

  // Validate every row up-front. We pre-flight so a bad row in the
  // middle of the file doesn't half-apply the import.
  type Parsed = { wipLabel: string; deptCode: string; minutes: number; rowIdx: number };
  const parsed: Parsed[] = [];
  const itemErrors: { rowIdx: number; error: string }[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    const it = rawItems[i] as BulkImportItem;
    const wipLabelRaw =
      typeof it.wipLabel === "string" ? it.wipLabel.trim() : "";
    const wipLabel = stripOrientationForMatch(wipLabelRaw);
    const deptCode =
      typeof it.deptCode === "string" ? it.deptCode.trim().toUpperCase() : "";
    const minutesRaw = Number(it.minutes);
    if (!wipLabel) {
      itemErrors.push({ rowIdx: i, error: "wipLabel required" });
      continue;
    }
    if (!deptCode) {
      itemErrors.push({ rowIdx: i, error: "deptCode required" });
      continue;
    }
    if (!Number.isFinite(minutesRaw) || minutesRaw < 0 || minutesRaw > 1440) {
      itemErrors.push({
        rowIdx: i,
        error: "minutes must be 0–1440 (24h cap)",
      });
      continue;
    }
    parsed.push({
      wipLabel,
      deptCode,
      minutes: Math.round(minutesRaw),
      rowIdx: i,
    });
  }

  if (parsed.length === 0) {
    return c.json({
      success: false,
      error: "no valid rows after validation",
      itemErrors,
    });
  }

  // Pull every ACTIVE BOM in the org ONCE — same query the single PUT
  // does, but we'll loop the matching pass over every parsed item to
  // amortise the SELECT. The mutateMatchingNodes pass against the parsed
  // tree is in-memory so it's cheap to repeat per item.
  const result = await c.var.DB.prepare(
    `SELECT
       bt.id               AS "id",
       bt.productCode      AS "productCode",
       bt.baseModel        AS "baseModel",
       bt.category         AS "category",
       bt.wipComponents    AS "wipComponents",
       p.defaultVariants   AS "defaultVariants",
       p.sizeCode          AS "sizeCode",
       p.sizeLabel         AS "sizeLabel"
     FROM bom_templates bt
     LEFT JOIN products p ON p.code = bt.productCode AND p.orgId = bt.orgId
     WHERE bt.orgId = ? AND UPPER(bt.versionStatus) = 'ACTIVE'`,
  )
    .bind(orgId)
    .all<BomRow & { id: string }>();
  const bomRows = result.results ?? [];

  // Parse each BOM tree once and cache the variant context. Each item's
  // pass then walks the cached parsed structures in memory.
  type BomCache = {
    id: string;
    tree: BomWipNode[];
    ctx: BomVariantContext;
    dirty: boolean;
  };
  const bomCache: BomCache[] = [];
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
    bomCache.push({ id: row.id, tree: tree as BomWipNode[], ctx, dirty: false });
  }

  // Per-item update pass over the cache. We DON'T write until after the
  // loop so dry-run and live runs share the same code path (and so a
  // late error doesn't leave us half-applied).
  const perItem: Array<{
    wipLabel: string;
    deptCode: string;
    minutes: number;
    updatedBomCount: number;
    updatedNodeCount: number;
  }> = [];
  for (const item of parsed) {
    let updatedBomCount = 0;
    let updatedNodeCount = 0;
    for (const bom of bomCache) {
      const nodesUpdated = mutateMatchingNodes(
        bom.tree,
        bom.ctx,
        item.wipLabel,
        item.deptCode,
        item.minutes,
      );
      if (nodesUpdated > 0) {
        bom.dirty = true;
        updatedBomCount++;
        updatedNodeCount += nodesUpdated;
      }
    }
    perItem.push({
      wipLabel: item.wipLabel,
      deptCode: item.deptCode,
      minutes: item.minutes,
      updatedBomCount,
      updatedNodeCount,
    });
  }

  // Write the dirty BOMs back, one row per UPDATE. Sequential to keep
  // error reporting per-row simple and to avoid pile-up under load.
  let appliedBomCount = 0;
  if (!dryRun) {
    for (const bom of bomCache) {
      if (!bom.dirty) continue;
      try {
        await c.var.DB
          .prepare(
            `UPDATE bom_templates SET wipComponents = ? WHERE id = ? AND orgId = ?`,
          )
          .bind(JSON.stringify(bom.tree), bom.id, orgId)
          .run();
        appliedBomCount++;
      } catch (e) {
        // Don't abort the rest — record the write failure but keep going
        // so an isolated row corruption doesn't lose every other update.
        itemErrors.push({
          rowIdx: -1,
          error: `bom_template ${bom.id} write failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  }

  const totalItems = rawItems.length;
  const applied = perItem.filter((p) => p.updatedNodeCount > 0).length;
  const skipped = perItem.length - applied;

  return c.json({
    success: true,
    mode: dryRun ? "dry-run" : "executed",
    totalItems,
    validItems: parsed.length,
    applied,
    skipped,
    appliedBomCount,
    itemErrors,
    perItem,
  });
});

export default app;
