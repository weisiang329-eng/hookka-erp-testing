// ---------------------------------------------------------------------------
// bom-wip-breakdown — parses a bom_templates row's JSON `wipComponents`
// tree into a flat list of WIPs with their dept-touching process summary.
//
// The BOM JSON tree has this shape (walked recursively — children may also
// have processes):
//   [
//     { wipCode, wipType, quantity, processes: [{deptCode, category, minutes}], children: [...] },
//     ...
//   ]
//
// For each TOP-LEVEL wip item, we collect ALL processes from the whole subtree
// (node + descendants) keyed by deptCode; minutes are summed; each dept entry
// remembers the node that owned that process so the job_card can display
// "8" Divan- 6FT Foam" (the Foam node) instead of "8" Divan- 6FT" (top-level).
// Tokens in wipCode / wipLabel (`{DIVAN_HEIGHT}`, `{SIZE}`, `{FABRIC}`,
// `{PRODUCT_CODE}`, `{TOTAL_HEIGHT}`, `{MODEL}`, `{SEAT_SIZE}`) are resolved
// against the variant context the caller supplies.
//
// If a WIP somehow has zero processes across its subtree, we fall back to the
// per-wipType default chain (see `DEFAULT_WIP_DEPT_CHAINS`). Finally, if the
// BOM itself has zero WIPs we synthesize a single "FG_MAIN" WIP that walks
// the full DEPT_ORDER.
// ---------------------------------------------------------------------------

import { DEPT_ORDER } from "./lead-times";

type BomProcess = {
  dept?: string;
  deptCode?: string;
  category?: string;
  minutes?: number;
};

type BomWipNode = {
  id?: string;
  wipCode?: string;
  wipLabel?: string;
  wipType?: string;
  quantity?: number;
  processes?: BomProcess[];
  children?: BomWipNode[];
};

export type BomVariantContext = {
  productCode?: string | null;
  sizeLabel?: string | null;
  sizeCode?: string | null;
  fabricCode?: string | null;
  divanHeightInches?: number | null;
  legHeightInches?: number | null;
  gapInches?: number | null;
};

export type WipProcessEntry = {
  deptCode: string;
  category: string;
  minutes: number;
  // wipCode / wipLabel of the SPECIFIC node that owns this dept's process.
  // e.g. for the K/Q Bedframe master the FRAMING process lives on the L2
  // Frame node whose code is `{DIVAN_HEIGHT} Divan- {SIZE} Frame` — after
  // variant resolution that becomes `8" Divan- 6FT Frame`, which is what
  // gets pushed onto the job_card (the top-level wipCode would lose the
  // "Frame" suffix). Falls back to the top-level code when a node has no
  // wipCode of its own.
  wipCode: string;
  wipLabel: string;
  // The node's own `quantity` — useful when a caller wants "per-node"
  // piece counts instead of the top-level multiplier (not used by the
  // SO → job_card cascade yet, but kept for future UI use).
  nodeQuantity: number;
};

export type WipBreakdownItem = {
  wipType: string;
  wipCode: string;
  wipLabel: string;
  wipKey: string;           // deterministic key for job_card grouping
  quantityMultiplier: number; // from the BOM `quantity` (defaults to 1)
  processes: WipProcessEntry[]; // one per DEPT_ORDER dept that this WIP touches
};

// Fallback dept chains for each known wipType when the BOM has no process data.
const DEFAULT_WIP_DEPT_CHAINS: Record<string, string[]> = {
  DIVAN:         ["WOOD_CUT", "FOAM", "FRAMING", "WEBBING", "UPHOLSTERY", "PACKING"],
  HEADBOARD:     ["FAB_CUT", "FAB_SEW", "FOAM", "FRAMING", "UPHOLSTERY", "PACKING"],
  SOFA_BASE:     ["WOOD_CUT", "FOAM", "FRAMING", "WEBBING", "UPHOLSTERY", "PACKING"],
  SOFA_CUSHION:  ["FAB_CUT", "FAB_SEW", "FOAM", "UPHOLSTERY", "PACKING"],
  SOFA_ARMREST:  ["WOOD_CUT", "FOAM", "UPHOLSTERY", "PACKING"],
  SOFA_HEADREST: ["FAB_CUT", "FAB_SEW", "FOAM", "UPHOLSTERY", "PACKING"],
};

