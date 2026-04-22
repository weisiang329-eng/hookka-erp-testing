// ============================================================
// HOOKKA ERP - Design Tokens (Single Source of Truth for UI)
// ============================================================
//
// Centralises every colour decision the UI makes. Pages must
// import these tokens instead of hard-coding Tailwind shades
// like `text-green-600` or `bg-red-50`. That way:
//
//   1. Brand palette drift is impossible — there is one list.
//   2. Re-theming is a single-file edit.
//   3. Backend enums (e.g. ChartOfAccount.type, RackLocation.status)
//      have a canonical colour mapping documented in one place.
//
// Colour philosophy (confirmed with stakeholder):
//   - Semantic meaning is preserved universally (green = positive,
//     red = negative, amber = warning, blue/teal = info). This
//     follows accounting / ERP convention and keeps every
//     financial or status display immediately legible.
//   - Shades are earthier / more muted than raw Tailwind defaults
//     so they harmonise with the primary brand colour #6B5C32
//     (warm brown-gold). Think "land of gold and moss" rather
//     than "dashboard-startup neon".
//
// Backend-driven: every semantic decision listed below maps from
// an actual backend enum / field / threshold. See comments.
// ============================================================

// ─────────────────────────────────────────────────────────────
// 1. Brand palette (existing — do not remap, these are the
//    chrome of every page: headings, surfaces, borders, muted).
// ─────────────────────────────────────────────────────────────

export const BRAND = {
  /** Primary brand colour — warm brown-gold, used for active states, links, focused rings. */
  primary:      "#6B5C32",
  /** Darker brand for hover / pressed. */
  primaryDark:  "#574A28",
  /** Near-black heading colour. */
  heading:      "#1F1D1B",
  /** Body text (neutral gray, slightly cool). */
  body:         "#6B7280",
  /** Muted secondary text (warm gray). */
  muted:        "#8A7F73",
  /** Placeholder / disabled text. */
  placeholder:  "#9A918A",
  /** Border beige — on white surfaces. */
  border:       "#E6E0D9",
  /** Border beige — on cream surfaces. */
  borderAlt:    "#E2DDD8",
  /** Cream page background. */
  bgCream:      "#FAF8F4",
  /** Slightly warmer cream for cards on cream pages. */
  bgCreamAlt:   "#FAF9F7",
  /** Pure white surface. */
  bgSurface:    "#FFFFFF",
  /** Hover-row tint on white surfaces. */
  bgHover:      "#FDFBF7",
} as const;

// ─────────────────────────────────────────────────────────────
// 2. Semantic colours — preserves meaning, brand-aligned shade.
//    These are the ONLY colours pages should use for
//    status/value indication.
//
//    Structure: each bucket has `text`, `bg`, `border` Tailwind
//    class strings so Badge / Cell / Card components can compose
//    them directly.
// ─────────────────────────────────────────────────────────────

export type SemanticStyle = {
  /** e.g. "text-[#4F7C3A]" — apply to foreground text / icons. */
  text:   string;
  /** e.g. "bg-[#EEF3E4]" — apply to chip / row tint background. */
  bg:     string;
  /** e.g. "border-[#C6DBA8]" — apply when using a bordered chip. */
  border: string;
  /** Raw hex for inline styles (e.g. chart bars, SVG strokes). */
  hex:    string;
};

/** Success — positive balance, completed, approved, in stock, adequate. */
export const SUCCESS: SemanticStyle = {
  text:   "text-[#4F7C3A]",
  bg:     "bg-[#EEF3E4]",
  border: "border-[#C6DBA8]",
  hex:    "#4F7C3A",
};

/** Warning — aging 60d, low stock, reserved, needs attention. */
export const WARNING: SemanticStyle = {
  text:   "text-[#9C6F1E]",
  bg:     "bg-[#FAEFCB]",
  border: "border-[#E8D597]",
  hex:    "#9C6F1E",
};

/** Escalating warning — aging 90d, high-risk but not yet critical. */
export const WARNING_HIGH: SemanticStyle = {
  text:   "text-[#B8601A]",
  bg:     "bg-[#FBE4CE]",
  border: "border-[#E8B786]",
  hex:    "#B8601A",
};

