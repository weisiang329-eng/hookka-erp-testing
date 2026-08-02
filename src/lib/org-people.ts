// ---------------------------------------------------------------------------
// The org chart's people model.
//
// Hookka has TWO tables of people and no link between them:
//   * users   — office / management. Email + RBAC. 10 rows.
//   * workers — the factory floor. PIN login, no email, no account. 42 rows.
//
// A factory org chart that only draws the ten people with email addresses is
// not an org chart, so a node is identified by (source, id) rather than by a
// row in either table — "worker:worker-b311d39e", "user:42". A worker needs no
// account to appear, and nobody has to be duplicated into `users` to be drawn.
//
// Reporting lines live in their own table (`org_reporting`) keyed by that same
// composite, which is the only way an edge can cross the two tables: a worker
// reporting to an office manager is one row, in one place, with no FK that
// could point at either.
//
// Pure — no DB, no React — so the key format and the tree building are testable
// on their own.
// ---------------------------------------------------------------------------

export type PersonSource = "user" | "worker";

export type OrgPerson = {
  /** "user:12" / "worker:worker-b311d39e". Stable across both tables. */
  key: string;
  source: PersonSource;
  id: string;
  name: string;
  /** Job title. Falls back to the department when a position is not set. */
  position: string;
  /** Department CODE (FAB_CUT…) or "" when unassigned. */
  departmentCode: string;
  /** Employee number for a worker; email for an office user. */
  ref: string;
  active: boolean;
  /** Who this person reports to, or null at the top of a tree. */
  managerKey: string | null;
};

export type OrgNode = OrgPerson & { children: OrgNode[] };

/** Build the composite key. The ONLY place the format is written. */
export function personKey(source: PersonSource, id: string | number): string {
  return `${source}:${id}`;
}

/** Split a composite key back into its parts, or null if it is malformed. */
export function parsePersonKey(
  key: string,
): { source: PersonSource; id: string } | null {
  const i = String(key ?? "").indexOf(":");
  if (i <= 0) return null;
  const source = key.slice(0, i);
  const id = key.slice(i + 1);
  if ((source !== "user" && source !== "worker") || !id) return null;
  return { source, id };
}

/**
 * Would setting `managerKey` as `personKey`'s manager create a cycle?
 *
 * A cycle is not a cosmetic problem: the tree builder walks children from the
 * roots, so a loop simply drops everyone inside it off the chart with no error
 * to explain where they went. Checked before every write.
 */
export function wouldCycle(
  personKey_: string,
  managerKey: string | null,
  managerOf: ReadonlyMap<string, string | null>,
): boolean {
  if (!managerKey) return false;
  if (managerKey === personKey_) return true;
  const seen = new Set<string>([personKey_]);
  let cur: string | null = managerKey;
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = managerOf.get(cur) ?? null;
  }
  return false;
}

/**
 * Assemble the forest.
 *
 * A manager who is not in `people` (resigned, or filtered out) is treated as
 * absent and their reports become roots — a filtered chart still shows whole
 * teams instead of silently hiding everyone under a manager who was excluded.
 * Children are sorted by name so the layout is stable between loads.
 */
export function buildOrgTree(people: readonly OrgPerson[]): OrgNode[] {
  const present = new Set(people.map((p) => p.key));
  const childrenOf = new Map<string | null, OrgPerson[]>();
  for (const p of people) {
    const parent =
      p.managerKey && present.has(p.managerKey) && p.managerKey !== p.key
        ? p.managerKey
        : null;
    const arr = childrenOf.get(parent) ?? [];
    arr.push(p);
    childrenOf.set(parent, arr);
  }
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => a.name.localeCompare(b.name));
  }
  // Walk from the roots. `seen` also stops a cycle that reached the database
  // before the guard existed from hanging the render.
  const seen = new Set<string>();
  const attach = (p: OrgPerson): OrgNode => {
    seen.add(p.key);
    return {
      ...p,
      children: (childrenOf.get(p.key) ?? [])
        .filter((c) => !seen.has(c.key))
        .map(attach),
    };
  };
  return (childrenOf.get(null) ?? []).map(attach);
}

/** Everyone in a subtree, including its root — for counts on a collapsed box. */
export function countSubtree(node: OrgNode): number {
  return 1 + node.children.reduce((s, c) => s + countSubtree(c), 0);
}
