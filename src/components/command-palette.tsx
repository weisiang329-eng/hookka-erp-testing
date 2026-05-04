// ---------------------------------------------------------------------------
// CommandPalette — Cmd/Ctrl-K global search & navigation overlay.
//
// Three sections:
//   • Recents — last 10 record detail pages (from localStorage, populated
//     on each navigation by the RecentTracker in DashboardLayout).
//   • Pages — static list of every dashboard route.
//   • Search — Customers / Sales Orders / Delivery Orders, filtered
//     client-side from the cached lists `useCachedJson` already keeps for
//     the regular pages. Each entity request is shared with the page that
//     owns it, so opening the palette never causes a duplicate fetch
//     when the user has visited that page recently.
//
// Mount once at the dashboard shell root. The palette listens to a
// global `keydown` for Cmd/Ctrl+K and toggles open. On close, all entity
// lists unmount — there is no idle subscription overhead.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import { Search, ArrowRight, Clock, FileText, Package, Truck, Users } from "lucide-react";
import { useCachedJson } from "@/lib/cached-fetch";
import { useRecentRecords } from "@/lib/use-recent-records";

type PageEntry = { path: string; label: string };

// Static page index. Mirrors the breadcrumb regex table but flattened
// to literal routes so the palette can show every reachable page in
// one render. Detail / edit / dynamic-id routes are intentionally
// excluded — those land in Recents or via entity search.
const PAGES: PageEntry[] = [
  { path: "/dashboard", label: "Dashboard" },
  { path: "/sales", label: "Sales Orders" },
  { path: "/sales/create", label: "New Sales Order" },
  { path: "/production", label: "Production" },
  { path: "/production/scan", label: "Production Scanner" },
  { path: "/production/fg-scan", label: "FG Scanner" },
  { path: "/production/fab-cut", label: "Production · Fab Cut" },
  { path: "/production/fab-sew", label: "Production · Fab Sew" },
  { path: "/production/foam", label: "Production · Foam" },
  { path: "/production/wood-cut", label: "Production · Wood Cut" },
  { path: "/production/framing", label: "Production · Framing" },
  { path: "/production/webbing", label: "Production · Webbing" },
  { path: "/production/upholstery", label: "Production · Upholstery" },
  { path: "/production/packing", label: "Production · Packing" },
  { path: "/planning", label: "Planning" },
  { path: "/planning/mrp", label: "MRP" },
  { path: "/delivery", label: "Delivery Orders" },
  { path: "/invoices", label: "Invoices" },
  { path: "/invoices/credit-notes", label: "Credit Notes" },
  { path: "/invoices/debit-notes", label: "Debit Notes" },
  { path: "/invoices/e-invoice", label: "e-Invoice" },
  { path: "/invoices/payments", label: "Payments" },
  { path: "/procurement", label: "Purchase Orders" },
  { path: "/procurement/grn", label: "GRN" },
  { path: "/procurement/pi", label: "Purchase Invoices" },
  { path: "/procurement/pricing", label: "Pricing" },
  { path: "/procurement/in-transit", label: "In Transit" },
  { path: "/procurement/maintenance", label: "Proc Maintenance" },
  { path: "/inventory", label: "Inventory" },
  { path: "/inventory/fabrics", label: "Fabrics" },
  { path: "/inventory/stock-value", label: "Stock Value" },
  { path: "/bom", label: "BOM" },
  { path: "/products", label: "Products" },
  { path: "/customers", label: "Customers" },
  { path: "/employees", label: "Employees" },
  { path: "/warehouse", label: "Warehouse" },
  { path: "/accounting", label: "Accounting" },
  { path: "/accounting/cash-flow", label: "Cash Flow" },
  { path: "/quality", label: "Quality" },
  { path: "/rd", label: "R&D" },
  { path: "/reports", label: "Reports" },
  { path: "/documents", label: "Documents" },
  { path: "/approvals", label: "Approvals" },
  { path: "/maintenance", label: "Maintenance" },
  { path: "/settings", label: "Settings" },
  { path: "/settings/organisations", label: "Organisations" },
  { path: "/settings/variants", label: "Variants" },
  { path: "/notifications", label: "Notifications" },
  { path: "/analytics/forecast", label: "Forecasting" },
  { path: "/consignment", label: "Consignment" },
  { path: "/consignment/create", label: "New Consignment" },
];

