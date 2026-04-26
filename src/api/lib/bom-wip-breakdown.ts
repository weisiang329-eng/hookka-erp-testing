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
  // Parent/base model SKU (e.g. "5531" for variant "5531-L(RHF)"). Read
  // from bom_templates.baseModel by the JC builder. When BOM templates use
  // `{MODEL}` they mean the model-level identifier — e.g. an armrest WIP
  // shared across `5531-L(RHF)`, `5531-2A(LHF)` etc. should render as
  // `5531 -Left Arm`, not `5531-L(RHF) -Left Arm`. Falls back to
  // productCode when null so legacy callers keep working.
  model?: string | null;
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
  // BOM-branch identifier — the wipCode (raw template, NOT resolved) of
  // the immediate-child-of-top BOM node this process descended through.
  // Top-level processes (UPHOLSTERY/PACKING in most BOMs) get "" because
  // they live on the root and are shared by every branch. Walked from
  // the actual BOM tree — see collectProcesses() — so a future BOM with
  // a different branch shape works without code changes.
  branchKey: string;
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
  // {MODEL} ≠ {PRODUCT_CODE}. Model is the shared parent SKU (e.g. "5531");
  // PRODUCT_CODE is the variant (e.g. "5531-L(RHF)"). When the BOM authors
  // wrote `{MODEL} -Back Cushion {SEAT_SIZE}` they meant the cushion is
  // shared across all variants of the same model, so it should NOT pick up
  // the variant suffix. Fall back to productCode only when caller didn't
  // provide a model — the legacy behaviour from before BUG-2026-04-27-004.
  const model = ctx.model || productCode;
  const fabric = ctx.fabricCode || "";
  return template
    .replace(/\{DIVAN_HEIGHT\}/g, divanH)
    .replace(/\{SIZE\}/g, size)
    .replace(/\{FABRIC\}/g, fabric)
    .replace(/\{PRODUCT_CODE\}/g, productCode)
    .replace(/\{MODEL\}/g, model)
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
  // branchKey passed-down through recursion. Empty at the top-level node;
  // becomes the immediate child's RAW (unresolved) wipCode on the first
  // descent, then inherits unchanged at deeper levels. The first-descent
  // child is the BOM-tree natural definition of "branch root", and using
  // the raw template (not the resolved value) keeps it stable across PO
  // variants — every Divan PO gets the same branchKey for the Foam
  // subtree regardless of fabric / size.
  branchKey: string,
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
        branchKey,
      });
    }
  }
  const kids = Array.isArray(node.children) ? node.children : [];
  for (const c of kids) {
    // First descent from the root (branchKey === "") adopts the child's
    // raw wipCode as the branch identifier; deeper descents inherit.
    const childBranch =
      branchKey || String(c.wipCode || "");
    collectProcesses(c, acc, variants, fallbackCode, fallbackLabel, childBranch);
  }
  return acc;
}

// Per-wipType production order, BOM-derived.  The flat DEPT_ORDER lied for
// SOFA_BASE / SOFA_CUSHION / SOFA_ARMREST: per BOM tree, sofa FOAM is
// downstream of WEBBING (FOAM ← WEBBING ← FRAMING ← WOOD_CUT chain), but
// DEPT_ORDER put FOAM at index 3, before FRAMING/WEBBING.  Each wipType
// gets its own canonical chain matching the BOM's parent→child links.
//
// HEADBOARD (BF) keeps FOAM near the front because BF Headboard's BOM has
// FOAM in the fabric branch (FOAM ← FAB_SEW ← FAB_CUT) which IS upstream
// of UPH but parallel to the webbing branch (WEBBING ← FRAMING ← WOOD_CUT).
const PRODUCTION_ORDER_BY_WIP_TYPE: Record<string, readonly string[]> = {
  // BF Divan BOM: FAB_CUT->FAB_SEW (fabric branch) || WOOD_CUT->FRAMING->WEBBING (frame branch) -> UPH -> PACK.
  // No FOAM in Divan (the "Foam"-named WIP node's actual dept is WEBBING).
  DIVAN:         ["FAB_CUT", "FAB_SEW", "WOOD_CUT", "FRAMING", "WEBBING", "UPHOLSTERY", "PACKING"],
  // BF Headboard BOM: FAB_CUT->FAB_SEW->FOAM (foam branch) || WOOD_CUT->FRAMING->WEBBING (webbing branch) -> UPH -> PACK.
  HEADBOARD:     ["FAB_CUT", "FAB_SEW", "FOAM", "WOOD_CUT", "FRAMING", "WEBBING", "UPHOLSTERY", "PACKING"],
  // Sofa BOM: FAB_CUT->FAB_SEW (fabric branch) || WOOD_CUT->FRAMING->WEBBING->FOAM (foam branch) -> UPH -> PACK.
  // FOAM is downstream of WEBBING in sofa, opposite of BF Headboard.
  SOFA_BASE:     ["FAB_CUT", "FAB_SEW", "WOOD_CUT", "FRAMING", "WEBBING", "FOAM", "UPHOLSTERY", "PACKING"],
  SOFA_CUSHION:  ["FAB_CUT", "FAB_SEW", "WOOD_CUT", "FRAMING", "WEBBING", "FOAM", "UPHOLSTERY", "PACKING"],
  SOFA_ARMREST:  ["FAB_CUT", "FAB_SEW", "WOOD_CUT", "FRAMING", "WEBBING", "FOAM", "UPHOLSTERY", "PACKING"],
  SOFA_HEADREST: ["FAB_CUT", "FAB_SEW", "WOOD_CUT", "FRAMING", "WEBBING", "FOAM", "UPHOLSTERY", "PACKING"],
};

// Sort a set of process entries by per-wipType chain when known, falling
// back to global DEPT_ORDER for unknown / FG_MAIN wipTypes.
function orderProcesses(
  entries: WipProcessEntry[],
  wipType: string,
): WipProcessEntry[] {
  const chain =
    PRODUCTION_ORDER_BY_WIP_TYPE[wipType.toUpperCase()] ?? DEPT_ORDER;
  const idx = (code: string): number => {
    const i = chain.indexOf(code);
    // Unknown depts go to the end so they don't break the ordering.
    return i === -1 ? chain.length : i;
  };
  return entries.slice().sort((a, b) => idx(a.deptCode) - idx(b.deptCode));
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
      // Fallback FG-only chain has a single linear branch — every process
      // shares the synthesized "FG_MAIN" branchKey so the (wipKey,
      // branchKey) sibling filter still groups them together.
      branchKey: "FG_MAIN",
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
    // Fallback chain: no real BOM tree to walk, so every process shares
    // one synthetic branchKey derived from the top-level wipCode. Lets
    // the (wipKey, branchKey) consume filter still group them.
    branchKey: fallbackCode,
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

    // Top-level call passes branchKey=""; collectProcesses adopts the
    // first child's raw wipCode as the branch identifier on the first
    // descent. Top-level processes (UPHOLSTERY/PACKING etc.) keep "".
    const acc = collectProcesses(
      node,
      new Map(),
      variants ?? null,
      wipCode,
      wipLabel,
      "",
    );
    let processes: WipProcessEntry[];
    if (acc.size === 0) {
      processes = fallbackChainForType(wipType, wipCode, wipLabel, nodeQty);
    } else {
      processes = orderProcesses(Array.from(acc.values()), wipType);
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
