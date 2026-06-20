// ---------------------------------------------------------------------------
// PurchaseLineageBar — compact pill/button bar showing the PO → GRN → PI
// document chain for Purchasing detail pages.
//
// Each pill: icon + label + count badge. Disabled/greyed when count is 0.
// Clicking a pill navigates to the linked document's detail page (single)
// or the filtered list (multiple). Read-only — no data writes.
//
// Usage:
//   <PurchaseLineageBar
//     parent={{ type: "PO", docNo: "PO-2606-001", href: "/procurement/abc123" }}
//     links={[
//       { type: "GRN", label: "GRNs", count: 2, items: [...] },
//       { type: "PI",  label: "Invoices", count: 1, items: [...] },
//     ]}
//   />
//
// The `parent` prop (optional) renders a greyed pill for the upstream document.
// The `links` array renders forward-link pills. When count === 1, clicking
// navigates directly to that doc's href. When count > 1 an `onExpand` callback
// is fired (default: no-op; caller can open a popover).
// ---------------------------------------------------------------------------

import { Link } from "react-router-dom";
import { Package, FileText, ShoppingCart } from "lucide-react";

// Icon per document type
const TYPE_ICONS = {
  PO: ShoppingCart,
  GRN: Package,
  PI: FileText,
} as const;

// Bronze accent palette (matches the rest of the procurement pages)
const PILL_BASE =
  "inline-flex items-center gap-1.5 rounded-full border text-xs font-medium transition-colors";
const PILL_ACTIVE =
  "border-[#C9B882] bg-[#F0ECE9] text-[#6B5C32] hover:bg-[#E8E0D0] cursor-pointer";
const PILL_DISABLED =
  "border-[#E2DDD8] bg-white text-[#9CA3AF] cursor-default select-none opacity-60";
const PILL_PARENT =
  "border-[#D1CBC5] bg-white text-[#6B7280] hover:bg-[#F3F0EA] cursor-pointer";

export type LineageLinkItem = {
  id: string;
  docNo: string;
  href: string;
  status?: string | null;
};

export type LineageLink = {
  type: keyof typeof TYPE_ICONS;
  label: string;
  count: number;
  items: LineageLinkItem[];
};

export type LineageParent = {
  type: keyof typeof TYPE_ICONS;
  docNo: string;
  href: string;
};

export function PurchaseLineageBar({
  parent,
  links,
}: {
  parent?: LineageParent | null;
  links: LineageLink[];
}) {
  if (!parent && links.length === 0) return null;

  const ParentIcon = parent ? TYPE_ICONS[parent.type] : null;

  return (
    <div className="flex flex-wrap items-center gap-2 py-1">
      {/* Optional upstream parent pill */}
      {parent && ParentIcon && (
        <Link
          to={parent.href}
          className={`${PILL_BASE} ${PILL_PARENT} px-3 py-1`}
          title={`Go to ${parent.type} ${parent.docNo}`}
        >
          <ParentIcon className="h-3.5 w-3.5 shrink-0" />
          <span>{parent.docNo}</span>
        </Link>
      )}

      {/* Separator if both parent and links present */}
      {parent && links.length > 0 && (
        <span className="text-[#D1CBC5] text-xs select-none">›</span>
      )}

      {links.map((link) => {
        const Icon = TYPE_ICONS[link.type];

        if (link.count === 0) {
          return (
            <span
              key={link.type}
              className={`${PILL_BASE} ${PILL_DISABLED} px-3 py-1`}
              title={`No ${link.label} linked`}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span>{link.label}</span>
              <CountBadge count={0} />
            </span>
          );
        }

        if (link.count === 1) {
          const item = link.items[0];
          return (
            <Link
              key={link.type}
              to={item.href}
              className={`${PILL_BASE} ${PILL_ACTIVE} px-3 py-1`}
              title={`${link.label}: ${item.docNo}${item.status ? ` (${item.status})` : ""}`}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span>{item.docNo}</span>
              {item.status && (
                <span className="text-[#9CA3AF] text-[10px]">· {item.status}</span>
              )}
            </Link>
          );
        }

        // Multiple docs: show count badge; expand on click (no popover built-in —
        // the first item is the navigation target as a fallback)
        return (
          <Link
            key={link.type}
            to={link.items[0].href}
            className={`${PILL_BASE} ${PILL_ACTIVE} px-3 py-1`}
            title={link.items.map((i) => `${i.docNo}${i.status ? ` (${i.status})` : ""}`).join(", ")}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span>{link.label}</span>
            <CountBadge count={link.count} />
          </Link>
        );
      })}
    </div>
  );
}

function CountBadge({ count }: { count: number }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full px-1.5 min-w-[18px] h-[18px] text-[10px] font-bold ${
        count > 0
          ? "bg-[#6B5C32] text-white"
          : "bg-[#E2DDD8] text-[#9CA3AF]"
      }`}
    >
      {count}
    </span>
  );
}
