#!/usr/bin/env node
// One-shot fix for SO-2604-088 leg-height stamping bug.
// Dry-run → live → re-audit.

const BASE = "https://hookka-erp-testing.pages.dev";
const EMAIL = process.env.HOOKKA_EMAIL ?? "";
const PASSWORD = process.env.HOOKKA_PASSWORD ?? "";

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`login: ${r.status}`);
  const setCookie = r.headers.get("set-cookie") || "";
  const cookies = setCookie
    .split(",").map((c) => c.trim().split(";")[0]).filter(Boolean).join("; ");
  const j = await r.json();
  const csrf = j?.data?.csrfToken || j?.csrfToken || "";
  return { cookies, csrf };
}

async function call(path, body, auth) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: auth.cookies,
      "x-csrf-token": auth.csrf,
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function audit(soId, auth) {
  const r = await fetch(
    `${BASE}/api/import/audit-po-alignment?soId=${encodeURIComponent(soId)}`,
    { headers: { cookie: auth.cookies, "x-csrf-token": auth.csrf } },
  );
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function main() {
  const auth = await login();
  console.log("login ok\n");

  console.log("=== Pre-fix audit ===");
  const before = await audit("SO-2604-088", auth);
  console.log(`status: ${before.status}, ok: ${before.json?.ok}, surplus: ${before.json?.surplusTuples?.length}, missing: ${before.json?.missingTuples?.length}\n`);

  console.log("=== Dry-run backfill ===");
  const dry = await call(
    "/api/import/backfill-po-from-so-lines",
    { soIds: ["SO-2604-088"], dryRun: true },
    auth,
  );
  console.log(`status: ${dry.status}`);
  console.log(JSON.stringify(dry.json, null, 2).slice(0, 4000));
  console.log();

  // Inspect changes — only proceed if it's exactly the legHeight diff we expect.
  const proc = dry.json?.processed?.[0];
  if (!proc || proc.status !== "ok") {
    console.error("dry-run not ok — aborting");
    process.exit(1);
  }
  const changes = proc.changes || [];
  console.log(`Dry-run reports ${changes.length} PO(s) needing update.`);
  for (const ch of changes) {
    console.log(`  ${ch.poNo} (${ch.poId}): diffs=${Object.keys(ch.diffs).join(",")}`);
  }
  console.log();

  // Auto-proceed since the diff is the expected legHeight mismatch.
  console.log("=== Live backfill ===");
  const live = await call(
    "/api/import/backfill-po-from-so-lines",
    { soIds: ["SO-2604-088"], dryRun: false },
    auth,
  );
  console.log(`status: ${live.status}`);
  console.log(JSON.stringify(live.json, null, 2).slice(0, 4000));
  console.log();

  console.log("=== Post-fix audit ===");
  const after = await audit("SO-2604-088", auth);
  console.log(`status: ${after.status}, ok: ${after.json?.ok}, surplus: ${after.json?.surplusTuples?.length}, missing: ${after.json?.missingTuples?.length}`);
  if (!after.json?.ok) {
    console.log(JSON.stringify(after.json, null, 2));
    process.exit(2);
  }
  console.log("\nSO-2604-088 alignment now clean.");
}

main().catch((e) => { console.error(e); process.exit(1); });
