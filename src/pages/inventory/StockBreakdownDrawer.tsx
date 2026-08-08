// ---------------------------------------------------------------------------
// StockBreakdownDrawer — everything about ONE inventory item, in one panel.
//
// Opened from any row of the Inventory list. ONE component serves all three
// stock types; only the Stock Lots table changes shape between them (a FIFO
// batch for raw material, a physical piece for finished goods, a production
// order's in-flight work for WIP). The header, movements and COGS sections are
// identical, because the endpoint returns one shape for all three.
//
// Two things this panel refuses to do:
//
//   • invent a running balance. The balance column is derived by the API from
//     the movement rows themselves, and when the ledger cannot support one it
//     arrives as null and renders as an em dash next to a plain-English notice
//     saying why. A screen that quietly shows a wrong number is worse than one
//     that says it does not know;
//
//   • fake a link. A source document renders as a link only when that document
//     actually exists and has a page in this app. Otherwise the number renders
//     as text — we know which receipt it was, the document is simply gone.
//
// Numeric columns all carry `tabular-nums` so digits line up down the column;
// money is integer sen everywhere and printed with formatCurrency.
// ---------------------------------------------------------------------------
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  X,
  ArrowDownToLine,
  ArrowUpFromLine,
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import {
  DEFAULT_BREAKDOWN_SECTIONS,
  panelNotices,
  toggleBreakdownSection,
} from "@/lib/stock-breakdown";
import type {
  BreakdownSection,
  BreakdownSections,
  FgLot,
  RmLot,
  StockBreakdown,
  StockBreakdownTarget,
  StockMovement,
  WipLot,
} from "@/lib/stock-breakdown";

export type { StockBreakdownTarget };

// ---------------------------------------------------------------------------
// Shared cells
// ---------------------------------------------------------------------------

/** The one place an absent value is rendered. Keeps every gap looking alike. */
function Dash() {
  return <span className="text-[#B9B2A9]">&mdash;</span>;
}

function Txt({ value }: { value: string | null | undefined }) {
  if (value === null || value === undefined || value === "") return <Dash />;
  return <>{value}</>;
}

