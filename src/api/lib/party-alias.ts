// ---------------------------------------------------------------------------
// party-alias.ts — teach the scanners who a document belongs to, once.
//
// Owner 2026-08-01: 「无论什么情况我们改对了 OCR 就应该学习，不可能每次我们都手动
// 更改了他还不学，都教导他了啊」.
//
// The gap this closes
// -------------------
// Party IDENTITY ("which company is this document from?") had zero learned
// state. It was decided by pure string heuristics, and every correction the
// operator made was thrown away:
//
//   * the scan-sample confirm endpoints persist `correctedJson` + `isGold`
//     only — never the partyId the operator actually picked;
//   * the queue-based wizards don't even reach confirm (they carry a synthetic
//     or null sampleId), so `correctedJson` stays NULL forever;
//   * `distillSupplierRules` / `distillCustomerRules` take the partyId as an
//     INPUT and learn that party's DOCUMENT LAYOUT. They sit downstream of
//     identification and structurally cannot learn identity.
//
// Measured consequence: supplier 400-A002 was registered as "ADD WOORD TRADING
// SDN. BHD." (a typo — one letter). Against the real supplier list, BOTH
// matchers returned null, while edit distance ranked the right supplier at 1
// with the runner-up at 8. No amount of manual correction changed that, because
// nothing was ever written down.
//
// The fix is deliberately dumb and immediate: remember the exact name OCR read
// and the party the human filed it under. One row. Next scan hits it directly —
// no Anthropic call, no waiting for Sunday's distill cron.
//
// Scope (owner ruling): shared across document types WITHIN a party type. An
// alias taught on a Purchase Invoice also resolves a GRN or a PO from the same
// supplier — same company, same answer. Party types stay separate namespaces
// (a customer alias can never resolve a supplier).
//
// Key design: alias_norm = normalizeCompanyName(rawName), i.e. the same
// legal-suffix-stripping normaliser the tolerant matcher uses, so "ADD WOOD
// TRADING SDN BHD" and "ADD WOOD TRADING SDN. BHD." collapse to one alias
// instead of two. The raw string is kept alongside for the audit trail.
// ---------------------------------------------------------------------------
import { normalizeCompanyName } from "../../lib/company-name-match";

export type PartyType = "CUSTOMER" | "SUPPLIER" | "OTHER_PARTY";

export const PARTY_TYPES: readonly PartyType[] = [
  "CUSTOMER",
  "SUPPLIER",
  "OTHER_PARTY",
];

export function isPartyType(v: unknown): v is PartyType {
  return typeof v === "string" && (PARTY_TYPES as readonly string[]).includes(v);
}

type AliasDb = {
  prepare: (sql: string) => {
    bind: (...args: unknown[]) => {
      run: () => Promise<unknown>;
      first: <T = unknown>() => Promise<T | null>;
      all: <T = unknown>() => Promise<{ results?: T[] }>;
    };
    run: () => Promise<unknown>;
    all: <T = unknown>() => Promise<{ results?: T[] }>;
  };
};

export type AliasRow = {
  partyType: PartyType;
  partyId: string;
  aliasNorm: string;
  aliasRaw: string;
  hits: number;
};

// Migration files are inert on deploy (see CLAUDE.md) — the table has to be
// created at runtime, before the first read or write, exactly like scan_queue.
let ensured = false;
export async function ensurePartyAliasTable(db: AliasDb): Promise<void> {
  if (ensured) return;
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS party_name_aliases (
           id           TEXT PRIMARY KEY,
           org_id       TEXT,
           party_type   TEXT NOT NULL,
           party_id     TEXT NOT NULL,
           alias_norm   TEXT NOT NULL,
           alias_raw    TEXT NOT NULL,
           hits         INTEGER NOT NULL DEFAULT 1,
           created_by   TEXT,
           created_at   TEXT NOT NULL,
           last_used_at TEXT
         )`,
      )
      .run();
    // One answer per (org, type, normalised name) — re-teaching overwrites
    // rather than accumulating contradictory rows.
    await db
      .prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS party_name_aliases_key_idx
           ON party_name_aliases (org_id, party_type, alias_norm)`,
      )
      .run();
    await db
      .prepare(
        `CREATE INDEX IF NOT EXISTS party_name_aliases_party_idx
           ON party_name_aliases (party_type, party_id)`,
      )
      .run();
    ensured = true;
  } catch (e) {
    // Never block a scan on the alias table — the heuristics still work.
    console.warn(
      "[party-alias] ensure failed:",
      e instanceof Error ? e.message : e,
    );
  }
}

