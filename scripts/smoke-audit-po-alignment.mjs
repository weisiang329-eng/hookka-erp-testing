#!/usr/bin/env node
// Smoke test for GET /api/import/audit-po-alignment
// One-shot helper after the multiset-validator rewrite. Logs in via
// cookie+CSRF, hits the endpoint for SO-2604-307, dumps the JSON.

const BASE = "https://hookka-erp-testing.pages.dev";
const EMAIL = process.env.HOOKKA_EMAIL ?? "";
const PASSWORD = process.env.HOOKKA_PASSWORD ?? "";

async function main() {
  // 1. Login (sets http-only cookie, returns CSRF token).
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!loginRes.ok) {
    console.error(`login failed: ${loginRes.status} ${await loginRes.text()}`);
    process.exit(1);
  }
  const setCookie = loginRes.headers.get("set-cookie") || "";
  const cookies = setCookie
    .split(",")
    .map((c) => c.trim().split(";")[0])
    .filter(Boolean)
    .join("; ");
  const loginJson = await loginRes.json();
  const csrfToken = loginJson?.data?.csrfToken || loginJson?.csrfToken;
  console.log(`login ok. csrf=${csrfToken ? "present" : "missing"}, cookies=${cookies ? "present" : "missing"}`);

  // 2. Hit audit endpoint.
  const soId = process.argv[2] || "SO-2604-307";
  const url = `${BASE}/api/import/audit-po-alignment?soId=${encodeURIComponent(soId)}`;
  const auditRes = await fetch(url, {
    headers: {
      cookie: cookies,
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
    },
  });
  const body = await auditRes.text();
  console.log(`status: ${auditRes.status}`);
  try {
    const json = JSON.parse(body);
    console.log(JSON.stringify(json, null, 2));
  } catch {
    console.log(body.slice(0, 2000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
