import postgres from "postgres";
const sql = postgres("postgresql://postgres:ZaXI0JigbBD6muTk@db.vpwdqtsxexpiqxzweivd.supabase.co:5432/postgres", { ssl:"require", max:1, idle_timeout:5 });

const out = {};

// 0. org ids
out.orgs = await sql`SELECT org_id, count(*) FROM job_cards GROUP BY org_id`;
out.today = await sql`SELECT now() AT TIME ZONE 'Asia/Kuala_Lumpur' AS myt, current_date`;

// 1. CNC queue (production-brief collectCncQueue) — NO org filter in code
out.cncQueue = await sql`
  SELECT COALESCE(po.item_category,'') AS cat, COUNT(*) AS cards,
         SUM(GREATEST(1, COALESCE(jc.wip_qty,1))) AS qty
    FROM job_cards jc
    JOIN production_orders po ON po.id = jc.production_order_id
   WHERE jc.department_code = 'FAB_CUT'
     AND jc.status NOT IN ('COMPLETED','CANCELLED','TRANSFERRED')
     AND po.status IN ('IN_PROGRESS','PENDING')
   GROUP BY 1 ORDER BY 1`;

out.cncFabrics = await sql`
  SELECT COUNT(DISTINCT COALESCE(NULLIF(TRIM(po.fabric_code),''),'(no fabric)')) AS fabrics
    FROM job_cards jc
    JOIN production_orders po ON po.id = jc.production_order_id
   WHERE jc.department_code = 'FAB_CUT'
     AND jc.status NOT IN ('COMPLETED','CANCELLED','TRANSFERRED')
     AND po.status IN ('IN_PROGRESS','PENDING')`;

// 1b. same but excluding POs whose SO is already invoiced/shipped/closed
out.cncQueueClean = await sql`
  SELECT COALESCE(po.item_category,'') AS cat, COUNT(*) AS cards,
         SUM(GREATEST(1, COALESCE(jc.wip_qty,1))) AS qty
    FROM job_cards jc
    JOIN production_orders po ON po.id = jc.production_order_id
    LEFT JOIN sales_orders so ON so.id = po.sales_order_id
   WHERE jc.department_code = 'FAB_CUT'
     AND jc.status NOT IN ('COMPLETED','CANCELLED','TRANSFERRED')
     AND po.status IN ('IN_PROGRESS','PENDING')
     AND (so.status IS NULL OR so.status NOT IN ('INVOICED','SHIPPED','DELIVERED','CLOSED'))
   GROUP BY 1 ORDER BY 1`;

out.cncFabricsClean = await sql`
  SELECT COUNT(DISTINCT COALESCE(NULLIF(TRIM(po.fabric_code),''),'(no fabric)')) AS fabrics
    FROM job_cards jc
    JOIN production_orders po ON po.id = jc.production_order_id
    LEFT JOIN sales_orders so ON so.id = po.sales_order_id
   WHERE jc.department_code = 'FAB_CUT'
     AND jc.status NOT IN ('COMPLETED','CANCELLED','TRANSFERRED')
     AND po.status IN ('IN_PROGRESS','PENDING')
     AND (so.status IS NULL OR so.status NOT IN ('INVOICED','SHIPPED','DELIVERED','CLOSED'))`;

// 1c. how old are these queued FAB_CUT cards?
out.cncAge = await sql`
  SELECT substr(po.created_at::text,1,7) AS po_month, count(*) AS cards,
         SUM(GREATEST(1,COALESCE(jc.wip_qty,1))) AS qty
    FROM job_cards jc
    JOIN production_orders po ON po.id = jc.production_order_id
   WHERE jc.department_code='FAB_CUT'
     AND jc.status NOT IN ('COMPLETED','CANCELLED','TRANSFERRED')
     AND po.status IN ('IN_PROGRESS','PENDING')
   GROUP BY 1 ORDER BY 1`;

// 2. drift  (last 7 days from today)
out.drift = await sql`
  SELECT COALESCE(po.item_category,'') AS cat,
         SUM(COALESCE(jc.actual_minutes, jc.est_minutes, 0)) AS mins,
         SUM(COALESCE(jc.wip_qty,1)) AS sets,
         COUNT(*) AS cards,
         SUM(CASE WHEN jc.actual_minutes IS NOT NULL THEN 1 ELSE 0 END) AS with_actual
    FROM job_cards jc
    JOIN production_orders po ON po.id = jc.production_order_id
   WHERE jc.department_code = 'FAB_CUT'
     AND jc.status IN ('COMPLETED','TRANSFERRED')
     AND substr(jc.completed_date::text,1,10) >= (current_date - 7)::text
   GROUP BY 1 ORDER BY 1`;

// 2b. raw sample of those cards
out.driftSample = await sql`
  SELECT po.item_category AS cat, jc.wip_qty, jc.est_minutes, jc.actual_minutes,
         jc.completed_date, jc.status, po.quantity AS po_qty
    FROM job_cards jc
    JOIN production_orders po ON po.id = jc.production_order_id
   WHERE jc.department_code='FAB_CUT'
     AND jc.status IN ('COMPLETED','TRANSFERRED')
     AND substr(jc.completed_date::text,1,10) >= (current_date - 7)::text
   ORDER BY po.item_category, jc.completed_date DESC LIMIT 40`;

// 3. capacity config override
out.cfg = await sql`SELECT key, value FROM kv_config WHERE key ILIKE '%capacity%' OR key ILIKE '%cnc%' OR key='planning_capacity_config'`;

console.log(JSON.stringify(out, null, 1));
await sql.end();
