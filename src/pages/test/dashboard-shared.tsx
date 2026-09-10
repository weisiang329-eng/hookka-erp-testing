import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { LucideIcon } from "lucide-react";

// Shared bits for the dashboard-prototype tabs (SalesOrdersView + the ones
// ported from it) — one Kpi card, one number formatter, one palette, so the
// six tabs read as one dashboard instead of six independently-styled pages.
export const TAUPE = "#6B5C32";
export const TEAL = "#3E6570";
export const MUTED = "#6B7280";
export const BORDER = "#E2DDD8";
export const GREEN = "#4F7C3A";
export const AMBER = "#9C6F1E";
export const RED = "#9A3A2D";

export function fmtN(n: number): string {
  return n.toLocaleString("en-MY");
}

export function LiveBadge({ live }: { live: boolean }) {
  return (
    <Badge
      className={
        live
          ? "bg-[#EEF3E4] text-[#4F7C3A] border-[#EEF3E4]"
          : "bg-[#FDF3E4] text-[#B5701A] border-[#FDF3E4]"
      }
    >
      {live ? "live" : "not live"}
    </Badge>
  );
}

export function Kpi({
  label,
  value,
  sub,
  icon: Icon,
  iconBgClass,
  iconColorClass,
  valueColorClass,
  valueSizeClass,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: LucideIcon;
  iconBgClass: string;
  iconColorClass: string;
  valueColorClass?: string;
  valueSizeClass?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <div className={cn("rounded-lg p-2.5 shrink-0", iconBgClass)}>
          <Icon className={cn("h-5 w-5", iconColorClass)} />
        </div>
        <div className="min-w-0">
          <p
            className={cn(
              "font-bold truncate tabular-nums",
              valueSizeClass ?? "text-2xl",
              valueColorClass ?? "text-[#1F1D1B]",
            )}
          >
            {value}
          </p>
          <p className="text-xs text-[#6B7280]">{label}</p>
          {sub && <p className="text-xs text-[#6B7280]">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

// A section whose live source isn't wired says so instead of rendering a
// zero that looks like a measurement — mirrors availability.<section>.missing
// from GET /api/dashboard/prototype.
export function MissingNote({ fields }: { fields: string[] }) {
  if (fields.length === 0) return null;
  return (
    <p className="text-xs text-[#9C6F1E]">
      Not available yet: {fields.join(", ")}.
    </p>
  );
}
