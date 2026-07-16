// ---------------------------------------------------------------------------
// service-agent.ts — the Service Agent's daily read-only after-sales digest.
//
// Owner 2026-07-16: one agent for service cases + after-sales QC/Quality.
// STRICTLY READ-ONLY — it never edits a case, order or QC tag; it only surfaces
// what needs attention so nothing slips after the sale:
//   • new cases   — OPEN / IN_PROGRESS service_cases opened in the last week
//   • untriaged   — open cases NOT linked to an original SO/CO (EXTERNAL / no
//                   source) — the ones needing a human to match + scope
//   • qc fails    — ACTIVE qc_tags raised in the last week (by severity)
// ---------------------------------------------------------------------------

/** Trailing window (calendar days) for "recent" cases + QC fails. */
const RECENT_DAYS = 7;

export interface ServiceDigest {
  date: string;
  newCases: Array<{ id: string; caseNo: string; customer: string; status: string }>;
  untriaged: Array<{ id: string; caseNo: string; customer: string }>;
  qcFails: Array<{ id: string; subject: string; severity: string; reason: string }>;
  qcBySeverity: { CRITICAL: number; MAJOR: number; MINOR: number };
  counts: { newCases: number; untriaged: number; qcFails: number };
}

function mytToday(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysAgoYmd(ymd: string, back: number): string {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/**
 * Compute (but never write) the after-sales digest. Each block fails soft — one
 * broken query returns an empty list, never a 500, so the console card always
 * renders.
 */
export async function runServiceDigest(
  db: D1Database,
  todayYmd: string = mytToday(),
): Promise<ServiceDigest> {
  const since = daysAgoYmd(todayYmd, RECENT_DAYS - 1);

  // 1 · New/open cases opened recently.
  const newCases: ServiceDigest["newCases"] = [];
  try {
    const r = await db
      .prepare(
        `SELECT id, caseNo, customerName, status, created_at
           FROM service_cases
          WHERE status IN ('OPEN','IN_PROGRESS')
            AND substr(created_at, 1, 10) >= ?
          ORDER BY created_at DESC
          LIMIT 200`,
      )
      .bind(since)
      .all<{
        id: string;
        caseNo?: string;
        caseno?: string;
        customerName?: string;
        customername?: string;
        status?: string;
      }>();
    for (const c of r.results ?? []) {
      newCases.push({
        id: c.id,
        caseNo: (c.caseNo ?? c.caseno ?? c.id) as string,
        customer: (c.customerName ?? c.customername ?? "") as string,
        status: c.status ?? "OPEN",
      });
    }
  } catch (e) {
    console.warn("[service-agent] new-cases query failed:", e);
  }

  // 2 · Untriaged — open cases with no matched original SO/CO.
  const untriaged: ServiceDigest["untriaged"] = [];
  try {
    const r = await db
      .prepare(
        `SELECT id, caseNo, customerName
           FROM service_cases
          WHERE status IN ('OPEN','IN_PROGRESS')
            AND (sourceType = 'EXTERNAL' OR sourceId IS NULL OR sourceId = '')
          ORDER BY created_at DESC
          LIMIT 200`,
      )
      .bind()
      .all<{ id: string; caseNo?: string; caseno?: string; customerName?: string; customername?: string }>();
    for (const c of r.results ?? []) {
      untriaged.push({
        id: c.id,
        caseNo: (c.caseNo ?? c.caseno ?? c.id) as string,
        customer: (c.customerName ?? c.customername ?? "") as string,
      });
    }
  } catch (e) {
    console.warn("[service-agent] untriaged query failed:", e);
  }

  // 3 · QC / Quality — ACTIVE fail-tags raised recently.
  const qcFails: ServiceDigest["qcFails"] = [];
  const qcBySeverity = { CRITICAL: 0, MAJOR: 0, MINOR: 0 };
  try {
    const r = await db
      .prepare(
        `SELECT id, subject_label, subject_code, severity, reason, tagged_at
           FROM qc_tags
          WHERE status = 'ACTIVE'
            AND substr(tagged_at, 1, 10) >= ?
          ORDER BY tagged_at DESC
          LIMIT 200`,
      )
      .bind(since)
      .all<{
        id: string;
        subject_label?: string;
        subjectLabel?: string;
        subject_code?: string;
        subjectCode?: string;
        severity?: string;
        reason?: string;
      }>();
    for (const t of r.results ?? []) {
      const sev = (t.severity ?? "MINOR").toUpperCase();
      if (sev === "CRITICAL") qcBySeverity.CRITICAL++;
      else if (sev === "MAJOR") qcBySeverity.MAJOR++;
      else qcBySeverity.MINOR++;
      qcFails.push({
        id: t.id,
        subject: (t.subjectLabel ?? t.subject_label ?? t.subjectCode ?? t.subject_code ?? "") as string,
        severity: sev,
        reason: (t.reason ?? "") as string,
      });
    }
  } catch (e) {
    console.warn("[service-agent] qc query failed:", e);
  }

  return {
    date: todayYmd,
    newCases,
    untriaged,
    qcFails,
    qcBySeverity,
    counts: {
      newCases: newCases.length,
      untriaged: untriaged.length,
      qcFails: qcFails.length,
    },
  };
}
