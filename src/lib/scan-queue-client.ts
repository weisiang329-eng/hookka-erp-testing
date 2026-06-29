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