/** Danger — negative balance, overdue >90d, out of stock, rejected, unbalanced. */
export const DANGER: SemanticStyle = {
  text:   "text-[#9A3A2D]",
  bg:     "bg-[#F9E1DA]",
  border: "border-[#E8B2A1]",
  hex:    "#9A3A2D",
};

/** Info — AP outstanding, in-progress, assets, neutral-positive. */
export const INFO: SemanticStyle = {
  text:   "text-[#3E6570]",
  bg:     "bg-[#E0EDF0]",
  border: "border-[#A8CAD2]",
  hex:    "#3E6570",
};

/** Neutral — draft, inactive, current aging, no special state. */
export const NEUTRAL: SemanticStyle = {
  text:   "text-[#6B7280]",
  bg:     "bg-[#F5F2ED]",
  border: "border-[#E6E0D9]",
  hex:    "#6B7280",
};

/** Equity / accounting convention — plum, distinguished from danger/liability. */
export const ACCENT_PLUM: SemanticStyle = {
  text:   "text-[#6B4A6D]",
  bg:     "bg-[#F1E6F0]",
  border: "border-[#D1B7D0]",
  hex:    "#6B4A6D",
};

// ─────────────────────────────────────────────────────────────
// 3. Backend-enum → semantic mappings.
//
//    These mirror the exact backend type definitions. When the
//    backend adds a new enum value, add the corresponding
//    colour here (TypeScript will complain if you miss one).
// ─────────────────────────────────────────────────────────────

/**
 * Maps `ChartOfAccount.type` (mock-data.ts L4173) to colour.
 * Follows standard accounting convention:
 *   - Assets  = info (blue/teal, resources we own)
 *   - Liabilities = danger (red, what we owe)
 *   - Equity = plum (neutral third category)
 *   - Revenue = success (positive)
 *   - Expense = warning (consumption, amber)
 */
export const COA_TYPE_COLOR: Record<
  "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE",
  SemanticStyle
> = {
  ASSET:     INFO,
  LIABILITY: DANGER,
  EQUITY:    ACCENT_PLUM,
  REVENUE:   SUCCESS,
  EXPENSE:   WARNING,
};

/**
 * Maps `RackLocation.status` (mock-data.ts L3981) to colour.
 *   - EMPTY    = success (available to use)
 *   - OCCUPIED = info (in use, not a problem)
 *   - RESERVED = warning (held for pending order, mild attention)
 */
export const RACK_STATUS_COLOR: Record<
  "EMPTY" | "OCCUPIED" | "RESERVED",
  SemanticStyle
> = {
  EMPTY:    SUCCESS,
  OCCUPIED: INFO,
  RESERVED: WARNING,
};

/**
 * Maps AR/AP aging buckets (ARAgingEntry / APAgingEntry) to
 * colour, where age severity compounds:
 *   current / 30d = neutral (normal payment window)
 *   60d           = warning (starting to age)
 *   90d           = warning-high (getting bad)
 *   >90d          = danger (critical / write-off risk)
 *
 * AR vs AP share the same buckets; tint direction (red vs blue)
 * is handled by the `TotalOutstanding` header, not buckets.
 */
export const AGING_BUCKET_COLOR: Record<
  "currentSen" | "days30Sen" | "days60Sen" | "days90Sen" | "over90Sen",
  SemanticStyle
> = {
  currentSen: NEUTRAL,
  days30Sen:  NEUTRAL,
  days60Sen:  WARNING,
  days90Sen:  WARNING_HIGH,
  over90Sen:  DANGER,
};

/**
 * Active / Inactive flags — universal UI convention.
 */
export const ACTIVE_COLOR: Record<"ACTIVE" | "INACTIVE", SemanticStyle> = {
  ACTIVE:   SUCCESS,
  INACTIVE: NEUTRAL,
};

// ─────────────────────────────────────────────────────────────
// 4. Frontend thresholds (not from backend — pure FE display
//    decisions). Extracted from hardcoded inline checks so the
//    rules are reviewable in one place.
// ─────────────────────────────────────────────────────────────

