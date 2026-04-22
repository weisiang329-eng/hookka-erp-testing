// ---------------------------------------------------------------------------
// PresenceBanner — shows a compact yellow banner when one or more other
// users have an edit view of the same record open. Designed to sit at the
// top of a detail/edit page so it's unmissable but not blocking.
// ---------------------------------------------------------------------------
import { Users } from "lucide-react";
import type { PresenceHolder } from "@/lib/use-presence";

export function PresenceBanner({ holders }: { holders: PresenceHolder[] }) {
  if (!holders.length) return null;

  const names = holders.map((h) => h.displayName || "Someone");
  const label =
    names.length === 1
      ? `${names[0]} is also editing this — save conflicts may occur.`
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are also editing this — save conflicts may occur.`;

  return (
    <div className="flex items-center gap-2 rounded-md border border-[#E0C97A] bg-[#FBF3DA] px-3 py-2 text-sm text-[#7A5A1E]">
      <Users className="h-4 w-4 shrink-0" />
      <span>{label}</span>
    </div>
  );
}
