import postgres from "postgres";
import { SupabaseAdapter } from "../src/api/lib/supabase-compat.ts";
const url = "postgresql://postgres:wfIPMyT4462iK0za@db.zaxygxwadidiqcphibma.supabase.co:5432/postgres";
const DB = new SupabaseAdapter(postgres(url, { ssl: "require", max: 1, idle_timeout: 5, prepare: false, fetch_types: false }));
const r = await DB.prepare("SELECT id, empNo, name, basicSalarySen FROM workers WHERE empNo = ?").bind("EMP-001").all();
console.log(JSON.stringify(r.results?.[0], null, 2));
process.exit(0);