/**
 * Inventory stock-level thresholds used on the Inventory page.
 *   stockQty === OUT           → DANGER
 *   stockQty  <  LOW           → WARNING
 *   else                        → NEUTRAL (normal)
 *
 * Keep in sync with `inventory/index.tsx` (was hard-coded <5).
 */
export const STOCK_THRESHOLD = {
  OUT: 0,
  LOW: 5,
} as const;

/**
 * WIP ageing thresholds for the Inventory WIP tab.
 *   ageDays >  CRITICAL_DAYS   → DANGER (too long in WIP, investigate)
 *   ageDays >  WARN_DAYS       → WARNING
 *   else                        → NEUTRAL
 */
export const WIP_AGE_THRESHOLD = {
  WARN_DAYS: 7,
  CRITICAL_DAYS: 14,
} as const;

/**
 * Resolve a stock quantity to its semantic style.
 */
export function getStockSemantic(qty: number): SemanticStyle {
  if (qty === STOCK_THRESHOLD.OUT) return DANGER;
  if (qty < STOCK_THRESHOLD.LOW) return WARNING;
  return NEUTRAL;
}

/**
 * Resolve a WIP age (in days) to its semantic style.
 */
export function getWipAgeSemantic(days: number): SemanticStyle {
  if (days > WIP_AGE_THRESHOLD.CRITICAL_DAYS) return DANGER;
  if (days > WIP_AGE_THRESHOLD.WARN_DAYS) return WARNING;
  return NEUTRAL;
}

/**
 * Resolve a signed balance (sen or RM) to its semantic style.
 * Positive = success, negative = danger, zero = neutral.
 * Applies to P&L net profit, balance-sheet check rows, etc.
 */
export function getSignedBalanceSemantic(value: number): SemanticStyle {
  if (value > 0) return SUCCESS;
  if (value < 0) return DANGER;
  return NEUTRAL;
}

// ─────────────────────────────────────────────────────────────
// 5. Category palettes (Category B in the audit — colours are
//    only for distinguishing categories; the colour itself
//    carries no intrinsic meaning).
//
//    Each palette is a brand-aligned set of 5-7 muted tones that
//    cycle predictably. Pages should pick from these instead of
//    reaching for raw Tailwind `bg-purple-100` etc.
// ─────────────────────────────────────────────────────────────

/**
 * Generic 7-step categorical palette. Use when you need to
 * distinguish types where rank / positivity is irrelevant
 * (e.g. fabric categories, WIP component types, department
 * colour-coding).
 *
 * Guidance: if you have N categories, take the first N entries
 * in declaration order so the same category always gets the
 * same colour across the app.
 */
export const CATEGORY_PALETTE: readonly SemanticStyle[] = [
  { text: "text-[#3E6570]", bg: "bg-[#E0EDF0]", border: "border-[#A8CAD2]", hex: "#3E6570" }, // teal
  { text: "text-[#6B4A6D]", bg: "bg-[#F1E6F0]", border: "border-[#D1B7D0]", hex: "#6B4A6D" }, // plum
  { text: "text-[#4F7C3A]", bg: "bg-[#EEF3E4]", border: "border-[#C6DBA8]", hex: "#4F7C3A" }, // moss
  { text: "text-[#9C6F1E]", bg: "bg-[#FAEFCB]", border: "border-[#E8D597]", hex: "#9C6F1E" }, // amber
  { text: "text-[#8C5A42]", bg: "bg-[#F2E4DB]", border: "border-[#D7B8A4]", hex: "#8C5A42" }, // terracotta
  { text: "text-[#3B5670]", bg: "bg-[#DFE7EF]", border: "border-[#A5B9CE]", hex: "#3B5670" }, // slate blue
  { text: "text-[#6B5C32]", bg: "bg-[#F0EAD8]", border: "border-[#D4C69E]", hex: "#6B5C32" }, // brand gold
] as const;

/**
 * Inventory WIP / component type palette (replaces the
 * hard-coded purple/blue/amber/cyan/rose map in
 * `inventory/index.tsx`).
 */
