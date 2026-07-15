// ---------------------------------------------------------------------------
// schedule-proposals.ts — Phase 2 of the Production Agent: due-date PROPOSALS.
//
// The deterministic chain engine (planning-scheduler + planning-chain) computes
// realistic per-department dates, but job cards' persisted dueDate comes from a
// crude reverse-schedule and is often blank or already in the past. This lib:
//
//   1. ensureProposalTables — runtime self-apply for the two Phase-2 tables
//      (migrations do NOT auto-replay on deploy; a table reaches prod ONLY via
//      this CREATE-IF-NOT-EXISTS, same pattern as ensureNonprodRequests).
//   2. generateProposals — runs computeChainWithAssignments (the FULL chain,
//      identical to the department schedule pages) and upserts one PENDING
//      schedule_proposals row per active WAITING job card whose dueDate is
//      NULL, in the past, or differs from the engine's date. A prior PENDING
//      proposal for the same jc_id is marked SUPERSEDED first.
//   3. applyPendingProposals — the AUTONOMY path (owner ruling 2026-07-12:
//      reversible actions are the agent's own decision). When the console's
//      auto-approve gate for PRODUCTION is ON, agent-initiated runs call this
//      to write dueDates themselves (decided_by='AGENT_AUTO'), batch-capped
//      so one run stays inside the Workers subrequest limit. Same red lines
//      as the manual approve route: WAITING cards only + ONE rollbackable
//      plan_snapshots row per batch.
//
// Otherwise NOTHING here writes to job_cards — with the gate OFF, only the
// owner's approve route applies proposals.
// All columns are snake_case (no column-rename-map entry needed).
// ---------------------------------------------------------------------------

import { computeChainWithAssignments } from "../routes/planning-schedule";

// ── Runtime self-apply (ensureNonprodRequests pattern) ───────────────────────

let _proposalsMig: Promise<void> | null = null;
export function ensureProposalTables(db: D1Database): Promise<void> {
  if (_proposalsMig) return _proposalsMig;
  _proposalsMig = (async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS schedule_proposals (
           id TEXT PRIMARY KEY,
           generated_at TEXT NOT NULL,
           jc_id TEXT NOT NULL,
           po_id TEXT,
           dept TEXT,
           so_ref TEXT,
           lane TEXT,
           fabric TEXT,
           current_due TEXT,
           proposed_due TEXT NOT NULL,
           reason TEXT,
           status TEXT NOT NULL DEFAULT 'PENDING',
           decided_at TEXT,
           decided_by TEXT
         )`,
      )
      .run();
    await db
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_schedule_proposals_status ON schedule_proposals(status, generated_at DESC)",
      )
      .run();
    await db
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_schedule_proposals_jc ON schedule_proposals(jc_id, status)",
      )
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS plan_snapshots (
           id TEXT PRIMARY KEY,
           taken_at TEXT NOT NULL,
           date TEXT NOT NULL,
           payload TEXT NOT NULL
         )`,
      )
      .run();
  })();
  return _proposalsMig;
}

// ── Proposal generation ──────────────────────────────────────────────────────

export interface GenerateProposalsResult {
  /** Engine (job card, day) assignments examined. */
  scanned: number;
  /** New PENDING proposals written this run. */
  proposed: number;
  /** Prior PENDING proposals marked SUPERSEDED. */
  superseded: number;
  /** Stale PENDING proposals (>1 day old, unadopted) marked EXPIRED. */
  expired: number;
  /** Of the proposed: job cards that had NO dueDate at all. */
  unscheduled: number;
  /** Of the proposed: job cards whose dueDate was already in the past. */
  overdue: number;
}

interface Candidate {
  jcId: string;
  poId: string;
  dept: string;
  soRef: string;
  lane: string;
  fabric: string;
  currentDue: string | null;
  proposedDue: string;
  reason: string;
}

/** Local YYYY-MM-DD (never toISOString — that shifts by timezone). */
function localToday(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${dd}`;
}

// Keep chunks small so the flattened bind-parameter count stays comfortably
// under adapter limits (11 params per inserted row).
const CHUNK = 40;

/**
 * Auto-expire stale PENDING proposals not acted on within ~1 day (owner
 * 2026-07-15: unadopted schedule proposals pile up forever — the per-job-card
 * supersede only touches cards that reappear as candidates, so a card that drops
 * out of the plan leaves its PENDING row orphaned). This clears anything PENDING
 * generated more than 24h ago, keeping the Schedule Proposals table small (it had
 * grown to 1000+ rows, which is what made the Planning page lag). Marks EXPIRED —
 * not deleted — so the history stays. Mirrors the delivery agent's expiry.
 */
async function expireStalePendingProposals(
  db: D1Database,
  nowIso: string,
): Promise<number> {
  const cutoff = new Date(Date.parse(nowIso) - 86400000).toISOString();
  const prev = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM schedule_proposals
        WHERE status = 'PENDING' AND generated_at < ?`,
    )
    .bind(cutoff)
    .first<{ n: number | string }>();
  const count = Number(prev?.n) || 0;
  if (count > 0) {
    await db
      .prepare(
        `UPDATE schedule_proposals SET status = 'EXPIRED', decided_at = ?
          WHERE status = 'PENDING' AND generated_at < ?`,
      )
      .bind(nowIso, cutoff)
      .run();
  }
  return count;
}

