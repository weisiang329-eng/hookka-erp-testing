// ---------------------------------------------------------------------------
// MDM duplicate detection — Phase C #4 quick-win.
//
// Pure detection: scans customers / suppliers, returns candidate pairs that
// look like duplicates of each other. Caller decides when to enqueue them
// into mdm_review_queue (see migrations/0052_mdm_review_queue.sql).
//
// Detection rules (deliberately simple — Levenshtein is overkill for v1):
//   Customer:
//     * same `ssmNo` (non-empty) — score 100, signal 'ssm_match'
//     * same `phone` (non-empty) AND similar name — score 80,
//       signals ['phone_match', 'name_substring' | 'name_first3']
//   Supplier:
//     * same `registrationNo` (closest equivalent of SSM) — score 100,
//       signal 'reg_match'
//     * same `email` (non-empty) AND similar name — score 80,
//       signals ['email_match', 'name_substring' | 'name_first3']
//
// Why these rules:
//   - SSM / registration is the deterministic identifier (effectively a
//     gov-issued PK). If two rows share it, they ARE the same legal entity.
//   - Phone / email are weaker — same number could be a shared receptionist,
//     same email could be a generic ops@ inbox. We require a name signal
//     too so a 0.7+ confidence floor is real.
//
// Suppliers don't have a `bankAccount` column in the live schema (see
// migrations/0001_init.sql + 0023_suppliers_autocount.sql) — `email` is the
// closest non-name secondary signal that's already populated, so we use it
// in place of the spec's `bankAccount`. Future enhancement: add a
// `supplier_bank_accounts` child table and route the rule through that.
//
// Scope:
//   - All scans are orgId-scoped via the `orgId` column added in 0049.
//     suppliers DOES NOT yet have orgId — supplier scan ignores tenancy
//     for now (see TODO below; tracked under roadmap §1 finish step).
//   - Pair ordering: we always return (smaller_id, larger_id) so (A,B) and
//     (B,A) collapse to one row in mdm_review_queue (UNIQUE handles dedup).
//
// TODO: hook into a Cloudflare Cron Trigger once Pages Functions support
// scheduled events, or via the companion-Worker pattern documented in
// wrangler.toml. The endpoint POST /api/mdm/detection/run lets ops trigger
// the same pass manually until then.
// ---------------------------------------------------------------------------
import type { Env } from "../worker";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ResourceType = "customers" | "suppliers" | "products";

export type DuplicateCandidate = {
  resourceType: ResourceType;
  primaryId: string;
  candidateId: string;
  score: number;
  signals: string[];
};

export type DetectionRunStats = {
  scanned: { customers: number; suppliers: number };
  detected: { customers: number; suppliers: number };
  inserted: number;
  durationMs: number;
};

// ---------------------------------------------------------------------------
// Scan rows
// ---------------------------------------------------------------------------

type CustomerScanRow = {
  id: string;
  name: string | null;
  ssmNo: string | null;
  phone: string | null;
};

