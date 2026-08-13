> **ARCHIVED — HISTORY ONLY. Last had current content 2026-06-26; archived 2026-07-23.**
> This describes work that is finished or a system that has since changed. Its file
> paths, line numbers, counts and open items are as of the date above and were NOT
> re-verified. **Do not use it to decide what the code does today** — read the code, or
> `docs/CODEBASE-MAP.md`. Banner added 2026-08-13; see `docs/archive/README.md`.

# Packing-Sticker QR Scanning + Completion — Handoff Spec

**For:** the developer taking over the packing-sticker scan work.
**Owner intent (Wei Siang, 2026-06-26):** the packing QR/barcode must (a) scan
reliably from BOTH the Worker Portal and a plain phone camera, and (b) follow
the completion + rack rules below exactly. Codes are **always scannable** — there
is **NO time-based expiry** (the "3-day after delivered" idea was DECLINED).

This doc is self-contained: desired behavior → current state → remaining bugs
(with file:line + fix) → the endpoint/file map → the non-negotiable rules.

---

## 1. Desired behavior (the spec)

### Resolving a packing sticker
A packing FG sticker's QR is one of two shapes:
- **`https://<origin>/p/<64-hex token>`** — the public, **no-login** "Assign Rack"
  page. Preferred. Minted at print time.
- **`https://<origin>/worker/scan?op=FG-PACKING&po=<poNo>&p=<n>&t=<m>&pn=<label>`**
  — the **fallback**, used only when the token mint failed at print time. Opens
  the Worker Portal (needs login).

`<origin>` follows the print-time domain, canonicalized so prod's legacy
`hookka-erp-testing.pages.dev` renders as `erp.hookka.com` (see §5). Resolution
is **path-based + domain-agnostic** — old pages.dev stickers still scan.

### Worker Portal scan (logged-in worker)
1. Scan/type → resolve the PO + the ONE PACKING job card (by `pn`/wipLabel).
2. One match → "lookup" card (PO, customer, WIP, size, mins) + a **Complete** button.
3. **A bare scan never auto-completes** — the worker must tap Complete.

### Phone-camera scan (no login)
- `/p/<token>` 1st scan → Assign-Rack page (resolves by the token, NOT poNo, so
  immune to poNo drift). 2nd scan → identical + idempotent (current rack
  pre-selected; re-writing just updates it).
- `/worker/scan` fallback scanned by a phone with no session → Worker Portal
  **login** page. This is why a minted `/p/` token matters for the floor.

### Completion (CONFIRMED CORRECT in code — do NOT "fix" it)
- **The FIRST worker to Complete = the piece IS complete.** It fills PIC1 **and**
  sets `completedAt`; the card flips **COMPLETED** once every piece-slot has a
  PIC1 (a single-piece card completes on the 1st scan).
  → `production-orders.ts` scan-complete, **lines ~7314–7360**.
- **A 2nd different worker = PIC2** — pure **labor attribution** (minutes split
  50/50 at read time). The piece was already complete.
- Same worker re-scans the same slot → no-op (`ALREADY_PIC1/2`, 409).
- A 3rd different worker after both slots full → `PIC_FULL` (the FE shows an
  **amber "Already complete"** card, not a red error, and still offers the rack
  picker). This amber card is NORMAL (the two-person sign-off), not a bug.

### Rack assignment
Assigning a rack (office dropdown / `/p/` scan / worker scan) must, via the ONE
shared writer `applyPackingRack` (`src/api/lib/packing-rack-write.ts`):
- write `job_cards.rackingNumber` (+ mirror to `production_orders`), AND
- mirror **one `rack_items` occupancy row** (so the Warehouse grid shows the
  piece under its rack) — set / move / clear, + recompute `rack_locations.status`.
- The `rack_items` identity (`productName` = description, `notes` = "SO <no>")
  MUST come from the shared `packingPieceIdentity` (`src/api/lib/packing-piece-identity.ts`)
  so the office, `/p/`, and `/r/` rack-scan paths converge on ONE row (no dup).

---

## 2. Current state (shipped to main + staging, 2026-06-25/26)

