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
 * Upload a scan-queue row's stored PDF (or image) bytes to /api/files so the
 * resulting PI/GRN can link back to its source supplier document. Owner
 * ruling 2026-06-30 — for auto-split parents, this is the SPECIFIC chunk's
 * PDF (not the original 85-page bundle). Returns the file_assets row id
 * (which the PI POST persists as `sourceDocumentFileId`).
 *
 * Best-effort: failures don't block PI creation — the PI just won't have
 * the "View source document" link surfaced. Caller logs/swallows on null.
 */
export async function uploadScanQueueRowAsSourceDoc(
  rowId: string,
  resourceType: string,
  resourceId: string,
): Promise<string | null> {
  try {
    // 1. Fetch the raw bytes from the scan_queue row.
    const bytesRes = await fetch(
      `/api/scan-queue/${encodeURIComponent(rowId)}/bytes`,
      { credentials: "include" },
    );
    if (!bytesRes.ok) return null;
    const blob = await bytesRes.blob();
    // The bytes endpoint sets Content-Disposition with the row's filename.
    let filename = "source-document.pdf";
    const disposition = bytesRes.headers.get("Content-Disposition") || "";
    const m = disposition.match(/filename="?([^";]+)"?/i);
    if (m && m[1]) filename = m[1];
    const contentType =
      bytesRes.headers.get("Content-Type") || "application/pdf";

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
    if (!upRes.ok) return null;
    const upJson = (await upRes.json().catch(() => null)) as {
      success?: boolean;
      data?: { id?: string };
    } | null;
    return upJson?.success && upJson.data?.id ? upJson.data.id : null;
  } catch {
    return null;
  }
}
