// ---------------------------------------------------------------------------
// delivery-agent.ts — the Delivery Agent (TMS), per docs/AGENTS-BLUEPRINT.md.
//
// Mission (owner JD): manage the full delivery lifecycle — pending delivery →
// load/dispatch planning → delivered (POD tracking) → invoice (close the
// missed-invoice loop) → delivery return. PROPOSAL-FIRST: nothing in this
// file writes to delivery_orders / sales_orders / invoices. The agent only:
//
//   1. collectDeliveryBrief  — today's delivery picture (READY_TO_SHIP pool
//      by state/hub, DO pipeline, overdue-to-ship, missing PODs, delivered-
//      not-invoiced, open service cases, 3PL learning summary).
//   2. generateDeliveryProposals — writes PENDING rows into the
//      delivery_proposals table: LOAD_PLAN (state+hub buckets honoring the
//      PL-first one-DO-per-customer-per-hub rule, costed against the 3PL
//      state-rate card), INVOICE_GAP (delivered DO with no invoice) and
//      POD_CHASE (delivered >24h with no POD/signature).
//   3. deliveryLearning — per-3PL on-time rate + actual freight
//      (delivery_orders.deliveryCostSen) vs the state-rate card.
//
// Red lines (JD, enforced structurally):
//   - Approval does NOT auto-create DOs in v1 — it only marks the plan
//     APPROVED for the office to execute (see routes/delivery-agent.ts).
//   - CNs are NEVER invoiced — this module reads delivery_orders only and
//     never touches consignment_notes, so a CN can never appear in an
//     INVOICE_GAP proposal.
//   - Never modifies INVOICED documents (no document writes at all).
//   - Hub integrity: load-plan buckets key on (state, hub) and drop counts
//     honor the PL-first one-DO-per-(customer, hub) rule.
//
// Schema rules: new tables are snake_case-only (no column-rename-map entry
// needed) and runtime self-applied (migration files do NOT replay on deploy).
// Every row read is dual-keyed (r.camelCase ?? r.snake_case) because the
// db-pg adapter folds snake_case result columns to camelCase.
// Money is integer sen everywhere.
// ---------------------------------------------------------------------------

import { resolveStateCode } from "../../lib/malaysia-states";
import { loadHubStateMap } from "../routes/delivery-orders";
import { loadDoValueMap } from "./do-value";

// D1-compat DB shape (matches the SupabaseAdapter used across routes).
interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

// ── Runtime self-apply (schedule-proposals.ts pattern) ───────────────────────

