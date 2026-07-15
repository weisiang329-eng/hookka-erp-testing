// ---------------------------------------------------------------------------
// Delivery Returns — list page. Mirrors the Delivery Order module (DataGrid +
// status badges + summary cards + search) so it looks native to the app.
// Reads /api/delivery-returns. Rows open the detail page.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type Column } from "@/components/ui/data-grid";
import { useCachedJson } from "@/lib/cached-fetch";
import { useToast } from "@/components/ui/toast";
import { Undo2, Plus, X, Loader2 } from "lucide-react";

interface ReturnItem {
  problem: string;
  productCode: string;
}
interface DeliveryReturn {
  id: string;
  returnNo: string;
  doNo: string;
  companySOId: string;
  customerName: string;
  customerPOId: string;
  returnType: string;
  status: string;
  items: ReturnItem[];
}
type Resp = { success?: boolean; data?: DeliveryReturn[] };

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open",
  RETURNED_TO_STOCK: "Returned to stock",
  SERVICE_SPAWNED: "Service in progress",
  CN_ISSUED: "CN issued",
  REDELIVERED: "Re-delivered",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};
const TYPE_LABEL: Record<string, string> = {
  PURE_RETURN: "Pure return",
  REPAIR_REDELIVER: "Repair & re-deliver",
};

