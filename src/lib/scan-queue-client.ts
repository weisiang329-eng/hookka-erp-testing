// ---------------------------------------------------------------------------
// scan-queue-client — small client helpers shared between scan-po-modal and
// scan-supplier-modal. Centralised so the per-doc consume signature stays in
// one place; the modals were copy-pasting the bare fetch wrapper twice and
// would drift the moment one needed a tweak.
// ---------------------------------------------------------------------------

/**
 * Mark a scan-queue row consumed so /api/scan-queue/pending stops surfacing
 * it. When `docIdx` is supplied, marks only that one doc within the row's
 * multi-doc payload (rawJson.docs[] for supplier, rawJson.pos[] for PO).
 * The backend stamps consumed_at only once every doc is accounted for.
 *
 * Best-effort: a failure here just means the resume endpoint may resurface
 * the row next session — the PI/GRN/SO was already saved so the operator
 * can ignore the duplicate. CSRF token is attached automatically by the
 * global window.fetch patch in src/lib/api-client.ts.
 */
export async function postScanQueueConsume(
  rowId: string,
  docIdx?: number,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const body =
    typeof docIdx === "number" && Number.isInteger(docIdx) && docIdx >= 0
      ? JSON.stringify({ docIdx })
      : null;
  try {
    const res = await fetch(
      `/api/scan-queue/${encodeURIComponent(rowId)}/consume`,
      {
        method: "POST",
        credentials: "include",
        ...(body
          ? { headers: { "content-type": "application/json" }, body }
          : {}),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: text.slice(0, 160) };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" };
  }
}

/**
 * Where a scanned document's bytes can be read from.
 *
 * The two scan entry points are COMPLEMENTARY and each is missing exactly what
 * the other has: a direct upload holds the real File but has no queue row,
 * while a card resumed from the queue has the row id and no File. Asking for
 * one of them only is a no-op for half the operators — that is precisely how
 * BUG-2026-08-19-155 lost a month of customer POs on the SALES side, and the
 * same gate stood here on the purchasing side.
 */
export type SourceDocOrigin =
  | { kind: "file"; file: File }
  | { kind: "queue"; rowId: string };

/**
 * Pick whichever source is REAL for this card. The local File wins: it needs no
 * round trip and survives `/consume` NULLing the stored bytes.
 */
export function sourceDocOriginForCard(card: {
  sourceFile?: File | null;
  scanQueueRowId?: string | null;
}): SourceDocOrigin | null {
  if (card.sourceFile && card.sourceFile.size > 0) {
    return { kind: "file", file: card.sourceFile };
  }
  if (card.scanQueueRowId) return { kind: "queue", rowId: card.scanQueueRowId };
  return null;
}

/**
 * Upload a scanned supplier document to /api/files so the resulting PI/GRN can
 * link back to it. Owner ruling 2026-06-30 — for auto-split parents this is the
 * SPECIFIC chunk's PDF (not the original 85-page bundle). Returns the
 * file_assets row id (which the PI POST persists as `sourceDocumentFileId`).
 *
 * Best-effort: failures don't block PI creation — the PI just won't have the
 * "View source document" link. It now logs instead of vanishing: the old bare
 * `catch {}` meant a document that was never saved looked exactly like one that
 * was.
 */
export async function uploadSourceDoc(
  origin: SourceDocOrigin | null,
  resourceType: string,
  resourceId: string,
): Promise<string | null> {
  try {
    if (!origin) throw new Error("no source document held for this card");
    let blob: Blob;
    let filename = "source-document.pdf";
    let contentType = "application/pdf";

    if (origin.kind === "file") {
      blob = origin.file;
      filename = origin.file.name || filename;
      contentType = origin.file.type || contentType;
    } else {
      // Fetch the raw bytes from the scan_queue row.
      const bytesRes = await fetch(
        `/api/scan-queue/${encodeURIComponent(origin.rowId)}/bytes`,
        { credentials: "include" },
      );
      if (!bytesRes.ok) throw new Error(`source bytes HTTP ${bytesRes.status}`);
      blob = await bytesRes.blob();
      // The bytes endpoint sets Content-Disposition with the row's filename.
      const disposition = bytesRes.headers.get("Content-Disposition") || "";
      const m = disposition.match(/filename="?([^";]+)"?/i);
      if (m && m[1]) filename = m[1];
      contentType = bytesRes.headers.get("Content-Type") || contentType;
    }
    if (!blob.size) throw new Error("source bytes empty");

    // 2. Upload to /api/files as a multipart POST.
    const fd = new FormData();
    fd.append("file", new File([blob], filename, { type: contentType }));
    fd.append("resourceType", resourceType);
    fd.append("resourceId", resourceId);
    const upRes = await fetch("/api/files", {
      method: "POST",
      credentials: "include",
      body: fd,
    });
    if (!upRes.ok) throw new Error(`file upload HTTP ${upRes.status}`);
    const upJson = (await upRes.json().catch(() => null)) as {
      success?: boolean;
      data?: { id?: string };
    } | null;
    if (!upJson?.success || !upJson.data?.id) {
      throw new Error("upload returned no file id");
    }
    return upJson.data.id;
  } catch (e) {
    console.error(`[scan] failed to save source document for ${resourceId}:`, e);
    return null;
  }
}
