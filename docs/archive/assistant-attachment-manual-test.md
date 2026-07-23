# Hookka AI — attachment manual test plan

Companion to the automated suite in
`tests/assistant-attachments.test.mjs`. These steps exercise the parts the
unit tests cannot reach: the vision model itself, the slide-over UI, the
audit row, and the round-trip of a real photo / spreadsheet through
production.

Tracked by **FEAT-2026-05-30-008** in `docs/BUG-HISTORY.md`.

---

## Prereqs

- Logged in as a `SUPER_ADMIN` (the assistant route is role-gated).
- A real prod or staging deploy of the `assistant-file-upload-vision`
  branch — Anthropic vision is not stubbed in dev.
- A test image with a Houzs PO number visible. Suggested:
  print `PO-009003` on a piece of paper with the Houzs logo, take a
  phone photo.
- A test CSV. Suggested content:
  ```csv
  PO Number,Customer,Date
  PO-009003,Houzs Century,2026-05-12
  PO-008654,Carress,2026-05-08
  PO-999999,Unknown,2026-04-01
  ```
- A test `.xlsx` — same columns as the CSV.
- A test PDF — anything readable (e.g. a sample invoice).

---

## 1. UI smoke

1. Open the floating chat button → slide-over opens.
2. The paperclip button is to the left of the textarea.
3. Click paperclip → OS file picker opens, filtered to
   images / PDF / CSV / XLS / XLSX.
4. Pick 1 image — a chip appears above the textarea with the filename,
   a 7x7 thumbnail, and a size in KB. An X button removes it.
5. Pick 4 files at once. Only the first 3 should appear as chips. An
   error toast (or the inline error slot) should read
   "max 3 files per message".
6. Try to pick a 20 MB image. UI shows error
   `"<name>" is over 10 MB — pick a smaller file.`
7. With at least one chip present and the textarea empty, the Send
   button is enabled.

## 2. Image vision happy path (the big one)

1. Compose: attach the Houzs PO photo, leave the textarea blank, press
   Send.
2. The user message bubble shows the attachment chip with thumbnail.
3. The assistant streams a description: "I can see a Houzs Century PO
   numbered PO-009003 for…". It MUST extract the number from the
   photo.
4. The assistant should then call `smart_lookup` (or `analyze_image`,
   which fans out to `smart_lookup`) — a `Looking up` chip appears,
   then `Used` once the result returns.
5. The final answer should reference the matched Sales Order with the
   `companySOId` (e.g. SO-2605-051), customer name, total, and a
   short summary.
6. Refresh the audit-events page (`/admin/audit`) and confirm:
   - One row with `resource = "assistant-attachment"`,
     `action = "upload"`.
   - At least one row with `resource = "assistant-tool"`,
     `action = "analyze_image"` or `"smart_lookup"`.

## 3. CSV ingest + cross-check

1. Compose: attach the test CSV, ask
   `"Are these 3 customer POs already in our system?"`.
2. Assistant should:
   - Acknowledge it sees a CSV with 3 rows and the column `PO Number`.
   - Call `match_uploaded_data_to_hookka` with
     `lookupColumn = "PO Number"`.
   - Reply with a per-row breakdown:
     * `PO-009003` → matched → SO `SO-2605-...`, customer Houzs.
     * `PO-008654` → matched (or not, depending on data).
     * `PO-999999` → not found.
3. Confirm the model does NOT invent matches for `PO-999999`.

## 4. Excel ingest summary

1. Compose: attach the `.xlsx`, ask `"Summarise this file."`.
2. Assistant calls `parse_spreadsheet` and replies with sheet name,
   column list, and a row preview.
3. If the workbook has multiple sheets, each one is summarised.

## 5. PDF document handling

1. Compose: attach the test PDF, ask `"What is this?"`.
2. Assistant should describe the PDF content (vendor, invoice number,
   date) without complaint. PDFs are forwarded to Anthropic via the
   `document` content block (no local OCR), so no `pdf-parse` errors
   should ever appear.

## 6. Failure paths

- Attach a `.bat` renamed to `.csv` — uploads, but the parser strips
  it because of the file's actual extension. Confirm the assistant
  receives "Rejected files: …".
- Attach a corrupted .xlsx (one byte: `00`). Confirm the rejection
  surfaces in the system note and the assistant tells the user the
  file couldn't be parsed.
- Disconnect network mid-stream. The Stop button cancels cleanly,
  abort error is shown.

## 7. Security guardrails

- Visit `/admin/audit`, filter by `resource = "assistant-attachment"`.
  Verify the audit row contains ONLY filename, kind, size — no body.
- Open the request in the browser devtools Network tab. Confirm the
  base64 payload is sent as `application/json` over HTTPS only (no
  query-string upload).
- Confirm a non-SUPER_ADMIN role gets a 403 from `/api/assistant/chat`
  even when attachments are present.

## 8. Performance

- Single 8 MB JPEG: end-to-end first-token latency < 5s.
- 3 small CSVs (< 100 KB total): < 2s to first token.
- 10 MB PDF: < 10s to first token.

---

## Known limits

- Image media types accepted by Anthropic: jpeg, png, gif, webp. HEIC
  from iPhone needs to be re-saved as JPEG before sending.
- PDFs over 32 MB / 100 pages will be rejected by Anthropic's
  `pdfs-2024-09-25` beta — the route surfaces the error to the user.
- Extracted-text cap is 50 KB per spreadsheet; bigger files come
  through truncated. `match_uploaded_data_to_hookka` still has access
  to all rows server-side, capped at 200 lookups per call.
