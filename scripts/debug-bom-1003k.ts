// Targeted sync test for 1003-(K). Applies sheet → tree, PUTs remote,
// re-fetches, and prints before/after diffs.
import { createRequire } from "node:module";
import type * as XLSX from "xlsx";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const xl = require("xlsx") as typeof XLSX;

const SHEET = "C:/Users/User/Downloads/Production Sheet (9).xlsx";
const PROD = "https://hookka-erp-testing.pages.dev";
const EMAIL = "weisiang329@gmail.com";
const PASSWORD = "CbpxqJQpjy3VA5yd3Q";

type DeptCode =
  | "FAB_CUT"
  | "FAB_SEW"
  | "FOAM"
  | "WOOD_CUT"
  | "FRAMING"
  | "WEBBING"
  | "UPHOLSTERY"
  | "PACKING";
type Proc = {
  dept?: string;
  deptCode: DeptCode;
  category?: string;
  minutes: number;
};
type Node = {
  wipCode?: string;
  wipType?: string;
  processes?: Proc[];
  children?: Node[];
};
type Dept = { deptCode: DeptCode; minutes: number; category: string };

const DEPT_NAME: Record<DeptCode, string> = {
  FAB_CUT: "Fabric Cutting",
  FAB_SEW: "Fabric Sewing",
  FOAM: "Foam Bonding",
  WOOD_CUT: "Wood Cutting",
  FRAMING: "Framing",
  WEBBING: "Webbing",
  UPHOLSTERY: "Upholstery",
  PACKING: "Packing",
};

function s(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}
function n(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }
  return 0;
}

function collectProcs(
  tops: Node[],
  topFilter: ((wc: string, wt: string) => boolean) | null,
): Array<{ node: Node; proc: Proc; path: string }> {
  const out: Array<{ node: Node; proc: Proc; path: string }> = [];
  const walk = (node: Node, path: string) => {
    const procs = Array.isArray(node.processes) ? node.processes : [];
    for (const p of procs) out.push({ node, proc: p, path });
    const kids = Array.isArray(node.children) ? node.children : [];
    for (const c of kids) walk(c, `${path}>${c.wipCode ?? ""}`);
  };
  for (const top of tops) {
    const wc = s(top.wipCode);
    const wt = s(top.wipType);
    if (topFilter === null || topFilter(wc, wt))
      walk(top, s(top.wipCode) || "?");
  }
  return out;
}

function applySection(
  tops: Node[],
  depts: Dept[],
  topFilter: ((wc: string, wt: string) => boolean) | null,
  label: string,
): void {
  const candidates = collectProcs(tops, topFilter);
  console.log(`  [${label}] candidates after filter: ${candidates.length}`);
  for (const d of depts) {
    const matches = candidates.filter((r) => r.proc.deptCode === d.deptCode);
    console.log(
      `    dept ${d.deptCode} (${d.minutes}m ${d.category}) matches=${matches.length}`,
    );
    if (matches.length === 0) continue;
    const base = Math.floor(d.minutes / matches.length);
    const rem = d.minutes - base * matches.length;
    for (let k = 0; k < matches.length; k++) {
      const m = matches[k];
      const v = base + (k < rem ? 1 : 0);
      const before = { cat: m.proc.category, min: m.proc.minutes };
      m.proc.minutes = v;
      if (d.category) m.proc.category = d.category;
      if (!m.proc.dept) m.proc.dept = DEPT_NAME[d.deptCode];
      console.log(
        `      node ${m.path.slice(0, 60)} ${d.deptCode}: ${before.cat} ${before.min}m → ${m.proc.category} ${m.proc.minutes}m`,
      );
    }
  }
}

