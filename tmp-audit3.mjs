import postgres from "postgres";
import { SupabaseAdapter } from "./src/api/lib/supabase-compat.ts";
import { collectComplianceData } from "./src/api/lib/compliance-report.ts";
import { collectBriefData } from "./src/api/lib/production-brief.ts";

const sql = postgres("postgresql://postgres:ZaXI0JigbBD6muTk@db.vpwdqtsxexpiqxzweivd.supabase.co:5432/postgres", { ssl:"require", max:1, idle_timeout:5 });
const db = new SupabaseAdapter(sql);

const today = "2026-08-05";
const prev = "2026-08-04";

const comp = await collectComplianceData(db, today);
console.log("=== COMPLIANCE COUNTS ===");
console.log(JSON.stringify(comp.counts, null, 1));

const brief = await collectBriefData(db, today, prev, undefined, {});
console.log("=== BRIEF ===");
console.log(JSON.stringify({
  scheduleTotals: brief.schedule.totals,
  scheduleByDept: brief.schedule.byDepartment.map(d=>({d:d.code,c:d.count,m:d.prodMinutes})),
  cnc: { ...brief.cnc, topFabrics: brief.cnc.topFabrics.slice(0,5) },
  cncConfig: brief.cncConfig,
  drift: brief.drift,
  overdueTotals: brief.overdue.totals,
  effTotals: brief.efficiency.totals,
  lowWorkers: brief.lowWorkers.length,
}, null, 1));
await sql.end();
