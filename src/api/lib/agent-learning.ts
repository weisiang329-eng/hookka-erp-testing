// ---------------------------------------------------------------------------
// agent-learning.ts — Production Agent Phase 3: the learning loop.
//
// Three deterministic learners (LLM never does the arithmetic — iron rule 2):
//
//   1. Plan-vs-actual — yesterday's plan (job_cards.dueDate, i.e. the dates
//      the owner approved via schedule proposals / bulk patch) vs actual
//      completedDate per department → adherence % + a data-derivable top
//      slippage reason (upstream late / capacity shortfall / no-show day).
//
//   2. Flexible handoffs — the owner's rule (2026-07-12): the +1/+2 chain
//      handoffs are DEFAULTS, not laws. We measure the ACTUAL average gap in
//      working days between an upstream department completing and this
//      department completing the same production order (last 30 days). When
//      the measured gap drifts >1 working day from the configured handoff
//      (with enough samples), we emit ONE PENDING config_proposals row the
//      owner can approve in the Agent Console; approval writes the value into
//      kv_config['planning_capacity'].chain so the engine picks it up live.
//
//   3. Forward OT signal with humane caps (owner red-lines, 2026-07-12):
//      look at the NEXT 21 working days of scheduled load (WAITING job cards
//      by dueDate) vs each department's rolling-7-working-day ACTUAL
//      throughput. Overloaded days are resolved in this priority order:
//        ① spread work to adjacent under-loaded days (no OT at all);
//        ② EARLY, SPREAD OT — max 2h/day, evenly across the window, never a
//          last-minute 5-6h day and never consecutive high-OT streaks;
//        ③ if even capped OT can't absorb it, recommend delaying the
//          lowest-priority orders (latest customer delivery date) — "宁可迟交
//          也不压榨人": some orders must just be late.
//
// Read-mostly: the ONLY write is the config_proposals INSERT, and only when
// opts.emitProposals is true (cron / Run-now — never on a plain GET render).
// Every write still goes through the owner's explicit approval.
//
// Runtime self-apply for config_proposals (migration files alone are inert);
// snake_case columns; ALL row reads dual-keyed (r.camelCase ?? r.snake_case).
// ---------------------------------------------------------------------------

import { loadCapacityConfig, type ChainConfig } from "./planning-capacity";

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

// ── Owner red-line constants ─────────────────────────────────────────────────
/** Humane OT ceiling — NEVER suggest more than this per department per day. */
const OT_MAX_HOURS_PER_DAY = 2;
/** Forward window (working days) the OT learner looks ahead. */
const OT_WINDOW_WORKING_DAYS = 21;
/** Rolling actual-throughput window (working days). */
export const ROLLING_WORKING_DAYS = 7;
/** Handoff drift (working days) that triggers a config proposal. */
const HANDOFF_DRIFT_THRESHOLD = 1;
/** Minimum (PO) samples before a handoff drift counts as "sustained". */
const HANDOFF_MIN_SAMPLES = 5;
/** Look-back window for the handoff learner (calendar days). */
const HANDOFF_LOOKBACK_DAYS = 30;

// ── Date helpers (SGT, YMD-string arithmetic — never toISOString on locals) ──

export function ymdInSgt(d: Date = new Date()): string {
  const shifted = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayOfWeek(ymd: string): number {
  const d = new Date(ymd + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? -1 : d.getUTCDay(); // 0 = Sunday
}

function isWorkingDay(ymd: string, holidays: Set<string>): boolean {
  return dayOfWeek(ymd) !== 0 && !holidays.has(ymd);
}

function previousWorkingDay(fromYmd: string, holidays: Set<string>): string {
  let cur = fromYmd;
  for (let i = 0; i < 14; i++) {
    cur = addDaysYmd(cur, -1);
    if (isWorkingDay(cur, holidays)) return cur;
  }
  return addDaysYmd(fromYmd, -1);
}

/** The next `count` working days STARTING the working day after `fromYmd`. */
function nextWorkingDays(
  fromYmd: string,
  count: number,
  holidays: Set<string>,
): string[] {
  const out: string[] = [];
  let cur = fromYmd;
  let guard = 0;
  while (out.length < count && guard < count * 3 + 30) {
    cur = addDaysYmd(cur, 1);
    if (isWorkingDay(cur, holidays)) out.push(cur);
    guard++;
  }
  return out;
}

/** Working days in (a, b] — 0 when b <= a. Bounded for safety. */
function workingDaysBetween(
  a: string,
  b: string,
  holidays: Set<string>,
): number {
  if (b <= a) return 0;
  let n = 0;
  let cur = a;
  let guard = 0;
  while (cur < b && guard < 400) {
    cur = addDaysYmd(cur, 1);
    if (isWorkingDay(cur, holidays)) n++;
    guard++;
  }
  return n;
}

/** The N-th working day walking BACK from (and excluding) fromYmd. */
export function workingDaysBack(
  fromYmd: string,
  n: number,
  holidays: Set<string>,
): string {
  let cur = fromYmd;
  let seen = 0;
  let guard = 0;
  while (seen < n && guard < n * 3 + 30) {
    cur = addDaysYmd(cur, -1);
    if (isWorkingDay(cur, holidays)) seen++;
    guard++;
  }
  return cur;
}

export async function loadHolidaySet(db: DbLike): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind("public_holidays")
      .first<{ value: string }>();
    if (row?.value) {
      const arr = JSON.parse(row.value);
      if (Array.isArray(arr)) {
        for (const d of arr) {
          if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) set.add(d);
        }
      }
    }
  } catch {
    // Missing/malformed → Sundays-only calendar.
  }
  return set;
}