export const INVENTORY_TYPE_COLOR: Record<string, SemanticStyle> = {
  "Finished Good": CATEGORY_PALETTE[1], // plum
  Divan:           CATEGORY_PALETTE[0], // teal
  Headboard:       CATEGORY_PALETTE[3], // amber
  Cushion:         CATEGORY_PALETTE[5], // slate blue
  Headrest:        CATEGORY_PALETTE[4], // terracotta
  Foam:            CATEGORY_PALETTE[2], // moss
  Wood:            CATEGORY_PALETTE[6], // brand gold
};

/**
 * Fabric category palette (replaces the hard-coded map in
 * `inventory/fabrics.tsx`).
 */
export const FABRIC_CATEGORY_COLOR: Record<string, SemanticStyle> = {
  "B.M-FABR":  CATEGORY_PALETTE[0], // teal (bedframe material)
  "S-FABR":    CATEGORY_PALETTE[1], // plum (sofa)
  "S.M-FABR":  CATEGORY_PALETTE[2], // moss (sofa material)
  LINING:      CATEGORY_PALETTE[3], // amber
  WEBBING:     CATEGORY_PALETTE[5], // slate blue
};

/**
 * Item category palette (BEDFRAME vs SOFA vs ACCESSORY at
 * product-level). Used by product lists / order summaries.
 */
export const ITEM_CATEGORY_COLOR: Record<
  "BEDFRAME" | "SOFA" | "ACCESSORY",
  SemanticStyle
> = {
  BEDFRAME:  CATEGORY_PALETTE[0], // teal
  SOFA:      CATEGORY_PALETTE[1], // plum
  ACCESSORY: CATEGORY_PALETTE[3], // amber
};

// ─────────────────────────────────────────────────────────────
// 6. Composed class helpers — tiny utilities so pages can write
//    `badgeClasses(COA_TYPE_COLOR[type])` instead of spelling
//    out `${text} ${bg} ${border}` every time.
// ─────────────────────────────────────────────────────────────

/**
 * Standard chip / pill classes: tint background + colored text +
 * matching border, with rounded padding. For use in <Badge>.
 */
export function badgeClasses(s: SemanticStyle): string {
  return `${s.bg} ${s.text} ${s.border} border rounded px-2 py-0.5 text-xs font-medium`;
}

/**
 * Just the foreground colour — for numeric cells, links,
 * icons where we don't want a filled chip.
 */
export function textOnly(s: SemanticStyle): string {
  return s.text;
}

/**
 * Filled block / tile — larger surface (stat cards, row tints).
 */
export function tileClasses(s: SemanticStyle): string {
  return `${s.bg} ${s.text} ${s.border} border rounded-lg`;
}

/**
 * Resolve an item-category badge style by backend category.
 */
export function getItemCategoryStyle(
  category: "BEDFRAME" | "SOFA" | "ACCESSORY",
): SemanticStyle {
  return ITEM_CATEGORY_COLOR[category];
}

/**
 * Resolve a Chart-of-Accounts type to its style.
 */
export function getCoaTypeStyle(
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE",
): SemanticStyle {
  return COA_TYPE_COLOR[type];
}

/**
 * Resolve a warehouse rack status to its style.
 */
export function getRackStatusStyle(
  status: "EMPTY" | "OCCUPIED" | "RESERVED",
): SemanticStyle {
  return RACK_STATUS_COLOR[status];
}

// ─────────────────────────────────────────────────────────────
// 7. Backend status-enum colour maps — every status value that
//    the backend can emit (types/index.ts + mock-data.ts).
//
//    Audited from:
//      - SOStatus            (types/index.ts L8)
//      - ProductionStatus    (L9)
//      - JobCardStatus       (L10)
//      - DeliveryStatus      (L11)
//      - AttendanceStatus    (L12)
//      - ConsignmentItemStatus (L15)
//      - TransitStatus       (L16)
//      - RDProjectStage      (L17)
//      - BOMVersionStatus    (L19)
//      - FGUnitStatus        (mock-data.ts L3598)
//
//    Colour philosophy applied consistently across all of them:
//      NEUTRAL  — initial/draft/waiting state with no attention
//                 required ("nothing wrong, nothing done yet")
//      INFO     — active/in-motion state ("happening now")
//      SUCCESS  — positive terminal / progressed state
//                 ("reached a good milestone")
//      WARNING  — attention required / paused / blocked
//      DANGER   — cancelled / rejected / damaged / overdue
// ─────────────────────────────────────────────────────────────

