// ---------------------------------------------------------------------------
// Breadcrumbs — URL-driven navigation strip below the topbar.
//
// Replaces the in-app tab strip we used before. Matches the pattern
// every mainstream ERP uses (Odoo, SAP Fiori, Oracle Fusion, Dynamics):
// a horizontal "Sales › New Order › #SO-123" trail rebuilt from the
// current URL on every render — no extra state, no localStorage, no
// re-render fanout to other consumers.
//
// How labels work
// ---------------
// The label table below maps each URL pattern to a human title. The
// table is the same set of regexes the old tabs-context exported as
// PATH_TITLES — keeping both in sync is unnecessary because there is
// only one consumer now (this component).
//
// For nested paths we build progressive sub-paths and look each one up,
// so /sales/123/edit produces three crumbs:
//   Sales (link → /sales) › Sales · 123 (link → /sales/123) › Edit (current)
// ---------------------------------------------------------------------------
import { Fragment } from "react";
import { Link, useLocation } from "react-router-dom";
import { ChevronRight, Home } from "lucide-react";

const PATH_TITLES: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/^\/dashboard\/?$/, () => "Dashboard"],
  [/^\/notifications\/?$/, () => "Notifications"],
  [/^\/analytics\/forecast\/?$/, () => "Forecasting"],
  [/^\/sales\/create\/?$/, () => "New Sales Order"],
  // Detail-route crumbs intentionally do NOT echo the raw internal id
  // (so-…, do-…, etc.) — the page's own header shows the human SO/DO number.
  // Wei Siang 2026-06-04: "全套系统不可以有这样字" (no internal ids in the UI).
  [/^\/sales\/([^/]+)\/edit\/?$/, () => "Edit Sales Order"],
  [/^\/sales\/([^/]+)\/?$/, () => "Sales Order"],
  [/^\/sales\/?$/, () => "Sales Orders"],
  [/^\/production\/department\/([^/]+)\/?$/, (m) => `Dept · ${m[1]}`],
  [/^\/production\/scan\/?$/, () => "Scanner"],
  [/^\/production\/fg-scan\/?$/, () => "FG Scanner"],
  [/^\/production\/([^/]+)\/?$/, (m) => `Production · ${m[1]}`],
  [/^\/production\/?$/, () => "Production"],
  [/^\/planning\/mrp\/?$/, () => "MRP"],
  [/^\/planning\/?$/, () => "Planning"],
  [/^\/agents\/?$/, () => "Agent Console"],
  [/^\/delivery\/([^/]+)\/?$/, () => "Delivery Order"],
  [/^\/delivery\/?$/, () => "Delivery Orders"],
  [/^\/invoices\/credit-notes\/?$/, () => "Credit Notes"],
  [/^\/invoices\/debit-notes\/?$/, () => "Debit Notes"],
  [/^\/invoices\/e-invoice\/?$/, () => "e-Invoice"],
  [/^\/invoices\/payments\/?$/, () => "Payments"],
  [/^\/invoices\/([^/]+)\/?$/, () => "Invoice"],
  [/^\/invoices\/?$/, () => "Invoices"],
  [/^\/procurement\/grn\/?$/, () => "GRN"],
  [/^\/procurement\/pi\/?$/, () => "Purchase Invoices"],
  [/^\/procurement\/in-transit\/?$/, () => "In Transit"],
  [/^\/procurement\/maintenance\/?$/, () => "Suppliers"],
  [/^\/procurement\/([^/]+)\/?$/, () => "Purchase Order"],
  [/^\/procurement\/?$/, () => "Purchase Orders"],
  [/^\/inventory\/fabrics\/?$/, () => "Fabrics"],
  [/^\/inventory\/stock-value\/?$/, () => "Stock Value"],
  [/^\/inventory\/?$/, () => "Inventory"],
  [/^\/bom\/?$/, () => "BOM"],
  [/^\/products\/([^/]+)\/bom\/?$/, (m) => `BOM · ${m[1]}`],
  [/^\/products\/?$/, () => "Products"],
  [/^\/customers\/?$/, () => "Customers"],
  [/^\/employees\/?$/, () => "Employees"],
  [/^\/warehouse\/?$/, () => "Warehouse"],
  [/^\/accounting\/cash-flow\/?$/, () => "Cash Flow"],
  [/^\/accounting\/?$/, () => "Accounting"],
  [/^\/quality\/?$/, () => "Quality"],
  [/^\/rd\/([^/]+)\/?$/, () => "R&D Project"],
  [/^\/rd\/?$/, () => "R&D"],
  [/^\/reports\/?$/, () => "Reports"],
  [/^\/documents\/?$/, () => "Documents"],
  [/^\/approvals\/?$/, () => "Approvals"],
  [/^\/maintenance\/?$/, () => "Maintenance"],
  [/^\/settings\/organisations\/?$/, () => "Organisations"],
  [/^\/settings\/variants\/?$/, () => "Variants"],
  [/^\/settings\/?$/, () => "Settings"],
  [/^\/consignment\/create\/?$/, () => "New Consignment"],
  [/^\/consignment\/note\/?$/, () => "Consignment Note"],
  [/^\/consignment\/return\/?$/, () => "Consignment Return"],
  [/^\/consignment\/([^/]+)\/?$/, () => "Consignment Note"],
  [/^\/consignment\/?$/, () => "Consignment"],
];

function titleForPath(path: string): string {
  for (const [re, mk] of PATH_TITLES) {
    const m = re.exec(path);
    if (m) return mk(m);
  }
  // Fallback: capitalise the first segment so unknown routes still get
  // a readable label rather than blank.
  const seg = path.replace(/^\/+/, "").split("/")[0] || "Home";
  return seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, " ");
}

function normalise(path: string): string {
  if (!path.startsWith("/")) path = "/" + path;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

// Build progressive sub-paths from a full URL.
//   /sales/123/edit → ['/sales', '/sales/123', '/sales/123/edit']
function progressivePaths(full: string): string[] {
  const segs = normalise(full).split("/").filter(Boolean);
  const out: string[] = [];
  let acc = "";
  for (const s of segs) {
    acc += "/" + s;
    out.push(acc);
  }
  return out;
}

export function Breadcrumbs() {
  const { pathname } = useLocation();
  const path = normalise(pathname);

  // Don't render on the dashboard root — there's nowhere to go up to.
  if (path === "/dashboard" || path === "/") {
    return null;
  }

  const trail = progressivePaths(path);

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-1 px-6 py-2 text-sm border-b border-[#E2DDD8] bg-[#FAF9F7] overflow-x-auto whitespace-nowrap"
    >
      <Link
        to="/dashboard"
        className="flex items-center text-[#6B7280] hover:text-[#1F1D1B] transition-colors"
        aria-label="Home"
      >
        <Home className="w-3.5 h-3.5" />
      </Link>
      {trail.map((p, idx) => {
        const isLast = idx === trail.length - 1;
        const label = titleForPath(p);
        return (
          <Fragment key={p}>
            <ChevronRight className="w-3.5 h-3.5 text-[#C9C2B9] flex-shrink-0" />
            {isLast ? (
              <span className="text-[#1F1D1B] font-medium truncate" title={label}>
                {label}
              </span>
            ) : (
              <Link
                to={p}
                className="text-[#6B7280] hover:text-[#1F1D1B] transition-colors truncate"
                title={label}
              >
                {label}
              </Link>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
