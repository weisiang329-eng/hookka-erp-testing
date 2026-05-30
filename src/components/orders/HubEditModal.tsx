// ---------------------------------------------------------------------------
// HubEditModal — reusable modal for changing the Delivery Hub on an SO or CO.
//
// Wei Siang's rule: hub is editable up until the first piece physically
// leaves the warehouse. Once any linked DO is past DRAFT (for SO) or any
// linked CN is past ACTIVE (for CO), the hub freezes. The caller passes
// `shipmentLocked` + a tooltip reason; this modal still posts the PATCH
// to be safe (backend re-validates and returns 409 / HUB_LOCKED_SHIPPED
// on race conditions), and renders the server-side lock message in-place
// without closing so the operator can see why their change was rejected.
//
// Hubs are loaded from the customer record (`deliveryHubs[]`), same source
// the SO/CO create pages use. Caller is responsible for fetching the
// customer and passing the array down — keeps this component dumb.
// ---------------------------------------------------------------------------
import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DeliveryHub } from "@/types";

interface HubEditModalProps {
  open: boolean;
  /** Endpoint to PATCH against, e.g. `/api/sales-orders/<id>/hub`. */
  endpoint: string;
  currentHubId: string | null | undefined;
  hubs: DeliveryHub[];
  onClose: () => void;
  /** Called after a successful save so the parent can refresh + toast. */
  onSaved: (hubName: string) => void;
}

export function HubEditModal({
  open,
  endpoint,
  currentHubId,
  hubs,
  onClose,
  onSaved,
}: HubEditModalProps) {
  const [hubId, setHubId] = useState<string>(currentHubId ?? "");
  const [reason, setReason] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [errMsg, setErrMsg] = useState<string>("");

  if (!open) return null;

  const handleSave = async () => {
    if (!hubId) {
      setErrMsg("Pick a hub before saving.");
      return;
    }
    if (hubId === (currentHubId ?? "")) {
      setErrMsg("Pick a different hub — this is already the current one.");
      return;
    }
    setSaving(true);
    setErrMsg("");
    let res: Response;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any;
    try {
      res = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hubId, reason: reason.trim() || undefined }),
      });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      setSaving(false);
      setErrMsg(e instanceof Error ? e.message : "Network error.");
      return;
    }
    setSaving(false);
    if (!res.ok || !data?.success) {
      // Special-case the shipment lock so the message stays in-place.
      const msg =
        data?.error ||
        `Failed to update hub (HTTP ${res.status}).`;
      setErrMsg(msg);
      return;
    }
    const newHub = hubs.find((h) => h.id === hubId);
    onSaved(newHub?.shortName || "(new hub)");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="fixed inset-0 bg-black/40"
        onClick={() => (saving ? null : onClose())}
      />
      <div className="relative bg-white rounded-lg shadow-xl border border-[#E2DDD8] w-full max-w-md mx-4 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-[#1F1D1B]">
            Change Delivery Hub
          </h3>
          <button
            onClick={onClose}
            disabled={saving}
            className="text-[#9CA3AF] hover:text-[#374151] disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="text-xs text-[#6B7280]">
          Pick the correct hub. Saves immediately and writes an audit row.
          Hub locks the moment any piece leaves the warehouse.
        </p>

        <div className="space-y-2">
          <label className="text-xs font-medium text-[#374151]">Hub</label>
          <select
            value={hubId}
            onChange={(e) => setHubId(e.target.value)}
            disabled={saving}
            className="flex h-10 w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-[#1F1D1B] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32] disabled:opacity-50"
          >
            <option value="">— Select a hub —</option>
            {hubs.map((h) => (
              <option key={h.id} value={h.id}>
                {h.shortName}
                {h.state ? ` (${h.state})` : ""}
                {h.isDefault ? "  — default" : ""}
              </option>
            ))}
          </select>
          {hubs.length === 0 && (
            <p className="text-xs text-[#9A3A2D]">
              This customer has no delivery hubs configured. Add one on the
              Customers page first.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-[#374151]">
            Reason (optional)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={saving}
            rows={2}
            maxLength={500}
            placeholder="e.g. operator picked wrong hub"
            className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-[#1F1D1B] placeholder:text-[#9CA3AF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32] disabled:opacity-50"
          />
        </div>

        {errMsg && (
          <div className="rounded-md border border-[#E8B2A1] bg-[#F9E1DA] px-3 py-2 text-xs text-[#7A2E24]">
            {errMsg}
          </div>
        )}

        <div className="flex justify-end gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={saving || !hubId}
          >
            {saving ? "Saving…" : "Save Hub"}
          </Button>
        </div>
      </div>
    </div>
  );
}