export default function DeliveryReturnsPage() {
  const navigate = useNavigate();
  const { data: raw, loading, refresh } = useCachedJson<Resp>("/api/delivery-returns");
  const rows = useMemo<DeliveryReturn[]>(() => raw?.data ?? [], [raw]);
  const [searchParams, setSearchParams] = useSearchParams();
  const createFrom = searchParams.get("createFrom") || "";
  const [showCreate, setShowCreate] = useState(false);
  // Opened via "Convert to Delivery Return" on a DO → pre-open the create modal.
  useEffect(() => {
    if (createFrom) setShowCreate(true);
  }, [createFrom]);

  const counts = useMemo(() => {
    const c = { open: 0, inService: 0, closed: 0 };
    for (const r of rows) {
      if (r.status === "CLOSED" || r.status === "REDELIVERED" || r.status === "CN_ISSUED") c.closed += 1;
      else if (r.status === "SERVICE_SPAWNED") c.inService += 1;
      else if (r.status !== "CANCELLED") c.open += 1;
    }
    return c;
  }, [rows]);

  const columns: Column<DeliveryReturn>[] = [
    { key: "returnNo", label: "Return", width: "130px", sortable: true },
    { key: "customerName", label: "Customer", width: "150px", sortable: true },
    { key: "companySOId", label: "From order", width: "130px", sortable: true },
    { key: "doNo", label: "Original DO", width: "130px", sortable: true },
    {
      key: "returnType",
      label: "Type",
      width: "150px",
      sortable: true,
      render: (_v, row) =>
        row.returnType ? (TYPE_LABEL[row.returnType] ?? row.returnType) : "—",
    },
    {
      key: "problem",
      label: "Problem",
      width: "160px",
      render: (_v, row) => row.items?.[0]?.problem || "—",
    },
    {
      key: "status",
      label: "Status",
      width: "150px",
      sortable: true,
      render: (_v, row) => (
        <Badge variant="status" status={row.status}>
          {STATUS_LABEL[row.status] ?? row.status}
        </Badge>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B] flex items-center gap-2">
            <Undo2 className="h-5 w-5 text-[#6B5C32]" /> Delivery Returns
          </h1>
          <p className="text-xs text-[#6B7280]">
            Goods returned after delivery — repair &amp; re-deliver, or a pure return with a credit note.
          </p>
        </div>
        <Button variant="primary" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" /> New return
        </Button>
      </div>

      {showCreate && (
        <CreateReturnModal
          initialDoId={createFrom}
          onClose={() => {
            setShowCreate(false);
            if (createFrom) setSearchParams({});
          }}
          onCreated={(id) => {
            setShowCreate(false);
            if (createFrom) setSearchParams({});
            refresh();
            navigate(`/delivery-returns/${id}`);
          }}
        />
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card><CardContent className="p-4"><div className="text-2xl font-bold text-[#1F1D1B]">{counts.open}</div><div className="text-xs text-[#6B7280]">Open</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-2xl font-bold text-[#6B5C32]">{counts.inService}</div><div className="text-xs text-[#6B7280]">Service in progress</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-2xl font-bold text-[#1F1D1B]">{counts.closed}</div><div className="text-xs text-[#6B7280]">Resolved</div></CardContent></Card>
      </div>

      <DataGrid<DeliveryReturn>
        columns={columns}
        data={rows}
        keyField="id"
        loading={loading}
        gridId="delivery-returns"
        onRowClick={(row) => navigate(`/delivery-returns/${row.id}`)}
        emptyMessage="No delivery returns yet."
      />
    </div>
  );
}

interface DoListRow {
  id: string;
  doNo: string;
  customerName: string;
  status: string;
}
interface DoItem {
  id: string;
  productionOrderId: string;
  poNo: string;
  productCode: string;
  productName: string;
  quantity: number;
}
type TickState = Record<string, { on: boolean; problem: string }>;

function CreateReturnModal({
  initialDoId,
  onClose,
  onCreated,
}: {
  initialDoId?: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { toast } = useToast();
  const { data: doRaw } = useCachedJson<{ data?: DoListRow[] }>(
    "/api/delivery-orders",
  );
  const dos = useMemo(
    () =>
      (doRaw?.data ?? []).filter(
        (d) => d.status === "DELIVERED" || d.status === "INVOICED",
      ),
    [doRaw],
  );
  const [doId, setDoId] = useState("");
  const [items, setItems] = useState<DoItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [ticked, setTicked] = useState<TickState>({});
  const [creating, setCreating] = useState(false);

  const pickDo = async (id: string) => {
    setDoId(id);
    setItems([]);
    setTicked({});
    if (!id) return;
    setLoadingItems(true);
    try {
      const res = await fetch(`/api/delivery-orders/${id}`);
      const json = (await res.json()) as { data?: { items?: DoItem[] } };
      setItems(json?.data?.items ?? []);
    } catch {
      toast.error("Failed to load the delivery order");
    } finally {
      setLoadingItems(false);
    }
  };

  useEffect(() => {
    if (initialDoId) void pickDo(initialDoId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDoId]);

  const create = async () => {
    const chosen = items.filter((it) => ticked[it.id]?.on);
    if (!doId || chosen.length === 0) {
      toast.error("Pick a delivered DO and tick at least one problem item.");
      return;
    }
    // Stamp each returned line "already invoiced?" from the source DO status so
    // the detail page shows it correctly and the office knows a Credit Note is
    // needed (an INVOICED DO's returned line was already billed).
    const wasInvoiced =
      (dos.find((d) => d.id === doId)?.status || "").toUpperCase() === "INVOICED";
    setCreating(true);
    try {
      const res = await fetch("/api/delivery-returns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deliveryOrderId: doId,
          items: chosen.map((it) => ({
            productionOrderId: it.productionOrderId,
            poNo: it.poNo,
            productCode: it.productCode,
            productName: it.productName,
            quantity: it.quantity,
            problem: ticked[it.id]?.problem ?? "",
            wasInvoiced,
          })),
        }),
      });
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        data?: { id: string };
      };
      if (!res.ok || json?.success === false || !json?.data?.id) {
        toast.error(json?.error || "Failed to create the return");
        return;
      }
      onCreated(json.data.id);
    } catch {
      toast.error("Network error");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl w-full max-w-lg max-h-[85vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#E2DDD8]">
          <h2 className="font-semibold text-[#1F1D1B]">New delivery return</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs text-[#6B7280] mb-1">Delivered order</label>
            <select
              value={doId}
              onChange={(e) => void pickDo(e.target.value)}
              className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20"
            >
              <option value="">Select a delivered DO…</option>
              {dos.map((d) => (
                <option key={d.id} value={d.id}>{d.doNo} · {d.customerName}</option>
              ))}
            </select>
          </div>

          {loadingItems && (
            <div className="flex justify-center py-4"><Loader2 className="h-6 w-6 animate-spin text-[#6B5C32]" /></div>
          )}

          {items.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-[#6B7280]">Tick the problem items and describe the problem:</p>
              {items.map((it) => {
                const t = ticked[it.id] ?? { on: false, problem: "" };
                return (
                  <div key={it.id} className="border border-[#E2DDD8] rounded-md p-2.5">
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={t.on}
                        onChange={(e) => setTicked((p) => ({ ...p, [it.id]: { ...t, on: e.target.checked } }))}
                      />
                      <b>{it.productCode}</b> <span className="text-[#6B7280]">{it.productName}</span>
                      <span className="text-gray-400 ml-auto">×{it.quantity}</span>
                    </label>
                    {t.on && (
                      <input
                        value={t.problem}
                        onChange={(e) => setTicked((p) => ({ ...p, [it.id]: { ...t, problem: e.target.value } }))}
                        placeholder="What's the problem? (e.g. fabric torn)"
                        className="mt-2 w-full rounded border border-[#E2DDD8] px-2 py-1 text-sm focus:outline-none focus:border-[#6B5C32]"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-[#E2DDD8]">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={creating} onClick={() => void create()}>
            {creating ? "Creating…" : "Create return"}
          </Button>
        </div>
      </div>
    </div>
  );
}