// Resolve `{TOKEN}` placeholders inside a master wipCode / wipLabel against
// the SO line's variant context. Any token with no value substitutes empty,
// then whitespace is collapsed so gaps don't cascade into trailing dashes.
export function resolveWipTokens(
  template: string,
  v: BomVariantContext | null | undefined,
): string {
  if (!template || !template.includes("{")) return template;
  const ctx = v ?? {};
  const divanH =
    ctx.divanHeightInches != null && Number(ctx.divanHeightInches) > 0
      ? `${Number(ctx.divanHeightInches)}"`
      : "";
  const gap = Number(ctx.gapInches) || 0;
  const divan = Number(ctx.divanHeightInches) || 0;
  const leg = Number(ctx.legHeightInches) || 0;
  const totalH = gap + divan + leg;
  const totalStr = totalH > 0 ? `${totalH}"` : "";
  const size = ctx.sizeLabel || ctx.sizeCode || "";
  const productCode = ctx.productCode || "";
  const fabric = ctx.fabricCode || "";
  return template
    .replace(/\{DIVAN_HEIGHT\}/g, divanH)
    .replace(/\{SIZE\}/g, size)
    .replace(/\{FABRIC\}/g, fabric)
    .replace(/\{PRODUCT_CODE\}/g, productCode)
    .replace(/\{MODEL\}/g, productCode)
    .replace(/\{TOTAL_HEIGHT\}/g, totalStr)
    .replace(/\{SEAT_SIZE\}/g, ctx.sizeCode || "")
    .replace(/\s+/g, " ")
    .trim();
}

// Walk a wip subtree and accumulate processes per deptCode.
// Returns a Map<deptCode, WipProcessEntry>.
function collectProcesses(
  node: BomWipNode,
  acc: Map<string, WipProcessEntry>,
  variants: BomVariantContext | null,
  fallbackCode: string,
  fallbackLabel: string,
): Map<string, WipProcessEntry> {
  const nodeQty = Number(node.quantity) > 0 ? Number(node.quantity) : 1;
  const rawCode = String(node.wipCode || "");
  const rawLabel = String(node.wipLabel || rawCode || "");
  const resolvedCode = rawCode
    ? resolveWipTokens(rawCode, variants)
    : fallbackCode;
  const resolvedLabel = rawLabel
    ? resolveWipTokens(rawLabel, variants)
    : (resolvedCode || fallbackLabel);

  const procs = Array.isArray(node.processes) ? node.processes : [];
  for (const p of procs) {
    const dc = String(p.deptCode || "").toUpperCase();
    if (!dc) continue;
    if (!DEPT_ORDER.includes(dc as (typeof DEPT_ORDER)[number])) continue;
    const existing = acc.get(dc);
    const minutes = Number(p.minutes) || 0;
    const category = String(p.category || "").trim();
    if (existing) {
      existing.minutes += minutes;
      if (!existing.category && category) existing.category = category;
      // Prefer the DEEPER node's code (first write wins via the subtree
      // traversal order: we recurse depth-first, so by the time the top-
      // level node's own processes would overwrite, the deeper entry is
      // already set and we leave it alone).
    } else {
      acc.set(dc, {
        deptCode: dc,
        category,
        minutes,
        wipCode: resolvedCode || fallbackCode,
        wipLabel: resolvedLabel || fallbackLabel,
        nodeQuantity: nodeQty,
      });
    }
  }
  const kids = Array.isArray(node.children) ? node.children : [];
  for (const c of kids) {
    collectProcesses(c, acc, variants, fallbackCode, fallbackLabel);
  }
  return acc;
}

