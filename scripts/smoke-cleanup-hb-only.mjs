#!/usr/bin/env node
// Smoke driver for /api/import/cleanup-headboard-only-divans.
// Default: dry-run. Pass --live to actually DELETE the orphan DIVAN JCs +
// fg_units for SOs/COs whose specialOrder contains "Headboard Only".
// Production-lock guard inside the endpoint preserves COMPLETED job_cards
// and any fg_unit whose status is not PENDING.
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
  const r = await fetch(`${BASE}/api/import/cleanup-headboard-only-divans`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: auth.cookies, "x-csrf-token": auth.csrf },
    body: JSON.stringify({ dryRun: !live }),
  });
  const j = await r.json();
  console.log(`status: ${r.status} | mode: ${live ? "LIVE" : "DRY-RUN"}`);
  console.log(`scanned POs:        ${j.scanned}`);
  console.log(`eligible SOs/COs:   ${j.eligibleSOs}`);
  console.log(`deleted job_cards:  ${j.deletedJCs}`);
  console.log(`deleted fg_units:   ${j.deletedFgUnits}`);
  console.log(`skipped (locks):    JC=${j.skippedDueToLocks?.jcs ?? 0} FG=${j.skippedDueToLocks?.fgUnits ?? 0}`);
  if (Array.isArray(j.sample) && j.sample.length > 0) {
    console.log("\nSample (first 5):");
    for (const s of j.sample) {
      const ref = s.soId || s.coId || "?";
      console.log(`  ${s.poNo} (${s.productCode ?? "?"}) [${ref}] → ${s.deletedPieces.join(", ")}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
