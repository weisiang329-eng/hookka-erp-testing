import jsPDF from "jspdf";
import autoTable, { type RowInput } from "jspdf-autotable";
import type { DeliveryOrder } from "@/lib/mock-data";
import { COMPANY } from "@/lib/constants";
import { fmtDate, drawLetterhead } from "@/lib/pdf-utils";
// Shared DO line ordering (customer PO ascending, blanks last, then SO).
// Lives in its own dependency-free module so the page can import the same
// comparator without pulling jsPDF into the page bundle.
import { compareDoLinesByCustomerPO } from "@/lib/do-item-order";
// DO-document rack line: per-component rack groups, NO label prefix, joined by
// " · " (owner's spec). Shares formatRacksCompact's dedup + numeric sort.
import { formatComponentRacksNoLabel } from "@/lib/rack-format";

// Read-only print-extras from GET /api/delivery-orders/:id/print-extras.
// All optional — the PDF still renders if not supplied.
export type DOPrintExtras = {
  customerSO?: string;
  customerRef?: string;
  // Delivery-status QR (data URL, rendered client-side from the DO's public
  // scan token — see src/lib/do-qr.ts). PRINT FLOWS ONLY: the QR can advance
  // the DO's status without login, so the customer-email PDF path
  // (sendCustomerNotice → generateDoPdfBase64) must never set this.
  qrDataUrl?: string;
  // Deliver-To resolved from the DO's hub (a customer can have many hubs,
  // each with its own address — the printed address must follow the hub).
  deliverTo?: string;
  deliveryAddress?: string;
  hubState?: string;
  hubContactName?: string;
  hubContactPhone?: string;
  items?: Record<
    string,
    {
      itemCategory?: string | null; // SOFA / BEDFRAME / ACCESSORY
      customerPOId?: string | null; // customer's PO no. for this line
      customerSO?: string | null; // customer's own SO no. for this line
      customerRef?: string | null; // customer's ERP reference for this line
      salesOrderNo?: string | null; // our SO no. for this line
      specialOrder?: string | null; // e.g. "Headboard Only" / "DIVAN CURVE"
      pieces?: string | null; // BOM set composition, e.g. "1 HB + 2 DIVAN"
      // Partial-repair note, e.g. "Repair: HB only". Set ONLY when the line's
      // production order carries a component-level repair scope, so the DO
      // prints just the repaired compartment(s) and says so. English (the DO
      // PDF font has no CJK glyphs). null/absent on a normal line.
      repairNote?: string | null;
      gapInches: number | null;
      divanHeightInches: number | null;
      legHeightInches: number | null;
      totalHeightInches: number | null;
      // Packing completion date — set only when EVERY PACKING job card of
      // the line's PO is done (matches the on-screen Packed column);
      // null/absent = not fully packed yet.
      packedDate?: string | null;
      // Warehouse rack per component type, racks pre-sorted numerically,
      // e.g. [{ label: "HB", racks: ["Rack 3"] },
      //       { label: "DIVAN", racks: ["Rack 3", "Rack 20"] }].
      componentRacks?: { label: string; racks: string[] }[];
    }
  >;
};

// The minimal per-item config the build-spec line (`describe`) needs. Exported
// so the CN PDF (generate-cn-pdf.ts) can call the SAME describe() and the
// fabric / DIVAN+LEG+GAP+T.Heights / special line can't drift between the two
// documents. The full DO per-item extra (DOPrintExtras["items"][string]) is a
// structural superset of this, so the DO call sites pass it unchanged.
export type BuildSpecExtra = {
  itemCategory?: string | null;
  specialOrder?: string | null;
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  totalHeightInches: number | null;
};

// Greyscale only — colour ink is expensive on the floor printer, so the
// whole document is black + greys (Wei Siang).
const INK: [number, number, number] = [17, 17, 17];
const RULE: [number, number, number] = [0, 0, 0];
const HAIR: [number, number, number] = [120, 120, 120];
const BAND: [number, number, number] = [232, 232, 232];
const FAINT: [number, number, number] = [110, 110, 110];

const num = (v?: number | null) =>
  v == null || Number(v) === 0 ? null : `${v}"`;

// "2 DIVAN + 1 HB" -> { text: "1 HB  +  2 DIVAN", total: 3 } (HB first).
// Exported so the CN PDF renders the identical pieces breakdown (Quantity
// column) — one formatter, no drift between DO and CN.
export function fmtPieces(pieces?: string | null): { text: string; total: number } {
  const parts = String(pieces || "")
    .split(" + ")
    .map((s) => s.trim())
    .filter(Boolean);
  let total = 0;
  const parsed = parts.map((p) => {
    const mm = p.match(/^(\d+)\s+(.+)$/);
    const n = mm ? Number(mm[1]) : 0;
    total += n;
    return { n, lab: mm ? mm[2] : p };
  });
  const rank = (lab: string) => {
    const u = lab.toUpperCase();
    return u === "HB" ? 0 : u === "DIVAN" ? 1 : 2;
  };
  parsed.sort((a, b) => rank(a.lab) - rank(b.lab));
  // Drop the leading count when it's exactly 1 — Wei Siang 2026-05-28: a
  // sofa variant label already starts with a digit ("1A(LHF)"), so "1
  // 1A(LHF)" read like "11A". Show just "1A(LHF)" for single pieces; keep
  // the count for 2+ ("2 1A(LHF)", "2 DIVAN"). `total` still sums the
  // underlying counts so the Total Qty column is unaffected.
  return {
    // Drop the leading "1" ONLY for labels that start with a digit (sofa
    // variants like 1A / 2A / 2S) — there "1 1A(LHF)" reads as "11A". For
    // HB / DIVAN etc. keep the count, so "1 HB" stays "1 HB" (Wei Siang).
    text: parsed
      .map((x) => (x.n === 1 && /^\d/.test(x.lab) ? x.lab : `${x.n} ${x.lab}`))
      .join("  +  "),
    total,
  };
}

