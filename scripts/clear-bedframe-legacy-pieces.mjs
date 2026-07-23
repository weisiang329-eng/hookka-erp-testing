#!/usr/bin/env node
// Clear product.pieces on bedframes that still carry the legacy
// {count:3, names:["HB","Divan","Legs"]} config so the new size-default
// (Headboard/Divan/Divan for K/Q, Headboard/Divan for S/SS) takes over.
// Sofa pieces are kept as-is — those are real compartment configs.
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

async function put(path, body, auth) {
  const r = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: auth.cookies, "x-csrf-token": auth.csrf },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function main() {
  const dryRun = process.argv[2] !== "--live";
  const auth = await login();

  const list = await get("/api/products?limit=1000", auth);
  const products = list?.data || list?.rows || [];
  const targets = products.filter((p) => {
    if (p.category !== "BEDFRAME") return false;
    if (!p.pieces) return false;
    const pieces = typeof p.pieces === "string" ? JSON.parse(p.pieces) : p.pieces;
    if (!pieces || pieces.count !== 3) return false;
    const names = (pieces.names || []).map((n) => String(n).toLowerCase());
    // Match the legacy ["HB","Divan","Legs"] shape — case-insensitive.
    return names.length === 3 && names[0] === "hb" && names[2] === "legs";
  });

  console.log(`Found ${targets.length} bedframe SKU(s) with legacy pieces config:`);
  for (const t of targets) {
    const piecesStr = typeof t.pieces === "string" ? t.pieces : JSON.stringify(t.pieces);
    console.log(`  ${t.code} (sizeCode=${t.sizeCode}): ${piecesStr}`);
  }
  console.log();

  if (dryRun) {
    console.log("(dry-run only — pass --live to actually clear)");
    return;
  }

  for (const t of targets) {
    // PUT with pieces=null clears the column → size-default takes over.
    const res = await put(`/api/products/${encodeURIComponent(t.id)}`, { pieces: null }, auth);
    console.log(`  ${t.code}: status=${res.status} success=${res.json?.success}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
