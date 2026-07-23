#!/usr/bin/env node
// Summarize the regen results: how many POs gained pieces (bedframe
// auto-derive kicked in), stayed the same, or shrank.
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

async function call(path, body, auth) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: auth.cookies, "x-csrf-token": auth.csrf },
    body: JSON.stringify(body),
  });
  return await r.json();
}

async function main() {
  const auth = await login();
  // Re-run dry-run; results show deleted vs created (no-op now since regen
  // is idempotent and the rows match the new logic).
  const soListRes = await fetch(`${BASE}/api/sales-orders?limit=2000`, {
    headers: { cookie: auth.cookies, "x-csrf-token": auth.csrf },
  });
  const soList = await soListRes.json();
  const sos = soList?.data?.rows || soList?.data || [];
  const soIds = sos.map((s) => s.id);

  // Re-run dry-run to gather the latest state. Since we just lived,
  // dry-run will show deleted=current count which is the new count.
  const j = await call("/api/import/regen-fg-units", { soIds, dryRun: true }, auth);

  const buckets = { same: 0, grew: 0, shrunk: 0, unknown: 0 };
  const grewSamples = [];
  const shrunkSamples = [];

  // We don't know from dry-run what the OLD count was vs new (dry-run
  // shows current). But the live run output is what matters. For this
  // summary, print the breakdown by createdCount = deletedCount semantic.
  // After live run, `deletedCount` IS the new count (since rows match).
  // Use distribution of deletedCount.
  const distribution = new Map();
  for (const r of j.results || []) {
    if (r.status !== "regenerated") continue;
    const n = r.deletedCount;
    distribution.set(n, (distribution.get(n) || 0) + 1);
  }

  console.log("Distribution of pieces-per-PO (after regen):");
  for (const [n, count] of [...distribution.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${n} pieces: ${count} PO(s)`);
  }
  console.log(`\nTotal regen-eligible POs: ${j.regenerated}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