// componentRacks -> "HB: Rack 3 · DIVAN: Rack 3, 20" for the packing-list
// manifest. The stored rackingNumber values carry the "Rack " prefix
// themselves (rack_locations catalog: "Rack 1"…"Rack 20"), so strip it per
// value and print it once per group — "Rack 3, 20", never "Rack Rack 3".
// Legacy bare numbers ("3") group the same way; anything else prints raw.
// Exported so the CN PDF prints the identical per-component rack manifest.
export function fmtComponentRacks(
  componentRacks?: { label: string; racks: string[] }[] | null,
): string {
  if (!componentRacks || componentRacks.length === 0) return "";
  const parts: string[] = [];
  for (const cr of componentRacks) {
    const racks = (cr.racks || []).map((r) => String(r).trim()).filter(Boolean);
    if (racks.length === 0) continue;
    const stripped = racks.map((r) => r.replace(/^rack\s*/i, "").trim() || r);
    const groupable =
      racks.some((r) => /^rack\b/i.test(r)) ||
      stripped.every((s) => /^\d+$/.test(s));
    const txt = groupable ? `Rack ${stripped.join(", ")}` : racks.join(", ");
    parts.push(`${cr.label}: ${txt}`);
  }
  return parts.join(" · ");
}

// Tally a set of items into a component map (HB / DIVAN / SOFA / ITEM) from
// their BOM pieces, plus the total piece count. Used for the per-drop and the
// whole-container component subtotals on the packing-list manifest, so the
// loader can count "how many headboards / divans / sofas" at each level.
function tallyComponents(
  items: { id?: string; quantity?: number }[],
  ex?: DOPrintExtras,
): { map: Map<string, number>; pcs: number } {
  const map = new Map<string, number>();
  let pcs = 0;
  for (const it of items) {
    const pieces = ex?.items?.[it.id ?? ""]?.pieces;
    const fp = fmtPieces(pieces);
    pcs += fp.total || Number(it.quantity) || 0;
    if (pieces) {
      for (const part of String(pieces).split(" + ")) {
        const mm = part.trim().match(/^(\d+)\s+(.+)$/);
        if (!mm) continue;
        const raw = mm[2].trim().toUpperCase();
        // HB / DIVAN and the partial-repair part labels (BC / ARM / HR / BASE)
        // keep their OWN manifest subtotal so a repair DO shows the real part;
        // sofa variants, the complete-sofa "Sofa", and accessories roll up
        // under SOFA so a normal manifest stays short.
        const lab =
          raw === "HB" ||
          raw === "DIVAN" ||
          raw === "BC" ||
          raw === "ARM" ||
          raw === "HR" ||
          raw === "BASE"
            ? raw
            : "SOFA";
        map.set(lab, (map.get(lab) || 0) + Number(mm[1]));
      }
    } else {
      map.set("ITEM", (map.get("ITEM") || 0) + (Number(it.quantity) || 0));
    }
  }
  return { map, pcs };
}

function formatComponents(map: Map<string, number>): string {
  const rank = (l: string) => {
    const u = l.toUpperCase();
    return u === "HB"
      ? 0
      : u === "DIVAN"
        ? 1
        : u === "BC"
          ? 2
          : u === "ARM"
            ? 3
            : u === "HR"
              ? 4
              : u === "BASE"
                ? 5
                : u === "SOFA"
                  ? 6
                  : 7;
  };
  return (
    Array.from(map.entries())
      .sort((a, b) => rank(a[0]) - rank(b[0]))
      .map(([l, n]) => `${n} ${l}`)
      .join("  +  ") || "-"
  );
}

// Print order: bedframes first, then the sofa block, then accessories
// (always travel WITH the sofas), then service items grouped at the end.
const catRank = (cat?: string | null): number => {
  const c = (cat || "").toUpperCase();
  if (c === "BEDFRAME") return 0;
  if (c === "SOFA") return 1;
  if (c === "ACCESSORY") return 2;
  if (c === "SERVICE") return 3;
  return 4;
};
const catLabel = (cat?: string | null): string => {
  const c = (cat || "").toUpperCase();
  if (c === "BEDFRAME") return "BEDFRAME";
  if (c === "SOFA") return "SOFA";
  if (c === "ACCESSORY") return "ACCESSORY / ADD-ON";
  if (c === "SERVICE") return "SERVICE";
  return "ITEMS";
};
const uomOf = (cat?: string | null) =>
  (cat || "").toUpperCase() === "ACCESSORY" ? "UNIT" : "SET";

