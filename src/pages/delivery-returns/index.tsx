// ---------------------------------------------------------------------------
// Delivery Returns — list page. Mirrors the Delivery Order module (DataGrid +
// status badges + summary cards + search) so it looks native to the app.
// Reads /api/delivery-returns. Rows open the detail page.
// ---------------------------------------------------------------------------
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataGrid, type Column } from "@/components/ui/data-grid";
import { useCachedJson } from "@/lib/cached-fetch";
import { Undo2 } from "lucide-react";

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
  const { data: raw, loading } = useCachedJson<Resp>("/api/delivery-returns");
  const rows = useMemo<DeliveryReturn[]>(() => raw?.data ?? [], [raw]);

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
      <div>
        <h1 className="text-xl font-bold text-[#1F1D1B] flex items-center gap-2">
          <Undo2 className="h-5 w-5 text-[#6B5C32]" /> Delivery Returns
        </h1>
        <p className="text-xs text-[#6B7280]">
          Goods returned after delivery — repair &amp; re-deliver, or a pure return with a credit note.
        </p>
      </div>

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
