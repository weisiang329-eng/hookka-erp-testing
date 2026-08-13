// ---------------------------------------------------------------------------
// document-chain-map.tsx — "how does this document connect, and where is it?"
//
// Owner 2026-08-01: 「最好可以看到是谁生产的 然后几号生产 生产流程 然后送货人
// 等等 / 无论是从 SO DO 都可以看到」 and, on the look: 「灰色和有色」.
//
// The visual language does the explaining
// ---------------------------------------
// COLOUR means the document exists. GREY means it doesn't yet — and every grey
// node says WHEN it will ("After confirmation", "On completion"). That single
// rule is what makes the map answer "which part isn't produced yet?" at a
// glance, instead of looking like something failed to load.
//
//   ● teal   linked   — exists, click through
//   ◉ brown  current  — the document you're looking at
//   ○ grey   pending  — not created yet, with the reason
//
// Anchored on the SO, so the DO / Invoice / Service Case pages all render the
// SAME map with their own node highlighted — "open any document and see how it
// connects" without each page rebuilding the chain.
//
// The production strip is expanded by default (owner's call). Each station is a
// DEPARTMENT — job cards are raised per component, so they are rolled up by
// `groupJobCardsByDept` and shown as one tile carrying done/total, who worked
// it, when it finished, and estimate-vs-actual. A station running over its
// estimate is flagged, because the point of showing the flow is to see where it
// is stuck and whose hands it is in.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useCachedJson } from "@/lib/cached-fetch";
import { ChevronDown, ChevronRight, Truck, User } from "lucide-react";
import {
  groupJobCardsByDept,
  prettyDept,
  type JobCard,
} from "@/lib/job-card-stations";

// --- palette ---------------------------------------------------------------
// Matches the app's existing tokens; kept here so a node's meaning and its
// colour are defined in one place.
// Owner 2026-08-02:「这个UI 太软了」— the first pass sat at ~1.4:1 against the
// card, so a wall of stations read as one grey smear. Borders and secondary
// text are pulled darker; the three MEANINGS are unchanged.
const C = {
  linked: { dot: "#2F6E62", border: "#A9CCC3", bg: "#F1F7F5", text: "#1F1D1B" },
  current: { dot: "#6B5C32", border: "#6B5C32", bg: "#F8F2E4", text: "#1F1D1B" },
  pending: { dot: "#C2BDB6", border: "#D5CFC8", bg: "#F7F6F4", text: "#8A8577" },
} as const;

type NodeState = "linked" | "current" | "pending";

type ChainNode = {
  kind: string;
  label: string;
  docNo?: string | null;
  /** Shown under the number — status when it exists, the reason when it doesn't. */
  sub?: string | null;
  state: NodeState;
  href?: string | null;
  /** Shown when the node is tapped but has nothing to open — see Node(). */
  why?: string | null;
};

// A tick for done, a filled ring for current, an empty ring for pending. Studied
// off the Houzs SCM map (DocumentRelationshipMapModal) — a glyph reads faster
// than three shades of the same dot, and it survives being printed in mono.
function StateDot({ state }: { state: NodeState }) {
  const c = C[state];
  if (state === "pending") {
    return (
      <span
        className="inline-block h-4 w-4 rounded-full border"
        style={{ borderColor: c.dot, background: "#fff" }}
      />
    );
  }
  return (
    <span
      className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold text-white"
      style={{ background: c.dot }}
      aria-hidden
    >
      {state === "current" ? "\u25C9" : "\u2713"}
    </span>
  );
}