// Stacked Description cell — the standard furniture DO line shape:
//   line 1  product code              e.g. 2008(A)-(K)
//   line 2  product name (w/ size)    e.g. TRION(A) (HB STRAIGHT) BEDFRAME (6FT) (183X190CM)
//   line 3  build spec               BF : PC151-02 / DIVAN 12" + 2" LEG / TH 14"
//                                     SOFA: BO315-21 / 35
// (PO / SO / Reference are their own columns now, not in the description.)
// Exported (and typed on the minimal BuildSpecExtra) so the CN PDF renders the
// SAME stacked code / name / build-spec cell — the fabric / DIVAN+LEG+GAP+
// T.Heights / special line can never drift between DO and CN.
export function describe(
  it: {
    productCode: string;
    productName: string;
    fabricCode: string;
    sizeLabel: string;
  },
  ex: BuildSpecExtra | undefined,
): string {
  const lines: string[] = [];
  if (it.productCode) lines.push(it.productCode);
  if (it.productName) lines.push(it.productName);

  const cat = (ex?.itemCategory || "").toUpperCase();
  const dv = num(ex?.divanHeightInches);
  const lg = num(ex?.legHeightInches);
  const gp = num(ex?.gapInches);
  const th = num(ex?.totalHeightInches);
  const spec: string[] = [];
  if (it.fabricCode) spec.push(it.fabricCode);

  // Treat it as a bedframe-style spec whenever it's tagged BEDFRAME OR it
  // carries a divan / leg / gap / total-height value — so the build spec
  // (D1 / Total H / Mattress Gap) still prints even when itemCategory was
  // never stamped on the order.
  const hasBfSpec = !!(dv || lg || gp || th);
  if (cat === "BEDFRAME" || (cat !== "SOFA" && cat !== "ACCESSORY" && hasBfSpec)) {
    if (dv) spec.push(`DIVAN ${dv}${lg ? ` + ${lg} LEG` : " + NO LEG"}`);
    else if (lg) spec.push(`${lg} LEG`);
    if (gp) spec.push(`GAP ${gp}`);
    if (th) spec.push(`T.Heights ${th}`);
  } else {
    // sofa / accessory — label the seat size so a bare "28" reads as
    // the sofa size, then leg height. NO T.Heights here: total height is a
    // bedframe-only concept (divan + gap + leg); a sofa doesn't have one, so
    // a stray totalHeightInches must not print on sofa lines.
    // — Wei Siang 2026-05-29
    if (it.sizeLabel) spec.push(`Size: ${it.sizeLabel}`);
    if (lg) spec.push(`${lg} LEG`);
  }
  if (ex?.specialOrder && String(ex.specialOrder).trim())
    spec.push(String(ex.specialOrder).trim());
  if (spec.length) lines.push(spec.join(" / "));
  // Piece composition is its own Quantity column now (not in here).
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Delivery Order PDF — A4 PORTRAIT, black & white. The standard furniture
// DO line shape: Item | Description (stacked code / name / spec / (PO)) |
// UOM | Qty. Bedframes / sofas / accessories print as labelled sections.
// Letterhead + reference block + column header repeat on every page.
// ---------------------------------------------------------------------------
// Draws ONE delivery order into an EXISTING jsPDF doc, starting on the
// current page (the table paginates itself; the header reprints per page).
// Footers + "Page X of Y" are NOT applied here — the caller runs
// stampDoFooters() once after all DOs are drawn (so a multi-DO run numbers
// the whole document, not each DO separately). The single-DO entry point
// generateDOPdf() below wraps this.
export function renderDoInto(
  doc: jsPDF,
  order: DeliveryOrder,
  extras?: DOPrintExtras,
  // When set, prints a "PACKING LIST · STOP n / N" tag at the top so each
  // DO in a consolidated packing list is numbered 1, 2, 3…
  opts?: { seq?: number; total?: number },
) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const m = 14;
  const co = COMPANY.HOOKKA;
  const o = order as DeliveryOrder & {
    customerPOId?: string;
    hubName?: string;
    hubState?: string;
    customerState?: string;
    driverPhone?: string;
    vehicleType?: string;
    lorryName?: string;
  };

  const docDate = fmtDate(order.deliveryDate);
  const deliverTo =
    extras?.deliverTo || o.hubName || o.hubState || o.customerState || "";
  const deliveryAddress =
    extras?.deliveryAddress || order.deliveryAddress || "";
  const contactPerson = extras?.hubContactName || order.contactPerson || "";
  const contactPhone = extras?.hubContactPhone || order.contactPhone || "";

  // Driver + lorry dispatch info for the header (operator wants the
  // lorry plate visible, not just the driver name).
  const driverLine = `${order.driverName || "-"}${
    o.driverPhone ? ` (${o.driverPhone})` : ""
  }`;
  const lorryLine =
    [order.vehicleNo, o.vehicleType, o.lorryName]
      .map((s) => (s || "").trim())
      .filter(Boolean)
      .join(" · ") || "-";

  const HEADER_BOTTOM = 72;
  const drawHeader = () => {
    // Consolidated packing list: tag each DO with its stop number (1, 2, 3…).
    if (opts?.seq) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7);
      doc.setTextColor(...FAINT);
      doc.text(
        `PACKING LIST · STOP ${opts.seq}${opts.total ? ` / ${opts.total}` : ""}`,
        pageW - m,
        9.5,
        { align: "right" },
      );
    }
    // --- Shared letterhead (single source of truth across all docs) ---
    drawLetterhead(doc, {
      docTitle: "DELIVERY ORDER",
      docNo: `No. ${order.doNo}`,
      docDate,
      statusText: "C.O.D.",
      companyInfo: {
        name: co.name,
        regNo: co.regNo,
        tin: co.tin,
        address: co.address,
        phone: co.phone,
        email: co.email,
      },
    });

    // --- Reference block ---
    const labelW = 23;
    const lblVal = (
      x: number,
      y: number,
      k: string,
      v: string,
      maxW: number,
    ): number => {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(...FAINT);
      doc.text(k, x, y);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(...INK);
      const lines = doc.splitTextToSize(v || "-", maxW);
      doc.text(lines, x + labelW, y);
      return y + Math.max(1, lines.length) * 4.3 + 0.8;
    };

    const leftX = m;
    const leftMaxW = (pageW - m * 2) * 0.55 - labelW;
    let ly = 38;
    ly = lblVal(leftX, ly, "Customer", order.customerName || "-", leftMaxW);
    ly = lblVal(leftX, ly, "Deliver To", deliverTo || "-", leftMaxW);
    ly = lblVal(leftX, ly, "Address", deliveryAddress || "-", leftMaxW);
    lblVal(
      leftX,
      ly,
      "Contact",
      `${contactPerson || "-"}${contactPhone ? ` (${contactPhone})` : ""}`,
      leftMaxW,
    );

    const rightX = pageW / 2 + 12;
    const rightMaxW = pageW - m - rightX - labelW;
    let ry = 38;
    ry = lblVal(rightX, ry, "DO No.", order.doNo, rightMaxW);
    ry = lblVal(rightX, ry, "Date", docDate, rightMaxW);
    ry = lblVal(rightX, ry, "Driver", driverLine, rightMaxW);
    lblVal(rightX, ry, "Lorry Plate", lorryLine, rightMaxW);

    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.5);
    doc.line(m, HEADER_BOTTOM - 3, pageW - m, HEADER_BOTTOM - 3);
  };

  // Grand totals for the footer row: total sets, the combined piece
  // breakdown across the whole DO (HB first), and total pieces.
  let totalSets = 0;
  let totalPcsAll = 0;
  const grand = new Map<string, number>();
  const grandSeen = new Map<string, number>(); // label → first-seen index
  for (const it of order.items) {
    totalSets += it.quantity;
    const pcs = extras?.items?.[it.id]?.pieces;
    const fp = fmtPieces(pcs);
    totalPcsAll += fp.total || it.quantity;
    if (pcs) {
      for (const part of String(pcs).split(" + ")) {
        const mm = part.trim().match(/^(\d+)\s+(.+)$/);
        if (!mm) continue;
        // Sum each part by its FULL label (Wei Siang 2026-06-16: spell parts
        // out — "2 Headboard + 2 Divan + 1 Back Cushion + 1 Armrest" — no more
        // collapsing every sofa part into "SOFA"). Complete sofas already
        // arrive as "Sofa" from piecesFor, so the footer stays readable; the
        // full breakdown lives on its own full-width row so it can't overflow.
        const lab = mm[2].trim();
        if (!grandSeen.has(lab)) grandSeen.set(lab, grandSeen.size);
        grand.set(lab, (grand.get(lab) || 0) + Number(mm[1]));
      }
    }
  }
  const rankL = (lab: string): number => {
    const u = lab.toUpperCase();
    return u === "HB" ? 0 : u === "DIVAN" ? 1 : u === "SOFA" ? 2 : 3;
  };
  const grandBreakdown =
    Array.from(grand.keys())
      .sort(
        (a, b) =>
          rankL(a) - rankL(b) || (grandSeen.get(a) ?? 0) - (grandSeen.get(b) ?? 0),
      )
      .map((lab) => `${grand.get(lab)} ${lab}`)
      .join("  +  ") || "-";

  // Keep the deliberate category banding (BEDFRAME / SOFA / ACCESSORY /
  // SERVICE — the loader's physical-stacking order) as the OUTERMOST key,
  // then sort WITHIN each band by customer PO ascending (blanks last), then
  // our SO, so identical Customer PO / SO group together on the printed DO.
  // (Display order only — order.items itself is untouched.)
  const ordered = order.items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      const cr =
        catRank(extras?.items?.[a.it.id]?.itemCategory) -
        catRank(extras?.items?.[b.it.id]?.itemCategory);
      if (cr !== 0) return cr;
      const exA = extras?.items?.[a.it.id];
      const exB = extras?.items?.[b.it.id];
      const pc = compareDoLinesByCustomerPO(
        { customerPOId: exA?.customerPOId, salesOrderNo: exA?.salesOrderNo },
        { customerPOId: exB?.customerPOId, salesOrderNo: exB?.salesOrderNo },
      );
      return pc !== 0 ? pc : a.i - b.i;
    })
    .map((x) => x.it);

  const body: RowInput[] = [];
  let lastCat: string | null = null;
  for (const it of ordered) {
    const ex = extras?.items?.[it.id];
    const cat = (ex?.itemCategory || "").toUpperCase();
    if (cat !== lastCat && extras?.items) {
      body.push([
        {
          content: catLabel(cat),
          colSpan: 5,
          styles: {
            fontStyle: "bold",
            fontSize: 8,
            fillColor: BAND,
            textColor: INK,
            halign: "left",
          },
        },
      ]);
      lastCat = cat;
    }
    const fp = fmtPieces(ex?.pieces);
    const qtyTxt = fp.text || uomOf(ex?.itemCategory);
    const totQty = fp.total || it.quantity;
    // Customer order refs go in their OWN leading "Order" column,
    // stacked PO / REF / SO, only the lines that have a value.
    const custSO =
      (ex?.customerSO && String(ex.customerSO).trim()) ||
      (extras?.customerSO && String(extras.customerSO).trim()) ||
      "";
    const custPO = (ex?.customerPOId && String(ex.customerPOId).trim()) || "";
    const custRef =
      (ex?.customerRef && String(ex.customerRef).trim()) ||
      (extras?.customerRef && String(extras.customerRef).trim()) ||
      "";
    // Our own SO no. for this line (a DO can consolidate several SOs). Shown
    // first so the floor can reconcile each line back to its sales order —
    // owner: "DO 要看到我們的 SO ID".
    const ourSO = (ex?.salesOrderNo && String(ex.salesOrderNo).trim()) || "";
    // Always show our SO + all three customer refs (PO / SO / REF) so neither
    // our sales order nor the customer's is ever silently missing — "-" when
    // the order didn't carry one.
    const refLines: string[] = [
      `Our SO: ${ourSO || "-"}`,
      `PO: ${custPO || "-"}`,
      `SO: ${custSO || "-"}`,
      `REF: ${custRef || "-"}`,
    ];
    const desc = describe(
      {
        productCode: it.productCode || "",
        productName: it.productName || "",
        fabricCode: it.fabricCode || "",
        sizeLabel: it.sizeLabel || "",
      },
      ex,
    );
    // Partial-repair lines append a note ("Repair: HB only") under the spec so
    // the driver/customer sees this DO ships just the repaired compartment —
    // the Quantity column above already shows the filtered pieces ("1 HB").
    const descCell = ex?.repairNote
      ? `${desc}\n${ex.repairNote}`
      : desc;
    body.push([
      refLines.length ? refLines.join("\n") : "-",
      descCell,
      String(it.quantity),
      qtyTxt,
      String(totQty),
    ]);
  }

  drawHeader();

  autoTable(doc, {
    // Header halign per column matches the body so nothing looks
    // crooked (Set centred, Quantity / Total Qty right).
    head: [
      [
        { content: "Order" },
        { content: "Description" },
        { content: "Set", styles: { halign: "center" } },
        { content: "Quantity", styles: { halign: "right" } },
        { content: "Total Qty", styles: { halign: "right" } },
      ],
    ],
    body,
    foot: [
      [
        { content: "Total", colSpan: 2, styles: { halign: "right" } },
        { content: `${totalSets} SETS`, styles: { halign: "center" } },
        { content: "", styles: {} },
        { content: `${totalPcsAll} ITEMS`, styles: { halign: "right" } },
      ],
      // Full breakdown on its OWN full-width row (colSpan 5 ≈ 182mm) so a long
      // list ("2 Headboard + 2 Divan + 1 Back Cushion + 1 Armrest") wraps
      // instead of being squeezed off the 42mm Quantity cell (Wei Siang
      // 2026-06-16 "被挤出去" fix).
      [
        {
          content: grandBreakdown,
          colSpan: 5,
          styles: {
            halign: "right",
            fontStyle: "normal",
            overflow: "linebreak",
            lineWidth: { top: 0, bottom: 0, left: 0, right: 0 },
          },
        },
      ],
    ],
    margin: { top: HEADER_BOTTOM, left: m, right: m, bottom: 16 },
    showHead: "everyPage",
    showFoot: "lastPage",
    theme: "plain",
    // Never split one item's stacked cell across a page break — the
    // whole row moves to the next page instead (no orphaned "Front
    // Drawer" tail).
    rowPageBreak: "avoid",
    styles: {
      font: "helvetica",
      fontSize: 7.2,
      cellPadding: { top: 1.3, bottom: 1.8, left: 1.8, right: 1.8 },
      textColor: INK,
      lineColor: HAIR,
      lineWidth: 0,
      valign: "top",
    },
    headStyles: {
      fontStyle: "bold",
      fontSize: 7,
      lineWidth: { top: 0, bottom: 0.5, left: 0, right: 0 },
      lineColor: RULE,
    },
    footStyles: {
      fontStyle: "bold",
      fontSize: 6.6,
      overflow: "visible",
      lineWidth: { top: 0.5, bottom: 0, left: 0, right: 0 },
      lineColor: RULE,
    },
    columnStyles: {
      0: { cellWidth: 32 }, // Order — stacked PO / SO / REF
      1: { cellWidth: "auto" }, // Description (code / name / spec)
      2: { cellWidth: 20, halign: "center" }, // Set (no. of sets)
      3: { cellWidth: 42, halign: "right" }, // Quantity (piece breakdown)
      4: { cellWidth: 20, halign: "right" }, // Total Qty (pcs)
    },
    didParseCell: (data) => {
      // Description is column 1 now.
      if (
        data.section === "body" &&
        data.column.index === 1 &&
        typeof data.cell.raw === "string"
      ) {
        data.cell.styles.fontSize = 7.6;
      }
    },
    didDrawCell: (data) => {
      // Thin dashed separator under every item row (drawn once per row,
      // on the last column) so rows are easy to read across.
      if (data.section === "body" && data.column.index === 4) {
        const y = data.cell.y + data.cell.height;
        doc.setDrawColor(...HAIR);
        doc.setLineWidth(0.1);
        doc.setLineDashPattern([0.7, 0.7], 0);
        doc.line(m, y, pageW - m, y);
        doc.setLineDashPattern([], 0);
      }
    },
    didDrawPage: () => {
      drawHeader();
    },
  });

  // The grand totals (sets / breakdown / pieces) live in the table's
  // own footer row now — no separate roll-up table.
  const afterY =
    (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable
      ?.finalY ?? HEADER_BOTTOM;

  // Optional delivery-status QR (extras.qrDataUrl, print flows only — the
  // customer-email path never passes it; the advance token must not leave
  // the company). Drawn right-aligned between the items table and the
  // signature strip, pushing the strip down; the existing page-break guard
  // below still applies.
  let sy = afterY + 16;
  if (extras?.qrDataUrl) {
    const qrSize = 22;
    let qy = afterY + 8;
    if (qy + qrSize > pageH - 36) {
      doc.addPage();
      qy = 36;
    }
    doc.addImage(extras.qrDataUrl, "PNG", pageW - m - qrSize, qy, qrSize, qrSize);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.8);
    doc.setTextColor(...INK);
    doc.text("SCAN TO UPDATE DELIVERY STATUS", pageW - m - qrSize - 3, qy + 9, {
      align: "right",
    });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.2);
    doc.setTextColor(...FAINT);
    doc.text("Any phone camera · no login", pageW - m - qrSize - 3, qy + 12.5, {
      align: "right",
    });
    sy = qy + qrSize + 10;
  }
  if (sy > pageH - 34) {
    doc.addPage();
    sy = 36;
  }
  const halfW = (pageW - m * 2 - 14) / 2;
  doc.setDrawColor(...RULE);
  doc.setLineWidth(0.3);
  doc.line(m, sy + 14, m + halfW, sy + 14);
  doc.line(pageW - m - halfW, sy + 14, pageW - m, sy + 14);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...INK);
  doc.text("Prepared By", m, sy + 19);
  doc.text("Received in Good Order", pageW - m - halfW, sy + 19);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(...FAINT);
  doc.text("Name / Date / Stamp", m, sy + 23.5);
  doc.text("Name / Date / Stamp", pageW - m - halfW, sy + 23.5);

  // Footers + page numbering are applied once by stampDoFooters() after
  // every DO is drawn — not here — so a multi-DO run numbers the whole
  // document instead of restamping earlier DOs' pages.
}

