// ---------------------------------------------------------------------------
// Fresh import from Production Sheet (9).xlsx → REMOTE hookka-erp-testing D1.
//
// Five idempotent steps:
//   1. Fab Maint        → raw_materials (insert missing fabric codes)
//   2. Other Maint      → kv_config "variants-config"
//   3. SKU BF + SKU SF  → products PUT (prices, fabricUsage, unitM3, deptWorkingTimes)
//   4. Attendance tab   → workers (28 employees, columns H/I/J/K/L)
//   5. Fabric listing   → fabrics master table (only if /api/fabrics supports upsert)
//
// Run:  npx tsx scripts/seed-from-production-sheet.ts
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// xlsx is a CJS module — import via require so tsx doesn't choke on it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const xl = require("xlsx") as typeof import("xlsx");

const SHEET = "C:/Users/User/Downloads/Production Sheet (9).xlsx";
const PROD = "https://hookka-erp-testing.pages.dev";
const EMAIL = "weisiang329@gmail.com";
const PASSWORD = "CbpxqJQpjy3VA5yd3Q";

// Department name → code mapping (departments table codes).
const DEPT_NAME_TO_CODE: Record<string, string> = {
  "Fabric Cutting": "FAB_CUT",
  "Fabric Sewing": "FAB_SEW",
  "Foam Bonding": "FOAM",
  "Wood Cutting": "WOOD_CUT",
  Framing: "FRAMING",
  Webbing: "WEBBING",
  Upholstery: "UPHOLSTERY",
  Packing: "PACKING",
};

// Per user: these special-order names belong to SOFA; everything else (incl. "Divan A11") is BEDFRAME.
const SOFA_SO_NAMES = new Set<string>(
  [
    "NYLON FABRIC",
    "5537 BACKREST",
    'ADD 1" INFRONT L',
    "ADD 1 INFRONT L",
    "SEPERATE BACKREST PACKING",
    'SEAT ADD ON 4"',
    "SEAT ADD ON 4",
  ].map((s) => s.toUpperCase()),
);

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

function senFromDollars(v: unknown): number | null {
  if (v === "" || v == null) return null;
  const x = n(v);
  return Math.round(x * 100);
}

// ---------------------------------------------------------------------------
// 1. Fab Maint parser
// ---------------------------------------------------------------------------
type FabRow = { code: string; description: string; itemGroup: string };

function parseFabMaint(wb: xl.WorkBook): FabRow[] {
  const ws = wb.Sheets["Fab Maint"];
  const rows = xl.utils.sheet_to_json<(string | number)[]>(ws, {
    header: 1,
    defval: "",
  });
  const items: FabRow[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const code = String(rows[i]?.[0] ?? "").trim();
    if (!code) continue;
    const description = String(rows[i]?.[1] ?? "FABRIC").trim() || "FABRIC";
    const itemGroup = String(rows[i]?.[2] ?? "B.M-FABR").trim() || "B.M-FABR";
    const key = code.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ code, description, itemGroup });
  }
  return items;
}

// ---------------------------------------------------------------------------
// 2. Other Maint parser
// ---------------------------------------------------------------------------
type SO = { name: string; priceSen: number | null; baseFormula?: string };
type VariantsParse = {
  divanHeights: Array<{ height: string; priceSen: number }>;
  legHeights: Array<{ height: string; priceSen: number }>;
  gapHeights: string[];
  sofaSeatSizes: string[];
  bedframeSpecialOrders: SO[];
  sofaSpecialOrders: SO[];
};

