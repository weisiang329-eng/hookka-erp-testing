#!/usr/bin/env node
// Sweep audit-po-alignment across every SO that has at least one
// production_order. Reports any SO with ok=false. Read-only.

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
    .split(",")
    .map((c) => c.trim().split(";")[0])
    .filter(Boolean)
    .join("; ");
  const j = await r.json();
  const csrf = j?.data?.csrfToken || j?.csrfToken || "";
  return { cookies, csrf };
}

async function getSOIds({ cookies, csrf }) {
  // List all SOs by paging /api/sales-orders. Should be < 500 rows for the
  // current dataset.
  const r = await fetch(`${BASE}/api/sales-orders?limit=1000`, {
    headers: { cookie: cookies, "x-csrf-token": csrf },
  });
  if (!r.ok) throw new Error(`list sales-orders: ${r.status} ${await r.text()}`);
  const j = await r.json();
  const rows = j?.data?.rows || j?.data || j?.rows || [];
  return rows.map((r) => r.id).filter(Boolean);
}

async function audit(soId, { cookies, csrf }) {
  const url = `${BASE}/api/import/audit-po-alignment?soId=${encodeURIComponent(soId)}`;
  const r = await fetch(url, {
    headers: { cookie: cookies, "x-csrf-token": csrf },
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

async function main() {
  const auth = await login();
  console.log("login ok");
  const ids = await getSOIds(auth);
  console.log(`scanning ${ids.length} SOs`);

  const failures = [];
  let scanned = 0;
  for (const id of ids) {
    const { status, body } = await audit(id, auth);
    scanned++;
    if (status !== 200) continue;
    if (!body.success) continue;
    // ok=true with expectedPoCount=0 means SO has no production_orders → skip.
    if (body.expectedPoCount === 0 && body.actualPoCount === 0) continue;
    if (!body.ok) {
      failures.push({
        soId: id,
        companySOId: body.companySOId,
        expectedPoCount: body.expectedPoCount,
        actualPoCount: body.actualPoCount,
        surplus: body.surplusTuples?.length ?? 0,
        missing: body.missingTuples?.length ?? 0,
      });
    }
    if (scanned % 50 === 0) {
      console.log(`  ... ${scanned}/${ids.length} scanned, ${failures.length} failures so far`);
    }
  }

  console.log(`\n=== Sweep complete ===`);
  console.log(`Scanned: ${scanned}`);
  console.log(`Failures (ok=false): ${failures.length}`);
  if (failures.length > 0) {
    console.log(`\nFailing SOs:`);
    for (const f of failures) {
      console.log(JSON.stringify(f));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
