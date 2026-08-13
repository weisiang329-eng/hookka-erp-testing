// ===========================================================================
// WarehouseScreen — the custom L1 Warehouse screen.
//
// The new design (erp-redesign-new) promotes Warehouse from the generic list
// engine to a bespoke screen with three sub-tabs:
//   • Rack Overview — Item-QR / All-rack-QR / Refresh actions, Total/Occupied
//     stat cards, and a card per rack (fill bar + View items / Rack QR).
//   • Stock In/Out  — a Stock-In form (completed PO chip + rack chip + notes →
//     Confirm Stock In) and a Stock-Out form (occupied-rack chip + reason →
//     Confirm Stock Out), plus a Recent Movements list.
//   • Movement      — All / Stock In / Stock Out filter chips + a movement
//     history list.
//
// EVERYTHING is wired to REAL endpoints (no fabricated data):
//   • racks      → GET  /api/warehouse                  (data[] + summary)
//   • movements  → GET  /api/warehouse/movements?type=  (data[])
//   • stock in   → POST /api/warehouse/movements {type:"STOCK_IN", ...}
//   • stock out  → POST /api/warehouse/movements {type:"STOCK_OUT", ...}
//   • item-QR    → GET  /api/inventory (finishedProducts) for the FG code list
// QR values reuse the shared desktop scheme (rackScanUrl / itemQrValue) so a
// phone-generated sticker scans identically to a desktop one.
//
// ADDITIVE: a new screen under src/pages/m/. Replaces the generic warehouse
// list ONLY at the /m/warehouse route (the rack DETAIL route is unchanged and
// still served by the config-driven DocumentDetailScreen).
// ===========================================================================
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  QrCode,
  Download,
  RefreshCw,
  ArrowDownToLine,
  ArrowUpFromLine,
  History,
  Eye,
  CheckCircle2,
  Search,
} from "lucide-react";
import { useCachedJson } from "@/lib/cached-fetch";
import { useDebounced } from "../lib/use-debounced";
import {
  getQRCodeDataURL,
  rackScanUrl,
  itemQrValue,
} from "@/lib/qr-utils";
import { MobileHeader, MobileCard, StatusPill, SubTabs } from "../components";
import { QrModal, type QrChoice } from "../components/QrModal";
import { M } from "../theme";
import { resolveStatus, PAYMENT_STATUS_MAP, str, num } from "../config/helpers";
import { mutateJson, refreshList } from "../config/mutate";

// ---- API response shapes (subset of routes/warehouse.ts output) ----
type RackItem = { productName?: string; productCode?: string };
type Rack = {
  id: string;
  rack: string;
  position?: string;
  status: string; // EMPTY | OCCUPIED | RESERVED
  items?: RackItem[];
  productName?: string;
  productCode?: string;
  customerName?: string;
  zone?: string;
};
type WarehouseResp = {
  success?: boolean;
  data?: Rack[];
  summary?: { total?: number; occupied?: number; empty?: number };
};
type Movement = {
  id: string;
  type: string; // STOCK_IN | STOCK_OUT | TRANSFER
  rackLabel?: string;
  productName?: string;
  productCode?: string;
  quantity?: number;
  reason?: string;
  performedBy?: string;
  createdAt?: string;
  docRef?: string;
};
type MovementsResp = { success?: boolean; data?: Movement[] };
type InventoryResp = {
  success?: boolean;
  data?: { finishedProducts?: { code?: string; name?: string }[] };
};

const RACK_STATUS_MAP = {
  EMPTY: PAYMENT_STATUS_MAP.ACTIVE,
  OCCUPIED: PAYMENT_STATUS_MAP.SUBMITTED,
  RESERVED: PAYMENT_STATUS_MAP.PARTIAL,
};

const TABS = [
  { key: "rack", label: "Rack Overview" },
  { key: "io", label: "Stock In/Out" },
  { key: "move", label: "Movement" },
];

