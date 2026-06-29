// ============================================================================
// GlobalSearchSheet — CHANGELOG O.1: "全局搜索:客户/PO/SO/Reference/单号,
// 任何模块列表都能搜". Fans out across the preloaded localStorage cache
// (every endpoint in src/pages/m/lib/preload.ts) and shows top matches
// grouped by module. Open it from the Home header's search icon.
//
// Strategy: read each cached list from localStorage (cached-fetch keys), do a
// substring match on the most identifying fields per type, render up to 5
// hits per module with a tappable row that navigates to the L2 detail.
//
// No new backend — pure client-side overlay over the cache we already prime.
// ============================================================================
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, X } from "lucide-react";
import { Sheet } from "./Sheet";
import { M } from "../theme";
import { peekCache } from "@/lib/cached-fetch";

type Hit = {
  module: string; // human label (Sales / Delivery / etc)
  modulePath: string; // /m/<slug>/:id
  code: string;
  title: string;
  subLine?: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
};

// Read a cached endpoint payload (set up by preload) + return its data[].
function readCachedList(url: string): Record<string, unknown>[] {
  const cached = peekCache<{ data?: unknown[] | { data?: unknown[] } } | unknown[]>(url);
  if (!cached) return [];
  if (Array.isArray(cached)) return cached as Record<string, unknown>[];
  const obj = cached as { data?: unknown[] | { data?: unknown[] } };
  const d = obj.data;
  if (Array.isArray(d)) return d as Record<string, unknown>[];
  if (d && typeof d === "object" && Array.isArray((d as { data?: unknown[] }).data)) {
    return (d as { data: Record<string, unknown>[] }).data;
  }
  return [];
}

function lc(v: unknown): string {
  return typeof v === "string" ? v.toLowerCase() : "";
}

// Substring match across a set of identifying fields per row.
function matchHits(
  q: string,
  list: Record<string, unknown>[],
  fields: string[],
  toHit: (r: Record<string, unknown>) => Hit,
): Hit[] {
  const ql = q.toLowerCase().trim();
  if (!ql) return [];
  const out: Hit[] = [];
  for (const r of list) {
    for (const f of fields) {
      if (lc(r[f]).includes(ql)) {
        out.push(toHit(r));
        break;
      }
    }
    if (out.length >= 5) break;
  }
  return out;
}

