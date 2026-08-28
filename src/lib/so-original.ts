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


// ---------------------------------------------------------------------------
// One PDF, one download — however many orders come out of it.
//
// A scanned PDF can hold several customer POs, and the create loop calls
// `persistSoOriginal` once per SO. Each call fetched
// `/api/scan-queue/:id/bytes` for itself, so eight POs on one scan meant EIGHT
// parallel downloads of the same multi-megabyte file. Some lost: the failures
// are caught and reported per-PO, and because they happen on the BYTES fetch —
// not the upload — nothing reaches the server's error log either. The
// signature on prod (2026-08-26) was a batch of eight Carress orders where the
// first three kept their original and the last five did not.
//
// The cache is passed IN, not held in this module, so it lives exactly as long
// as one create pass. A module-level Map would outlive the scan it belongs to,
// and a row re-fetched later in the same page would get the earlier answer —
// which is how the existing "empty source bytes" test caught the first
// attempt at this.
//
// It holds the in-flight PROMISE, so calls arriving while the first download
// is still running wait for it instead of starting their own.
// ---------------------------------------------------------------------------
export type QueueBytesCache = Map<string, Promise<Blob>>;

/** A cache for ONE create pass. Make it where the pass starts; drop it after. */
export function newQueueBytesCache(): QueueBytesCache {
  return new Map();
}

function queueBytes(rowId: string, cache?: QueueBytesCache): Promise<Blob> {
  const hit = cache?.get(rowId);
  if (hit) return hit;
  const p = (async () => {
    const res = await fetch(`/api/scan-queue/${encodeURIComponent(rowId)}/bytes`);
    if (!res.ok) throw new Error(`source bytes HTTP ${res.status}`);
    const b = await res.blob();
    // An empty body is a failure, not an answer — never let it be reused.
    if (!b.size) throw new Error("source bytes empty");
    return b;
  })();
  if (cache) {
    cache.set(rowId, p);
    void p.catch(() => cache.delete(rowId));
  }
  return p;
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
  /** Share one across a create pass so a multi-PO scan downloads once. */
  cache?: QueueBytesCache,
): Promise<{ ok: boolean; poNo: string }> {
  const label = poNo || soId;
  try {
    if (!source) throw new Error("no source document held for this PO");
    let blob: Blob;
    if (source.kind === "file") {
      blob = source.file;
    } else {
      blob = await queueBytes(source.rowId, cache);
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