// ── Output shapes ────────────────────────────────────────────────────────────

export interface DeptAdherence {
  dept: string;
  /** Cards that were due on prevDate. */
  due: number;
  onTime: number;
  late: number;
  stillOpen: number;
  /** onTime ÷ due × 100 (null when nothing was due). */
  adherencePct: number | null;
  /** Data-derivable dominant slippage reason (null = nothing slipped). */
  topReason: string | null;
}

export interface HandoffFinding {
  /** ChainConfig key, e.g. "sewHandoffDays". */
  key: keyof ChainConfig & string;
  fromDepts: string[];
  toDept: string;
  configuredDays: number;
  /** Measured average working-day gap (null = not enough data). */
  actualAvgDays: number | null;
  samples: number;
  driftDays: number | null;
  /** |drift| > 1 working day with enough samples. */
  flagged: boolean;
  /** Rounded value a config proposal would set. */
  proposedDays: number | null;
}

export interface OtDayRow {
  date: string;
  loadMin: number;
  capacityMin: number;
  overloadPct: number; // e.g. 130 = needs 130% of a normal day
  /** ≤ OT_MAX_HOURS_PER_DAY; 0 when spreading alone absorbs the overflow. */
  suggestedOtHours: number;
  soRefs: string[];
}

export interface OtDeptSignal {
  dept: string;
  /** Rolling-7-working-day actual throughput, minutes/working day. */
  capacityMinPerDay: number;
  windowLoadMin: number;
  windowCapacityMin: number;
  /** SPREAD = rebalance only · OT = early spread OT ≤2h/day · DELAY = OT caps insufficient. */
  mode: "SPREAD" | "OT" | "DELAY";
  overloadedDays: OtDayRow[];
  /** Lowest-priority orders (latest customer DD) to delay when mode=DELAY. */
  delayCandidates: Array<{ soRef: string; customerDd: string | null }>;
  note: string;
}

export interface LearningData {
  date: string;
  prevDate: string;
  adherence: DeptAdherence[];
  /** Weighted overall adherence % across depts (null = nothing due). */
  overallAdherencePct: number | null;
  handoffs: HandoffFinding[];
  /** PENDING config_proposals rows awaiting the owner (incl. new ones). */
  pendingConfigProposals: number;
  ot: OtDeptSignal[];
}

// ── config_proposals runtime self-apply ──────────────────────────────────────

