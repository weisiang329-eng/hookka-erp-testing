# Read-path performance optimization — execution plan (2026-07-13)

Owner ask: make the slow pages fast **without changing any data** — input, output,
and QR-scan completion must stay 100% accurate. Staging-first; each step verified
byte-identical against the live computation before it reaches prod.

## Measured baseline (prod, live, 2026-07-13)
| Endpoint | Cold | Warm | Size | Verdict |
|---|---|---|---|---|
| `/api/delivery-orders` (list) | 27s | 1.6–5s | 141KB | ✅ FIXED — value-map snapshot+SWR (`loadDoValueMapCached`). Re-measured **0.75s**, values byte-identical. |
| `/api/production-orders?include=jobCards` | 25s | 3s | **20MB** | ⏳ remaining — delivery page's full-fetch |
| `/api/delivery-orders/stats` | 4.7s | — | small | ⏳ uses uncached `loadDoValueMap` |
| Sales Orders / Invoices / Production pages | — | ~1s | — | ✅ already fast |

Root cause everywhere: **compute over the whole org on every read** (load all rows
into the Worker + loop in JS + `SELECT *`), no/cold cache. Data volume is small
(~530 POs, ~9k job cards) — this is architectural, not "too much data".

## Iron rule for every step
- **Never touch the write/input path** (order entry, edits, QR-scan → completion).
- **Never change the computation** (same functions, same math) unless a step is
  explicitly a "move-to-SQL" step, and then prove the number byte-identical.
- **Verify before prod:** compare new vs current output on real staging data —
  every DO value, every tab count/row identical; and scan a job card → confirm the
  completion status shows **immediately** (cache invalidation on `job_cards` write).

## Steps (safest → deepest), each shipped to `staging` and verified first

### 1. Cache the DO `/stats` value map (zero data risk)
`/api/delivery-orders/stats` still calls the uncached `loadDoValueMap`. Swap to
`loadDoValueMapCached` (same output, snapshot+SWR — the proven pattern already on
the list). Verify the tab RM totals unchanged.

### 2. Pre-warm the heavy list snapshots (zero data risk)
The `production-orders` snapshot exists but its cold recompute is too slow for the
in-request SWR refresh to finish. Add an internal `CRON_SECRET` endpoint that
recomputes + stores the snapshot for the delivery-page variant on a schedule
(off the request path — a cron has no 30s Worker limit). Users always read the
warm snapshot. **Output identical** — only the *timing* of the recompute moves.
Verify: delivery page cold load drops from ~25s to snapshot-read; data identical.

### 3. Denormalize the DO/PO sales figure (touches writes — extra care)
Store `valueSen` on the row, computed by the SAME `loadDoValueMap`/`loadPoValueMap`
math at write time (DO create/edit) + a nightly rebuild safety net (reuse the
existing nightly-rebuild cron pattern). Reads become a plain SELECT. Verify: every
stored value == the live computation to the cent; nightly rebuild reconciles.

### 4. Move the delivery "Ready-for-DO / Planning / Pending" compute server-side
Today the page ships 20MB of POs+job-cards and joins client-side (freezes the main
thread). Best-practice fix: a dedicated endpoint that runs the SAME predicates
(`poReadyForDelivery`, `poInPlanning`, `pickRelevantUphCards`) server-side and
returns the small final lists. Verify: the three tabs' rows + counts byte-identical
to today's client output, on real staging data (the lesson from the reverted
"PACKING-only" attempt: the gates need UPHOLSTERY + all-dept cards — the server
compute must load exactly what the predicates read).

### 5. Indexes + query-plan pass
Confirm `job_cards(orgId, departmentCode)`, `delivery_orders(orgId, created_at)`,
etc. are indexed so the remaining scans are fast as data grows. Pure speed, zero
output change.

## Definition of done
All slow pages < ~1.5s warm; delivery page no longer freezes navigation; **every
figure byte-identical** to today; QR-scan completion reflects immediately. Verified
on staging, signed off, then merged to prod.
