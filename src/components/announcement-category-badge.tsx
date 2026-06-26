// ============================================================
// Shared category pill badge — used by the office composer/list
// (src/pages/announcements.tsx) AND the worker portal (home banner + must-ack
// popup in worker/index.tsx, past-archive in worker/me.tsx).
//
// Renders a small colored pill: lucide icon + label, colors from the shared
// announcement-category metadata. ADDITIVE — a missing/unknown category
// normalizes to General Memo (gray).
// ============================================================
import { announcementCategoryMeta } from "@/lib/announcement-category";

export function AnnouncementCategoryBadge({
  category,
  className = "",
}: {
  category: unknown;
  className?: string;
}) {
  const meta = announcementCategoryMeta(category);
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.badgeClass} ${className}`}
    >
      <Icon className="h-3 w-3 shrink-0" />
      {meta.label}
    </span>
  );
}
