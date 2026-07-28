// Route → human page title. Shared by the breadcrumb strip (breadcrumbs.tsx)
// and the workspace tab strip (workspaceTabs.ts) so the two can never disagree
// about a page's name. Extracted from breadcrumbs.tsx (a component file can
// only export components under react-refresh) — this is the plain, shared home.

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

export function titleForPath(path: string): string {
  for (const [re, mk] of PATH_TITLES) {
    const m = re.exec(path);
    if (m) return mk(m);
  }
  // Fallback: capitalise the first segment so unknown routes still get a
  // readable label rather than blank.
  const seg = path.replace(/^\/+/, "").split("/")[0] || "Home";
  return seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, " ");
}

export function normalise(path: string): string {
  if (!path.startsWith("/")) path = "/" + path;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}
