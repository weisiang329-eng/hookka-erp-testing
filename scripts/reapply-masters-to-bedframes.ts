// Re-apply Master BOM Templates to every bedframe, reading the CURRENT
// D1 state as the base (not the recovered localStorage snapshot). Safe to
// re-run whenever the user updates a master template.
//
// Overlay rules (per user request):
//   S, SS                              -> SS/S Bedframe master (id=BEDFRAME-COPY-LS9CI)
//   everything else (K, Q, SK, SP,     -> K/Q Bedframe master   (id=BEDFRAME)
//   152X200, 170, 183X200, etc.)
//
// Only bedframes are touched — sofas and custom-size products keep whatever
// BOM they currently have in D1.

const PROD = "https://hookka-erp-testing.pages.dev";
const EMAIL = "weisiang329@gmail.com";
const PASSWORD = "CbpxqJQpjy3VA5yd3Q";

async function login(): Promise<string> {
  const res = await fetch(`${PROD}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = (await res.json()) as { data?: { token?: string } };
  const t = j?.data?.token;
  if (!t) throw new Error("Login failed");
  return t;
}

type Master = {
  id: string;
  category: string;
  label: string;
  l1Processes: unknown[];
  l1Materials: unknown[];
  wipItems: unknown[];
};

type Product = {
  id: string;
  code: string;
  category?: string;
  sizeCode?: string;
  name: string;
  baseModel?: string;
};

type BomRow = {
  id: string;
  productCode: string;
  baseModel?: string;
  category?: string;
  l1Processes: unknown;
  wipComponents: unknown;
  version: string;
  versionStatus: string;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  changeLog?: string | null;
};

function parseMaybe(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function main() {
  const token = await login();
  const auth: HeadersInit = { authorization: `Bearer ${token}` };

  console.log("Fetching fresh master templates, products, and bom_templates from D1...");
  const [mRes, pRes, bRes] = await Promise.all([
    fetch(`${PROD}/api/bom-master-templates`, { headers: auth }),
    fetch(`${PROD}/api/products`, { headers: auth }),
    fetch(`${PROD}/api/bom/templates`, { headers: auth }),
  ]);
  const masters = ((await mRes.json()) as { data: Master[] }).data;
  const products = ((await pRes.json()) as { data: Product[] }).data;
  const bomRows = ((await bRes.json()) as { data: BomRow[] }).data;

  const ssMaster = masters.find((m) => m.id === "BEDFRAME-COPY-LS9CI") || null;
  const kqMaster = masters.find((m) => m.id === "BEDFRAME") || null;
  if (!ssMaster || !kqMaster) {
    console.error("Missing master templates. Run upload-recovered-masters.ts first.");
    process.exit(1);
  }
  console.log(`  SS/S master: ${ssMaster.label} — ${ssMaster.wipItems.length} WIPs (updated? ${JSON.stringify(ssMaster.wipItems).length}b)`);
  console.log(`  K/Q master:  ${kqMaster.label} — ${kqMaster.wipItems.length} WIPs (updated? ${JSON.stringify(kqMaster.wipItems).length}b)`);
  console.log(`  ${products.length} products, ${bomRows.length} bom_templates`);

  // Decide which master each bedframe product gets.
  const SMALL = new Set(["S", "SS"]);
  const overlay = new Map<string, Master>();
  let smallCount = 0;
  let largeCount = 0;
  for (const p of products) {
    if ((p.category || "").toUpperCase() !== "BEDFRAME") continue;
    const sz = (p.sizeCode || "").toUpperCase();
    if (SMALL.has(sz)) {
      overlay.set(p.code, ssMaster);
      smallCount++;
    } else {
      overlay.set(p.code, kqMaster);
      largeCount++;
    }
  }
  console.log(`\nOverlay plan: ${smallCount} small (S/SS → SS/S master), ${largeCount} other bedframes → K/Q master`);

  // Build payload: every existing bom_templates row, with bedframe ones overlaid.
  const out = bomRows.map((r) => {
    const m = overlay.get(r.productCode);
    const base = {
      id: r.id,
      productCode: r.productCode,
      baseModel: r.baseModel || r.productCode,
      category: (r.category === "SOFA" ? "SOFA" : "BEDFRAME") as "BEDFRAME" | "SOFA",
      l1Processes: parseMaybe(r.l1Processes),
      wipComponents: parseMaybe(r.wipComponents),
      version: r.version || "1.0",
      versionStatus: r.versionStatus || "ACTIVE",
      effectiveFrom: r.effectiveFrom || new Date().toISOString(),
      effectiveTo: r.effectiveTo ?? null,
      changeLog: r.changeLog ?? null,
    };
    if (m) {
      return {
        ...base,
        l1Processes: m.l1Processes,
        wipComponents: m.wipItems,
      };
    }
    return base;
  });

  console.log(`\nBulk PUT ${out.length} templates...`);
  const putRes = await fetch(`${PROD}/api/bom/templates`, {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ templates: out }),
  });
  const putBody = await putRes.text();
  console.log(`HTTP ${putRes.status}`);
  console.log(putBody.slice(0, 200));

  if (!putRes.ok) process.exit(1);

  console.log("\nSample verify:");
  const vRes = await fetch(`${PROD}/api/bom/templates`, { headers: auth });
  const vj = ((await vRes.json()) as { data: BomRow[] }).data;
  const samples = ["1003-(S)", "1003-(SS)", "1003-(K)", "1003-(Q)", "1003-(SK)", "2023(HF)(W)-(210X200)"];
  for (const c of samples) {
    const r = vj.find((x) => x.productCode === c);
    if (!r) {
      console.log(`  ${c}: (no row)`);
      continue;
    }
    const wcLen = typeof r.wipComponents === "string" ? r.wipComponents.length : JSON.stringify(r.wipComponents).length;
    console.log(`  ${c.padEnd(25)} wipComponents=${wcLen}b`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
