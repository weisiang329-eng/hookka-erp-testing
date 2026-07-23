#!/usr/bin/env node
// Dry-run / live driver for /api/import/backfill-sofa-leg-heights.
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

async function main() {
  const live = process.argv[2] === "--live";
  const auth = await login();

  const r = await fetch(`${BASE}/api/import/backfill-sofa-leg-heights`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: auth.cookies, "x-csrf-token": auth.csrf },
    body: JSON.stringify({ dryRun: !live }),
  });
  const j = await r.json();
  console.log(`status: ${r.status}`);
  console.log(`mode: ${live ? "LIVE" : "DRY-RUN"}`);
  console.log(`scanned soItems=${j.scanned?.soItems} pos=${j.scanned?.pos}`);
  console.log(`updateCount: ${j.updateCount ?? j.updated}`);
  console.log(`distribution:`, j.distribution);
  console.log(`\nsample updates:`);
  for (const u of (j.sampleUpdates || []).slice(0, 15)) {
    console.log(`  [${u.table}] ${u.soNo} line ${u.lineNo} ${u.productCode}: ${u.from} → ${u.to}"`);
  }

  if (!live) console.log("\n(dry-run only — pass --live to apply)");
}

main().catch((e) => { console.error(e); process.exit(1); });
