import postgres from "postgres";
const sql = postgres("postgresql://postgres:ZaXI0JigbBD6muTk@db.vpwdqtsxexpiqxzweivd.supabase.co:5432/postgres", { ssl:"require", max:1, idle_timeout:5 });
const out = {};

// holidays
out.holidays = await sql`SELECT value FROM kv_config WHERE key='public_holidays'`;

// FAB_CUT wip_qty distribution (queued)
out.fabcutWip = await sql`
  SELECT jc.wip_qty, count(*) FROM job_cards jc
   WHERE jc.department_code='FAB_CUT' AND jc.status NOT IN ('COMPLETED','CANCELLED','TRANSFERRED')
   GROUP BY 1 ORDER BY 1`;

// fabric buckets in cnc queue
out.cncFabricBuckets = await sql`
  SELECT COALESCE(NULLIF(TRIM(po.fabric_code),''),'(no fabric)') AS fab,
         COUNT(*) AS cards, SUM(GREATEST(1,COALESCE(jc.wip_qty,1))) AS qty
    FROM job_cards jc JOIN production_orders po ON po.id=jc.production_order_id
   WHERE jc.department_code='FAB_CUT' AND jc.status NOT IN ('COMPLETED','CANCELLED','TRANSFERRED')
     AND po.status IN ('IN_PROGRESS','PENDING')
   GROUP BY 1 ORDER BY 2 DESC`;

// jc status breakdown for FAB_CUT queue
out.fabcutStatus = await sql`
  SELECT jc.status, count(*) FROM job_cards jc JOIN production_orders po ON po.id=jc.production_order_id
   WHERE jc.department_code='FAB_CUT' AND jc.status NOT IN ('COMPLETED','CANCELLED','TRANSFERRED')
     AND po.status IN ('IN_PROGRESS','PENDING') GROUP BY 1`;

// actual_minutes coverage overall
out.actualCoverage = await sql`
  SELECT department_code, count(*) AS n,
         SUM(CASE WHEN actual_minutes IS NOT NULL THEN 1 ELSE 0 END) AS with_actual
    FROM job_cards WHERE status IN ('COMPLETED','TRANSFERRED') GROUP BY 1 ORDER BY 1`;

// ---- Daily capacity (rolling 7 working days ending yesterday, ex Sundays/holidays)
out.completedByDay = await sql`
  SELECT completed_date::text AS d,
         SUM(CASE WHEN department_code='FAB_CUT' THEN COALESCE(actual_minutes,est_minutes,0)
                  ELSE COALESCE(actual_minutes,est_minutes,0)*GREATEST(1,COALESCE(wip_qty,1)) END) AS mins,
         COUNT(*) AS cards
    FROM job_cards
   WHERE org_id='hookka' AND status IN ('COMPLETED','TRANSFERRED') AND completed_date IS NOT NULL
     AND completed_date::text >= '2026-07-01'
   GROUP BY 1 ORDER BY 1`;

// ---- Backlog by dept (current code: no SO filter)
out.backlogByDept = await sql`
  SELECT jc.department_code AS dept,
         SUM(CASE WHEN upper(COALESCE(po.item_category,''))='SOFA' THEN
             (CASE WHEN jc.department_code='FAB_CUT' THEN COALESCE(jc.est_minutes,0)
                   ELSE COALESCE(jc.est_minutes,0)*GREATEST(1,COALESCE(jc.wip_qty,1)) END) ELSE 0 END) AS sofa_min,
         SUM(CASE WHEN upper(COALESCE(po.item_category,''))='BEDFRAME' THEN
             (CASE WHEN jc.department_code='FAB_CUT' THEN COALESCE(jc.est_minutes,0)
                   ELSE COALESCE(jc.est_minutes,0)*GREATEST(1,COALESCE(jc.wip_qty,1)) END) ELSE 0 END) AS bf_min
    FROM job_cards jc JOIN production_orders po ON po.id=jc.production_order_id
   WHERE jc.org_id='hookka' AND po.status IN ('IN_PROGRESS','PENDING')
     AND jc.status NOT IN ('COMPLETED','CANCELLED','TRANSFERRED')
   GROUP BY 1 ORDER BY 1`;

// ---- Backlog by dept EXCLUDING POs whose SO is invoiced/shipped/closed
out.backlogByDeptClean = await sql`
  SELECT jc.department_code AS dept,
         SUM(CASE WHEN upper(COALESCE(po.item_category,''))IN('SOFA','BEDFRAME') THEN
             (CASE WHEN jc.department_code='FAB_CUT' THEN COALESCE(jc.est_minutes,0)
                   ELSE COALESCE(jc.est_minutes,0)*GREATEST(1,COALESCE(jc.wip_qty,1)) END) ELSE 0 END) AS tot_min
    FROM job_cards jc JOIN production_orders po ON po.id=jc.production_order_id
    LEFT JOIN sales_orders so ON so.id=po.sales_order_id
   WHERE jc.org_id='hookka' AND po.status IN ('IN_PROGRESS','PENDING')
     AND jc.status NOT IN ('COMPLETED','CANCELLED','TRANSFERRED')
     AND (so.status IS NULL OR so.status NOT IN ('INVOICED','SHIPPED','DELIVERED','CLOSED'))
   GROUP BY 1 ORDER BY 1`;