let _agentMig: Promise<void> | null = null;
export function ensureDeliveryAgentTables(db: DbLike): Promise<void> {
  if (_agentMig) return _agentMig;
  _agentMig = (async () => {
    const stmts = [
      `CREATE TABLE IF NOT EXISTS delivery_proposals (
         id TEXT PRIMARY KEY,
         generated_at TEXT NOT NULL,
         kind TEXT NOT NULL,
         so_refs TEXT,
         state TEXT,
         hub TEXT,
         items_count INTEGER NOT NULL DEFAULT 0,
         value_sen INTEGER NOT NULL DEFAULT 0,
         three_pl_cost_sen INTEGER NOT NULL DEFAULT 0,
         recommendation TEXT,
         status TEXT NOT NULL DEFAULT 'PENDING',
         decided_at TEXT,
         decided_by TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_delivery_proposals_status
         ON delivery_proposals(status, generated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_delivery_proposals_kind
         ON delivery_proposals(kind, status)`,
      // Daily brief snapshots for the cron run (latest per date wins on read).
      `CREATE TABLE IF NOT EXISTS delivery_briefs (
         id TEXT PRIMARY KEY,
         date TEXT NOT NULL,
         taken_at TEXT NOT NULL,
         payload TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_delivery_briefs_date
         ON delivery_briefs(date, taken_at DESC)`,
    ];
    for (const sql of stmts) {
      try {
        await db.prepare(sql).bind().run();
      } catch (err) {
        console.warn("[delivery-agent.migrations] DDL skipped", {
          sql: sql.split("\n")[0],
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  })();
  return _agentMig;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function s(v: unknown): string {
  return v == null ? "" : String(v);
}
function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/** Whole days elapsed from an ISO/YMD timestamp to todayYmd (>= 0). */
function daysBetween(fromIso: string, todayYmd: string): number {
  if (!fromIso) return 0;
  const from = new Date(fromIso.slice(0, 10) + "T00:00:00Z").getTime();
  const today = new Date(todayYmd + "T00:00:00Z").getTime();
  if (Number.isNaN(from)) return 0;
  return Math.max(0, Math.floor((today - from) / 86400000));
}

/** todayYmd minus N days as an ISO cutoff "YYYY-MM-DDT00:00:00". */
function isoCutoff(todayYmd: string, days: number): string {
  const d = new Date(todayYmd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10) + "T00:00:00";
}

// ── READY_TO_SHIP pool (SOs ready but with NO delivery order yet) ────────────
//
// Same "has a DO" definition as GET /api/delivery-orders/pending-sos: linked
// via delivery_orders.salesOrderId OR via any item's production order, across
// non-cancelled DOs. Restricted to READY_TO_SHIP (the dispatchable pool).

type PoolRow = {
  id: string;
  companySOId?: string | null;
  customerId?: string | null;
  customerName?: string | null;
  customerState?: string | null;
  hubId?: string | null;
  hubName?: string | null;
  hookkaExpectedDD?: string | null;
  customerDeliveryDate?: string | null;
  totalSen?: number | string | null;
  // snake_case fallbacks (db-pg fold)
  company_so_id?: string | null;
  customer_id?: string | null;
  customer_name?: string | null;
  customer_state?: string | null;
  hub_id?: string | null;
  hub_name?: string | null;
  hookka_expected_dd?: string | null;
  customer_delivery_date?: string | null;
  total_sen?: number | string | null;
};

export interface PoolSo {
  soId: string;
  soNo: string;
  customerId: string;
  customerName: string;
  /** Canonical MALAYSIA_STATES code, or "UNKNOWN" when unresolvable. */
  stateCode: string;
  hubId: string;
  hubName: string;
  /** hookkaExpectedDD, falling back to customerDeliveryDate. */
  dueDate: string;
  valueSen: number;
}

async function loadReadyPool(db: DbLike, orgId: string): Promise<PoolSo[]> {
  const res = await db
    .prepare(
      `SELECT id, companySOId, customerId, customerName, customerState,
              hubId, hubName, hookkaExpectedDD, customerDeliveryDate, totalSen
         FROM sales_orders
        WHERE orgId = ?
          AND status = 'READY_TO_SHIP'
          AND id NOT IN (
            SELECT salesOrderId FROM delivery_orders
              WHERE orgId = ? AND salesOrderId IS NOT NULL AND salesOrderId <> ''
                AND status <> 'CANCELLED'
            UNION
            SELECT DISTINCT po.salesOrderId
              FROM delivery_order_items doi
              JOIN delivery_orders d ON d.id = doi.deliveryOrderId
              JOIN production_orders po ON po.id = doi.productionOrderId
             WHERE d.status <> 'CANCELLED'
               AND po.salesOrderId IS NOT NULL AND po.salesOrderId <> ''
          )
        ORDER BY hookkaExpectedDD ASC`,
    )
    .bind(orgId, orgId)
    .all<PoolRow>();

  const rows = res.results ?? [];
  // Resolve hub state for SOs whose customerState is blank but a hub is set.
  const hubIds = rows.map((r) => s(r.hubId ?? r.hub_id));
  const hubStates = await loadHubStateMap(
    db as never,
    hubIds.filter(Boolean),
  ).catch(() => new Map<string, string>());

  return rows.map((r) => {
    const hubId = s(r.hubId ?? r.hub_id);
    const rawState =
      s(r.customerState ?? r.customer_state) || (hubStates.get(hubId) ?? "");
    return {
      soId: s(r.id),
      soNo: s(r.companySOId ?? r.company_so_id),
      customerId: s(r.customerId ?? r.customer_id),
      customerName: s(r.customerName ?? r.customer_name),
      stateCode: resolveStateCode(rawState) ?? (rawState ? rawState : "UNKNOWN"),
      hubId,
      hubName: s(r.hubName ?? r.hub_name),
      dueDate:
        s(r.hookkaExpectedDD ?? r.hookka_expected_dd) ||
        s(r.customerDeliveryDate ?? r.customer_delivery_date),
      valueSen: Math.round(n(r.totalSen ?? r.total_sen)),
    };
  });
}

// ── Delivered-not-invoiced + POD-missing (compliance query shapes) ───────────
//
// Same shape as compliance-report.ts checkDoNotInvoiced — kept as a thin local
// query (that module's row type carries report-specific fields) but the
// definition is identical: DELIVERED, deliveredAt past the grace cutoff, no
// invoices row pointing at the DO. CN documents live in consignment_notes and
// are structurally excluded (CNs are never invoiced — red line).

export interface DoGapRow {
  doId: string;
  doNo: string;
  customerName: string;
  customerState: string;
  hubId: string;
  hubName: string;
  deliveredAt: string;
  daysSinceDelivered: number;
}

type DoRow = Record<string, unknown>;

function doRowToGap(r: DoRow, todayYmd: string): DoGapRow {
  const deliveredAt = s(r.deliveredAt ?? r.delivered_at).slice(0, 10);
  return {
    doId: s(r.id),
    doNo: s(r.doNo ?? r.do_no),
    customerName: s(r.customerName ?? r.customer_name),
    customerState: s(r.customerState ?? r.customer_state),
    hubId: s(r.hubId ?? r.hub_id),
    hubName: s(r.hubName ?? r.hub_name),
    deliveredAt,
    daysSinceDelivered: daysBetween(deliveredAt, todayYmd),
  };
}

async function loadDeliveredNotInvoiced(
  db: DbLike,
  orgId: string,
  todayYmd: string,
  graceDays = 1,
): Promise<DoGapRow[]> {
  const cutoff = isoCutoff(todayYmd, graceDays);
  const res = await db
    .prepare(
      `SELECT id, doNo, customerName, customerState, hubId, hubName, deliveredAt
         FROM delivery_orders
        WHERE orgId = ?
          AND status = 'DELIVERED'
          AND deliveredAt IS NOT NULL AND deliveredAt <> ''
          AND deliveredAt < ?
        ORDER BY deliveredAt ASC`,
    )
    .bind(orgId, cutoff)
    .all<DoRow>();
  const dos = res.results ?? [];
  if (dos.length === 0) return [];

  const doIds = dos.map((d) => s(d.id));
  const ph = doIds.map(() => "?").join(",");
  const invRes = await db
    .prepare(
      `SELECT deliveryOrderId FROM invoices
        WHERE deliveryOrderId IN (${ph})
          AND deliveryOrderId IS NOT NULL AND deliveryOrderId <> ''
          AND status <> 'CANCELLED'`,
    )
    .bind(...doIds)
    .all<DoRow>();
  const invoiced = new Set<string>();
  for (const r of invRes.results ?? []) {
    const id = s(r.deliveryOrderId ?? r.delivery_order_id);
    if (id) invoiced.add(id);
  }
  return dos
    .filter((d) => !invoiced.has(s(d.id)))
    .map((d) => doRowToGap(d, todayYmd));
}

// DOs physically delivered >24h ago with neither a POD photo nor a signature.
async function loadPodMissing(
  db: DbLike,
  orgId: string,
  todayYmd: string,
): Promise<DoGapRow[]> {
  const cutoff = isoCutoff(todayYmd, 1); // "> 24h" at day granularity
  const res = await db
    .prepare(
      `SELECT id, doNo, customerName, customerState, hubId, hubName, deliveredAt
         FROM delivery_orders
        WHERE orgId = ?
          AND status IN ('DELIVERED','INVOICED')
          AND deliveredAt IS NOT NULL AND deliveredAt <> ''
          AND deliveredAt < ?
          AND (proofOfDelivery IS NULL OR proofOfDelivery = '')
          AND (signedAt IS NULL OR signedAt = '')
        ORDER BY deliveredAt ASC`,
    )
    .bind(orgId, cutoff)
    .all<DoRow>();
  return (res.results ?? []).map((d) => doRowToGap(d, todayYmd));
}

// ── 3PL state-rate card (read-side) ──────────────────────────────────────────

interface StateRate {
  providerId: string;
  providerName: string;
  tripSen: number;
  extraDropSen: number;
}

/** state code → rates of every provider that quoted it (tripSen > 0). */
async function loadStateRateCard(
  db: DbLike,
  orgId: string,
): Promise<Map<string, StateRate[]>> {
  const map = new Map<string, StateRate[]>();
  try {
    const res = await db
      .prepare(
        `SELECT r.providerId AS providerId, r.state AS state,
                r.ratePerTripSen AS ratePerTripSen,
                r.ratePerExtraDropSen AS ratePerExtraDropSen,
                d.name AS providerName, d.status AS providerStatus
           FROM three_pl_state_rates r
           JOIN drivers d ON d.id = r.providerId
          WHERE r.orgId = ?`,
      )
      .bind(orgId)
      .all<DoRow>();
    for (const r of res.results ?? []) {
      const status = s(r.providerStatus ?? r.providerstatus ?? r.status).toUpperCase();
      if (status && status !== "ACTIVE") continue;
      const tripSen = Math.round(n(r.ratePerTripSen ?? r.rate_per_trip_sen));
      if (tripSen <= 0) continue; // 0/0 = unset (house rule) — not a quote
      const state = s(r.state);
      const entry: StateRate = {
        providerId: s(r.providerId ?? r.provider_id),
        providerName: s(r.providerName ?? r.providername ?? r.name),
        tripSen,
        extraDropSen: Math.round(n(r.ratePerExtraDropSen ?? r.rate_per_extra_drop_sen)),
      };
      const arr = map.get(state);
      if (arr) arr.push(entry);
      else map.set(state, [entry]);
    }
  } catch (err) {
    // Rate table not self-applied yet on this environment — cost = unknown.
    console.warn("[delivery-agent] state-rate card unavailable:", err);
  }
  return map;
}

function cheapestForState(
  card: Map<string, StateRate[]>,
  stateCode: string,
  drops: number,
): { rate: StateRate; costSen: number } | null {
  const rates = card.get(stateCode);
  if (!rates || rates.length === 0) return null;
  let best: { rate: StateRate; costSen: number } | null = null;
  for (const r of rates) {
    const costSen = r.tripSen + Math.max(0, drops - 1) * r.extraDropSen;
    if (!best || costSen < best.costSen) best = { rate: r, costSen };
  }
  return best;
}

// ── Learning loop — per-3PL on-time rate + actual freight vs rate card ───────

export interface ProviderLearningRow {
  providerId: string;
  providerName: string;
  /** Delivered trips in the window. */
  trips: number;
  /** Trips that had a planned deliveryDate to measure against. */
  ratedOnTime: number;
  onTimeTrips: number;
  /** null when no trip had a planned date. */
  onTimePct: number | null;
  /** Trips carrying a captured actual cost (deliveryCostSen > 0). */
  costedTrips: number;
  actualFreightSen: number;
  /** Rate-card expectation for the SAME costed trips (0 when no rate). */
  cardFreightSen: number;
  /** actual − card, over the costed trips. */
  varianceSen: number;
}

export async function deliveryLearning(
  db: DbLike,
  orgId: string,
  todayYmd: string,
  windowDays = 90,
): Promise<ProviderLearningRow[]> {
  const cutoff = isoCutoff(todayYmd, windowDays);
  const res = await db
    .prepare(
      `SELECT id, driverId, driverName, customerState, hubId, deliveryDate,
              deliveredAt, deliveryCostSen, dropPoints
         FROM delivery_orders
        WHERE orgId = ?
          AND status IN ('DELIVERED','INVOICED')
          AND driverId IS NOT NULL AND driverId <> ''
          AND deliveredAt IS NOT NULL AND deliveredAt <> ''
          AND deliveredAt >= ?`,
    )
    .bind(orgId, cutoff)
    .all<DoRow>();
  const rows = res.results ?? [];
  if (rows.length === 0) return [];

  const hubStates = await loadHubStateMap(
    db as never,
    rows.map((r) => s(r.hubId ?? r.hub_id)).filter(Boolean),
  ).catch(() => new Map<string, string>());

  // Full card including inactive providers — historical trips may belong to a
  // provider that has since been deactivated; their card row still prices them.
  const rateByProviderState = new Map<string, { tripSen: number; extraDropSen: number }>();
  try {
    const rateRes = await db
      .prepare(
        `SELECT providerId, state, ratePerTripSen, ratePerExtraDropSen
           FROM three_pl_state_rates WHERE orgId = ?`,
      )
      .bind(orgId)
      .all<DoRow>();
    for (const r of rateRes.results ?? []) {
      const tripSen = Math.round(n(r.ratePerTripSen ?? r.rate_per_trip_sen));
      if (tripSen <= 0) continue;
      rateByProviderState.set(
        `${s(r.providerId ?? r.provider_id)}\u0000${s(r.state)}`,
        {
          tripSen,
          extraDropSen: Math.round(n(r.ratePerExtraDropSen ?? r.rate_per_extra_drop_sen)),
        },
      );
    }
  } catch {
    /* rate table absent — card comparison stays 0 */
  }

  const byProvider = new Map<string, ProviderLearningRow>();
  for (const r of rows) {
    const providerId = s(r.driverId ?? r.driver_id);
    if (!providerId) continue;
    let agg = byProvider.get(providerId);
    if (!agg) {
      agg = {
        providerId,
        providerName: s(r.driverName ?? r.driver_name) || providerId,
        trips: 0,
        ratedOnTime: 0,
        onTimeTrips: 0,
        onTimePct: null,
        costedTrips: 0,
        actualFreightSen: 0,
        cardFreightSen: 0,
        varianceSen: 0,
      };
      byProvider.set(providerId, agg);
    }
    agg.trips += 1;

    const planned = s(r.deliveryDate ?? r.delivery_date).slice(0, 10);
    const actual = s(r.deliveredAt ?? r.delivered_at).slice(0, 10);
    if (planned && actual) {
      agg.ratedOnTime += 1;
      if (actual <= planned) agg.onTimeTrips += 1;
    }

    const costSen = Math.round(n(r.deliveryCostSen ?? r.delivery_cost_sen));
    if (costSen > 0) {
      agg.costedTrips += 1;
      agg.actualFreightSen += costSen;
      const hubId = s(r.hubId ?? r.hub_id);
      const rawState = s(r.customerState ?? r.customer_state) || (hubStates.get(hubId) ?? "");
      const stateCode = resolveStateCode(rawState);
      if (stateCode) {
        const rate = rateByProviderState.get(`${providerId}\u0000${stateCode}`);
        if (rate) {
          const drops = Math.max(1, Math.round(n(r.dropPoints ?? r.drop_points)) || 1);
          agg.cardFreightSen += rate.tripSen + (drops - 1) * rate.extraDropSen;
        }
      }
    }
  }

  const out = [...byProvider.values()];
  for (const p of out) {
    p.onTimePct =
      p.ratedOnTime > 0 ? Math.round((p.onTimeTrips / p.ratedOnTime) * 100) : null;
    p.varianceSen = p.actualFreightSen - p.cardFreightSen;
  }
  out.sort((a, b) => b.trips - a.trips);
  return out;
}

// ── Brief (read-only, never throws per-section) ──────────────────────────────

export interface StateBucketSummary {
  stateCode: string;
  hubName: string;
  count: number;
  valueSen: number;
}

export interface DeliveryBriefData {
  date: string;
  generatedAtIso: string;
  pool: {
    count: number;
    valueSen: number;
    byStateHub: StateBucketSummary[];
  };
  overdueToShip: {
    count: number;
    valueSen: number;
    rows: Array<PoolSo & { daysLate: number }>;
  };
  doPipeline: {
    byStatus: Record<string, number>;
  };
  invoiceGaps: { count: number; rows: DoGapRow[] };
  podChases: { count: number; rows: DoGapRow[] };
  returns: { openServiceCases: number };
  proposals: { pendingByKind: Record<string, number>; pending: number };
  learning: ProviderLearningRow[];
}

async function collectDoStatusCounts(
  db: DbLike,
  orgId: string,
): Promise<Record<string, number>> {
  const res = await db
    .prepare("SELECT status FROM delivery_orders WHERE orgId = ?")
    .bind(orgId)
    .all<{ status: string }>();
  const byStatus: Record<string, number> = {};
  for (const r of res.results ?? []) {
    const st = s(r.status) || "UNKNOWN";
    byStatus[st] = (byStatus[st] ?? 0) + 1;
  }
  return byStatus;
}

async function collectOpenServiceCases(db: DbLike): Promise<number> {
  try {
    const r = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM service_cases WHERE status IN ('OPEN','IN_PROGRESS')",
      )
      .bind()
      .first<{ n: number | string }>();
    return n(r?.n);
  } catch {
    return 0; // table absent — best-effort section
  }
}

async function collectPendingProposalCounts(
  db: DbLike,
): Promise<{ pendingByKind: Record<string, number>; pending: number }> {
  try {
    const res = await db
      .prepare(
        `SELECT kind, COUNT(*) AS n FROM delivery_proposals
          WHERE status = 'PENDING' GROUP BY kind`,
      )
      .bind()
      .all<{ kind: string; n: number | string }>();
    const pendingByKind: Record<string, number> = {};
    let pending = 0;
    for (const r of res.results ?? []) {
      const k = s(r.kind) || "UNKNOWN";
      const c = n(r.n);
      pendingByKind[k] = c;
      pending += c;
    }
    return { pendingByKind, pending };
  } catch {
    return { pendingByKind: {}, pending: 0 };
  }
}

export async function collectDeliveryBrief(
  db: DbLike,
  orgId: string,
  todayYmd: string,
): Promise<DeliveryBriefData> {
  await ensureDeliveryAgentTables(db);

  const [pool, byStatus, invoiceGaps, podChases, openServiceCases, proposals, learning] =
    await Promise.all([
      loadReadyPool(db, orgId).catch((err) => {
        console.error("[delivery-agent] pool failed:", err);
        return [] as PoolSo[];
      }),
      collectDoStatusCounts(db, orgId).catch(() => ({}) as Record<string, number>),
      loadDeliveredNotInvoiced(db, orgId, todayYmd).catch((err) => {
        console.error("[delivery-agent] invoiceGaps failed:", err);
        return [] as DoGapRow[];
      }),
      loadPodMissing(db, orgId, todayYmd).catch((err) => {
        console.error("[delivery-agent] podChases failed:", err);
        return [] as DoGapRow[];
      }),
      collectOpenServiceCases(db),
      collectPendingProposalCounts(db),
      deliveryLearning(db, orgId, todayYmd).catch((err) => {
        console.error("[delivery-agent] learning failed:", err);
        return [] as ProviderLearningRow[];
      }),
    ]);

  // Aggregate pool by (state, hub) — largest value first.
  const bucketMap = new Map<string, StateBucketSummary>();
  let poolValueSen = 0;
  for (const so of pool) {
    poolValueSen += so.valueSen;
    const key = `${so.stateCode}\u0000${so.hubName}`;
    const b =
      bucketMap.get(key) ??
      ({ stateCode: so.stateCode, hubName: so.hubName, count: 0, valueSen: 0 } as StateBucketSummary);
    b.count += 1;
    b.valueSen += so.valueSen;
    bucketMap.set(key, b);
  }
  const byStateHub = [...bucketMap.values()].sort((a, b) => b.valueSen - a.valueSen);

  // Overdue-to-ship: ready, no DO, and the promised date is already past.
  const overdueRows = pool
    .filter((so) => so.dueDate && so.dueDate.slice(0, 10) < todayYmd)
    .map((so) => ({ ...so, daysLate: daysBetween(so.dueDate, todayYmd) }))
    .sort((a, b) => b.daysLate - a.daysLate);

  return {
    date: todayYmd,
    generatedAtIso: new Date().toISOString(),
    pool: { count: pool.length, valueSen: poolValueSen, byStateHub },
    overdueToShip: {
      count: overdueRows.length,
      valueSen: overdueRows.reduce((sum, r) => sum + r.valueSen, 0),
      rows: overdueRows.slice(0, 20),
    },
    doPipeline: { byStatus },
    invoiceGaps: { count: invoiceGaps.length, rows: invoiceGaps.slice(0, 20) },
    podChases: { count: podChases.length, rows: podChases.slice(0, 20) },
    returns: { openServiceCases },
    proposals,
    learning,
  };
}

// ── Proposal generation (LOAD_PLAN + INVOICE_GAP + POD_CHASE) ────────────────

export interface GenerateDeliveryProposalsResult {
  loadPlans: number;
  invoiceGaps: number;
  podChases: number;
  superseded: number;
}

function rm(sen: number): string {
  return `RM ${(sen / 100).toFixed(2)}`;
}

interface ProposalInsert {
  kind: "LOAD_PLAN" | "INVOICE_GAP" | "POD_CHASE";
  soRefs: string;
  state: string;
  hub: string;
  itemsCount: number;
  valueSen: number;
  threePlCostSen: number;
  recommendation: string;
}

const INSERT_CHUNK = 40; // 9 binds/row → well under adapter parameter limits

async function supersedePendingOfKinds(
  db: DbLike,
  kinds: string[],
  nowIso: string,
): Promise<number> {
  const ph = kinds.map(() => "?").join(",");
  const prev = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM delivery_proposals
        WHERE status = 'PENDING' AND kind IN (${ph})`,
    )
    .bind(...kinds)
    .first<{ n: number | string }>();
  const count = n(prev?.n);
  if (count > 0) {
    await db
      .prepare(
        `UPDATE delivery_proposals SET status = 'SUPERSEDED', decided_at = ?
          WHERE status = 'PENDING' AND kind IN (${ph})`,
      )
      .bind(nowIso, ...kinds)
      .run();
  }
  return count;
}

async function insertProposals(
  db: DbLike,
  proposals: ProposalInsert[],
  nowIso: string,
): Promise<void> {
  for (let i = 0; i < proposals.length; i += INSERT_CHUNK) {
    const chunk = proposals.slice(i, i + INSERT_CHUNK);
    const valuesSql = chunk.map(() => "(?,?,?,?,?,?,?,?,?,?,'PENDING')").join(",");
    const binds: unknown[] = [];
    for (const p of chunk) {
      binds.push(
        crypto.randomUUID(),
        nowIso,
        p.kind,
        p.soRefs,
        p.state,
        p.hub,
        p.itemsCount,
        p.valueSen,
        p.threePlCostSen,
        p.recommendation,
      );
    }
    await db
      .prepare(
        `INSERT INTO delivery_proposals
           (id, generated_at, kind, so_refs, state, hub,
            items_count, value_sen, three_pl_cost_sen, recommendation, status)
         VALUES ${valuesSql}`,
      )
      .bind(...binds)
      .run();
  }
}

/**
 * Generate the day's proposals. PROPOSAL-ONLY: writes exclusively to
 * delivery_proposals; approving a LOAD_PLAN does NOT create DOs in v1 —
 * the office executes the plan through the existing PL-first flow.
 */
export async function generateDeliveryProposals(
  db: DbLike,
  orgId: string,
  todayYmd: string,
): Promise<GenerateDeliveryProposalsResult> {
  await ensureDeliveryAgentTables(db);
  const nowIso = new Date().toISOString();

  const [pool, rateCard, invoiceGaps, podChases, doValueMap] = await Promise.all([
    loadReadyPool(db, orgId),
    loadStateRateCard(db, orgId),
    loadDeliveredNotInvoiced(db, orgId, todayYmd),
    loadPodMissing(db, orgId, todayYmd),
    loadDoValueMap(db as never, orgId).catch(() => new Map<string, number>()),
  ]);

  const proposals: ProposalInsert[] = [];

  // -- LOAD_PLAN: bucket the READY_TO_SHIP pool by (state, hub) --------------
  // Drops within a bucket honor the PL-first hub-integrity rule: one DO per
  // (customer, hub), so the 3PL extra-drop count = distinct customers.
  const buckets = new Map<string, PoolSo[]>();
  for (const so of pool) {
    const key = `${so.stateCode}\u0000${so.hubName}\u0000${so.hubId}`;
    const arr = buckets.get(key);
    if (arr) arr.push(so);
    else buckets.set(key, [so]);
  }
  for (const sos of buckets.values()) {
    const first = sos[0];
    const drops = new Set(sos.map((x) => `${x.customerId}\u0000${x.hubId}`)).size;
    const valueSen = sos.reduce((sum, x) => sum + x.valueSen, 0);
    const soRefs = sos
      .map((x) => x.soNo || x.soId)
      .filter(Boolean)
      .join(",");
    const cheapest = cheapestForState(rateCard, first.stateCode, drops);
    const dest = first.hubName
      ? `${first.stateCode} · hub ${first.hubName}`
      : first.stateCode;
    const dropNote =
      drops > 1
        ? `${drops} drops (PL-first: one DO per customer+hub)`
        : "1 drop";
    const reco = cheapest
      ? `Load ${sos.length} SO(s) worth ${rm(valueSen)} to ${dest} as ${dropNote}. ` +
        `Cheapest 3PL: ${cheapest.rate.providerName} ≈ ${rm(cheapest.costSen)} ` +
        `(${rm(cheapest.rate.tripSen)}/trip${drops > 1 ? ` + ${drops - 1} × ${rm(cheapest.rate.extraDropSen)}/extra drop` : ""}). ` +
        `Compare vs own truck before dispatch. Approval records the plan only — create the DOs via Create Packing List.`
      : `Load ${sos.length} SO(s) worth ${rm(valueSen)} to ${dest} as ${dropNote}. ` +
        `No 3PL state rate captured for ${first.stateCode} — own truck, or capture a quote in 3PL Providers first. ` +
        `Approval records the plan only — create the DOs via Create Packing List.`;
    proposals.push({
      kind: "LOAD_PLAN",
      soRefs,
      state: first.stateCode,
      hub: first.hubName,
      itemsCount: sos.length,
      valueSen,
      threePlCostSen: cheapest ? cheapest.costSen : 0,
      recommendation: reco,
    });
  }

  // -- INVOICE_GAP: one proposal per delivered-but-not-invoiced DO -----------
  // delivery_orders only — consignment notes can never surface here (CNs are
  // never invoiced, red line).
  for (const gap of invoiceGaps) {
    proposals.push({
      kind: "INVOICE_GAP",
      soRefs: gap.doNo || gap.doId,
      state: resolveStateCode(gap.customerState) ?? gap.customerState,
      hub: gap.hubName,
      itemsCount: 1,
      valueSen: Math.round(n(doValueMap.get(gap.doId))),
      threePlCostSen: 0,
      recommendation:
        `${gap.doNo || gap.doId} (${gap.customerName}) was delivered ${gap.deliveredAt} — ` +
        `${gap.daysSinceDelivered} day(s) with no invoice. Create the invoice from the Delivered tab.`,
    });
  }

  // -- POD_CHASE: delivered >24h with no POD photo and no signature ----------
  for (const pod of podChases) {
    proposals.push({
      kind: "POD_CHASE",
      soRefs: pod.doNo || pod.doId,
      state: resolveStateCode(pod.customerState) ?? pod.customerState,
      hub: pod.hubName,
      itemsCount: 1,
      valueSen: Math.round(n(doValueMap.get(pod.doId))),
      threePlCostSen: 0,
      recommendation:
        `${pod.doNo || pod.doId} (${pod.customerName}) marked delivered ${pod.deliveredAt} but has ` +
        `no POD photo or signature after ${pod.daysSinceDelivered} day(s). Chase the driver/3PL for the POD.`,
    });
  }

  // Whole-kind supersede then fresh insert — regeneration is idempotent and
  // a decided (APPROVED/REJECTED) proposal is never touched.
  const superseded = await supersedePendingOfKinds(
    db,
    ["LOAD_PLAN", "INVOICE_GAP", "POD_CHASE"],
    nowIso,
  );
  if (proposals.length > 0) {
    await insertProposals(db, proposals, nowIso);
  }

  return {
    loadPlans: proposals.filter((p) => p.kind === "LOAD_PLAN").length,
    invoiceGaps: invoiceGaps.length,
    podChases: podChases.length,
    superseded,
  };
}

// ── Daily brief snapshot (cron) ──────────────────────────────────────────────

export async function storeDeliveryBriefSnapshot(
  db: DbLike,
  data: DeliveryBriefData,
): Promise<void> {
  await ensureDeliveryAgentTables(db);
  await db
    .prepare(
      "INSERT INTO delivery_briefs (id, date, taken_at, payload) VALUES (?,?,?,?)",
    )
    .bind(crypto.randomUUID(), data.date, data.generatedAtIso, JSON.stringify(data))
    .run();
}