/** The dedup key for a scanned name. Empty when the name carries no letters. */
export function aliasKey(rawName: string | null | undefined): string {
  return normalizeCompanyName(rawName);
}

/**
 * Remember that `rawName` (as OCR read it) means `partyId`.
 *
 * Upsert on (org, type, normalised name): re-teaching the same name a NEW party
 * overwrites the old answer — the most recent human decision wins, because a
 * correction is exactly the signal that the previous answer was wrong.
 * Best-effort; never throws into the caller's create path.
 */
export async function recordPartyAlias(
  db: AliasDb,
  opts: {
    orgId: string;
    partyType: PartyType;
    partyId: string;
    rawName: string | null | undefined;
    createdBy?: string | null;
  },
): Promise<{ recorded: boolean; aliasNorm: string; reason?: string }> {
  const aliasNorm = aliasKey(opts.rawName);
  const aliasRaw = (opts.rawName ?? "").trim();
  if (!aliasNorm || !opts.partyId) {
    return { recorded: false, aliasNorm, reason: "empty name or party" };
  }
  await ensurePartyAliasTable(db);
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO party_name_aliases
           (id, org_id, party_type, party_id, alias_norm, alias_raw, hits, created_by, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT (org_id, party_type, alias_norm) DO UPDATE SET
           party_id     = EXCLUDED.party_id,
           alias_raw    = EXCLUDED.alias_raw,
           hits         = party_name_aliases.hits + 1,
           last_used_at = EXCLUDED.last_used_at`,
      )
      .bind(
        `alias-${crypto.randomUUID().slice(0, 12)}`,
        opts.orgId,
        opts.partyType,
        opts.partyId,
        aliasNorm,
        aliasRaw,
        opts.createdBy ?? null,
        now,
        now,
      )
      .run();
    return { recorded: true, aliasNorm };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`[party-alias] record "${aliasRaw}" failed: ${reason}`);
    return { recorded: false, aliasNorm, reason };
  }
}

/**
 * Every alias for one party type, as { aliasNorm → partyId }.
 *
 * Served to the scan modals alongside the catalog so the FE can resolve an
 * alias before falling back to heuristics — the matchers run client-side, so
 * they need the map in hand rather than a per-name round trip.
 */
export async function loadPartyAliasMap(
  db: AliasDb,
  orgId: string,
  partyType: PartyType,
): Promise<Record<string, string>> {
  await ensurePartyAliasTable(db);
  try {
    const res = await db
      .prepare(
        `SELECT alias_norm AS "aliasNorm", party_id AS "partyId"
           FROM party_name_aliases
          WHERE party_type = ? AND (org_id = ? OR org_id IS NULL)`,
      )
      .bind(partyType, orgId)
      .all<{ aliasNorm: string; partyId: string }>();
    const map: Record<string, string> = {};
    for (const r of res.results ?? []) {
      if (r.aliasNorm && r.partyId) map[r.aliasNorm] = r.partyId;
    }
    return map;
  } catch (e) {
    console.warn(
      "[party-alias] load failed:",
      e instanceof Error ? e.message : e,
    );
    return {};
  }
}

/** Resolve one scanned name against an already-loaded alias map. */
export function resolveAlias(
  aliasMap: Record<string, string> | null | undefined,
  rawName: string | null | undefined,
): string | null {
  if (!aliasMap) return null;
  const key = aliasKey(rawName);
  if (!key) return null;
  return aliasMap[key] ?? null;
}