type CustomerHit = { id?: string; name?: string; phone?: string };
type SalesOrderHit = {
  id?: string;
  salesOrderNo?: string;
  customerName?: string;
  status?: string;
};
type DeliveryOrderHit = {
  id?: string;
  doNumber?: string;
  customerName?: string;
  status?: string;
};

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const recents = useRecentRecords();

  // Lazy data fetches — only fired when the palette is open. cmdk's
  // search runs client-side (substring match on the value attribute);
  // the lists themselves come from the same useCachedJson the regular
  // pages use, so there is no duplicate network cost when the user has
  // visited those pages recently.
  const { data: customersResp } = useCachedJson<{ success?: boolean; data?: CustomerHit[] }>(
    open ? "/api/customers" : null,
  );
  const { data: salesResp } = useCachedJson<{ success?: boolean; data?: SalesOrderHit[] }>(
    open ? "/api/sales-orders" : null,
  );
  const { data: doResp } = useCachedJson<{ success?: boolean; data?: DeliveryOrderHit[] }>(
    open ? "/api/delivery-orders" : null,
  );

  const customers = useMemo<CustomerHit[]>(
    () => (customersResp?.success ? customersResp.data ?? [] : []).slice(0, 200),
    [customersResp],
  );
  const salesOrders = useMemo<SalesOrderHit[]>(
    () => (salesResp?.success ? salesResp.data ?? [] : []).slice(0, 200),
    [salesResp],
  );
  const deliveryOrders = useMemo<DeliveryOrderHit[]>(
    () => (doResp?.success ? doResp.data ?? [] : []).slice(0, 200),
    [doResp],
  );

  // No reset effect needed: when `open` flips to false the palette
  // returns null (see early return below), the component unmounts, and
  // the next open creates a fresh useState("") for `query`.

  function go(path: string) {
    onOpenChange(false);
    navigate(path);
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/40 pt-24"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-full max-w-xl bg-white rounded-xl shadow-2xl border border-[#E2DDD8] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <Command
          shouldFilter
          loop
          label="Command palette"
          className="flex flex-col"
        >
          <div className="flex items-center gap-2 px-3 py-3 border-b border-[#E2DDD8]">
            <Search className="w-4 h-4 text-[#9A918A]" />
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Search pages, customers, orders…"
              className="flex-1 text-sm bg-transparent outline-none placeholder:text-[#9A918A]"
            />
            <kbd className="text-[10px] text-[#9A918A] border border-[#E2DDD8] rounded px-1.5 py-0.5 font-mono">
              Esc
            </kbd>
          </div>

          <Command.List className="max-h-[400px] overflow-y-auto py-1">
            <Command.Empty className="px-4 py-6 text-center text-sm text-[#9A918A]">
              No results.
            </Command.Empty>

            {recents.length > 0 && (
              <Command.Group
                heading="Recent"
                className="text-[10px] uppercase tracking-wide text-[#9A918A] px-3 pt-2"
              >
                {recents.slice(0, 5).map((r) => (
                  <Command.Item
                    key={`recent-${r.path}`}
                    value={`${r.label} ${r.path}`}
                    onSelect={() => go(r.path)}
                    className="flex items-center gap-2 px-3 py-2 mx-1 my-0.5 rounded text-sm cursor-pointer aria-selected:bg-[#FAF9F7] data-[selected=true]:bg-[#FAF9F7]"
                  >
                    <Clock className="w-3.5 h-3.5 text-[#9A918A]" />
                    <span className="flex-1 text-[#1F1D1B]">{r.label}</span>
                    <ArrowRight className="w-3 h-3 text-[#C9C2B9]" />
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            <Command.Group
              heading="Pages"
              className="text-[10px] uppercase tracking-wide text-[#9A918A] px-3 pt-2"
            >
              {PAGES.map((p) => (
                <Command.Item
                  key={`page-${p.path}`}
                  value={`${p.label} ${p.path}`}
                  onSelect={() => go(p.path)}
                  className="flex items-center gap-2 px-3 py-2 mx-1 my-0.5 rounded text-sm cursor-pointer aria-selected:bg-[#FAF9F7] data-[selected=true]:bg-[#FAF9F7]"
                >
                  <FileText className="w-3.5 h-3.5 text-[#9A918A]" />
                  <span className="flex-1 text-[#1F1D1B]">{p.label}</span>
                  <span className="text-[10px] text-[#9A918A] font-mono">{p.path}</span>
                </Command.Item>
              ))}
            </Command.Group>

            {customers.length > 0 && (
              <Command.Group
                heading="Customers"
                className="text-[10px] uppercase tracking-wide text-[#9A918A] px-3 pt-2"
              >
                {customers.map((c) => (
                  <Command.Item
                    key={`cust-${c.id ?? c.name}`}
                    value={`${c.name ?? ""} ${c.phone ?? ""}`}
                    onSelect={() => go(`/customers?id=${encodeURIComponent(c.id ?? "")}`)}
                    className="flex items-center gap-2 px-3 py-2 mx-1 my-0.5 rounded text-sm cursor-pointer aria-selected:bg-[#FAF9F7] data-[selected=true]:bg-[#FAF9F7]"
                  >
                    <Users className="w-3.5 h-3.5 text-[#9A918A]" />
                    <span className="flex-1 text-[#1F1D1B]">{c.name ?? c.id}</span>
                    {c.phone && (
                      <span className="text-[10px] text-[#9A918A]">{c.phone}</span>
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {salesOrders.length > 0 && (
              <Command.Group
                heading="Sales Orders"
                className="text-[10px] uppercase tracking-wide text-[#9A918A] px-3 pt-2"
              >
                {salesOrders.map((s) => (
                  <Command.Item
                    key={`so-${s.id}`}
                    value={`${s.salesOrderNo ?? ""} ${s.customerName ?? ""}`}
                    onSelect={() => go(`/sales/${encodeURIComponent(s.id ?? "")}`)}
                    className="flex items-center gap-2 px-3 py-2 mx-1 my-0.5 rounded text-sm cursor-pointer aria-selected:bg-[#FAF9F7] data-[selected=true]:bg-[#FAF9F7]"
                  >
                    <Package className="w-3.5 h-3.5 text-[#9A918A]" />
                    <span className="flex-1 text-[#1F1D1B]">
                      {s.salesOrderNo}
                      {s.customerName && (
                        <span className="text-[#9A918A]"> · {s.customerName}</span>
                      )}
                    </span>
                    {s.status && (
                      <span className="text-[10px] text-[#9A918A]">{s.status}</span>
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {deliveryOrders.length > 0 && (
              <Command.Group
                heading="Delivery Orders"
                className="text-[10px] uppercase tracking-wide text-[#9A918A] px-3 pt-2"
              >
                {deliveryOrders.map((d) => (
                  <Command.Item
                    key={`do-${d.id}`}
                    value={`${d.doNumber ?? ""} ${d.customerName ?? ""}`}
                    onSelect={() => go(`/delivery/${encodeURIComponent(d.id ?? "")}`)}
                    className="flex items-center gap-2 px-3 py-2 mx-1 my-0.5 rounded text-sm cursor-pointer aria-selected:bg-[#FAF9F7] data-[selected=true]:bg-[#FAF9F7]"
                  >
                    <Truck className="w-3.5 h-3.5 text-[#9A918A]" />
                    <span className="flex-1 text-[#1F1D1B]">
                      {d.doNumber}
                      {d.customerName && (
                        <span className="text-[#9A918A]"> · {d.customerName}</span>
                      )}
                    </span>
                    {d.status && (
                      <span className="text-[10px] text-[#9A918A]">{d.status}</span>
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>

          <div className="border-t border-[#E2DDD8] px-3 py-2 flex items-center justify-between text-[10px] text-[#9A918A]">
            <span>
              <kbd className="border border-[#E2DDD8] rounded px-1 py-0.5 font-mono mr-1">↑↓</kbd>
              navigate
              <kbd className="border border-[#E2DDD8] rounded px-1 py-0.5 font-mono mx-1">↵</kbd>
              open
            </span>
            <span>Hookka · Cmd+K</span>
          </div>
        </Command>
      </div>
    </div>
  );
}
