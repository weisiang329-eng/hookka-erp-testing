# B-Flow — Sticker Identity

Documentation for the experimental sticker-identity flow that lives under
`/production-test` and `/delivery-test`. Kept separate from the main
production flow so business logic can be validated on a staging dataset
without touching live SO / PO records.

If you're looking for the rollback procedure (how to remove B entirely),
see `../B-ROLLBACK.md` in the repo root.

---

## Why a parallel flow exists

The legacy (A) production flow tracks finished-goods identity **per SO
item**: an SO for 3 bedframes produces 3 FG units, each tied back to the
specific SO line. Physical workers on the shop floor don't know which unit
is for which SO when they're upholstering — the upholstery department only
sees "a fabric-cut batch is ready, produce X covers".

That mismatch creates two problems:

1. **No traceability for batch-level decisions.** If a batch of covers is
   returned from upholstery with a defect, A can only flag it at the SO
   level — which is too coarse.
2. **No reliable sticker workflow.** A-flow's sticker is printed late in
   the pipeline (at packing), so QC issues discovered earlier lose their
   chain of evidence.

B-flow introduces an earlier, batch-level identity:

- Stickers are **printed at FG-materialisation time** — as soon as the
  fabric-cut department cuts enough covers for N physical pieces, those
  pieces are assigned a sticker.
- FG units start in **`PENDING_UPHOLSTERY`** status and progress through
  `UPHOLSTERED → PACKED → LOADED → DELIVERED`.
- Each FG carries a **`batchId`** pointer back to the source cut/sew
  batch plus **`scanHistory`** — an append-only log of every
  department scan.

---

## Lifecycle comparison

```
A-flow (legacy):
  PENDING ─────────────────► PACKED ► LOADED ► DELIVERED [► RETURNED]
  (implied, never rendered)

B-flow (sticker):
  PENDING_UPHOLSTERY ► UPHOLSTERED ► PACKED ► LOADED ► DELIVERED [► RETURNED]
  │                   │              │        │        │
  │                   │              │        │        └ sign at customer
  │                   │              │        └ loaded onto lorry
  │                   │              └ packed for dispatch
  │                   └ upholstery scan complete
  └ sticker printed, fabric cover done, awaiting upholstery scan
```

Both lifecycles share the same `FGUnitStatus` union so existing code
compiles for both. A-flow ignores `PENDING_UPHOLSTERY` and `UPHOLSTERED`.
B-flow never emits bare `PENDING`.

---

## Data model additions

B-flow adds the following optional fields to `FGUnit` in
`src/lib/mock-data.ts`. All are optional so A-flow ignores them:

| Field               | Type              | Purpose                                             |
| ------------------- | ----------------- | --------------------------------------------------- |
| `batchId`           | `string?`         | Points back to the source cut/sew batch             |
| `sourcePieceIndex`  | `number?`         | Which piece index inside that batch                 |
| `sourceSlotIndex`   | `number?`         | Which slot inside the piece                         |
| `upholsteredBy`     | `string?`         | Worker ID who completed the upholstery scan         |
| `upholsteredByName` | `string?`         | Denormalised worker name for display                |
| `upholsteredAt`     | `string?` (ISO)   | Timestamp of the upholstery scan                    |
| `doId`              | `string?`         | DO this FG is currently allocated to (cleared on removal) |
| `scanHistory`       | `FGScanEvent[]?`  | Append-only audit trail for every department scan   |

`FGScanEvent` shape:

```ts
interface FGScanEvent {
  timestamp: string;                         // ISO
  deptCode: string;                          // FAB_CUT | FAB_SEW | FOAM | … | UPHOLSTERY | PACKING | LOADING | DELIVERY
  workerId?: string;
  workerName?: string;
  picSlot?: 1 | 2;                           // which PIC slot on that scan
  action: 'COMPLETE' | 'UNDO' | 'SIGN' | 'DISPATCH';
  sourceBatchId?: string;                    // when inherited from a batch piece
  sourcePieceIndex?: number;
  sourceSlotIndex?: number;
  note?: string;
}
```

---

## Routing

The parallel pages live under `/production-test` and `/delivery-test`:

```
/production-test                    # list all production orders (B-flow)
/production-test/:id                # detail — job cards, FG stickers
/production-test/department/:code   # shop-floor queue for ONE department
/production-test/scan               # scan entry (QR → job-card form)
/production-test/fg-scan            # FG sticker scan (status transitions)

/delivery-test                      # list all delivery orders (B-flow)
/delivery-test/:id                  # detail — truck load, sign-off, POD
```

Code mirror — each page is a fresh copy of its A-flow counterpart under
`src/pages/production-test/` and `src/pages/delivery-test/`. When the A
and B pages diverge, only the `-test` copy moves; A stays stable.