type SupplierScanRow = {
  id: string;
  name: string | null;
  registrationNo: string | null;
  email: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise a string for fuzzy matching: trim + lower-case. */
function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

/** Strip non-alphanumerics for SSM / registration / phone equality checks. */
function stripNonAlnum(s: string | null | undefined): string {
  return (s ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/** Order an id pair so (A,B) and (B,A) collapse to one. */
function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Cheap "names look similar" check — case-insensitive substring match
 * either direction, OR first-3-character match. Levenshtein is overkill
 * for a quick-win and would blow the Workers CPU budget on a full scan.
 */
function namesLookSimilar(
  a: string | null | undefined,
  b: string | null | undefined,
): { hit: boolean; signal?: string } {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return { hit: false };
  if (na === nb) return { hit: true, signal: "name_exact" };
  if (na.includes(nb) || nb.includes(na)) return { hit: true, signal: "name_substring" };
  if (na.length >= 3 && nb.length >= 3 && na.slice(0, 3) === nb.slice(0, 3)) {
    return { hit: true, signal: "name_first3" };
  }
  return { hit: false };
}

// ---------------------------------------------------------------------------
// Detectors — return pairs WITHOUT side effects so callers can preview.
// ---------------------------------------------------------------------------

/**
 * Scan customers for likely duplicates. Returns ordered, dedup-keyed pairs.
 * Higher-confidence signals override lower ones for the same pair (so an
 * SSM match wins over a phone+name match if both apply).
 */
export async function detectCustomerDuplicates(
  db: D1Database,
  orgId: string,
): Promise<DuplicateCandidate[]> {
  const res = await db
    .prepare(
      "SELECT id, name, ssmNo, phone FROM customers WHERE orgId = ? AND COALESCE(isActive, 1) = 1",
    )
    .bind(orgId)
    .all<CustomerScanRow>();
  const rows = res.results ?? [];

  // Bucket by ssmNo (cleaned) and by phone (digits only) for O(n) grouping.
  const bySsm = new Map<string, CustomerScanRow[]>();
  const byPhone = new Map<string, CustomerScanRow[]>();
  for (const r of rows) {
    const s = stripNonAlnum(r.ssmNo);
    if (s.length >= 4) {
      const arr = bySsm.get(s) ?? [];
      arr.push(r);
      bySsm.set(s, arr);
    }
    const p = stripNonAlnum(r.phone);
    if (p.length >= 6) {
      const arr = byPhone.get(p) ?? [];
      arr.push(r);
      byPhone.set(p, arr);
    }
  }

  // Deterministic key → highest-confidence candidate so SSM wins over phone.
  const out = new Map<string, DuplicateCandidate>();

  // Tier 1 — SSM match (deterministic, score 100).
  for (const group of bySsm.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [primaryId, candidateId] = orderedPair(group[i].id, group[j].id);
        const key = `${primaryId}::${candidateId}`;
        out.set(key, {
          resourceType: "customers",
          primaryId,
          candidateId,
          score: 100,
          signals: ["ssm_match"],
        });
      }
    }
  }

  // Tier 2 — phone + similar name (heuristic, score 80). Only added when
  // not already present from the SSM tier.
  for (const group of byPhone.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const sim = namesLookSimilar(a.name, b.name);
        if (!sim.hit) continue;
        const [primaryId, candidateId] = orderedPair(a.id, b.id);
        const key = `${primaryId}::${candidateId}`;
        if (out.has(key)) continue;
        out.set(key, {
          resourceType: "customers",
          primaryId,
          candidateId,
          score: 80,
          signals: ["phone_match", sim.signal ?? "name_match"],
        });
      }
    }
  }

  return Array.from(out.values());
}

/**
 * Scan suppliers for likely duplicates. Mirrors customer rules but uses
 * registrationNo (the closest SSM-equivalent in the suppliers schema —
 * see migrations/0023) and email (the closest secondary identifier — the
 * spec's bankAccount doesn't exist on the suppliers table).
 *
 * Note: suppliers does not yet have an `orgId` column (0049 only added it
 * to 5 leak-critical tables). Until §1 finish covers suppliers we can't
 * filter by tenant — the caller passes `orgId` purely so the inserted
 * mdm_review_queue rows are tagged correctly.
 */
export async function detectSupplierDuplicates(
  db: D1Database,
  _orgId: string,
): Promise<DuplicateCandidate[]> {
  const res = await db
    .prepare(
      "SELECT id, name, registrationNo, email FROM suppliers WHERE COALESCE(isActive, 1) = 1",
    )
    .all<SupplierScanRow>();
  const rows = res.results ?? [];

  const byReg = new Map<string, SupplierScanRow[]>();
  const byEmail = new Map<string, SupplierScanRow[]>();
  for (const r of rows) {
    const reg = stripNonAlnum(r.registrationNo);
    if (reg.length >= 4) {
      const arr = byReg.get(reg) ?? [];
      arr.push(r);
      byReg.set(reg, arr);
    }
    const em = norm(r.email);
    if (em.length > 0 && em.includes("@")) {
      const arr = byEmail.get(em) ?? [];
      arr.push(r);
      byEmail.set(em, arr);
    }
  }

  const out = new Map<string, DuplicateCandidate>();

  for (const group of byReg.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [primaryId, candidateId] = orderedPair(group[i].id, group[j].id);
        const key = `${primaryId}::${candidateId}`;
        out.set(key, {
          resourceType: "suppliers",
          primaryId,
          candidateId,
          score: 100,
          signals: ["reg_match"],
        });
      }
    }
  }

  for (const group of byEmail.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const sim = namesLookSimilar(a.name, b.name);
        if (!sim.hit) continue;
        const [primaryId, candidateId] = orderedPair(a.id, b.id);
        const key = `${primaryId}::${candidateId}`;
        if (out.has(key)) continue;
        out.set(key, {
          resourceType: "suppliers",
          primaryId,
          candidateId,
          score: 80,
          signals: ["email_match", sim.signal ?? "name_match"],
        });
      }
    }
  }

  return Array.from(out.values());
}

