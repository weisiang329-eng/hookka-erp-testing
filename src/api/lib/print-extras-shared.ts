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
import { partLabelFromKey, type RepairScope } from "../../lib/repair-scope";
import { compareRackLabels } from "../../lib/rack-format";

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
  // Component-level repair scope (partial repair). When its `components` are
  // set, the line lists ONLY those repaired components by their picker labels
  // ("1 Headboard + 1 Back Cushion") instead of the full set composition.
  // Omitted/null on a normal sales line (and on the CN path, which never passes
  // it) → full set.
  repairScope?: RepairScope | null;
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
    repairScope,
  } = args;
  const C = (cat || "").toUpperCase();
  const cu = code.toUpperCase();
  const isBedframe = C === "BEDFRAME" || cu.startsWith("DIVAN");
  const hasRepairComponents = !!(
    repairScope?.components && repairScope.components.length > 0
  );

  // Break the BOM once when we'll actually need it — a bedframe's HB/Divan
  // pieces, or a repair's full-SKU check + component listing. A sofa BOM breaks
  // into its Base / Cushion / Arm sub-components, used ONLY for repairs (a
  // normal whole-sofa line never breaks).
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
  const allWips =
    (isBedframe || hasRepairComponents) && wipComponents
      ? breakBomIntoWips(wipComponents, code, variants)
      : [];
  const isFgMain = allWips.length === 1 && allWips[0].wipCode === "FG_MAIN";

  // Partial repair: list ONLY the repaired components, by clean short labels
  // derived from each component's wipKey (Headboard→HB, Back Cushion→BC, Right
  // Arm→R Arm, …); qty is the picked per-set count × the line's set quantity.
  // BUT if the picks cover EVERY top-level BOM component at full qty, it's the
  // WHOLE unit — fall through to the normal complete-unit pieces ("1 Sofa" /
  // "1 HB + 2 Divan"), don't break it apart (Wei Siang 2026-06-16).
  if (hasRepairComponents) {
    const comps = repairScope!.components!;
    const bomQtyByKey = new Map(
      (isFgMain ? [] : allWips).map((w) => [
        w.wipKey,
        Number(w.quantityMultiplier) || 1,
      ]),
    );
    const coversWholeSku =
      bomQtyByKey.size > 0 &&
      [...bomQtyByKey.entries()].every(([k, bomQty]) => {
        const pick = comps.find((cmp) => cmp.key === k);
        return !!pick && (Number(pick.qty) || 1) >= bomQty;
      });
    if (!coversWholeSku) {
      const parts = comps
        .filter((cmp) => cmp && (cmp.key || cmp.label))
        .map(
          (cmp) =>
            `${(Number(cmp.qty) || 1) * (qty || 1)} ${partLabelFromKey(cmp.key, cmp.label)}`,
        );
      if (parts.length > 0) return parts.join(" + ");
    }
    // coversWholeSku → fall through to the complete-unit pieces below.
  }

  // A sofa / stool / accessory IS one finished set — NOT broken into pieces on
  // a normal delivery/consignment note.
  if (!isBedframe) {
    // A complete SOFA set (any variant — 1A / 2A / 1L1A / 2L / …) counts as one
    // "Sofa" piece (Wei Siang 2026-06-16); the variant rides the product name.
    if (C === "SOFA") return `${qty || 1} Sofa`;
    const dash = code.indexOf("-");
    const variant =
      (dash >= 0 ? code.slice(dash + 1).trim() : "") ||
      (sizeLabel && sizeLabel.trim()) ||
      code ||
      "SET";
    return `${qty || 1} ${variant}`;
  }
  if (!wipComponents) return null;
  let wips = allWips;
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
          ? "Divan"
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
// buildRepairNote — the short "Repair: HB only" line a partial-repair DO line
// prints under its spec. Derived from the ALREADY-FILTERED pieces string so
// the labels (HB / DIVAN / …) match the printed Quantity breakdown exactly.
// English only — the document PDFs carry no CJK glyphs. The caller gates this
// on the line actually being a narrowed partial repair (components present AND
// the filtered pieces differ from the full set), so a stale-pick fallback
// never prints a misleading "only".
// ---------------------------------------------------------------------------
export function buildRepairNote(filteredPieces: string | null): string | null {
  if (!filteredPieces) return null;
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const part of String(filteredPieces).split(" + ")) {
    const lab = part.trim().replace(/^\d+\s+/, "").trim();
    if (lab && !seen.has(lab)) {
      seen.add(lab);
      labels.push(lab);
    }
  }
  return labels.length ? `Repair: ${labels.join(" + ")} only` : null;
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
  // pieces-string ordering fmtPieces prints. Racks sort numerically (via the
  // shared compareRackLabels) so "Rack 3" lands before "Rack 20" — the exact
  // same ordering the compact "Rack 3, 4" grid form uses.
  const labRank = (lab: string) => (lab === "HB" ? 0 : lab === "DIVAN" ? 1 : 2);
  labelOrder.sort((a, b) => labRank(a) - labRank(b));
  for (const label of labelOrder) {
    const racks = racksByLabel.get(label)!;
    racks.sort(compareRackLabels);
    componentRacks.push({ label, racks });
  }
  return { packedDate, componentRacks };
}
