import { useState, useMemo } from "react";
import { useToast } from "@/components/ui/toast";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { ArrowLeft, Plus, Trash2, Save } from "lucide-react";
import type { Customer, Product } from "@/lib/mock-data";

type LineItem = {
  productId: string;
  productCode: string;
  productName: string;
  quantity: number;
  unitPrice: number; // sen
};

type CreateConsignmentResponse =
  | { success: true; data: { id: string } }
  | { success: false; error?: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}

function asCreateConsignmentResponse(v: unknown): CreateConsignmentResponse | null {
  if (!isRecord(v)) return null;
  if (v.success === true && isRecord(v.data) && typeof v.data.id === "string") {
    return { success: true, data: { id: v.data.id } };
  }
  if (v.success === false) {
    return { success: false, error: typeof v.error === "string" ? v.error : undefined };
  }
  return null;
}

const EMPTY_LINE: LineItem = {
  productId: "",
  productCode: "",
  productName: "",
  quantity: 1,
  unitPrice: 0,
};

export default function CreateConsignmentPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);

  const [customerId, setCustomerId] = useState("");
  const [branchName, setBranchName] = useState("");
  const [sentDate, setSentDate] = useState(new Date().toISOString().split("T")[0]);
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<LineItem[]>([{ ...EMPTY_LINE }]);

  const { data: customersResp } = useCachedJson<{ success?: boolean; data?: Customer[] }>("/api/customers");
  const { data: productsResp } = useCachedJson<{ success?: boolean; data?: Product[] }>("/api/products");
  const customers: Customer[] = useMemo(() => customersResp?.data || [], [customersResp]);
  const products: Product[] = useMemo(() => productsResp?.data || [], [productsResp]);

  const addItem = () => setItems([...items, { ...EMPTY_LINE }]);

  const removeItem = (idx: number) => {
    if (items.length <= 1) return;
    setItems(items.filter((_, i) => i !== idx));
  };

  const updateItem = (idx: number, updates: Partial<LineItem>) => {
    setItems((prev) => prev.map((item, i) => (i === idx ? { ...item, ...updates } : item)));
  };

  const selectProduct = (idx: number, productId: string) => {
    const prod = products.find((p) => p.id === productId);
    if (!prod) return;
    updateItem(idx, {
      productId: prod.id,
      productCode: prod.code,
      productName: prod.name,
      unitPrice: prod.costPriceSen || 0,
    });
  };

  const getLineTotal = (item: LineItem) => item.unitPrice * item.quantity;

  const subtotal = items.reduce((sum, item) => sum + getLineTotal(item), 0);
  const totalQty = items.reduce((sum, item) => sum + item.quantity, 0);

  const selectedCustomer = customers.find((c) => c.id === customerId);

  const handleSubmit = async () => {
    if (!customerId) { toast.warning("Please select a customer"); return; }
    if (items.some((l) => !l.productId)) { toast.warning("Please select a product for all line items"); return; }

    setSaving(true);
    const res = await fetch("/api/consignments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerId,
        branchName: branchName || selectedCustomer?.name || "",
        sentDate,
        notes,
        type: "OUT",
        items: items.map((item) => ({
          productId: item.productId,
          productName: item.productName,
          productCode: item.productCode,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
      }),
    });
    const data = asCreateConsignmentResponse(await res.json());
    setSaving(false);

    if (data?.success) {
      invalidateCachePrefix("/api/consignments");
      invalidateCachePrefix("/api/invoices");
      navigate(`/consignment/${data.data.id}`);
    } else {
      toast.error(data?.error || "Failed to create consignment note");
    }
  };

  const selectClass = "w-full rounded border border-[#E2DDD8] px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20";

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/consignment")}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-[#1F1D1B]">New Consignment Note</h1>
          <p className="text-xs text-[#6B7280]">Create a new consignment note to send products to a branch</p>
        </div>
        <Button variant="outline" onClick={() => navigate("/consignment")}>Cancel</Button>
        <Button
          variant="outline"
          onClick={handleSubmit}
          disabled={saving}
        >
          <Save className="h-4 w-4" />
          {saving ? "Saving..." : "Save as Draft"}
        </Button>
        <Button
          onClick={handleSubmit}
          disabled={saving}
          className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
        >
          <Save className="h-4 w-4" />
          {saving ? "Creating..." : "Create"}
        </Button>
      </div>

      <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3"><CardTitle>Consignment Details</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Customer *</label>
                <select
                  value={customerId}
                  onChange={(e) => {
                    const cid = e.target.value;
                    setCustomerId(cid);
                    const cust = customers.find((c) => c.id === cid);
                    if (cust) setBranchName(cust.name);
                  }}
                  className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                >
                  <option value="">Select customer...</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.code} - {c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Branch / Delivery Address</label>
                <Input
                  value={branchName}
                  onChange={(e) => setBranchName(e.target.value)}
                  placeholder="Branch name or delivery address"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Sent Date</label>
                <Input type="date" value={sentDate} onChange={(e) => setSentDate(e.target.value)} />
              </div>
            </div>

            {selectedCustomer && (
              <div className="rounded-md bg-[#FAF9F7] border border-[#E2DDD8] p-3 text-sm">
                <div className="flex gap-6">
                  <span className="text-[#6B7280]">Customer: <span className="font-medium text-[#1F1D1B]">{selectedCustomer.name}</span></span>
                  <span className="text-[#6B7280]">Terms: <span className="font-medium text-[#1F1D1B]">{selectedCustomer.creditTerms}</span></span>
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1.5">Notes</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                placeholder="Internal notes..."
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3"><CardTitle>Summary</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Total Qty</span><span className="font-medium">{totalQty}</span></div>
            <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Line Items</span><span className="font-medium">{items.filter((l) => l.productId).length}</span></div>
            <hr className="border-[#E2DDD8]" />
            <div className="flex justify-between text-lg font-bold"><span>Total</span><span className="text-[#6B5C32]">{formatCurrency(subtotal)}</span></div>
          </CardContent>
        </Card>
      </div>

      {/* Line Items */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle>Line Items ({items.length})</CardTitle>
            <Button variant="outline" size="sm" onClick={addItem}>
              <Plus className="h-4 w-4" /> Add Item
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {items.map((item, idx) => (
            <div key={idx} className="rounded-md border border-[#E2DDD8] p-4 space-y-3">
              {/* Header */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-[#6B5C32]">Line {idx + 1}</span>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold amount">{formatCurrency(getLineTotal(item))}</span>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-red-400 hover:text-red-600" onClick={() => removeItem(idx)} disabled={items.length <= 1}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* Product / Qty / Price row */}
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs text-[#9CA3AF] mb-1">Product *</label>
                  <select
                    value={item.productId}
                    onChange={(e) => selectProduct(idx, e.target.value)}
                    className={selectClass}
                  >
                    <option value="">Select product...</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.code} - {p.name} ({p.sizeLabel})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[#9CA3AF] mb-1">Qty</label>
                  <Input
                    type="number"
                    min={1}
                    value={item.quantity}
                    onChange={(e) => updateItem(idx, { quantity: Math.max(1, parseInt(e.target.value) || 1) })}
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#9CA3AF] mb-1">Unit Price (sen)</label>
                  <Input
                    type="number"
                    min={0}
                    value={item.unitPrice}
                    onChange={(e) => updateItem(idx, { unitPrice: Math.max(0, parseInt(e.target.value) || 0) })}
                  />
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
