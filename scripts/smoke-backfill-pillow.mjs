#!/usr/bin/env node
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
  const r = await fetch(`${BASE}/api/import/backfill-pillow-packing-jc`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: auth.cookies, "x-csrf-token": auth.csrf },
    body: JSON.stringify({ dryRun: !live }),
  });
  const j = await r.json();
  console.log(`status: ${r.status} | mode: ${live ? "LIVE" : "DRY-RUN"}`);
  console.log(`scannedPOs: ${j.scannedPOs} | scannedGroups: ${j.scannedGroups}`);
  console.log(`created: ${j.created ?? 0} | wouldCreate: ${j.wouldCreate ?? 0} | skipped: ${j.skipped ?? 0} | errors: ${j.errors ?? 0}`);
  console.log("\nResults:");
  for (const r of j.results || []) {
    console.log(`  [${r.status}] ${r.productCode} ${r.fabricCode} | poCount=${r.poCount} totalQty=${r.totalQty}${r.deletedJcCount != null ? ` deletedJC=${r.deletedJcCount}` : ""}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
