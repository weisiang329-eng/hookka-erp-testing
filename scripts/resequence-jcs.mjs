// One-shot: re-compute job_cards.sequence per (production_order_id, wip_key)
// using the same per-wipType chain that bom-wip-breakdown.ts now uses.
//
// Idempotent: re-running rewrites to the same values.
import postgres from 'postgres'
import { readFileSync } from 'fs'

const env = Object.fromEntries(
  readFileSync('.dev.vars', 'utf-8').split('\n')
    .filter((l) => l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')] }),
)
const sql = postgres(env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, prepare: false, max: 1, idle_timeout: 5 })

const PRODUCTION_ORDER_BY_WIP_TYPE = {
  DIVAN:         ["FAB_CUT", "FAB_SEW", "WOOD_CUT", "FRAMING", "WEBBING", "UPHOLSTERY", "PACKING"],
  HEADBOARD:     ["FAB_CUT", "FAB_SEW", "FOAM", "WOOD_CUT", "FRAMING", "WEBBING", "UPHOLSTERY", "PACKING"],
  SOFA_BASE:     ["FAB_CUT", "FAB_SEW", "WOOD_CUT", "FRAMING", "WEBBING", "FOAM", "UPHOLSTERY", "PACKING"],
  SOFA_CUSHION:  ["FAB_CUT", "FAB_SEW", "WOOD_CUT", "FRAMING", "WEBBING", "FOAM", "UPHOLSTERY", "PACKING"],
  SOFA_ARMREST:  ["FAB_CUT", "FAB_SEW", "WOOD_CUT", "FRAMING", "WEBBING", "FOAM", "UPHOLSTERY", "PACKING"],
  SOFA_HEADREST: ["FAB_CUT", "FAB_SEW", "WOOD_CUT", "FRAMING", "WEBBING", "FOAM", "UPHOLSTERY", "PACKING"],
}
const FALLBACK = ["FAB_CUT", "FAB_SEW", "WOOD_CUT", "FOAM", "FRAMING", "WEBBING", "UPHOLSTERY", "PACKING"]

try {
  console.log('Loading all job_cards…')
  const jcs = await sql`
    SELECT id, production_order_id, wip_key, wip_type, department_code, sequence
      FROM job_cards
     ORDER BY production_order_id, wip_key, sequence`
  console.log(`  ${jcs.length} JCs total`)

  // Group by (po_id, wip_key)
  const groups = new Map()
  for (const jc of jcs) {
    const key = `${jc.production_order_id}::${jc.wip_key ?? 'NULL'}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(jc)
  }

  let changed = 0
  let unchanged = 0
  const updates = []  // { id, newSeq }

  for (const [, group] of groups) {
    const wipType = (group[0].wip_type ?? '').toUpperCase()
    const chain = PRODUCTION_ORDER_BY_WIP_TYPE[wipType] ?? FALLBACK
    const idx = (code) => {
      const i = chain.indexOf(code)
      return i === -1 ? chain.length : i
    }
    // Sort by chain order, assign 0..N-1
    const sorted = group.slice().sort((a, b) => {
      const ai = idx(a.department_code)
      const bi = idx(b.department_code)
      if (ai !== bi) return ai - bi
      return a.sequence - b.sequence  // tiebreaker
    })
    for (let i = 0; i < sorted.length; i++) {
      const jc = sorted[i]
      // PACKING is special: legacy data sometimes has seq 99 for FG-only
      // PACKING. Preserve high seq if both are >= 50 (don't normalize legacy
      // FG-only single-PACKING JCs to 0).
      let newSeq = i
      if (jc.department_code === 'PACKING' && jc.sequence >= 50 && sorted.length === 1) {
        newSeq = jc.sequence
      }
      if (jc.sequence !== newSeq) {
        updates.push({ id: jc.id, newSeq, oldSeq: jc.sequence, dept: jc.department_code, wt: wipType })
        changed++
      } else {
        unchanged++
      }
    }
  }

  console.log(`  ${changed} JCs need new sequence, ${unchanged} unchanged`)
  console.log(`\nSample changes (first 10):`)
  for (const u of updates.slice(0, 10)) console.log(`  ${u.dept.padEnd(12)} (${u.wt}): ${u.oldSeq} -> ${u.newSeq}`)

  if (updates.length === 0) { console.log('\nNothing to do.'); await sql.end(); process.exit(0) }

  // Apply in batches
  console.log('\nApplying updates…')
  const batchSize = 500
  for (let i = 0; i < updates.length; i += batchSize) {
    const batch = updates.slice(i, i + batchSize)
    await sql.begin(async (tx) => {
      for (const u of batch) {
        await tx`UPDATE job_cards SET sequence = ${u.newSeq} WHERE id = ${u.id}`
      }
    })
    process.stdout.write(`  ${Math.min(i + batchSize, updates.length)}/${updates.length}\r`)
  }
  console.log(`\nDone. ${updates.length} JCs re-sequenced.`)
} finally {
  await sql.end()
}