function Node({ node }: { node: ChainNode }) {
  const c = C[node.state];
  const inner = (
    <div
      className="min-w-[150px] flex-1 rounded-lg px-3 py-2.5 transition-colors"
      style={{
        background: c.bg,
        border: `${node.state === "current" ? 2 : 1}px ${node.state === "pending" ? "dashed" : "solid"} ${c.border}`,
      }}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <StateDot state={node.state} />
        <span
          className="text-[10px] font-medium uppercase tracking-wide"
          style={{ color: node.state === "pending" ? C.pending.text : "#8A8577" }}
        >
          {node.label}
        </span>
      </div>
      <div
        className="truncate text-sm font-semibold"
        style={{ color: c.text }}
        title={node.docNo ?? undefined}
      >
        {node.docNo || "Not created"}
      </div>
      {node.sub && (
        <div className="truncate text-[11px]" style={{ color: "#9A9384" }}>
          {node.sub}
        </div>
      )}
    </div>
  );
  // Houzs SCM's owner rule, adopted verbatim: 「每個點了都要有反應可以看到文件的」
  // — a node the operator can see must ANSWER when tapped. A real document
  // navigates. One that cannot open (a pending step, or a reference that is the
  // customer's own paperwork and not ours) explains itself instead of sitting
  // dead. Silence reads as a broken link; a sentence reads as a system that
  // knows what it is doing.
  if (node.href && node.state !== "pending") {
    return (
      <a
        href={node.href}
        className="flex flex-1 hover:opacity-90"
        title={`Open ${node.docNo}`}
      >
        {inner}
      </a>
    );
  }
  return (
    <button
      type="button"
      className="flex flex-1 text-left"
      title={node.why ?? undefined}
      onClick={() => node.why && window.alert(node.why)}
    >
      {inner}
    </button>
  );
}

function Arrow({ solid }: { solid: boolean }) {
  return (
    <div className="hidden flex-shrink-0 items-center px-1 sm:flex" aria-hidden>
      <svg width="22" height="10" viewBox="0 0 22 10">
        <line
          x1="0"
          y1="5"
          x2="15"
          y2="5"
          stroke={solid ? C.linked.dot : C.pending.dot}
          strokeWidth="1.5"
          strokeDasharray={solid ? undefined : "3 3"}
        />
        <path
          d="M15 1 L21 5 L15 9 Z"
          fill={solid ? C.linked.dot : C.pending.dot}
        />
      </svg>
    </div>
  );
}

// --- production ------------------------------------------------------------

function StationStrip({ poId }: { poId: string }) {
  // Fetched only when the production order is expanded — a SO can carry several
  // POs of 6-8 cards each, and pulling every one up front would cost more than
  // it shows.
  const { data, loading, failure } = useCachedJson<{ success?: boolean; data?: { jobCards?: JobCard[] } }>(
    `/api/production-orders/${poId}`,
  );
  const stations = useMemo(
    () => groupJobCardsByDept(data?.data?.jobCards ?? []),
    [data],
  );
  // "No job cards yet" is a statement about the shop floor. Make it only when
  // the read actually landed — a timeout used to render it identically
  // (BUG-2026-08-13-016).
  if (stations.length === 0 && !data && failure) {
    return (
      <div className="px-3 py-2 text-xs text-[#9A3A2D]">
        Couldn&apos;t load this production order&apos;s job cards — {failure.message}
      </div>
    );
  }
  if (stations.length === 0 && !data && loading) {
    return (
      <div className="px-3 py-2 text-xs text-[#9CA3AF]">Loading job cards…</div>
    );
  }
  if (stations.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-[#9CA3AF]">
        No job cards on this production order yet.
      </div>
    );
  }
  return (
    // A GRID, not flex-wrap: the stations are a route of equal steps, and
    // ragged widths made them read as unrelated chips with one stranded on its
    // own line. Equal columns line the route up.
    <div className="grid grid-cols-2 gap-1.5 px-3 pb-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
      {stations.map((s) => {
        const c = C[s.state];
        const who = s.who.join(", ");
        // Only worth flagging once the station actually finished — a station
        // still running hasn't had its chance yet.
        const over =
          s.state === "linked" && s.estMinutes > 0 && s.actualMinutes > s.estMinutes;
        return (
          <a
            key={s.code}
            href={`/production/${poId}`}
            className="block rounded-md px-2.5 py-2 hover:opacity-90"
            style={{
              background: c.bg,
              border: `1px ${s.state === "pending" ? "dashed" : "solid"} ${c.border}`,
            }}
            title={`${s.name} — ${s.done}/${s.total} job card(s) done`}
          >
            <div className="mb-0.5 flex items-center gap-1.5">
              <StateDot state={s.state} />
              <span
                className="truncate text-[11px] font-semibold"
                style={{ color: s.state === "pending" ? C.pending.text : "#1F1D1B" }}
              >
                {s.name}
              </span>
              {/* The roll-up must stay honest about what it merged — an
                  operator who sees one tile still needs to know it stands for
                  four cards. */}
              {s.total > 1 && (
                <span
                  className="ml-auto flex-shrink-0 rounded px-1 text-[10px] font-semibold"
                  style={{ background: "#fff", color: c.dot, border: `1px solid ${c.border}` }}
                >
                  {s.done}/{s.total}
                </span>
              )}
            </div>
            <div className="text-[10px]" style={{ color: "#8A8577" }}>
              {s.state === "linked"
                ? s.completedDate || "done"
                : s.state === "current"
                  ? `in progress${s.done > 0 ? ` · ${s.done} done` : ""}`
                  : "waiting"}
            </div>
            {who && (
              <div className="flex items-center gap-1 truncate text-[10px] text-[#6B7280]">
                <User className="h-2.5 w-2.5 flex-shrink-0" />
                <span className="truncate">{who}</span>
              </div>
            )}
            {s.estMinutes > 0 && (
              <div
                className="text-[10px]"
                style={{ color: over ? "#9A3A2D" : "#8A8577" }}
              >
                {s.actualMinutes > 0 ? `${s.actualMinutes}m` : "—"} / est{" "}
                {s.estMinutes}m{over ? " ⚠" : ""}
              </div>
            )}
          </a>
        );
      })}
    </div>
  );
}