// Sort a set of process entries by DEPT_ORDER (the canonical dept chain).
function orderProcesses(entries: WipProcessEntry[]): WipProcessEntry[] {
  return entries
    .slice()
    .sort(
      (a, b) => DEPT_ORDER.indexOf(a.deptCode as (typeof DEPT_ORDER)[number]) -
        DEPT_ORDER.indexOf(b.deptCode as (typeof DEPT_ORDER)[number]),
    );
}

// Build the virtual FG fallback WIP when a BOM has zero WIPs.
function makeFallbackFgWip(productCode: string): WipBreakdownItem {
  const code = `${productCode} (main)`;
  return {
    wipType: "FG_MAIN",
    wipCode: "FG_MAIN",
    wipLabel: code,
    wipKey: `${productCode}::FG_MAIN`,
    quantityMultiplier: 1,
    processes: DEPT_ORDER.map((d) => ({
      deptCode: d,
      category: "",
      minutes: 0,
      wipCode: "FG_MAIN",
      wipLabel: code,
      nodeQuantity: 1,
    })),
  };
}

// Build the fallback dept chain for a wipType when the BOM tree has no usable
// process list.
function fallbackChainForType(
  wipType: string,
  fallbackCode: string,
  fallbackLabel: string,
  nodeQty: number,
): WipProcessEntry[] {
  const chain = DEFAULT_WIP_DEPT_CHAINS[wipType] ?? DEPT_ORDER;
  return chain.map((d) => ({
    deptCode: d,
    category: "",
    minutes: 0,
    wipCode: fallbackCode,
    wipLabel: fallbackLabel,
    nodeQuantity: nodeQty,
  }));
}

// Main entry — parse a raw BOM-templates `wipComponents` JSON string into the
// flat breakdown list consumed by the job_cards generator.
export function breakBomIntoWips(
  rawWipComponents: string | null | undefined,
  productCode: string,
  variants?: BomVariantContext | null,
): WipBreakdownItem[] {
  if (!rawWipComponents) {
    return [makeFallbackFgWip(productCode)];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawWipComponents);
  } catch {
    return [makeFallbackFgWip(productCode)];
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return [makeFallbackFgWip(productCode)];
  }

  const wips: WipBreakdownItem[] = [];
  for (let idx = 0; idx < parsed.length; idx++) {
    const node = parsed[idx] as BomWipNode;
    if (!node || typeof node !== "object") continue;

    const wipType = String(node.wipType || "FG_MAIN").toUpperCase();
    const rawTopCode = String(node.wipCode || wipType);
    const rawTopLabel = String(node.wipLabel || rawTopCode);
    const wipCode = resolveWipTokens(rawTopCode, variants ?? null);
    const wipLabel = resolveWipTokens(rawTopLabel, variants ?? null);
    const nodeQty = Number(node.quantity) > 0 ? Number(node.quantity) : 1;
    const quantityMultiplier = nodeQty;

    const acc = collectProcesses(
      node,
      new Map(),
      variants ?? null,
      wipCode,
      wipLabel,
    );
    let processes: WipProcessEntry[];
    if (acc.size === 0) {
      processes = fallbackChainForType(wipType, wipCode, wipLabel, nodeQty);
    } else {
      processes = orderProcesses(Array.from(acc.values()));
    }

    wips.push({
      wipType,
      wipCode,
      wipLabel,
      // wipKey disambiguates multiple top-level wips of the same type within a
      // single BOM (e.g. Sofa left-arm + right-arm). Prefix with index to
      // guarantee uniqueness even if two wips share a wipCode. We use the
      // UNRESOLVED rawTopCode here so the key stays stable across SO lines
      // with different fabric/height variants (otherwise identical POs would
      // get different wipKeys and upstream-lock scoping breaks).
      wipKey: `${productCode}::${idx}::${wipType}::${rawTopCode}`,
      quantityMultiplier,
      processes,
    });
  }

  if (wips.length === 0) {
    return [makeFallbackFgWip(productCode)];
  }
  return wips;
}
