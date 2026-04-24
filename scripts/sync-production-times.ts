// ---------------------------------------------------------------------------
// Sync Production Times matrix (Dept × CAT) → REMOTE kv_config "variants-config".
//
// Parses SKU BF + SKU SF tabs of Production Sheet (9).xlsx, groups
// (deptCode, category) → minutes, resolves conflicts by mode → median, then
// merges a `productionTimes` field into variants-config while preserving every
// existing field (divanHeights / legHeights / gaps / sofaSizes / etc.).
//
// Run:  npx tsx scripts/sync-production-times.ts
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// xlsx is a CJS module — import via require so tsx doesn't choke on it.
 
const xl = require("xlsx") as typeof import("xlsx");

const SHEET = "C:/Users/User/Downloads/Production Sheet (9).xlsx";
const PROD = "https://hookka-erp-testing.pages.dev";
const EMAIL = "weisiang329@gmail.com";
const PASSWORD = "CbpxqJQpjy3VA5yd3Q";

// Department name → code mapping.
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

const DEPT_CODES = Object.values(DEPT_NAME_TO_CODE);
// Categories always reported as "CAT 1" … "CAT 7".
const CAT_KEYS = ["CAT 1", "CAT 2", "CAT 3", "CAT 4", "CAT 5", "CAT 6", "CAT 7"];

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

function toNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }
  return 0;
}

// Normalize "cat 1", " CAT 1 ", "Cat 1" → "CAT 1".
function normalizeCat(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\s+/g, " ");
  if (!s) return "";
  const m = /^CAT\s*(\d+)$/.exec(s);
  if (m) return `CAT ${m[1]}`;
  return s; // leave as-is; caller will filter unknowns
}

// ---------------------------------------------------------------------------
// Parse SKU tabs → flat tuple list
// ---------------------------------------------------------------------------
type Tuple = {
  deptCode: string;
  category: string;
  minutes: number;
  sourceCode: string;
  sourceTab: string;
};

