// ---------------------------------------------------------------------------
// component-kit-subbom.test.mjs — reusable kit sub-BOMs (owner 2026-07-31).
//
// A mechanism / leg SKU is bound ONCE to the screws it always needs, and every
// product BOM referencing that SKU auto-explodes the screws into consumption /
// costing (the orthodox multi-level-BOM / "kit" approach, 乙). Two layers:
//   1. FUNCTIONAL — component-bom.ts saveKit + explodeKits against a compact
//      in-memory D1 stub (the explosion math, the parent-line-preserved rule,
//      the self-guard, the qty × waste inheritance).
//   2. STRUCTURAL — the route surface, worker mount, cascade wiring, and the
//      Maintenance page + sidebar/route are present (repo idiom).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping handles the .ts import */
}

// ---- Compact D1 stub: only the SQL component-bom.ts issues -----------------
function makeDb(seed = []) {
  let rows = seed.map((r) => ({ ...r })); // component_bom_lines
  function prepare(sql) {
    const s = sql.trim().replace(/\s+/g, " ");
    let bound = [];
    const obj = {
      bind(...args) {
        bound = args;
        return obj;
      },
      async run() {
        if (/^CREATE (TABLE|INDEX)/i.test(s)) return { success: true };
        if (/^DELETE FROM component_bom_lines WHERE parent_code = \?/i.test(s)) {
          const [code] = bound;
          rows = rows.filter((r) => r.parent_code !== code);
          return { success: true };
        }
        if (/^INSERT INTO component_bom_lines/i.test(s)) {
          const [id, org_id, parent_code, parent_name, child_code, child_name, qty_per, waste_pct, created_at] = bound;
          rows.push({ id, org_id, parent_code, parent_name, child_code, child_name, qty_per, waste_pct, created_at });
          return { success: true };
        }
        return { success: true };
      },
      async all() {
        if (/FROM component_bom_lines WHERE \(org_id = \? OR org_id IS NULL\)/i.test(s)) {
          const [org] = bound;
          const out = rows.filter((r) => r.org_id === org || r.org_id == null);
          out.sort((a, b) =>
            a.parent_code === b.parent_code
              ? String(a.child_code).localeCompare(String(b.child_code))
              : String(a.parent_code).localeCompare(String(b.parent_code)),
          );
          return { results: out };
        }
        // explodeKits: SELECT ... WHERE parent_code IN (?, ?, ...)
        if (/FROM component_bom_lines WHERE parent_code IN/i.test(s)) {
          const set = new Set(bound);
          return { results: rows.filter((r) => set.has(r.parent_code)) };
        }
        return { results: [] };
      },
      async first() {
        return null;
      },
    };
    return obj;
  }
  return {
    prepare,
    async batch(stmts) {
      for (const st of stmts) await st.run();
      return [];
    },
    _rows: () => rows,
  };
}

test("saveKit stores children; a kit cannot include its own parent", async () => {
  const { saveKit, loadKit } = await import("../src/api/lib/component-bom.ts");
  const db = makeDb();
  const ok = await saveKit(db, "org1", "MECH-PB", "Pushback mechanism", [
    { childCode: "SCR-M6", childName: "M6 screw", qtyPer: 4, wastePct: 0 },
    { childCode: "SCR-M8", childName: "M8 screw", qtyPer: 2, wastePct: 5 },
    { childCode: "BLANK", childName: "", qtyPer: 0, wastePct: 0 }, // dropped (qty 0)
  ]);
  assert.equal(ok.ok, true);
  assert.equal(ok.count, 2);
  const kit = await loadKit(db, "org1", "MECH-PB");
  assert.equal(kit.children.length, 2);
  // self-reference is rejected
  const bad = await saveKit(db, "org1", "MECH-PB", "x", [
    { childCode: "MECH-PB", childName: "self", qtyPer: 1, wastePct: 0 },
  ]);
  assert.equal(bad.ok, false);
});

