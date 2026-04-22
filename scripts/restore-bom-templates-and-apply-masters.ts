// Emergency restore: rebuild bom_templates from the recovered
// hookka-bom-templates-v2 localStorage snapshot, then overlay the SS/S
// master onto S+SS bedframes and the K/Q master onto K+Q+SK+SP bedframes.
//
// Fixes the previous run's mistake where l1Processes / wipComponents were
// sent as JSON strings — the server's bulk PUT expects them as arrays and
// silently replaced non-array values with [].
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const recoveredFile = path.join(repoRoot, "recovered-bom-templates.json");

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

type RecoveredEntry = {
  profile: string;
  origin: string;
  key: string;
  value: unknown;
};

type PerProductBom = {
  id?: string;
  productCode?: string;
  baseModel?: string;
  category?: string;
  l1Processes?: unknown[];
  wipComponents?: unknown[];
  version?: string;
  versionStatus?: string;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  changeLog?: string | null;
};

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

function pickBestV2(entries: RecoveredEntry[]): PerProductBom[] {
  // Find the hookka-bom-templates-v2 entry with the most data (by value size).
  const v2s = entries.filter((e) => e.key === "hookka-bom-templates-v2");
  let best: RecoveredEntry | null = null;
  let bestLen = -1;
  for (const e of v2s) {
    const s = JSON.stringify(e.value || []);
    if (s.length > bestLen) {
      bestLen = s.length;
      best = e;
    }
  }
  if (!best) return [];
  console.log(`  picking hookka-bom-templates-v2 from origin=${best.origin} (${bestLen} bytes)`);
  const arr = Array.isArray(best.value) ? (best.value as PerProductBom[]) : [];
  return arr;
}

function overlay(
  base: PerProductBom,
  master: Master | null,
): PerProductBom {
  if (!master) return base;
  return {
    ...base,
    l1Processes: master.l1Processes,
    // master's wipItems map 1:1 onto bom_templates.wipComponents.
    wipComponents: master.wipItems,
  };
}

async function main() {
  if (!fs.existsSync(recoveredFile)) {
    console.error(`Missing ${recoveredFile}. Run scripts/recover-bom-master-templates.ts first.`);
    process.exit(1);
  }
  const doc = JSON.parse(fs.readFileSync(recoveredFile, "utf8")) as {
    entries: RecoveredEntry[];
  };

  console.log("Step 1: extract hookka-bom-templates-v2 from recovered file");
  const perProduct = pickBestV2(doc.entries);
  console.log(`  ${perProduct.length} per-product BOM entries`);
  if (perProduct.length === 0) {
    console.error("No per-product BOM data in recovered file.");
    process.exit(1);
  }

  const token = await login();
  const auth: HeadersInit = { authorization: `Bearer ${token}` };

  console.log("\nStep 2: fetch master templates + products");
  const masterRes = await fetch(`${PROD}/api/bom-master-templates`, { headers: auth });
  const mj = (await masterRes.json()) as { data: Master[] };
  const masters = mj.data;
  // User's wording:
  //   SS/S Bedframe master → id "BEDFRAME-COPY-LS9CI"
  //   K/Q Bedframe master  → id "BEDFRAME"  (isDefault=true, label "K/Q Bedframe")
  const ssMaster = masters.find((m) => m.id === "BEDFRAME-COPY-LS9CI") || null;
  const kqMaster = masters.find((m) => m.id === "BEDFRAME") || null;
  if (!ssMaster || !kqMaster) {
    console.error("Cannot find master templates by id.");
    process.exit(1);
  }
  console.log(`  SS/S master: ${ssMaster.label} (${ssMaster.wipItems.length} WIPs)`);
  console.log(`  K/Q master:  ${kqMaster.label} (${kqMaster.wipItems.length} WIPs)`);

  const prodRes = await fetch(`${PROD}/api/products`, { headers: auth });
  const pj = (await prodRes.json()) as { data: Product[] };
  const products = pj.data;
  console.log(`  ${products.length} products`);

  console.log("\nStep 3: overlay masters on matching bedframes");
  const SMALL = new Set(["S", "SS"]);
  const LARGE = new Set(["K", "Q", "SK", "SP"]);
  const overlayCodes = new Map<string, Master>();
  for (const p of products) {
    if ((p.category || "").toUpperCase() !== "BEDFRAME") continue;
    const sz = (p.sizeCode || "").toUpperCase();
    if (SMALL.has(sz)) overlayCodes.set(p.code, ssMaster);
    else if (LARGE.has(sz)) overlayCodes.set(p.code, kqMaster);
  }
  console.log(`  ${overlayCodes.size} bedframe products will be overlayed (S/SS/K/Q/SK/SP)`);

  console.log("\nStep 4: build bulk template payload (arrays, not strings!)");
  const out: PerProductBom[] = perProduct.map((raw) => {
    const m = raw.productCode ? overlayCodes.get(raw.productCode) : null;
    const base: PerProductBom = {
      id: raw.id,
      productCode: raw.productCode,
      baseModel: raw.baseModel,
      category: raw.category,
      l1Processes: Array.isArray(raw.l1Processes) ? raw.l1Processes : [],
      wipComponents: Array.isArray(raw.wipComponents) ? raw.wipComponents : [],
      version: raw.version,
      versionStatus: raw.versionStatus,
      effectiveFrom: raw.effectiveFrom,
      effectiveTo: raw.effectiveTo ?? null,
      changeLog: raw.changeLog ?? null,
    };
    return m ? overlay(base, m) : base;
  });

  console.log("\nStep 5: bulk PUT /api/bom/templates (DELETE ALL + INSERT ALL)");
  const putRes = await fetch(`${PROD}/api/bom/templates`, {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ templates: out }),
  });
  const putBody = await putRes.text();
  console.log(`  HTTP ${putRes.status}`);
  console.log(`  ${putBody.slice(0, 300)}`);
  if (!putRes.ok) process.exit(1);

  // Verify a few samples hit D1 correctly
  const verifySamples = [
    "1003-(S)",
    "1003-(SS)",
    "1003-(K)",
    "1003-(Q)",
    "1003-(SK)",
    "1003-(SP)",
    "DIVAN-(S)",
  ];
  const verifyRes = await fetch(`${PROD}/api/bom/templates`, { headers: auth });
  const vj = (await verifyRes.json()) as { data: Array<Record<string, unknown>> };
  console.log("\nVerify samples:");
  for (const code of verifySamples) {
    const row = vj.data.find((r) => r.productCode === code);
    if (!row) {
      console.log(`  ${code}: MISSING`);
      continue;
    }
    const wc = row.wipComponents;
    const pc = row.l1Processes;
    const wcLen = typeof wc === "string" ? wc.length : JSON.stringify(wc).length;
    const pcLen = typeof pc === "string" ? pc.length : JSON.stringify(pc).length;
    console.log(`  ${code.padEnd(12)}  wipComponents=${wcLen}b  l1Processes=${pcLen}b`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