function rackLabel(r: Rack): string {
  return [str(r, "rack"), str(r, "position")].filter(Boolean).join("-") || str(r, "rack");
}
function rackProduct(r: Rack): string {
  const first = Array.isArray(r.items) && r.items.length ? r.items[0] : undefined;
  return (
    str((first ?? {}) as Record<string, unknown>, "productName", "productCode") ||
    str(r, "productName", "productCode") ||
    "Empty rack"
  );
}

export function WarehouseScreen() {
  const navigate = useNavigate();
  const [tab, setTab] = useState("rack");

  const { data: whResp, refresh } = useCachedJson<WarehouseResp>("/api/warehouse");
  const racks = useMemo(() => {
    const list = whResp?.data ?? [];
    // Natural/numeric sort so Rack 2 comes before Rack 10 (owner 2026-06-28:
    // racks were showing lexically 1, 10, 11, 2…). Sorts whether the field is
    // "rack" ("1"/"10") or a "Rack 1" name — numeric localeCompare handles both.
    return [...list].sort((a, b) =>
      str(a, "rack", "name", "rackName", "code", "label").localeCompare(
        str(b, "rack", "name", "rackName", "code", "label"),
        undefined,
        { numeric: true, sensitivity: "base" },
      ),
    );
  }, [whResp]);
  const summary = whResp?.summary;
  const total = summary?.total ?? racks.length;
  const occupied =
    summary?.occupied ?? racks.filter((r) => str(r, "status") === "OCCUPIED").length;

  // QR modal state (rack QR / item QR / all-rack composite).
  const [qr, setQr] = useState<{
    title: string;
    choices: QrChoice[];
    downloadName?: string;
  } | null>(null);

  // Item-QR target list — real finished-good codes.
  // perf 2026-08-13 (BUG-2026-08-13-021): `?buckets=finishedProducts` — only
  // that bucket is read (and then only its first 24 rows), so the RM and WIP
  // buckets no longer ride along on a factory phone.
  const { data: invResp } = useCachedJson<InventoryResp>("/api/inventory?buckets=finishedProducts");
  const fgItems = invResp?.data?.finishedProducts ?? [];

  const openRackQr = (r: Rack) => {
    const label = rackLabel(r);
    setQr({
      title: `Rack QR · ${label}`,
      downloadName: `rack-${label}`,
      choices: [{ label, code: label, value: rackScanUrl(r.id) }],
    });
  };

  const openItemQr = () => {
    const choices: QrChoice[] = fgItems
      .filter((it) => it.code)
      .slice(0, 24)
      .map((it) => ({
        label: it.name || (it.code as string),
        code: it.code as string,
        value: itemQrValue(it.name || (it.code as string), it.code),
      }));
    if (choices.length === 0) {
      setToast({ kind: "err", text: "No finished goods to encode yet." });
      return;
    }
    setQr({ title: "Item QR code", choices });
  };

  // "All rack QR" → composite PNG sheet of every rack's scan QR.
  const [allBusy, setAllBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  const downloadAllRackQr = async () => {
    if (allBusy) return;
    if (racks.length === 0) {
      setToast({ kind: "err", text: "No racks to export." });
      return;
    }
    setAllBusy(true);
    try {
      // Generate every rack QR locally first (no network), then tile onto one
      // canvas — same mechanic as the desktop "Download all rack QRs".
      const tiles = await Promise.all(
        racks.map(async (r) => ({
          label: rackLabel(r),
          url: await getQRCodeDataURL(rackScanUrl(r.id), 600).catch(() => null),
        })),
      );
      const imgs = await Promise.all(
        tiles.map(
          (t) =>
            new Promise<{ label: string; img: HTMLImageElement | null }>(
              (resolve) => {
                if (!t.url) return resolve({ label: t.label, img: null });
                const im = new Image();
                im.onload = () => resolve({ label: t.label, img: im });
                im.onerror = () => resolve({ label: t.label, img: null });
                im.src = t.url;
              },
            ),
        ),
      );
      const cols = 2;
      const cw = 240;
      const ch = 300;
      const padX = 30;
      const padY = 92;
      const gap = 24;
      const rows = Math.ceil(imgs.length / cols);
      const W = padX * 2 + cols * cw + (cols - 1) * gap;
      const H = padY + rows * (ch + gap) + 10;
      const cv = document.createElement("canvas");
      cv.width = W;
      cv.height = H;
      const ctx = cv.getContext("2d");
      if (!ctx) throw new Error("canvas");
      ctx.fillStyle = M.paper;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = M.raisin;
      ctx.font = "bold 30px system-ui, sans-serif";
      ctx.fillText("Hookka · Rack QR Codes", padX, 50);
      ctx.fillStyle = M.muted;
      ctx.font = "15px system-ui, sans-serif";
      ctx.fillText("Warehouse Main", padX, 76);
      imgs.forEach((t, i) => {
        const cx = padX + (i % cols) * (cw + gap);
        const cy = padY + Math.floor(i / cols) * (ch + gap);
        ctx.fillStyle = M.card;
        ctx.fillRect(cx, cy, cw, ch);
        ctx.strokeStyle = M.border;
        ctx.lineWidth = 1;
        ctx.strokeRect(cx, cy, cw, ch);
        if (t.img) ctx.drawImage(t.img, cx + (cw - 184) / 2, cy + 26, 184, 184);
        ctx.textAlign = "center";
        ctx.fillStyle = M.raisin;
        ctx.font = "bold 23px system-ui, sans-serif";
        ctx.fillText(t.label, cx + cw / 2, cy + 26 + 184 + 36);
        ctx.textAlign = "left";
      });
      const a = document.createElement("a");
      a.href = cv.toDataURL("image/png");
      a.download = "hookka-rack-qr-codes.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setToast({ kind: "ok", text: `Downloaded ${racks.length} rack QR codes` });
    } catch {
      setToast({ kind: "err", text: "Couldn’t build the QR sheet." });
    } finally {
      setAllBusy(false);
    }
  };

  const showToast = (t: { kind: "ok" | "err"; text: string }) => {
    setToast(t);
    window.setTimeout(() => setToast(null), 2400);
  };

  return (
    <>
      <MobileHeader title="Warehouse" onBack={() => navigate(-1)} />
      <SubTabs tabs={TABS} active={tab} onChange={setTab} />

      <div style={{ padding: "12px 18px 24px" }}>
        {toast ? (
          <div
            onClick={() => setToast(null)}
            style={{
              background: M.raisin,
              color: "#fff",
              borderRadius: 13,
              padding: "11px 15px",
              marginBottom: 12,
              display: "flex",
              alignItems: "center",
              gap: 9,
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            <CheckCircle2
              size={17}
              strokeWidth={2}
              color={toast.kind === "ok" ? "#C6DBA8" : "#E8B2A1"}
            />
            {toast.text}
          </div>
        ) : null}

        {tab === "rack" ? (
          <RackOverview
            racks={racks}
            total={total}
            occupied={occupied}
            allBusy={allBusy}
            onItemQr={openItemQr}
            onAllQr={downloadAllRackQr}
            onRefresh={() => {
              refresh();
              showToast({ kind: "ok", text: "Refreshed · live data synced" });
            }}
            onView={(r) => navigate(`/m/warehouse/${encodeURIComponent(r.id)}`)}
            onRackQr={openRackQr}
          />
        ) : null}

        {tab === "io" ? (
          <StockInOut racks={racks} onDone={showToast} />
        ) : null}

        {tab === "move" ? <MovementHistory /> : null}
      </div>

      {qr ? (
        <QrModal
          open
          onClose={() => setQr(null)}
          title={qr.title}
          choices={qr.choices}
          downloadName={qr.downloadName}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// RACK OVERVIEW
// ---------------------------------------------------------------------------
function RackOverview({
  racks,
  total,
  occupied,
  allBusy,
  onItemQr,
  onAllQr,
  onRefresh,
  onView,
  onRackQr,
}: {
  racks: Rack[];
  total: number;
  occupied: number;
  allBusy: boolean;
  onItemQr: () => void;
  onAllQr: () => void;
  onRefresh: () => void;
  onView: (r: Rack) => void;
  onRackQr: (r: Rack) => void;
}) {
  // Rack search — scans the rack no / zone AND EVERY item inside the rack
  // (product · customer · PO · SO · SKU), so searching any stocked item finds
  // the rack that holds it (owner 2026-07-02: "要跟著第三張照片那樣才 search 到東西"
  // — the rack's "In this rack now" items, not just its first/primary product).
  const [q, setQ] = useState("");
  const ql = useDebounced(q).trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!ql) return racks;
    return racks.filter((r) => {
      const items = Array.isArray(r.items)
        ? (r.items as Record<string, unknown>[])
        : [];
      const itemHay = items
        .map((it) =>
          [
            str(it, "productName"),
            str(it, "productCode", "code", "sku"),
            str(it, "customerName"),
            // The customer PO on a rack item is `customerPOId` (routes/warehouse.ts
            // RackItemApi) — the old search looked for poNo/poNumber, which the
            // item never carries, so "search by PO" always missed.
            str(it, "customerPOId", "poNo", "poNumber"),
            // Our own SO number (companySOId, e.g. "SO-2607-062") — joined onto
            // rack items server-side so a rack can be found by Company SOID
            // (owner 2026-07-11).
            str(it, "companySOId", "salesOrderNo"),
            str(it, "sizeLabel"),
          ].join(" "),
        )
        .join(" ");
      return [rackLabel(r), rackProduct(r), str(r, "customerName"), str(r, "zone"), itemHay]
        .join(" ")
        .toLowerCase()
        .includes(ql);
    });
  }, [racks, ql]);
  return (
    <>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <ActionBtn icon={<QrCode size={17} strokeWidth={1.75} color={M.taupe} />} label="Item QR" onClick={onItemQr} />
        <ActionBtn
          icon={<Download size={17} strokeWidth={1.75} color={M.taupe} />}
          label={allBusy ? "Building…" : "All rack QR"}
          onClick={onAllQr}
        />
        <button
          onClick={onRefresh}
          aria-label="Refresh"
          style={{
            width: 44,
            height: 44,
            border: `1px solid ${M.hairline}`,
            background: M.card,
            borderRadius: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flex: "none",
            cursor: "pointer",
          }}
        >
          <RefreshCw size={17} strokeWidth={1.75} color={M.taupe} />
        </button>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <StatCard value={total} label="Total racks" valueColor={M.raisin} />
        <StatCard value={occupied} label="Occupied" valueColor={M.taupe} />
      </div>

      {/* Rack search — spec §Search (present on every list). */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "11px 13px",
          backgroundColor: M.card,
          border: `1px solid ${M.hairline}`,
          borderRadius: 12,
          marginBottom: 14,
        }}
      >
        <Search size={18} strokeWidth={1.75} color={M.faint} />
        <input
          value={q}
          placeholder="Search rack / product / customer…"
          onChange={(e) => setQ(e.target.value)}
          style={{
            flex: 1,
            minWidth: 0,
            border: "none",
            outline: "none",
            background: "transparent",
            fontSize: 14,
            color: M.raisin,
          }}
        />
      </div>

      {filtered.length === 0 ? (
        <MobileCard radius={16} style={{ padding: 20 }}>
          <div style={{ color: M.muted, fontSize: 13, textAlign: "center" }}>
            {ql ? "No racks match your search." : "No racks configured."}
          </div>
        </MobileCard>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
          {filtered.map((r) => {
            const isOcc = str(r, "status") === "OCCUPIED";
            const itemCount = Array.isArray(r.items) ? r.items.length : isOcc ? 1 : 0;
            const fill = isOcc ? Math.min(100, (itemCount / 8) * 100) : 0;
            const st = resolveStatus(str(r, "status"), RACK_STATUS_MAP);
            const label = rackLabel(r);
            return (
              <MobileCard key={r.id} radius={16} style={{ padding: "14px 15px" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 800, color: M.raisin }}>
                    {label}
                  </span>
                  <StatusPill style={st.style} label={st.label} size="sm" />
                </div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: M.ink,
                    marginTop: 8,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {rackProduct(r)}
                </div>
                {str(r, "customerName") ? (
                  <div
                    style={{
                      fontSize: 11.5,
                      color: M.muted,
                      marginTop: 2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {str(r, "customerName")}
                  </div>
                ) : null}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginTop: 11,
                  }}
                >
                  {str(r, "zone") ? (
                    <span style={{ fontSize: 11, color: M.muted, fontWeight: 600 }}>
                      Zone {str(r, "zone")}
                    </span>
                  ) : null}
                  <span
                    style={{
                      flex: 1,
                      height: 6,
                      background: "#F0EBE0",
                      borderRadius: 4,
                      overflow: "hidden",
                    }}
                  >
                    <span
                      style={{
                        display: "block",
                        width: `${fill}%`,
                        height: "100%",
                        background: isOcc ? M.taupe : M.hairline,
                        borderRadius: 4,
                      }}
                    />
                  </span>
                  <span style={{ fontSize: 11, color: M.ink, fontWeight: 700 }}>
                    {itemCount} / 8
                  </span>
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    marginTop: 12,
                    paddingTop: 12,
                    borderTop: `1px solid ${M.divider}`,
                  }}
                >
                  <RowBtn
                    icon={<Eye size={15} strokeWidth={1.75} color={M.taupe} />}
                    label="View items"
                    onClick={() => onView(r)}
                  />
                  <RowBtn
                    icon={<QrCode size={15} strokeWidth={1.75} color={M.taupe} />}
                    label="Rack QR"
                    onClick={() => onRackQr(r)}
                  />
                </div>
              </MobileCard>
            );
          })}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// STOCK IN / OUT
// ---------------------------------------------------------------------------
function StockInOut({
  racks,
  onDone,
}: {
  racks: Rack[];
  onDone: (t: { kind: "ok" | "err"; text: string }) => void;
}) {
  const emptyOrAny = racks; // any rack is a valid stock-in target
  const occupiedRacks = racks.filter((r) => str(r, "status") === "OCCUPIED");

  // Stock-In form.
  const [inRack, setInRack] = useState<string>("");
  const [inProduct, setInProduct] = useState("");
  const [inNotes, setInNotes] = useState("");
  const [inBusy, setInBusy] = useState(false);

  // Stock-Out form.
  const [outRack, setOutRack] = useState<string>("");
  const [outReason, setOutReason] = useState("");
  const [outBusy, setOutBusy] = useState(false);

  const { data: movResp, refresh: refreshMov } =
    useCachedJson<MovementsResp>("/api/warehouse/movements");
  const recent = (movResp?.data ?? []).slice(0, 6);

  const canIn = !!(inRack && inProduct.trim());
  const canOut = !!(outRack && outReason.trim());

  const submitIn = async () => {
    if (!canIn || inBusy) return;
    setInBusy(true);
    const rack = racks.find((r) => r.id === inRack);
    const res = await mutateJson("/api/warehouse/movements", "POST", {
      type: "STOCK_IN",
      rackLocationId: inRack,
      rackLabel: rack ? rackLabel(rack) : inRack,
      productCode: inProduct.trim(),
      productName: inProduct.trim(),
      quantity: 1,
      reason: inNotes.trim() || "Stock in",
    });
    setInBusy(false);
    if (res.ok) {
      refreshList("/api/warehouse");
      refreshMov();
      setInRack("");
      setInProduct("");
      setInNotes("");
      onDone({ kind: "ok", text: "Stock in recorded" });
    } else {
      onDone({ kind: "err", text: res.error || "Stock in failed" });
    }
  };

  const submitOut = async () => {
    if (!canOut || outBusy) return;
    setOutBusy(true);
    const rack = racks.find((r) => r.id === outRack);
    const product =
      rack && Array.isArray(rack.items) && rack.items.length
        ? str(rack.items[0] as Record<string, unknown>, "productName", "productCode")
        : rack
          ? rackProduct(rack)
          : "Item";
    const res = await mutateJson("/api/warehouse/movements", "POST", {
      type: "STOCK_OUT",
      rackLocationId: outRack,
      rackLabel: rack ? rackLabel(rack) : outRack,
      productCode: product || "Item",
      productName: product || "Item",
      quantity: 1,
      reason: outReason.trim(),
    });
    setOutBusy(false);
    if (res.ok) {
      refreshList("/api/warehouse");
      refreshMov();
      setOutRack("");
      setOutReason("");
      onDone({ kind: "ok", text: "Stock out recorded" });
    } else {
      onDone({ kind: "err", text: res.error || "Stock out failed" });
    }
  };

  return (
    <>
      {/* ---- Stock In ---- */}
      <MobileCard radius={18} style={{ padding: 17, marginBottom: 13 }}>
        <FormHeading
          icon={<ArrowDownToLine size={19} strokeWidth={1.75} color="#4F7C3A" />}
          label="Stock In"
        />
        <FieldLabel>Rack Position</FieldLabel>
        <ChipRow
          options={emptyOrAny.map((r) => ({ id: r.id, label: rackLabel(r) }))}
          selected={inRack}
          onSelect={setInRack}
          empty="No racks available"
        />
        <FieldLabel>
          Product <span style={{ color: M.muted, fontWeight: 500 }}>(code or name)</span>
        </FieldLabel>
        <TextField
          value={inProduct}
          onChange={setInProduct}
          placeholder="Finished good code / name…"
        />
        <FieldLabel>
          Notes <span style={{ color: M.muted, fontWeight: 500 }}>(optional)</span>
        </FieldLabel>
        <TextField value={inNotes} onChange={setInNotes} placeholder="Additional notes…" />
        <ConfirmBtn
          label={inBusy ? "Working…" : "Confirm Stock In"}
          icon={<ArrowDownToLine size={17} strokeWidth={1.75} color="#fff" />}
          enabled={canIn && !inBusy}
          bg={canIn ? "#4F7C3A" : "#B7C4A6"}
          onClick={submitIn}
        />
      </MobileCard>

      {/* ---- Stock Out ---- */}
      <MobileCard radius={18} style={{ padding: 17, marginBottom: 13 }}>
        <FormHeading
          icon={<ArrowUpFromLine size={19} strokeWidth={1.75} color="#9A3A2D" />}
          label="Stock Out"
        />
        <FieldLabel>Select Occupied Rack</FieldLabel>
        <ChipRow
          options={occupiedRacks.map((r) => ({ id: r.id, label: rackLabel(r) }))}
          selected={outRack}
          onSelect={setOutRack}
          empty="No occupied racks"
        />
        <FieldLabel>Reason</FieldLabel>
        <TextField
          value={outReason}
          onChange={setOutReason}
          placeholder="Delivered, transferred, damaged…"
        />
        <ConfirmBtn
          label={outBusy ? "Working…" : "Confirm Stock Out"}
          icon={<ArrowUpFromLine size={17} strokeWidth={1.75} color="#fff" />}
          enabled={canOut && !outBusy}
          bg={canOut ? "#9A3A2D" : "#E0B6AC"}
          onClick={submitOut}
        />
      </MobileCard>

      {/* ---- Recent movements ---- */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          margin: "18px 2px 11px",
        }}
      >
        <History size={17} strokeWidth={1.75} color={M.taupe} />
        <span style={{ fontSize: 15, fontWeight: 800, color: M.raisin }}>
          Recent Movements
        </span>
      </div>
      <MobileCard padded={false} radius={16} style={{ overflow: "hidden" }}>
        {recent.length === 0 ? (
          <div style={{ padding: 16, color: M.muted, fontSize: 13 }}>
            No recent movements.
          </div>
        ) : (
          recent.map((m, i) => <MovementRow key={m.id} m={m} first={i === 0} compact />)
        )}
      </MobileCard>
    </>
  );
}

// ---------------------------------------------------------------------------
// MOVEMENT HISTORY
// ---------------------------------------------------------------------------
function MovementHistory() {
  const [filter, setFilter] = useState<"all" | "STOCK_IN" | "STOCK_OUT">("all");
  const url =
    filter === "all"
      ? "/api/warehouse/movements"
      : `/api/warehouse/movements?type=${filter}`;
  const { data } = useCachedJson<MovementsResp>(url);
  const moves = data?.data ?? [];

  const chips: { key: typeof filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "STOCK_IN", label: "Stock In" },
    { key: "STOCK_OUT", label: "Stock Out" },
  ];

  return (
    <>
      <div style={{ display: "flex", gap: 7, marginBottom: 13 }}>
        {chips.map((c) => {
          const active = filter === c.key;
          return (
            <button
              key={c.key}
              onClick={() => setFilter(c.key)}
              style={{
                padding: "8px 13px",
                borderRadius: 10,
                border: `1px solid ${active ? M.taupe : M.hairline}`,
                background: active ? M.taupe : M.card,
                color: active ? "#fff" : "#6B7280",
                fontSize: 12.5,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {c.label}
            </button>
          );
        })}
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: M.muted,
          fontWeight: 600,
          margin: "0 2px 10px",
        }}
      >
        {moves.length} movements
      </div>
      {moves.length === 0 ? (
        <MobileCard radius={14} style={{ padding: 18 }}>
          <div style={{ color: M.muted, fontSize: 13, textAlign: "center" }}>
            No movement history.
          </div>
        </MobileCard>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {moves.map((m) => (
            <MovementCard key={m.id} m={m} />
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared small pieces
// ---------------------------------------------------------------------------
function dateShort(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

function MovementRow({
  m,
  first,
}: {
  m: Movement;
  first?: boolean;
  /** Reserved for a denser variant; layout is identical today. */
  compact?: boolean;
}) {
  const isIn = m.type === "STOCK_IN";
  const tileBg = isIn ? "#EEF3E4" : "#F9E1DA";
  const tileFg = isIn ? "#4F7C3A" : "#9A3A2D";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
        borderTop: first ? "none" : `1px solid ${M.divider}`,
      }}
    >
      <span
        style={{
          width: 34,
          height: 34,
          borderRadius: 10,
          background: tileBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flex: "none",
        }}
      >
        {isIn ? (
          <ArrowDownToLine size={16} strokeWidth={1.75} color={tileFg} />
        ) : (
          <ArrowUpFromLine size={16} strokeWidth={1.75} color={tileFg} />
        )}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: M.raisin,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {str(m, "productName", "productCode") || "Movement"}
        </div>
        <div
          style={{
            fontSize: 11,
            color: M.muted,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {[str(m, "docRef"), str(m, "rackLabel"), dateShort(m.createdAt)]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
      <div style={{ textAlign: "right", flex: "none" }}>
        <span
          style={{
            display: "inline-flex",
            padding: "2px 9px",
            borderRadius: 7,
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: 0.4,
            background: tileBg,
            color: tileFg,
          }}
        >
          {isIn ? "IN" : "OUT"}
        </span>
        <div style={{ fontSize: 12, fontWeight: 700, color: M.raisin, marginTop: 4 }}>
          ×{num(m, "quantity") || 1}
        </div>
      </div>
    </div>
  );
}

function MovementCard({ m }: { m: Movement }) {
  const isIn = m.type === "STOCK_IN";
  const tileBg = isIn ? "#EEF3E4" : "#F9E1DA";
  const tileFg = isIn ? "#4F7C3A" : "#9A3A2D";
  return (
    <MobileCard radius={14} style={{ padding: "13px 14px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            padding: "2px 9px",
            borderRadius: 7,
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: 0.4,
            background: tileBg,
            color: tileFg,
          }}
        >
          {isIn ? "IN" : m.type === "STOCK_OUT" ? "OUT" : "MOVE"}
        </span>
        <span style={{ fontSize: 11, color: M.muted, fontWeight: 600 }}>
          {dateShort(m.createdAt)}
        </span>
      </div>
      <div
        style={{
          fontSize: 13.5,
          fontWeight: 600,
          color: M.raisin,
          marginTop: 9,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {str(m, "productName", "productCode") || "Movement"}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          marginTop: 11,
          paddingTop: 11,
          borderTop: `1px solid ${M.divider}`,
        }}
      >
        <MovMeta label="Rack" value={str(m, "rackLabel") || "—"} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <MetaCaption>Document</MetaCaption>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: M.taupe,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {str(m, "docRef") || "—"}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <MetaCaption>Qty</MetaCaption>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: M.raisin }}>
            ×{num(m, "quantity") || 1}
          </div>
        </div>
      </div>
      {str(m, "reason") || str(m, "performedBy") ? (
        <div style={{ fontSize: 11, color: M.muted, marginTop: 9 }}>
          {[str(m, "reason"), str(m, "performedBy") ? `by ${str(m, "performedBy")}` : ""]
            .filter(Boolean)
            .join(" · ")}
        </div>
      ) : null}
    </MobileCard>
  );
}

function MovMeta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <MetaCaption>{label}</MetaCaption>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: M.raisin }}>{value}</div>
    </div>
  );
}
function MetaCaption({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 9.5,
        color: "#A89F8D",
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 0.3,
      }}
    >
      {children}
    </div>
  );
}

function ActionBtn({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        height: 44,
        border: `1px solid ${M.hairline}`,
        background: M.card,
        borderRadius: 12,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        fontSize: 12.5,
        fontWeight: 700,
        color: M.ink,
        cursor: "pointer",
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function RowBtn({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        height: 38,
        border: `1px solid ${M.hairline}`,
        background: M.paper,
        borderRadius: 10,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        fontSize: 12.5,
        fontWeight: 700,
        color: M.ink,
        cursor: "pointer",
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function StatCard({
  value,
  label,
  valueColor,
}: {
  value: number;
  label: string;
  valueColor: string;
}) {
  return (
    <MobileCard radius={14} style={{ padding: "13px 15px", flex: 1 }}>
      <div
        style={{
          fontSize: 22,
          fontWeight: 800,
          color: valueColor,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 11.5, color: M.muted, fontWeight: 600 }}>{label}</div>
    </MobileCard>
  );
}

function FormHeading({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}
    >
      {icon}
      <span style={{ fontSize: 16, fontWeight: 800, color: M.raisin }}>{label}</span>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 700,
        color: M.ink,
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function TextField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: "100%",
        height: 42,
        border: `1px solid ${M.hairline}`,
        borderRadius: 11,
        padding: "0 13px",
        fontSize: 13.5,
        color: M.raisin,
        background: M.paper,
        marginBottom: 15,
        outline: "none",
        fontFamily: "inherit",
        boxSizing: "border-box",
      }}
    />
  );
}

function ChipRow({
  options,
  selected,
  onSelect,
  empty,
}: {
  options: { id: string; label: string }[];
  selected: string;
  onSelect: (id: string) => void;
  empty: string;
}) {
  if (options.length === 0) {
    return (
      <div style={{ fontSize: 12.5, color: M.muted, marginBottom: 14 }}>{empty}</div>
    );
  }
  return (
    <div
      style={{
        display: "flex",
        gap: 7,
        overflowX: "auto",
        paddingBottom: 4,
        marginBottom: 14,
        scrollbarWidth: "none",
      }}
    >
      {options.map((o) => {
        const active = selected === o.id;
        return (
          <button
            key={o.id}
            onClick={() => onSelect(o.id)}
            style={{
              flexShrink: 0,
              padding: "8px 13px",
              borderRadius: 10,
              border: `1px solid ${active ? M.taupe : M.hairline}`,
              background: active ? M.taupe : M.card,
              color: active ? "#fff" : "#6B7280",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function ConfirmBtn({
  label,
  icon,
  enabled,
  bg,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  enabled: boolean;
  bg: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={enabled ? onClick : undefined}
      disabled={!enabled}
      style={{
        width: "100%",
        height: 48,
        border: "none",
        borderRadius: 13,
        fontSize: 14.5,
        fontWeight: 700,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        color: "#fff",
        cursor: enabled ? "pointer" : "default",
        background: bg,
        fontFamily: "inherit",
      }}
    >
      {icon}
      {label}
    </button>
  );
}