function parseOtherMaint(wb: xl.WorkBook): VariantsParse {
  const ws = wb.Sheets["Other Maint"];
  const rows = xl.utils.sheet_to_json<(string | number)[]>(ws, {
    header: 1,
    defval: "",
  });

  const divans: Array<{ height: string; priceSen: number }> = [];
  const legs: Array<{ height: string; priceSen: number }> = [];
  const gaps: string[] = [];
  const specialOrdersRaw: Array<{ name: string; price: number | string }> = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const dIn = r[0],
      dP = r[1];
    const lIn = r[3],
      lP = r[4];
    const g = r[6];
    const soName = r[8],
      soP = r[9];

    if (dIn !== "" && dIn != null)
      divans.push({
        height: `${dIn}"`,
        priceSen: Math.round(n(dP) * 100),
      });
    if (lIn !== "" && lIn != null)
      legs.push({
        height: `${lIn}"`,
        priceSen: Math.round(n(lP) * 100),
      });
    if (g !== "" && g != null) gaps.push(`${g}"`);
    if (soName !== "" && soName != null)
      specialOrdersRaw.push({ name: String(soName).trim(), price: soP });
  }

  // Sofa seat sizes are in the column whose header contains "Sofa Size".
  const header0 = (rows[0] as string[]) || [];
  const sofaSizeCol = header0.findIndex((h) =>
    String(h).toLowerCase().includes("sofa size"),
  );
  const sofaSizes: string[] = [];
  if (sofaSizeCol >= 0) {
    for (let i = 1; i < rows.length; i++) {
      const v = rows[i]?.[sofaSizeCol];
      if (v !== "" && v != null) sofaSizes.push(`${v}"`);
    }
  }

  const bedframeSO: SO[] = [];
  const sofaSO: SO[] = [];
  for (const so of specialOrdersRaw) {
    const up = so.name.toUpperCase();
    const isSofa = SOFA_SO_NAMES.has(up);
    let priceSen: number | null = null;
    let baseFormula: string | undefined = undefined;
    if (typeof so.price === "number" && Number.isFinite(so.price)) {
      priceSen = Math.round(so.price * 100);
    } else if (typeof so.price === "string" && so.price.trim()) {
      const s = so.price.trim();
      if (/^\d/.test(s)) priceSen = Math.round(Number(s) * 100);
      else baseFormula = s; // "BASE PRICE /2" etc.
    }
    const entry: SO = { name: so.name, priceSen };
    if (baseFormula) entry.baseFormula = baseFormula;
    if (isSofa) sofaSO.push(entry);
    else bedframeSO.push(entry);
  }

  return {
    divanHeights: divans,
    legHeights: legs,
    gapHeights: gaps,
    sofaSeatSizes: sofaSizes,
    bedframeSpecialOrders: bedframeSO,
    sofaSpecialOrders: sofaSO,
  };
}

// ---------------------------------------------------------------------------
// 3. SKU BF / SF parser
// ---------------------------------------------------------------------------
type SkuRow = {
  code: string;
  basePriceSen: number | null; // from "Price 2"
  price1Sen: number | null; // from "Price 1"
  fabricUsage: number;
  unitM3: number;
  deptWorkingTimes: Array<{
    departmentCode: string;
    minutes: number;
    category: string;
  }>;
};

