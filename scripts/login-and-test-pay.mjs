// Set EMP-001 PIN via admin then login as worker, then call /api/worker/payslips to see actual error
const API = "https://hookka-erp-testing.pages.dev";

// Login as admin
const adminLogin = await fetch(`${API}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: process.env.HOOKKA_EMAIL ?? "", password: process.env.HOOKKA_PASSWORD ?? "" }),
});
const adminJ = await adminLogin.json();
const adminCookies = adminLogin.headers.getSetCookie?.() ?? [];
const adminCookieHeader = adminCookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
const csrf = adminJ?.data?.csrfToken;
console.log("admin login:", adminLogin.status);

// Set EMP-001 PIN to 999111 via admin endpoint
const setPinRes = await fetch(`${API}/api/workers/worker-b311d39e/set-pin`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-csrf-token": csrf, Cookie: adminCookieHeader },
  body: JSON.stringify({ pin: "999111" }),
});
const setPinJ = await setPinRes.json();
console.log("set-pin:", setPinRes.status, JSON.stringify(setPinJ));

// Login as worker EMP-001 with PIN 999111
const wLogin = await fetch(`${API}/api/worker-auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ empNo: "EMP-001", pin: "999111" }),
});
const wJ = await wLogin.json();
console.log("worker login:", wLogin.status, JSON.stringify(wJ).slice(0, 200));
const token = wJ?.token;

// Call /api/worker/payslips
const payRes = await fetch(`${API}/api/worker/payslips`, {
  headers: { "X-Worker-Token": token },
});
const payText = await payRes.text();
console.log("\n/api/worker/payslips:", payRes.status);
console.log(payText.slice(0, 800));

// Call /api/worker/history
const histRes = await fetch(`${API}/api/worker/history?from=2026-04-30&to=2026-05-09`, {
  headers: { "X-Worker-Token": token },
});
const histText = await histRes.text();
console.log("\n/api/worker/history:", histRes.status);
console.log(histText.slice(0, 800));
