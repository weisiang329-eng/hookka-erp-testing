// ---------------------------------------------------------------------------
// print-extras-shared.ts — the BOM-pieces + per-component-racking derivation
// shared by the DO and CN /print-extras endpoints.
//
// Both documents print the SAME per-item rich detail (a build-spec line, a
// "1 HB + 2 DIVAN" pieces breakdown, and per-component warehouse racks). The
// pieces string is read straight from the product BOM (bom_templates.
// wipComponents → breakBomIntoWips, the same source production uses) and the
// racks come from the PACKING job_cards of the item's production order. That
// logic is identical regardless of whether the parent order is a sales order
// (DO) or a consignment order (CN), so it lives here in ONE place instead of
// being copy-pasted into both routes (which is exactly how DO and CN drift).
//
// What is NOT shared (and stays in each route): resolving the customer PO /
// SO refs and the deliver-to hub, plus the per-line config FALLBACK source
// (DO falls back to sales_order_items, CN to consignment_order_items). Each
// route owns its own table joins for those and feeds the resolved config in.
//
// Extracted from delivery-orders.ts GET /:id/print-extras (2026-06-12, CN/DO
// FE parity P3). DO's output is byte-identical after the extraction — it now
// calls selectBestBomByCode + piecesFor + deriveComponentRacks instead of the
// inlined copies it carried before.
// ---------------------------------------------------------------------------
import {
  breakBomIntoWips,
  type BomVariantContext,
} from "./bom-wip-breakdown";
import { isHeadboardOnlySpecial } from "../routes/fg-units";

// One BOM template per product code, already collapsed to the version we
// print from (ACTIVE preferred, then latest effectiveFrom).
export type BomForCode = {
  wipComponents: string | null;
  baseModel: string | null;
};

// A PACKING job card row — the per-component rack + packing-completion source
// (one PACKING JC per top-level component, each with its own rackingNumber +
// completedDate). production_orders.rackingNumber is a lossy last-writer
// mirror, so it is deliberately NOT used; the job cards are authoritative.
export type PackingJcRow = {
  productionOrderId: string | null;
  wipType: string | null;
  wipLabel: string | null;
  rackingNumber: string | null;
  completedDate: string | null;
  status: string | null;
};

// ---------------------------------------------------------------------------
// selectBestBomByCode — pick the one bom_templates row to print from per
// product code. Prefer versionStatus='ACTIVE', then the latest effectiveFrom.
// Mirrors the inline `best` selection the DO print-extras used.
// ---------------------------------------------------------------------------
export function selectBestBomByCode(
  rows: {
    productCode: string | null;
    baseModel: string | null;
    wipComponents: string | null;
    versionStatus: string | null;
    effectiveFrom: string | null;
  }[],
): Map<string, BomForCode> {
  const best = new Map<
    string,
    {
      wipComponents: string | null;
      baseModel: string | null;
      active: boolean;
      eff: string;
    }
  >();
  for (const b of rows) {
    const pc = (b.productCode || "").trim();
    if (!pc) continue;
    const active = (b.versionStatus || "").toUpperCase() === "ACTIVE";
    const eff = b.effectiveFrom || "";
    const prev = best.get(pc);
    const better =
      !prev ||
      (active && !prev.active) ||
      (active === prev.active && eff > prev.eff);
    if (better)
      best.set(pc, {
        wipComponents: b.wipComponents,
        baseModel: b.baseModel,
        active,
        eff,
      });
  }
  const out = new Map<string, BomForCode>();
  for (const [pc, v] of best)
    out.set(pc, { wipComponents: v.wipComponents, baseModel: v.baseModel });
  return out;
}