// --- payload ---------------------------------------------------------------

type LinkedPO = {
  id: string;
  poNo: string;
  productName?: string;
  quantity?: number;
  status?: string;
  progress?: number;
  currentDepartment?: string;
  completedDate?: string | null;
  /** Distinct worker names off the scanned job cards — "who produced it". */
  completedBy?: string | null;
  deliveryDoNo?: string;
};

interface ChainResp {
  success?: boolean;
  data?: { id: string; companySOId?: string; status?: string; customerPOId?: string };
  linkedPOs?: LinkedPO[];
  linkedDOs?: { id: string; doNo: string; status: string; driverName?: string | null }[];
  linkedInvoices?: { id: string; invoiceNo: string; status: string }[];
  linkedPayments?: { id: string; receiptNumber: string; status: string }[];
}

export function DocumentChainMap({
  soId,
  currentDocNo,
}: {
  soId?: string | null;
  currentDocNo?: string;
}) {
  const { data } = useCachedJson<ChainResp>(
    soId ? `/api/sales-orders/${soId}` : null,
  );
  const [openPOs, setOpenPOs] = useState<Record<string, boolean>>({});

  const chain = useMemo(() => {
    if (!data?.success || !data.data) return null;
    const so = data.data;
    const soNo = so.companySOId ?? "";
    const dos = data.linkedDOs ?? [];
    const invs = data.linkedInvoices ?? [];
    const pays = data.linkedPayments ?? [];
    const cur = (no?: string | null) =>
      !!currentDocNo && !!no && currentDocNo === no;

    const nodes: ChainNode[] = [
      {
        kind: "CPO",
        label: "Customer PO",
        docNo: so.customerPOId || null,
        sub: so.customerPOId ? "From the customer" : "—",
        state: so.customerPOId ? "linked" : "pending",
        // The customer's PO is THEIR document — we store the reference, never a
        // file. Saying so beats a dead tap on a node that looks linked.
        why: so.customerPOId
          ? `${so.customerPOId} is the customer's own reference for this order. It is their document, not ours, so there is no file here to open.`
          : "No customer PO reference was recorded on this order.",
      },
      {
        kind: "SO",
        label: "Sales Order",
        docNo: soNo,
        sub: cur(soNo) ? "This document" : (so.status ?? null),
        state: cur(soNo) ? "current" : "linked",
        href: `/sales/${so.id}`,
      },
      {
        kind: "DO",
        label: "Delivery Order",
        docNo: dos[0]?.doNo ?? null,
        // The driver is the answer to "who delivered it", so it belongs on the
        // node rather than buried in the DO page.
        sub: dos[0]
          ? [dos[0].status, dos[0].driverName].filter(Boolean).join(" · ")
          : "After confirmation",
        why: dos[0]
          ? null
          : "No delivery order yet. One is created once this sales order is confirmed and the goods are ready to ship.",
        state: dos[0] ? (cur(dos[0].doNo) ? "current" : "linked") : "pending",
        href: dos[0] ? `/delivery/${dos[0].id}` : null,
      },
      {
        kind: "INV",
        label: "Sales Invoice",
        docNo: invs[0]?.invoiceNo ?? null,
        sub: invs[0] ? invs[0].status : "On delivery",
        why: invs[0]
          ? null
          : "No invoice yet. One is raised from the delivery order once the goods have gone out.",
        state: invs[0] ? (cur(invs[0].invoiceNo) ? "current" : "linked") : "pending",
        href: invs[0] ? `/invoices/${invs[0].id}` : null,
      },
      {
        kind: "PAY",
        label: "Payment",
        docNo: pays[0]?.receiptNumber ?? null,
        sub: pays[0] ? pays[0].status : "On settlement",
        state: pays[0] ? "linked" : "pending",
        why: pays[0]
          ? null
          : "No payment recorded yet. Payments appear here once they are allocated against this order's invoice.",
      },
    ];
    return { nodes, pos: data.linkedPOs ?? [], extraDOs: dos.slice(1) };
  }, [data, currentDocNo]);

  if (!soId || !chain) return null;

  return (
    <div className="rounded-xl border border-[#E2DDD8] bg-white p-4">
      <div className="mb-1 text-sm font-semibold text-[#1F1D1B]">
        Relationship map
      </div>
      <p className="mb-3 text-xs text-[#8A8577]">
        How this document links to its sources and everything generated
        downstream. Grey means not created yet — the caption says when it will be.
      </p>

      {/* ── document chain ── */}
      <div className="rounded-lg border border-dashed border-[#E2DDD8] bg-[#FCFBF9] p-3">
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-[#9A9384]">
          Sales chain
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
          {chain.nodes.map((n, i) => (
            <div key={n.kind} className="flex flex-1 items-stretch">
              {i > 0 && <Arrow solid={n.state !== "pending"} />}
              <Node node={n} />
            </div>
          ))}
        </div>
      </div>

      {/* ── production ── */}
      {chain.pos.length > 0 && (
        <div className="mt-3 rounded-lg border border-dashed border-[#E2DDD8] bg-[#FCFBF9] p-3">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-[#9A9384]">
            Production — {chain.pos.length} order
            {chain.pos.length !== 1 ? "s" : ""}
          </div>
          <div className="space-y-2">
            {chain.pos.map((po) => {
              const done = (po.status ?? "").toUpperCase() === "COMPLETED";
              const state: NodeState = done
                ? "linked"
                : (po.progress ?? 0) > 0
                  ? "current"
                  : "pending";
              const c = C[state];
              // Expanded by default (owner's call) — the stations are the point.
              const open = openPOs[po.id] ?? true;
              return (
                <div
                  key={po.id}
                  className="rounded-lg"
                  style={{ background: c.bg, border: `1px solid ${c.border}` }}
                >
                  {/* TWO rows, not one. Owner 2026-08-02:「这个排版也是不好看
                      啊」— a finished order carries a dozen worker names, and
                      on one row that list (flex-shrink-0) crushed the PO number
                      into four wrapped lines. The identity line is now
                      unbreakable and the names sit under it, where a long list
                      costs nothing. */}
                  <div className="px-3 py-2 text-left">
                    <div className="flex w-full items-center gap-2">
                      {/* Expand and open are SEPARATE targets on purpose: the
                          row is both a disclosure and a link, and one click
                          cannot mean both — merging them would navigate away
                          every time the operator tried to see the stations. */}
                      <button
                        type="button"
                        onClick={() =>
                          setOpenPOs((p) => ({ ...p, [po.id]: !(p[po.id] ?? true) }))
                        }
                        aria-label={open ? "Collapse stations" : "Expand stations"}
                        className="flex-shrink-0 text-[#6B7280] hover:text-[#1F1D1B]"
                      >
                        {open ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <StateDot state={state} />
                      <a
                        href={`/production/${po.id}`}
                        className="flex-shrink-0 whitespace-nowrap text-sm font-semibold text-[#1F1D1B] hover:underline"
                        title={`Open production order ${po.poNo}`}
                      >
                        {po.poNo}
                      </a>
                      {/* The product is what gives way when space runs out —
                          min-w-0 is what lets truncate actually engage inside a
                          flex row. */}
                      <span className="min-w-0 flex-1 truncate text-xs text-[#6B7280]">
                        {po.productName}
                        {po.quantity ? ` × ${po.quantity}` : ""}
                      </span>
                      <span className="flex flex-shrink-0 items-center gap-3 whitespace-nowrap text-xs">
                        {po.deliveryDoNo && (
                          <span className="flex items-center gap-1 text-[#6B7280]">
                            <Truck className="h-3 w-3" />
                            {po.deliveryDoNo}
                          </span>
                        )}
                        <span
                          className="font-medium"
                          style={{ color: state === "pending" ? "#9CA3AF" : "#1F1D1B" }}
                        >
                          {/* `currentDepartment` is the raw code (`WOOD_CUT`).
                              Owner 2026-08-02:「为什么show fab cut呢」— the code
                              is internal, and next to the station names it reads
                              like a different thing entirely. */}
                          {done
                            ? po.completedDate || "Completed"
                            : po.currentDepartment
                              ? `At ${prettyDept(po.currentDepartment)}`
                              : "Not started"}
                        </span>
                      </span>
                    </div>
                    {po.completedBy && (
                      <div
                        className="mt-1 flex items-start gap-1 pl-[38px] text-[11px] text-[#6B7280]"
                        title={po.completedBy}
                      >
                        <User className="mt-0.5 h-3 w-3 flex-shrink-0" />
                        <span className="line-clamp-2">{po.completedBy}</span>
                      </div>
                    )}
                  </div>
                  {open && <StationStrip poId={po.id} />}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── extra DOs (a SO can ship in several drops) ── */}
      {chain.extraDOs.length > 0 && (
        <div className="mt-3 rounded-lg border border-dashed border-[#E2DDD8] bg-[#FCFBF9] p-3">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-[#9A9384]">
            Further deliveries
          </div>
          <div className="flex flex-wrap gap-2">
            {chain.extraDOs.map((d) => (
              <a
                key={d.id}
                href={`/delivery/${d.id}`}
                className="rounded-md px-3 py-2 text-xs"
                style={{
                  background: C.linked.bg,
                  border: `1px solid ${C.linked.border}`,
                }}
              >
                <span className="font-semibold text-[#1F1D1B]">{d.doNo}</span>
                <span className="ml-2 text-[#6B7280]">
                  {[d.status, d.driverName].filter(Boolean).join(" · ")}
                </span>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* ── legend ── */}
      <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-[#8A8577]">
        <span className="flex items-center gap-1.5">
          <StateDot state="linked" /> Linked
        </span>
        <span className="flex items-center gap-1.5">
          <StateDot state="current" /> Current / in progress
        </span>
        <span className="flex items-center gap-1.5">
          <StateDot state="pending" /> Not created yet
        </span>
      </div>
    </div>
  );
}

export default DocumentChainMap;
