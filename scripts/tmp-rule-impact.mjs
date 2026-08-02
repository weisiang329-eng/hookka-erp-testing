// What do the HR rules change, on July's real punches?
import postgres from "postgres";
const sql = postgres("postgresql://postgres:ZaXI0JigbBD6muTk@db.vpwdqtsxexpiqxzweivd.supabase.co:5432/postgres",{ssl:"require",max:1,idle_timeout:5});

const START = 8*60, END = 18*60;
const toMin = (t) => { if(!t) return null; const m=/(\d{1,2}):(\d{2})/.exec(String(t)); return m? (+m[1])*60 + (+m[2]) : null; };

// CURRENT: grace 10, late rounds UP to 15-blocks; OT floors with <=15 -> 0, then <30 -> 0
const curLate = (inMin) => { const raw = Math.max(0, inMin - START); return raw > 10 ? Math.ceil(raw/15)*15 : 0; };
const curRound = (m) => m<=15?0 : m<=29?15 : m<=44?30 : 45;
const curOt = (outMin) => { if (outMin<=END) return 0; const r=Math.floor(outMin/60)*60+curRound(outMin%60); let ot=Math.max(0,r-END); return ot<30?0:ot; };
// HR: grace 15, late per MINUTE from 08:00; OT floors to 15 (>=15 counts)
const hrLate  = (inMin) => { const raw = Math.max(0, inMin - START); return raw > 15 ? raw : 0; };
const hrOt    = (outMin) => { if (outMin<=END) return 0; const ot=outMin-END; return Math.floor(ot/15)*15; };

try {
  const rows = await sql`
    SELECT employee_id, date, clock_in, clock_out FROM attendance_records
    WHERE date >= '2026-07-01' AND date <= '2026-07-31' AND clock_in IS NOT NULL`;
  let n=0, lateCur=0, lateHr=0, otCur=0, otHr=0, changedLate=0, changedOt=0;
  for (const r of rows) {
    const i = toMin(r.clock_in), o = toMin(r.clock_out);
    if (i===null) continue;
    n++;
    const lc = curLate(i), lh = hrLate(i);
    lateCur += lc; lateHr += lh; if (lc!==lh) changedLate++;
    if (o!==null) { const oc=curOt(o), oh=hrOt(o); otCur+=oc; otHr+=oh; if(oc!==oh) changedOt++; }
  }
  console.log(`July punches with a clock-in: ${n}`);
  console.log(`LATE  minutes  current ${lateCur}  ->  HR ${lateHr}   (${lateHr-lateCur >= 0 ? '+' : ''}${lateHr-lateCur}) · days changed: ${changedLate}`);
  console.log(`OT    minutes  current ${otCur}  ->  HR ${otHr}   (+${otHr-otCur}) · days changed: ${changedOt}`);
} finally { await sql.end(); }