// ---------------------------------------------------------------------------
// Convenience: detect + insert.  Idempotent — UNIQUE (resourceType,
// primaryId, candidateId) on mdm_review_queue means re-running just skips
// the conflict.  We use INSERT ... ON CONFLICT DO NOTHING (Postgres) since
// SQLite-style INSERT OR IGNORE is rewritten by supabase-compat.
// ---------------------------------------------------------------------------

function genId(): string {
  return `mdm-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Run a full detection pass: scan customers + suppliers and insert every
 * new candidate pair into mdm_review_queue.  Existing pairs (same
 * resourceType/primaryId/candidateId) are skipped via the UNIQUE constraint
 * so re-runs are safe.
 *
 * Returns counts so the admin endpoint can report what happened.
 */
export async function runMdmDetectionPass(
  db: D1Database,
  orgId: string,
): Promise<DetectionRunStats> {
  const t0 = Date.now();

  const [custCount, suppCount] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS n FROM customers WHERE orgId = ?")
      .bind(orgId)
      .first<{ n: number }>(),
    db
      .prepare("SELECT COUNT(*) AS n FROM suppliers")
      .first<{ n: number }>(),
  ]);

  const [customers, suppliers] = await Promise.all([
    detectCustomerDuplicates(db, orgId),
    detectSupplierDuplicates(db, orgId),
  ]);

  const all = [...customers, ...suppliers];
  let inserted = 0;
  for (const c of all) {
    try {
      const result = await db
        .prepare(
          `INSERT INTO mdm_review_queue
             (id, resourceType, primaryId, candidateId, score, signals, status, orgId)
           VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)
           ON CONFLICT (resourceType, primaryId, candidateId) DO NOTHING`,
        )
        .bind(
          genId(),
          c.resourceType,
          c.primaryId,
          c.candidateId,
          c.score,
          JSON.stringify(c.signals),
          orgId,
        )
        .run();
      // D1 reports rowsWritten via meta.changes (postgres path returns
      // rowCount) — count only when the row actually landed.
      const changes =
        (result as unknown as { meta?: { changes?: number } }).meta?.changes ??
        0;
      if (changes > 0) inserted += 1;
    } catch (e) {
      // Defence in depth — even with ON CONFLICT in place, swallow per-row
      // errors so one bad pair doesn't sink the whole pass. Logged for
      // ops follow-up.
      console.error(
        "[mdm-detect] insert failed for",
        c.resourceType,
        c.primaryId,
        c.candidateId,
        e,
      );
    }
  }

  return {
    scanned: {
      customers: custCount?.n ?? 0,
      suppliers: suppCount?.n ?? 0,
    },
    detected: { customers: customers.length, suppliers: suppliers.length },
    inserted,
    durationMs: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// Test surface — re-export internals for unit tests without polluting the
// runtime module's public API. Routes import from this file and only see
// the named exports above.
// ---------------------------------------------------------------------------
export const __test = {
  norm,
  stripNonAlnum,
  orderedPair,
  namesLookSimilar,
};

// Helper passthrough so the route handler can import a single module rather
// than reaching into hono context internals.
export function dbFromCtx<E extends Env>(c: Context<E>): D1Database {
  return c.var.DB;
}