let _configMig = false;
export async function ensureConfigProposalTable(db: DbLike): Promise<void> {
  if (_configMig) return;

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS config_proposals (
         id TEXT PRIMARY KEY,
         generated_at TEXT NOT NULL,
         param_key TEXT NOT NULL,
         current_value TEXT,
         proposed_value TEXT NOT NULL,
         reason TEXT,
         status TEXT NOT NULL DEFAULT 'PENDING',
         decided_at TEXT,
         decided_by TEXT
       )`,
    )
    .bind()
    .run();
  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS idx_config_proposals_status ON config_proposals(status, generated_at DESC)",
    )
    .bind()
    .run();
  _configMig = true;
}

/**
 * Whitelisted parameter keys a config proposal may write. Everything else is
 * rejected at approve time (reject bad inputs — never normalize). All five
 * land under kv_config['planning_capacity'].chain.<field>.
 */
export const CONFIG_PROPOSAL_KEYS: Record<string, keyof ChainConfig & string> = {
  "chain.sewHandoffDays": "sewHandoffDays",
  "chain.woodHandoffDays": "woodHandoffDays",
  "chain.frameHandoffDays": "frameHandoffDays",
  "chain.foamHandoffDays": "foamHandoffDays",
  "chain.uphHandoffDays": "uphHandoffDays",
};

/**
 * Validate + write ONE config-proposal value into kv_config. Shared by the
 * manual console approve route AND the full-auto path — identical whitelist
 * and bounds so autonomy can NEVER write a value a human approve couldn't:
 *   chain.<field>          → kv['planning_capacity'].chain.<field>   (0..30)
 *   cs.transitDays.<STATE> → kv['cs-agent'].transitDaysByState.<X>   (0..10)
 * Returns true when a value was written, false when the key/value is not
 * approvable (rejected, never normalized).
 */
export async function applyConfigProposalValue(
  db: DbLike,
  paramKey: string,
  proposedRaw: string,
): Promise<boolean> {
  const chainField = CONFIG_PROPOSAL_KEYS[paramKey];
  const csState = /^cs\.transitDays\.([A-Z]{2,3})$/.exec(paramKey)?.[1] ?? null;
  const value = Number(proposedRaw);
  const maxValue = csState ? 10 : 30;
  if ((!chainField && !csState) || !Number.isFinite(value) || value < 0 || value > maxValue) {
    return false;
  }
  const kvKey = csState ? "cs-agent" : "planning_capacity";
  let override: Record<string, unknown> = {};
  try {
    const kv = await db
      .prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind(kvKey)
      .first<{ value: string }>();
    if (kv?.value) {
      const parsed = JSON.parse(kv.value);
      if (parsed && typeof parsed === "object") override = parsed as Record<string, unknown>;
    }
  } catch {
    override = {};
  }
  if (csState) {
    const byState =
      override.transitDaysByState && typeof override.transitDaysByState === "object"
        ? (override.transitDaysByState as Record<string, unknown>)
        : {};
    byState[csState] = Math.floor(value);
    override.transitDaysByState = byState;
  } else if (chainField) {
    const chain =
      override.chain && typeof override.chain === "object"
        ? (override.chain as Record<string, unknown>)
        : {};
    chain[chainField] = Math.floor(value);
    override.chain = chain;
  }
  await db
    .prepare(
      `INSERT INTO kv_config (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(kvKey, JSON.stringify(override), new Date().toISOString())
    .run();
  return true;
}

/**
 * FULL-AUTO path (owner ruling 2026-07-13: "auto 就是自动，我不要 approve").
 * With an agent's auto-approve gate ON, it applies its OWN parameter proposals
 * (decided_by='AGENT_AUTO') — bounded by the SAME whitelist/limits as a manual
 * approval, every change stamped in config_proposals + kv_config.updated_at so
 * it stays fully visible and reversible. Family owns its param namespace:
 *   PRODUCTION → chain.*            DELIVERY → cs.transitDays.*
 * Returns the number of parameters applied.
 */
export async function autoApplyConfigProposals(
  db: DbLike,
  family: "PRODUCTION" | "DELIVERY",
  decidedBy: string,
): Promise<number> {
  await ensureConfigProposalTable(db);
  const prefix = family === "PRODUCTION" ? "chain." : "cs.transitDays.";
  const res = await db
    .prepare(
      "SELECT * FROM config_proposals WHERE status = 'PENDING' ORDER BY generated_at DESC LIMIT 100",
    )
    .bind()
    .all<{
      id: string;
      param_key?: string;
      paramKey?: string;
      proposed_value?: string;
      proposedValue?: string;
    }>();
  const nowIso = new Date().toISOString();
  let applied = 0;
  for (const row of res.results ?? []) {
    const paramKey = (row.paramKey ?? row.param_key) ?? "";
    if (!paramKey.startsWith(prefix)) continue;
    const proposedRaw = (row.proposedValue ?? row.proposed_value) ?? "";
    const ok = await applyConfigProposalValue(db, paramKey, proposedRaw);
    if (!ok) continue;
    await db
      .prepare(
        "UPDATE config_proposals SET status = 'APPROVED', decided_at = ?, decided_by = ? WHERE id = ?",
      )
      .bind(nowIso, decidedBy, row.id)
      .run();
    applied++;
  }
  return applied;
}

/**
 * Write ONE PENDING config proposal, skipping when the same param already has
 * a PENDING row (learners run daily — they must never stack duplicates).
 * Shared by every agent family's learning loop (production handoffs, delivery
 * transit drift, ...); the approve-time whitelist in routes/agent-console.ts
 * decides what a key may actually write. Returns true when a row was created.
 */
export async function proposeConfigParam(
  db: DbLike,
  p: {
    paramKey: string;
    currentValue: string | null;
    proposedValue: string;
    reason: string;
  },
): Promise<boolean> {
  await ensureConfigProposalTable(db);
  const existing = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM config_proposals WHERE param_key = ? AND status = 'PENDING'",
    )
    .bind(p.paramKey)
    .first<{ n: number | string }>();
  if ((Number(existing?.n) || 0) > 0) return false;
  await db
    .prepare(
      `INSERT INTO config_proposals
         (id, generated_at, param_key, current_value, proposed_value, reason)
       VALUES (?,?,?,?,?,?)`,
    )
    .bind(
      crypto.randomUUID(),
      new Date().toISOString(),
      p.paramKey,
      p.currentValue,
      p.proposedValue,
      p.reason,
    )
    .run();
  return true;
}

