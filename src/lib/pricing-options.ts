// ---------------------------------------------------------------------------
// pricing-options — pure data tables for sales / consignment / production
// configurator forms.
//
// Why this exists:
// `src/lib/mock-data.ts` is a 326KB monolith that bundles type defs, ~50
// seed arrays (originally used by the deleted /api/routes-mock dev
// fallback), and a handful of genuinely-needed pricing tables like
// `divanHeightOptions`. Until Sprint 5, every page that needed even one
// constant pulled in the whole mock-data chunk including thousands of
// seed rows the page never touched. This module re-exports just the
// small, stable pricing/option tables, with no transitive dependency on
// the seeds. `mock-data.ts` re-exports from here for back-compat.
//
// Sprint 5, Goal 2 — see PROGRAM-EXECUTION.md.
// ---------------------------------------------------------------------------

// Seat height pricing tiers for sofa modules (in sen = RM * 100).
// Wei Siang 2026-05-15: canonical format is BARE numerics (matches
// kv_config.variants-config.sofaSizes + the validateSofaSizeLabels
// gate at SO/CO POST/PUT). Previously this fallback was quoted
// (`['24"', '28"', ...]`) which contradicted the backend canonical
// and caused SO edits to fail validation when KV config wasn't
// hydrated. Aligned to bare to match Maintenance page + DB +
// backend validator.
export const SEAT_HEIGHT_OPTIONS = ['24', '26', '28', '30', '32', '35'] as const;

// ============================================================
// PRICING CONFIG — Special Orders (from Google Sheet "Special orders" tab)
// All surcharges in sen (1 RM = 100 sen)
// ============================================================

export type DivanHeightOption = {
  height: string; // "4\"", "5\"", etc.
  surcharge: number; // in sen
};

export type SpecialOrderOption = {
  code: string;
  name: string;
  surcharge: number; // in sen (negative for discounts like "No Side Panel")
  notes: string;
};

export type LegHeightOption = {
  height: string;
  surcharge: number; // in sen
};

// 2026-07-23: realigned to kv_config `variants-config`, which is what the
// backend actually prices from. This table is the FALLBACK used whenever the
// live config fails to load, and it had drifted a full price increase behind
// it — every height RM 5–10 low, and "No Side Panel" carried +RM 40 where the
// live config has −RM 40 (a discount stored as a surcharge, an RM 80 swing).
// A silent fallback that under-charges is worse than no fallback.
// tests/price-component-class.test.mjs pins the two together.
export const divanHeightOptions: DivanHeightOption[] = [
  { height: '4"', surcharge: 0 },
  { height: '5"', surcharge: 0 },
  { height: '6"', surcharge: 0 },
  { height: '8"', surcharge: 0 },
  { height: '10"', surcharge: 5500 },
  { height: '11"', surcharge: 13000 },
  { height: '12"', surcharge: 13000 },
  { height: '13"', surcharge: 15000 },
  { height: '14"', surcharge: 15000 },
  { height: '16"', surcharge: 16000 },
];

export const specialOrderOptions: SpecialOrderOption[] = [
  { code: "HB_FULL_COVER", name: "HB Fully Cover", surcharge: 5000, notes: "" },
  { code: "DIVAN_TOP_COVER", name: "Divan Top Fully Cover", surcharge: 5000, notes: "" },
  { code: "DIVAN_BTM_COVER", name: "Divan Full Cover", surcharge: 8000, notes: "If HB & divan full cover combined = RM100 total" },
  { code: "LEFT_DRAWER", name: "Left Drawer", surcharge: 16000, notes: "" },
  { code: "RIGHT_DRAWER", name: "Right Drawer", surcharge: 16000, notes: "" },
  { code: "FRONT_DRAWER", name: "Front Drawer", surcharge: 13000, notes: "" },
  { code: "HB_STRAIGHT", name: "HB Straight", surcharge: 0, notes: "" },
  { code: "DIVAN_TOP_W", name: "Divan Top(W)", surcharge: 0, notes: "" },
  { code: "ONE_PIECE_DIVAN", name: "1 Piece Divan", surcharge: 25000, notes: "" },
  { code: "DIVAN_CURVE", name: "Divan Curve", surcharge: 5000, notes: "" },
  { code: "NO_SIDE_PANEL", name: "No Side Panel", surcharge: -4000, notes: "" },
  { code: "HEADBOARD_ONLY", name: "Headboard Only", surcharge: 0, notes: "Base price ÷ 2" },
  { code: "NYLON_FABRIC", name: "Nylon Fabric", surcharge: 0, notes: "" },
  { code: "5537_BACKREST", name: "5537 Backrest", surcharge: 0, notes: "" },
  { code: "ADD_1_INFRONT_L", name: "Add 1\" Infront L", surcharge: 0, notes: "" },
  { code: "SEP_BACKREST_PACK", name: "Separate Backrest Packing", surcharge: 0, notes: "" },
  { code: "DIVAN_A11", name: "Divan A11", surcharge: 0, notes: "" },
  { code: "SEAT_ADD_ON_4", name: "Seat Add On 4\"", surcharge: 0, notes: "" },
];

export const legHeightOptions: LegHeightOption[] = [
  { height: "No Leg", surcharge: 0 },
  { height: '1"', surcharge: 0 },
  { height: '2"', surcharge: 0 },
  { height: '4"', surcharge: 0 },
  { height: '6"', surcharge: 0 },
  { height: '7"', surcharge: 16000 },
];

/** Gap height options (inches) – standard range offered */
export const gapHeightOptions = ['4"', '5"', '6"', '7"', '8"', '9"', '10"'];
