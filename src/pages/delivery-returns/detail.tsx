// ---------------------------------------------------------------------------
// Delivery Return — detail page. Header + returned items + status chain +
// action bar (return to stock / open service order / convert to CN / mark
// re-delivered). Same component vocabulary as the Delivery Order detail page.
// Cascade endpoints land in later phases; buttons call them.
// ---------------------------------------------------------------------------
import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCachedJson } from "@/lib/cached-fetch";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Loader2, ArrowLeft, Printer } from "lucide-react";
import { generateDeliveryReturnPdf } from "@/lib/generate-delivery-return-pdf";

interface DRItem {
  id: string;
  productCode: string;
  productName: string;
  wipLabel: string;
  quantity: number;
  problem: string;
  disposition: string;
  wasInvoiced: boolean;
  fabricCode: string;
  sizeLabel: string;
  specialOrder: string;
  salesOrderNo: string;
  // The line's OWN order refs + buildSpec inputs — a DO can span several SOs,
  // so the header's single customer PO can't identify a line.
  customerPO: string;
  customerSO: string;
  reference: string;
  itemCategory: string;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  gapInches: number | null;
}
interface DeliveryReturn {
  id: string;
  returnNo: string;
  deliveryOrderId: string;
  doNo: string;
  salesOrderId: string;
  companySOId: string;
  customerName: string;
  customerPOId: string;
  returnType: string;
  status: string;
  serviceOrderId: string;
  creditNoteId: string;
  reason: string;
  items: DRItem[];
}
type Resp = { success?: boolean; data?: DeliveryReturn };

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open",
  RETURNED_TO_STOCK: "Returned to stock",
  SERVICE_SPAWNED: "Service in progress",
  CN_ISSUED: "CN issued",
  REDELIVERED: "Re-delivered",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};