function Qty({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <Dash />;
  return <span className="tabular-nums">{value}</span>;
}

function Money({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <Dash />;
  return <span className="tabular-nums">{formatCurrency(value)}</span>;
}

function DateCell({ value }: { value: string | null | undefined }) {
  if (!value) return <Dash />;
  return <span className="tabular-nums">{value.slice(0, 10)}</span>;
}

/**
 * A source document. Clickable when — and only when — the API resolved a live
 * href for it. A number without a document still renders; that is the point.
 */
function DocLink({
  no,
  href,
  onNavigate,
}: {
  no: string | null | undefined;
  href: string | null | undefined;
  onNavigate: (href: string) => void;
}) {
  if (!no) return <Dash />;
  if (!href) {
    return (
      <span
        className="text-[#6B7280]"
        title="This document no longer exists in the system, so there is nothing to open."
      >
        {no}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="text-[#6B5C32] underline underline-offset-2 hover:text-[#4A3F22]"
      onClick={() => onNavigate(href)}
    >
      {no}
    </button>
  );
}

/**
 * A section heading: brass left accent bar, one uppercase line, the count and
 * the explanation inline. The whole hierarchy of the panel is carried by this
 * one shape, so a heading never needs a box of its own.
 */
const EYEBROW =
  "pl-2 border-l-[3px] border-[#6B5C32] text-[12px] font-extrabold uppercase " +
  "tracking-[0.06em] text-[#4A3F22] leading-tight";

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className={`m-0 ${EYEBROW}`}>{children}</p>;
}

/** The white bordered card every table sits in; wide tables scroll inside it. */
function TableCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 rounded-md border border-[#E2DDD8] bg-white overflow-x-auto">
      {children}
    </div>
  );
}

/** A collapsible section's heading. Same eyebrow, plus a chevron. */
function SectionToggle({
  open,
  onClick,
  children,
}: {
  open: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className="bg-transparent border-0 p-0 text-left cursor-pointer"
    >
      <span className={`inline-flex items-center gap-1 ${EYEBROW}`}>
        {open ? (
          <ChevronDown className="h-3 w-3" strokeWidth={2.5} />
        ) : (
          <ChevronRight className="h-3 w-3" strokeWidth={2.5} />
        )}
        {children}
      </span>
    </button>
  );
}

const TH =
  "px-3 py-2 text-left text-[10px] font-bold uppercase tracking-[0.14em] " +
  "text-[#1F1D1B] whitespace-nowrap";
const THR = `${TH} text-right`;
const TD = "px-3 py-1.5 text-[#1F1D1B] whitespace-nowrap";
const TDR = `${TD} text-right`;

/** IN / OUT pill — the movement's direction, said once per row. */
function DirectionPill({ direction }: { direction: "IN" | "OUT" }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-px text-[10px] font-semibold uppercase tracking-[0.08em] ${
        direction === "IN"
          ? "bg-[#2F8A5B]/12 text-[#2F8A5B]"
          : "bg-[#B23A3A]/10 text-[#B23A3A]"
      }`}
    >
      {direction}
    </span>
  );
}

/** Signed quantity — a movement's sign is part of the number, not the column. */
function SignedQty({ m }: { m: StockMovement }) {
  if (m.qty === null || m.qty === undefined) return <Dash />;
  const sign = m.direction === "IN" ? "+" : "−";
  return (
    <span
      className={`tabular-nums ${m.direction === "IN" ? "text-[#2F8A5B]" : "text-[#B23A3A]"}`}
    >
      {sign}
      {Math.abs(m.qty)}
    </span>
  );
}

/**
 * Free-text notes, shown only where there is something to show. A column of em
 * dashes is worse than no column: it reads as "nothing was noted" when the
 * truth is that this kind of movement never carries a note.
 */
function hasNotes(rows: StockMovement[]): boolean {
  return rows.some((r) => Boolean(r.notes));
}

function NotesCell({ value }: { value: string | null | undefined }) {
  return (
    <span className="text-[#6B7280]" title={value ?? ""}>
      <Txt value={value} />
    </span>
  );
}

function EmptyRow({ span, message }: { span: number; message: string }) {
  return (
    <tr>
      <td colSpan={span} className="px-3 py-4 text-center text-[#9CA3AF]">
        {message}
      </td>
    </tr>
  );
}

/**
 * A notice the operator must read before trusting the numbers above it.
 * `tone="warn"` is used when the ledger cannot be reconciled at all.
 */
function Notice({ tone, children }: { tone: "warn" | "info"; children: React.ReactNode }) {
  const warn = tone === "warn";
  return (
    <div
      className={`flex gap-2 items-start rounded-md border px-3 py-2 text-xs leading-relaxed ${
        warn
          ? "border-[#E0C9A6] bg-[#FDF6EC] text-[#7A4E12]"
          : "border-[#D8DEE6] bg-[#F5F8FB] text-[#3F5163]"
      }`}
    >
      {warn ? (
        <AlertTriangle className="h-4 w-4 shrink-0 mt-px" />
      ) : (
        <Info className="h-4 w-4 shrink-0 mt-px" />
      )}
      <p>{children}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header stats
// ---------------------------------------------------------------------------
function Stat({
  label,
  value,
  sub,
  title,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  /** Hover explanation — used where the counting unit needs saying out loud. */
  title?: string;
}) {
  return (
    <div className="border border-[#E2DDD8] rounded-lg px-4 py-3 bg-white" title={title}>
      <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#6B7280]">
        {label}
      </p>
      <p className="mt-1 text-[22px] font-bold text-[#1F1D1B] tabular-nums leading-tight">
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[11px] text-[#6B7280] tabular-nums">{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lots — RM
// ---------------------------------------------------------------------------
function RmLotsTable({
  lots,
  onNavigate,
}: {
  lots: RmLot[];
  onNavigate: (href: string) => void;
}) {
  // No warehouse column: `rm_batches` has no location and there is no
  // warehouses table, so the column Houzs leads with would be an em dash on
  // every row of every material. An always-empty column reads as missing data
  // rather than as a dimension this system does not have.
  const subtotalSen = lots.reduce((s, l) => s + (l.valueSen ?? 0), 0);
  return (
    <table className="w-full text-xs">
      <thead className="bg-[#FAF8F5]">
        <tr>
          <th className={TH}>Attributes</th>
          <th className={THR}>Qty</th>
          <th className={THR}>Unit cost</th>
          <th className={THR}>Value</th>
          <th className={TH}>Source</th>
          <th className={TH}>Supplier</th>
          <th className={TH}>Received</th>
          <th className={THR}>Age</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#F0EDE9]">
        {lots.length === 0 && (
          <EmptyRow span={8} message="No stock lots for this material." />
        )}
        {lots.map((l) => (
          <tr key={l.id} className={l.qty <= 0 ? "opacity-60" : undefined}>
            <td className={`${TD} max-w-[220px] truncate`} title={l.attributes ?? ""}>
              <Txt value={l.attributes} />
            </td>
            <td className={TDR}>
              <span className={l.qty < 0 ? "text-[#9A3A2D] font-semibold tabular-nums" : "tabular-nums"}>
                {l.qty}
              </span>
              <span className="text-[#9CA3AF] tabular-nums"> / {l.originalQty}</span>
            </td>
            <td className={TDR}><Money value={l.unitCostSen} /></td>
            <td className={TDR}><Money value={l.valueSen} /></td>
            {/* SOURCE is two lines: the receipt on top, the PO it came from
                underneath. They are one fact — where this lot came in — and
                reading them as one cell is how the warehouse thinks of it. */}
            <td className={`${TD} align-top`}>
              <span className="text-[#6B7280] mr-1">{l.source}</span>
              <DocLink no={l.grnNo} href={l.grnHref} onNavigate={onNavigate} />
              {l.purchaseOrderNo && (
                <span className="block mt-px text-[11px] text-[#9CA3AF]">
                  from{" "}
                  <DocLink
                    no={l.purchaseOrderNo}
                    href={l.purchaseOrderHref}
                    onNavigate={onNavigate}
                  />
                </span>
              )}
            </td>
            <td className={`${TD} max-w-[180px] truncate`} title={l.supplierName ?? ""}>
              <Txt value={l.supplierName} />
            </td>
            <td className={TD}><DateCell value={l.receivedDate} /></td>
            <td className={TDR}>
              {l.ageDays === null ? <Dash /> : <span className="tabular-nums">{l.ageDays}d</span>}
            </td>
          </tr>
        ))}
        {lots.length > 0 && (
          <tr className="bg-[#FAF8F5]">
            <td colSpan={3} className={`${TDR} font-semibold`}>Value subtotal</td>
            <td className={`${TDR} font-bold`}>
              <Money value={subtotalSen} />
            </td>
            <td colSpan={4} />
          </tr>
        )}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Lots — FG. One row per PHYSICAL PIECE, not per cost layer: a finished good
// here is a serialised piece with a maker, a date and usually a customer
// already waiting for it.
// ---------------------------------------------------------------------------
function FgLotsTable({
  lots,
  onNavigate,
}: {
  lots: FgLot[];
  onNavigate: (href: string) => void;
}) {
  return (
    <table className="w-full text-xs">
      <thead className="bg-[#FAF8F5]">
        <tr>
          <th className={TH}>Serial</th>
          <th className={TH}>Attributes</th>
          <th className={THR}>Unit cost</th>
          <th className={TH}>Production order</th>
          <th className={TH}>MFD</th>
          <th className={THR}>Age</th>
          <th className={TH}>Claimed by SO</th>
          <th className={TH}>Customer</th>
          <th className={TH}>Status</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#F0EDE9]">
        {lots.length === 0 && (
          <EmptyRow span={9} message="No pieces of this product are on hand." />
        )}
        {lots.map((l) => (
          <tr key={l.id}>
            <td className={TD}>
              <span className="tabular-nums">{l.serial}</span>
              {l.shortCode && (
                <span className="text-[#9CA3AF] tabular-nums"> · {l.shortCode}</span>
              )}
            </td>
            <td className={`${TD} max-w-[220px] truncate`} title={l.attributes ?? ""}>
              <Txt value={l.attributes} />
            </td>
            <td className={TDR}><Money value={l.unitCostSen} /></td>
            <td className={TD}>
              <DocLink
                no={l.productionOrderNo}
                href={l.productionOrderHref}
                onNavigate={onNavigate}
              />
            </td>
            <td className={TD}><DateCell value={l.mfdDate} /></td>
            <td className={TDR}>
              {l.ageDays === null ? <Dash /> : <span className="tabular-nums">{l.ageDays}d</span>}
            </td>
            <td className={TD}>
              <DocLink
                no={l.claimedBySoNo}
                href={l.claimedBySoHref}
                onNavigate={onNavigate}
              />
            </td>
            <td className={`${TD} max-w-[160px] truncate`} title={l.customerName ?? ""}>
              <Txt value={l.customerName} />
            </td>
            <td className={TD}>
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#F0EDE9] text-[#6B7280]">
                {l.status}
              </span>
            </td>
          </tr>
        ))}
        {/* A finished-goods piece IS its own layer, so the piece's unit cost is
            its value and the subtotal of the column is the shelf's value — the
            same figure the header shows. Pieces with no cost contribute
            nothing, which the valuation notice above states outright. */}
        {lots.length > 0 && (
          <tr className="bg-[#FAF8F5]">
            <td colSpan={2} className={`${TDR} font-semibold`}>Value subtotal</td>
            <td className={`${TDR} font-bold`}>
              <Money value={lots.reduce((s, l) => s + (l.valueSen ?? 0), 0)} />
            </td>
            <td colSpan={6} />
          </tr>
        )}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Lots — WIP. One row per JOB CARD: the piece of work that made this WIP item
// on one production order.
//
// The cost columns are headed "Labour" and not "Value", because that is what
// they are. Nothing in this system costs a WIP piece, and a column called Value
// would be read as a stock valuation.
// ---------------------------------------------------------------------------
function WipLotsTable({
  lots,
  onNavigate,
}: {
  lots: WipLot[];
  onNavigate: (href: string) => void;
}) {
  return (
    <table className="w-full text-xs">
      <thead className="bg-[#FAF8F5]">
        <tr>
          <th className={TH}>Production order</th>
          <th className={TH}>Sales order</th>
          <th className={TH}>Department</th>
          <th className={THR}>Qty made</th>
          <th className={THR}>Labour (min)</th>
          <th className={THR}>Labour posted</th>
          <th className={TH}>Completed</th>
          <th className={THR}>Age</th>
          <th className={TH}>Status</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#F0EDE9]">
        {lots.length === 0 && (
          <EmptyRow span={9} message="No job cards have produced this WIP item." />
        )}
        {lots.map((l) => (
          <tr key={l.id}>
            <td className={TD}>
              <DocLink
                no={l.productionOrderNo}
                href={l.productionOrderHref}
                onNavigate={onNavigate}
              />
            </td>
            <td className={TD}>
              <DocLink no={l.salesOrderNo} href={l.salesOrderHref} onNavigate={onNavigate} />
            </td>
            <td className={TD}>
              <DocLink
                no={l.department ?? l.jobCardNo}
                href={l.jobCardHref}
                onNavigate={onNavigate}
              />
            </td>
            <td className={TDR}><Qty value={l.qty} /></td>
            <td className={TDR}><Qty value={l.laborMinutes} /></td>
            <td className={TDR}><Money value={l.laborPostedSen} /></td>
            <td className={TD}><DateCell value={l.completedDate} /></td>
            <td className={TDR}>
              {l.ageDays === null ? <Dash /> : <span className="tabular-nums">{l.ageDays}d</span>}
            </td>
            <td className={TD}>
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#F0EDE9] text-[#6B7280]">
                {l.status ?? "—"}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Movements — split IN / OUT, different columns on each (owner's ask)
// ---------------------------------------------------------------------------
function BalanceCell({ m }: { m: StockMovement }) {
  if (m.balanceAfter === null) {
    return (
      <span
        className="text-[#B9B2A9]"
        title="No running balance is shown — see the notice at the top of this panel."
      >
        &mdash;
      </span>
    );
  }
  return <span className="tabular-nums font-medium">{m.balanceAfter}</span>;
}

function RmInTable({
  rows,
  onNavigate,
}: {
  rows: StockMovement[];
  onNavigate: (href: string) => void;
}) {
  const notes = hasNotes(rows);
  return (
    <table className="w-full text-xs">
      <thead className="bg-[#F3F7F3]">
        <tr>
          <th className={TH}>Date</th>
          <th className={TH}>Type</th>
          <th className={TH}>GR no</th>
          <th className={TH}>Supplier</th>
          <th className={TH}>PO no</th>
          <th className={THR}>Qty</th>
          <th className={THR}>Unit cost</th>
          <th className={THR}>Value</th>
          <th className={THR}>Running</th>
          {notes && <th className={TH}>Notes</th>}
        </tr>
      </thead>
      <tbody className="divide-y divide-[#F0EDE9]">
        {rows.length === 0 && (
          <EmptyRow span={notes ? 10 : 9} message="No inbound movements." />
        )}
        {rows.map((m) => (
          <tr key={m.id}>
            <td className={TD}><DateCell value={m.date} /></td>
            <td className={TD}><DirectionPill direction={m.direction} /></td>
            <td className={TD}>
              <DocLink no={m.docNo} href={m.docHref} onNavigate={onNavigate} />
            </td>
            <td className={`${TD} max-w-[180px] truncate`} title={m.supplierName ?? ""}>
              <Txt value={m.supplierName} />
            </td>
            <td className={TD}>
              <DocLink
                no={m.purchaseOrderNo}
                href={m.purchaseOrderHref}
                onNavigate={onNavigate}
              />
            </td>
            <td className={TDR}><SignedQty m={m} /></td>
            <td className={TDR}><Money value={m.unitCostSen} /></td>
            <td className={TDR}><Money value={m.totalCostSen} /></td>
            <td className={TDR}><BalanceCell m={m} /></td>
            {notes && (
              <td className={`${TD} max-w-[220px] truncate`}>
                <NotesCell value={m.notes} />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RmOutTable({
  rows,
  onNavigate,
}: {
  rows: StockMovement[];
  onNavigate: (href: string) => void;
}) {
  const notes = hasNotes(rows);
  return (
    <table className="w-full text-xs">
      <thead className="bg-[#FBF3F2]">
        <tr>
          <th className={TH}>Date</th>
          <th className={TH}>Type</th>
          <th className={TH}>Production order</th>
          <th className={TH}>Department</th>
          <th className={TH}>Taken by</th>
          <th className={TH}>Job card</th>
          <th className={THR}>Qty</th>
          <th className={THR}>Cost</th>
          <th className={THR}>Running</th>
          {notes && <th className={TH}>Notes</th>}
        </tr>
      </thead>
      <tbody className="divide-y divide-[#F0EDE9]">
        {rows.length === 0 && (
          <EmptyRow span={notes ? 10 : 9} message="No outbound movements." />
        )}
        {rows.map((m) => (
          <tr key={m.id}>
            <td className={TD}><DateCell value={m.date} /></td>
            <td className={TD}><DirectionPill direction={m.direction} /></td>
            <td className={TD}>
              <DocLink
                no={m.productionOrderNo ?? m.docNo}
                href={m.productionOrderHref ?? m.docHref}
                onNavigate={onNavigate}
              />
            </td>
            <td className={TD}><Txt value={m.department} /></td>
            <td className={TD}><Txt value={m.takenByName} /></td>
            <td className={TD}>
              <DocLink no={m.jobCardNo} href={m.jobCardHref} onNavigate={onNavigate} />
            </td>
            <td className={TDR}><SignedQty m={m} /></td>
            <td className={TDR}><Money value={m.totalCostSen} /></td>
            <td className={TDR}><BalanceCell m={m} /></td>
            {notes && (
              <td className={`${TD} max-w-[220px] truncate`}>
                <NotesCell value={m.notes} />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FgInTable({
  rows,
  onNavigate,
}: {
  rows: StockMovement[];
  onNavigate: (href: string) => void;
}) {
  const notes = hasNotes(rows);
  return (
    <table className="w-full text-xs">
      <thead className="bg-[#F3F7F3]">
        <tr>
          <th className={TH}>Date</th>
          <th className={TH}>Type</th>
          <th className={TH}>Production order</th>
          <th className={TH}>Sales order</th>
          <th className={TH}>Customer</th>
          <th className={THR}>Qty</th>
          <th className={THR}>Unit cost</th>
          <th className={THR}>Running</th>
          {notes && <th className={TH}>Notes</th>}
        </tr>
      </thead>
      <tbody className="divide-y divide-[#F0EDE9]">
        {rows.length === 0 && (
          <EmptyRow span={notes ? 9 : 8} message="No inbound movements." />
        )}
        {rows.map((m) => (
          <tr key={m.id}>
            <td className={TD}><DateCell value={m.date} /></td>
            <td className={TD}><DirectionPill direction={m.direction} /></td>
            <td className={TD}>
              <DocLink
                no={m.productionOrderNo ?? m.docNo}
                href={m.productionOrderHref ?? m.docHref}
                onNavigate={onNavigate}
              />
            </td>
            <td className={TD}>
              <DocLink no={m.salesOrderNo} href={m.salesOrderHref} onNavigate={onNavigate} />
            </td>
            <td className={`${TD} max-w-[180px] truncate`} title={m.customerName ?? ""}>
              <Txt value={m.customerName} />
            </td>
            <td className={TDR}><SignedQty m={m} /></td>
            <td className={TDR}><Money value={m.unitCostSen} /></td>
            <td className={TDR}><BalanceCell m={m} /></td>
            {notes && (
              <td className={`${TD} max-w-[220px] truncate`}>
                <NotesCell value={m.notes} />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The serials that left on a delivery. Long lists are clipped to keep the row
 * one line high; the full list stays in the title so nothing is lost.
 */
function Serials({ serials }: { serials: string[] | undefined }) {
  if (!serials || serials.length === 0) return <Dash />;
  const shown = serials.slice(0, 3).join(", ");
  return (
    <span className="tabular-nums" title={serials.join(", ")}>
      {shown}
      {serials.length > 3 && (
        <span className="text-[#9CA3AF]"> +{serials.length - 3} more</span>
      )}
    </span>
  );
}

function FgOutTable({
  rows,
  onNavigate,
}: {
  rows: StockMovement[];
  onNavigate: (href: string) => void;
}) {
  const notes = hasNotes(rows);
  return (
    <table className="w-full text-xs">
      <thead className="bg-[#FBF3F2]">
        <tr>
          <th className={TH}>Date</th>
          <th className={TH}>Type</th>
          <th className={TH}>DO no</th>
          <th className={TH}>Sales order</th>
          <th className={TH}>Customer</th>
          <th className={THR}>Qty</th>
          <th className={TH}>Unit serials</th>
          <th className={THR}>Running</th>
          {notes && <th className={TH}>Notes</th>}
        </tr>
      </thead>
      <tbody className="divide-y divide-[#F0EDE9]">
        {rows.length === 0 && (
          <EmptyRow span={notes ? 9 : 8} message="No outbound movements." />
        )}
        {rows.map((m) => (
          <tr key={m.id}>
            <td className={TD}><DateCell value={m.date} /></td>
            <td className={TD}><DirectionPill direction={m.direction} /></td>
            <td className={TD}>
              <DocLink no={m.docNo} href={m.docHref} onNavigate={onNavigate} />
            </td>
            <td className={TD}>
              <DocLink no={m.salesOrderNo} href={m.salesOrderHref} onNavigate={onNavigate} />
            </td>
            <td className={`${TD} max-w-[180px] truncate`} title={m.customerName ?? ""}>
              <Txt value={m.customerName} />
            </td>
            <td className={TDR}><SignedQty m={m} /></td>
            <td className={`${TD} max-w-[280px] truncate`}>
              <Serials serials={m.unitSerials} />
            </td>
            <td className={TDR}><BalanceCell m={m} /></td>
            {notes && (
              <td className={`${TD} max-w-[220px] truncate`}>
                <NotesCell value={m.notes} />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * WIP movements. One table for both directions — unlike RM and FG there is no
 * pair of column sets to choose between, because every row is the same kind of
 * event: labour booked against a job card, or a reversal of one.
 *
 * The Qty column is headed "Qty (min)" on purpose. These are MINUTES, and the
 * grid above this drawer counts pieces; a bare "Qty" is what would let somebody
 * add the two together.
 */
function WipMovementsTable({
  rows,
  onNavigate,
}: {
  rows: StockMovement[];
  onNavigate: (href: string) => void;
}) {
  const notes = hasNotes(rows);
  return (
    <table className="w-full text-xs">
      <thead className="bg-[#FAF8F5]">
        <tr>
          <th className={TH}>Date</th>
          <th className={TH}>Type</th>
          <th className={TH}>Production order</th>
          <th className={TH}>Department</th>
          <th className={TH}>Worker</th>
          <th className={THR}>Qty (min)</th>
          <th className={THR}>Cost</th>
          <th className={THR}>Running</th>
          {notes && <th className={TH}>Notes</th>}
        </tr>
      </thead>
      <tbody className="divide-y divide-[#F0EDE9]">
        {rows.length === 0 && (
          <EmptyRow span={notes ? 9 : 8} message="No movements recorded." />
        )}
        {rows.map((m) => (
          <tr key={m.id}>
            <td className={TD}><DateCell value={m.date} /></td>
            {/* Direction pill AND the ledger type: WIP rows are all inbound
                work, so the pill alone would not distinguish a labour posting
                from its reversal. */}
            <td className={TD}>
              <DirectionPill direction={m.direction} />
              <span className="ml-1.5 text-[11px] text-[#6B7280]">{m.type}</span>
            </td>
            <td className={TD}>
              <DocLink
                no={m.productionOrderNo}
                href={m.productionOrderHref}
                onNavigate={onNavigate}
              />
            </td>
            <td className={TD}>
              <DocLink
                no={m.department ?? m.jobCardNo}
                href={m.jobCardHref}
                onNavigate={onNavigate}
              />
            </td>
            <td className={`${TD} max-w-[160px] truncate`} title={m.takenByName ?? ""}>
              <Txt value={m.takenByName} />
            </td>
            <td className={TDR}><SignedQty m={m} /></td>
            <td className={TDR}><Money value={m.totalCostSen} /></td>
            <td className={TDR}><BalanceCell m={m} /></td>
            {notes && (
              <td className={`${TD} max-w-[220px] truncate`}>
                <NotesCell value={m.notes} />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// The drawer
// ---------------------------------------------------------------------------
/**
 * Closed is a distinct component from open, and each open item mounts fresh.
 *
 * The alternative — one long-lived component that clears its own state in an
 * effect whenever the target changes — is how a panel ends up briefly showing
 * the PREVIOUS item's lots under the new item's header. Remounting on the key
 * makes that state impossible to reach rather than merely unlikely.
 */
export default function StockBreakdownDrawer({
  target,
  onClose,
}: {
  target: StockBreakdownTarget | null;
  onClose: () => void;
}) {
  if (!target) return null;
  return (
    <StockBreakdownPanel
      key={`${target.type}:${target.itemId}`}
      target={target}
      onClose={onClose}
    />
  );
}

function StockBreakdownPanel({
  target,
  onClose,
}: {
  target: StockBreakdownTarget;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [data, setData] = useState<StockBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Movements and COGS collapse INDEPENDENTLY and both start open. Closing one
  // must leave the other exactly as the operator left it.
  const [sections, setSections] = useState<BreakdownSections>(
    DEFAULT_BREAKDOWN_SECTIONS,
  );
  const toggle = (s: BreakdownSection) =>
    setSections((prev) => toggleBreakdownSection(prev, s));

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/stock/breakdown?type=${encodeURIComponent(target.type)}&itemId=${encodeURIComponent(target.itemId)}`,
        );
        const j = (await res.json().catch(() => null)) as
          | { success?: boolean; data?: StockBreakdown; error?: string }
          | null;
        if (cancelled) return;
        if (!res.ok || !j?.success || !j.data) {
          setError(j?.error ?? `Could not load the breakdown (HTTP ${res.status}).`);
        } else {
          setData(j.data);
        }
      } catch {
        if (!cancelled) setError("Could not load the breakdown.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  // Escape closes, matching every other overlay in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const go = (href: string) => {
    onClose();
    navigate(href);
  };

  const header = data?.header;
  const movements = data?.movements ?? [];
  const inRows = movements.filter((m) => m.direction === "IN");
  const outRows = movements.filter((m) => m.direction === "OUT");

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/25"
        onClick={onClose}
        aria-hidden
      />
      <aside
        className="fixed top-0 right-0 bottom-0 z-50 flex flex-col bg-[#FAF8F5] shadow-2xl border-l border-[#E2DDD8] w-[min(1120px,96vw)]"
        role="dialog"
        aria-label="Stock breakdown"
      >
        {/* Title bar — the PANEL is named first, then the item: the operator
            already knows which row was clicked, and what they need to read is
            what this thing is. Code as a chip beside the full description. */}
        <div className="flex items-start justify-between gap-4 px-5 py-3 border-b border-[#E2DDD8] bg-white">
          <div className="min-w-0">
            <h2 className="text-[18px] font-extrabold leading-tight tracking-tight text-[#1F1D1B]">
              Stock Breakdown
            </h2>
            <p className="mt-1 text-[13px] text-[#6B7280] truncate">
              <span className="inline-block rounded-full border border-[#E2DDD8] bg-[#F5F2ED] px-2 py-px font-mono text-[12px] text-[#1F1D1B]">
                {header?.itemCode || target.code}
              </span>{" "}
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#F0EDE9] text-[#6B7280]">
                {target.type}
              </span>{" "}
              {header?.itemName || target.name || ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[#E2DDD8] bg-white px-2.5 py-1.5 text-xs text-[#6B7280] hover:bg-[#F0EDE9]"
            aria-label="Close"
          >
            <X className="h-3.5 w-3.5" />
            <span>Close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {loading && <p className="text-sm text-[#6B7280]">Loading breakdown…</p>}
          {error && !loading && (
            <Notice tone="warn">{error}</Notice>
          )}

          {header && (
            <>
              {/* 1 — Header stats. No "(owned)" qualifier anywhere: Houzs
                  needs it to separate owned stock from consignment, and this
                  system holds no consignment stock at all. Borrowing the word
                  would imply a distinction nothing here makes. */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat
                  label="Total qty"
                  value={
                    header.totalQty === null ? <Dash /> : header.totalQty
                  }
                  sub={header.uom || undefined}
                  title={header.qtyNote ?? undefined}
                />
                <Stat
                  label="Assigned · Free"
                  value={
                    header.assignedQty === null || header.freeQty === null ? (
                      <Dash />
                    ) : (
                      `${header.assignedQty} / ${header.freeQty}`
                    )
                  }
                />
                <Stat
                  label="Total value"
                  value={<Money value={header.totalValueSen} />}
                />
                <Stat
                  label="Age (FIFO)"
                  value={
                    header.oldestAgeDays === null ? (
                      <Dash />
                    ) : (
                      `${header.oldestAgeDays}d`
                    )
                  }
                  sub={header.oldestLayerDate?.slice(0, 10)}
                />
              </div>

              {/* Every notice this header carries, in one place. The list comes
                  from panelNotices so a restyle cannot quietly drop one. */}
              {panelNotices(header).map((n) => (
                <Notice key={n.key} tone={n.tone}>{n.text}</Notice>
              ))}

              {/* 2 — Stock lots.
                  WIP gets a different heading because it has no lots: what it
                  has is the job cards that made the item. Calling those "stock
                  lots" would imply a FIFO layer that does not exist. */}
              <section>
                <Eyebrow>
                  {target.type === "WIP"
                    ? `Job cards that made this (${data?.lots.length ?? 0}) — oldest first, WIP has no cost layers so these are the work, not lots`
                    : `Stock lots (${data?.lots.length ?? 0}) — oldest first, consumed first on the next DO`}
                </Eyebrow>
                <TableCard>
                  {target.type === "RM" && (
                    <RmLotsTable
                      lots={(data?.lots ?? []) as RmLot[]}
                      onNavigate={go}
                    />
                  )}
                  {target.type === "FG" && (
                    <FgLotsTable
                      lots={(data?.lots ?? []) as FgLot[]}
                      onNavigate={go}
                    />
                  )}
                  {target.type === "WIP" && (
                    <WipLotsTable
                      lots={(data?.lots ?? []) as WipLot[]}
                      onNavigate={go}
                    />
                  )}
                </TableCard>
              </section>

              {/* 3 — Movements, newest first. ONE collapsible section, as in
                  Houzs — but the IN and OUT rows keep their own column sets,
                  because a receipt and an issue answer different questions
                  (which GRN and supplier vs which production order, department
                  and who took it) and the owner asked for both by name.
                  WIP is not split: every row is the same kind of event, so a
                  second table headed "Stock issued" holding nothing would read
                  as "nothing has been issued" rather than "issues are not
                  recorded". The notice above says which. */}
              <section>
                <SectionToggle
                  open={sections.movements}
                  onClick={() => toggle("movements")}
                >
                  Movements ({movements.length}) — every stock change for this item
                </SectionToggle>
                {sections.movements && (
                  <>
                    <TableCard>
                      {target.type !== "WIP" && (
                        <div className="flex items-center gap-1.5 px-3 pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#3F6B3F]">
                          <ArrowDownToLine className="h-3.5 w-3.5" /> Stock received (
                          {inRows.length})
                        </div>
                      )}
                      {target.type === "RM" && <RmInTable rows={inRows} onNavigate={go} />}
                      {target.type === "FG" && <FgInTable rows={inRows} onNavigate={go} />}
                      {target.type === "WIP" && (
                        <WipMovementsTable rows={movements} onNavigate={go} />
                      )}
                    </TableCard>

                    {target.type !== "WIP" && (
                      <TableCard>
                        <div className="flex items-center gap-1.5 px-3 pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#9A3A2D]">
                          <ArrowUpFromLine className="h-3.5 w-3.5" /> Stock issued (
                          {outRows.length})
                        </div>
                        {target.type === "RM" && <RmOutTable rows={outRows} onNavigate={go} />}
                        {target.type === "FG" && <FgOutTable rows={outRows} onNavigate={go} />}
                      </TableCard>
                    )}
                  </>
                )}
              </section>

              {/* 4 — COGS */}
              <section>
                <SectionToggle open={sections.cogs} onClick={() => toggle("cogs")}>
                  COGS ({data?.cogs.length ?? 0}) — FIFO consumptions for this item
                </SectionToggle>
                {sections.cogs && (
                <TableCard>
                <table className="w-full text-xs">
                  <thead className="bg-[#FAF8F5]">
                    <tr>
                      <th className={TH}>Consumed at</th>
                      <th className={TH}>Source doc</th>
                      <th className={THR}>Qty</th>
                      <th className={THR}>Unit cost</th>
                      <th className={THR}>Total cost</th>
                      <th className={TH}>From lot</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F0EDE9]">
                    {(data?.cogs ?? []).length === 0 && (
                      <EmptyRow
                        span={6}
                        // "Nothing has been consumed yet" is true for a raw
                        // material nobody has drawn on. For WIP it would be a
                        // false statement about a real event: WIP IS consumed
                        // constantly, and none of it is written down.
                        message={
                          target.type === "WIP"
                            ? "WIP consumption is never written to the ledger, so there is nothing to list here. This is not a record that nothing was consumed."
                            : "Nothing has been consumed yet."
                        }
                      />
                    )}
                    {(data?.cogs ?? []).map((r) => (
                      <tr key={r.id}>
                        <td className={TD}><DateCell value={r.consumedAt} /></td>
                        <td className={TD}>
                          <DocLink no={r.docNo} href={r.docHref} onNavigate={go} />
                        </td>
                        <td className={TDR}><Qty value={r.qty} /></td>
                        <td className={TDR}><Money value={r.unitCostSen} /></td>
                        <td className={TDR}><Money value={r.totalCostSen} /></td>
                        <td className={`${TD} max-w-[260px] truncate`} title={r.fromLotId ?? ""}>
                          <Txt value={r.fromLotLabel} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </TableCard>
                )}
              </section>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