export function GlobalSearchSheet({ open, onClose }: Props) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");

  // Read caches lazily — only when sheet is open AND query has content.
  const hits: { module: string; results: Hit[] }[] = useMemo(() => {
    if (!open || !q.trim()) return [];
    const groups: { module: string; results: Hit[] }[] = [];

    // SALES
    const sales = readCachedList("/api/sales-orders");
    const salesHits = matchHits(
      q,
      sales,
      ["companySO", "companySOId", "customerSO", "customerSOId", "customerPO", "customerPOId", "customerName", "reference"],
      (r) => ({
        module: "Sales",
        modulePath: `/m/sales/${encodeURIComponent(String(r.id ?? r.companySO ?? ""))}`,
        code: String(r.companySO ?? r.companySOId ?? ""),
        title: String(r.customerName ?? ""),
        subLine: String(r.customerPO ?? r.customerPOId ?? "") || undefined,
      }),
    );
    if (salesHits.length > 0) groups.push({ module: "Sales", results: salesHits });

    // DELIVERY
    const dos = readCachedList("/api/delivery-orders");
    const doHits = matchHits(
      q,
      dos,
      ["doNo", "companySO", "companySOId", "customerName", "customerPO"],
      (r) => ({
        module: "Delivery",
        modulePath: `/m/delivery/${encodeURIComponent(String(r.id ?? r.doNo ?? ""))}`,
        code: String(r.doNo ?? ""),
        title: String(r.customerName ?? ""),
        subLine: String(r.companySO ?? r.companySOId ?? "") || undefined,
      }),
    );
    if (doHits.length > 0) groups.push({ module: "Delivery", results: doHits });

    // PROCUREMENT
    const pos = readCachedList("/api/purchase-orders");
    const poHits = matchHits(
      q,
      pos,
      ["poNo", "supplierName"],
      (r) => ({
        module: "Procurement",
        modulePath: `/m/procurement/${encodeURIComponent(String(r.id ?? r.poNo ?? ""))}`,
        code: String(r.poNo ?? ""),
        title: String(r.supplierName ?? ""),
      }),
    );
    if (poHits.length > 0) groups.push({ module: "Procurement", results: poHits });

    // INVOICES
    const invs = readCachedList("/api/invoices");
    const invHits = matchHits(
      q,
      invs,
      ["invoiceNo", "customerName"],
      (r) => ({
        module: "Invoices",
        modulePath: `/m/invoices/${encodeURIComponent(String(r.id ?? r.invoiceNo ?? ""))}`,
        code: String(r.invoiceNo ?? ""),
        title: String(r.customerName ?? ""),
      }),
    );
    if (invHits.length > 0) groups.push({ module: "Invoices", results: invHits });

    // CUSTOMERS
    const custs = readCachedList("/api/customers");
    const custHits = matchHits(
      q,
      custs,
      ["code", "name", "phone"],
      (r) => ({
        module: "Customers",
        modulePath: `/m/customers/${encodeURIComponent(String(r.id ?? r.code ?? ""))}`,
        code: String(r.code ?? ""),
        title: String(r.name ?? ""),
      }),
    );
    if (custHits.length > 0) groups.push({ module: "Customers", results: custHits });

    // SUPPLIERS
    const sups = readCachedList("/api/suppliers");
    const supHits = matchHits(
      q,
      sups,
      ["code", "name", "phone", "contactPerson"],
      (r) => ({
        module: "Suppliers",
        modulePath: `/m/suppliers/${encodeURIComponent(String(r.id ?? r.code ?? ""))}`,
        code: String(r.code ?? ""),
        title: String(r.name ?? ""),
      }),
    );
    if (supHits.length > 0) groups.push({ module: "Suppliers", results: supHits });

    // PRODUCTS
    const prods = readCachedList("/api/products");
    const prodHits = matchHits(
      q,
      prods,
      ["code", "name"],
      (r) => ({
        module: "Products",
        modulePath: `/m/products/${encodeURIComponent(String(r.id ?? r.code ?? ""))}`,
        code: String(r.code ?? ""),
        title: String(r.name ?? ""),
      }),
    );
    if (prodHits.length > 0) groups.push({ module: "Products", results: prodHits });

    return groups;
  }, [open, q]);

  // Reset query when sheet re-opens (render-time check, NOT in an effect —
  // matches the codebase's no-setState-in-effect rule).
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (!open && q) setQ("");
  }

  return (
    <Sheet open={open} onClose={onClose}>
      <div style={{ padding: "16px 16px 8px", display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "11px 13px",
            backgroundColor: M.card,
            border: `1px solid ${M.hairline}`,
            borderRadius: 12,
          }}
        >
          <Search size={18} strokeWidth={1.75} color={M.faint} />
          <input
            autoFocus
            value={q}
            placeholder="Search customer / PO / SO / Reference…"
            onChange={(e) => setQ(e.target.value)}
            style={{
              flex: 1,
              minWidth: 0,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: 14,
              color: M.raisin,
              fontFamily: "inherit",
            }}
          />
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            width: 38,
            height: 38,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "none",
            cursor: "pointer",
          }}
        >
          <X size={20} color={M.body} />
        </button>
      </div>
      <div style={{ padding: "4px 16px 80px", overflowY: "auto", maxHeight: "calc(85dvh - 60px)" }}>
        {q.trim().length === 0 ? (
          <div style={{ color: M.muted, fontSize: 13, padding: "20px 4px", textAlign: "center" }}>
            Type a customer name, PO, SO, or reference to search every module.
          </div>
        ) : hits.length === 0 ? (
          <div style={{ color: M.muted, fontSize: 13, padding: "20px 4px", textAlign: "center" }}>
            No matches.
          </div>
        ) : (
          hits.map((g) => (
            <div key={g.module} style={{ marginBottom: 14 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                  color: M.muted,
                  padding: "6px 4px 6px",
                }}
              >
                {g.module} · {g.results.length}
              </div>
              {g.results.map((h, i) => (
                <button
                  key={`${g.module}-${i}`}
                  onClick={() => {
                    onClose();
                    navigate(h.modulePath);
                  }}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    padding: "11px 12px",
                    background: M.card,
                    border: `1px solid ${M.hairline}`,
                    borderRadius: 12,
                    marginBottom: 7,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    textAlign: "left",
                    WebkitTapHighlightColor: "transparent",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: M.taupe, fontVariantNumeric: "tabular-nums" }}>
                      {h.code || "—"}
                    </div>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: M.raisin,
                        marginTop: 2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h.title}
                    </div>
                    {h.subLine ? (
                      <div
                        style={{
                          fontSize: 12,
                          color: M.muted,
                          marginTop: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h.subLine}
                      </div>
                    ) : null}
                  </div>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </Sheet>
  );
}
