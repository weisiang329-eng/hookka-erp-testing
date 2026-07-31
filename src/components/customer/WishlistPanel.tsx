// ---------------------------------------------------------------------------
// WishlistPanel — CRM slice 5 (owner 2026-07-30, outbound sales). The styles /
// models a customer likes, so a new hire knows "what to pitch next". Add by
// picking a real SKU from a datalist (or typing a style the shop hasn't turned
// into a SKU yet) with an optional note. Self-contained; talks to
// /api/customer-crm/wishlist. CSRF is auto-injected by api-client.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, Heart } from "lucide-react";

type WishItem = {
  id: string;
  product_id: string | null;
  product_code: string | null;
  product_name: string | null;
  interest: string | null;
  note: string | null;
  created_at: string | null;
};

type ProductLite = { id: string; code: string; name: string };

async function getJson<T>(url: string): Promise<T[]> {
  try {
    const r = await fetch(url);
    const j = (await r.json()) as { success: boolean; data?: T[] };
    return j.success && j.data ? j.data : [];
  } catch {
    return [];
  }
}

export function WishlistPanel({ customerId }: { customerId: string }) {
  const [items, setItems] = useState<WishItem[]>([]);
  const [products, setProducts] = useState<ProductLite[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  // `pick` holds the typed/selected value from the datalist. It may be a bare
  // code, or "CODE — Name" (what an option renders as); we split it on save.
  const [pick, setPick] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    const rows = await getJson<WishItem>(
      `/api/customer-crm/wishlist?customerId=${encodeURIComponent(customerId)}`,
    );
    setItems(rows);
  }, [customerId]);

  // reload()/product load flip setters on a user-driven prop change (customerId),
  // not a tight render loop, so the cascading-render concern set-state-in-effect
  // warns about doesn't apply here.
  /* eslint-disable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */
  useEffect(() => {
    void reload();
    void getJson<ProductLite>("/api/products").then((p) =>
      setProducts(
        p
          .filter((x) => x && x.code)
          .map((x) => ({ id: x.id, code: x.code, name: x.name })),
      ),
    );
  }, [customerId]);
  /* eslint-enable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

  const add = async () => {
    const raw = pick.trim();
    if (!raw) return;
    // Resolve the datalist entry back to a SKU when it matches one; otherwise
    // keep it as a free-text style name.
    const code = raw.includes("—") ? raw.split("—")[0].trim() : raw;
    const match = products.find(
      (p) => p.code.toLowerCase() === code.toLowerCase(),
    );
    setSaving(true);
    try {
      await fetch("/api/customer-crm/wishlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId,
          productId: match?.id ?? null,
          productCode: match?.code ?? (raw.includes("—") ? code : null),
          productName: match?.name ?? (raw.includes("—") ? raw.split("—")[1]?.trim() : raw),
          note: note.trim() || null,
        }),
      });
      setPick("");
      setNote("");
      setShowAdd(false);
      await reload();
    } finally {
      setSaving(false);
    }
  };

  const del = async (id: string) => {
    await fetch(`/api/customer-crm/wishlist/${id}`, { method: "DELETE" });
    await reload();
  };

  return (
    <div className="rounded-lg border border-[#E2DDD8] bg-white p-4 mt-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#1F1D1B]">
          <Heart className="h-4 w-4 text-[#B8601A]" />
          Wishlist — styles liked ({items.length})
        </div>
        <button
          onClick={() => setShowAdd((v) => !v)}
          className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 bg-[#6B5C32] text-white rounded-md hover:bg-[#5A4D2A]"
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </button>
      </div>

      {showAdd && (
        <div className="flex flex-wrap items-center gap-2 mb-3 p-2 bg-[#FAF9F7] border border-[#E2DDD8] rounded-md">
          <input
            list="wishlist-products"
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            placeholder="Pick a SKU or type a style…"
            className="flex-1 min-w-[200px] text-sm border border-[#E2DDD8] rounded px-2 py-1.5 bg-white focus:outline-none focus:border-[#6B5C32]"
          />
          <datalist id="wishlist-products">
            {products.slice(0, 2000).map((p) => (
              <option key={p.id} value={`${p.code} — ${p.name}`} />
            ))}
          </datalist>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className="flex-1 min-w-[160px] text-sm border border-[#E2DDD8] rounded px-2 py-1.5 bg-white focus:outline-none focus:border-[#6B5C32]"
          />
          <button
            onClick={add}
            disabled={saving || !pick.trim()}
            className="text-sm px-3 py-1.5 bg-[#6B5C32] text-white rounded-md hover:bg-[#5A4D2A] disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}

      {items.length === 0 ? (
        <p className="text-xs text-gray-400 py-2">
          No styles yet. Add what this customer likes so you know what to pitch next.
        </p>
      ) : (
        <div className="space-y-1.5">
          {items.map((it) => (
            <div
              key={it.id}
              className="flex items-center gap-2 px-2.5 py-2 bg-[#FAF9F7] border border-[#E2DDD8] rounded-md"
            >
              <span className="text-sm font-medium text-[#1F1D1B]">
                {it.product_code ? (
                  <span className="font-mono text-[#6B5C32]">{it.product_code}</span>
                ) : null}
                {it.product_code && it.product_name ? " · " : ""}
                {it.product_name}
              </span>
              {it.note ? (
                <span className="text-xs text-gray-500">— {it.note}</span>
              ) : null}
              <button
                onClick={() => del(it.id)}
                className="ml-auto p-1 text-[#9A3A2D] hover:bg-[#F9E1DA] rounded"
                title="Remove"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