---

## API

B-flow routes are prefixed with `/api/test/`:

```
/api/test/production-orders   # routes/production-orders-test.ts
/api/test/fg-units            # routes/fg-units-test.ts
/api/test/delivery-orders     # routes/delivery-orders-test.ts
```

They share no in-memory state with the A endpoints — production-test reads
and writes its own `productionOrdersTest[]` collection. You can corrupt
the test data arbitrarily and the A data is untouched.

---

## Test-flow-specific rules

### Sticker printing

At fabric-cut completion, the API materialises one `FGUnit` row per
physical piece with:

- `status = 'PENDING_UPHOLSTERY'`
- `batchId` pointing at the cut batch
- `sourcePieceIndex` + `sourceSlotIndex` identifying position within batch
- Empty `scanHistory: []` (populated as scans happen)

The sticker PDF (`lib/generate-sticker-pdf.ts`) renders the QR payload,
`shortCode`, product, piece name, and SO/customer.

### Upholstery scan

Worker scans FG QR → the form pre-fills product + SO + piece → they confirm,
the API:

1. Pushes an `FGScanEvent` with `action: 'COMPLETE'`, `deptCode:
   'UPHOLSTERY'`, the worker's ID + name, current timestamp.
2. Sets `upholsteredBy`, `upholsteredByName`, `upholsteredAt`.
3. Transitions status to `UPHOLSTERED`.

### Packing / loading / delivery

Each subsequent scan appends another `FGScanEvent` and advances status:

- `UPHOLSTERED → PACKED` (packing dept scan)
- `PACKED → LOADED` (lorry loading)
- `LOADED → DELIVERED` (customer sign-off)

### Returns

If the customer rejects a unit post-delivery, the API sets status to
`RETURNED` and appends one more `FGScanEvent` with `action: 'UNDO'` and a
note.

### Scan undo

Any department can "undo" its last scan; the API appends another
`FGScanEvent` with `action: 'UNDO'` and regresses the status. History is
never deleted — append-only.

---

## When to promote B → A

B is experimental. Promotion criteria:

1. All A-flow QC + delivery paths have a B equivalent.
2. Stakeholder sign-off on the sticker shape + data captured in
   `scanHistory`.
3. The `production-test` / `delivery-test` routes have run live for at
   least one full SO cycle (SO → PO → FG → DO → Invoice) with no data
   inconsistencies.
4. The batch-level rework case has been demonstrated end-to-end.

Promotion mechanics:

1. Copy `production-test` → `production`, `delivery-test` → `delivery`.
2. Copy API routes over (drop the `-test` suffix and `/api/test/` prefix).
3. Point the in-memory collections at the single-source-of-truth arrays.
4. Delete `production-test` / `delivery-test` pages and test endpoints.
5. Remove `PENDING_UPHOLSTERY` / `UPHOLSTERED` from the A-flow transition
   tables (they become the new canonical states).

---

## Rollback

If B needs to be ripped out entirely (crashes on promotion, unsolvable
bug), the process is mechanical — see `../B-ROLLBACK.md`. Short version:

1. Delete the `-test` page directories and the `-test` route files.
2. Unregister the routes in `src/router.tsx` and `src/api/index.ts`.
3. Strip the B-flow fields from `FGUnit` in `types/index.ts` +
   `mock-data.ts`.
4. Run `npx tsc --noEmit` + `npm run dev` to confirm clean state.

A-flow is untouched so rollback is always safe.

---

## File map

| File                                      | Purpose                                 |
| ----------------------------------------- | --------------------------------------- |
| `src/pages/production-test/index.tsx`     | PO list (B)                             |
| `src/pages/production-test/detail.tsx`    | PO detail + job cards + FG stickers     |
| `src/pages/production-test/department.tsx`| Shop-floor queue                        |
| `src/pages/production-test/scan.tsx`      | QR scan entry                           |
| `src/pages/production-test/fg-scan.tsx`   | FG sticker scan (status transitions)    |
| `src/pages/production-test/tracker.tsx`   | Lineage tracker (A + B unified view)    |
| `src/pages/delivery-test/index.tsx`       | DO list (B)                             |
| `src/pages/delivery-test/detail.tsx`      | DO detail, load sheet, sign-off         |
| `src/api/routes/production-orders-test.ts`| B production-order CRUD                 |
| `src/api/routes/fg-units-test.ts`         | B FG-unit CRUD + scan transitions       |
| `src/api/routes/delivery-orders-test.ts`  | B delivery-order CRUD                   |
| `src/lib/generate-sticker-pdf.ts`         | Sticker PDF (shared A + B)              |
| `src/lib/qr-utils.ts`                     | QR encode/decode + track URL (shared)   |