// backlog categories not counted (ACCESSORY / null)
out.backlogOtherCats = await sql`
  SELECT upper(COALESCE(po.item_category,'(null)')) AS cat, count(*) AS cards,
         SUM(CASE WHEN jc.department_code='FAB_CUT' THEN COALESCE(jc.est_minutes,0)
                  ELSE COALESCE(jc.est_minutes,0)*GREATEST(1,COALESCE(jc.wip_qty,1)) END) AS mins
    FROM job_cards jc JOIN production_orders po ON po.id=jc.production_order_id
   WHERE jc.org_id='hookka' AND po.status IN ('IN_PROGRESS','PENDING')
     AND jc.status NOT IN ('COMPLETED','CANCELLED','TRANSFERRED')
   GROUP BY 1 ORDER BY 3 DESC`;

// ---- how much of the rolling-7 capacity denominator comes from non-SOFA/BF cards
out.capBySplit = await sql`
  SELECT CASE WHEN upper(COALESCE(po.item_category,'')) IN ('SOFA','BEDFRAME') THEN 'SOFA/BF' ELSE 'other' END AS grp,
         SUM(CASE WHEN jc.department_code='FAB_CUT' THEN COALESCE(jc.actual_minutes,jc.est_minutes,0)
                  ELSE COALESCE(jc.actual_minutes,jc.est_minutes,0)*GREATEST(1,COALESCE(jc.wip_qty,1)) END) AS mins,
         count(*) AS cards
    FROM job_cards jc LEFT JOIN production_orders po ON po.id=jc.production_order_id
   WHERE jc.org_id='hookka' AND jc.status IN ('COMPLETED','TRANSFERRED')
     AND jc.completed_date::text >= '2026-07-28'
   GROUP BY 1`;

// ---- Workforce
out.workers = await sql`
  SELECT department_code AS dept, count(*) AS n FROM workers
   WHERE status='ACTIVE' AND emp_no NOT LIKE 'TEST%' GROUP BY 1 ORDER BY 2 DESC`;

// ---- Completed in month (per-day, code sums COUNT(DISTINCT so) per day)
out.completedMonth = await sql`
  WITH per_po AS (
    SELECT production_order_id,
           MAX(CASE WHEN status IN ('COMPLETED','TRANSFERRED') AND completed_date IS NOT NULL
                    THEN completed_date END) AS unit_completed_at
      FROM job_cards WHERE department_code='UPHOLSTERY' GROUP BY 1
     HAVING COUNT(*)>0 AND SUM(CASE WHEN status IN ('COMPLETED','TRANSFERRED') AND completed_date IS NOT NULL THEN 1 ELSE 0 END)=COUNT(*)
  )
  SELECT substr(per_po.unit_completed_at::text,1,10) AS d,
         COALESCE(SUM(CASE WHEN po.item_category='BEDFRAME' THEN po.quantity ELSE 0 END),0) AS bf,
         COUNT(DISTINCT CASE WHEN po.item_category='SOFA' THEN po.sales_order_id END) AS sofa
    FROM per_po JOIN production_orders po ON po.id=per_po.production_order_id
   WHERE po.org_id='hookka' AND substr(per_po.unit_completed_at::text,1,10) >= '2026-08-01'
     AND substr(per_po.unit_completed_at::text,1,10) <= '2026-08-05'
   GROUP BY 1 ORDER BY 1`;

out.completedMonthDistinct = await sql`
  WITH per_po AS (
    SELECT production_order_id,
           MAX(CASE WHEN status IN ('COMPLETED','TRANSFERRED') AND completed_date IS NOT NULL
                    THEN completed_date END) AS unit_completed_at
      FROM job_cards WHERE department_code='UPHOLSTERY' GROUP BY 1
     HAVING COUNT(*)>0 AND SUM(CASE WHEN status IN ('COMPLETED','TRANSFERRED') AND completed_date IS NOT NULL THEN 1 ELSE 0 END)=COUNT(*)
  )
  SELECT COUNT(DISTINCT CASE WHEN po.item_category='SOFA' THEN po.sales_order_id END) AS sofa_distinct,
         COALESCE(SUM(CASE WHEN po.item_category='BEDFRAME' THEN po.quantity ELSE 0 END),0) AS bf
    FROM per_po JOIN production_orders po ON po.id=per_po.production_order_id
   WHERE po.org_id='hookka' AND substr(per_po.unit_completed_at::text,1,10) BETWEEN '2026-08-01' AND '2026-08-05'`;

console.log(JSON.stringify(out,null,1));
await sql.end();
