// ---------------------------------------------------------------------------
// component-bom.ts — reusable sub-BOMs ("kits") keyed by a raw_materials SKU.
//
// Owner ask (2026-07-31): a pushback mechanism, or a set of legs, always needs
// certain screws. Rather than re-listing those screws in every product BOM
// that uses the mechanism, we define them ONCE against the mechanism's own SKU
// — a small reusable sub-BOM. This is the orthodox multi-level-BOM ("phantom /
// kit") approach the owner chose (乙 over the lighter per-BOM binding table):
// define the mechanism → screw list in one place, and EVERY product BOM that
// references that mechanism auto-explodes the screws at consumption time.
//
//   parent_code  = the mechanism / leg raw_materials.itemCode
//   child_code   = a required screw (or any component) raw_materials.itemCode
//   qty_per      = how many children per ONE parent
//   waste_pct    = the child's own wastage (kept separate from the parent's)
//
// The parent (mechanism) is a real purchased stock item and still consumes on
// its own BOM line — the kit only ADDS the children it drags in. Explosion is
// one level deep and self/loop-guarded (a screw with its own kit is not
// re-exploded), which is all the shop needs and keeps consumption bounded.
//
// The table is self-applied at runtime (migrations are inert on deploy) before
// the first read/write, exactly like the other owner-added tables.
// ---------------------------------------------------------------------------

let ensured = false;