async function main() {
  const loginRes = await fetch(`${PROD}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = (await loginRes.json()) as { data?: { token?: string } };
  const token = j.data?.token;
  if (!token) throw new Error("login failed");
  const auth: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };

  const wb = xl.readFile(SHEET);
  const ws = wb.Sheets["SKU BF"];
  const rows = xl.utils.sheet_to_json<(string | number | null)[]>(ws, {
    header: 1,
    defval: "",
  });

  const code = "1003-(K)";
  const r = rows.find((rr) => rr && String(rr[0]).trim() === code);
  if (!r) throw new Error(`no sheet row for ${code}`);

  const tRes = await fetch(`${PROD}/api/bom/templates`, { headers: auth });
  const tJ = (await tRes.json()) as {
    data?: Array<Record<string, unknown>>;
  };
  const templates = tJ.data ?? [];
  const norm = code.replace(/[\s-]+/g, "").toUpperCase();
  const t = templates.find(
    (x) =>
      String(x.productCode ?? "")
        .replace(/[\s-]+/g, "")
        .toUpperCase() === norm,
  );
  if (!t) throw new Error(`no template for ${code}`);
  console.log(`Template id: ${t.id}`);

  const treeRaw = t.wipComponents;
  const tree: Node[] = Array.isArray(treeRaw)
    ? (JSON.parse(JSON.stringify(treeRaw)) as Node[])
    : typeof treeRaw === "string"
      ? (JSON.parse(treeRaw) as Node[])
      : [];

  const l1Raw = t.l1Processes;
  const l1: Proc[] = Array.isArray(l1Raw)
    ? (JSON.parse(JSON.stringify(l1Raw)) as Proc[])
    : typeof l1Raw === "string"
      ? (JSON.parse(l1Raw) as Proc[])
      : [];

  // Parse sheet.
  const cell = (c: number): unknown => r[c];
  const build = (defs: Array<[DeptCode, number, number]>): Dept[] => {
    const out: Dept[] = [];
    for (const [code_, catCol, timeCol] of defs) {
      const cat = s(cell(catCol));
      const mins = n(cell(timeCol));
      if (!cat && mins === 0) continue;
      out.push({
        deptCode: code_,
        minutes: Math.round(mins),
        category: cat,
      });
    }
    return out;
  };
  const fg = build([
    ["FAB_CUT", 8, 9],
    ["FAB_SEW", 10, 11],
    ["FOAM", 12, 13],
  ]);
  const divan = build([
    ["WOOD_CUT", 16, 17],
    ["FRAMING", 18, 19],
    ["WEBBING", 20, 21],
    ["UPHOLSTERY", 22, 23],
    ["PACKING", 24, 25],
  ]);
  const hb = build([
    ["WOOD_CUT", 29, 30],
    ["FRAMING", 31, 32],
    ["WEBBING", 33, 34],
    ["UPHOLSTERY", 35, 36],
    ["PACKING", 37, 38],
  ]);
  console.log(`FG sheet: ${JSON.stringify(fg)}`);
  console.log(`DIVAN sheet: ${JSON.stringify(divan)}`);
  console.log(`HB sheet: ${JSON.stringify(hb)}`);

  console.log("\n-- Applying FG (tree-wide) --");
  applySection(tree, fg, null, "FG");
  console.log("\n-- Applying DIVAN --");
  applySection(tree, divan, (_wc, wt) => wt === "DIVAN", "DIVAN");
  console.log("\n-- Applying HB --");
  applySection(tree, hb, (_wc, wt) => wt === "HEADBOARD", "HB");

  // PUT
  const body = { l1Processes: l1, wipComponents: tree };
  console.log(
    `\nPUT body size: ${JSON.stringify(body).length} chars, wipComponents items=${tree.length}`,
  );
  const resp = await fetch(`${PROD}/api/bom/templates/${t.id}`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify(body),
  });
  const pj = (await resp.json()) as { success?: boolean; error?: string };
  console.log(`PUT status: ${resp.status} success=${pj.success} error=${pj.error ?? "-"}`);

  // Re-fetch.
  const vRes = await fetch(`${PROD}/api/bom/templates/${t.id}`, {
    headers: auth,
  });
  console.log(`GET /templates/${t.id} status: ${vRes.status}`);
  const vJ = (await vRes.json()) as {
    data?: Record<string, unknown>;
    success?: boolean;
  };
  if (vJ.data?.wipComponents) {
    const after = Array.isArray(vJ.data.wipComponents)
      ? (vJ.data.wipComponents as Node[])
      : (JSON.parse(String(vJ.data.wipComponents)) as Node[]);
    console.log(`\n=== AFTER (re-fetched) ===`);
    const dump = (node: Node, depth: number) => {
      const ind = "  ".repeat(depth);
      console.log(
        `${ind}${node.wipCode} (${node.wipType})`,
      );
      for (const p of node.processes ?? [])
        console.log(
          `${ind}  ${p.deptCode} ${p.category} ${p.minutes}m`,
        );
      for (const k of node.children ?? []) dump(k, depth + 1);
    };
    for (const top of after) dump(top, 0);
  } else {
    console.log("single-template fetch failed, refetching list…");
    const lRes = await fetch(`${PROD}/api/bom/templates`, { headers: auth });
    const lJ = (await lRes.json()) as {
      data?: Array<Record<string, unknown>>;
    };
    const t2 = (lJ.data ?? []).find(
      (x) =>
        String(x.productCode ?? "")
          .replace(/[\s-]+/g, "")
          .toUpperCase() === norm,
    );
    if (t2) {
      console.log(
        "Fetched via list:",
        JSON.stringify(t2.wipComponents).slice(0, 500),
      );
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
