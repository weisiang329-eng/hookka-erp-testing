// Smoke test for /api/worker/team-stats Operator Leader feature.
// Run: node scripts/smoke-team-stats-2026-05-10.mjs
//
// Postgres uses snake_case + TEXT columns for the JSON arrays
// (department_codes, categories). The Cloudflare D1-compat adapter on the
// API side translates camelCase ↔ snake_case.
import postgres from "postgres";

const API = "https://hookka-erp-testing.pages.dev";
const FROM = "2026-04-15";
const TO = "2026-05-10";
const ADMIN_EMAIL = process.env.HOOKKA_EMAIL ?? "";
const ADMIN_PASSWORD = process.env.HOOKKA_PASSWORD ?? "";

const sql = postgres(
  "postgresql://postgres:ZaXI0JigbBD6muTk@db.vpwdqtsxexpiqxzweivd.supabase.co:5432/postgres",
  { ssl: "require", max: 1, idle_timeout: 5 },
);

function log(label, value) {
  console.log(`\n=== ${label} ===`);
  if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

try {
  // 1. Find candidate workers with UPHOLSTERY+SOFA hours in range.
  const candidates = await sql`
    SELECT worker_id, SUM(hours)::float AS total_hours, COUNT(*)::int AS rows
      FROM working_hour_entries
     WHERE department_code = 'UPHOLSTERY'
       AND category = 'SOFA'
       AND date >= ${FROM}
       AND date <= ${TO}
     GROUP BY worker_id
     ORDER BY total_hours DESC
     LIMIT 10
  `;
  log("Top UPHOLSTERY × SOFA workers in range", candidates);
  if (candidates.length === 0) {
    console.log("No UPHOLSTERY × SOFA hours in range — abort.");
    await sql.end();
    process.exit(1);
  }

  // Pick the top one. Need to ensure they're ACTIVE (so they're in team set).
  let chosenId = null;
  let chosen = null;
  for (const c of candidates) {
    const [w] = await sql`
      SELECT id, emp_no, name, position, department_code, department_codes, categories, status
        FROM workers WHERE id = ${c.worker_id}
    `;
    if (w && w.status === "ACTIVE") {
      chosenId = w.id;
      chosen = w;
      break;
    }
  }
  if (!chosenId) {
    console.log("No ACTIVE candidate — abort.");
    await sql.end();
    process.exit(1);
  }
  log("Chosen worker (before promote)", chosen);

  // 2. Promote to Operator Leader. Save originals for rollback.
  const orig = {
    position: chosen.position,
    department_codes: chosen.department_codes,
    categories: chosen.categories,
  };
  await sql`
    UPDATE workers
       SET position = 'Operator Leader',
           department_codes = ${'["UPHOLSTERY"]'},
           categories = ${'["SOFA"]'}
     WHERE id = ${chosenId}
  `;
  const [postUpdate] = await sql`
    SELECT id, emp_no, position, department_codes, categories
      FROM workers WHERE id = ${chosenId}
  `;
  log("Chosen worker (after promote)", postUpdate);

  // 3. Compute team set the same way the API does:
  //    ACTIVE workers whose departmentCodes/departmentCode contains UPHOLSTERY.
  const allActive = await sql`
    SELECT id, emp_no, department_code, department_codes
      FROM workers WHERE status = 'ACTIVE'
  `;
  function parseCodes(jsonText, fallbackSingle) {
    let codes = [];
    if (jsonText) {
      try {
        const arr = JSON.parse(jsonText);
        if (Array.isArray(arr)) codes = arr.filter((x) => typeof x === "string");
      } catch { /* malformed */ }
    }
    if (codes.length === 0 && fallbackSingle) codes = [fallbackSingle];
    return codes;
  }
  const teamRows = allActive.filter((w) => {
    const codes = parseCodes(w.department_codes, w.department_code);
    return codes.includes("UPHOLSTERY");
  });
  log(`Team size = ${teamRows.length}`, teamRows.map((r) => `${r.emp_no}(${r.id})`));

  // 4. Admin login + reset PIN.
  const adminLoginRes = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const adminJ = await adminLoginRes.json();
  const adminCookies = adminLoginRes.headers.getSetCookie?.() ?? [];
  const adminCookieHeader = adminCookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  const csrf = adminJ?.data?.csrfToken;
  log("admin login status", { status: adminLoginRes.status, hasCsrf: !!csrf });

  const PIN = "778899";
  const setPinRes = await fetch(`${API}/api/workers/${chosenId}/set-pin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrf,
      Cookie: adminCookieHeader,
    },
    body: JSON.stringify({ pin: PIN }),
  });
  const setPinTxt = await setPinRes.text();
  log("set-pin response", { status: setPinRes.status, body: setPinTxt.slice(0, 300) });

  // 5. Worker login.
  const wLoginRes = await fetch(`${API}/api/worker-auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ empNo: chosen.emp_no, pin: PIN }),
  });
  const wJ = await wLoginRes.json();
  log("worker login response", { status: wLoginRes.status, body: wJ });
  const token = wJ?.token ?? wJ?.data?.token;
  if (!token) {
    console.log("No worker token — abort + restore.");
    await restore();
    await sql.end();
    process.exit(1);
  }

  // 6. Call /api/worker/team-stats.
  const tsRes = await fetch(`${API}/api/worker/team-stats?from=${FROM}&to=${TO}`, {
    headers: { "X-Worker-Token": token },
  });
  const tsTxt = await tsRes.text();
  let tsJ;
  try { tsJ = JSON.parse(tsTxt); } catch { tsJ = tsTxt; }
  log("/api/worker/team-stats response", { status: tsRes.status, body: tsJ });

  // 7. Cross-check: SUM(hours) for chosen worker UPHOLSTERY+SOFA in range
  //    AND for the team union (handler aggregates across team).
  const [singleTotal] = await sql`
    SELECT COALESCE(SUM(hours), 0)::float AS hours
      FROM working_hour_entries
     WHERE worker_id = ${chosenId}
       AND department_code = 'UPHOLSTERY'
       AND category = 'SOFA'
       AND date >= ${FROM}
       AND date <= ${TO}
  `;
  const teamIds = teamRows.map((r) => r.id);
  const [teamTotal] = await sql`
    SELECT COALESCE(SUM(hours), 0)::float AS hours
      FROM working_hour_entries
     WHERE worker_id = ANY(${teamIds})
       AND department_code = 'UPHOLSTERY'
       AND category = 'SOFA'
       AND date >= ${FROM}
       AND date <= ${TO}
  `;
  log("DB cross-check totals (hours)", {
    chosen_worker_only_hours: singleTotal.hours,
    chosen_worker_only_minutes: Math.round(singleTotal.hours * 60),
    team_union_hours: teamTotal.hours,
    team_union_minutes: Math.round(teamTotal.hours * 60),
  });

  // Verify API row.
  const apiRows = (tsJ && tsJ.data && tsJ.data.rows) || [];
  const sofaRow = apiRows.find((r) => r.departmentCode === "UPHOLSTERY" && r.category === "SOFA");
  const bedframeRow = apiRows.find((r) => r.departmentCode === "UPHOLSTERY" && r.category === "BEDFRAME");
  // The API rounds per-row: workingMinutes += round(hours * 60). Approximate match.
  const expectedMinutes = Math.round(teamTotal.hours * 60);
  log("Verification", {
    isLeader: tsJ?.data?.isLeader,
    rowCount: apiRows.length,
    hasSofaRow: !!sofaRow,
    hasBedframeRow_should_be_false: !!bedframeRow,
    apiWorkingMinutes: sofaRow?.workingMinutes,
    expectedTeamWorkingMinutes_approx: expectedMinutes,
    matches_within_60s: Math.abs((sofaRow?.workingMinutes ?? 0) - expectedMinutes) <= 60,
    productionMinutes: sofaRow?.productionMinutes,
    efficiencyPct: sofaRow?.efficiencyPct,
    workerCount: sofaRow?.workerCount,
  });

  async function restore() {
    await sql`
      UPDATE workers
         SET position = ${orig.position},
             department_codes = ${orig.department_codes},
             categories = ${orig.categories}
       WHERE id = ${chosenId}
    `;
    log("Restored worker to original state", { id: chosenId, ...orig });
  }
  await restore();
} catch (err) {
  console.error("FAIL:", err);
} finally {
  await sql.end();
}
