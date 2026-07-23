#!/usr/bin/env node
// Spot-check fg_units after regen for a specific SO.
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
  const cookies = setCookie
    .split(",").map((c) => c.trim().split(";")[0]).filter(Boolean).join("; ");
  const j = await r.json();
  return { cookies, csrf: j?.data?.csrfToken || "" };
}

async function get(path, auth) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { cookie: auth.cookies, "x-csrf-token": auth.csrf },
  });
  return await r.json().catch(() => ({}));
}

async function main() {
  const soNo = process.argv[2] || "SO-2604-088";
  const auth = await login();

  // Resolve to internal id
  const list = await get(`/api/sales-orders?search=${encodeURIComponent(soNo)}`, auth);
  const so = (list?.data?.rows || list?.data || []).find((s) => s.companySOId === soNo);
  if (!so) { console.log(`SO ${soNo} not found`); return; }
  console.log(`SO: ${so.companySOId} (${so.id})`);

  // Get production_orders for this SO
  const pos = await get(`/api/production-orders?soId=${encodeURIComponent(so.id)}`, auth);
  const poList = pos?.data?.rows || pos?.data || [];
  console.log(`POs: ${poList.length}\n`);

  for (const po of poList) {
    console.log(`PO ${po.poNo} — category=${po.itemCategory} size=${po.sizeCode} legs=${po.legHeightInches}`);
    const fg = await get(`/api/fg-units?poId=${encodeURIComponent(po.id)}`, auth);
    const units = fg?.data?.rows || fg?.data || [];
    for (const u of units) {
      console.log(`  ${u.unitSerial} | piece ${u.pieceNo}/${u.totalPieces} ${u.pieceName} | unit ${u.unitNo}/${u.totalUnits} | status=${u.status}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