// ── 1 · Plan vs actual ───────────────────────────────────────────────────────

interface AdherenceRawRow {
  dept: string;
  due: number | string;
  ontime: number | string;
  late: number | string;
  stillopen: number | string;
  dueminutes: number | string;
  // adapter may fold aliases differently; dual-key the mixed-case ones
  onTime?: number | string;
  stillOpen?: number | string;
  dueMinutes?: number | string;
}

async function collectAdherence(
  db: DbLike,
  prevDate: string,
  capacityByDept: Map<string, number>,
): Promise<{ rows: DeptAdherence[]; overallPct: number | null }> {
  // Everything that was DUE on prevDate, by dept. completedDate is compared
  // as its YMD prefix (same ::text cast production-brief.ts already uses).
  const res = await db
    .prepare(
      `SELECT jc.departmentCode AS dept,
              COUNT(*) AS due,
              SUM(CASE WHEN jc.status IN ('COMPLETED','TRANSFERRED')
                        AND substr(jc.completedDate::text,1,10) <= ? THEN 1 ELSE 0 END) AS on_time,
              SUM(CASE WHEN jc.status IN ('COMPLETED','TRANSFERRED')
                        AND substr(jc.completedDate::text,1,10) > ? THEN 1 ELSE 0 END) AS late,
              SUM(CASE WHEN jc.status NOT IN ('COMPLETED','TRANSFERRED','CANCELLED') THEN 1 ELSE 0 END) AS still_open,
              SUM(CASE WHEN jc.departmentCode = 'FAB_CUT'
                       THEN COALESCE(jc.estMinutes, 0)
                       ELSE COALESCE(jc.productionTimeMinutes, 0) * COALESCE(jc.wipQty, 1) END) AS due_minutes
         FROM job_cards jc
        WHERE substr(jc.dueDate::text,1,10) = ?
          AND jc.status <> 'CANCELLED'
        GROUP BY 1`,
    )
    .bind(prevDate, prevDate, prevDate)
    .all<AdherenceRawRow>();

  // Misses whose PO has an incomplete UPSTREAM (lower-sequence) card — the
  // "upstream late" attribution. Deterministic proxy: if the earlier step in
  // the same order still isn't done, this dept could not have started.
  const upstreamRes = await db
    .prepare(
      `SELECT jc.departmentCode AS dept, COUNT(*) AS n
         FROM job_cards jc
        WHERE substr(jc.dueDate::text,1,10) = ?
          AND jc.status NOT IN ('COMPLETED','TRANSFERRED','CANCELLED')
          AND EXISTS (
            SELECT 1 FROM job_cards up
             WHERE up.productionOrderId = jc.productionOrderId
               AND up.sequence < jc.sequence
               AND up.status NOT IN ('COMPLETED','TRANSFERRED','CANCELLED'))
        GROUP BY 1`,
    )
    .bind(prevDate)
    .all<{ dept: string; n: number | string }>();
  const upstreamLate = new Map<string, number>();
  for (const r of upstreamRes.results ?? []) {
    upstreamLate.set(r.dept, Number(r.n) || 0);
  }

  // Departments that completed NOTHING at all on prevDate (any due date) —
  // the "no-show / zero output" attribution.
  const doneRes = await db
    .prepare(
      `SELECT jc.departmentCode AS dept, COUNT(*) AS n
         FROM job_cards jc
        WHERE jc.status IN ('COMPLETED','TRANSFERRED')
          AND substr(jc.completedDate::text,1,10) = ?
        GROUP BY 1`,
    )
    .bind(prevDate)
    .all<{ dept: string; n: number | string }>();
  const completedAnything = new Set<string>();
  for (const r of doneRes.results ?? []) {
    if ((Number(r.n) || 0) > 0) completedAnything.add(r.dept);
  }

  const rows: DeptAdherence[] = [];
  let totalDue = 0;
  let totalOnTime = 0;
  for (const r of res.results ?? []) {
    const due = Number(r.due) || 0;
    const onTime = Number(r.onTime ?? r.ontime) || 0;
    const late = Number(r.late) || 0;
    const stillOpen = Number(r.stillOpen ?? r.stillopen) || 0;
    const dueMinutes = Number(r.dueMinutes ?? r.dueminutes) || 0;
    const missed = late + stillOpen;
    totalDue += due;
    totalOnTime += onTime;

    let topReason: string | null = null;
    if (missed > 0) {
      const up = upstreamLate.get(r.dept) ?? 0;
      const cap = capacityByDept.get(r.dept) ?? 0;
      if (!completedAnything.has(r.dept)) {
        topReason = "no-show day (zero completions)";
      } else if (up * 2 >= missed && up > 0) {
        topReason = `upstream late (${up} of ${missed} blocked)`;
      } else if (cap > 0 && dueMinutes > cap * 1.05) {
        topReason = `capacity shortfall (planned ${Math.round(dueMinutes / 60)}h vs ~${Math.round(cap / 60)}h/day actual)`;
      } else {
        topReason = "slipped (no dominant cause in data)";
      }
    }
    rows.push({
      dept: r.dept,
      due,
      onTime,
      late,
      stillOpen,
      adherencePct: due > 0 ? Math.round((onTime / due) * 100) : null,
      topReason,
    });
  }
  rows.sort((a, b) => (a.adherencePct ?? 101) - (b.adherencePct ?? 101));
  return {
    rows,
    overallPct: totalDue > 0 ? Math.round((totalOnTime / totalDue) * 100) : null,
  };
}