// Stamps the per-page footer + "Page X of Y" across the WHOLE document.
// Run exactly once, after all DO(s) have been rendered.
export function stampDoFooters(doc: jsPDF) {
  const m = 14;
  const co = COMPANY.HOOKKA;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    const fy = pageH - 9;
    doc.setDrawColor(...HAIR);
    doc.setLineWidth(0.3);
    doc.line(m, fy - 4, pageW - m, fy - 4);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    doc.setTextColor(...FAINT);
    doc.text(
      `${co.name} · ${co.regNo} · Computer-generated delivery order`,
      m,
      fy,
    );
    doc.text(`Page ${p} of ${pages}`, pageW - m, fy, { align: "right" });
  }
}

// Single-DO entry point — unchanged behaviour for all existing call sites.
export function generateDOPdf(
  order: DeliveryOrder,
  extras?: DOPrintExtras,
  // "download" = save the file (default); "view" = open in the browser.
  mode: "download" | "view" = "download",
) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
  renderDoInto(doc, order, extras);
  stampDoFooters(doc);

  // order.doNo already carries the "DO-" prefix (e.g. "DO-2605-094"), so
  // prepending another "DO-" produced "DO-DO-2605-094.pdf". Use it verbatim;
  // only add the prefix for any legacy doNo that lacks it.
  const fileName = `${(order.doNo || "").startsWith("DO-") ? order.doNo : `DO-${order.doNo}`}.pdf`;

  if (mode === "view") {
    // Open to read on screen — no download. Fall back to save() if the
    // browser blocks the blob window (popup blocker).
    try {
      const url = doc.output("bloburl");
      const w = window.open(String(url), "_blank");
      if (!w) doc.save(fileName);
    } catch {
      doc.save(fileName);
    }
    return;
  }
  doc.save(fileName);
}

