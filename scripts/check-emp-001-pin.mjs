import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
const sql = postgres(prodUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const w = await sql`SELECT id, emp_no, name, status, phone FROM workers WHERE LOWER(emp_no) = 'emp-001' LIMIT 1`;
  if (w.length === 0) { console.log("no worker EMP-001"); }
  else {
    const r = w[0];
    console.log(`worker: id=${r.id} empNo=${r.emp_no} name=${r.name} status=${r.status} phone=${r.phone ?? "—"}`);
    const p = await sql`SELECT pin, updated_at, must_reset, length(pin) AS len FROM worker_pins WHERE worker_id = ${r.id}`;
    if (p.length === 0) console.log("no PIN set yet (firstTimePin path)");
    else console.log(`pin row: len=${p[0].len} mustReset=${p[0].must_reset} updatedAt=${p[0].updated_at} (hashed=SHA-256, length 64 hex)`);
  }
} finally { await sql.end(); }
