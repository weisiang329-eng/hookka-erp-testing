#!/usr/bin/env node
// Smoke test: GET a few SOs' production_orders → regen-fg-units (dry-run)
// then optionally live. Verifies the bedframe pieces auto-derive + sofa
// aggregation feature.

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

async function call(path, body, auth, method = "POST") {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: auth.cookies,
      "x-csrf-token": auth.csrf,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function get(path, auth) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { cookie: auth.cookies, "x-csrf-token": auth.csrf },
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function main() {
  const auth = await login();
  console.log("login ok\n");

  const dryRunOnly = process.argv[2] !== "--live";

  // Scan ALL SOs.
  const soList = await get("/api/sales-orders?limit=2000", auth);
  const sos = soList.json?.data?.rows || soList.json?.data || [];
  const soIds = sos.map((s) => s.id);
  console.log(`Scanning ALL ${soIds.length} SOs\n`);

  // Dry-run first
  console.log("=== Dry-run ===");
  const dry = await call(
    "/api/import/regen-fg-units",
    { soIds, dryRun: true },
    auth,
  );
  console.log(`status: ${dry.status}`);
  if (dry.json) {
    console.log(`scanned=${dry.json.scanned} regenerated=${dry.json.regenerated} skipped=${dry.json.skipped} errors=${dry.json.errors}`);
    const samples = (dry.json.results || []).slice(0, 5);
    for (const r of samples) {
      console.log(`  ${r.poNo || r.poId}: status=${r.status} deletedCount=${r.deletedCount} blockedBy=${(r.blockedByStatuses || []).join(",")}`);
    }
  }
  console.log();

  if (dryRunOnly) {
    console.log("(dry-run only — pass --live to actually regen)");
    return;
  }

  console.log("=== Live regen ===");
  const live = await call(
    "/api/import/regen-fg-units",
    { soIds, dryRun: false },
    auth,
  );
  console.log(`status: ${live.status}`);
  if (live.json) {
    console.log(`scanned=${live.json.scanned} regenerated=${live.json.regenerated} skipped=${live.json.skipped} errors=${live.json.errors}`);
    const samples = (live.json.results || []).filter((r) => r.status === "regenerated").slice(0, 5);
    for (const r of samples) {
      console.log(`  ${r.poNo || r.poId}: deleted=${r.deletedCount} created=${r.createdCount}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