/**
 * Sales Order lifecycle. Ordered roughly by stage:
 * DRAFT → CONFIRMED → IN_PRODUCTION → READY_TO_SHIP → SHIPPED
 *       → DELIVERED → INVOICED → CLOSED (ON_HOLD / CANCELLED branches).
 */
export const SO_STATUS_COLOR: Record<
  | "DRAFT" | "CONFIRMED" | "IN_PRODUCTION" | "READY_TO_SHIP" | "SHIPPED"
  | "DELIVERED" | "INVOICED" | "CLOSED" | "ON_HOLD" | "CANCELLED",
  SemanticStyle
> = {
  DRAFT:          NEUTRAL,
  CONFIRMED:      INFO,
  IN_PRODUCTION:  INFO,
  READY_TO_SHIP:  SUCCESS,
  SHIPPED:        INFO,
  DELIVERED:      SUCCESS,
  INVOICED:       SUCCESS,
  CLOSED:         NEUTRAL,
  ON_HOLD:        WARNING,
  CANCELLED:      DANGER,
};

/** Production-order lifecycle (ProductionStatus in types/index.ts:9). */
export const PRODUCTION_STATUS_COLOR: Record<
  "PENDING" | "IN_PROGRESS" | "COMPLETED" | "ON_HOLD" | "CANCELLED" | "PAUSED",
  SemanticStyle
> = {
  PENDING:     NEUTRAL,
  IN_PROGRESS: INFO,
  COMPLETED:   SUCCESS,
  ON_HOLD:     WARNING,
  PAUSED:      WARNING,
  CANCELLED:   DANGER,
};

/** Job-card lifecycle on a single PO × Department slot. */
export const JOB_CARD_STATUS_COLOR: Record<
  "WAITING" | "IN_PROGRESS" | "PAUSED" | "COMPLETED" | "TRANSFERRED" | "BLOCKED",
  SemanticStyle
> = {
  WAITING:     NEUTRAL,
  IN_PROGRESS: INFO,
  PAUSED:      WARNING,
  BLOCKED:     DANGER, // upstream issue — needs escalation
  COMPLETED:   SUCCESS,
  TRANSFERRED: SUCCESS,
};

/** Delivery-order lifecycle (DeliveryStatus in types/index.ts:11). */
export const DELIVERY_STATUS_COLOR: Record<
  | "DRAFT" | "LOADED" | "DISPATCHED" | "IN_TRANSIT"
  | "SIGNED" | "DELIVERED" | "INVOICED" | "CANCELLED",
  SemanticStyle
> = {
  DRAFT:      NEUTRAL,
  LOADED:     INFO,
  DISPATCHED: INFO,
  IN_TRANSIT: INFO,
  SIGNED:     SUCCESS,
  DELIVERED:  SUCCESS,
  INVOICED:   SUCCESS,
  CANCELLED:  DANGER,
};

/** Attendance per worker per day. */
export const ATTENDANCE_STATUS_COLOR: Record<
  | "PRESENT" | "ABSENT" | "HALF_DAY"
  | "MEDICAL_LEAVE" | "ANNUAL_LEAVE" | "REST_DAY",
  SemanticStyle
> = {
  PRESENT:        SUCCESS,
  ABSENT:         DANGER,
  HALF_DAY:       WARNING,
  MEDICAL_LEAVE:  INFO,   // legitimate absence, company-approved
  ANNUAL_LEAVE:   INFO,
  REST_DAY:       NEUTRAL,
};

/** Consignment item at a customer branch. */
export const CONSIGNMENT_ITEM_STATUS_COLOR: Record<
  "AT_BRANCH" | "SOLD" | "RETURNED" | "DAMAGED",
  SemanticStyle
> = {
  AT_BRANCH: INFO,
  SOLD:      SUCCESS,
  RETURNED:  WARNING, // came back, didn't sell, but ok
  DAMAGED:   DANGER,
};

