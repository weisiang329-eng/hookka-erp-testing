// One-shot: rebuild wip_items.stockQty + status from current job_cards state.
//
// Why: prior `applyWipInventoryChange` zeroed every upstream wip_items row when
// UPH completed, regardless of consumption qty.  That left rows at stockQty=0
// status=IN_PRODUCTION that should still hold residue stock (Fab Sew had 13,
// UPH consumed 7, true remaining = 6 not 0).  Bug fixed in commit 8519f93;
// this rebuild aligns the persisted ledger with what the live edge-detection
// logic in /api/inventory/wip would derive.
//
// Algorithm (mirrors inventory-wip.ts):
//   for each (poId, wipKey) group:
//     sort JCs by sequence ascending
//     for each JC `i`:
//       if jc[i] is completed AND jc[i+1] does NOT exist OR jc[i+1] not completed:
//         => stock sits at jc[i].wipLabel (= wipQty)
//   for UPH JCs whose downstream PACKING is NOT completed:
//     => UPH output sits at jc.wipLabel
//
// Idempotent. Re-running rewrites the same values. Safe to run anytime.
import postgres from 'postgres'
import { readFileSync } from 'fs'
const env = Object.fromEntries(
  readFileSync('.dev.vars', 'utf-8').split('\n')
    .filter((l) => l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')] }))
const sql = postgres(env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, prepare: false, max: 1, idle_timeout: 5 })

const isDone = (status) => status === 'COMPLETED' || status === 'TRANSFERRED'

try {
  console.log('Loading job_cards + production_orders…')
  const jcs = await sql`
    SELECT jc.id, jc.production_order_id, jc.wip_key, jc.wip_label, jc.wip_qty,
           jc.department_code, jc.sequence, jc.status, jc.wip_type,
           po.product_code, po.item_category
      FROM job_cards jc JOIN production_orders po ON po.id = jc.production_order_id
     WHERE po.status IN ('PENDING','IN_PROGRESS','ON_HOLD')
     ORDER BY jc.production_order_id, jc.wip_key, jc.sequence`
  console.log(`  ${jcs.length} JCs in active POs`)

  // group by (poId, wipKey)
  const groups = new Map()
  for (const jc of jcs) {
    const key = `${jc.production_order_id}::${jc.wip_key ?? 'NULL'}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(jc)
  }

  // target state by wipLabel: { stockQty, status, wipType, productCode, deptStatus }
  const target = new Map()
  function bump(label, qty, deptStatus, wipType, productCode, status = 'COMPLETED') {
    if (!label) return
    const cur = target.get(label) ?? { stockQty: 0, status, wipType, productCode, deptStatus }
    cur.stockQty += qty
    cur.deptStatus = deptStatus
    cur.status = status
    if (wipType) cur.wipType = wipType
    if (productCode) cur.productCode = productCode
    target.set(label, cur)
  }

  for (const [, group] of groups) {
    const sorted = group.slice().sort((a, b) => a.sequence - b.sequence)
    for (let i = 0; i < sorted.length; i++) {
      const jc = sorted[i]
      if (!isDone(jc.status)) continue
      if (jc.department_code === 'UPHOLSTERY') {
        const pack = sorted.find((s) => s.department_code === 'PACKING')
        if (pack && isDone(pack.status)) continue  // PACK consumed UPH
        bump(jc.wip_label, jc.wip_qty || 1, 'UPHOLSTERY', shortType(jc.wip_type), jc.product_code)
        continue
      }
      // For producer depts: emit if next-seq sibling is NOT completed
      const next = sorted[i + 1]
      if (next && isDone(next.status)) continue  // next consumed this
      bump(jc.wip_label, jc.wip_qty || 1, jc.department_code, shortType(jc.wip_type), jc.product_code)
    }
  }

  function shortType(t) {
    const u = (t || '').toUpperCase()
    if (u === 'HEADBOARD') return 'HB'
    if (u === 'SOFA_BASE') return 'BASE'
    if (u === 'SOFA_CUSHION') return 'CUSHION'
    if (u === 'SOFA_ARMREST') return 'ARMREST'
    return u || 'WIP'
  }

  console.log(`  ${target.size} wipLabels should have stock`)

  // Compare with current wip_items
  const current = await sql`SELECT id, code, stock_qty, dept_status, status, type, related_product FROM wip_items`
  const byCode = new Map(current.map((r) => [r.code, r]))
  console.log(`  ${current.length} wip_items rows currently in DB`)

  let updates = 0, inserts = 0, zeros = 0

  // Update / insert
  for (const [label, t] of target) {
    const existing = byCode.get(label)
    if (!existing) {
      await sql`INSERT INTO wip_items (id, code, type, related_product, dept_status, stock_qty, status)
                VALUES (${'wip-rebuild-' + Math.random().toString(36).slice(2, 10)},
                        ${label}, ${t.wipType}, ${t.productCode || ''}, ${t.deptStatus},
                        ${t.stockQty}, ${t.status})`
      inserts++
    } else if (existing.stock_qty !== t.stockQty || existing.dept_status !== t.deptStatus) {
      await sql`UPDATE wip_items SET stock_qty = ${t.stockQty}, dept_status = ${t.deptStatus}, status = ${t.status}
                WHERE id = ${existing.id}`
      updates++
    }
  }

  // Zero out wip_items rows whose code is NOT in target (consumed / no longer have stock)
  for (const r of current) {
    if (target.has(r.code)) continue
    if (r.stock_qty !== 0) {
      await sql`UPDATE wip_items SET stock_qty = 0, status = 'IN_PRODUCTION' WHERE id = ${r.id}`
      zeros++
    }
  }

  console.log(`\nDone:`)
  console.log(`  ${inserts} new wip_items rows inserted`)
  console.log(`  ${updates} existing rows updated to match`)
  console.log(`  ${zeros} stale rows zeroed out`)
  console.log(`  ${current.length + inserts - updates - zeros} unchanged`)
} finally { await sql.end() }