// ── 2 · Flexible handoffs learning ───────────────────────────────────────────

// Upstream(s) → downstream pairs mirroring the ChainConfig handoff knobs.
// Upholstery's real upstream is FOAM for sofas but FRAMING for bedframes, so
// both are candidates and the LATEST completed upstream per PO wins.
const HANDOFF_PAIRS: Array<{
  key: keyof ChainConfig & string;
  from: string[];
  to: string;
}> = [
  { key: "sewHandoffDays", from: ["FAB_CUT"], to: "FAB_SEW" },
  { key: "woodHandoffDays", from: ["FAB_SEW"], to: "WOOD_CUT" },
  { key: "frameHandoffDays", from: ["WOOD_CUT"], to: "FRAMING" },
  { key: "foamHandoffDays", from: ["FRAMING"], to: "FOAM" },
  { key: "uphHandoffDays", from: ["FOAM", "FRAMING"], to: "UPHOLSTERY" },
];

interface CompletionRow {
  poid: string;
  dept: string;
  donedate: string;
  poId?: string;
  doneDate?: string;
}

async function collectHandoffFindings(
  db: DbLike,
  chain: ChainConfig,
  today: string,
  holidays: Set<string>,
): Promise<HandoffFinding[]> {
  // Fetch a 60-day completion matrix so upstream completions older than the
  // 30-day downstream window are still available for gap measurement.
  const fetchSince = addDaysYmd(today, -(HANDOFF_LOOKBACK_DAYS * 2));
  const windowSince = addDaysYmd(today, -HANDOFF_LOOKBACK_DAYS);
  const res = await db
    .prepare(
      `SELECT jc.productionOrderId AS poId,
              jc.departmentCode AS dept,
              MAX(substr(jc.completedDate::text,1,10)) AS done_date
         FROM job_cards jc
        WHERE jc.status IN ('COMPLETED','TRANSFERRED')
          AND substr(jc.completedDate::text,1,10) >= ?
        GROUP BY 1, 2`,
    )
    .bind(fetchSince)
    .all<CompletionRow>();

  // poId → dept → last completion date.
  const byPo = new Map<string, Map<string, string>>();
  for (const r of res.results ?? []) {
    const poId = (r.poId ?? r.poid) as string;
    const done = (r.doneDate ?? r.donedate) as string;
    if (!poId || !done) continue;
    let m = byPo.get(poId);
    if (!m) {
      m = new Map();
      byPo.set(poId, m);
    }
    m.set(r.dept, done);
  }

  const findings: HandoffFinding[] = [];
  for (const pair of HANDOFF_PAIRS) {
    const configured = chain[pair.key];
    if (typeof configured !== "number") continue;
    let sum = 0;
    let samples = 0;
    for (const depts of byPo.values()) {
      const toDate = depts.get(pair.to);
      if (!toDate || toDate < windowSince) continue; // downstream done in last 30d
      // Latest completed upstream candidate = the actual immediate feeder.
      let fromDate: string | null = null;
      for (const f of pair.from) {
        const d = depts.get(f);
        if (d && (!fromDate || d > fromDate)) fromDate = d;
      }
      if (!fromDate || fromDate > toDate) continue;
      sum += workingDaysBetween(fromDate, toDate, holidays);
      samples++;
    }
    const actualAvg = samples > 0 ? Math.round((sum / samples) * 10) / 10 : null;
    const drift = actualAvg == null ? null : Math.round((actualAvg - configured) * 10) / 10;
    const flagged =
      drift != null &&
      Math.abs(drift) > HANDOFF_DRIFT_THRESHOLD &&
      samples >= HANDOFF_MIN_SAMPLES;
    findings.push({
      key: pair.key,
      fromDepts: pair.from,
      toDept: pair.to,
      configuredDays: configured,
      actualAvgDays: actualAvg,
      samples,
      driftDays: drift,
      flagged,
      proposedDays: flagged && actualAvg != null
        ? Math.max(0, Math.min(10, Math.round(actualAvg)))
        : null,
    });
  }
  return findings;
}