export async function generateProposals(db: D1Database): Promise<GenerateProposalsResult> {
  await ensureProposalTables(db);
  // Clear proposals the owner never adopted within a day BEFORE regenerating.
  const expired = await expireStalePendingProposals(db, new Date().toISOString());
  // Housekeeping (owner 2026-07-16: "过期的没 delete 掉吗?"): expiry only MARKS
  // rows EXPIRED so recent history stays visible — but terminal rows
  // (EXPIRED / APPLIED / REJECTED) older than 7 days are dead weight, so
  // physically delete them here to keep the table lean over time.
  try {
    const purgeCut = new Date(Date.now() - 7 * 86400000).toISOString();
    await db
      .prepare(
        `DELETE FROM schedule_proposals
          WHERE status IN ('EXPIRED','APPLIED','REJECTED')
            AND COALESCE(decided_at, generated_at) < ?`,
      )
      .bind(purgeCut)
      .run();
  } catch (err) {
    console.warn("[schedule-proposals] terminal-row purge failed:", err);
  }

  const { assignments } = await computeChainWithAssignments(db);
  const today = localToday();

  // Protect committed/imminent work (owner 2026-07-15): never PROPOSE a date
  // change for job cards already SENT to production (distributedAt set) or due
  // within 3 days — they're locked in. The engine still counts them for
  // capacity; we only skip proposing to move them.
  const soon = new Date(today + "T00:00:00Z");
  soon.setUTCDate(soon.getUTCDate() + 3);
  const soonYmd = soon.toISOString().slice(0, 10);
  const protectedJcs = new Set<string>();
  try {
    const pr = await db
      .prepare(
        `SELECT id FROM job_cards
          WHERE status = 'WAITING'
            AND ( (distributedAt IS NOT NULL AND distributedAt <> '')
               OR ( dueDate IS NOT NULL AND dueDate <> ''
                    AND substr(dueDate,1,10) >= ? AND substr(dueDate,1,10) <= ? ) )`,
      )
      .bind(today, soonYmd)
      .all<{ id: string }>();
    for (const r of pr.results ?? []) protectedJcs.add(String(r.id));
  } catch (e) {
    console.warn("[schedule-proposals] protected-jc query failed:", e);
  }

  // ONE candidate per job card (each jc appears in exactly one dept's plan).
  const byJc = new Map<string, Candidate>();
  let unscheduled = 0;
  let overdue = 0;
  for (const a of assignments) {
    for (const jcId of a.jcIds) {
      if (protectedJcs.has(jcId)) continue; // sent / due within 3 days — locked
      const cur = a.currentDue;
      const proposed = a.date;
      let flavor: string | null = null;
      if (!cur) {
        flavor = "was unscheduled";
      } else if (cur < today) {
        flavor = `was overdue (due ${cur})`;
      } else if (cur !== proposed) {
        flavor = `moves ${cur} -> ${proposed}`;
      }
      if (!flavor) continue; // dueDate already matches the engine — no proposal
      if (!byJc.has(jcId)) {
        if (!cur) unscheduled++;
        else if (cur < today) overdue++;
      }
      const what =
        a.dept === "FAB_CUT"
          ? `CNC batch ${a.fabric || "(no fabric)"}`
          : `chain ${a.dept} day`;
      byJc.set(jcId, {
        jcId,
        poId: a.poId,
        dept: a.dept,
        soRef: a.soPo,
        lane: a.lane,
        fabric: a.fabric,
        currentDue: cur,
        proposedDue: proposed,
        reason: `${what} · ${flavor}`,
      });
    }
  }

  const cands = [...byJc.values()];
  const nowIso = new Date().toISOString();
  let superseded = 0;

  for (let i = 0; i < cands.length; i += CHUNK) {
    const chunk = cands.slice(i, i + CHUNK);
    const ids = chunk.map((x) => x.jcId);
    const ph = ids.map(() => "?").join(",");

    // Supersede any prior PENDING proposal for these job cards.
    const prev = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM schedule_proposals
          WHERE status = 'PENDING' AND jc_id IN (${ph})`,
      )
      .bind(...ids)
      .first<{ n: number | string }>();
    const nPrev = Number(prev?.n) || 0;
    if (nPrev > 0) {
      superseded += nPrev;
      await db
        .prepare(
          `UPDATE schedule_proposals SET status = 'SUPERSEDED', decided_at = ?
            WHERE status = 'PENDING' AND jc_id IN (${ph})`,
        )
        .bind(nowIso, ...ids)
        .run();
    }

    // Multi-row INSERT of the fresh PENDING proposals.
    const valuesSql = chunk.map(() => "(?,?,?,?,?,?,?,?,?,?,?)").join(",");
    const binds: unknown[] = [];
    for (const cd of chunk) {
      binds.push(
        crypto.randomUUID(),
        nowIso,
        cd.jcId,
        cd.poId,
        cd.dept,
        cd.soRef,
        cd.lane,
        cd.fabric,
        cd.currentDue,
        cd.proposedDue,
        cd.reason,
      );
    }
    await db
      .prepare(
        `INSERT INTO schedule_proposals
           (id, generated_at, jc_id, po_id, dept, so_ref, lane, fabric,
            current_due, proposed_due, reason)
         VALUES ${valuesSql}`,
      )
      .bind(...binds)
      .run();
  }

  return {
    scanned: assignments.length,
    proposed: cands.length,
    superseded,
    expired,
    unscheduled,
    overdue,
  };
}

// ── Autonomy: agent-decided apply (auto-approve gate ON) ─────────────────────

interface PendingRow {
  id: string;
  jc_id?: string;
  po_id?: string | null;
  dept?: string | null;
  so_ref?: string | null;
  current_due?: string | null;
  proposed_due?: string;
  // db-pg adapter folds snake_case → camelCase; dual-key every read.
  jcId?: string;
  poId?: string | null;
  soRef?: string | null;
  currentDue?: string | null;
  proposedDue?: string;
}

export interface ApplyProposalsResult {
  approved: number;
  skipped: number;
  remainingPending: number;
}

/**
 * Apply up to `limit` PENDING proposals in one pass (dueDate write on WAITING
 * cards only), mark them APPROVED with the given decidedBy, and store ONE
 * rollbackable plan_snapshots batch row. `limit` keeps a single run within
 * the Workers subrequest budget AND keeps each batch small enough for the
 * console's rollback-last-batch to revert safely — a big backlog drains over
 * several heartbeats instead of one giant write.
 */
export async function applyPendingProposals(
  db: D1Database,
  opts: { decidedBy: string; limit?: number },
): Promise<ApplyProposalsResult> {
  await ensureProposalTables(db);
  const limit = Math.max(1, Math.min(400, opts.limit ?? 300));
  const nowIso = new Date().toISOString();

  const res = await db
    .prepare(
      `SELECT * FROM schedule_proposals WHERE status = 'PENDING'
        ORDER BY so_ref, dept, jc_id LIMIT ?`,
    )
    .bind(limit)
    .all<PendingRow>();
  const rows = res.results ?? [];

  const applied: Array<{
    proposalId: string;
    jcId: string;
    poId: string | null;
    dept: string | null;
    soRef: string | null;
    from: string | null;
    to: string;
  }> = [];
  let skipped = 0;

  for (const row of rows) {
    const jcId = row.jcId ?? row.jc_id;
    const proposedDue = row.proposedDue ?? row.proposed_due;
    if (!jcId || !proposedDue) {
      skipped++;
      continue;
    }
    await db
      .prepare(
        `UPDATE job_cards SET dueDate = ?, updated_at = ?
          WHERE id = ? AND status = 'WAITING'`,
      )
      .bind(proposedDue, nowIso, jcId)
      .run();
    await db
      .prepare(
        `UPDATE schedule_proposals
            SET status = 'APPROVED', decided_at = ?, decided_by = ?
          WHERE id = ?`,
      )
      .bind(nowIso, opts.decidedBy, row.id)
      .run();
    applied.push({
      proposalId: row.id,
      jcId,
      poId: (row.poId ?? row.po_id) ?? null,
      dept: row.dept ?? null,
      soRef: (row.soRef ?? row.so_ref) ?? null,
      from: (row.currentDue ?? row.current_due) ?? null,
      to: proposedDue,
    });
  }

  if (applied.length > 0) {
    await db
      .prepare("INSERT INTO plan_snapshots (id, taken_at, date, payload) VALUES (?,?,?,?)")
      .bind(
        crypto.randomUUID(),
        nowIso,
        nowIso.slice(0, 10),
        JSON.stringify({ kind: "PROPOSALS_APPLIED", decidedBy: opts.decidedBy, applied }),
      )
      .run();
  }

  const remain = await db
    .prepare("SELECT COUNT(*) AS n FROM schedule_proposals WHERE status = 'PENDING'")
    .bind()
    .first<{ n: number | string }>();

  return {
    approved: applied.length,
    skipped,
    remainingPending: Number(remain?.n) || 0,
  };
}
