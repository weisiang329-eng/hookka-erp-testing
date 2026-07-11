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
//
// NOTHING here writes to job_cards — the owner approves proposals in the
// Planning > Schedule Proposals tab, and only the approve route applies them.
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

export async function generateProposals(db: D1Database): Promise<GenerateProposalsResult> {
  await ensureProposalTables(db);

  const { assignments } = await computeChainWithAssignments(db);
  const today = localToday();

  // ONE candidate per job card (each jc appears in exactly one dept's plan).
  const byJc = new Map<string, Candidate>();
  let unscheduled = 0;
  let overdue = 0;
  for (const a of assignments) {
    for (const jcId of a.jcIds) {
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
    unscheduled,
    overdue,
  };
}
