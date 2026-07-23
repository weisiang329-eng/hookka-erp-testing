#!/usr/bin/env node
// Inspect which products have product.pieces set and what shape.
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
  const r = await fetch(`${BASE}${path}`, {
    headers: { cookie: auth.cookies, "x-csrf-token": auth.csrf },
  });
  return await r.json();
}

async function main() {
  const auth = await login();
  const list = await get("/api/products?limit=1000", auth);
  const products = list?.data || list?.rows || [];
  console.log(`Total products: ${products.length}\n`);

  // Group by category + has-pieces
  const stats = { BEDFRAME: { withPieces: 0, withoutPieces: 0, samples: [] }, SOFA: { withPieces: 0, withoutPieces: 0, samples: [] }, ACCESSORY: { withPieces: 0, withoutPieces: 0, samples: [] } };
  const sizeCodes = new Map(); // category → set of size codes seen

  for (const p of products) {
    const cat = p.category || "UNKNOWN";
    if (!stats[cat]) stats[cat] = { withPieces: 0, withoutPieces: 0, samples: [] };
    const hasPieces = p.pieces !== null && p.pieces !== undefined && (typeof p.pieces === "object" ? p.pieces.count > 0 : p.pieces.length > 0);
    if (hasPieces) {
      stats[cat].withPieces++;
      if (stats[cat].samples.length < 6) stats[cat].samples.push({ code: p.code, sizeCode: p.sizeCode, pieces: p.pieces });
    } else {
      stats[cat].withoutPieces++;
    }
    if (cat === "BEDFRAME") {
      const sc = (p.sizeCode || "").trim();
      if (!sizeCodes.has(cat)) sizeCodes.set(cat, new Map());
      sizeCodes.get(cat).set(sc, (sizeCodes.get(cat).get(sc) || 0) + 1);
    }
  }

  for (const [cat, s] of Object.entries(stats)) {
    console.log(`=== ${cat} ===`);
    console.log(`  with pieces: ${s.withPieces}, without: ${s.withoutPieces}`);
    if (s.samples.length > 0) {
      console.log(`  samples with pieces:`);
      for (const sm of s.samples) {
        const piecesStr = typeof sm.pieces === "object" ? JSON.stringify(sm.pieces) : sm.pieces;
        console.log(`    ${sm.code} (sizeCode=${sm.sizeCode}): ${piecesStr}`);
      }
    }
    console.log();
  }

  if (sizeCodes.has("BEDFRAME")) {
    console.log(`=== BEDFRAME sizeCode distribution ===`);
    for (const [sc, n] of [...sizeCodes.get("BEDFRAME").entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  "${sc}": ${n}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