export default function DeliveryReturnDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const { data: raw, loading, refresh } = useCachedJson<Resp>(
    `/api/delivery-returns/${id}`,
  );
  const dr = raw?.data ?? null;
  const [busy, setBusy] = useState(false);

  const call = async (path: string, body?: unknown) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/delivery-returns/${id}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || json?.success === false) {
        toast.error(json?.error || "Action failed");
      } else {
        toast.success("Done");
        refresh();
      }
    } catch {
      toast.error("Network error");
    } finally {
      setBusy(false);
    }
  };

  if (loading && !dr) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-[#6B5C32]" />
      </div>
    );
  }
  if (!dr) {
    return (
      <div className="space-y-4">
        <Button variant="outline" size="sm" onClick={() => navigate("/delivery-returns")}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <Card><CardContent className="p-12 text-center text-sm text-[#6B7280]">Delivery return not found.</CardContent></Card>
      </div>
    );
  }

  const isOpen = dr.status === "OPEN";
  // Outcomes are MUTUALLY EXCLUSIVE — you pick exactly one from OPEN. Once any
  // outcome is chosen (restock / repair / pure-return) the DR is resolved and
  // the other buttons disappear. This is what stops "restock (+1 good stock)
  // then repair (produce a replacement)" from double-counting inventory.
  const canService = isOpen;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="outline" size="sm" onClick={() => navigate("/delivery-returns")}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <h1 className="text-xl font-bold text-[#1F1D1B]">{dr.returnNo}</h1>
        <Badge variant="status" status={dr.status}>{STATUS_LABEL[dr.status] ?? dr.status}</Badge>
        {dr.returnType && (
          <span className="text-xs text-[#6B7280]">
            {dr.returnType === "PURE_RETURN" ? "Pure return" : "Repair & re-deliver"}
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() =>
            generateDeliveryReturnPdf({
              returnNo: dr.returnNo,
              companySOId: dr.companySOId,
              doNo: dr.doNo,
              customerName: dr.customerName,
              customerPOId: dr.customerPOId,
              returnType: dr.returnType,
              reason: dr.reason,
              items: dr.items.map((it) => ({
                productCode: it.productCode,
                productName: it.productName,
                wipLabel: it.wipLabel,
                quantity: it.quantity,
                problem: it.problem,
                fabricCode: it.fabricCode,
                sizeLabel: it.sizeLabel,
                specialOrder: it.specialOrder,
                salesOrderNo: it.salesOrderNo,
                customerPO: it.customerPO,
                customerSO: it.customerSO,
                reference: it.reference,
                itemCategory: it.itemCategory,
                divanHeightInches: it.divanHeightInches,
                legHeightInches: it.legHeightInches,
                gapInches: it.gapInches,
              })),
            })
          }
        >
          <Printer className="h-4 w-4" /> Print
        </Button>
      </div>

      <Card>
        <CardContent className="p-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
            <Meta k="From sales order" v={dr.companySOId || "—"} />
            <Meta k="Original DO" v={
              dr.deliveryOrderId
                ? <Link className="text-[#6B5C32] font-medium" to={`/delivery/${dr.deliveryOrderId}`}>{dr.doNo || "—"}</Link>
                : (dr.doNo || "—")
            } />
            <Meta k="Customer" v={dr.customerName || "—"} />
            <Meta k="Customer PO" v={dr.customerPOId || "—"} />
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-[#6B7280] border-b border-[#E2DDD8]">
                <th className="py-2">Returned item</th><th>Size / Fabric</th><th>Qty</th><th>Problem</th><th>Invoiced?</th>
              </tr>
            </thead>
            <tbody>
              {dr.items.map((it) => (
                <tr key={it.id} className="border-b border-[#F0ECE9] align-top">
                  <td className="py-2">
                    <div>
                      <b>{it.productCode}</b>{" "}
                      <span className="text-[#6B7280]">{it.productName}</span>
                    </div>
                    {/* The line's OWN refs — two identical products on one DO
                        are otherwise indistinguishable (owner 2026-07-16:
                        "要不然我怎麼知道要選那個"). */}
                    {(it.salesOrderNo || it.customerPO || it.reference || it.specialOrder) && (
                      <div className="text-[11px] text-[#9CA3AF]">
                        {[
                          it.salesOrderNo ? `SO ${it.salesOrderNo}` : "",
                          it.customerPO ? `PO ${it.customerPO}` : "",
                          it.reference ? `Ref ${it.reference}` : "",
                          it.specialOrder,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    )}
                  </td>
                  <td className="text-xs text-[#6B7280]">
                    {[it.sizeLabel, it.fabricCode].filter(Boolean).join(" · ") || "—"}
                  </td>
                  <td>{it.quantity}</td>
                  <td>{it.problem ? <span className="text-[#9A3A2D] font-medium">{it.problem}</span> : "—"}</td>
                  <td>{it.wasInvoiced ? <span className="text-[#9A3A2D]">Invoiced</span> : <span className="text-[#6B7280]">Not yet</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {dr.serviceOrderId && (
            <p className="mt-3 text-xs text-[#6B7280]">Service order: <span className="font-mono text-[#6B5C32]">{dr.serviceOrderId}</span></p>
          )}
          {dr.creditNoteId && (
            <p className="mt-1 text-xs text-[#6B7280]">Credit note: <span className="font-mono text-[#6B5C32]">{dr.creditNoteId}</span></p>
          )}

          <div className="flex gap-2 flex-wrap pt-4 mt-4 border-t border-[#E2DDD8]">
            {/* ONE button. "Pure return" and "return to stock" are the same act
                (owner 2026-07-16: "pure return 就是 return to stocks 的意思，
                一樣的") — both endpoints already run the SAME inventory half
                (buildReturnToStockStatements); the only difference is whether a
                Credit Note follows. So don't ask the operator to choose: the
                invoice decides. Owner's rule, confirmed: DO already invoiced →
                raise the CN (money was taken, credit it back); never invoiced →
                no CN (nothing to credit). */}
            {isOpen && (
              <Button
                variant="primary"
                disabled={busy}
                onClick={async () => {
                  const invoiced = dr.items.some((it) => it.wasInvoiced);
                  if (invoiced) {
                    await call("/set-outcome", { returnType: "PURE_RETURN" });
                    toast.info(
                      "Returned to stock — this DO was invoiced, so a Credit Note is pre-filled; confirm the refund amount.",
                    );
                    navigate(`/invoices/credit-notes?fromReturn=${id}`);
                  } else {
                    await call("/return-to-stock");
                    toast.success(
                      "Returned to stock. No Credit Note — this DO was never invoiced.",
                    );
                  }
                }}
              >
                Return to stock
              </Button>
            )}
            {canService && (
              <Button
                variant="primary"
                disabled={busy}
                onClick={async () => {
                  if (busy) return;
                  setBusy(true);
                  try {
                    // Auto-open a service case from the original SO, seeded with
                    // the RETURNED items (as affectedProducts) so the replacement
                    // (SV) order the case hands off to is pre-filled with just the
                    // damaged lines — not the whole order. Then link + jump in.
                    let caseId = "";
                    if (dr.salesOrderId) {
                      const r = await fetch("/api/service-cases", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          sourceType: "SO",
                          sourceId: dr.salesOrderId,
                          affectedProducts: dr.items.map((it) => ({
                            code: it.productCode,
                            name: it.productName,
                            qty: it.quantity,
                          })),
                        }),
                      });
                      const j = (await r.json()) as { data?: { id?: string } };
                      caseId = j?.data?.id ?? "";
                    }
                    await fetch(`/api/delivery-returns/${id}/set-outcome`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ returnType: "REPAIR_REDELIVER", serviceCaseId: caseId }),
                    });
                    // Standard step is DR → Service Case → Service Order: land on
                    // the case so the operator spawns the SV order from there
                    // (the case detail's "Spawn Service Order" button).
                    toast.success("Service case opened — spawn the replacement order from the case.");
                    navigate(caseId ? `/service-cases/${caseId}` : "/service-cases");
                  } catch {
                    toast.error("Failed to open the service case");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Repair &amp; re-deliver → service case
              </Button>
            )}
            {dr.status === "SERVICE_SPAWNED" && (
              <Button variant="primary" disabled={busy} onClick={() => call("/mark-redelivered")}>
                Mark re-delivered
              </Button>
            )}
            {isOpen && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  if (await confirm({ title: "Cancel this return?", message: "This delivery return will be voided.", confirmLabel: "Cancel return" })) {
                    call("/cancel");
                  }
                }}
              >
                Cancel return
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Meta({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-[#9CA3AF]">{k}</div>
      <div className="text-sm font-medium text-[#1F1D1B] mt-0.5">{v}</div>
    </div>
  );
}