/** Goods-in-Transit (international purchase incoming). */
export const TRANSIT_STATUS_COLOR: Record<
  "ORDERED" | "SHIPPED" | "IN_TRANSIT" | "CUSTOMS" | "RECEIVED",
  SemanticStyle
> = {
  ORDERED:    NEUTRAL,
  SHIPPED:    INFO,
  IN_TRANSIT: INFO,
  CUSTOMS:    WARNING,  // typically where delays happen
  RECEIVED:   SUCCESS,
};

/** R&D project pipeline stage. */
export const RD_STAGE_COLOR: Record<
  "CONCEPT" | "DESIGN" | "PROTOTYPE" | "TESTING" | "APPROVED" | "PRODUCTION_READY",
  SemanticStyle
> = {
  CONCEPT:          NEUTRAL,
  DESIGN:           INFO,
  PROTOTYPE:        INFO,
  TESTING:          WARNING, // needs manual sign-off
  APPROVED:         SUCCESS,
  PRODUCTION_READY: SUCCESS,
};

/** BOM version lifecycle. */
export const BOM_VERSION_STATUS_COLOR: Record<
  "DRAFT" | "ACTIVE" | "OBSOLETE",
  SemanticStyle
> = {
  DRAFT:    NEUTRAL,
  ACTIVE:   SUCCESS,
  OBSOLETE: NEUTRAL,  // terminal, no longer in use, but not bad
};

/** FG unit lifecycle (sticker flow + legacy). */
export const FG_UNIT_STATUS_COLOR: Record<
  | "PENDING" | "PENDING_UPHOLSTERY" | "UPHOLSTERED"
  | "PACKED" | "LOADED" | "DELIVERED" | "RETURNED",
  SemanticStyle
> = {
  PENDING:             NEUTRAL,
  PENDING_UPHOLSTERY:  NEUTRAL,
  UPHOLSTERED:         INFO,
  PACKED:              INFO,
  LOADED:              INFO,
  DELIVERED:           SUCCESS,
  RETURNED:            WARNING, // came back, needs review
};

// ─────────────────────────────────────────────────────────────
// 8. Backend category-enum colour maps — non-lifecycle
//    classification, colours are just for distinguishing types.
// ─────────────────────────────────────────────────────────────

/**
 * WIP component types — what kind of intermediate the
 * production line is building. Paired with existing
 * INVENTORY_TYPE_COLOR visual language.
 */
export const WIP_TYPE_COLOR: Record<
  | "HEADBOARD" | "DIVAN" | "SOFA_BASE"
  | "SOFA_CUSHION" | "SOFA_ARMREST" | "SOFA_HEADREST",
  SemanticStyle
> = {
  HEADBOARD:     CATEGORY_PALETTE[3], // amber
  DIVAN:         CATEGORY_PALETTE[0], // teal
  SOFA_BASE:     CATEGORY_PALETTE[1], // plum
  SOFA_CUSHION:  CATEGORY_PALETTE[5], // slate blue
  SOFA_ARMREST:  CATEGORY_PALETTE[4], // terracotta
  SOFA_HEADREST: CATEGORY_PALETTE[2], // moss
};

/**
 * Stock-category buckets used on Inventory pages. These are
 * purely categorical — colour choice is arbitrary as long as
 * they're visually distinct.
 */
export const STOCK_CATEGORY_COLOR: Record<
  | "FINISHED_GOOD" | "WIP" | "BM_FABRIC" | "SM_FABRIC"
  | "PLYWOOD" | "WD_STRIP" | "B_FILLER"
  | "ACCESSORIES" | "WEBBING" | "PACKING" | "OTHERS",
  SemanticStyle
> = {
  FINISHED_GOOD: CATEGORY_PALETTE[1], // plum
  WIP:           CATEGORY_PALETTE[3], // amber
  BM_FABRIC:     CATEGORY_PALETTE[0], // teal
  SM_FABRIC:     CATEGORY_PALETTE[2], // moss
  PLYWOOD:       CATEGORY_PALETTE[6], // brand gold
  WD_STRIP:      CATEGORY_PALETTE[4], // terracotta
  B_FILLER:      CATEGORY_PALETTE[5], // slate blue
  ACCESSORIES:   CATEGORY_PALETTE[4], // terracotta (re-use, low volume)
  WEBBING:       CATEGORY_PALETTE[5], // slate blue (re-use)
  PACKING:       CATEGORY_PALETTE[6], // brand gold (re-use)
  OTHERS:        NEUTRAL,
};

