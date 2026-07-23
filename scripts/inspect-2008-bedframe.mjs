#!/usr/bin/env node
// Inspect why SO-2604-285's 2008(A)-(K) HB sticker shows 1/1 instead of 1/3.
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

  // 1) Find 2008(A)-(K) product
  const productsRes = await get("/api/products?limit=500", auth);
  const products = productsRes?.data || [];
  const p = products.find(p => p.code === "2008(A)-(K)");
  console.log("=== Product 2008(A)-(K) ===");
  console.log(`  category=${p?.category} sizeCode=${p?.sizeCode} pieces=${JSON.stringify(p?.pieces)}\n`);

  // 2) Find SO SO-2604-285
  const soRes = await get("/api/sales-orders?search=SO-2604-285", auth);
  const sos = soRes?.data?.rows || soRes?.data || [];
  const so = sos.find(s => s.companySOId === "SO-2604-285");
  console.log(`=== SO ${so?.companySOId} (${so?.id}) ===\n`);

  // 3) Find production_orders — fetch all and filter by salesOrderId
  const posRes = await get(`/api/production-orders?limit=2000`, auth);
  const pos = posRes?.data?.rows || posRes?.data || [];
  for (const po of pos) {
    if (po.salesOrderId !== so.id) continue;
    if (po.productCode !== "2008(A)-(K)") continue;
    console.log(`=== PO ${po.poNo} — productCode=${po.productCode} sizeCode=${po.sizeCode} status=${po.status} ===`);
    const fgRes = await get(`/api/fg-units?poId=${encodeURIComponent(po.id)}`, auth);
    const units = fgRes?.data?.rows || fgRes?.data || [];
    console.log(`  fg_units (${units.length}):`);
    for (const u of units) {
      console.log(`    ${u.unitSerial} | piece ${u.pieceNo}/${u.totalPieces} ${u.pieceName} | unit ${u.unitNo}/${u.totalUnits} | status=${u.status}`);
    }
    console.log();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
