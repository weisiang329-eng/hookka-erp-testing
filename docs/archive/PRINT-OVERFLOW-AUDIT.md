# Print / document overflow audit ("被挤出去")

Owner-reported 2026-06-15: important info (esp. the **QR code** on WIP stickers)
gets squeezed off the printed page when content is long. This doc catalogs
every print surface, its overflow edge cases, severity, and the fix — so we
adjust each case deliberately instead of discovering clipping on real paper.

The rule we're enforcing everywhere: **critical info (QR / barcode / totals /
piece indicator) must occupy a reserved area that variable-length content can
never invade.** Long text clamps (ellipsis / smaller tier); it never pushes the
QR off.

---

## Severity table

| Surface | File | Risk | Failure mode |
|---|---|---|---|
| **WIP / job-card sticker** | `src/lib/generate-sticker-pdf.ts`, `src/pages/production/index.tsx` (#batch-jobcard-print) | **HIGH — live bug** | Info grid has no max-height → long Model / WIP / Notes / customer push the QR + piece indicator off the bottom; printer clips them |
| **FG / packing sticker** | same files (#batch-fg-print, portrait 100×150) | **HIGH** | Same: QR pinned at a fixed Y, info above grows unbounded → overlap / clip |
| **DO totals footer (planned breakdown)** | `src/lib/generate-do-pdf.ts` | **HIGH (preventive)** | Grand breakdown renders in the 42mm Quantity cell with `overflow:visible`; adding repaired components ("+ 1 Back Cushion") spills off the right edge |
| **DO per-line repair note (planned)** | `generate-do-pdf.ts` `describe()` | MEDIUM | "维修:只修 X" embedded in description grows row height; many lines reduce items/page |
| **Production schedule — Barcode column** | `src/pages/production/index.tsx` `handlePrintSchedule` | MEDIUM | A long job-card id makes the Code 128 wider than the 182px cap → image scaled down (may not scan) |
| **Print Report (HTML, employee tabs)** | `src/lib/print-report.ts` | MEDIUM | Browser auto-layout, no fixed widths → a long free-text field can overflow |
| Invoice | `generate-invoice-pdf.ts` | LOW | Explicit widths + `rowPageBreak:"avoid"`; safe |
| Delivery Order (current) | `generate-do-pdf.ts` | LOW | Explicit widths; QR has a page-break guard; safe until the planned footer change |
| Consignment Note + CN packing list | `generate-cn-pdf.ts`, `cn-packing-lists.ts` | LOW | Mirrors DO discipline; safe |
| PO / SO / CO / Quotation / Debit-Credit / Payslip / GRN / Statement / Packing List | `generate-*-pdf.ts` | LOW | All use jsPDF autoTable with explicit `cellWidth` + `rowPageBreak:"avoid"` |

---

## Detailed edge cases + fixes

### 1. WIP / FG sticker — the QR squeeze-out (P1, live)

**Root cause.** The QR sits at a fixed position (PDF: `qrY = ph - qrSize - 14`;
HTML: a `mt-auto` footer). The info block above it (PO / Model / WIP / Size /
Colour / Gap / Divan / Leg / Notes) has **no max-height**, and the WIP label can
wrap to 3 lines. When the fields are tall, they grow down into / past the QR's
reserved Y, so the printer clips the QR + the piece indicator ("DIVAN 2/3").

**Edge cases that trigger it**
- Long Model code (variant-heavy, e.g. `2008(A)-(HB STRAIGHT)-(K)`)
- WIP label wrapping (e.g. `8" Divan-Queen w/ Extended Headrest`)
- Long Notes / special-order text
- Long hub / customer name in the header

**Fix.** Split the sticker into a **fixed-height footer band** (QR + piece
indicator) and a **clamped body** above it:
- HTML: the body gets `max-height` + `overflow:hidden`; long values get
  `text-overflow:ellipsis` / `white-space:nowrap` (or a smaller font tier).
- PDF: stop the info loop at a `maxInfoY` that leaves the QR band free; truncate
  any value whose `splitTextToSize` returns >1 line with an ellipsis.

Result: the QR + "2/3" always print; only the least-important long text trims.

### 2. DO totals footer — must not spill (P1 for the breakdown feature)

**Constraint for the compartment-aware breakdown we agreed to add:** the
grand-breakdown string lands in the 42mm Quantity cell with `overflow:visible`,
so `2 HB + 2 DIVAN + 1 SOFA + 1 BACK CUSHION` would print off the page.

**Fix (do this AS PART of the breakdown feature):** move the grand totals out of
the table cell into a **full-width totals block** drawn below the table
(`doc.lastAutoTable.finalY + n`), spanning the full 182mm. Per-line: keep the
"维修:只修 X" note short and clamp the description to 3 lines.

### 3. Production schedule — Barcode column width

The Code 128 image is capped at `max-width:182px`; a long job-card id generates
a wider barcode that then scales down and may not scan. Caption already wraps.
**Fix:** add `min-width` to keep it scannable, or widen the `.bc` cell; verify on
a real print at the longest id.

### 4. Print Report (HTML) — employee tables

Non-transactional, but wide free-text columns can overflow. **Fix:** add
`table-layout:fixed` + per-column widths in `print-report.ts`.

---

## Fix status

- [x] **P1** WIP/FG sticker — long fields now single-line truncate (HTML: all
      sticker value rows; PDF: clamp landscape WIP/customer to fit width + cap
      portrait WIP to 3 lines) so the QR + piece indicator are never pushed off
- [ ] **P1** DO totals → full-width block (bundle with the compartment breakdown)
- [ ] **P2** Barcode column min-width / scannability check
- [ ] **P3** Print-report `table-layout:fixed`
- [x] Audit complete — invoice / DO / CN / PO / SO / CO / quotation / payslip /
      GRN / statement confirmed safe (explicit widths + page-break guards)

## Regression checklist (run before shipping any print change)

- Longest realistic Model + WIP + Notes on a sticker → QR + piece indicator still print
- DO with a long product name + a partial-repair line → totals don't spill, description clamps
- Production schedule with the Barcode column on the longest job-card id → scans off paper
- Multi-page DO → header repeats, totals not orphaned