// Same branded single-DO document as generateDOPdf, returned as a base64
// string instead of saved/opened — feeds the customer dispatch notice
// attachment (POST /api/delivery-orders/:id/notify-customer). Renders via
// the EXACT renderDoInto + stampDoFooters path the print flows use, so the
// emailed PDF is byte-for-byte the printed one.
export function generateDoPdfBase64(
  order: DeliveryOrder,
  extras?: DOPrintExtras,
): string {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
  renderDoInto(doc, order, extras);
  stampDoFooters(doc);
  // datauristring = "data:application/pdf;filename=…;base64,<payload>".
  const uri = String(doc.output("datauristring"));
  const at = uri.indexOf("base64,");
  return at >= 0 ? uri.slice(at + "base64,".length) : "";
}

// Cover page for the consolidated packing list: a manifest so the driver/
// loader sees the whole run at a glance — how many DOs, which hubs +
// customers, how many drop points, and the DO numbers (with line/unit
// counts). The per-DO details follow on their own pages.
function renderPackingSummary(
  doc: jsPDF,
  orders: DeliveryOrder[],
  packingNo?: string,
  extrasById?: Record<string, DOPrintExtras>,
  // Delivery-status QR for the WHOLE run (the PL's public scan token) —
  // one scan marks every member DO Dispatched / Delivered. Print-only.
  qrDataUrl?: string,
) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const m = 14;
  const co = COMPANY.HOOKKA;
  const list = orders as (DeliveryOrder & {
    hubName?: string;
    customerState?: string;
    deliveryAddress?: string;
  })[];

  // --- Header (shared letterhead — single source of truth across all docs) ---
  const bodyY = drawLetterhead(doc, {
    docTitle: "PACKING LIST",
    docNo: packingNo ? `No. ${packingNo}` : "",
    docDate: `Delivery Run Manifest  ·  ${fmtDate(new Date().toISOString())}`,
    companyInfo: {
      name: co.name,
      regNo: co.regNo,
      tin: co.tin,
      address: co.address,
      phone: co.phone,
      email: co.email,
    },
  });

  // --- Run totals ---
  const uniq = (vals: (string | undefined)[]) =>
    Array.from(new Set(vals.map((v) => (v || "").trim()).filter(Boolean)));
  const totalDOs = list.length;
  const hubs = uniq(list.map((o) => o.hubName));
  const customers = uniq(list.map((o) => o.customerName));
  const totalUnits = list.reduce(
    (s, o) => s + (o.items || []).reduce((q, it) => q + (Number(it.quantity) || 0), 0),
    0,
  );
  const totalM3 = list.reduce(
    (s, o) => s + (Number((o as { totalM3?: number }).totalM3) || 0),
    0,
  );

  // Group DOs into drops by delivery LOCATION: same customer + same hub = one
  // drop (two/three DOs to the same place are still one stop). A new drop only
  // when the customer differs, or the same customer ships to a different hub.
  // 2026-06-11 owner rule: a DROP = one REAL delivery address. Several DOs
  // (even different customers / hubs — "hub" is just the customer's label)
  // going to the SAME address are ONE physical stop, matching the Packing
  // List table's Stops + the one-trip Cost. DOs with no address fall back to
  // customer+hub grouping so unrelated blank-address DOs don't merge.
  const normDropAddr = (raw: string | null | undefined): string =>
    (raw ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const dropGroups: {
    customers: string[];
    hubs: string[];
    states: string[];
    dos: typeof list;
  }[] = [];
  const dropIndex = new Map<string, number>();
  for (const o of list) {
    const addrKey = normDropAddr(o.deliveryAddress);
    const key = addrKey
      ? `addr::${addrKey}`
      : `ch::${(o.customerName || "").trim().toLowerCase()}::${(o.hubName || "").trim().toLowerCase()}`;
    let idx = dropIndex.get(key);
    if (idx === undefined) {
      idx = dropGroups.length;
      dropIndex.set(key, idx);
      dropGroups.push({ customers: [], hubs: [], states: [], dos: [] });
    }
    const g = dropGroups[idx];
    const cust = o.customerName || "-";
    if (!g.customers.includes(cust)) g.customers.push(cust);
    const hub = o.hubName || "-";
    if (!g.hubs.includes(hub)) g.hubs.push(hub);
    const st = o.customerState || "";
    if (st && !g.states.includes(st)) g.states.push(st);
    g.dos.push(o);
  }

  let y = bodyY;
  const colW = (pageW - 2 * m) / 4;
  const kv = (label: string, val: string, x: number, yy: number) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...FAINT);
    doc.text(label, x, yy);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...INK);
    doc.text(val, x + 23, yy);
  };
  // One clean row of the four headline numbers, then a names line — no more
  // duplicated "Hubs: 1 / Hubs: Houzs KL" clutter.
  kv("Drops:", String(dropGroups.length), m, y);
  kv("DOs:", String(totalDOs), m + colW, y);
  kv("Units:", String(totalUnits), m + colW * 2, y);
  kv("Total M³:", totalM3.toFixed(2), m + colW * 3, y);
  y += 7;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(...FAINT);
  const namesLine = doc.splitTextToSize(
    `Hubs: ${hubs.join(", ") || "-"}      Customers: ${customers.join(", ") || "-"}`,
    pageW - 2 * m,
  );
  doc.text(namesLine, m, y);
  y += namesLine.length * 3.8 + 4;

  // --- Container component total: how many Headboards / Divans / Sofas are in
  // the WHOLE truck (summed from each item's BOM pieces), so the loader can
  // tally the entire container. ---
  const containerMap = new Map<string, number>();
  let containerPcs = 0;
  for (const o of list) {
    const { map, pcs } = tallyComponents(o.items || [], extrasById?.[o.id]);
    for (const [k, v] of map) containerMap.set(k, (containerMap.get(k) || 0) + v);
    containerPcs += pcs;
  }
  const containerBreakdown = formatComponents(containerMap);

  doc.setFillColor(238, 238, 238);
  doc.rect(m, y, pageW - 2 * m, 9, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  doc.setTextColor(...INK);
  doc.text("CONTAINER TOTAL", m + 2.5, y + 5.7);
  doc.setFontSize(9.5);
  doc.text(
    `${containerBreakdown}   ·   ${containerPcs} pcs`,
    pageW - m - 2.5,
    y + 5.7,
    { align: "right" },
  );
  y += 14;

  // --- Per-DROP (location) sections. One drop = one delivery location; the
  // DOs going there are listed under it, with a single drop total. ---
  dropGroups.forEach((g, gi) => {
    // Component total across every DO at this location.
    const gMap = new Map<string, number>();
    let gPcs = 0;
    for (const o of g.dos) {
      const { map, pcs } = tallyComponents(o.items || [], extrasById?.[o.id]);
      for (const [k, v] of map) gMap.set(k, (gMap.get(k) || 0) + v);
      gPcs += pcs;
    }
    const gBreakdown = formatComponents(gMap);

    if (y > pageH - 52) {
      doc.addPage();
      y = 18;
    }

    // Drop header bar: DROP n · Customer — Hub   |   N DO(s)
    doc.setFillColor(238, 238, 238);
    doc.rect(m, y, pageW - 2 * m, 8, "F");
    doc.setTextColor(...INK);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.text(
      `DROP ${gi + 1}  ·  ${g.customers.join(" + ")}  —  ${g.hubs.join(", ")}${g.states.length ? ` (${g.states.join("/")})` : ""}`,
      m + 2.5,
      y + 5.4,
    );
    doc.setFontSize(8);
    doc.text(
      `${g.dos.length} DO${g.dos.length === 1 ? "" : "s"}`,
      pageW - m - 2.5,
      y + 5.4,
      { align: "right" },
    );
    y += 11;

    // Each DO at this drop, with its own deliver-to address.
    g.dos.forEach((o) => {
      const exDo = extrasById?.[o.id];
      // Sort a COPY by customer PO ascending (blanks last), then SO, so the
      // manifest lines match the printed DO order. Source array untouched.
      const items = [...(o.items || [])].sort((ia, ib) => {
        const exA = exDo?.items?.[ia.id ?? ""];
        const exB = exDo?.items?.[ib.id ?? ""];
        return compareDoLinesByCustomerPO(
          { customerPOId: exA?.customerPOId, salesOrderNo: exA?.salesOrderNo },
          { customerPOId: exB?.customerPOId, salesOrderNo: exB?.salesOrderNo },
        );
      });

      if (y > pageH - 34) {
        doc.addPage();
        y = 18;
      }
      // DO number (doNo already carries the "DO-" prefix — don't double it).
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(...INK);
      doc.text(o.doNo, m, y + 1);
      y += 4;

      // This DO's deliver-to address.
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7);
      doc.setTextColor(...FAINT);
      const addr = doc.splitTextToSize(
        `Deliver to: ${(o.deliveryAddress || "").trim() || "-"}`,
        pageW - 2 * m,
      );
      doc.text(addr, m, y);
      y += addr.length * 3.6 + 1.5;

      // Per-row rack sub-line for the Quantity cell ("HB: Rack 3 · DIVAN:
      // Rack 3, 20"). autotable cells are single-font, so the small grey
      // line is drawn by hand: didParseCell reserves the extra height,
      // didDrawCell draws it bottom-anchored under the pieces text.
      const QTY_WRAP_W = 34 - 3.6; // Quantity col width minus L/R padding
      const LH_MAIN = 3.05; // 7.5pt × 1.15 line height, in mm
      const LH_RACK = 2.55; // 6.2pt × 1.15 line height, in mm
      const rowExtras = items.map((it) => {
        const ex = exDo?.items?.[it.id];
        const rackTxt = formatComponentRacksNoLabel(ex?.componentRacks);
        if (!rackTxt) return null;
        const rackLines = doc.splitTextToSize(rackTxt, QTY_WRAP_W, {
          fontSize: 6.2,
        }) as string[];
        const fp = fmtPieces(ex?.pieces);
        const qtyTxt = fp.text || String(it.quantity ?? 0);
        const piecesLines = (
          doc.splitTextToSize(qtyTxt, QTY_WRAP_W, { fontSize: 7.5 }) as string[]
        ).length;
        return {
          rackLines,
          minH: 2.4 + piecesLines * LH_MAIN + rackLines.length * LH_RACK + 0.8,
        };
      });

      autoTable(doc, {
        startY: y,
        margin: { left: m, right: m },
        head: [
          [
            { content: "#", styles: { halign: "center" } },
            "Order (Our SO / PO / SO / Ref)",
            "Description",
            "Quantity",
            { content: "Packed", styles: { halign: "center" } },
            { content: "Total", styles: { halign: "right" } },
          ],
        ],
        body: items.map((it, k) => {
          const ex = exDo?.items?.[it.id];
          const ourSO = (ex?.salesOrderNo || "").trim();
          const po = (ex?.customerPOId || "").trim();
          const so = (ex?.customerSO || exDo?.customerSO || "").trim();
          const ref = (ex?.customerRef || exDo?.customerRef || "").trim();
          const fp = fmtPieces(ex?.pieces);
          // Full DO-style description (code / name+size / build spec:
          // fabric · DIVAN · LEG · GAP · T.Heights · specials) — identical to
          // the real DO line so the manifest matches the DO it stands in for.
          const desc = describe(
            {
              productCode: it.productCode || "",
              productName: it.productName || "",
              fabricCode: it.fabricCode || "",
              sizeLabel: it.sizeLabel || "",
            },
            ex,
          );
          return [
            String(k + 1),
            `Our SO: ${ourSO || "-"}\nPO: ${po || "-"}\nSO: ${so || "-"}\nREF: ${ref || "-"}`,
            desc,
            fp.text || String(it.quantity ?? 0),
            // Packed = the date the PO's LAST packing card completed;
            // "—" = at least one component not packed yet.
            ex?.packedDate ? fmtDate(ex.packedDate) : "—",
            String(fp.total || it.quantity || 0),
          ];
        }) as RowInput[],
        theme: "plain",
        styles: {
          font: "helvetica",
          fontSize: 7.5,
          cellPadding: { top: 1.2, bottom: 1.2, left: 1.8, right: 1.8 },
          textColor: INK,
          valign: "top",
        },
        headStyles: {
          fontStyle: "bold",
          fontSize: 7,
          lineWidth: { top: 0, bottom: 0.4, left: 0, right: 0 },
          lineColor: RULE,
        },
        columnStyles: {
          0: { cellWidth: 9, halign: "center" },
          1: { cellWidth: 30, fontSize: 6.5 },
          2: { cellWidth: "auto" },
          3: { cellWidth: 34 },
          4: { cellWidth: 18, fontSize: 6.5, halign: "center" },
          5: { cellWidth: 14, halign: "right" },
        },
        rowPageBreak: "avoid",
        didParseCell: (data) => {
          // Reserve room under the pieces text for the small rack line.
          if (data.section !== "body" || data.column.index !== 3) return;
          const rx = rowExtras[data.row.index];
          if (rx) {
            data.cell.styles.minCellHeight = Math.max(
              data.cell.styles.minCellHeight || 0,
              rx.minH,
            );
          }
        },
        didDrawCell: (data) => {
          // Rack location line, small + grey, bottom-anchored in the
          // Quantity cell so it never collides with the pieces text above.
          if (data.section !== "body" || data.column.index !== 3) return;
          const rx = rowExtras[data.row.index];
          if (!rx || rx.rackLines.length === 0) return;
          const x = data.cell.x + 1.8;
          const yLast = data.cell.y + data.cell.height - 1.8;
          doc.setFont("helvetica", "normal");
          doc.setFontSize(6.2);
          doc.setTextColor(...FAINT);
          rx.rackLines.forEach((ln, i) =>
            doc.text(ln, x, yLast - (rx.rackLines.length - 1 - i) * LH_RACK),
          );
          doc.setTextColor(...INK);
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      y = ((doc as any).lastAutoTable?.finalY ?? y) + 4;
    });

    // Drop total across all DOs at this location.
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.4);
    doc.line(m, y, pageW - m, y);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(...INK);
    doc.text(
      `Drop total:  ${gBreakdown}   ·   ${gPcs} pcs`,
      pageW - m,
      y + 4.8,
      { align: "right" },
    );
    y += 11;
  });

  // Delivery-status QR for the whole run — bottom-left after the drop
  // sections (~32mm; the header corners are owned by the title block, so
  // the QR closes the manifest instead). One scan transitions every member
  // DO together via the public /d/<token> page.
  if (qrDataUrl) {
    const qrSize = 32;
    if (y + qrSize + 6 > pageH - 14) {
      doc.addPage();
      y = 18;
    }
    doc.addImage(qrDataUrl, "PNG", m, y + 2, qrSize, qrSize);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(...INK);
    doc.text("SCAN TO UPDATE DELIVERY STATUS", m + qrSize + 4, y + 12);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.8);
    doc.setTextColor(...FAINT);
    doc.text(
      "Any phone camera · no login · one tap marks every DO on this run Dispatched / Delivered.",
      m + qrSize + 4,
      y + 16.5,
    );
    y += qrSize + 8;
  }

  if (y < pageH - 12) {
    doc.setFont("helvetica", "italic");
    doc.setFontSize(7);
    doc.setTextColor(...FAINT);
    doc.text(
      "Each delivery order's full DO follows on its own page (STOP 1, 2, 3…).",
      m,
      y + 1,
    );
  }
}

