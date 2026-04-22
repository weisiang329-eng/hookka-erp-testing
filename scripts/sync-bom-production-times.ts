// ---------------------------------------------------------------------------
// Sync per-product per-dept production times from Production Sheet → REMOTE
// D1 bom_templates.wipComponents. Each product's BOM owns its own process
// minutes (we never touch bom_master_templates).
//
// Sheet → tree mapping:
//   • SKU BF row has THREE sections of dept columns:
//       - FG-level       (cols 8..13)  : FAB_CUT / FAB_SEW / FOAM
//       - Divan sub-WIP  (cols 14..25) : WOOD_CUT / FRAMING / WEBBING / UPHOLSTERY / PACKING
//       - HB sub-WIP     (cols 27..38) : WOOD_CUT / FRAMING / WEBBING / UPHOLSTERY / PACKING
//   • SKU SF row has FIVE sections:
//       - FG-level       (cols 11..16) : FAB_CUT / PACKING / UPHOLSTERY
//       - L2-1 (BASE)    (cols 17..28) : FAB_SEW / FOAM / WOOD_CUT / FRAMING / WEBBING
//       - L2-2 (CUSHION) (cols 29..40)
//       - L2-3 (ARMREST) (cols 41..52) — name tells us LEFT vs RIGHT arm
//       - L2-4 (ARMREST) (cols 53..64)
//
// Distribution rule: for each (section, deptCode) pair we find all matching
// process nodes in the BOM tree restricted to that section's subtree (or the
// full tree for FG-level sections), then SPLIT the sheet minutes EVENLY
// across those nodes and set category on every match. Idempotent — re-running
// with unchanged sheet produces no diff.
//
// Sofa PACKING (FG-level) is written to l1Processes[] since the tree itself
// has no PACKING node for sofas.
//
// Run: npx tsx scripts/sync-bom-production-times.ts
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";
import type * as XLSX from "xlsx";

const require = createRequire(import.meta.url);
// xlsx is CJS — loading via require avoids tsx's ESM interop problems.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const xl = require("xlsx") as typeof XLSX;

const SHEET = "C:/Users/User/Downloads/Production Sheet (9).xlsx";
const PROD = "https://hookka-erp-testing.pages.dev";
const EMAIL = "weisiang329@gmail.com";
const PASSWORD = "CbpxqJQpjy3VA5yd3Q";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type DeptCode =
  | "FAB_CUT"
  | "FAB_SEW"
  | "FOAM"
  | "WOOD_CUT"
  | "FRAMING"
  | "WEBBING"
  | "UPHOLSTERY"
  | "PACKING";

const DEPT_NAME_TO_CODE: Record<string, DeptCode> = {
  "Fabric Cutting": "FAB_CUT",
  "Fabric Sewing": "FAB_SEW",
  "Foam Bonding": "FOAM",
  "Wood Cutting": "WOOD_CUT",
  Framing: "FRAMING",
  Webbing: "WEBBING",
  Upholstery: "UPHOLSTERY",
  Packing: "PACKING",
};

const DEPT_CODE_TO_NAME: Record<DeptCode, string> = {
  FAB_CUT: "Fabric Cutting",
  FAB_SEW: "Fabric Sewing",
  FOAM: "Foam Bonding",
  WOOD_CUT: "Wood Cutting",
  FRAMING: "Framing",
  WEBBING: "Webbing",
  UPHOLSTERY: "Upholstery",
  PACKING: "Packing",
};

type SheetDept = { deptCode: DeptCode; minutes: number; category: string };

// Each sheet row produces one or more "sections" — a filter (predicate over a
// top-level wipItem) + the dept values to push into nodes inside that section.
type Section = {
  // Predicate over the top-level wipItem (returns true for the subtrees this
  // section's values should be applied to). `null` = apply tree-wide.
  topFilter: ((topWipCode: string, topWipType: string) => boolean) | null;
  depts: SheetDept[];
  // If true, the section writes to l1Processes instead of walking the tree.
  l1Only?: boolean;
};

