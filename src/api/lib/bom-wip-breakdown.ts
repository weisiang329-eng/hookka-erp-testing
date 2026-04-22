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
// (node + descendants) keyed by deptCode; minutes are summed; the earliest
// non-empty category wins. The flat result is then fed to the job_cards
// generator, which orders depts by DEPT_ORDER and inserts one row per (wip,dept).
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

export type WipProcessEntry = {
  deptCode: string;
  category: string;
  minutes: number;
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

// Walk a wip subtree and accumulate processes per deptCode.
// Returns a Map<deptCode, {category, minutes}>.
function collectProcesses(
  node: BomWipNode,
  acc: Map<string, WipProcessEntry>,
): Map<string, WipProcessEntry> {
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
    } else {
      acc.set(dc, { deptCode: dc, category, minutes });
    }
  }
  const kids = Array.isArray(node.children) ? node.children : [];
  for (const c of kids) {
    collectProcesses(c, acc);
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
  return {
    wipType: "FG_MAIN",
    wipCode: "FG_MAIN",
    wipLabel: `${productCode} (main)`,
    wipKey: `${productCode}::FG_MAIN`,
    quantityMultiplier: 1,
    processes: DEPT_ORDER.map((d) => ({
      deptCode: d,
      category: "",
      minutes: 0,
    })),
  };
}

// Build the fallback dept chain for a wipType when the BOM tree has no usable
// process list.
function fallbackChainForType(wipType: string): WipProcessEntry[] {
  const chain = DEFAULT_WIP_DEPT_CHAINS[wipType] ?? DEPT_ORDER;
  return chain.map((d) => ({ deptCode: d, category: "", minutes: 0 }));
}

// Main entry — parse a raw BOM-templates `wipComponents` JSON string into the
// flat breakdown list consumed by the job_cards generator.
export function breakBomIntoWips(
  rawWipComponents: string | null | undefined,
  productCode: string,
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
    const wipCode = String(node.wipCode || wipType);
    const wipLabel = String(node.wipLabel || wipCode);
    const quantityMultiplier = Number(node.quantity) > 0 ? Number(node.quantity) : 1;

    const acc = collectProcesses(node, new Map());
    let processes: WipProcessEntry[];
    if (acc.size === 0) {
      processes = fallbackChainForType(wipType);
    } else {
      processes = orderProcesses(Array.from(acc.values()));
    }

    wips.push({
      wipType,
      wipCode,
      wipLabel,
      // wipKey disambiguates multiple top-level wips of the same type within a
      // single BOM (e.g. Sofa left-arm + right-arm). Prefix with index to
      // guarantee uniqueness even if two wips share a wipCode.
      wipKey: `${productCode}::${idx}::${wipType}::${wipCode}`,
      quantityMultiplier,
      processes,
    });
  }

  if (wips.length === 0) {
    return [makeFallbackFgWip(productCode)];
  }
  return wips;
}