- ✅ Worker Portal scan resolves a packing sticker; completion logic above is correct.
- ✅ `/p/<token>` resolve is archive-aware (`resolveCard`, public-rack-write.ts) +
  `pickPackingCard` tiers + token re-read (won't print a dead token).
- ✅ Rack assignment → warehouse occupancy (`applyPackingRack` writes `rack_items`).
- ✅ Shared `packingPieceIdentity` locks the rack_items identity across paths.
- ✅ QR/sticker URLs canonicalize the prod fallback origin → `erp.hookka.com`
  (`src/lib/app-origin.ts`; staging/preview/local keep their own origin).
- ✅ FG-sticker print always uses the enriched `/p/` set (no fallback-URL race).
- ✅ **FG-PACKING scan-lookup fallback (just shipped):** when `po=` doesn't match
  exactly, scan-lookup now retries trim/case-insensitive poNo, then resolves via
  `fg_units` (sticker `po` = the unit's stored poNo → its stable `poId` → the
  live PO). → `src/api/routes/worker.ts` scan-lookup (~line 481). This fixes the
  "Not found: FG-PACKING / SO-2604-206-04" when the PO still exists.

---

## 3. Remaining bugs / tasks (DO THESE)

### TASK 1 — Mint robustness so reprints get a `/p/` token even when poNo drifted (HIGH)
**Symptom:** a sticker printed with the `/worker/scan` fallback (because the
mint couldn't resolve the PACKING card) opens the LOGIN page on an external phone.
**Root cause:** `POST /api/production-orders/packing-rack-tokens`
(`src/api/routes/production-orders.ts` ~line 6001) resolves the PACKING card by
`production_orders.poNo IN (...) OR id IN (...)`. If the printed/asked poNo has
drifted (SO edited → line renumbered, trailing space, case), no card → no token →
fallback URL.
**Fix:** mirror §2's scan-lookup recovery into the mint resolve — after the exact
poNo/id match misses, retry trim/case-insensitive poNo, then fall back via
`fg_units` (`SELECT poId FROM fg_units WHERE poNo = ? AND poId IS NOT NULL` → load
that production_order → its PACKING cards). Then `getOrCreateJobCardQrToken` mints
the `/p/` token. Keep it BYTE-IDENTICAL in spirit to the scan-lookup fallback so
the two stay in lock-step. After this, the owner **reprints** the affected
stickers and external-phone scan works.

### TASK 2 — Carry the job-card id on the FG-PACKING sticker (MEDIUM, robustness)
Dept stickers encode `op=<job_card.id>` and are rescued by scan-lookup's
JOIN-job_cards path. The FG-PACKING sticker encodes only `op=FG-PACKING` + `po=`.
**Fix (ADDITIVE — keep `po=`, ADD a param):** in `packingStickerUrl`
(`src/pages/production/index.tsx`) add `&jc=<packing job_card id>` (the card
`pickPackingCard` already resolves in the mint flow). Teach `parseStickerData`
(`src/lib/qr-utils.ts`) to read `jc`, and scan-lookup to resolve by it. This gives
FG-PACKING the same stable fallback dept stickers have. **Shared-artifact change —
verify EVERY consumer (in-app scan, phone deep-link, /p/ mint, `pn=` narrowing)
and that OLD already-printed stickers still resolve.**

### TASK 3 — "Completed row vanishes" inconsistency (MEDIUM)
Some completed rows disappear from the dept sheet instead of staying visible. The
`forceShowCompletedIds` keep-visible allowlist (production/index.tsx, BUG-2026-06-23-004,
commits `baa3a07b`/`0f694524`) covers single + batch completion but has gaps.
**Fix:** find the completion path(s) that don't add to `forceShowCompletedIds` and
add them, so a just-completed row stays visible until reload on EVERY path.

### TASK 4 — Regression tests + BUG-HISTORY
Add a test asserting an FG-PACKING sticker whose poNo drifted still resolves via
the `fg_units` fallback (and, after Task 2, via the jc-id). Log each fix in
`docs/BUG-HISTORY.md` (newest-first).

---

## 4. Endpoint / file map

| Concern | File:area |
|---|---|
| Worker-Portal scan resolve | `src/api/routes/worker.ts` → `GET /scan-lookup` (~395; fallback ~481) |
| Scan complete (PIC1/PIC2) | `src/api/routes/production-orders.ts` scan-complete (~7290–7440) |
| `/p/` resolve + rack write | `src/api/routes/public-rack-write.ts` (`resolveCard`) |
| Rack write (the one writer) | `src/api/lib/packing-rack-write.ts` (`applyPackingRack`) |
| Shared rack identity | `src/api/lib/packing-piece-identity.ts` (`packingPieceIdentity`) |
| `/p/` token mint | `src/api/routes/production-orders.ts` → `POST /packing-rack-tokens` (~6001) |
| `/r/` rack-QR stock-in | `src/api/routes/public-rack-qr.ts` |
| Sticker URL build | `src/pages/production/index.tsx` `packingStickerUrl`; `src/lib/qr-utils.ts` |
| Origin canonicalization | `src/lib/app-origin.ts` (`canonicalizeOrigin` / `appOrigin`) |
| Card resolver (tolerant tiers) | `src/api/lib/packing-card-resolve.ts` (`pickPackingCard`) |
| Sticker payload parse | `src/lib/qr-utils.ts` (`parseStickerData`) |

---

## 5. Non-negotiable rules (READ BEFORE TOUCHING)

- **ADDITIVE, never break existing scans.** The QR/sticker URL scheme is a SHARED
  artifact — any change must keep every consumer (in-app scan, phone camera, `/p/`,
  `/r/`, the office) AND every already-printed sticker working. Add params/fallbacks;
  don't replace.
- **Codes are always-scannable — do NOT add any time-based expiry** (3-day idea
  declined 2026-06-26).
- **Completion = first-scan-completes; PIC2 is labor split.** Don't "fix" it to
  require two PICs.
- **CSRF is global** (`src/lib/api-client.ts` patches `window.fetch`) — never add
  `csrfHeaders()` "because a fetch is missing CSRF"; it isn't.
- **QR origin follows the print site, canonicalized to `erp.hookka.com` on prod;
  staging/preview/local keep their own origin** (so their QRs resolve against their
  own DB).
- **build:strict before every push:** `npx tsc -p tsconfig.app.json --noEmit` AND
  `npx tsc -p tsconfig.json --noEmit` (ignore only the 3 jsbarcode/@zxing errors).
- **New DB columns = snake_case;** read rows dual-keyed `r.camelCase ?? r.snake_case`.
- **Verify live on prod after deploy** (read + write path).

---

## 6. How to reproduce the original bug (for verification)
Owner's case: a packing sticker QR
`erp.hookka.com/worker/scan?op=FG-PACKING&po=SO-2604-206-04&p=1&t=1&pn=Full Product`
→ Worker Portal "Not found: FG-PACKING / SO-2604-206-04". The `po` (SO-2604-206-04)
had drifted from the current `production_orders.poNo`. §2's scan-lookup fallback now
recovers it **if the PO still exists**; if the SO was fully rebuilt (PO gone), the
sticker must be reprinted. Task 1 makes the reprint produce a `/p/` token.
