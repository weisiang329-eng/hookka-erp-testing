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
import { askAgentBrain } from "./agent-brain";
import { proposeConfigParam } from "./agent-learning";
import { loadCsConfig } from "./cs-agent";

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
         decided_by TEXT,
         due_date TEXT,
         do_count INTEGER NOT NULL DEFAULT 0,
         drop_count INTEGER NOT NULL DEFAULT 0,
         driver TEXT,
         recipients TEXT
       )`,
      // Packing-list columns for existing prod tables (idempotent; the loop
      // try/catches so "duplicate column" is skipped silently). due_date drives
      // the auto-expire; do_count/drop_count/driver/recipients feed the new
      // "one truck run" proposal card.
      `ALTER TABLE delivery_proposals ADD COLUMN due_date TEXT`,
      `ALTER TABLE delivery_proposals ADD COLUMN do_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE delivery_proposals ADD COLUMN drop_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE delivery_proposals ADD COLUMN driver TEXT`,
      `ALTER TABLE delivery_proposals ADD COLUMN recipients TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_delivery_proposals_status
         ON delivery_proposals(status, generated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_delivery_proposals_kind
         ON delivery_proposals(kind, status)`,
      `CREATE INDEX IF NOT EXISTS idx_delivery_proposals_due
         ON delivery_proposals(status, due_date)`,
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

export async function loadReadyPool(db: DbLike, orgId: string): Promise<PoolSo[]> {
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
                d.name AS provider_name, d.status AS provider_status
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
  /**
   * Claude-written one-paragraph focus (English — shown on the Delivery
   * Agent tab). Filled only on cron / run-now paths (the LLM never runs on
   * a plain GET); null when no API key or the call failed.
   */
  aiFocus?: string | null;
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
      // POD chasing is opt-in (see podChaseEnabled) — Delivered click = proof.
      podChaseEnabled(db).then((on) =>
        on
          ? loadPodMissing(db, orgId, todayYmd).catch((err) => {
              console.error("[delivery-agent] podChases failed:", err);
              return [] as DoGapRow[];
            })
          : ([] as DoGapRow[]),
      ),
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
  expired: number;
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
  // Packing-list fields (LOAD_PLAN only; the other kinds leave them at defaults).
  dueDate?: string; // earliest delivery date across the run → drives auto-expire
  doCount?: number; // # delivery orders (one per customer+hub) in this truck run
  dropCount?: number; // # distinct drop locations (hubs)
  driver?: string; // suggested carrier (cheapest 3PL, or "Own truck")
  recipients?: string; // JSON [{ customer, hub, doCount, valueSen }]
}

const INSERT_CHUNK = 30; // 15 binds/row → well under adapter parameter limits

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

/**
 * Auto-expire stale PENDING proposals the owner never adopted within ~1 day of
 * GENERATION (owner 2026-07-15: unadopted plans should clear after a day). Keyed
 * on generated_at age — NOT the delivery date — because a ready SO whose expected
 * DD has passed is OVERDUE and must keep surfacing, not be hidden. Marks EXPIRED
 * (not deleted — the audit/history stays). Runs BEFORE regeneration each cycle.
 * Mirrors the production schedule-proposals expiry.
 */
async function expireStalePendingProposals(
  db: DbLike,
  nowIso: string,
): Promise<number> {
  const cutoff = new Date(Date.parse(nowIso) - 86400000).toISOString();
  const prev = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM delivery_proposals
        WHERE status = 'PENDING' AND generated_at < ?`,
    )
    .bind(cutoff)
    .first<{ n: number | string }>();
  const count = n(prev?.n);
  if (count > 0) {
    await db
      .prepare(
        `UPDATE delivery_proposals SET status = 'EXPIRED', decided_at = ?
          WHERE status = 'PENDING' AND generated_at < ?`,
      )
      .bind(nowIso, cutoff)
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
    const valuesSql = chunk
      .map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING')")
      .join(",");
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
        p.dueDate ?? "",
        p.doCount ?? 0,
        p.dropCount ?? 0,
        p.driver ?? "",
        p.recipients ?? "",
      );
    }
    await db
      .prepare(
        `INSERT INTO delivery_proposals
           (id, generated_at, kind, so_refs, state, hub,
            items_count, value_sen, three_pl_cost_sen, recommendation,
            due_date, do_count, drop_count, driver, recipients, status)
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
/**
 * POD chasing is OPT-IN (kv_config['delivery-agent'].podChase === true).
 * Owner ruling 2026-07-12: the office clicks Delivered only when the goods
 * actually arrived — the click itself is the proof, and the factory has no
 * signature-capture flow, so chasing PODs just manufactures busywork
 * (253-row backlog on day one). Flip the kv flag if a POD process starts.
 */
async function podChaseEnabled(db: DbLike): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind("delivery-agent")
      .first<{ value: string }>();
    if (!row?.value) return false;
    const parsed = JSON.parse(row.value) as { podChase?: unknown };
    return parsed?.podChase === true;
  } catch {
    return false;
  }
}

export async function generateDeliveryProposals(
  db: DbLike,
  orgId: string,
  todayYmd: string,
): Promise<GenerateDeliveryProposalsResult> {
  await ensureDeliveryAgentTables(db);
  const nowIso = new Date().toISOString();

  const chasePods = await podChaseEnabled(db);
  const [pool, rateCard, invoiceGaps, podChases, doValueMap] = await Promise.all([
    loadReadyPool(db, orgId),
    loadStateRateCard(db, orgId),
    loadDeliveredNotInvoiced(db, orgId, todayYmd),
    chasePods ? loadPodMissing(db, orgId, todayYmd) : Promise.resolve([] as DoGapRow[]),
    loadDoValueMap(db as never, orgId).catch(() => new Map<string, number>()),
  ]);

  const proposals: ProposalInsert[] = [];

  // -- LOAD_PLAN: one proposal per STATE = one packing list (truck run). ------
  // Multiple DOs (one per customer+hub — the PL-first hub-integrity rule) bundle
  // into a single truck run dropping at N locations. Owner 2026-07-15: propose by
  // PACKING LIST, not by DO — the card shows DO count, drop count, recipients,
  // suggested carrier, and the delivery date (earliest DD across the run), which
  // also drives auto-expiry. Approval still records only (Phase 1); the office
  // creates the DOs via Create Packing List.
  const byState = new Map<string, PoolSo[]>();
  for (const so of pool) {
    const arr = byState.get(so.stateCode);
    if (arr) arr.push(so);
    else byState.set(so.stateCode, [so]);
  }
  for (const [stateCode, sos] of byState) {
    // One DO per (customer, hub) — each is a stop. Drops = distinct hub locations.
    const doCount = new Set(sos.map((x) => `${x.customerId}__${x.hubId}`)).size;
    const dropCount =
      new Set(sos.map((x) => x.hubId).filter(Boolean)).size || doCount;
    const valueSen = sos.reduce((sum, x) => sum + x.valueSen, 0);
    const soRefs = sos
      .map((x) => x.soNo || x.soId)
      .filter(Boolean)
      .join(",");
    // Earliest delivery date across the run — the deliver-by + the expiry floor.
    const dueDate =
      sos
        .map((x) => x.dueDate)
        .filter(Boolean)
        .sort()[0] ?? "";
    // Recipients grouped by (customer, hub), each with its own DO count + value.
    const recMap = new Map<
      string,
      { customer: string; hub: string; doCount: number; valueSen: number }
    >();
    for (const x of sos) {
      const k = `${x.customerId}__${x.hubId}`;
      const cur = recMap.get(k);
      if (cur) cur.valueSen += x.valueSen;
      else
        recMap.set(k, {
          customer: x.customerName || "—",
          hub: x.hubName || "—",
          doCount: 1,
          valueSen: x.valueSen,
        });
    }
    const recipients = JSON.stringify([...recMap.values()]);
    const cheapest = cheapestForState(rateCard, stateCode, doCount);
    const driver = cheapest ? cheapest.rate.providerName : "Own truck";
    const dropNote = dropCount > 1 ? `${dropCount} drops` : "1 drop";
    const byLine = dueDate ? `Deliver by ${dueDate}. ` : "";
    const reco = cheapest
      ? `Packing list — ${stateCode}: ${doCount} DO(s) worth ${rm(valueSen)} to ${dropNote}. ` +
        `Suggested 3PL: ${cheapest.rate.providerName} ≈ ${rm(cheapest.costSen)} ` +
        `(${rm(cheapest.rate.tripSen)}/trip${dropCount > 1 ? ` + ${dropCount - 1} × ${rm(cheapest.rate.extraDropSen)}/extra drop` : ""}). ` +
        `Compare vs own truck. ${byLine}Approval records the plan only — create the DOs via Create Packing List.`
      : `Packing list — ${stateCode}: ${doCount} DO(s) worth ${rm(valueSen)} to ${dropNote}. ` +
        `No 3PL state rate for ${stateCode} — own truck, or capture a quote in 3PL Providers first. ` +
        `${byLine}Approval records the plan only — create the DOs via Create Packing List.`;
    proposals.push({
      kind: "LOAD_PLAN",
      soRefs,
      state: stateCode,
      hub: "",
      itemsCount: sos.length,
      valueSen,
      threePlCostSen: cheapest ? cheapest.costSen : 0,
      recommendation: reco,
      dueDate,
      doCount,
      dropCount,
      driver,
      recipients,
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

  // Expire past-due PENDING proposals first (owner 2026-07-15), then whole-kind
  // supersede + fresh insert — regeneration is idempotent and a decided
  // (APPROVED/REJECTED) proposal is never touched.
  const expired = await expireStalePendingProposals(db, nowIso);
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
    expired,
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

/**
 * Latest stored aiFocus (today first, else most recent). The GET brief path
 * stays LLM-free and cheap — the tab shows the focus written by the last
 * cron / run-now execution.
 */
export async function loadLatestDeliveryAiFocus(
  db: DbLike,
): Promise<{ date: string; aiFocus: string } | null> {
  try {
    await ensureDeliveryAgentTables(db);
    const res = await db
      .prepare("SELECT date, payload FROM delivery_briefs ORDER BY taken_at DESC LIMIT 10")
      .bind()
      .all<{ date: string; payload: string }>();
    for (const row of res.results ?? []) {
      try {
        const p = JSON.parse(row.payload) as { aiFocus?: string | null };
        if (p?.aiFocus) return { date: s(row.date), aiFocus: p.aiFocus };
      } catch {
        /* malformed snapshot — keep scanning */
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Autonomy: agent-decided approval (auto-approve gate ON) ──────────────────
//
// Delivery approval only records the decision — it never creates or
// dispatches documents (v1 red line stands even in full-auto). So with the
// DELIVERY gate ON, the agent marks its own proposals APPROVED
// (decided_by='AGENT_AUTO') and the office executes from the approved list.

export async function autoApproveDeliveryProposals(
  db: DbLike,
  decidedBy: string,
): Promise<number> {
  await ensureDeliveryAgentTables(db);
  const nowIso = new Date().toISOString();
  const before = await db
    .prepare("SELECT COUNT(*) AS n FROM delivery_proposals WHERE status = 'PENDING'")
    .bind()
    .first<{ n: number | string }>();
  const pending = Number(before?.n) || 0;
  if (pending === 0) return 0;
  await db
    .prepare(
      `UPDATE delivery_proposals
          SET status = 'APPROVED', decided_at = ?, decided_by = ?
        WHERE status = 'PENDING'`,
    )
    .bind(nowIso, decidedBy)
    .run();
  return pending;
}

// ── AI focus (agent brain — judgment over the engine's numbers) ─────────────

export async function generateDeliveryFocus(
  apiKey: string | undefined,
  brief: DeliveryBriefData,
  usageSink?: { tokensIn: number; tokensOut: number },
  ownerInstructions: string[] = [],
): Promise<string | null> {
  const compact = {
    date: brief.date,
    // Standing teachings from the owner (agent_feedback notebook).
    ownerInstructions,
    readyPool: { count: brief.pool.count, topBuckets: brief.pool.byStateHub.slice(0, 5) },
    overdueToShip: {
      count: brief.overdueToShip.count,
      worst: brief.overdueToShip.rows.slice(0, 5).map((r) => ({
        so: r.soNo,
        customer: r.customerName,
        daysLate: r.daysLate,
      })),
    },
    invoiceGaps: brief.invoiceGaps.count,
    podChases: brief.podChases.count,
    pendingProposals: brief.proposals.pendingByKind,
    providers: brief.learning.slice(0, 5).map((p) => ({
      name: p.providerName,
      trips: p.trips,
      onTimePct: p.onTimePct,
      freightVarianceRm: Math.round(p.varianceSen / 100),
    })),
  };
  return askAgentBrain(apiKey, {
    system:
      "You are the Delivery Agent of Hookka, a Malaysian furniture factory. " +
      "From the JSON numbers, write ONE short paragraph (3-5 sentences, plain " +
      "English, no jargon, no headings, no bullet points) telling the office " +
      "what matters most in deliveries today: the most overdue-to-ship orders, " +
      "which state/hub bucket is worth a truck, invoice gaps or POD chases " +
      "needing closure, and any 3PL whose on-time rate or freight variance " +
      "looks off. ownerInstructions in the JSON are standing rules the boss " +
      "personally taught you — obey every one of them. " +
      "Be direct and specific — name orders and providers.",
    payload: compact,
    maxTokens: 500,
    usageSink,
  });
}

// ── Transit-drift learning (cross-agent: Delivery teaches CS) ────────────────
//
// The CS Agent promises "dispatch + N working days" per state. This learner
// measures the ACTUAL dispatch→delivered duration per state over the last 90
// days and, when it drifts ≥1 working day from the configured allowance on
// ≥5 trips, writes a PENDING config proposal (`cs.transitDays.<STATE>`) the
// owner can approve on the Agent Console. Approval writes
// kv_config['cs-agent'].transitDaysByState — the CS Agent picks it up on the
// very next question. Iron rule 1: nothing changes without approval.

export interface TransitDriftFinding {
  stateCode: string;
  samples: number;
  configuredDays: number;
  actualAvgDays: number;
  driftDays: number;
  flagged: boolean;
  proposedDays: number | null;
}

/** Working-day steps from `fromYmd` to `toYmd` (Sundays skipped, cap 30). */
function transitWorkingDays(fromYmd: string, toYmd: string): number | null {
  if (!fromYmd || !toYmd || toYmd < fromYmd) return null;
  const d = new Date(`${fromYmd}T00:00:00`);
  const end = new Date(`${toYmd}T00:00:00`);
  if (Number.isNaN(d.getTime()) || Number.isNaN(end.getTime())) return null;
  let steps = 0;
  while (d < end && steps < 30) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0) steps++;
  }
  return steps;
}

export async function transitDriftLearning(
  db: DbLike,
  orgId: string,
  todayYmd: string,
  opts: { emitProposals?: boolean } = {},
  windowDays = 90,
): Promise<TransitDriftFinding[]> {
  const cutoff = isoCutoff(todayYmd, windowDays);
  const res = await db
    .prepare(
      `SELECT customerState, hubId, dispatchedAt, deliveredAt
         FROM delivery_orders
        WHERE orgId = ?
          AND status IN ('DELIVERED','INVOICED')
          AND dispatchedAt IS NOT NULL AND dispatchedAt <> ''
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

  const byState = new Map<string, { total: number; samples: number }>();
  for (const r of rows) {
    const hubId = s(r.hubId ?? r.hub_id);
    const rawState = s(r.customerState ?? r.customer_state) || (hubStates.get(hubId) ?? "");
    const stateCode = resolveStateCode(rawState);
    if (!stateCode) continue;
    const days = transitWorkingDays(
      s(r.dispatchedAt ?? r.dispatched_at).slice(0, 10),
      s(r.deliveredAt ?? r.delivered_at).slice(0, 10),
    );
    if (days == null) continue;
    const agg = byState.get(stateCode) ?? { total: 0, samples: 0 };
    agg.total += days;
    agg.samples += 1;
    byState.set(stateCode, agg);
  }

  const config = await loadCsConfig(db as never);
  const findings: TransitDriftFinding[] = [];
  for (const [stateCode, agg] of byState) {
    if (agg.samples < 5) continue; // too thin to learn from
    const actualAvg = Math.round((agg.total / agg.samples) * 10) / 10;
    const configured =
      config.transitDaysByState[stateCode] ?? config.defaultTransitDays;
    const drift = Math.round(actualAvg) - configured;
    const flagged = Math.abs(drift) >= 1;
    findings.push({
      stateCode,
      samples: agg.samples,
      configuredDays: configured,
      actualAvgDays: actualAvg,
      driftDays: drift,
      flagged,
      proposedDays: flagged
        ? Math.max(0, Math.min(10, Math.round(actualAvg)))
        : null,
    });
  }
  findings.sort((a, b) => Math.abs(b.driftDays) - Math.abs(a.driftDays));

  if (opts.emitProposals) {
    for (const f of findings) {
      if (!f.flagged || f.proposedDays == null) continue;
      await proposeConfigParam(db as never, {
        paramKey: `cs.transitDays.${f.stateCode}`,
        currentValue: String(f.configuredDays),
        proposedValue: String(f.proposedDays),
        reason: `${f.stateCode}: actual dispatch->delivered avg ${f.actualAvgDays} working days over ${f.samples} trips (last ${windowDays}d) vs CS promise allowance ${f.configuredDays} — drift ${f.driftDays > 0 ? "+" : ""}${f.driftDays}d`,
      }).catch((err) => {
        console.warn(`[delivery-agent] transit proposal ${f.stateCode} failed:`, err);
      });
    }
  }
  return findings;
}
