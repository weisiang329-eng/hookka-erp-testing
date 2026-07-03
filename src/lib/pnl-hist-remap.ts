// ---------------------------------------------------------------------------
// pnl-hist-remap.ts — canonicalize the OWNER-KEYED historical P&L identities
// to the system chart of accounts, at LOAD time (owner complaint 2026-07-03:
// the Monthly P&L showed his historical material groups ("B.M Fabric") and
// expense lines (placeholder codes "900"/"780") as SEPARATE rows next to the
// engine's account-keyed rows ("701-0010 PURCHASE - B.M FABRIC")).
//
// Display-layer only: the stored pnl_historical rows are NEVER modified (iron
// rule — owner-entered data is untouched). A historical line adopts a COA
// identity ONLY on an exact normalized-name match (case / punctuation /
// spacing insensitive) plus an explicit spelling-variant alias list, and only
// within the section-compatible account types. Anything else keeps its own
// row — no fuzzy matching, so two different things can never collapse into
// one line (the 2026-07-02 lump-sum bug taught identity merges must be
// conservative).
// ---------------------------------------------------------------------------

export type CoaLite = { code: string; name: string; type: string };

type LineLike = { code: string; name: string };
type RmGroupLike = { group: string; description?: string };
type WindowLike = {
  revLines?: LineLike[];
  rmGroups?: RmGroupLike[];
  labourLines?: LineLike[];
  overheadLines?: LineLike[];
  otherIncomeLines?: LineLike[];
  expenseLines?: LineLike[];
};

const norm = (s: string): string => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "");

// Historical spelling variants → the COA spelling (normalized keys both sides).
const NAME_ALIASES: Record<string, string> = {
  FACTORYGENERALREQUISTION: "FACTORYGENERALREQUISITE",
  STAFFREFERSHMENT: "STAFFREFRESHMENT",
  POSTAGESTAMPS: "POSTAGESSTAMPS",
  UPKEEPOFOFFICEEQUIPMENT: "UPKEEPOFOFFICEEQUIPMENTS",
  SECRETARIALFEES: "SECRETARIALFEE",
  TRAVELLINGEXPENSE: "TRAVELLINGEXPENSES",
};
// Historical material-group names → the COA purchase-account suffix.
const RM_ALIASES: Record<string, string> = {
  PACKING: "PACKAGING",
};

const aliased = (key: string, aliases: Record<string, string>): string => aliases[key] ?? key;

export interface HistIdentityRemap {
  /** Mutates the window's line/group identities in place; returns #changed. */
  remapWindow(w: WindowLike): number;
}

export function buildHistIdentityRemap(coa: CoaLite[]): HistIdentityRemap {
  // Unique normalized-name → account (per allowed-type set). Names that
  // normalize identically for two accounts are dropped (ambiguous → no remap).
  const byName = new Map<string, CoaLite | null>();
  for (const a of coa) {
    const k = norm(a.name);
    if (!k) continue;
    byName.set(k, byName.has(k) ? null : a);
  }
  // COST accounts named "PURCHASE - X" indexed by norm(X) for material groups.
  const purchaseBySuffix = new Map<string, CoaLite | null>();
  for (const a of coa) {
    if (a.type !== "COST") continue;
    const m = /^PURCHASE\s*-\s*(.+)$/i.exec(a.name);
    if (!m) continue;
    const k = norm(m[1]);
    if (!k) continue;
    purchaseBySuffix.set(k, purchaseBySuffix.has(k) ? null : a);
  }
  const codeSet = new Set(coa.map((a) => a.code));

  const remapLines = (lines: LineLike[] | undefined, allowedTypes: ReadonlySet<string>): number => {
    if (!lines) return 0;
    let n = 0;
    for (const l of lines) {
      // Already a real account identity (code exists in the COA with this
      // exact name) → nothing to do.
      const hitByName = byName.get(aliased(norm(l.name), NAME_ALIASES));
      if (!hitByName) continue;
      if (!allowedTypes.has(hitByName.type)) continue;
      if (l.code === hitByName.code && l.name === hitByName.name) continue;
      l.code = hitByName.code;
      l.name = hitByName.name;
      n++;
    }
    return n;
  };

  return {
    remapWindow(w: WindowLike): number {
      let n = 0;
      for (const g of w.rmGroups ?? []) {
        if (codeSet.has(g.group)) continue; // already account-keyed (engine era)
        const hit = purchaseBySuffix.get(aliased(norm(g.group), RM_ALIASES));
        if (!hit) continue;
        g.group = hit.code;
        g.description = hit.name;
        n++;
      }
      const COST = new Set(["COST"]);
      const EXPENSE = new Set(["EXPENSE"]);
      const REVENUE = new Set(["REVENUE"]);
      n += remapLines(w.revLines, REVENUE);
      n += remapLines(w.labourLines, COST);
      n += remapLines(w.overheadLines, COST);
      n += remapLines(w.otherIncomeLines, REVENUE);
      n += remapLines(w.expenseLines, EXPENSE);
      return n;
    },
  };
}