/**
 * Emit ONE PENDING config proposal per sustained-drift handoff, skipping any
 * param that already has a PENDING proposal (the learner runs daily — it must
 * not stack duplicates). Returns the number of NEW proposals written.
 */
async function emitConfigProposals(
  db: DbLike,
  findings: HandoffFinding[],
): Promise<number> {
  let created = 0;
  for (const f of findings) {
    if (!f.flagged || f.proposedDays == null) continue;
    const drift = f.driftDays ?? 0;
    const wrote = await proposeConfigParam(db, {
      paramKey: `chain.${f.key}`,
      currentValue: String(f.configuredDays),
      proposedValue: String(f.proposedDays),
      reason: `${f.fromDepts.join("/")} -> ${f.toDept}: actual avg handoff ${f.actualAvgDays} working days over ${f.samples} orders (last ${HANDOFF_LOOKBACK_DAYS}d) vs configured ${f.configuredDays} — drift ${drift > 0 ? "+" : ""}${drift}d sustained`,
    });
    if (wrote) created++;
  }
  return created;
}

export async function countPendingConfigProposals(db: DbLike): Promise<number> {
  try {
    const r = await db
      .prepare("SELECT COUNT(*) AS n FROM config_proposals WHERE status = 'PENDING'")
      .bind()
      .first<{ n: number | string }>();
    return Number(r?.n) || 0;
  } catch {
    return 0; // table not self-applied yet
  }
}

// ── 3 · Forward OT signal ────────────────────────────────────────────────────

interface LoadRawRow {
  dept: string;
  day: string;
  soref: string | null;
  customerdd: string | null;
  minutes: number | string;
  soRef?: string | null;
  customerDd?: string | null;
}

/** Exported for the read-only capacity audit (planning-capacity-audit.ts) so
 *  the audit and the learning loop can never disagree on what "actual daily
 *  throughput" means. */
