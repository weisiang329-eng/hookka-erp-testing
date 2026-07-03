import { useState, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { getQRCodeDataURL, rackScanUrl, itemQrValue } from "@/lib/qr-utils";
import {
  Warehouse, Grid3X3, Package, MapPin, LayoutGrid,
  ArrowDownToLine, ArrowUpFromLine, History, X, ArrowRightLeft,
  Loader2, RefreshCw, QrCode, Download, Search, Plus, ChevronDown,
} from "lucide-react";

// ---------- Types ----------
// A rack can hold any number of items — no limit (per user request
// "正常一个 rack 都可以放好几样东西的 暂时不需要 set limitation").
//
// PER-PIECE: a rack item from the public QR scan is ONE physical piece. Its
// clear description lives in `productName` (e.g. "1013 King Size Headboard") and
// its Sales Order number is stored in `notes` as "SO <no>" (rack_items has no
// dedicated SO column; see routes/public-rack-qr.ts). Legacy / office-stocked
// items instead carry productCode + customerName — the display helpers below
// unify BOTH shapes so every rack card reads the same way.
type RackItem = {
  productionOrderId?: string;
  productCode: string;
  productName?: string;
  sizeLabel?: string;
  customerName?: string;
  customerPOId?: string;
  qty?: number;
  stockedInDate?: string;
  notes?: string;
};

// The piece's Sales Order number, if its notes hold the "SO <no>" tag the
// public per-piece stock-in writes. Returns "" when there's no SO tag.
function rackItemSO(it: RackItem): string {
  const m = (it.notes || "").match(/\bSO\s+(\S+)/i);
  return m ? m[1] : "";
}

// One clear description line for a rack item, unifying the per-piece shape
// (productName + size) and the legacy shape (productCode). Never empty.
function rackItemDescription(it: RackItem): string {
  const name = (it.productName || it.productCode || "").trim();
  const size = (it.sizeLabel || "").trim();
  const desc = size && !name.includes(size) ? `${name} ${size}`.trim() : name;
  return desc || "Item";
}

type RackLocation = {
  id: string;
  rack: string;
  position: string;
  items: RackItem[];
  reserved?: boolean;
  status: "OCCUPIED" | "EMPTY" | "RESERVED"; // derived on the server
};

type StockMovement = {
  id: string;
  type: "STOCK_IN" | "STOCK_OUT" | "TRANSFER";
  rackLocationId: string;
  rackLabel: string;
  productionOrderId?: string;
  productCode: string;
  productName: string;
  quantity: number;
  reason: string;
  performedBy: string;
  createdAt: string;
  // Document reference resolved server-side from productionOrderId via the
  // production_orders join. poNo = production order no, salesOrderNo = the SO
  // it traces back to, docRef = best single label (poNo, else salesOrderNo).
  poNo?: string;
  salesOrderNo?: string;
  docRef?: string;
};

type ProductionOrder = {
  id: string;
  poNo: string;
  productCode: string;
  productName: string;
  sizeLabel: string;
  customerName: string;
  quantity: number;
  status: string;
  stockedIn: boolean;
  rackingNumber: string;
};

type Summary = {
  total: number;
  occupied: number;
  empty: number;
  reserved: number;
  occupancyRate: number;
};

// Per-rack detail payload from GET /api/warehouse/:id/details — drives the
// "Contents" + "Move history" sections of the rack detail popup.
type RackDetails = {
  rack: RackLocation;
  contents: RackItem[];
  movements: StockMovement[];
};

// ---------- Constants ----------
// Flat rack layout — "Rack 1" … "Rack 20", no A/B/C sub-columns.
const TABS = [
  { key: "grid", label: "Rack Overview", icon: Grid3X3 },
  { key: "stockio", label: "Stock In/Out", icon: ArrowRightLeft },
  { key: "history", label: "Movement History", icon: History },
] as const;
type TabKey = typeof TABS[number]["key"];

// ---------- Component ----------
export default function WarehousePage() {
  const [activeTab, setActiveTab] = useState<TabKey>("grid");

  // Popup / modals
  const [selectedSlot, setSelectedSlot] = useState<RackLocation | null>(null);
  // Rack-detail accordions — collapsed by default (owner 2026-07-03: Contents +
  // Move history open only on click). Reset each time a rack is opened.
  const [contentsOpen, setContentsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Rack Overview search (owner 2026-06-25): substring match — type "9090" to
  // find PO-009090, "062" to find SO-2606-062 — across each rack item's SO /
  // customer PO / customer name / product, to see WHICH rack a piece is in.
  // Pure client-side filter over the already-loaded racks (mirrors the SO/DO
  // list search); empty query shows every rack.
  const [rackSearch, setRackSearch] = useState("");
  // Small action menu shown when an EMPTY rack tile is clicked, so the owner can
  // print the rack's QR (to stick on, then scan to stock in) OR jump to stock-in.
  const [emptyRackMenu, setEmptyRackMenu] = useState<RackLocation | null>(null);
  const [showStockInForm, setShowStockInForm] = useState(false);
  const [stockInTarget, setStockInTarget] = useState<string>(""); // rackLocationId
  const [stockOutTarget, setStockOutTarget] = useState<RackLocation | null>(null);
  const [stockOutItemIndex, setStockOutItemIndex] = useState<number>(0);
  const [stockOutReason, setStockOutReason] = useState("");

  // "Create Item QR" — print a QR for a NON-system / loose item by name, with no
  // backend record (the name lives in the QR itself; see itemQrValue/parseItemQr).
  const [showItemQrForm, setShowItemQrForm] = useState(false);
  // Create-rack modal (owner 2026-07-02): add a new rack. Its id IS its QR
  // token, so a created rack is instantly QR-printable + used by every API.
  const [showCreateRack, setShowCreateRack] = useState(false);
  const [newRackName, setNewRackName] = useState("");
  const [newRackPosition, setNewRackPosition] = useState("");
  const [creatingRack, setCreatingRack] = useState(false);
  const [createRackError, setCreateRackError] = useState<string | null>(null);
  const [itemQrName, setItemQrName] = useState("");
  const [itemQrCode, setItemQrCode] = useState("");

  // Stock In form fields
  const [selectedPO, setSelectedPO] = useState("");
  const [stockInNote, setStockInNote] = useState("");

  // History filters
  const [historyType, setHistoryType] = useState<string>("");
  const [historyFrom, setHistoryFrom] = useState("");
  const [historyTo, setHistoryTo] = useState("");

  const [actionLoading, setActionLoading] = useState(false);
  const { toast } = useToast();

  // Small helper to assert a fetch succeeded before trusting its JSON body.
  // Warehouse mutations chain 2-3 calls (rack assign → movement log → PO
  // update) and a silent mid-sequence failure leaves the inventory books
  // drifting from reality — item shows stocked in UI, server hasn't
  // recorded the movement, next audit finds ghost stock. throw's caught
  // by the calling try/catch which surfaces a toast + aborts the chain.
  async function postOrThrow(url: string, opts: RequestInit): Promise<void> {
    let res: Response;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : "Network error");
    }
    if (!res.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let body: any = {};
      try { body = await res.json(); } catch { /* ignore */ }
      throw new Error(body?.error || `${opts.method || "GET"} ${url} failed (HTTP ${res.status})`);
    }
  }

  // ---------- Data Fetching ----------
  const movementsUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (historyType) params.set("type", historyType);
    if (historyFrom) params.set("from", historyFrom);
    if (historyTo) params.set("to", historyTo);
    return `/api/warehouse/movements?${params.toString()}`;
  }, [historyType, historyFrom, historyTo]);

  const { data: rackResp, loading: rackLoading, refresh: fetchRackLocations } = useCachedJson<{ success?: boolean; data?: RackLocation[]; summary?: Summary }>("/api/warehouse");
  const { data: movementsResp, loading: movementsLoading, refresh: fetchMovements } = useCachedJson<{ success?: boolean; data?: StockMovement[] }>(movementsUrl);

  // Create a new (empty) rack. The backend inserts a rack_locations row whose id
  // IS the QR token — so no separate QR/step is needed and the rack immediately
  // shows in the grid, prints via "Download all rack QRs", and accepts stock-in.
  const handleCreateRack = async () => {
    const rack = newRackName.trim();
    if (!rack || creatingRack) return;
    setCreatingRack(true);
    setCreateRackError(null);
    try {
      const res = await fetch("/api/warehouse/racks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rack,
          position: newRackPosition.trim() || undefined,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
      };
      if (!res.ok || j.success === false) {
        setCreateRackError(j.error || "Failed to create rack");
        return;
      }
      setShowCreateRack(false);
      setNewRackName("");
      setNewRackPosition("");
      fetchRackLocations();
    } catch {
      setCreateRackError("Network error creating rack");
    } finally {
      setCreatingRack(false);
    }
  };
  // ?fields=minimal&include= → drop jobCards (this page only reads PO
  // basics — productionOrders.find / .filter — never .jobCards).
  // Trims a 12MB payload to ~100-300KB.
  const { data: poResp, loading: poLoading, refresh: fetchProductionOrders } = useCachedJson<{ success?: boolean; data?: ProductionOrder[] }>("/api/production-orders?fields=minimal&include=");
  // Per-rack contents + move history for the detail popup. URL is null when no
  // rack is selected, so nothing is fetched until the owner opens a rack.
  const { data: rackDetailResp, loading: rackDetailLoading } = useCachedJson<{ success?: boolean; data?: RackDetails }>(
    selectedSlot ? `/api/warehouse/${encodeURIComponent(selectedSlot.id)}/details` : null
  );

  const rackLocations: RackLocation[] = useMemo(() => {
    const list = rackResp?.success ? rackResp.data ?? [] : Array.isArray(rackResp) ? rackResp : [];
    // Natural numeric sort by the trailing rack number so dropdowns + lists read
    // Rack 1, 2, 3 … 9, 10, 11 … 20 instead of the string order Rack 1, 10, 11,
    // 2, 20 … (server returns ORDER BY rack = lexical). Tie-break on the raw
    // string so racks without a number stay stable.
    const rackNo = (s: string) => parseInt(s.match(/\d+/)?.[0] ?? "0", 10);
    return [...list].sort(
      (a, b) => rackNo(a.rack) - rackNo(b.rack) || a.rack.localeCompare(b.rack)
    );
  }, [rackResp]);
  const summary: Summary = useMemo(
    () => rackResp?.summary ?? { total: 0, occupied: 0, empty: 0, reserved: 0, occupancyRate: 0 },
    [rackResp]
  );
  const movements: StockMovement[] = useMemo(
    () => (movementsResp?.success ? movementsResp.data ?? [] : Array.isArray(movementsResp) ? movementsResp : []),
    [movementsResp]
  );
  const productionOrders: ProductionOrder[] = useMemo(
    () => (poResp?.success ? poResp.data ?? [] : Array.isArray(poResp) ? poResp : []),
    [poResp]
  );
  // Popup detail: contents fall back to the slot's own items (already loaded in
  // the grid) until the per-rack fetch lands, so the list never flashes empty.
  const rackDetails: RackDetails | null = useMemo(
    () => (rackDetailResp?.success ? rackDetailResp.data ?? null : null),
    [rackDetailResp]
  );
  const popupContents: RackItem[] = rackDetails?.contents ?? selectedSlot?.items ?? [];
  const popupMovements: StockMovement[] = rackDetails?.movements ?? [];
  const loading = rackLoading || movementsLoading || poLoading;

  // Rack Overview search predicate — substring across the searchable identity
  // fields of ANY item in the rack (partial match: "9090" hits PO-009090).
  // Empty query → every rack matches.
  const rackQuery = rackSearch.trim().toLowerCase();
  const rackHasMatch = (slot: RackLocation): boolean => {
    if (!rackQuery) return true;
    return (slot.items || []).some((it) =>
      [
        rackItemSO(it),
        rackItemDescription(it),
        it.customerName || "",
        it.customerPOId || "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(rackQuery),
    );
  };
  const shownRackCount = rackLocations.reduce(
    (n, s) => n + (rackHasMatch(s) ? 1 : 0),
    0,
  );

  // ---------- Actions ----------
  const handleStockIn = async () => {
    if (!stockInTarget || !selectedPO) return;
    setActionLoading(true);
    try {
      const po = productionOrders.find((p) => p.id === selectedPO);
      if (!po) return;

      // 1. Assign rack location
      await postOrThrow("/api/warehouse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rackLocationId: stockInTarget,
          productionOrderId: po.id,
          productCode: po.productCode,
          productName: po.productName,
          sizeLabel: po.sizeLabel,
          customerName: po.customerName,
          notes: stockInNote,
        }),
      });

      // 2. Record stock movement
      await postOrThrow("/api/warehouse/movements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "STOCK_IN",
          rackLocationId: stockInTarget,
          rackLabel: stockInTarget,
          productionOrderId: po.id,
          productCode: po.productCode,
          productName: `${po.productName} ${po.sizeLabel}`,
          quantity: po.quantity,
          reason: `Production completed - stocked in from ${po.poNo}`,
          performedBy: "Warehouse Staff",
        }),
      });

      // 3. Update production order stockedIn status
      await postOrThrow(`/api/production-orders/${po.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rackingNumber: stockInTarget,
          stockedIn: true,
        }),
      });

      // Refresh data
      invalidateCachePrefix("/api/warehouse");
      invalidateCachePrefix("/api/production-orders");
      invalidateCachePrefix("/api/inventory");
      invalidateCachePrefix("/api/stock-movements");
      fetchRackLocations();
      fetchMovements();
      fetchProductionOrders();
      setShowStockInForm(false);
      setStockInTarget("");
      setSelectedPO("");
      setStockInNote("");
      toast.success("Stocked in");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Stock in failed — nothing saved");
    } finally {
      setActionLoading(false);
    }
  };

  const handleStockOut = async () => {
    if (!stockOutTarget) return;
    const item = stockOutTarget.items[stockOutItemIndex];
    if (!item) return;
    setActionLoading(true);
    try {
      // 1. Record stock movement for the specific item being removed.
      await postOrThrow("/api/warehouse/movements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "STOCK_OUT",
          rackLocationId: stockOutTarget.id,
          rackLabel: stockOutTarget.id,
          // Omit (undefined → not serialized) when the item has no PO link, so
          // the server stores NULL rather than "" and the movements JOIN stays
          // honest. Matches the productionOrderId || null bind in warehouse.ts.
          productionOrderId: item.productionOrderId || undefined,
          productCode: item.productCode || "",
          productName: `${item.productName || ""} ${item.sizeLabel || ""}`.trim(),
          quantity: item.qty ?? 1,
          reason: stockOutReason || "Stock out",
          performedBy: "Warehouse Staff",
        }),
      });

      // 2. Remove ONLY the selected item from the rack. Per-piece rows share an
      // empty productCode, so identify them by their description + SO-notes
      // signature; legacy single-code racks still remove by productCode. (Never
      // send an empty productCode — that used to wipe the whole rack.)
      const removeQs = item.productCode
        ? `productCode=${encodeURIComponent(item.productCode)}`
        : `itemName=${encodeURIComponent(item.productName || "")}` +
          `&itemNotes=${encodeURIComponent(item.notes || "")}`;
      await postOrThrow(
        `/api/warehouse/${stockOutTarget.id}?${removeQs}`,
        { method: "DELETE" }
      );

      // Refresh data
      invalidateCachePrefix("/api/warehouse");
      invalidateCachePrefix("/api/production-orders");
      invalidateCachePrefix("/api/inventory");
      invalidateCachePrefix("/api/stock-movements");
      fetchRackLocations();
      fetchMovements();
      setStockOutTarget(null);
      setStockOutItemIndex(0);
      setStockOutReason("");
      toast.success("Stocked out");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Stock out failed — inventory unchanged");
    } finally {
      setActionLoading(false);
    }
  };

  // Print a single rack's QR sticker. Encodes the PUBLIC scan URL (`/r/<id>`)
  // so a NORMAL phone camera opens this rack's stock-in page — no in-app scanner
  // needed. Mirrors the delivery-QR / department-poster print pattern: build a
  // hi-res data URL, open a blank window, write a self-contained sticker, then
  // print() after a short settle delay (runs from a click gesture, so no
  // pop-up-blocker trip).
  const handlePrintRackQr = async (slot: RackLocation) => {
    const qrDataUrl = await getQRCodeDataURL(rackScanUrl(slot.id), 600).catch(() => null);
    if (!qrDataUrl) {
      toast.error("Failed to generate rack QR");
      return;
    }
    const w = window.open("", "_blank");
    if (!w) {
      toast.error("Please allow pop-ups to print");
      return;
    }
    // position is the rack's location label (e.g. a row/bay); only show the row
    // when it carries something distinct from the rack name itself.
    const locationLabel =
      slot.position && slot.position !== slot.rack ? slot.position : "";
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Rack QR — ${esc(slot.rack)}</title>
<style>
  @page { margin: 14mm; }
  body { font-family: Helvetica, Arial, sans-serif; color: #111; text-align: center; }
  .kind { font-size: 13px; text-transform: uppercase; letter-spacing: 3px; color: #555; }
  .rack-no { font-size: 34px; font-weight: 800; letter-spacing: 1px; margin: 10mm 0 2mm; }
  .loc { font-size: 14px; color: #555; margin-bottom: 2mm; }
  img { width: 90mm; height: 90mm; margin-top: 6mm; }
  .hint { font-size: 13px; color: #333; margin-top: 8mm; }
  .sub { font-size: 11px; color: #777; margin-top: 2mm; }
</style></head><body>
  <div class="kind">Warehouse Rack</div>
  <div class="rack-no">${esc(slot.rack)}</div>
  ${locationLabel ? `<div class="loc">${esc(locationLabel)}</div>` : ""}
  <img src="${qrDataUrl}" alt="Rack QR code" />
  <div class="hint">Scan with any phone camera to stock in</div>
  <div class="sub">HOOKKA INDUSTRIES — warehouse rack QR</div>
</body></html>`);
    w.document.close();
    w.focus();
    // Give the new window time to lay out before invoking print(). Click
    // handler, not React lifecycle — useTimeout doesn't apply.
    // eslint-disable-next-line no-restricted-syntax -- print-window settle delay from event handler
    setTimeout(() => w.print(), 500);
  };

  // Batch-print EVERY rack's public-scan QR onto one sheet (a CSS-grid of
  // tiles, each = rack label + its `/r/<id>` QR). Same print mechanics as
  // handlePrintRackQr — local data URLs (no network round-trip), blank window,
  // self-contained doc, print() after a short settle delay — looped over the
  // already-loaded rackLocations so the owner can label every rack in one go.
  const [allRackQrLoading, setAllRackQrLoading] = useState(false);
  const handleDownloadAllRackQrs = async () => {
    if (allRackQrLoading) return;
    if (rackLocations.length === 0) {
      toast.error("No racks to print");
      return;
    }
    setAllRackQrLoading(true);
    try {
      // Generate all QRs locally FIRST (getQRCodeDataURL never hits the network,
      // so a 20-rack batch is fine), then write one sheet with every tile.
      const tiles = await Promise.all(
        rackLocations.map(async (l) => ({
          rack: l.rack,
          qr: await getQRCodeDataURL(rackScanUrl(l.id), 600).catch(() => null),
        })),
      );
      const ready = tiles.filter((t) => t.qr);
      if (ready.length === 0) {
        toast.error("Failed to generate rack QRs");
        return;
      }
      const w = window.open("", "_blank");
      if (!w) {
        toast.error("Please allow pop-ups to print");
        return;
      }
      const esc = (s: string) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const tilesHtml = ready
        .map(
          (t) => `  <div class="tile">
    <div class="rack-no">${esc(t.rack)}</div>
    <img src="${t.qr}" alt="Rack QR code" />
    <div class="hint">Scan with any phone camera to stock in</div>
  </div>`,
        )
        .join("\n");
      w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>All Rack QRs</title>
<style>
  @page { margin: 12mm; }
  body { font-family: Helvetica, Arial, sans-serif; color: #111; margin: 0; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10mm; }
  .tile { border: 1px solid #ddd; border-radius: 6px; padding: 6mm; text-align: center; break-inside: avoid; page-break-inside: avoid; }
  .rack-no { font-size: 22px; font-weight: 800; letter-spacing: 1px; margin-bottom: 3mm; }
  .tile img { width: 60mm; height: 60mm; }
  .hint { font-size: 11px; color: #333; margin-top: 3mm; }
</style></head><body>
  <div class="grid">
${tilesHtml}
  </div>
</body></html>`);
      w.document.close();
      w.focus();
      // Give the new window time to lay out (all images decode) before print().
      // Click handler, not React lifecycle — useTimeout doesn't apply.
      // eslint-disable-next-line no-restricted-syntax -- print-window settle delay from event handler
      setTimeout(() => w.print(), 500);
    } finally {
      setAllRackQrLoading(false);
    }
  };

  // Print a QR sticker for a NON-system / loose item, naming it. There is NO
  // backend record — the name (and optional linked product code) is encoded
  // directly in the QR (`HKITEM:<name>` / `HKITEM:<name>|<code>`) so it can be
  // scanned later during rack stock-in. Same print mechanics as
  // handlePrintRackQr: build a hi-res data URL, open a blank window, write a
  // self-contained sticker, then print() after a short settle delay (runs from
  // a click gesture, so no pop-up-blocker trip).
  const handlePrintItemQr = async () => {
    const name = itemQrName.trim();
    const code = itemQrCode.trim();
    if (!name) {
      toast.error("Please enter an item name");
      return;
    }
    const qrDataUrl = await getQRCodeDataURL(itemQrValue(name, code || undefined), 600).catch(
      () => null,
    );
    if (!qrDataUrl) {
      toast.error("Failed to generate item QR");
      return;
    }
    const w = window.open("", "_blank");
    if (!w) {
      toast.error("Please allow pop-ups to print");
      return;
    }
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Item QR — ${esc(name)}</title>
<style>
  @page { margin: 14mm; }
  body { font-family: Helvetica, Arial, sans-serif; color: #111; text-align: center; }
  .kind { font-size: 13px; text-transform: uppercase; letter-spacing: 3px; color: #555; }
  .item-name { font-size: 28px; font-weight: 800; letter-spacing: 1px; margin: 10mm 0 2mm; }
  .code { font-size: 14px; color: #555; margin-bottom: 2mm; }
  img { width: 90mm; height: 90mm; margin-top: 6mm; }
  .hint { font-size: 13px; color: #333; margin-top: 8mm; }
  .sub { font-size: 11px; color: #777; margin-top: 2mm; }
</style></head><body>
  <div class="kind">Non-System Item</div>
  <div class="item-name">${esc(name)}</div>
  ${code ? `<div class="code">${esc(code)}</div>` : ""}
  <img src="${qrDataUrl}" alt="Item QR code" />
  <div class="hint">Scan to select this item</div>
  <div class="sub">HOOKKA INDUSTRIES — non-system item QR</div>
</body></html>`);
    w.document.close();
    w.focus();
    // Give the new window time to lay out before invoking print(). Click
    // handler, not React lifecycle — useTimeout doesn't apply.
    // eslint-disable-next-line no-restricted-syntax -- print-window settle delay from event handler
    setTimeout(() => w.print(), 500);
    setShowItemQrForm(false);
    setItemQrName("");
    setItemQrCode("");
  };

  // Completed POs that are not yet stocked in
  const availablePOs = productionOrders.filter(
    (po) => po.status === "COMPLETED" && !po.stockedIn
  );

  // Racks available for stock-in: anything not explicitly reserved. Since
  // racks can hold multiple items, occupied racks are still valid targets.
  const stockInEligibleRacks = rackLocations.filter((l) => l.status !== "RESERVED");

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-[#6B5C32]" />
        <span className="ml-2 text-[#6B7280]">Loading warehouse data...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Warehouse</h1>
          <p className="text-xs text-[#6B7280]">Rack location management, stock-in/out tracking</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => { setCreateRackError(null); setShowCreateRack(true); }}>
            <Plus className="h-4 w-4" /> Create Rack
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowItemQrForm(true)}>
            <QrCode className="h-4 w-4" /> Create Item QR
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={allRackQrLoading || rackLocations.length === 0}
            onClick={() => void handleDownloadAllRackQrs()}
          >
            {allRackQrLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download all rack QRs
          </Button>
          <Button variant="outline" size="sm" onClick={() => { fetchRackLocations(); fetchMovements(); }}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-5">
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Total Slots</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{summary.total}</p>
            </div>
            <Grid3X3 className="h-5 w-5 text-[#6B5C32]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Occupied</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{summary.occupied}</p>
            </div>
            <Package className="h-5 w-5 text-[#3E6570]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Empty</p>
              <p className="text-xl font-bold text-[#4F7C3A]">{summary.empty}</p>
            </div>
            <MapPin className="h-5 w-5 text-[#4F7C3A]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Reserved</p>
              <p className="text-xl font-bold text-[#9C6F1E]">{summary.reserved}</p>
            </div>
            <LayoutGrid className="h-5 w-5 text-[#9C6F1E]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Occupancy</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{summary.occupancyRate}%</p>
            </div>
            <Warehouse className="h-5 w-5 text-[#6B5C32]" />
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#E2DDD8]">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
                isActive
                  ? "border-[#6B5C32] text-[#6B5C32]"
                  : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* ===== TAB 1: Rack Overview ===== */}
      {activeTab === "grid" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <Warehouse className="h-5 w-5 text-[#6B5C32]" />
              Rack Grid Layout
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {/* Legend */}
              <div className="flex items-center gap-4 text-xs text-[#6B7280]">
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded bg-[#6B5C32]" />
                  <span>Occupied ({summary.occupied})</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded bg-[#EEF3E4] border border-[#C6DBA8]" />
                  <span>Empty ({summary.empty})</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded bg-[#FAEFCB] border border-[#E8D597]" />
                  <span>Reserved ({summary.reserved})</span>
                </div>
              </div>

              {/* Search — find which rack a piece is in by SO / customer PO /
                  customer / product. Substring (type "9090" → PO-009090);
                  client-side over the already-loaded racks. */}
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#9C8F73]" />
                  <input
                    type="text"
                    value={rackSearch}
                    onChange={(e) => setRackSearch(e.target.value)}
                    placeholder="Search by SO, customer PO, customer, or product…"
                    className="w-full rounded-md border border-[#E2DDD8] bg-white pl-9 pr-3 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30 focus:border-[#6B5C32]"
                  />
                </div>
                {rackSearch && (
                  <Button variant="outline" size="sm" onClick={() => setRackSearch("")}>
                    Clear
                  </Button>
                )}
              </div>
              {rackQuery && (
                <p className="text-xs text-[#6B5C32]">
                  Showing <span className="font-semibold">{shownRackCount}</span> of {rackLocations.length} racks
                  {shownRackCount === 0 ? " — no item matches" : ""}
                </p>
              )}

              {/* Grid — flat list of 20 racks, 5 per row. Each rack can show
                  multiple items; if more than 3 items we show the first 3 and
                  a "+N more" indicator. Card height auto-grows. */}
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3 items-start">
                {rackLocations.map((slot) => {
                  // Render every real rack from the DB (incl. Floor + any created
                  // rack), not a hard-coded 1..20 list — a new rack was invisible.
                  // Hide racks with no item matching the search (empty query = all).
                  if (rackQuery && !rackHasMatch(slot)) return null;

                  const bgColor =
                    slot.status === "OCCUPIED"
                      ? "bg-[#6B5C32] text-white"
                      : slot.status === "RESERVED"
                      ? "bg-[#FAEFCB] border border-[#E8D597] text-[#9C6F1E]"
                      : "bg-[#EEF3E4] border border-[#C6DBA8] text-[#4F7C3A]";

                  const VISIBLE = 3;
                  const slotItems = slot.items || [];
                  const visibleItems = slotItems.slice(0, VISIBLE);
                  const extraCount = Math.max(0, slotItems.length - VISIBLE);

                  return (
                    <div
                      key={slot.id}
                      className={`rounded-md p-3 cursor-pointer hover:opacity-80 transition-opacity min-h-[72px] ${bgColor}`}
                      onClick={() => {
                        if (slot.status === "OCCUPIED") {
                          setContentsOpen(false);
                          setHistoryOpen(false);
                          setSelectedSlot(slot);
                        } else if (slot.status === "EMPTY") {
                          // Empty rack: offer Print Rack QR + Stock in here rather
                          // than jumping straight to the form, so QR labels can be
                          // printed for empty racks too (stick on → scan to stock in).
                          setEmptyRackMenu(slot);
                        }
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold">{slot.rack}</p>
                        {slot.status === "OCCUPIED" && (
                          <span className="text-[10px] opacity-80">
                            {slotItems.length} item{slotItems.length > 1 ? "s" : ""}
                          </span>
                        )}
                      </div>
                      {slot.status === "OCCUPIED" && (
                        <div className="mt-2 pt-2 border-t border-white/15 divide-y divide-white/10">
                          {/* Per-item identity (owner 2026-06-25): description +
                              customer · customer PO + our SO. Each item is spaced
                              out with a faint divider (owner: "排版漂亮一点,别全挤在
                              一起") so a multi-item rack reads cleanly. */}
                          {visibleItems.map((it, i) => {
                            const so = rackItemSO(it);
                            const cust = it.customerName || "";
                            const po = it.customerPOId || "";
                            return (
                              <div key={i} className="py-1.5 leading-tight">
                                <p className="text-[12px] font-medium truncate">
                                  {rackItemDescription(it)}
                                </p>
                                {(cust || po) && (
                                  <p className="text-[11px] truncate opacity-90 mt-0.5">
                                    {cust}
                                    {cust && po ? " · " : ""}
                                    {po}
                                  </p>
                                )}
                                {so && (
                                  <p className="text-[10px] truncate opacity-60 mt-0.5">{so}</p>
                                )}
                              </div>
                            );
                          })}
                          {extraCount > 0 && (
                            <p className="text-[11px] opacity-85 pt-2 text-center">
                              + {extraCount} more
                            </p>
                          )}
                        </div>
                      )}
                      {slot.status === "RESERVED" && (
                        <p className="text-[11px] mt-0.5">Reserved</p>
                      )}
                      {slot.status === "EMPTY" && (
                        <p className="text-[11px] mt-0.5">Empty</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ===== Occupied Slot Detail Popup ===== */}
      {selectedSlot && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setSelectedSlot(null)}>
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-[#1F1D1B]">{selectedSlot.rack}</h3>
              <button onClick={() => setSelectedSlot(null)} className="text-[#6B7280] hover:text-[#1F1D1B] cursor-pointer">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-[#6B7280]">Status</span>
                <Badge>{selectedSlot.status}</Badge>
              </div>

              {/* ----- Contents: what's currently IN this rack (collapsed by default) ----- */}
              <button
                type="button"
                onClick={() => setContentsOpen((o) => !o)}
                className="flex w-full items-center justify-between pt-1 cursor-pointer text-left"
              >
                <span className="flex items-center gap-1.5 font-semibold text-[#1F1D1B]">
                  <ChevronDown className={`h-4 w-4 text-[#6B7280] transition-transform ${contentsOpen ? "" : "-rotate-90"}`} />
                  Contents
                </span>
                <span className="text-xs text-[#6B7280]">{popupContents.length} item{popupContents.length === 1 ? "" : "s"}</span>
              </button>
              {contentsOpen && (
              <div className="space-y-2">
                {popupContents.length === 0 ? (
                  <p className="text-xs text-[#6B7280] text-center py-3">No items in this rack.</p>
                ) : (
                  popupContents.map((it, i) => {
                    const so = rackItemSO(it);
                    // Suppress notes that are ONLY the "SO <no>" tag — the SO is
                    // shown on its own line below — but keep any other note text.
                    const extraNotes = (it.notes || "")
                      .replace(/\bSO\s+\S+/i, "")
                      .trim();
                    // Per-piece rows are always qty 1; only surface qty when it
                    // adds information (legacy multi-qty rows).
                    const showQty = typeof it.qty === "number" && it.qty > 1;
                    return (
                      <div key={i} className="rounded-md border border-[#E2DDD8] p-3 space-y-0.5 bg-[#FAF9F7]">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-[#1F1D1B]">{rackItemDescription(it)}</span>
                          {showQty && (
                            <span className="text-xs text-[#6B7280] shrink-0">Qty: {it.qty}</span>
                          )}
                        </div>
                        {it.customerName && <p className="text-xs text-[#6B7280]">Customer: {it.customerName}</p>}
                        {it.customerPOId && <p className="text-xs text-[#6B7280]">Customer PO: {it.customerPOId}</p>}
                        {so && <p className="text-xs text-[#4B5563]">Sales Order: {so}</p>}
                        {it.stockedInDate && <p className="text-xs text-[#6B7280]">Stocked In: {it.stockedInDate}</p>}
                        {extraNotes && <p className="text-xs text-[#6B7280]">Notes: {extraNotes}</p>}
                      </div>
                    );
                  })
                )}
              </div>
              )}

              {/* ----- Move history: in/out for THIS rack (collapsed by default) ----- */}
              <button
                type="button"
                onClick={() => setHistoryOpen((o) => !o)}
                className="flex w-full items-center justify-between pt-3 mt-3 border-t border-[#E2DDD8] cursor-pointer text-left"
              >
                <span className="flex items-center gap-1.5 font-semibold text-[#1F1D1B]">
                  <ChevronDown className={`h-4 w-4 text-[#6B7280] transition-transform ${historyOpen ? "" : "-rotate-90"}`} />
                  Move history
                </span>
                {rackDetailLoading && <Loader2 className="h-4 w-4 animate-spin text-[#6B5C32]" />}
              </button>
              {historyOpen && (
              <div className="space-y-2">
                {popupMovements.length === 0 ? (
                  <p className="text-xs text-[#6B7280] text-center py-3">
                    {rackDetailLoading ? "Loading history..." : "No movements recorded for this rack."}
                  </p>
                ) : (
                  popupMovements.map((m) => (
                    <div key={m.id} className="rounded-md border border-[#E2DDD8] p-3 bg-white">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Badge
                            className={
                              m.type === "STOCK_IN"
                                ? "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]"
                                : m.type === "STOCK_OUT"
                                ? "bg-[#F9E1DA] text-[#9A3A2D] border-[#E8B2A1]"
                                : "bg-[#E0EDF0] text-[#3E6570] border-[#A8CAD2]"
                            }
                          >
                            {m.type === "STOCK_IN" ? "IN" : m.type === "STOCK_OUT" ? "OUT" : "TRANSFER"}
                          </Badge>
                          <span className="text-xs text-[#6B7280]">Qty: {m.quantity}</span>
                        </div>
                        <span className="text-xs text-[#6B7280] whitespace-nowrap">
                          {new Date(m.createdAt).toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" })}
                        </span>
                      </div>
                      {m.productName && <p className="text-xs text-[#4B5563] mt-1">{m.productName}</p>}
                      {/* Document reference — docRef (reason-extracted DO/DR/GRN,
                          else PO, else SO) as primary; a distinct PO/SO appended
                          only when it adds info beyond docRef. */}
                      {(() => {
                        const primary = m.docRef || m.poNo || m.salesOrderNo || "";
                        if (!primary) return null;
                        const secondary =
                          m.poNo && m.poNo !== primary
                            ? m.poNo
                            : m.salesOrderNo && m.salesOrderNo !== primary
                            ? m.salesOrderNo
                            : "";
                        return (
                          <p className="text-xs text-[#4B5563] mt-0.5">
                            <span className="font-medium text-[#1F1D1B]">{primary}</span>
                            {secondary && <span className="text-[#6B7280]"> · {secondary}</span>}
                          </p>
                        );
                      })()}
                      {m.reason && <p className="text-xs text-[#6B7280] mt-0.5">{m.reason}</p>}
                      {m.performedBy && <p className="text-[11px] text-[#9CA3AF] mt-0.5">By {m.performedBy}</p>}
                    </div>
                  ))
                )}
              </div>
              )}
            </div>
            <div className="mt-6 flex gap-2 justify-between">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handlePrintRackQr(selectedSlot)}
              >
                <QrCode className="h-4 w-4" /> Print Rack QR
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    setStockOutTarget(selectedSlot);
                    setSelectedSlot(null);
                    setActiveTab("stockio");
                  }}
                >
                  <ArrowUpFromLine className="h-4 w-4" /> Stock Out
                </Button>
                <Button variant="outline" size="sm" onClick={() => setSelectedSlot(null)}>
                  Close
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== Empty Rack Action Menu ===== */}
      {/* Shown when an EMPTY rack tile is clicked. Lets the owner print the rack's
          QR label (the whole point: stick it on an empty rack, then scan to stock
          in) or jump straight to the stock-in form. Reuses handlePrintRackQr and
          the same stock-in navigation the tile used to trigger directly. */}
      {emptyRackMenu && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setEmptyRackMenu(null)}>
          <div className="bg-white rounded-lg shadow-xl max-w-sm w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-[#1F1D1B]">{emptyRackMenu.rack}</h3>
              <button onClick={() => setEmptyRackMenu(null)} className="text-[#6B7280] hover:text-[#1F1D1B] cursor-pointer">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm text-[#6B7280]">Status</span>
              <Badge>{emptyRackMenu.status}</Badge>
            </div>
            <div className="space-y-2">
              <Button
                variant="outline"
                className="w-full justify-start"
                onClick={() => {
                  void handlePrintRackQr(emptyRackMenu);
                  setEmptyRackMenu(null);
                }}
              >
                <QrCode className="h-4 w-4" /> Print Rack QR
              </Button>
              <Button
                variant="primary"
                className="w-full justify-start"
                onClick={() => {
                  setStockInTarget(emptyRackMenu.id);
                  setShowStockInForm(true);
                  setActiveTab("stockio");
                  setEmptyRackMenu(null);
                }}
              >
                <ArrowDownToLine className="h-4 w-4" /> Stock in here
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ===== Create Item QR Modal ===== */}
      {/* Print a QR for a NON-system / loose item by name. No backend record —
          the name is encoded in the QR (itemQrValue) and can be scanned later
          during rack stock-in. */}
      {showItemQrForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowItemQrForm(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-[#1F1D1B]">Create Item QR</h3>
              <button onClick={() => setShowItemQrForm(false)} className="text-[#6B7280] hover:text-[#1F1D1B] cursor-pointer">
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="text-xs text-[#6B7280] mb-4">
              Print a QR label for an item that isn't in the system. The name is
              stored in the QR itself — scan it later during rack stock-in.
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1">Item Name</label>
                <input
                  type="text"
                  autoFocus
                  className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  value={itemQrName}
                  onChange={(e) => setItemQrName(e.target.value)}
                  placeholder="e.g. Loose timber leg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1">Link to product code (optional)</label>
                <input
                  type="text"
                  className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  value={itemQrCode}
                  onChange={(e) => setItemQrCode(e.target.value)}
                  placeholder="e.g. WD-LEG-01"
                />
              </div>
            </div>
            <div className="mt-6 flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => setShowItemQrForm(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!itemQrName.trim()}
                onClick={() => void handlePrintItemQr()}
              >
                <QrCode className="h-4 w-4" /> Generate &amp; Print
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ===== Create Rack Modal ===== */}
      {showCreateRack && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowCreateRack(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-[#1F1D1B]">Create Rack</h3>
              <button onClick={() => setShowCreateRack(false)} className="text-[#6B7280] hover:text-[#1F1D1B] cursor-pointer">
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="text-xs text-[#6B7280] mb-4">
              Add a new (empty) rack. Its QR code is generated automatically — print
              it from “Download all rack QRs” or the rack’s own QR button — and it’s
              immediately usable for stock-in, movements and scanning.
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1">Rack number / name *</label>
                <input
                  type="text"
                  autoFocus
                  className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  value={newRackName}
                  onChange={(e) => setNewRackName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void handleCreateRack(); }}
                  placeholder="e.g. Rack 21"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1">Position / zone (optional)</label>
                <input
                  type="text"
                  className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  value={newRackPosition}
                  onChange={(e) => setNewRackPosition(e.target.value)}
                  placeholder="e.g. A / Row 3"
                />
              </div>
              {createRackError ? (
                <p className="text-xs text-[#9A3A2D]">{createRackError}</p>
              ) : null}
            </div>
            <div className="mt-6 flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => setShowCreateRack(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={!newRackName.trim() || creatingRack} onClick={() => void handleCreateRack()}>
                {creatingRack ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create Rack
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ===== TAB 2: Stock In/Out ===== */}
      {activeTab === "stockio" && (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Stock In Form */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-[#4F7C3A]">
                <ArrowDownToLine className="h-5 w-5" />
                Stock In
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {availablePOs.length === 0 && !showStockInForm ? (
                <p className="text-xs text-[#6B7280]">No completed production orders available for stocking in.</p>
              ) : (
                <>
                  <div>
                    <label className="block text-sm font-medium text-[#374151] mb-1">Production Order</label>
                    <select
                      className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                      value={selectedPO}
                      onChange={(e) => setSelectedPO(e.target.value)}
                    >
                      <option value="">Select a completed PO...</option>
                      {availablePOs.map((po) => (
                        <option key={po.id} value={po.id}>
                          {po.poNo} - {po.productName} {po.sizeLabel} ({po.customerName})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-[#374151] mb-1">Rack Position</label>
                    <select
                      className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                      value={stockInTarget}
                      onChange={(e) => setStockInTarget(e.target.value)}
                    >
                      <option value="">Select rack...</option>
                      {stockInEligibleRacks.map((slot) => (
                        <option key={slot.id} value={slot.id}>
                          {slot.id} ({(slot.items || []).length} item{(slot.items || []).length === 1 ? "" : "s"})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-[#374151] mb-1">Notes (optional)</label>
                    <input
                      type="text"
                      className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                      value={stockInNote}
                      onChange={(e) => setStockInNote(e.target.value)}
                      placeholder="Additional notes..."
                    />
                  </div>
                  {selectedPO && (
                    <div className="bg-[#F0ECE9] rounded-md p-3 text-sm">
                      <p className="font-medium text-[#1F1D1B]">Selected PO Details:</p>
                      {(() => {
                        const po = productionOrders.find((p) => p.id === selectedPO);
                        if (!po) return null;
                        return (
                          <div className="mt-1 space-y-0.5 text-[#4B5563]">
                            <p>PO: {po.poNo}</p>
                            <p>Product: {po.productName} - {po.sizeLabel}</p>
                            <p>Customer: {po.customerName}</p>
                            <p>Qty: {po.quantity}</p>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                  <Button
                    variant="primary"
                    className="w-full"
                    disabled={!selectedPO || !stockInTarget || actionLoading}
                    onClick={handleStockIn}
                  >
                    {actionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
                    Confirm Stock In
                  </Button>
                </>
              )}
            </CardContent>
          </Card>

          {/* Stock Out Form */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-[#9A3A2D]">
                <ArrowUpFromLine className="h-5 w-5" />
                Stock Out
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1">Select Occupied Rack</label>
                <select
                  className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  value={stockOutTarget?.id || ""}
                  onChange={(e) => {
                    const loc = rackLocations.find((l) => l.id === e.target.value);
                    setStockOutTarget(loc || null);
                    setStockOutItemIndex(0);
                  }}
                >
                  <option value="">Select an occupied rack...</option>
                  {rackLocations
                    .filter((l) => l.status === "OCCUPIED")
                    .map((loc) => (
                      <option key={loc.id} value={loc.id}>
                        {loc.id} ({loc.items.length} item{loc.items.length === 1 ? "" : "s"})
                      </option>
                    ))}
                </select>
              </div>
              {stockOutTarget && stockOutTarget.items.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-[#374151] mb-1">Select Item to Remove</label>
                  <select
                    className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                    value={stockOutItemIndex}
                    onChange={(e) => setStockOutItemIndex(Number(e.target.value))}
                  >
                    {stockOutTarget.items.map((it, i) => {
                      const so = rackItemSO(it);
                      const tail = so
                        ? so
                        : it.customerName || "-";
                      return (
                        <option key={i} value={i}>
                          {rackItemDescription(it)} ({tail})
                        </option>
                      );
                    })}
                  </select>
                </div>
              )}
              {stockOutTarget && stockOutTarget.items[stockOutItemIndex] && (() => {
                const it = stockOutTarget.items[stockOutItemIndex];
                const so = rackItemSO(it);
                return (
                  <div className="bg-[#F9E1DA] rounded-md p-3 text-sm border border-[#E8B2A1]">
                    <p className="font-medium text-[#9A3A2D]">Item to be released:</p>
                    <div className="mt-1 space-y-0.5 text-[#9A3A2D]">
                      <p>Rack: {stockOutTarget.id}</p>
                      <p>Product: {rackItemDescription(it)}</p>
                      {it.customerName && <p>Customer: {it.customerName}</p>}
                      {it.customerPOId && <p>Customer PO: {it.customerPOId}</p>}
                      {so && <p>Sales Order: {so}</p>}
                      {it.stockedInDate && <p>Stocked In: {it.stockedInDate}</p>}
                    </div>
                  </div>
                );
              })()}
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1">Reason</label>
                <input
                  type="text"
                  className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  value={stockOutReason}
                  onChange={(e) => setStockOutReason(e.target.value)}
                  placeholder="e.g. Delivered to customer, Transferred, Damaged..."
                />
              </div>
              <Button
                variant="destructive"
                className="w-full"
                disabled={!stockOutTarget || !stockOutReason || actionLoading}
                onClick={handleStockOut}
              >
                {actionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpFromLine className="h-4 w-4" />}
                Confirm Stock Out
              </Button>
            </CardContent>
          </Card>

          {/* Recent Movements */}
          <div className="lg:col-span-2">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2">
                  <History className="h-5 w-5 text-[#6B5C32]" />
                  Recent Movements
                </CardTitle>
              </CardHeader>
              <CardContent>
                <MovementTable movements={movements.slice(0, 20)} />
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* ===== TAB 3: Movement History ===== */}
      {activeTab === "history" && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <CardTitle className="flex items-center gap-2">
                <History className="h-5 w-5 text-[#6B5C32]" />
                Full Movement History
              </CardTitle>
              <div className="flex flex-wrap gap-2 items-center">
                <select
                  className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  value={historyType}
                  onChange={(e) => setHistoryType(e.target.value)}
                >
                  <option value="">All Types</option>
                  <option value="STOCK_IN">Stock In</option>
                  <option value="STOCK_OUT">Stock Out</option>
                  <option value="TRANSFER">Transfer</option>
                </select>
                <input
                  type="date"
                  className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  value={historyFrom}
                  onChange={(e) => setHistoryFrom(e.target.value)}
                  placeholder="From"
                />
                <input
                  type="date"
                  className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  value={historyTo}
                  onChange={(e) => setHistoryTo(e.target.value)}
                  placeholder="To"
                />
                {(historyType || historyFrom || historyTo) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { setHistoryType(""); setHistoryFrom(""); setHistoryTo(""); }}
                  >
                    Clear Filters
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <MovementTable movements={movements} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------- Movement Table Component ----------
function MovementTable({ movements }: { movements: StockMovement[] }) {
  // Stock-movement history grows without bound — window the rendering so a
  // big warehouse log doesn't mount thousands of rows at once.
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: movements.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 41,
    overscan: 12,
  });

  if (movements.length === 0) {
    return <p className="text-sm text-[#6B7280] text-center py-8">No movements found.</p>;
  }

  return (
    <div className="rounded-md border border-[#E2DDD8] overflow-hidden">
      <div
        ref={scrollRef}
        className="overflow-auto"
        style={{ maxHeight: "calc(100vh - 320px)" }}
      >
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
              <th className="h-10 px-4 text-left font-medium text-[#374151]">Date</th>
              <th className="h-10 px-4 text-left font-medium text-[#374151]">Type</th>
              <th className="h-10 px-4 text-left font-medium text-[#374151]">Rack</th>
              <th className="h-10 px-4 text-left font-medium text-[#374151]">Document</th>
              <th className="h-10 px-4 text-left font-medium text-[#374151]">Product</th>
              <th className="h-10 px-4 text-left font-medium text-[#374151]">Qty</th>
              <th className="h-10 px-4 text-left font-medium text-[#374151]">Reason</th>
              <th className="h-10 px-4 text-left font-medium text-[#374151]">Performed By</th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              const vItems = rowVirtualizer.getVirtualItems();
              const padTop = vItems.length > 0 ? vItems[0].start : 0;
              const padBottom =
                vItems.length > 0
                  ? rowVirtualizer.getTotalSize() - vItems[vItems.length - 1].end
                  : 0;
              return (
                <>
                  {padTop > 0 && (
                    <tr aria-hidden="true">
                      <td colSpan={8} style={{ height: padTop, padding: 0, border: 0 }} />
                    </tr>
                  )}
                  {vItems.map((vi) => {
                    const m = movements[vi.index];
                    if (!m) return null;
                    return (
              <tr key={m.id} data-index={vi.index} ref={rowVirtualizer.measureElement} className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7] transition-colors">
                <td className="h-10 px-4 text-[#4B5563] whitespace-nowrap">
                  {new Date(m.createdAt).toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" })}
                </td>
                <td className="h-10 px-4">
                  <Badge
                    className={
                      m.type === "STOCK_IN"
                        ? "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]"
                        : m.type === "STOCK_OUT"
                        ? "bg-[#F9E1DA] text-[#9A3A2D] border-[#E8B2A1]"
                        : "bg-[#E0EDF0] text-[#3E6570] border-[#A8CAD2]"
                    }
                  >
                    {m.type === "STOCK_IN" ? "IN" : m.type === "STOCK_OUT" ? "OUT" : "TRANSFER"}
                  </Badge>
                </td>
                <td className="h-10 px-4 font-medium text-[#1F1D1B]">{m.rackLabel}</td>
                <td className="h-10 px-4 whitespace-nowrap">
                  {(() => {
                    // docRef is the server's best single document token:
                    // reason-extracted DO/DR/GRN first (so DO dispatches show
                    // their DO no), else PO no, else SO no. Show it as the
                    // primary value; surface a distinct PO/SO as a secondary
                    // line only when it adds info beyond docRef.
                    const primary = m.docRef || m.poNo || m.salesOrderNo || "";
                    if (!primary) return <span className="text-[#9CA3AF]">—</span>;
                    const secondary =
                      m.poNo && m.poNo !== primary
                        ? m.poNo
                        : m.salesOrderNo && m.salesOrderNo !== primary
                        ? m.salesOrderNo
                        : "";
                    return (
                      <div className="flex flex-col leading-tight">
                        <span className="text-[#1F1D1B] font-medium">{primary}</span>
                        {secondary && <span className="text-[11px] text-[#6B7280]">{secondary}</span>}
                      </div>
                    );
                  })()}
                </td>
                <td className="h-10 px-4 text-[#4B5563]">{m.productName}</td>
                <td className="h-10 px-4 text-[#4B5563]">{m.quantity}</td>
                <td className="h-10 px-4 text-[#4B5563] max-w-[200px] truncate">{m.reason.replace(/\bDO (DO-)/g, "$1")}</td>
                <td className="h-10 px-4 text-[#4B5563]">{m.performedBy}</td>
              </tr>
                    );
                  })}
                  {padBottom > 0 && (
                    <tr aria-hidden="true">
                      <td colSpan={8} style={{ height: padBottom, padding: 0, border: 0 }} />
                    </tr>
                  )}
                </>
              );
            })()}
          </tbody>
        </table>
      </div>
    </div>
  );
}