function parseSku(wb: xl.WorkBook, tab: "SKU BF" | "SKU SF"): SkuRow[] {
  const ws = wb.Sheets[tab];
  const rows = xl.utils.sheet_to_json<(string | number)[]>(ws, {
    header: 1,
    defval: "",
  });
  const header = (rows[0] as string[]) || [];

  // Header column lookup — headers can repeat, so we remember the FIRST match
  // (for single-occurrence columns like Product Code / Price 1 / Price 2).
  const colFirst = new Map<string, number>();
  for (let i = 0; i < header.length; i++) {
    const h = String(header[i]).trim();
    if (!h) continue;
    if (!colFirst.has(h)) colFirst.set(h, i);
  }

  const codeCol = colFirst.get("Product Code") ?? 0;
  const unitM3Col = colFirst.get("Unit M3") ?? -1;
  const fabricUsageCol = colFirst.get("Fabric Usage") ?? -1;
  // SKU BF has "Price 2" / "Price 1". SKU SF uses size columns; we default both to null there.
  const price2Col = colFirst.get("Price 2") ?? -1;
  const price1Col = colFirst.get("Price 1") ?? -1;

  // Per-dept columns — capture EVERY occurrence of the "<Dept> Category" /
  // "<Dept> Production Time" pair. Each section (FG, Divan, HB for BF /
  // FG, BASE, CUSHION, ARMs for SF) repeats the same headers, so one SKU row
  // can contribute minutes to the same dept from multiple sub-sections.
  type DeptColPair = { cat: number; time: number };
  const deptCols: Record<string, DeptColPair[]> = {};
  for (const deptName of Object.keys(DEPT_NAME_TO_CODE)) {
    deptCols[deptName] = [];
  }
  for (let i = 0; i < header.length; i++) {
    const h = String(header[i]).trim();
    if (!h) continue;
    for (const deptName of Object.keys(DEPT_NAME_TO_CODE)) {
      if (h === `${deptName} Production Time`) {
        // Find the closest preceding "<Dept> Category" column (may be i-1 in normal layout).
        let catCol = -1;
        for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
          if (String(header[j]).trim() === `${deptName} Category`) {
            catCol = j;
            break;
          }
        }
        deptCols[deptName].push({ cat: catCol, time: i });
      }
    }
  }

  const out: SkuRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const code = String(r[codeCol] ?? "").trim();
    if (!code) continue;
    const basePriceSen = price2Col >= 0 ? senFromDollars(r[price2Col]) : null;
    const price1Sen = price1Col >= 0 ? senFromDollars(r[price1Col]) : null;
    const fabricUsage = fabricUsageCol >= 0 ? n(r[fabricUsageCol]) : 0;
    const unitM3 = unitM3Col >= 0 ? n(r[unitM3Col]) : 0;
    const deptWorkingTimes: SkuRow["deptWorkingTimes"] = [];
    for (const [deptName, pairs] of Object.entries(deptCols)) {
      if (pairs.length === 0) continue;
      let totalMins = 0;
      const cats: string[] = [];
      for (const p of pairs) {
        const cat =
          p.cat >= 0 ? String(r[p.cat] ?? "").trim() : "";
        const mins = n(r[p.time]);
        if (mins > 0 || cat) {
          totalMins += mins;
          if (cat) cats.push(cat);
        }
      }
      if (totalMins === 0 && cats.length === 0) continue;
      // Category: if all sub-sections share the same cat, show it once;
      // otherwise join with "; " (e.g. "CAT 3; CAT 1; CAT 5").
      const uniqueCats = Array.from(new Set(cats));
      const category = uniqueCats.join("; ");
      deptWorkingTimes.push({
        departmentCode: DEPT_NAME_TO_CODE[deptName],
        minutes: Math.round(totalMins),
        category,
      });
    }
    out.push({
      code,
      basePriceSen,
      price1Sen,
      fabricUsage,
      unitM3,
      deptWorkingTimes,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Attendance employee list parser (cols H/I/J/K/L, rows 3..30)
// ---------------------------------------------------------------------------
type EmpRow = {
  name: string;
  deptName: string;
  salary: number;
  workingHour: number;
  workingDaysPerWeek: number;
};

function parseEmployees(wb: xl.WorkBook): EmpRow[] {
  const ws = wb.Sheets["Attendance"];
  const rows = xl.utils.sheet_to_json<(string | number)[]>(ws, {
    header: 1,
    defval: "",
  });
  const out: EmpRow[] = [];
  const seen = new Set<string>();
  // Header is row 2 (0-indexed); employee rows start at 3.
  for (let i = 3; i < rows.length; i++) {
    const r = rows[i] || [];
    const name = String(r[7] ?? "").trim();
    if (!name) continue;
    const deptName = String(r[8] ?? "").trim();
    if (!deptName || !DEPT_NAME_TO_CODE[deptName]) continue;
    const salary = n(r[9]);
    const workingHour = n(r[10]) || 9;
    const workingDaysPerWeek = n(r[11]) || 6;
    const key = name.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, deptName, salary, workingHour, workingDaysPerWeek });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
type ApiResp<T = unknown> = {
  success?: boolean;
  data?: T;
  error?: string;
  total?: number;
};

async function main() {
  console.log("== Seed from Production Sheet → REMOTE ==");
  console.log("Logging in...");
  const token = await login();
  const auth: HeadersInit = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };

  console.log(`Reading ${SHEET}...`);
  const wb = xl.readFile(SHEET);

  // =========================================================================
  // Fetch existing data once (shared across steps)
  // =========================================================================
  console.log("\nFetching existing remote data...");
  const [rmRes, prodRes, deptRes, workersRes] = await Promise.all([
    fetch(`${PROD}/api/raw-materials`, { headers: auth }),
    fetch(`${PROD}/api/products`, { headers: auth }),
    fetch(`${PROD}/api/departments`, { headers: auth }),
    fetch(`${PROD}/api/workers`, { headers: auth }),
  ]);
  const rmJ = (await rmRes.json()) as ApiResp<Array<{ itemCode: string }>>;
  const prodJ = (await prodRes.json()) as ApiResp<
    Array<{ id: string; code: string }>
  >;
  const deptJ = (await deptRes.json()) as ApiResp<
    Array<{ id: string; code: string; name: string }>
  >;
  const workersJ = (await workersRes.json()) as ApiResp<
    Array<{ id: string; empNo: string; name: string }>
  >;

  const existingFabricCodes = new Set(
    (rmJ.data ?? []).map((x) => x.itemCode.toUpperCase()),
  );
  const productByNormCode = new Map<string, { id: string; code: string }>();
  for (const p of prodJ.data ?? []) {
    productByNormCode.set(normalizeCode(p.code), p);
  }
  const deptCodeToId = new Map<string, string>();
  for (const d of deptJ.data ?? []) deptCodeToId.set(d.code, d.id);
  const existingWorkerNames = new Set(
    (workersJ.data ?? []).map((w) => w.name.toUpperCase()),
  );
  const existingEmpNos = new Set(
    (workersJ.data ?? []).map((w) => w.empNo.toUpperCase()),
  );
  console.log(`  raw_materials=${existingFabricCodes.size}`);
  console.log(`  products=${productByNormCode.size}`);
  console.log(`  departments=${deptCodeToId.size}`);
  console.log(`  workers=${existingWorkerNames.size}`);

  // =========================================================================
  // Step 1 — Fab Maint → raw_materials
  // =========================================================================
  console.log("\n=== Step 1: Fab Maint → raw_materials ===");
  const fabs = parseFabMaint(wb);
  console.log(`  parsed ${fabs.length} fabric rows`);
  let rmInserted = 0,
    rmSkipped = 0,
    rmFailed = 0;
  const rmFailures: string[] = [];
  for (const f of fabs) {
    if (existingFabricCodes.has(f.code.toUpperCase())) {
      rmSkipped++;
      continue;
    }
    const body = {
      itemCode: f.code,
      description: f.description,
      baseUOM: "METER",
      unit: "METER",
      itemGroup: f.itemGroup,
      status: "ACTIVE",
      balanceQty: 0,
      minStock: 0,
      maxStock: 0,
    };
    try {
      const r = await fetch(`${PROD}/api/raw-materials`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify(body),
      });
      const j = (await r.json()) as ApiResp;
      if (j.success) {
        rmInserted++;
        existingFabricCodes.add(f.code.toUpperCase());
      } else {
        rmFailed++;
        rmFailures.push(`${f.code}: ${j.error || r.status}`);
      }
    } catch (e) {
      rmFailed++;
      rmFailures.push(`${f.code}: ${(e as Error).message}`);
    }
  }
  console.log(
    `  inserted=${rmInserted} skipped=${rmSkipped} failed=${rmFailed}`,
  );
  if (rmFailures.length) {
    console.log("  failures (first 10):");
    rmFailures.slice(0, 10).forEach((f) => console.log(`    ${f}`));
  }

  // =========================================================================
  // Step 2 — Other Maint → kv_config variants-config
  // =========================================================================
  console.log("\n=== Step 2: Other Maint → kv_config variants-config ===");
  const variants = parseOtherMaint(wb);
  console.log(
    `  divanHeights=${variants.divanHeights.length} legHeights=${variants.legHeights.length} gapHeights=${variants.gapHeights.length}`,
  );
  console.log(
    `  sofaSeatSizes=${variants.sofaSeatSizes.length} bedframeSO=${variants.bedframeSpecialOrders.length} sofaSO=${variants.sofaSpecialOrders.length}`,
  );
  const existingVcRes = await fetch(`${PROD}/api/kv-config/variants-config`, {
    headers: auth,
  });
  const existingVcJ = (await existingVcRes.json()) as ApiResp<
    Record<string, unknown>
  >;
  const merged: Record<string, unknown> = {
    ...(existingVcJ.data ?? {}),
    divanHeights: variants.divanHeights,
    legHeights: variants.legHeights,
    gapHeights: variants.gapHeights,
    sofaSeatSizes: variants.sofaSeatSizes,
    bedframeSpecialOrders: variants.bedframeSpecialOrders,
    sofaSpecialOrders: variants.sofaSpecialOrders,
    updatedFromSheet: new Date().toISOString(),
  };
  const putVcRes = await fetch(`${PROD}/api/kv-config/variants-config`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify(merged),
  });
  const putVcJ = (await putVcRes.json()) as ApiResp;
  console.log(`  variants-config PUT: ${putVcJ.success ? "ok" : "FAILED"}`);

  // =========================================================================
  // Step 3 — SKU BF + SKU SF → products update
  // =========================================================================
  console.log("\n=== Step 3: SKU BF + SKU SF → products PUT ===");
  const bfRows = parseSku(wb, "SKU BF");
  const sfRows = parseSku(wb, "SKU SF");
  console.log(`  SKU BF=${bfRows.length} SKU SF=${sfRows.length}`);
  let prodUpdated = 0,
    prodSkipped = 0,
    prodFailed = 0;
  const prodFailures: string[] = [];
  for (const r of [...bfRows, ...sfRows]) {
    const match = productByNormCode.get(normalizeCode(r.code));
    if (!match) {
      prodSkipped++;
      continue;
    }
    const body = {
      basePriceSen: r.basePriceSen,
      price1Sen: r.price1Sen,
      fabricUsage: r.fabricUsage,
      unitM3: r.unitM3,
      deptWorkingTimes: r.deptWorkingTimes,
    };
    try {
      const resp = await fetch(`${PROD}/api/products/${match.id}`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify(body),
      });
      const j = (await resp.json()) as ApiResp;
      if (j.success) prodUpdated++;
      else {
        prodFailed++;
        prodFailures.push(`${r.code}: ${j.error || resp.status}`);
      }
    } catch (e) {
      prodFailed++;
      prodFailures.push(`${r.code}: ${(e as Error).message}`);
    }
  }
  console.log(
    `  updated=${prodUpdated} skipped=${prodSkipped} failed=${prodFailed}`,
  );
  if (prodFailures.length) {
    console.log("  failures (first 10):");
    prodFailures.slice(0, 10).forEach((f) => console.log(`    ${f}`));
  }

  // =========================================================================
  // Step 4 — Attendance employees → workers
  // =========================================================================
  console.log("\n=== Step 4: Attendance employees → workers ===");
  const emps = parseEmployees(wb);
  console.log(`  parsed ${emps.length} employee rows`);
  let empInserted = 0,
    empSkipped = 0,
    empFailed = 0;
  const empFailures: string[] = [];
  // Existing empNos to make the EMP-### sequence monotonic.
  let seq = 1;
  // Keep bumping seq until we find an unused number — cheap because list is small.
  const usedSeq = new Set<number>();
  for (const empNo of existingEmpNos) {
    const m = /^EMP-(\d+)$/i.exec(empNo);
    if (m) usedSeq.add(Number(m[1]));
  }
  const nextSeq = () => {
    while (usedSeq.has(seq)) seq++;
    usedSeq.add(seq);
    return seq++;
  };

  for (const e of emps) {
    if (existingWorkerNames.has(e.name.toUpperCase())) {
      empSkipped++;
      continue;
    }
    const deptCode = DEPT_NAME_TO_CODE[e.deptName];
    const departmentId = deptCode ? deptCodeToId.get(deptCode) : undefined;
    if (!departmentId) {
      empFailed++;
      empFailures.push(`${e.name}: unknown dept '${e.deptName}'`);
      continue;
    }
    const empNo = `EMP-${String(nextSeq()).padStart(3, "0")}`;
    const body = {
      name: e.name,
      empNo,
      departmentId,
      departmentCode: deptCode,
      position: "Operator",
      phone: "",
      status: "ACTIVE",
      basicSalarySen: Math.round(e.salary * 100),
      workingHoursPerDay: e.workingHour,
      workingDaysPerMonth: Math.round(e.workingDaysPerWeek * 4.33),
      joinDate: new Date().toISOString().split("T")[0],
    };
    try {
      const resp = await fetch(`${PROD}/api/workers`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify(body),
      });
      const j = (await resp.json()) as ApiResp;
      if (j.success) {
        empInserted++;
        existingWorkerNames.add(e.name.toUpperCase());
      } else {
        empFailed++;
        empFailures.push(`${e.name}: ${j.error || resp.status}`);
      }
    } catch (err) {
      empFailed++;
      empFailures.push(`${e.name}: ${(err as Error).message}`);
    }
  }
  console.log(
    `  inserted=${empInserted} skipped=${empSkipped} failed=${empFailed}`,
  );
  if (empFailures.length) {
    empFailures.forEach((f) => console.log(`    ${f}`));
  }

  // =========================================================================
  // Step 5 — fabrics master (skipped: /api/fabrics is read-only, no POST)
  // =========================================================================
  console.log("\n=== Step 5: fabrics master ===");
  console.log(
    "  skipped — /api/fabrics is read-only (no POST handler); raw_materials already holds fabric codes via step 1",
  );

  // =========================================================================
  // Summary
  // =========================================================================
  console.log("\n===================== SUMMARY =====================");
  console.log(
    `Step 1 (raw_materials):       inserted=${rmInserted} skipped=${rmSkipped} failed=${rmFailed}`,
  );
  console.log(
    `Step 2 (variants-config):     ${putVcJ.success ? "ok" : "FAILED"}`,
  );
  console.log(
    `Step 3 (products PUT):        updated=${prodUpdated} skipped=${prodSkipped} failed=${prodFailed}`,
  );
  console.log(
    `Step 4 (workers):             inserted=${empInserted} skipped=${empSkipped} failed=${empFailed}`,
  );
  console.log(`Step 5 (fabrics master):      skipped (read-only API)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