function parseSkuTab(
  wb: xl.WorkBook,
  tab: "SKU BF" | "SKU SF",
): Tuple[] {
  const ws = wb.Sheets[tab];
  if (!ws) throw new Error(`Tab '${tab}' not found`);
  const rows = xl.utils.sheet_to_json<(string | number)[]>(ws, {
    header: 1,
    defval: "",
  });
  const header = (rows[0] as string[]) || [];

  // Column lookup — headers may repeat; remember first occurrence.
  const colFirst = new Map<string, number>();
  for (let i = 0; i < header.length; i++) {
    const h = String(header[i]).trim();
    if (!h) continue;
    if (!colFirst.has(h)) colFirst.set(h, i);
  }
  const codeCol = colFirst.get("Product Code") ?? 0;

  const deptCols: Record<string, { cat: number; time: number }> = {};
  for (const deptName of Object.keys(DEPT_NAME_TO_CODE)) {
    const cat = colFirst.get(`${deptName} Category`);
    const time = colFirst.get(`${deptName} Production Time`);
    if (cat !== undefined && time !== undefined) {
      deptCols[deptName] = { cat, time };
    }
  }

  const out: Tuple[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const code = String(r[codeCol] ?? "").trim();
    if (!code) continue;
    for (const [deptName, cols] of Object.entries(deptCols)) {
      const rawCat = String(r[cols.cat] ?? "").trim();
      const minutes = toNum(r[cols.time]);
      if (!rawCat) continue;
      if (minutes === 0) continue;
      const cat = normalizeCat(rawCat);
      if (!CAT_KEYS.includes(cat)) continue;
      out.push({
        deptCode: DEPT_NAME_TO_CODE[deptName],
        category: cat,
        minutes: Math.round(minutes),
        sourceCode: code,
        sourceTab: tab,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conflict resolution: mode → median
// ---------------------------------------------------------------------------
type Resolved = {
  deptCode: string;
  category: string;
  minutes: number;
  observations: number[];
  conflict: boolean;
};

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function resolveMinutes(obs: number[]): { value: number; conflict: boolean } {
  if (obs.length === 0) return { value: 0, conflict: false };
  const uniq = new Set(obs);
  if (uniq.size === 1) return { value: obs[0]!, conflict: false };
  // Tally counts.
  const counts = new Map<number, number>();
  for (const v of obs) counts.set(v, (counts.get(v) ?? 0) + 1);
  let maxCount = 0;
  for (const c of counts.values()) if (c > maxCount) maxCount = c;
  const modes: number[] = [];
  for (const [v, c] of counts) if (c === maxCount) modes.push(v);
  if (modes.length === 1) return { value: modes[0]!, conflict: true };
  // Tie — use median of raw observations.
  const sorted = [...obs].sort((a, b) => a - b);
  return { value: median(sorted), conflict: true };
}

function resolveAll(tuples: Tuple[]): Resolved[] {
  const buckets = new Map<string, number[]>();
  for (const t of tuples) {
    const key = `${t.deptCode}||${t.category}`;
    const arr = buckets.get(key) ?? [];
    arr.push(t.minutes);
    buckets.set(key, arr);
  }
  const out: Resolved[] = [];
  for (const [key, obs] of buckets) {
    const [deptCode, category] = key.split("||") as [string, string];
    const { value, conflict } = resolveMinutes(obs);
    out.push({ deptCode, category, minutes: value, observations: obs, conflict });
  }
  return out;
}

function buildMatrix(
  resolved: Resolved[],
): Record<string, Record<string, number>> {
  const matrix: Record<string, Record<string, number>> = {};
  for (const dept of DEPT_CODES) {
    matrix[dept] = {};
    for (const cat of CAT_KEYS) matrix[dept]![cat] = 0;
  }
  for (const r of resolved) {
    if (!matrix[r.deptCode]) continue;
    matrix[r.deptCode]![r.category] = r.minutes;
  }
  return matrix;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
type ApiResp<T = unknown> = {
  success?: boolean;
  data?: T;
  error?: string;
};

async function main() {
  console.log("== Sync Production Times matrix → REMOTE variants-config ==");
  console.log("Logging in...");
  const token = await login();
  const auth: HeadersInit = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };

  console.log(`Reading ${SHEET}...`);
  const wb = xl.readFile(SHEET);

  const bf = parseSkuTab(wb, "SKU BF");
  const sf = parseSkuTab(wb, "SKU SF");
  console.log(`  tuples: SKU BF=${bf.length}, SKU SF=${sf.length}`);

  const resolved = resolveAll([...bf, ...sf]);
  console.log(`  unique (dept, category) combos: ${resolved.length}`);

  // Log conflicts.
  const conflicts = resolved.filter((r) => r.conflict);
  if (conflicts.length) {
    console.log(`\n  CONFLICTS (${conflicts.length}):`);
    for (const c of conflicts) {
      const sorted = [...c.observations].sort((a, b) => a - b);
      const counts = new Map<number, number>();
      for (const v of c.observations) counts.set(v, (counts.get(v) ?? 0) + 1);
      const distinct = Array.from(counts.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([v, n]) => `${v}×${n}`)
        .join(", ");
      console.log(
        `    ${c.deptCode} / ${c.category}: obs=[${distinct}] → ${c.minutes} (n=${sorted.length})`,
      );
    }
  } else {
    console.log("  no conflicts");
  }

  const matrix = buildMatrix(resolved);

  console.log("\n  matrix summary (non-zero values per dept):");
  for (const dept of DEPT_CODES) {
    const values = CAT_KEYS.map((c) => `${c}=${matrix[dept]![c]}`).join(" ");
    console.log(`    ${dept.padEnd(11)} ${values}`);
  }

  // =========================================================================
  // Merge into variants-config
  // =========================================================================
  console.log("\nFetching current variants-config...");
  const cur = await fetch(`${PROD}/api/kv-config/variants-config`, {
    headers: auth,
  });
  const curJ = (await cur.json()) as ApiResp<Record<string, unknown>>;
  const existing = curJ.data ?? {};
  const merged: Record<string, unknown> = {
    ...existing,
    productionTimes: matrix,
    productionTimesUpdatedAt: new Date().toISOString(),
  };

  console.log("PUT variants-config...");
  const put = await fetch(`${PROD}/api/kv-config/variants-config`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify(merged),
  });
  const putJ = (await put.json()) as ApiResp;
  console.log(`  PUT: ${putJ.success ? "ok" : "FAILED"}`);
  if (!putJ.success) {
    console.error(putJ);
    process.exit(1);
  }

  // Verify.
  console.log("\nVerifying...");
  const ver = await fetch(`${PROD}/api/kv-config/variants-config`, {
    headers: auth,
  });
  const verJ = (await ver.json()) as ApiResp<{
    productionTimes?: Record<string, Record<string, number>>;
    divanHeights?: unknown;
  }>;
  const pt = verJ.data?.productionTimes;
  if (!pt?.["FAB_CUT"]) {
    console.error("  productionTimes.FAB_CUT missing after PUT");
    process.exit(1);
  }
  console.log(
    `  productionTimes.FAB_CUT = ${JSON.stringify(pt["FAB_CUT"])}`,
  );
  console.log(
    `  preserved divanHeights? ${Array.isArray(verJ.data?.divanHeights) ? "yes" : "no"}`,
  );
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
