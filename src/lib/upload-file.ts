// ---------------------------------------------------------------------------
// upload-file.ts — hardened client-side upload for /api/files (2026-07-03,
// Phase 2 of the visibility plan).
//
// Every upload surface previously did a bare fetch("/api/files"): no timeout
// (a dead connection spun the button forever), no size pre-check (a 60MB file
// crawled up the weak factory wifi only to be rejected with a raw byte count),
// and success was reported the moment the DB row existed — before anyone had
// confirmed the bytes were actually servable, which is exactly the owner's
// "I uploaded it and then it wouldn't open" trap.
//
// This helper owns those three failure modes. It never throws — callers get
// a discriminated result and decide how to toast.
// ---------------------------------------------------------------------------

export type UploadResult =
  | { ok: true; id: string; verified: boolean }
  | { ok: false; error: string };

const MAX_UPLOAD_MB = 50; // mirror of MAX_UPLOAD_BYTES in src/api/routes/files.ts

export async function uploadFileAsset(opts: {
  file: File;
  resourceType: string;
  resourceId: string;
  /** Abort the upload after this long. Generous for weak factory wifi. */
  timeoutMs?: number;
}): Promise<UploadResult> {
  const { file, resourceType, resourceId, timeoutMs = 180_000 } = opts;

  // Pre-check the size locally — don't spend minutes pushing a file up weak
  // wifi that the server is guaranteed to reject.
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
    return {
      ok: false,
      error: `File is too large (${Math.round(file.size / 1048576)} MB) — maximum is ${MAX_UPLOAD_MB} MB`,
    };
  }

  const fd = new FormData();
  fd.append("file", file);
  fd.append("resourceType", resourceType);
  fd.append("resourceId", resourceId);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch("/api/files", {
      method: "POST",
      body: fd,
      signal: controller.signal,
    });
  } catch (err) {
    return {
      ok: false,
      error:
        (err as Error)?.name === "AbortError"
          ? "Upload timed out — check your connection and try again"
          : "Upload failed — network problem. The file was NOT saved; please try again",
    };
  } finally {
    clearTimeout(timer);
  }

  const j = (await res.json().catch(() => null)) as {
    success?: boolean;
    error?: string;
    data?: { id?: string };
  } | null;
  if (!res.ok || !j?.success || !j.data?.id) {
    return { ok: false, error: j?.error || `Upload failed (${res.status})` };
  }

  const verified = await verifyReadable(j.data.id);
  return { ok: true, id: j.data.id, verified };
}

// Confirm the uploaded bytes are actually servable before claiming success.
// Header-only read: the body is cancelled as soon as the status is known.
// 3 attempts over ~4s; a false return means "row exists but bytes not
// readable yet" — callers surface that as a warning, never a silent success.
async function verifyReadable(fileId: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`/api/files/${fileId}/stream`, {
        headers: { Range: "bytes=0-0" },
      });
      if (res.ok) {
        try {
          await res.body?.cancel();
        } catch {
          /* body already consumed/closed */
        }
        return true;
      }
    } catch {
      /* transient network error — retry */
    }
    await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
  }
  return false;
}