export async function ensureComponentBomTable(db: D1Database): Promise<void> {
  if (ensured) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS component_bom_lines (
         id TEXT PRIMARY KEY,
         org_id TEXT,
         parent_code TEXT NOT NULL,
         parent_name TEXT,
         child_code TEXT NOT NULL,
         child_name TEXT,
         qty_per REAL NOT NULL DEFAULT 0,
         waste_pct REAL NOT NULL DEFAULT 0,
         created_at TEXT
       )`,
    )
    .run();
  // Lookup is by parent_code (once per cascade), so index it.
  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS idx_component_bom_parent ON component_bom_lines (parent_code)",
    )
    .run();
  ensured = true;
}

export type KitChild = {
  childCode: string;
  childName: string;
  qtyPer: number;
  wastePct: number;
};

// All parent SKUs that currently have a kit, each with its child lines. Used by
// the Maintenance list. Grouped in memory so the API stays a flat table.
export type Kit = {
  parentCode: string;
  parentName: string;
  children: KitChild[];
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Rows come back from Supabase Postgres with the driver's snake_case →
// camelCase transform already applied (db-pg.ts `transform.column.from`), so
// `SELECT *` on this runtime-created table yields parentCode / childCode /
// qtyPer / wastePct — NOT the snake_case names the DDL declares. Reading only
// snake_case silently returned undefined for every column, which made
// listKits() skip every row (kits saved but the page showed "no kits yet")
// AND made explodeKits() find no kit at all (the screws never reached
// consumption / costing). Repo rule: read rows DUAL-KEYED. See CLAUDE.md
// "Read rows dual-keyed: r.camelCase ?? r.snake_case".
const str = (r: Record<string, unknown>, camel: string, snake: string): string =>
  String(r[camel] ?? r[snake] ?? "");
const dualNum = (r: Record<string, unknown>, camel: string, snake: string): number =>
  num(r[camel] ?? r[snake]);

export async function listKits(db: D1Database, orgId: string | null): Promise<Kit[]> {
  await ensureComponentBomTable(db);
  const res = await db
    .prepare(
      `SELECT * FROM component_bom_lines
        WHERE (org_id = ? OR org_id IS NULL)
        ORDER BY parent_code ASC, child_code ASC`,
    )
    .bind(orgId)
    .all<Record<string, unknown>>();
  const byParent = new Map<string, Kit>();
  for (const r of res.results ?? []) {
    const parentCode = str(r, "parentCode", "parent_code");
    if (!parentCode) continue;
    let kit = byParent.get(parentCode);
    if (!kit) {
      kit = { parentCode, parentName: str(r, "parentName", "parent_name"), children: [] };
      byParent.set(parentCode, kit);
    }
    kit.children.push({
      childCode: str(r, "childCode", "child_code"),
      childName: str(r, "childName", "child_name"),
      qtyPer: dualNum(r, "qtyPer", "qty_per"),
      wastePct: dualNum(r, "wastePct", "waste_pct"),
    });
  }
  return [...byParent.values()];
}

export async function loadKit(
  db: D1Database,
  orgId: string | null,
  parentCode: string,
): Promise<Kit | null> {
  const all = await listKits(db, orgId);
  return all.find((k) => k.parentCode === parentCode) ?? null;
}

// Replace the whole kit for one parent (delete + re-insert) inside one atomic
// batch. children[] with qtyPer <= 0 or a blank childCode are dropped. A parent
// may not include ITSELF as a child (that would loop the explosion).
export async function saveKit(
  db: D1Database,
  orgId: string | null,
  parentCode: string,
  parentName: string,
  children: KitChild[],
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  await ensureComponentBomTable(db);
  const code = parentCode.trim();
  if (!code) return { ok: false, error: "a parent SKU is required" };
  const clean = children
    .map((c) => ({
      childCode: String(c.childCode ?? "").trim(),
      childName: String(c.childName ?? "").trim(),
      qtyPer: num(c.qtyPer),
      wastePct: Math.max(0, num(c.wastePct)),
    }))
    .filter((c) => c.childCode && c.qtyPer > 0);
  if (clean.some((c) => c.childCode === code)) {
    return { ok: false, error: "a kit cannot include its own parent SKU" };
  }
  const stmts: D1PreparedStatement[] = [
    db
      .prepare("DELETE FROM component_bom_lines WHERE parent_code = ? AND (org_id = ? OR org_id IS NULL)")
      .bind(code, orgId),
  ];
  const now = new Date().toISOString();
  for (const c of clean) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO component_bom_lines
             (id, org_id, parent_code, parent_name, child_code, child_name, qty_per, waste_pct, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `kit-${crypto.randomUUID().slice(0, 12)}`,
          orgId,
          code,
          parentName.trim(),
          c.childCode,
          c.childName,
          c.qtyPer,
          c.wastePct,
          now,
        ),
    );
  }
  await db.batch(stmts);
  return { ok: true, count: clean.length };
}

// --- Cascade-side explosion --------------------------------------------------
// The shape below mirrors po-cost-cascade.ts's MaterialLine closely enough to
// explode without importing it (avoids a cycle). Only the fields the explosion
// reads / writes are typed; the rest ride along via the generic spread the
// caller uses. Kept intentionally structural.
export type ExplodableLine = {
  code: string;
  name: string;
  qtyPerUnit: number;
  wastePct: number;
  inventoryCode?: string;
  // repair-scope tags the screws must inherit from their owning mechanism line
  ownerDeptCodes?: string[];
  ownerWipKey?: string;
  ownerWipQty?: number;
};

// Given already-resolved BOM lines, append every kit child dragged in by a line
// whose SKU (inventoryCode preferred, else code) is a kit parent. One level
// deep: children are NOT themselves re-exploded, so a screw that happens to own
// a kit won't recurse. The parent line is left untouched (the mechanism still
// consumes on its own).
export async function explodeKits<T extends ExplodableLine>(
  db: D1Database,
  lines: T[],
): Promise<T[]> {
  if (lines.length === 0) return lines;
  await ensureComponentBomTable(db);
  // Distinct candidate parent SKUs present in this BOM.
  const parents = new Set<string>();
  for (const l of lines) {
    const key = (l.inventoryCode || l.code || "").trim();
    if (key) parents.add(key);
  }
  if (parents.size === 0) return lines;
  const codes = [...parents];
  const placeholders = codes.map(() => "?").join(", ");
  const res = await db
    .prepare(
      `SELECT parent_code, child_code, child_name, qty_per, waste_pct
         FROM component_bom_lines WHERE parent_code IN (${placeholders})`,
    )
    .bind(...codes)
    .all<Record<string, unknown>>();
  const rows = res.results ?? [];
  if (rows.length === 0) return lines;
  // parent_code → its child rows.
  const kitByParent = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const p = str(r, "parentCode", "parent_code");
    if (!p) continue;
    const arr = kitByParent.get(p) ?? [];
    arr.push(r);
    kitByParent.set(p, arr);
  }
  const out: T[] = [];
  for (const line of lines) {
    out.push(line);
    const key = (line.inventoryCode || line.code || "").trim();
    const kit = key ? kitByParent.get(key) : undefined;
    if (!kit) continue;
    for (const r of kit) {
      const childCode = str(r, "childCode", "child_code").trim();
      if (!childCode || childCode === key) continue; // self-guard
      const qtyPer = dualNum(r, "qtyPer", "qty_per");
      if (qtyPer <= 0) continue;
      out.push({
        ...line,
        code: childCode,
        inventoryCode: childCode,
        name: str(r, "childName", "child_name") || childCode,
        // per-FG qty of the screw = per-FG qty of the mechanism × screws-each
        qtyPerUnit: line.qtyPerUnit * qtyPer,
        wastePct: dualNum(r, "wastePct", "waste_pct"),
        // clear FILLER cut sizes if the parent line carried any — a screw is
        // a discrete count, never area-based.
        cutLengthIn: undefined,
        cutWidthIn: undefined,
        autoDetect: undefined,
        // ownerDeptCodes / ownerWipKey / ownerWipQty inherit from the parent
        // line via the spread above — the screws belong to the same node as
        // the mechanism, so a scoped repair treats them together.
      } as unknown as T);
    }
  }
  return out;
}