type SheetProduct = {
  code: string;
  category: "BEDFRAME" | "SOFA";
  sections: Section[];
};

type ProcessNode = {
  dept?: string;
  deptCode: DeptCode;
  category?: string;
  minutes: number;
};

type WipNode = {
  wipCode?: string;
  wipType?: string;
  processes?: ProcessNode[];
  children?: WipNode[];
  [k: string]: unknown;
};

type BomTemplate = {
  id: string;
  productCode: string;
  baseModel?: string;
  category?: "BEDFRAME" | "SOFA";
  l1Processes: ProcessNode[] | unknown;
  wipComponents: WipNode[] | unknown;
  version: string;
  versionStatus: string;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  changeLog?: string | null;
};

type ApiResp<T = unknown> = {
  success?: boolean;
  data?: T;
  error?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function login(): Promise<string> {
  const r = await fetch(`${PROD}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = (await r.json()) as { data?: { token?: string } };
  if (!j.data?.token) throw new Error("login failed");
  return j.data.token;
}

function normalizeCode(code: string): string {
  return code.replace(/[\s-]+/g, "").toUpperCase();
}

function n(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }
  return 0;
}

function s(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function parseJsonOrArray<T>(v: unknown, fallback: T): T {
  if (Array.isArray(v)) return v as unknown as T;
  if (typeof v === "string" && v.trim()) {
    try {
      const p = JSON.parse(v);
      return (p as T) ?? fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Sheet parsers
// ---------------------------------------------------------------------------
function parseSheetBF(wb: XLSX.WorkBook): SheetProduct[] {
  const ws = wb.Sheets["SKU BF"];
  const rows = xl.utils.sheet_to_json<(string | number | null)[]>(ws, {
    header: 1,
    defval: "",
  });
  const out: SheetProduct[] = [];
  // Column layout (validated against sheet header dump in audit):
  //   col 8..9   FAB_CUT
  //   col 10..11 FAB_SEW
  //   col 12..13 FOAM
  //   col 14     SKU L2-1 (Divan)
  //   col 16..17 WOOD_CUT
  //   col 18..19 FRAMING
  //   col 20..21 WEBBING
  //   col 22..23 UPHOLSTERY
  //   col 24..25 PACKING
  //   col 27     SKU L2-1 (HB)
  //   col 29..30 WOOD_CUT
  //   col 31..32 FRAMING
  //   col 33..34 WEBBING
  //   col 35..36 UPHOLSTERY
  //   col 37..38 PACKING
  const cell = (r: (string | number | null)[], c: number): unknown => r[c];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const code = s(r[0]);
    if (!code) continue;

    const fg: SheetDept[] = [];
    const pushFg = (code_: DeptCode, catCol: number, timeCol: number) => {
      const cat = s(cell(r, catCol));
      const mins = n(cell(r, timeCol));
      if (!cat && mins === 0) return;
      fg.push({ deptCode: code_, minutes: Math.round(mins), category: cat });
    };
    pushFg("FAB_CUT", 8, 9);
    pushFg("FAB_SEW", 10, 11);
    pushFg("FOAM", 12, 13);

    const divan: SheetDept[] = [];
    const pushDivan = (code_: DeptCode, catCol: number, timeCol: number) => {
      const cat = s(cell(r, catCol));
      const mins = n(cell(r, timeCol));
      if (!cat && mins === 0) return;
      divan.push({ deptCode: code_, minutes: Math.round(mins), category: cat });
    };
    pushDivan("WOOD_CUT", 16, 17);
    pushDivan("FRAMING", 18, 19);
    pushDivan("WEBBING", 20, 21);
    pushDivan("UPHOLSTERY", 22, 23);
    pushDivan("PACKING", 24, 25);

    const hb: SheetDept[] = [];
    const pushHb = (code_: DeptCode, catCol: number, timeCol: number) => {
      const cat = s(cell(r, catCol));
      const mins = n(cell(r, timeCol));
      if (!cat && mins === 0) return;
      hb.push({ deptCode: code_, minutes: Math.round(mins), category: cat });
    };
    pushHb("WOOD_CUT", 29, 30);
    pushHb("FRAMING", 31, 32);
    pushHb("WEBBING", 33, 34);
    pushHb("UPHOLSTERY", 35, 36);
    pushHb("PACKING", 37, 38);

    out.push({
      code,
      category: "BEDFRAME",
      sections: [
        { topFilter: null, depts: fg },
        { topFilter: (_wc, wt) => wt === "DIVAN", depts: divan },
        { topFilter: (_wc, wt) => wt === "HEADBOARD", depts: hb },
      ],
    });
  }
  return out;
}

function parseSheetSF(wb: XLSX.WorkBook): SheetProduct[] {
  const ws = wb.Sheets["SKU SF"];
  const rows = xl.utils.sheet_to_json<(string | number | null)[]>(ws, {
    header: 1,
    defval: "",
  });
  const out: SheetProduct[] = [];
  // Column layout:
  //   col 11..12 FAB_CUT (FG)
  //   col 13..14 PACKING (FG)
  //   col 15..16 UPHOLSTERY (FG)
  //   col 17     SKU L2-1 (BASE)    18=qty
  //   col 19..20 FAB_SEW
  //   col 21..22 FOAM
  //   col 23..24 WOOD_CUT
  //   col 25..26 FRAMING
  //   col 27..28 WEBBING
  //   col 29     SKU L2-2 (CUSHION)  30=qty
  //   col 31..32 FAB_SEW .. col 39..40 WEBBING
  //   col 41     SKU L2-3 (ARM)      42=qty
  //   col 43..44 FAB_SEW .. col 51..52 WEBBING
  //   col 53     SKU L2-4 (ARM)      54=qty
  //   col 55..56 FAB_SEW .. col 63..64 WEBBING
  const cell = (r: (string | number | null)[], c: number): unknown => r[c];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const code = s(r[0]);
    if (!code) continue;

    // FG-level
    const fg: SheetDept[] = [];
    const pushFg = (code_: DeptCode, catCol: number, timeCol: number) => {
      const cat = s(cell(r, catCol));
      const mins = n(cell(r, timeCol));
      if (!cat && mins === 0) return;
      fg.push({ deptCode: code_, minutes: Math.round(mins), category: cat });
    };
    pushFg("FAB_CUT", 11, 12);
    pushFg("PACKING", 13, 14);
    pushFg("UPHOLSTERY", 15, 16);

    // Helper to parse a L2 dept block (5 depts × 2 cols each, starting at `base`).
    const parseL2 = (base: number): SheetDept[] => {
      const acc: SheetDept[] = [];
      const depts: DeptCode[] = [
        "FAB_SEW",
        "FOAM",
        "WOOD_CUT",
        "FRAMING",
        "WEBBING",
      ];
      for (let k = 0; k < depts.length; k++) {
        const catCol = base + k * 2;
        const timeCol = base + k * 2 + 1;
        const cat = s(cell(r, catCol));
        const mins = n(cell(r, timeCol));
        if (!cat && mins === 0) continue;
        acc.push({
          deptCode: depts[k],
          minutes: Math.round(mins),
          category: cat,
        });
      }
      return acc;
    };

    const l2_1Name = s(cell(r, 17));
    const l2_1 = parseL2(19);

    const l2_2Name = s(cell(r, 29));
    const l2_2 = parseL2(31);

    const l2_3Name = s(cell(r, 41));
    const l2_3 = parseL2(43);

    const l2_4Name = s(cell(r, 53));
    const l2_4 = parseL2(55);

    // Build sections.
    const sections: Section[] = [];
    // FG — PACKING → l1Processes, FAB_CUT + UPHOLSTERY → tree-wide.
    const packingFg = fg.filter((d) => d.deptCode === "PACKING");
    const treeFg = fg.filter((d) => d.deptCode !== "PACKING");
    if (packingFg.length)
      sections.push({ topFilter: null, depts: packingFg, l1Only: true });
    if (treeFg.length) sections.push({ topFilter: null, depts: treeFg });

    // L2-1 (BASE)
    if (l2_1.length) {
      const isBase = (wc: string, wt: string) => {
        const u = wc.toUpperCase();
        return (
          wt === "SOFA_BASE" ||
          u.includes("BASE") ||
          (l2_1Name.toUpperCase().includes("BASE") &&
            wt !== "SOFA_CUSHION" &&
            wt !== "SOFA_ARMREST")
        );
      };
      sections.push({ topFilter: isBase, depts: l2_1 });
    }
    // L2-2 (CUSHION)
    if (l2_2.length) {
      const isCushion = (wc: string, wt: string) => {
        const u = wc.toUpperCase();
        return wt === "SOFA_CUSHION" || u.includes("CUSHION");
      };
      sections.push({ topFilter: isCushion, depts: l2_2 });
    }
    // L2-3 — match ARMREST by name (LEFT / RIGHT)
    if (l2_3.length) {
      const name = l2_3Name.toUpperCase();
      const wantLeft = name.includes("LEFT");
      const wantRight = name.includes("RIGHT");
      const isArm3 = (wc: string, wt: string) => {
        if (wt !== "SOFA_ARMREST") return false;
        const u = wc.toUpperCase();
        if (wantLeft) return u.includes("LEFT");
        if (wantRight) return u.includes("RIGHT");
        return true;
      };
      sections.push({ topFilter: isArm3, depts: l2_3 });
    }
    // L2-4 — match remaining arm
    if (l2_4.length) {
      const name = l2_4Name.toUpperCase();
      const wantLeft = name.includes("LEFT");
      const wantRight = name.includes("RIGHT");
      const isArm4 = (wc: string, wt: string) => {
        if (wt !== "SOFA_ARMREST") return false;
        const u = wc.toUpperCase();
        if (wantLeft) return u.includes("LEFT");
        if (wantRight) return u.includes("RIGHT");
        return true;
      };
      sections.push({ topFilter: isArm4, depts: l2_4 });
    }

    out.push({ code, category: "SOFA", sections });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tree mutation
// ---------------------------------------------------------------------------
type NodeRef = { node: WipNode; proc: ProcessNode };

function collectProcesses(
  tops: WipNode[],
  topFilter: ((wipCode: string, wipType: string) => boolean) | null,
): NodeRef[] {
  const out: NodeRef[] = [];
  const walk = (node: WipNode) => {
    const procs = Array.isArray(node.processes) ? node.processes : [];
    for (const p of procs) out.push({ node, proc: p });
    const kids = Array.isArray(node.children) ? node.children : [];
    for (const c of kids) walk(c);
  };
  for (const top of tops) {
    if (
      topFilter === null ||
      topFilter(s(top.wipCode), s(top.wipType as string))
    ) {
      walk(top);
    }
  }
  return out;
}

// Apply one section to a tree. Returns { applied, missed } counts.
// Strategy: for each dept, collect all matching process nodes under the
// section. Split minutes evenly (integer division, remainder distributed to
// first slots). Always set the category to match the sheet.
function applySection(
  tops: WipNode[],
  section: Section,
): { applied: number; missed: SheetDept[] } {
  const missed: SheetDept[] = [];
  let applied = 0;
  const candidates = collectProcesses(tops, section.topFilter);
  for (const d of section.depts) {
    const matches = candidates.filter((r) => r.proc.deptCode === d.deptCode);
    if (matches.length === 0) {
      missed.push(d);
      continue;
    }
    const base = Math.floor(d.minutes / matches.length);
    const rem = d.minutes - base * matches.length;
    for (let k = 0; k < matches.length; k++) {
      const slot = matches[k];
      const v = base + (k < rem ? 1 : 0);
      slot.proc.minutes = v;
      if (d.category) slot.proc.category = d.category;
      // keep the human-friendly `dept` label consistent.
      if (!slot.proc.dept) slot.proc.dept = DEPT_CODE_TO_NAME[d.deptCode];
      applied++;
    }
  }
  return { applied, missed };
}

// Apply a section's depts to l1Processes (upsert by deptCode).
function applyToL1(
  l1: ProcessNode[],
  section: Section,
): { applied: number } {
  let applied = 0;
  for (const d of section.depts) {
    const existing = l1.find((p) => p.deptCode === d.deptCode);
    if (existing) {
      existing.minutes = d.minutes;
      if (d.category) existing.category = d.category;
      if (!existing.dept) existing.dept = DEPT_CODE_TO_NAME[d.deptCode];
    } else {
      l1.push({
        dept: DEPT_CODE_TO_NAME[d.deptCode],
        deptCode: d.deptCode,
        category: d.category || "CAT 1",
        minutes: d.minutes,
      });
    }
    applied++;
  }
  return { applied };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("== Sync BOM Production Times → REMOTE ==");
  console.log("Logging in...");
  const token = await login();
  const auth: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };

  console.log(`Reading ${SHEET}...`);
  const wb = xl.readFile(SHEET);
  const bfRows = parseSheetBF(wb);
  const sfRows = parseSheetSF(wb);
  console.log(`  parsed SKU BF=${bfRows.length} SKU SF=${sfRows.length}`);

  console.log("Fetching bom_templates...");
  const tRes = await fetch(`${PROD}/api/bom/templates`, { headers: auth });
  const tJ = (await tRes.json()) as ApiResp<BomTemplate[]>;
  const templates = tJ.data ?? [];
  console.log(`  bom_templates=${templates.length}`);

  const tmplByNormCode = new Map<string, BomTemplate>();
  for (const t of templates)
    tmplByNormCode.set(normalizeCode(t.productCode), t);

  // Pre-snapshot of sample products for before/after display.
  const samples = ["1003-(K)", "5530-1NA"];
  const beforeSnap = new Map<string, BomTemplate>();
  for (const code of samples) {
    const t = tmplByNormCode.get(normalizeCode(code));
    if (t)
      beforeSnap.set(code, JSON.parse(JSON.stringify(t)) as BomTemplate);
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const failures: string[] = [];
  const missedReport: Array<{ code: string; missed: string[] }> = [];

  for (const row of [...bfRows, ...sfRows]) {
    const t = tmplByNormCode.get(normalizeCode(row.code));
    if (!t) {
      skipped++;
      continue;
    }
    const tree = parseJsonOrArray<WipNode[]>(t.wipComponents, []);
    const l1 = parseJsonOrArray<ProcessNode[]>(t.l1Processes, []);
    const rowMissed: string[] = [];

    for (const sec of row.sections) {
      if (sec.depts.length === 0) continue;
      if (sec.l1Only) {
        applyToL1(l1, sec);
      } else {
        const { missed } = applySection(tree, sec);
        for (const d of missed) {
          rowMissed.push(
            `${d.deptCode}(${d.minutes}) in section filter for ${row.code}`,
          );
        }
      }
    }
    if (rowMissed.length) missedReport.push({ code: row.code, missed: rowMissed });

    const body: Partial<BomTemplate> = {
      l1Processes: l1,
      wipComponents: tree,
    };
    try {
      const resp = await fetch(`${PROD}/api/bom/templates/${t.id}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify(body),
      });
      const j = (await resp.json()) as ApiResp<BomTemplate>;
      if (j.success) updated++;
      else {
        failed++;
        failures.push(`${row.code}: ${j.error || resp.status}`);
      }
    } catch (e) {
      failed++;
      failures.push(`${row.code}: ${(e as Error).message}`);
    }
  }

  console.log(
    `\nProducts: updated=${updated} skipped(no-bom-match)=${skipped} failed=${failed}`,
  );
  if (failures.length) {
    console.log("  failures (first 10):");
    failures.slice(0, 10).forEach((f) => console.log(`    ${f}`));
  }
  if (missedReport.length) {
    const total = missedReport.reduce((a, r) => a + r.missed.length, 0);
    console.log(
      `  sections with depts that had no matching tree node: ${missedReport.length} products, ${total} dept-sections`,
    );
    missedReport.slice(0, 5).forEach((m) => {
      console.log(`    ${m.code}:`);
      m.missed.slice(0, 4).forEach((x) => console.log(`      ${x}`));
    });
  }

  // =========================================================================
  // Verification (re-fetch sample products and compare)
  // =========================================================================
  console.log("\n--- Verification ---");
  const vRes = await fetch(`${PROD}/api/bom/templates`, { headers: auth });
  const vJ = (await vRes.json()) as ApiResp<BomTemplate[]>;
  const vMap = new Map<string, BomTemplate>();
  for (const t of vJ.data ?? [])
    vMap.set(normalizeCode(t.productCode), t);

  for (const code of samples) {
    const before = beforeSnap.get(code);
    const after = vMap.get(normalizeCode(code));
    if (!before || !after) {
      console.log(`  ${code}: (not found)`);
      continue;
    }
    console.log(`\n  === ${code} ===`);
    const dumpProcs = (
      label: string,
      tree: unknown,
      l1: unknown,
    ): Array<{ key: string; minutes: number; category: string }> => {
      const flat: Array<{ key: string; minutes: number; category: string }> =
        [];
      const tops = parseJsonOrArray<WipNode[]>(tree, []);
      const l1Arr = parseJsonOrArray<ProcessNode[]>(l1, []);
      for (const p of l1Arr) {
        flat.push({
          key: `l1.${p.deptCode}`,
          minutes: p.minutes,
          category: s(p.category),
        });
      }
      const walk = (node: WipNode, path: string) => {
        const procs = Array.isArray(node.processes) ? node.processes : [];
        for (const p of procs) {
          flat.push({
            key: `${path}.${p.deptCode}`,
            minutes: p.minutes,
            category: s(p.category),
          });
        }
        const kids = Array.isArray(node.children) ? node.children : [];
        for (const c of kids)
          walk(c, `${path}>${s(c.wipCode).slice(0, 18)}`);
      };
      for (const t of tops) walk(t, s(t.wipCode).slice(0, 18));
      console.log(`    --- ${label} ---`);
      for (const r of flat) {
        console.log(
          `      ${r.key.padEnd(60)} minutes=${r.minutes} cat=${r.category}`,
        );
      }
      return flat;
    };
    const beforeFlat = dumpProcs("BEFORE", before.wipComponents, before.l1Processes);
    const afterFlat = dumpProcs("AFTER", after.wipComponents, after.l1Processes);
    // summary of diffs
    const byKey = new Map<
      string,
      { before?: { m: number; c: string }; after?: { m: number; c: string } }
    >();
    for (const b of beforeFlat) {
      byKey.set(b.key, { before: { m: b.minutes, c: b.category } });
    }
    for (const a of afterFlat) {
      const v = byKey.get(a.key) || {};
      v.after = { m: a.minutes, c: a.category };
      byKey.set(a.key, v);
    }
    console.log(`    --- DIFF ---`);
    for (const [k, v] of byKey) {
      const bm = v.before?.m;
      const am = v.after?.m;
      if (bm !== am) {
        console.log(
          `      ${k.padEnd(60)} ${bm ?? "-"} → ${am ?? "-"} (cat ${v.before?.c ?? "-"} → ${v.after?.c ?? "-"})`,
        );
      }
    }
  }

  console.log("\n===================== SUMMARY =====================");
  console.log(
    `sheet rows: BF=${bfRows.length} SF=${sfRows.length} total=${bfRows.length + sfRows.length}`,
  );
  console.log(
    `templates updated=${updated} skipped(no-match)=${skipped} failed=${failed}`,
  );
  if (missedReport.length) {
    console.log(
      `products with unmatched dept-sections: ${missedReport.length}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
