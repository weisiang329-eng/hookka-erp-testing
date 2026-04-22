import * as React from "react";
import { cn } from "@/lib/utils";
import {
  type SemanticStyle,
  NEUTRAL,
  SO_STATUS_COLOR,
  PRODUCTION_STATUS_COLOR,
  JOB_CARD_STATUS_COLOR,
  DELIVERY_STATUS_COLOR,
  ATTENDANCE_STATUS_COLOR,
  CONSIGNMENT_ITEM_STATUS_COLOR,
  TRANSIT_STATUS_COLOR,
  RD_STAGE_COLOR,
  BOM_VERSION_STATUS_COLOR,
  FG_UNIT_STATUS_COLOR,
  COA_TYPE_COLOR,
  RACK_STATUS_COLOR,
  ACTIVE_COLOR,
  resolveUnknownStatus,
} from "@/lib/design-tokens";

/**
 * Universal status / enum chip.
 *
 * Automatically looks up the correct `SemanticStyle` from
 * `design-tokens.ts` based on the `kind` prop + enum value, so
 * callers never have to know which colour to use.
 *
 * The `kind` prop is restricted to enums we've mapped. Adding a
 * new enum = add a case here + a map in design-tokens.ts.
 *
 * Usage:
 *   <StatusBadge kind="so" value={order.status} />
 *   <StatusBadge kind="delivery" value={delivery.status} />
 *   <StatusBadge kind="attendance" value="PRESENT" />
 *
 * For legacy / dynamic statuses not in any enum, pass
 * `kind="unknown"` — renders neutral and emits a dev warning so
 * it surfaces in the console.
 */

type BadgeSize = "sm" | "md";

export type StatusBadgeKind =
  | "so"
  | "production"
  | "jobcard"
  | "delivery"
  | "attendance"
  | "consignment"
  | "transit"
  | "rd"
  | "bom"
  | "fgunit"
  | "coa"
  | "rack"
  | "active"
  | "unknown";

export interface StatusBadgeProps {
  kind: StatusBadgeKind;
  /** The enum value to render. */
  value: string;
  /** Override the displayed label (default: value with underscores → spaces). */
  label?: React.ReactNode;
  /** sm = 11px tight, md = 12px (default sm for table cells, md for headers). */
  size?: BadgeSize;
  /** Render style: chip (filled bg, default), outline (border only), text (no chip). */
  appearance?: "chip" | "outline" | "text";
  className?: string;
}

/**
 * Resolve `kind` + `value` to a SemanticStyle. Any value the map
 * doesn't know falls back to NEUTRAL via `resolveUnknownStatus`.
 */
function lookupStyle(kind: StatusBadgeKind, value: string): SemanticStyle {
  const tryMap = <K extends string>(
    map: Record<K, SemanticStyle>,
  ): SemanticStyle => {
    return (map as Record<string, SemanticStyle>)[value] ?? resolveUnknownStatus(`${kind}:${value}`);
  };

  switch (kind) {
    case "so":            return tryMap(SO_STATUS_COLOR);
    case "production":    return tryMap(PRODUCTION_STATUS_COLOR);
    case "jobcard":       return tryMap(JOB_CARD_STATUS_COLOR);
    case "delivery":      return tryMap(DELIVERY_STATUS_COLOR);
    case "attendance":    return tryMap(ATTENDANCE_STATUS_COLOR);
    case "consignment":   return tryMap(CONSIGNMENT_ITEM_STATUS_COLOR);
    case "transit":       return tryMap(TRANSIT_STATUS_COLOR);
    case "rd":            return tryMap(RD_STAGE_COLOR);
    case "bom":           return tryMap(BOM_VERSION_STATUS_COLOR);
    case "fgunit":        return tryMap(FG_UNIT_STATUS_COLOR);
    case "coa":           return tryMap(COA_TYPE_COLOR);
    case "rack":          return tryMap(RACK_STATUS_COLOR);
    case "active":        return tryMap(ACTIVE_COLOR);
    case "unknown":
    default:              return resolveUnknownStatus(`${kind}:${value}`);
  }
}

export function StatusBadge({
  kind,
  value,
  label,
  size = "sm",
  appearance = "chip",
  className,
}: StatusBadgeProps) {
  const style = lookupStyle(kind, value);

  const sizeClass =
    size === "sm"
      ? "px-2 py-0.5 text-[11px]"
      : "px-2.5 py-0.5 text-xs";

  if (appearance === "text") {
    return (
      <span className={cn(style.text, "font-medium", className)}>
        {label ?? value.replace(/_/g, " ")}
      </span>
    );
  }

  const bgClass = appearance === "outline" ? "bg-transparent" : style.bg;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border font-medium",
        sizeClass,
        style.text,
        bgClass,
        style.border,
        className,
      )}
    >
      {label ?? value.replace(/_/g, " ")}
    </span>
  );
}

/**
 * Legacy-compat: resolves a style for a raw status string without
 * knowing its kind. Tries every known map in sequence; falls back
 * to NEUTRAL. Use ONLY for migration of pages that mix many enums.
 */
export function getAnyStatusStyle(value: string): SemanticStyle {
  const maps: Record<string, SemanticStyle>[] = [
    SO_STATUS_COLOR as Record<string, SemanticStyle>,
    PRODUCTION_STATUS_COLOR as Record<string, SemanticStyle>,
    JOB_CARD_STATUS_COLOR as Record<string, SemanticStyle>,
    DELIVERY_STATUS_COLOR as Record<string, SemanticStyle>,
    ATTENDANCE_STATUS_COLOR as Record<string, SemanticStyle>,
    CONSIGNMENT_ITEM_STATUS_COLOR as Record<string, SemanticStyle>,
    TRANSIT_STATUS_COLOR as Record<string, SemanticStyle>,
    RD_STAGE_COLOR as Record<string, SemanticStyle>,
    BOM_VERSION_STATUS_COLOR as Record<string, SemanticStyle>,
    FG_UNIT_STATUS_COLOR as Record<string, SemanticStyle>,
    COA_TYPE_COLOR as Record<string, SemanticStyle>,
    RACK_STATUS_COLOR as Record<string, SemanticStyle>,
    ACTIVE_COLOR as Record<string, SemanticStyle>,
  ];
  for (const m of maps) {
    if (value in m) return m[value];
  }
  return NEUTRAL;
}