export async function collectRollingCapacity(
  db: DbLike,
  today: string,
  holidays: Set<string>,
): Promise<Map<string, number>> {
  const since = workingDaysBack(today, ROLLING_WORKING_DAYS, holidays);
  // FAB_CUT est/actualMinutes are per-CARD totals; every other dept stores
  // per-unit minutes × wipQty (see job-card-minutes.ts / production-brief).
  const res = await db
    .prepare(
      `SELECT jc.departmentCode AS dept,
              SUM(CASE WHEN jc.departmentCode = 'FAB_CUT'
                       THEN COALESCE(jc.actualMinutes, jc.estMinutes, 0)
                       ELSE COALESCE(jc.actualMinutes, jc.estMinutes, 0) * COALESCE(jc.wipQty, 1) END) AS minutes
         FROM job_cards jc
        WHERE jc.status IN ('COMPLETED','TRANSFERRED')
          AND substr(jc.completedDate::text,1,10) >= ?
          AND substr(jc.completedDate::text,1,10) < ?
        GROUP BY 1`,
    )
    .bind(since, today)
    .all<{ dept: string; minutes: number | string }>();
  const out = new Map<string, number>();
  for (const r of res.results ?? []) {
    out.set(r.dept, Math.round((Number(r.minutes) || 0) / ROLLING_WORKING_DAYS));
  }
  return out;
}

async function collectOtSignals(
  db: DbLike,
  today: string,
  holidays: Set<string>,
  capacityByDept: Map<string, number>,
): Promise<OtDeptSignal[]> {
  const windowDays = nextWorkingDays(today, OT_WINDOW_WORKING_DAYS, holidays);
  if (windowDays.length === 0) return [];
  const start = windowDays[0];
  const end = windowDays[windowDays.length - 1];

  const res = await db
    .prepare(
      `SELECT jc.departmentCode AS dept,
              substr(jc.dueDate::text,1,10) AS day,
              po.companySOId AS so_ref,
              so.customerDeliveryDate AS customer_dd,
              CASE WHEN COALESCE(jc.productionTimeMinutes, 0) > 0
                   THEN jc.productionTimeMinutes * COALESCE(jc.wipQty, 1)
                   ELSE COALESCE(jc.estMinutes, 0) END AS minutes
         FROM job_cards jc
         JOIN production_orders po ON po.id = jc.productionOrderId
         LEFT JOIN sales_orders so ON so.id = po.salesOrderId
        WHERE jc.status = 'WAITING'
          AND substr(jc.dueDate::text,1,10) >= ?
          AND substr(jc.dueDate::text,1,10) <= ?`,
    )
    .bind(start, end)
    .all<LoadRawRow>();

  // dept → day → { load, soRefs } (+ per-SO latest customer DD for delays).
  const byDept = new Map<
    string,
    Map<string, { load: number; soRefs: Set<string> }>
  >();
  const soDd = new Map<string, Map<string, string | null>>();
  for (const r of res.results ?? []) {
    const dept = r.dept;
    const day = r.day;
    if (!dept || !day) continue;
    const minutes = Number(r.minutes) || 0;
    const soRef = ((r.soRef ?? r.soref) || "").trim();
    const dd = ((r.customerDd ?? r.customerdd) || "").slice(0, 10) || null;
    let days = byDept.get(dept);
    if (!days) {
      days = new Map();
      byDept.set(dept, days);
    }
    let cell = days.get(day);
    if (!cell) {
      cell = { load: 0, soRefs: new Set() };
      days.set(day, cell);
    }
    cell.load += minutes;
    if (soRef) cell.soRefs.add(soRef);
    if (soRef) {
      let m = soDd.get(dept);
      if (!m) {
        m = new Map();
        soDd.set(dept, m);
      }
      if (!m.has(soRef) || (dd && (m.get(soRef) ?? "") < dd)) m.set(soRef, dd);
    }
  }

  const signals: OtDeptSignal[] = [];
  for (const [dept, days] of byDept) {
    const capacity = capacityByDept.get(dept) ?? 0;
    if (capacity <= 0) continue; // no throughput history — can't judge load
    const windowCapacityMin = capacity * windowDays.length;
    let windowLoadMin = 0;
    let overflowTotal = 0;
    let slackTotal = 0;
    const overloaded: OtDayRow[] = [];
    for (const day of windowDays) {
      const load = days.get(day)?.load ?? 0;
      windowLoadMin += load;
      if (load > capacity) {
        overflowTotal += load - capacity;
        overloaded.push({
          date: day,
          loadMin: Math.round(load),
          capacityMin: capacity,
          overloadPct: Math.round((load / capacity) * 100),
          suggestedOtHours: 0, // filled below by mode
          soRefs: [...(days.get(day)?.soRefs ?? [])].slice(0, 6),
        });
      } else {
        slackTotal += capacity - load;
      }
    }
    if (overloaded.length === 0) continue; // dept is fine — no signal

    // ① Spread first: adjacent under-loaded days can absorb everything.
    if (slackTotal >= overflowTotal) {
      signals.push({
        dept,
        capacityMinPerDay: capacity,
        windowLoadMin: Math.round(windowLoadMin),
        windowCapacityMin,
        mode: "SPREAD",
        overloadedDays: overloaded,
        delayCandidates: [],
        note:
          `${overloaded.length} overloaded day(s) but the ${windowDays.length}-day window has ` +
          `${Math.round(slackTotal / 60)}h of slack — rebalance due dates to adjacent lighter days, no OT needed.`,
      });
      continue;
    }

    // ② Early, SPREAD OT — deficit after using every slack hour, split evenly
    //    across the WHOLE window (start now, never a last-minute spike),
    //    capped at 2h/day. ③ If even that can't absorb it → delay the
    //    lowest-priority orders (latest customer DD).
    const deficitMin = overflowTotal - slackTotal;
    const otCapMin = windowDays.length * OT_MAX_HOURS_PER_DAY * 60;
    const perDayHours = Math.min(
      OT_MAX_HOURS_PER_DAY,
      Math.ceil((deficitMin / windowDays.length / 60) * 2) / 2, // ½h steps
    );
    for (const row of overloaded) {
      row.suggestedOtHours = perDayHours;
    }
    if (deficitMin <= otCapMin) {
      signals.push({
        dept,
        capacityMinPerDay: capacity,
        windowLoadMin: Math.round(windowLoadMin),
        windowCapacityMin,
        mode: "OT",
        overloadedDays: overloaded,
        delayCandidates: [],
        note:
          `window is ${Math.round(deficitMin / 60)}h over even after spreading — start EARLY: ` +
          `~${perDayHours}h OT/day (max ${OT_MAX_HOURS_PER_DAY}h, spread across the window, no last-minute spikes).`,
      });
    } else {
      // OT caps insufficient — some orders must just be late (owner red-line:
      // 宁可迟交也不压榨人). Recommend the latest-customer-DD orders first.
      const ddMap = soDd.get(dept) ?? new Map<string, string | null>();
      const delayCandidates = [...ddMap.entries()]
        .sort((a, b) => (b[1] ?? "9999-99-99").localeCompare(a[1] ?? "9999-99-99"))
        .slice(0, 5)
        .map(([soRef, customerDd]) => ({ soRef, customerDd }));
      const beyondMin = deficitMin - otCapMin;
      signals.push({
        dept,
        capacityMinPerDay: capacity,
        windowLoadMin: Math.round(windowLoadMin),
        windowCapacityMin,
        mode: "DELAY",
        overloadedDays: overloaded,
        delayCandidates,
        note:
          `even ${OT_MAX_HOURS_PER_DAY}h/day OT across all ${windowDays.length} days leaves ` +
          `~${Math.round(beyondMin / 60)}h unabsorbed — delay the lowest-priority orders ` +
          `(latest customer DD) and tell the customers EARLY.`,
      });
    }
  }
  signals.sort((a, b) => b.windowLoadMin / b.windowCapacityMin - a.windowLoadMin / a.windowCapacityMin);
  return signals;
}