/** R&D prototype kind. */
export const RD_PROTOTYPE_TYPE_COLOR: Record<
  "FABRIC_SEWING" | "FRAMING",
  SemanticStyle
> = {
  FABRIC_SEWING: CATEGORY_PALETTE[1], // plum
  FRAMING:       CATEGORY_PALETTE[6], // brand gold
};

/** R&D project type. */
export const RD_PROJECT_TYPE_COLOR: Record<
  "DEVELOPMENT" | "IMPROVEMENT",
  SemanticStyle
> = {
  DEVELOPMENT: INFO,
  IMPROVEMENT: SUCCESS,
};

/** Lead-time category (BEDFRAME vs SOFA). Aliased to ItemCategory subset. */
export const LEAD_TIME_CATEGORY_COLOR: Record<
  "BEDFRAME" | "SOFA",
  SemanticStyle
> = {
  BEDFRAME: ITEM_CATEGORY_COLOR.BEDFRAME,
  SOFA:     ITEM_CATEGORY_COLOR.SOFA,
};

// ─────────────────────────────────────────────────────────────
// 9. Type-safe resolvers — pages should call these instead of
//    reaching into the maps directly. Keeps every callsite
//    compile-checked against the backend enum.
// ─────────────────────────────────────────────────────────────

export function getSOStatusStyle(s: keyof typeof SO_STATUS_COLOR): SemanticStyle {
  return SO_STATUS_COLOR[s];
}

export function getProductionStatusStyle(s: keyof typeof PRODUCTION_STATUS_COLOR): SemanticStyle {
  return PRODUCTION_STATUS_COLOR[s];
}

export function getJobCardStatusStyle(s: keyof typeof JOB_CARD_STATUS_COLOR): SemanticStyle {
  return JOB_CARD_STATUS_COLOR[s];
}

export function getDeliveryStatusStyle(s: keyof typeof DELIVERY_STATUS_COLOR): SemanticStyle {
  return DELIVERY_STATUS_COLOR[s];
}

export function getAttendanceStatusStyle(s: keyof typeof ATTENDANCE_STATUS_COLOR): SemanticStyle {
  return ATTENDANCE_STATUS_COLOR[s];
}

export function getConsignmentItemStatusStyle(s: keyof typeof CONSIGNMENT_ITEM_STATUS_COLOR): SemanticStyle {
  return CONSIGNMENT_ITEM_STATUS_COLOR[s];
}

export function getTransitStatusStyle(s: keyof typeof TRANSIT_STATUS_COLOR): SemanticStyle {
  return TRANSIT_STATUS_COLOR[s];
}

export function getRDStageStyle(s: keyof typeof RD_STAGE_COLOR): SemanticStyle {
  return RD_STAGE_COLOR[s];
}

export function getBOMVersionStatusStyle(s: keyof typeof BOM_VERSION_STATUS_COLOR): SemanticStyle {
  return BOM_VERSION_STATUS_COLOR[s];
}

export function getFGUnitStatusStyle(s: keyof typeof FG_UNIT_STATUS_COLOR): SemanticStyle {
  return FG_UNIT_STATUS_COLOR[s];
}

export function getWipTypeStyle(t: keyof typeof WIP_TYPE_COLOR): SemanticStyle {
  return WIP_TYPE_COLOR[t];
}

export function getStockCategoryStyle(c: keyof typeof STOCK_CATEGORY_COLOR): SemanticStyle {
  return STOCK_CATEGORY_COLOR[c];
}

/**
 * Fallback: when a status string is not statically known
 * (e.g. comes from an API that may evolve), return NEUTRAL
 * so the UI remains safe. Logs a dev warning.
 */
export function resolveUnknownStatus(label: string): SemanticStyle {
  if (import.meta.env?.DEV) {
     
    console.warn(`[design-tokens] Unknown status "${label}" — using NEUTRAL. Add it to the relevant enum map.`);
  }
  return NEUTRAL;
}
