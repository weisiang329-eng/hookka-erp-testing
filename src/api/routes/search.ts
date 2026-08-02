// ---------------------------------------------------------------------------
// GET /api/search?q=&limit= — one round trip, everything findable.
//
// WHAT THIS REPLACES
// The Ctrl+K palette fanned out SIX separate HTTP requests from the browser on
// every keystroke (sales orders, customers, products, delivery orders,
// invoices, consignment notes) and covered only those six things. Purchase
// orders, GRNs, purchase invoices, suppliers, production orders, service
// orders, service cases, employees, leads and journal entries were not
// findable from search at all.
//
// Six browser requests per keystroke is also six connection acquisitions, and
// on this stack that is the expensive part — see
// /api/admin/health/db-connect. One request that runs the queries side by side
// on ONE connection is strictly cheaper, and it is what makes adding ten more
// searchable modules affordable.
//
// WHY NOT ONE UNION ALL
// A single UNION would be one query instead of N. It is also all-or-nothing:
// one renamed column anywhere and the entire search returns an error instead
// of degraded results. These queries run concurrently on the same connection,
// each isolated, so a broken source costs that source and nothing else. On a
// database whose largest table is 32k rows and where every search column is
// indexed, that trade is worth making.
//
// SAFETY
// Every table and column name comes from SEARCH_SOURCES, a module constant,
// and is checked against the live information_schema before use — no
// caller-supplied string is ever interpolated. The term and the org id are
// bound as parameters. Each source is gated on the caller's `read` permission
// for its own resource, so search can never surface a module the user cannot
// open.
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import type { Env } from "../worker";
import { getOrgId } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";
import {
  SEARCH_SOURCES,
  buildSourceSql,
  isSourceUsable,
  type SearchSource,
} from "../lib/search-sources";

const app = new Hono<Env>();

// Shortest term worth a database round trip. One or two characters match
// nearly every row and the result is noise, not search.
const MIN_TERM_LEN = 2;
const DEFAULT_PER_SOURCE = 6;

type Row = {
  rid?: string; label?: string; sub1?: string | null; sub2?: string | null; sub3?: string | null;
  // The pg driver lower-cases nothing, but the compat shim camelCases columns
  // on the way back; both spellings are read so a driver change cannot
  // silently empty the results (the repo's documented camelCase read trap).
  [k: string]: unknown;
};

/** Table → its column names, from the live schema. Cached per isolate. */
let columnsCache: Map<string, Set<string>> | null = null;

async function loadColumns(
  db: Env["Variables"]["DB"],
): Promise<Map<string, Set<string>>> {
  if (columnsCache) return columnsCache;
  const tables = [...new Set(SEARCH_SOURCES.map((s) => s.table))];
  const placeholders = tables.map(() => "?").join(",");
  const out = new Map<string, Set<string>>();
  try {
    const res = await db
      .prepare(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name IN (${placeholders})`,
      )
      .bind(...tables)
      .all<{ table_name?: string; tableName?: string; column_name?: string; columnName?: string }>();
    for (const r of res.results ?? []) {
      const t = String(r.table_name ?? r.tableName ?? "");
      const col = String(r.column_name ?? r.columnName ?? "");
      if (!t || !col) continue;
      if (!out.has(t)) out.set(t, new Set());
      out.get(t)!.add(col);
    }
  } catch {
    // No introspection → search nothing rather than guessing at identifiers.
    return new Map();
  }
  columnsCache = out;
  return out;
}

app.get("/", async (c) => {
  const term = (c.req.query("q") ?? c.req.query("search") ?? "").trim();
  if (term.length < MIN_TERM_LEN) {
    return c.json({ success: true, data: { term, groups: [], truncated: false } });
  }
  const perSource = Math.max(1, Math.min(20, parseInt(c.req.query("limit") ?? "", 10) || DEFAULT_PER_SOURCE));
  const orgId = getOrgId(c);
  const columns = await loadColumns(c.var.DB);

  // Permission is checked BEFORE querying, not after: a user without
  // procurement access should never cause a procurement query to run.
  const allowed: SearchSource[] = [];
  for (const s of SEARCH_SOURCES) {
    if (!isSourceUsable(s, columns)) continue;
    // requirePermission returns null when allowed and a 403 Response when
    // not; we only need the boolean, and the denial Response is discarded.
    if (await requirePermission(c, s.resource, "read")) continue;
    allowed.push(s);
  }

  const like = `%${term}%`;
  const settled = await Promise.all(
    allowed.map(async (s) => {
      const cols = columns.get(s.table)!;
      const { sql } = buildSourceSql(s, cols, perSource);
      const binds: unknown[] = s.searchCols.map(() => like);
      if (s.orgCol && cols.has(s.orgCol)) binds.push(orgId);
      try {
        const res = await c.var.DB.prepare(sql).bind(...binds).all<Row>();
        const items = (res.results ?? []).map((r) => {
          const id = String(r.rid ?? "");
          return {
            id,
            label: String(r.label ?? "") || id,
            sub: [r.sub1, r.sub2, r.sub3].filter((x) => x != null && String(x) !== "").map(String),
            href: `${s.hrefPrefix}${encodeURIComponent(id)}`,
          };
        }).filter((x) => x.id);
        return { kind: s.kind, group: s.groupLabel, items };
      } catch {
        // One source failing must not blank the whole palette.
        return { kind: s.kind, group: s.groupLabel, items: [], failed: true as const };
      }
    }),
  );

  const groups = settled.filter((g) => g.items.length > 0);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return c.json({
    success: true,
    data: {
      term,
      groups,
      total,
      // True when at least one group filled its per-source limit, so the UI can
      // say "keep typing" rather than implying these are all the matches.
      truncated: groups.some((g) => g.items.length >= perSource),
      sourcesSearched: allowed.length,
      sourcesFailed: settled.filter((g) => "failed" in g && g.failed).map((g) => g.kind),
    },
  });
});

export default app;