test("explodeKits appends screw lines, multiplies qty, keeps the mechanism line", async () => {
  const { explodeKits } = await import("../src/api/lib/component-bom.ts");
  const db = makeDb([
    { id: "k1", org_id: "org1", parent_code: "MECH-PB", parent_name: "PB", child_code: "SCR-M6", child_name: "M6", qty_per: 4, waste_pct: 0 },
    { id: "k2", org_id: "org1", parent_code: "MECH-PB", parent_name: "PB", child_code: "SCR-M8", child_name: "M8", qty_per: 2, waste_pct: 10 },
  ]);
  const lines = [
    { code: "MECH-PB", inventoryCode: "MECH-PB", name: "Pushback", qtyPerUnit: 3, wastePct: 0, ownerWipKey: "SOFA::0", ownerDeptCodes: ["ASSY"] },
    { code: "PLY-18", inventoryCode: "PLY-18", name: "Plywood", qtyPerUnit: 1, wastePct: 0 },
  ];
  const out = await explodeKits(db, lines);
  // original 2 lines preserved + 2 screws appended
  assert.equal(out.length, 4);
  const m6 = out.find((l) => l.code === "SCR-M6");
  const m8 = out.find((l) => l.code === "SCR-M8");
  // per-FG qty = mechanism qty (3) × screws-each
  assert.equal(m6.qtyPerUnit, 12);
  assert.equal(m8.qtyPerUnit, 6);
  assert.equal(m8.wastePct, 10);
  // screws inherit the mechanism's repair-scope tags (assembled together)
  assert.equal(m6.ownerWipKey, "SOFA::0");
  assert.deepEqual(m6.ownerDeptCodes, ["ASSY"]);
  // the mechanism itself is untouched (still consumes on its own line)
  assert.ok(out.find((l) => l.code === "MECH-PB" && l.qtyPerUnit === 3));
  // a line with no kit is unchanged
  assert.ok(out.find((l) => l.code === "PLY-18" && l.qtyPerUnit === 1));
});

test("explodeKits is a no-op when no line matches a kit parent", async () => {
  const { explodeKits } = await import("../src/api/lib/component-bom.ts");
  const db = makeDb([
    { id: "k1", org_id: "org1", parent_code: "MECH-PB", parent_name: "PB", child_code: "SCR-M6", child_name: "M6", qty_per: 4, waste_pct: 0 },
  ]);
  const lines = [{ code: "FOAM-D35", inventoryCode: "FOAM-D35", name: "Foam", qtyPerUnit: 2, wastePct: 0 }];
  const out = await explodeKits(db, lines);
  assert.equal(out.length, 1);
  assert.equal(out[0].code, "FOAM-D35");
});

// ---- Structural: wiring is present -----------------------------------------
const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");
const flat = (p) => read(p).replace(/\s+/g, " ");

test("cascade explodes kits on the FINAL resolved lines", () => {
  const f = flat("src/api/lib/po-cost-cascade.ts");
  assert.match(f, /import \{ explodeKits \} from "\.\/component-bom"/);
  // resolveBomMaterials wraps the raw resolver + explodes.
  assert.match(f, /const lines = await resolveBomMaterialsRaw\(db, po\); return explodeKits\(db, lines\)/);
  assert.match(f, /async function resolveBomMaterialsRaw\(/);
});

test("routes: list / get / put / delete, RBAC-gated on bom", () => {
  const f = flat("src/api/routes/component-boms.ts");
  assert.match(f, /app\.get\("\/"/);
  assert.match(f, /app\.get\("\/:parentCode"/);
  assert.match(f, /app\.put\("\/:parentCode"/);
  assert.match(f, /app\.delete\("\/:parentCode"/);
  assert.match(f, /requirePermission\(c, "bom", "read"\)/);
  assert.match(f, /requirePermission\(c, "bom", "update"\)/);
});

test("worker mounts /api/component-boms", () => {
  const f = flat("src/api/worker.ts");
  assert.match(f, /import componentBoms from "\.\/routes\/component-boms"/);
  assert.match(f, /app\.route\("\/api\/component-boms", componentBoms\)/);
});

test("BOM editor surfaces a read-only kit hint on kit-parent material lines", () => {
  const f = flat("src/pages/bom.tsx");
  // module-level parent-code set, populated from /api/component-boms on load
  assert.match(f, /const KIT_PARENT_CODES = new Set<string>\(\)/);
  assert.match(f, /cachedFetchJson<[^>]*>\("\/api\/component-boms"\)/);
  assert.match(f, /KIT_PARENT_CODES\.add\(k\.parentCode\)/);
  // the hint helper + badge render
  assert.match(f, /function materialHasKit\(m: WIPMaterial\)/);
  assert.match(f, /materialHasKit\(m\) && \(/);
});

test("Component Kits page + route + sidebar are wired", () => {
  const page = flat("src/pages/component-kits/index.tsx");
  assert.match(page, /\/api\/component-boms/);
  assert.match(page, /MaterialPicker/);
  assert.match(flat("src/dashboard-routes.tsx"), /path: '\/bom\/component-kits'/);
  assert.match(flat("src/components/layout/sidebar.tsx"), /name: "Component Kits", href: "\/bom\/component-kits"/);
});
