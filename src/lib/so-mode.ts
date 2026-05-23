// ---------------------------------------------------------------------------
// so-mode — shared helper for the dual-purpose Sales Order pages.
//
// 0134 (Service Order module): the sales/{index,create,edit,detail}.tsx
// pages serve TWO modules now:
//   * "/sales/..."          → normal Sales Orders (the default)
//   * "/service-order/..."  → aftersales Service Orders (cloned from a SO/CO)
//
// Both modules use the SAME backend route (/api/sales-orders) and the
// SAME line-item editor — the only differences are:
//   * the GET list filters by `?isServiceOrder=true|false`
//   * the POST/PUT body carries `isServiceOrder: true|false`
//   * the page header copy, the create-button label, the row-link path
//   * default unit prices = 0 on a Service Order create
//
// Concentrating these branches behind one tiny helper keeps the change to
// the four sales pages small (a few `if (mode === "service-order")` checks
// per file) rather than forking 6800 lines of form code into a parallel
// /pages/service-order/ tree that would silently drift on every bug fix.
// The wrapper components under /pages/service-order/ re-export the sales
// pages — the mode is detected here from the React Router URL.
// ---------------------------------------------------------------------------
import { useLocation } from "react-router-dom";

export type SOMode = "sales" | "service-order";

export function useSOMode(): SOMode {
  const { pathname } = useLocation();
  return pathname.startsWith("/service-order") ? "service-order" : "sales";
}

/**
 * Base URL segment for navigate() calls.
 *   "/sales"          → /sales, /sales/create, /sales/:id, /sales/:id/edit
 *   "/service-order"  → /service-order, /service-order/create, …
 */
export function soBasePath(mode: SOMode): string {
  return mode === "service-order" ? "/service-order" : "/sales";
}

/** Page header text. */
export function soPageTitle(mode: SOMode): string {
  return mode === "service-order" ? "Service Orders" : "Sales Orders";
}

/** "+ New …" button label. */
export function soNewButtonLabel(mode: SOMode): string {
  return mode === "service-order" ? "New Service Order" : "New Sales Order";
}

/** Singular noun used in toasts ("Order created", "Draft saved", …). */
export function soSingularNoun(mode: SOMode): string {
  return mode === "service-order" ? "Service Order" : "Sales Order";
}
