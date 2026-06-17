// ---------------------------------------------------------------------------
// rack-format.ts — the ONE place the per-piece rack aggregation + compact
// "Rack 3, 4" grid format lives.
//
// Why this exists: a single finished-good's pieces can sit on DIFFERENT racks
// (e.g. the HEADBOARD on Rack 3, the DIVAN on Rack 4). The authoritative
// per-piece location is each PACKING job_card's `rackingNumber` — there is one
// PACKING card per top-level component, each with its own rack. The mirror
// `production_orders.rackingNumber` is a LOSSY last-writer field (it only ever
// holds one of the racks), and `delivery_order_items.rackingNumber` is a frozen
// snapshot of that mirror. Every grid/detail that reads those mirrors shows one
// rack or none when a unit spans several.
//
// The DO/CN PDFs already aggregate correctly via deriveComponentRacks
// (print-extras-shared.ts) → fmtComponentRacks (generate-do-pdf.ts), but those
// produce the per-component manifest "HB: Rack 3 · DIVAN: Rack 4". For the
// narrow on-screen Rack columns and the DO snapshot we want the COMPACT grid
// form: the distinct racks across all pieces, numerically sorted, joined as
// "Rack 3, 4".
//
// This module is DEPENDENCY-FREE on purpose (no Hono / BOM / repair-scope
// imports) so it can be imported by BOTH the frontend pages (delivery list,
// consignment note detail) and the backend (DO-creation snapshot, and the
// print-extras-shared aggregator) without dragging server-only code into the
// page bundle. print-extras-shared.deriveComponentRacks delegates its dedup +
// numeric sort + format to formatRacksCompact here, so the manifest and the
// compact form can never drift in how they pick/sort racks.
// ---------------------------------------------------------------------------

// A PACKING-card-ish row: only the three fields the rack aggregation needs.
// Both the API payload (rowToMinimalJobCard) and the backend job_cards query
// expose these, so callers can pass their rows through directly.
export type RackPackingCard = {
  wipType?: string | null;
  wipLabel?: string | null;
  rackingNumber?: string | null;
};

// rackNum — extract the leading integer from a rack label so "Rack 3" sorts
// before "Rack 20" (and bare "3" before "20"). No digits ⇒ sorts last.
function rackNum(s: string): number {
  const m = s.match(/\d+/);
  return m ? Number(m[0]) : Number.POSITIVE_INFINITY;
}

// compareRackLabels — the ONE numeric rack comparator. "Rack 3" < "Rack 20",
// digit-bearing labels before plain ones, ties broken lexicographically.
// Exported so deriveComponentRacks (print-extras-shared) sorts each component's
// racks with the exact same rule the compact format uses — no second copy.
export function compareRackLabels(a: string, b: string): number {
  return rackNum(a) - rackNum(b) || a.localeCompare(b);
}

// ---------------------------------------------------------------------------
// formatRacksCompact — dedupe + numeric-sort + compact "Rack 3, 4" format for
// a flat list of rack labels (already collected from whatever source).
//
// The stored values carry their own "Rack " prefix (rack_locations catalog:
// "Rack 1"…"Rack 20"), so we strip it per value and print it once: "Rack 3, 4",
// never "Rack Rack 3". Legacy bare numbers ("3") group the same way. Anything
// non-numeric (and unprefixed) is printed raw, comma-joined, after dedup.
// Empty / all-blank input ⇒ "".
// ---------------------------------------------------------------------------
export function formatRacksCompact(racks: ReadonlyArray<string>): string {
  const cleaned = racks.map((r) => String(r ?? "").trim()).filter(Boolean);
  if (cleaned.length === 0) return "";
  // Distinct, preserving the numeric ordering we apply below.
  const distinct = Array.from(new Set(cleaned));
  const stripped = distinct.map((r) => r.replace(/^rack\s*/i, "").trim() || r);
  const groupable =
    distinct.some((r) => /^rack\b/i.test(r)) ||
    stripped.every((s) => /^\d+$/.test(s));
  if (groupable) {
    // Dedupe again on the stripped value ("Rack 3" and "3" collapse), then
    // numeric-sort and re-emit under a single "Rack " prefix.
    const nums = Array.from(new Set(stripped));
    nums.sort(compareRackLabels);
    return `Rack ${nums.join(", ")}`;
  }
  return [...distinct].sort(compareRackLabels).join(", ");
}

// ---------------------------------------------------------------------------
// aggregateRacksFromPackingCards — the frontend entry point. From a unit's
// PACKING job cards (each carrying its own rackingNumber), produce the compact
// "Rack 3, 4" grid string covering EVERY piece's rack.
//
// `dropDivan` mirrors deriveComponentRacks' HB-only rule: an HB-only BEDFRAME
// special does not ship its DIVAN, so a stranded DIVAN packing card's rack is
// not a load location and is excluded. Callers compute it from their own
// special-order/category check (the FE has isHbOnlySpecial). Default false.
// ---------------------------------------------------------------------------
export function aggregateRacksFromPackingCards(
  packingCards: ReadonlyArray<RackPackingCard>,
  opts?: { dropDivan?: boolean },
): string {
  const dropDivan = opts?.dropDivan ?? false;
  const racks: string[] = [];
  for (const j of packingCards) {
    if (dropDivan && (j.wipType || "").toUpperCase() === "DIVAN") continue;
    const rack = (j.rackingNumber || "").trim();
    if (rack) racks.push(rack);
  }
  return formatRacksCompact(racks);
}
