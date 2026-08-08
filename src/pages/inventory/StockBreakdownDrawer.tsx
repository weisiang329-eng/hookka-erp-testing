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
import { X, Package, ArrowDownToLine, ArrowUpFromLine, AlertTriangle, Info } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import type {
  FgLot,
  RmLot,
  StockBreakdown,
  StockItemType,
  StockMovement,
  WipLot,
} from "@/lib/stock-breakdown";

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

function Section({
  title,
  subtitle,
  count,
  children,
}: {
  title: string;
  subtitle?: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-[#E2DDD8] rounded-lg bg-white">
      <header className="px-4 py-2.5 border-b border-[#E2DDD8]">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold text-[#1F1D1B]">{title}</h3>
          {count !== undefined && (
            <span className="text-xs text-[#6B7280] tabular-nums">({count})</span>
          )}
        </div>
        {subtitle && (
          <p className="text-[11px] uppercase tracking-wide text-[#9C6F1E] mt-0.5">
            {subtitle}
          </p>
        )}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

const TH = "px-3 py-2 text-left font-medium text-[#6B7280] whitespace-nowrap";
const THR = `${TH} text-right`;
const TD = "px-3 py-1.5 text-[#1F1D1B] whitespace-nowrap";
const TDR = `${TD} text-right`;

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
    <div className="border border-[#E2DDD8] rounded-lg px-3 py-2 bg-white" title={title}>
      <p className="text-[11px] text-[#6B7280]">{label}</p>
      <p className="text-lg font-semibold text-[#1F1D1B] tabular-nums leading-tight">
        {value}
      </p>
      {sub && <p className="text-[11px] text-[#6B7280] tabular-nums">{sub}</p>}
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
  return (
    <table className="w-full text-xs">
      <thead className="bg-[#FAF8F5]">
        <tr>
          <th className={TH}>Warehouse</th>
          <th className={TH}>Attributes</th>
          <th className={THR}>Qty</th>
          <th className={THR}>Unit cost</th>
          <th className={THR}>Value</th>
          <th className={TH}>Source</th>
          <th className={TH}>Purchase order</th>
          <th className={TH}>Supplier</th>
          <th className={TH}>Received</th>
          <th className={THR}>Age</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#F0EDE9]">
        {lots.length === 0 && (
          <EmptyRow span={10} message="No stock lots for this material." />
        )}
        {lots.map((l) => (
          <tr key={l.id} className={l.qty <= 0 ? "opacity-60" : undefined}>
            <td className={TD}><Txt value={l.warehouse} /></td>
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
            <td className={TD}>
              <span className="text-[#6B7280] mr-1">{l.source}</span>
              <DocLink no={l.grnNo} href={l.grnHref} onNavigate={onNavigate} />
            </td>
            <td className={TD}>
              <DocLink
                no={l.purchaseOrderNo}
                href={l.purchaseOrderHref}
                onNavigate={onNavigate}
              />
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
  return (
    <table className="w-full text-xs">
      <thead className="bg-[#F3F7F3]">
        <tr>
          <th className={TH}>Date</th>
          <th className={TH}>GR no</th>
          <th className={TH}>Supplier</th>
          <th className={TH}>PO no</th>
          <th className={THR}>Qty</th>
          <th className={THR}>Unit cost</th>
          <th className={THR}>Value</th>
          <th className={THR}>Balance</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#F0EDE9]">
        {rows.length === 0 && <EmptyRow span={8} message="No inbound movements." />}
        {rows.map((m) => (
          <tr key={m.id}>
            <td className={TD}><DateCell value={m.date} /></td>
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
            <td className={TDR}><Qty value={m.qty} /></td>
            <td className={TDR}><Money value={m.unitCostSen} /></td>
            <td className={TDR}><Money value={m.totalCostSen} /></td>
            <td className={TDR}><BalanceCell m={m} /></td>
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
  return (
    <table className="w-full text-xs">
      <thead className="bg-[#FBF3F2]">
        <tr>
          <th className={TH}>Date</th>
          <th className={TH}>Production order</th>
          <th className={TH}>Department</th>
          <th className={TH}>Taken by</th>
          <th className={TH}>Job card</th>
          <th className={THR}>Qty</th>
          <th className={THR}>Cost</th>
          <th className={THR}>Balance</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#F0EDE9]">
        {rows.length === 0 && <EmptyRow span={8} message="No outbound movements." />}
        {rows.map((m) => (
          <tr key={m.id}>
            <td className={TD}><DateCell value={m.date} /></td>
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
            <td className={TDR}><Qty value={m.qty} /></td>
            <td className={TDR}><Money value={m.totalCostSen} /></td>
            <td className={TDR}><BalanceCell m={m} /></td>
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
  return (
    <table className="w-full text-xs">
      <thead className="bg-[#F3F7F3]">
        <tr>
          <th className={TH}>Date</th>
          <th className={TH}>Production order</th>
          <th className={TH}>Sales order</th>
          <th className={TH}>Customer</th>
          <th className={THR}>Qty</th>
          <th className={THR}>Unit cost</th>
          <th className={THR}>Balance</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#F0EDE9]">
        {rows.length === 0 && <EmptyRow span={7} message="No inbound movements." />}
        {rows.map((m) => (
          <tr key={m.id}>
            <td className={TD}><DateCell value={m.date} /></td>
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
            <td className={TDR}><Qty value={m.qty} /></td>
            <td className={TDR}><Money value={m.unitCostSen} /></td>
            <td className={TDR}><BalanceCell m={m} /></td>
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
  return (
    <table className="w-full text-xs">
      <thead className="bg-[#FBF3F2]">
        <tr>
          <th className={TH}>Date</th>
          <th className={TH}>DO no</th>
          <th className={TH}>Sales order</th>
          <th className={TH}>Customer</th>
          <th className={THR}>Qty</th>
          <th className={TH}>Unit serials</th>
          <th className={THR}>Balance</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#F0EDE9]">
        {rows.length === 0 && <EmptyRow span={7} message="No outbound movements." />}
        {rows.map((m) => (
          <tr key={m.id}>
            <td className={TD}><DateCell value={m.date} /></td>
            <td className={TD}>
              <DocLink no={m.docNo} href={m.docHref} onNavigate={onNavigate} />
            </td>
            <td className={TD}>
              <DocLink no={m.salesOrderNo} href={m.salesOrderHref} onNavigate={onNavigate} />
            </td>
            <td className={`${TD} max-w-[180px] truncate`} title={m.customerName ?? ""}>
              <Txt value={m.customerName} />
            </td>
            <td className={TDR}><Qty value={m.qty} /></td>
            <td className={`${TD} max-w-[280px] truncate`}>
              <Serials serials={m.unitSerials} />
            </td>
            <td className={TDR}><BalanceCell m={m} /></td>
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
          <th className={THR}>Balance</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#F0EDE9]">
        {rows.length === 0 && <EmptyRow span={8} message="No movements recorded." />}
        {rows.map((m) => (
          <tr key={m.id}>
            <td className={TD}><DateCell value={m.date} /></td>
            <td className={TD}>{m.type}</td>
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
            <td className={TDR}><Qty value={m.qty} /></td>
            <td className={TDR}><Money value={m.totalCostSen} /></td>
            <td className={TDR}><BalanceCell m={m} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// The drawer
// ---------------------------------------------------------------------------
export interface StockBreakdownTarget {
  type: StockItemType;
  itemId: string;
  /** Shown in the header while the fetch is in flight. */
  code: string;
  name?: string;
}

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
        {/* Title bar */}
        <div className="flex items-start justify-between gap-4 px-5 py-3 border-b border-[#E2DDD8] bg-white">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Package className="h-4 w-4 text-[#6B5C32]" />
              <h2 className="text-base font-semibold text-[#1F1D1B] truncate">
                {header?.itemCode || target.code}
              </h2>
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#F0EDE9] text-[#6B7280]">
                {target.type}
              </span>
            </div>
            <p className="text-xs text-[#6B7280] truncate">
              {header?.itemName || target.name || ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[#F0EDE9] text-[#6B7280]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {loading && <p className="text-sm text-[#6B7280]">Loading breakdown…</p>}
          {error && !loading && (
            <Notice tone="warn">{error}</Notice>
          )}

          {header && (
            <>
              {/* 1 — Header stats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat
                  label="Total qty (owned)"
                  value={
                    header.totalQty === null ? <Dash /> : header.totalQty
                  }
                  sub={header.uom || undefined}
                  title={header.qtyNote ?? undefined}
                />
                <Stat
                  label="Assigned / Free"
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

              {header.qtyNote && <Notice tone="info">{header.qtyNote}</Notice>}
              {header.reconciliation.notice && (
                <Notice tone="warn">{header.reconciliation.notice}</Notice>
              )}
              {header.ledgerVsOnHand.note && (
                <Notice tone={header.ledgerVsOnHand.agrees ? "info" : "warn"}>
                  {header.ledgerVsOnHand.note}
                </Notice>
              )}
              {header.valuationNote && (
                <Notice tone="warn">{header.valuationNote}</Notice>
              )}

              {/* 2 — Stock lots.
                  WIP gets a different heading because it has no lots: what it
                  has is the job cards that made the item. Calling those "stock
                  lots" would imply a FIFO layer that does not exist. */}
              <Section
                title={target.type === "WIP" ? "Job cards that made this" : "Stock lots"}
                subtitle={
                  target.type === "WIP"
                    ? "Oldest first — WIP has no cost layers, so these are the work, not lots"
                    : "Oldest first — consumed first on the next DO"
                }
                count={data?.lots.length}
              >
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
              </Section>

              {/* 3 — Movements, newest first, split IN / OUT.
                  WIP is not split: every row is the same kind of event, so a
                  second table headed "Stock issued" holding nothing would read
                  as "nothing has been issued" rather than "issues are not
                  recorded". The notice above says which. */}
              <Section
                title={target.type === "WIP" ? "Movements" : "Movements in"}
                count={target.type === "WIP" ? movements.length : inRows.length}
                subtitle="Newest first"
              >
                {target.type !== "WIP" && (
                  <div className="flex items-center gap-1.5 px-3 pt-2 text-[11px] text-[#3F6B3F]">
                    <ArrowDownToLine className="h-3.5 w-3.5" /> Stock received
                  </div>
                )}
                {target.type === "RM" && <RmInTable rows={inRows} onNavigate={go} />}
                {target.type === "FG" && <FgInTable rows={inRows} onNavigate={go} />}
                {target.type === "WIP" && (
                  <WipMovementsTable rows={movements} onNavigate={go} />
                )}
              </Section>

              {target.type !== "WIP" && (
                <Section
                  title="Movements out"
                  count={outRows.length}
                  subtitle="Newest first"
                >
                  <div className="flex items-center gap-1.5 px-3 pt-2 text-[11px] text-[#9A3A2D]">
                    <ArrowUpFromLine className="h-3.5 w-3.5" /> Stock issued
                  </div>
                  {target.type === "RM" && <RmOutTable rows={outRows} onNavigate={go} />}
                  {target.type === "FG" && <FgOutTable rows={outRows} onNavigate={go} />}
                </Section>
              )}

              {/* 4 — COGS */}
              <Section
                title="COGS — FIFO consumptions"
                count={data?.cogs.length}
              >
                <table className="w-full text-xs">
                  <thead className="bg-[#FAF8F5]">
                    <tr>
                      <th className={TH}>Consumed at</th>
                      <th className={TH}>Source document</th>
                      <th className={THR}>Qty</th>
                      <th className={THR}>Unit cost</th>
                      <th className={THR}>Total</th>
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
              </Section>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
