#!/usr/bin/env node
// Inspect pillow products + their BOMs + existing pillow POs / JCs.
const BASE = "https://hookka-erp-testing.pages.dev";
const EMAIL = process.env.HOOKKA_EMAIL ?? "";
const PASSWORD = process.env.HOOKKA_PASSWORD ?? "";

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const setCookie = r.headers.get("set-cookie") || "";
  const cookies = setCookie.split(",").map((c) => c.trim().split(";")[0]).filter(Boolean).join("; ");
  const j = await r.json();
  return { cookies, csrf: j?.data?.csrfToken || "" };
}

async function get(path, auth) {
  const r = await fetch(`${BASE}${path}`, { headers: { cookie: auth.cookies, "x-csrf-token": auth.csrf } });
  return await r.json();
}

async function main() {
  const auth = await login();

  // 1) Find pillow products
  const productsRes = await get("/api/products?limit=1000", auth);
  const products = productsRes?.data || productsRes?.rows || [];
  const pillowProducts = products.filter((p) => {
    const code = (p.code || "").toLowerCase();
    const name = (p.name || "").toLowerCase();
    return code.includes("plo") || code.startsWith("pillow") || name.includes("pillow");
  });
  console.log(`=== Pillow products (${pillowProducts.length}) ===`);
  for (const p of pillowProducts.slice(0, 10)) {
    console.log(`  ${p.code} — ${p.name}  category=${p.category}`);
  }
  console.log();

  // 2) Inspect BOM for one sample pillow product
  if (pillowProducts.length > 0) {
    const sample = pillowProducts[0];
    console.log(`=== BOM for ${sample.code} (id=${sample.id}) ===`);
    const bomRes = await get(`/api/bom/templates?productCode=${encodeURIComponent(sample.code)}`, auth);
    const tpl = bomRes?.data || bomRes?.rows || bomRes || {};
    console.log(JSON.stringify(tpl, null, 2).slice(0, 3000));
    console.log();
  }

  // 3) Find pillow POs
  const posRes = await get("/api/production-orders?limit=2000", auth);
  const pos = posRes?.data?.rows || posRes?.data || [];
  const pillowPOs = pos.filter((po) => {
    const code = (po.productCode || "").toLowerCase();
    const name = (po.productName || "").toLowerCase();
    return po.itemCategory === "ACCESSORY" && (code.includes("plo") || name.includes("pillow"));
  });
  console.log(`=== Pillow POs (${pillowPOs.length}) ===`);
  for (const po of pillowPOs.slice(0, 10)) {
    console.log(`  ${po.poNo} ${po.productCode} fabric=${po.fabricCode} qty=${po.quantity} status=${po.status}`);
  }
  console.log();

  // 4) Group by (soId, productCode, fabricCode)
  const groups = new Map();
  for (const po of pillowPOs) {
    if (!po.salesOrderId) continue;
    const key = `${po.salesOrderId}::${po.productCode}::${po.fabricCode || ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(po);
  }
  console.log(`=== Groups (sum across SO×SKU×fabric): ${groups.size} ===`);
  let multiPoGroups = 0;
  for (const [key, list] of groups) {
    if (list.length > 1) {
      multiPoGroups++;
      if (multiPoGroups <= 5) {
        console.log(`  ${key} → ${list.length} POs (combined qty=${list.reduce((s, p) => s + p.quantity, 0)})`);
      }
    }
  }
  console.log(`Total groups with >1 PO (need merging): ${multiPoGroups}`);
  console.log(`Total groups with 1 PO (no merge needed): ${groups.size - multiPoGroups}`);
  console.log();

  // 5) Check job_cards for one pillow PO
  if (pillowPOs.length > 0) {
    const samplePO = pillowPOs[0];
    console.log(`=== Job cards for ${samplePO.poNo} (${samplePO.id}) ===`);
    const jcRes = await get(`/api/job-cards?poId=${encodeURIComponent(samplePO.id)}`, auth);
    const jcs = jcRes?.data?.rows || jcRes?.data || [];
    for (const jc of jcs) {
      console.log(`  ${jc.departmentCode} | wipKey=${jc.wipKey} wipCode=${jc.wipCode} wipType=${jc.wipType} wipQty=${jc.wipQty} status=${jc.status}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
