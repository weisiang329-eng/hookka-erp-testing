// ---------------------------------------------------------------------------
// so-original — keep the customer's original PO document on the SO, for every
// path that creates one.
//
// WHY THIS IS ITS OWN FILE
// The logic used to live inside `scan-po-modal.tsx` (a ~3.5k-line component),
// where the only way to check it was to read it. It was read, it looked right,
// and it saved nothing for a month: the call was gated on `scanQueueRowId`,
// which is `null` on every row that comes from dragging a PDF into the modal.
// A component that big cannot be unit-tested; this file can, and
// `tests/so-original-every-path.test.mjs` exercises the real functions.
//
// THE SHAPE OF THE BUG, because it will recur
// The two scan entry points are COMPLEMENTARY and each is missing exactly what
// the other has:
//
//   direct upload  → holds the real File   · `scanQueueRowId: null`
//   scan queue     → holds the queue row id · File is a ZERO-BYTE placeholder
//
// Any code that asks for one of them only is a no-op for half the operators.
// `originalSourceForRow` exists so that question is asked in one place.
// ---------------------------------------------------------------------------

/** Where the original document can be read from. */
export type OriginalSource =
  | { kind: "file"; file: File }
  | { kind: "queue"; rowId: string };

/** The only two fields of a scan row that matter here. */
export type OriginalSourceRow = {
  file?: File | null;
  scanQueueRowId?: string | null;
};

/**
 * Pick whichever source is REAL for this row.
 *
 * Order matters: the local File needs no round trip and — unlike the stored
 * bytes — is still intact after `/consume` NULLs them.
 */
export function originalSourceForRow(row: OriginalSourceRow): OriginalSource | null {
  if (row.file && row.file.size > 0) return { kind: "file", file: row.file };
  if (row.scanQueueRowId) return { kind: "queue", rowId: row.scanQueueRowId };
  return null;
}

/**
 * Copy the source scan into a durable `/api/files` attachment keyed to the SO
 * (owner 2026-07-15: every SO must keep its original PO on record). That is the
 * same resource the SO's Files section and its "View original" button read.
 *
 * Best-effort: it never throws and never blocks the SO create. It reports
 * failure through the return value so the caller can warn the operator.
 */
export async function persistSoOriginal(
  soId: string,
  source: OriginalSource | null,
  poNo: string | null,
): Promise<{ ok: boolean; poNo: string }> {
  const label = poNo || soId;
  try {
    if (!source) throw new Error("no source document held for this PO");
    let blob: Blob;
    if (source.kind === "file") {
      blob = source.file;
    } else {
      const bres = await fetch(
        `/api/scan-queue/${encodeURIComponent(source.rowId)}/bytes`,
      );
      if (!bres.ok) throw new Error(`source bytes HTTP ${bres.status}`);
      blob = await bres.blob();
    }
    if (!blob.size) throw new Error("source bytes empty");
    const type = blob.type || "application/pdf";
    const ext = type.includes("pdf")
      ? "pdf"
      : type.includes("png")
        ? "png"
        : "jpg";
    const file = new File([blob], `PO-original-${label}.${ext}`, { type });
    const fd = new FormData();
    fd.append("file", file);
    fd.append("resourceType", "SO");
    fd.append("resourceId", soId);
    const up = await fetch("/api/files", { method: "POST", body: fd });
    if (!up.ok) throw new Error(`file upload HTTP ${up.status}`);
    return { ok: true, poNo: label };
  } catch (e) {
    // Do NOT swallow — this exact silent-catch is how the original went
    // unnoticed for a month. Surface it (console + a done-step warning) so a
    // save failure is caught the same day, not by a customer complaint later.
    console.error(`[scan] failed to persist original for ${label}:`, e);
    return { ok: false, poNo: label };
  }
}
