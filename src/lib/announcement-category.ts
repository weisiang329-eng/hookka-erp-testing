// ============================================================
// Announcement categories (4 types) — shared metadata used by BOTH the office
// composer/list (src/pages/announcements.tsx) and the worker portal (home
// banner + must-ack popup in worker/index.tsx, past-archive in worker/me.tsx).
//
// ADDITIVE: existing (categoryless) announcements default to GENERAL, so the
// whole flow is back-compatible. The backend normalizes unknown/missing values
// to GENERAL too (toPublic in src/api/routes/announcements.ts).
//
// Each entry carries the lucide-react icon component + Tailwind classes for the
// colored pill badge. Keep this the single source of truth for the labels and
// colors so the office and the phone render identical badges.
// ============================================================
import {
  MessageSquare,
  AlertTriangle,
  ClipboardList,
  GraduationCap,
  type LucideIcon,
} from "lucide-react";

// The four category values. GENERAL is the back-compat default.
export type AnnouncementCategory = "GENERAL" | "WARNING" | "SOP" | "LEARNING";

export type AnnouncementCategoryMeta = {
  value: AnnouncementCategory;
  label: string;
  icon: LucideIcon;
  // Tailwind classes for the badge pill (background + text). Matches the
  // owner-approved colors:
  //   GENERAL  gray  bg #F1EFE8 / text #444441
  //   WARNING  red   bg #FCEBEB / text #A32D2D
  //   SOP      blue  bg #E6F1FB / text #0C447C
  //   LEARNING teal  bg #E1F5EE / text #085041
  badgeClass: string;
};

export const ANNOUNCEMENT_CATEGORIES: Record<
  AnnouncementCategory,
  AnnouncementCategoryMeta
> = {
  GENERAL: {
    value: "GENERAL",
    label: "General Memo",
    icon: MessageSquare,
    badgeClass: "bg-[#F1EFE8] text-[#444441]",
  },
  WARNING: {
    value: "WARNING",
    label: "Warning",
    icon: AlertTriangle,
    badgeClass: "bg-[#FCEBEB] text-[#A32D2D]",
  },
  SOP: {
    value: "SOP",
    label: "SOP",
    icon: ClipboardList,
    badgeClass: "bg-[#E6F1FB] text-[#0C447C]",
  },
  LEARNING: {
    value: "LEARNING",
    label: "Learning",
    icon: GraduationCap,
    badgeClass: "bg-[#E1F5EE] text-[#085041]",
  },
};

// Ordered list for rendering selectors / filter chips (General first).
export const ANNOUNCEMENT_CATEGORY_ORDER: AnnouncementCategory[] = [
  "GENERAL",
  "WARNING",
  "SOP",
  "LEARNING",
];

// Normalize an arbitrary value (missing / unknown / lowercase) to a known
// category, defaulting to GENERAL. Used on every read so a categoryless or
// corrupt value never breaks rendering.
export function normalizeAnnouncementCategory(
  v: unknown,
): AnnouncementCategory {
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "WARNING" || s === "SOP" || s === "LEARNING") return s;
  return "GENERAL";
}

// Look up the metadata for a (possibly raw) category value.
export function announcementCategoryMeta(
  v: unknown,
): AnnouncementCategoryMeta {
  return ANNOUNCEMENT_CATEGORIES[normalizeAnnouncementCategory(v)];
}
