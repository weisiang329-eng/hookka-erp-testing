// One-shot: apply a Master BOM Template to every product matching a
// category + size filter. Writes wipComponents + l1Processes directly to
// each product's bom_templates row in D1.
//
// Usage:
//   npx tsx scripts/apply-master-to-sizes.ts <masterId> <category> <size1,size2,...>
// Example:
//   npx tsx scripts/apply-master-to-sizes.ts BEDFRAME-COPY-LS9CI BEDFRAME S,SS

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
  if (!t) throw new Error("Login failed: " + JSON.stringify(j));
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
};

type BomRow = {
  id: string;
  productCode: string;
  category: string;
  l1Processes: string;
  wipComponents: string;
  version: string;
  versionStatus: string;
};

async function main() {
  const [masterId, category, sizesArg] = process.argv.slice(2);
  if (!masterId || !category || !sizesArg) {
    console.error("Usage: apply-master-to-sizes.ts <masterId> <category> <size1,size2,...>");
    process.exit(1);
  }
  const sizes = sizesArg.split(",").map((s) => s.trim().toUpperCase());

  const token = await login();
  const auth: HeadersInit = { authorization: `Bearer ${token}` };

  // 1. Fetch the master template
  const mRes = await fetch(`${PROD}/api/bom-master-templates/${encodeURIComponent(masterId)}`, { headers: auth });
  if (!mRes.ok) {
    console.error(`Master not found: ${masterId} (HTTP ${mRes.status})`);
    process.exit(1);
  }
  const mj = (await mRes.json()) as { data: Master };
  const master = mj.data;
  console.log(`Master: ${master.id} — ${master.label} (${master.category}) — ${master.wipItems.length} WIPs, ${master.l1Processes.length} L1 processes`);

  // 2. Fetch products + filter
  const pRes = await fetch(`${PROD}/api/products`, { headers: auth });
  const pj = (await pRes.json()) as { data: Product[] };
  const matches = pj.data.filter(
    (p) => (p.category || "").toUpperCase() === category.toUpperCase() && sizes.includes((p.sizeCode || "").toUpperCase()),
  );
  console.log(`\n${matches.length} products match category=${category} sizeCode IN (${sizes.join(",")})`);

  // 3. Fetch the current bom_templates for those productCodes so we can update
  const codes = matches.map((p) => p.code);
  const btRes = await fetch(`${PROD}/api/bom/templates`, { headers: auth });
  const btj = (await btRes.json()) as { data: BomRow[] };
  const existingMap = new Map<string, BomRow>();
  for (const row of btj.data) {
    if (codes.includes(row.productCode)) existingMap.set(row.productCode, row);
  }

  // 4. For each matched product, build the updated row body keeping product-
  //    specific fields (id, productCode, category, version) but replacing
  //    l1Processes + wipComponents with the master's content.
  const updated: BomRow[] = [];
  for (const p of matches) {
    const existing = existingMap.get(p.code);
    if (!existing) {
      console.warn(`  skip ${p.code} — no bom_templates row`);
      continue;
    }
    updated.push({
      ...existing,
      l1Processes: JSON.stringify(master.l1Processes),
      wipComponents: JSON.stringify(master.wipItems),
    });
  }
  console.log(`\nApplying to ${updated.length} bom_templates rows...`);

  // 5. Unchanged rows we want to KEEP (all other products) + updated rows.
  const keepRows = btj.data.filter((r) => !codes.includes(r.productCode));
  const merged = [...keepRows, ...updated];

  // 6. PUT /api/bom/templates (bulk replace — DELETE ALL + INSERT ALL)
  const putRes = await fetch(`${PROD}/api/bom/templates`, {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ templates: merged }),
  });
  const putBody = await putRes.text();
  console.log(`\nHTTP ${putRes.status}`);
  console.log(putBody.slice(0, 400));
  if (!putRes.ok) process.exit(1);

  // 7. Verify
  const verifyRes = await fetch(`${PROD}/api/bom/templates`, { headers: auth });
  const vj = (await verifyRes.json()) as { data: BomRow[] };
  const vmap = new Map(vj.data.map((r) => [r.productCode, r]));
  let ok = 0;
  for (const p of matches) {
    const r = vmap.get(p.code);
    if (r && JSON.parse(r.wipComponents).length === master.wipItems.length) ok++;
  }
  console.log(`\n✓ ${ok}/${matches.length} products now carry the master template's ${master.wipItems.length} WIPs`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
