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
  DEFAULT_WIP_DEPT_CHAINS,
  type BomVariantContext,
} from "../lib/bom-wip-breakdown";

// "FAB_CUT" → "Fab Cut" — used when synthesising a missing process node
// in a BOM via PUT, since stored processes carry a human `dept` label
// alongside `deptCode`. Lowercase + Title-case each underscore segment.
function deptHumanLabel(code: string): string {
  return code
    .toLowerCase()
    .split("_")
    .map((s) => (s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s))
    .join(" ");
}

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
  // BOM-authored process entries carry a human `dept` label alongside
  // `deptCode` (e.g. "Fab Cut" / "FAB_CUT"). When we synthesise a new
  // process via the PUT inline-edit path, we write both so the BOM
  // editor in /bom keeps rendering consistently.
  dept?: string;
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
    const definedDepts = new Set<string>();
    for (const p of procs) {
      const dept = String(p?.deptCode || "").toUpperCase();
      if (!dept) continue;
      definedDepts.add(dept);
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
    // Synthetic rows for "BOM defines this WIP but forgot a dept" —
    // per Wei Siang 2026-05-11 "BOM 存在都要进 没 set 时间就 production
    // time 放 0". For each dept in the wipType's default chain that
    // isn't on `procs`, emit a 0m row so the editor can fill it in via
    // the inline ✏️ flow (PUT then CREATEs the process entry).
    if (wipLabel) {
      const expectedChain = DEFAULT_WIP_DEPT_CHAINS[wipType] ?? [];
      for (const expectedDept of expectedChain) {
        if (definedDepts.has(expectedDept)) continue;
        out.push({
          productCode,
          baseModel,
          category,
          wipLabel,
          wipType,
          quantity,
          departmentCode: expectedDept,
          bomMinutes: 0,
          hasZeroMinutes: true,
        });
      }
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
      p.defaultVariants   AS "defaultVariants",
      p.sizeCode          AS "sizeCode",
      p.sizeLabel         AS "sizeLabel"
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

  // Apply dept filter post-walk (cheaper than re-walking the tree).
  const filtered = dept
    ? rows.filter((r) => r.departmentCode === dept)
    : rows;

  // Dedup pass — per Wei Siang 2026-05-11 v3 "如果相同的 wip 出来就不需要
  // 了 show 一次可以了". Now that variant tokens are resolved (sizeLabel ↦
  // "6FT", divanHeight ↦ "8\""), divan WIPs naturally share a label across
  // every K-size bedframe; collapse them into a single row with min/max/avg
  // minutes plus the product count. Headboard WIPs use {PRODUCT_CODE} so
  // their labels stay unique → 1 product per bucket (still shown, just
  // doesn't collapse with anything).
  //
  // LHF/RHF folding (v5, Wei Siang 2026-05-11):
  // `5530-1A(LHF) -Base (FC)` and `5530-1A(RHF) -Base (FC)` are mirror
  // operations with identical production time, so the dedup key strips
  // `(LHF)` / `(RHF)`. The displayed wipLabel uses the same stripped form
  // so the table reads `5530-1A -Base (FC)` once with productCount=2.
  // Inline-edit naturally follows: PUT /api/wip-times matches by stripped
  // label too, so saving once updates BOTH BOMs.
  const stripOrientation = (s: string): string =>
    s.replace(/\s*\((LHF|RHF)\)/gi, "").replace(/\s+/g, " ").trim();
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

  const agg = Array.from(buckets.values()).map((b) => {
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
      hasZeroMinutes: b.minutes.some((m) => m === 0),
    };
  });

  // Sort by max minutes desc (longest WIPs surface first — what planners
  // scan for); same-minute rows fall back to category → wipLabel.
  agg.sort((a, b) => {
    if (a.bomMaxMinutes !== b.bomMaxMinutes)
      return b.bomMaxMinutes - a.bomMaxMinutes;
    if (a.itemCategory !== b.itemCategory)
      return a.itemCategory.localeCompare(b.itemCategory);
    if (a.departmentCode !== b.departmentCode)
      return a.departmentCode.localeCompare(b.departmentCode);
    return a.wipLabel.localeCompare(b.wipLabel);
  });

  return c.json({ success: true, data: agg });
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
// resolved label + dept matches the target. If a matching node has NO
// process entry for the target dept, CREATE one — supports the synthetic
// 0m rows shown for "BOM forgot this dept" combos, so the first inline
// edit actually persists. Returns # nodes touched.
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
      const procs: BomProcess[] = Array.isArray(node.processes)
        ? node.processes
        : [];
      let foundExisting = false;
      for (const p of procs) {
        if (!p || !p.deptCode) continue;
        if (String(p.deptCode).toUpperCase() === targetDept) {
          p.minutes = newMinutes;
          count++;
          foundExisting = true;
        }
      }
      if (!foundExisting) {
        // Synthesise a new process entry so the BOM gains a real row
        // that the next GET can return non-synthetically. Category left
        // empty — operator can adjust via the per-product BOM editor if
        // categorisation matters. dept = human label, deptCode = upper.
        procs.push({
          dept: deptHumanLabel(targetDept),
          deptCode: targetDept,
          category: "",
          minutes: newMinutes,
        } as BomProcess);
        node.processes = procs;
        count++;
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

export default app;