// Consolidated packing list — a manifest cover page (run summary + DO list),
// then EVERY selected DO rendered in the SAME DO format, each on its own page
// tagged STOP 1, STOP 2, STOP 3… The warehouse loads the whole truck from this
// one document; each hub still has its own DO.
export function generateConsolidatedDoPdf(
  orders: DeliveryOrder[],
  extrasById?: Record<string, DOPrintExtras>,
  // "download" = save the file (default); "view" = open on screen to read
  // first, no download.
  mode: "download" | "view" = "download",
  packingNo?: string,
  // When false, prints ONLY the packing-list manifest page and omits the
  // per-DO delivery-order forms that normally follow it. The packing list
  // is a standalone driver manifest; the DOs print separately.
  includeDoPages = true,
  // Optional delivery-status QR for the run (the PL's public scan token,
  // pre-rendered to a data URL via src/lib/do-qr.ts). Print flows only.
  plQrDataUrl?: string,
) {
  if (!orders || orders.length === 0) return;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
  renderPackingSummary(doc, orders, packingNo, extrasById, plQrDataUrl);
  if (includeDoPages) {
    orders.forEach((o, i) => {
      doc.addPage();
      renderDoInto(doc, o, extrasById?.[o.id], { seq: i + 1, total: orders.length });
    });
  }
  stampDoFooters(doc);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const fileName = packingNo
    ? `PackingList-${packingNo}.pdf`
    : `PackingList-Run-${stamp}-${orders.length}DO.pdf`;
  if (mode === "view") {
    // Open to read on screen — no download. Fall back to save() if the
    // browser blocks the blob window (popup blocker).
    try {
      const url = doc.output("bloburl");
      const w = window.open(String(url), "_blank");
      if (!w) doc.save(fileName);
    } catch {
      doc.save(fileName);
    }
    return;
  }
  doc.save(fileName);
}