// ---------------------------------------------------------------------------
// piecesFor — per-line set composition string, e.g. "1 HB + 2 DIVAN"
// (bedframe) or "1 1A + 1 2A + 1 STOOL" (sofa set). null when there's no real
// BOM to break. Reads from the product BOM (the same source production uses)
// so a Queen/King DIVAN node already carries its real qty and a sofa is its
// set of WIP pieces — no size guessing.
//
// Lifted verbatim from delivery-orders.ts print-extras so the DO and CN
// pieces strings are produced by ONE function and can't drift.
// ---------------------------------------------------------------------------
export function piecesFor(args: {
  code: string;
  baseModel: string | null;
  wipComponents: string | null;
  cat: string | null;
  special: string | null;
  sizeLabel: string;
  fabricCode: string;
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  qty: number;
}): string | null {
  const {
    code,
    baseModel,
    wipComponents,
    cat,
    special,
    sizeLabel,
    fabricCode,
    gapInches: g,
    divanHeightInches: d,
    legHeightInches: l,
    qty,
  } = args;
  const C = (cat || "").toUpperCase();
  const cu = code.toUpperCase();
  const isBedframe = C === "BEDFRAME" || cu.startsWith("DIVAN");
  // A sofa "1A" / a stool / an accessory IS one finished set — it is NOT
  // broken into Base / Cushion / Arm WIP pieces on a delivery/consignment
  // note. Count it as its own FG unit, labelled by its variant so the
  // roll-up can list "2 1A(LHF) + 1 STOOL".
  if (!isBedframe) {
    // Label by the sofa TYPE (product-code variant, e.g. "1A(LHF)",
    // "STOOL") — that's what "一套沙发" means — not the seat size.
    const dash = code.indexOf("-");
    const variant =
      (dash >= 0 ? code.slice(dash + 1).trim() : "") ||
      (sizeLabel && sizeLabel.trim()) ||
      code ||
      "SET";
    return `${qty || 1} ${variant}`;
  }
  if (!wipComponents) return null;
  const variants: BomVariantContext = {
    productCode: code,
    model: baseModel || code,
    sizeLabel,
    sizeCode: "",
    fabricCode,
    divanHeightInches: d,
    legHeightInches: l,
    gapInches: g,
  };
  let wips = breakBomIntoWips(wipComponents, code, variants);
  if (wips.length === 1 && wips[0].wipCode === "FG_MAIN") return null;
  // What actually ships = what reaches PACKING. Count only the WIPs that have
  // a PACKING process so the figure matches the loaded pieces ("packing 有多
  // 少东西就是多少东西"). Keep all if the BOM never marks packing (don't zero
  // the line out).
  const packed = wips.filter((w) =>
    (w.processes || []).some(
      (p) => String(p.deptCode || "").toUpperCase() === "PACKING",
    ),
  );
  if (packed.length) wips = packed;
  if (cu.startsWith("DIVAN")) {
    wips = wips.filter((w) => w.wipType.toUpperCase() === "DIVAN");
  } else if (C === "BEDFRAME" && isHeadboardOnlySpecial(special)) {
    wips = wips.filter((w) => w.wipType.toUpperCase() !== "DIVAN");
  }
  if (wips.length === 0) return null;
  const agg = new Map<string, number>();
  const order: string[] = [];
  for (const w of wips) {
    const t = w.wipType.toUpperCase();
    const label =
      t === "HEADBOARD"
        ? "HB"
        : t === "DIVAN"
          ? "DIVAN"
          : (w.wipLabel || w.wipType || "PC").trim();
    if (!agg.has(label)) order.push(label);
    agg.set(
      label,
      (agg.get(label) || 0) + (Number(w.quantityMultiplier) || 1) * (qty || 1),
    );
  }
  return order.map((lab) => `${agg.get(lab)} ${lab}`).join(" + ");
}

// ---------------------------------------------------------------------------
// deriveComponentRacks — from a line's PACKING job cards, compute:
//   - packedDate: latest completedDate when EVERY (shipping) PACKING card is
//     COMPLETED/TRANSFERRED; null if any is still open. Matches the on-screen
//     Packed column (mapPO).
//   - componentRacks: distinct racks grouped by component label
//     (HEADBOARD→HB, DIVAN→DIVAN, else wipLabel/wipType), HB first then DIVAN
//     then first-seen, racks sorted numerically ("Rack 3" before "Rack 20").
//
// HB-only BEDFRAME specials ignore stranded DIVAN packing cards (and their
// racks — a component that isn't shipping has no load location).
//
// Lifted verbatim from delivery-orders.ts print-extras so DO and CN produce
// identical racking data.
// ---------------------------------------------------------------------------
export function deriveComponentRacks(
  packJcs: PackingJcRow[],
  itemCategory: string | null,
  specialOrder: string | null,
): { packedDate: string | null; componentRacks: { label: string; racks: string[] }[] } {
  let packedDate: string | null = null;
  const componentRacks: { label: string; racks: string[] }[] = [];
  if (packJcs.length === 0) return { packedDate, componentRacks };

  const hbOnly =
    (itemCategory || "").toUpperCase() === "BEDFRAME" &&
    isHeadboardOnlySpecial(specialOrder);
  const pk = packJcs.filter(
    (j) => !hbOnly || (j.wipType || "").toUpperCase() !== "DIVAN",
  );
  if (
    pk.length > 0 &&
    pk.every((j) => j.status === "COMPLETED" || j.status === "TRANSFERRED")
  ) {
    const dates = pk
      .map((j) => j.completedDate)
      .filter((dd): dd is string => !!dd);
    packedDate = dates.length > 0 ? dates.sort().reverse()[0] : null;
  }
  // Group distinct racks by component label — the same label mapping
  // piecesFor uses (HEADBOARD→HB, DIVAN→DIVAN, else wipLabel/wipType).
  const racksByLabel = new Map<string, string[]>();
  const labelOrder: string[] = [];
  for (const j of pk) {
    const rack = (j.rackingNumber || "").trim();
    if (!rack) continue;
    const t = (j.wipType || "").toUpperCase();
    const label =
      t === "HEADBOARD"
        ? "HB"
        : t === "DIVAN"
          ? "DIVAN"
          : (j.wipLabel || j.wipType || "PC").trim();
    let bucket = racksByLabel.get(label);
    if (!bucket) {
      bucket = [];
      racksByLabel.set(label, bucket);
      labelOrder.push(label);
    }
    if (!bucket.includes(rack)) bucket.push(rack);
  }
  // HB first, DIVAN second, the rest in first-seen order — matches the
  // pieces-string ordering fmtPieces prints. Racks sort numerically so
  // "Rack 3" lands before "Rack 20".
  const labRank = (lab: string) => (lab === "HB" ? 0 : lab === "DIVAN" ? 1 : 2);
  labelOrder.sort((a, b) => labRank(a) - labRank(b));
  const rackNum = (s: string) => {
    const mm = s.match(/\d+/);
    return mm ? Number(mm[0]) : Number.POSITIVE_INFINITY;
  };
  for (const label of labelOrder) {
    const racks = racksByLabel.get(label)!;
    racks.sort((a, b) => rackNum(a) - rackNum(b) || a.localeCompare(b));
    componentRacks.push({ label, racks });
  }
  return { packedDate, componentRacks };
}