// ── Entry point ──────────────────────────────────────────────────────────────

export interface RunLearningOptions {
  /**
   * Write NEW config_proposals rows for sustained handoff drift. Only the
   * cron / Run-now paths set this — a plain GET render never writes.
   */
  emitProposals?: boolean;
}

/**
 * Run the full Phase-3 learning loop. Self-contained (loads its own holiday
 * calendar + capacity config); read-only unless opts.emitProposals.
 */
export async function runLearning(
  db: DbLike,
  opts: RunLearningOptions = {},
): Promise<LearningData> {
  const today = ymdInSgt();
  const holidays = await loadHolidaySet(db);
  const prevDate = previousWorkingDay(today, holidays);
  const cfg = await loadCapacityConfig(db);

  const capacityByDept = await collectRollingCapacity(db, today, holidays);
  const [{ rows: adherence, overallPct }, handoffs, ot] = await Promise.all([
    collectAdherence(db, prevDate, capacityByDept),
    collectHandoffFindings(db, cfg.chain, today, holidays),
    collectOtSignals(db, today, holidays, capacityByDept),
  ]);

  if (opts.emitProposals) {
    await emitConfigProposals(db, handoffs);
  }
  const pendingConfigProposals = await countPendingConfigProposals(db);

  return {
    date: today,
    prevDate,
    adherence,
    overallAdherencePct: overallPct,
    handoffs,
    pendingConfigProposals,
    ot,
  };
}
