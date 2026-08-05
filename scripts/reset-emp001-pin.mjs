import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
const sql = postgres(prodUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
const API = "https://hookka-erp-testing.pages.dev";
try {
  const w = await sql`SELECT id, emp_no, name FROM workers WHERE emp_no = 'EMP-001'`;
  const p = await sql`SELECT length(pin) AS len, must_reset, updated_at FROM worker_pins WHERE worker_id = ${w[0].id}`;
  console.log("worker:", w[0]);
  console.log("pin row:", p[0]);

  // Reset via admin endpoint to PIN 999111
  const adminLogin = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: process.env.HOOKKA_EMAIL ?? "", password: process.env.HOOKKA_PASSWORD ?? "" }),
  });
  const aJ = await adminLogin.json();
  const cookieHeader = (adminLogin.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const csrf = aJ?.data?.csrfToken;

  const setPin = await fetch(`${API}/api/workers/${w[0].id}/set-pin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-csrf-token": csrf, Cookie: cookieHeader },
    body: JSON.stringify({ pin: "999111" }),
  });
  console.log("set-pin:", setPin.status, JSON.stringify(await setPin.json()));

  // Verify by attempting login
  const login = await fetch(`${API}/api/worker-auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ empNo: "EMP-001", pin: "999111" }),
  });
  console.log("test login with 999111:", login.status, JSON.stringify(await login.json()).slice(0, 150));
} finally { await sql.end(); }
