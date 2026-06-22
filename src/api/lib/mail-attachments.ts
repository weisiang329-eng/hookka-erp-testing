// ---------------------------------------------------------------------------
// Mail Center compose — outbound attachment validation (PURE helpers).
//
// The POST /api/mail-center/compose route sends SYNCHRONOUSLY via sendMail and
// BYPASSES the email outbox (lib/email-outbox.ts), so the outbox's
// MAX_ATTACHMENT_TOTAL_BYTES guard does NOT protect it. This route therefore
// owns its own cap, exactly like routes/delivery-orders.ts does for the
// customer-notice PDFs (decoded-bytes 5 MB cap, ~4997).
//
// These limits are the SINGLE SOURCE OF TRUTH and are MIRRORED on the frontend
// (src/pages/mail-center/compose.tsx) so the operator is rejected at the Save
// handler with the SAME error the server would return (project rule:
// "frontend+backend validation unified"). If you change a number here, change
// it there too.
//
// No DB, no network — just shape + size + extension checks, so this is unit
// testable (tests/mail-attachments.test.mjs).
// ---------------------------------------------------------------------------

// Allow images + PDF only (the compose <input> sets accept="image/*,application/pdf").
export const MAIL_ATTACH_MAX_COUNT = 10;
export const MAIL_ATTACH_MAX_TOTAL_BYTES = 5 * 1024 * 1024; // 5 MB decoded
export const MAIL_ATTACH_ALLOWED_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "heic",
  "heif",
  "pdf",
] as const;

export interface MailAttachmentInput {
  filename?: string;
  contentBase64?: string;
}

export interface MailAttachmentValidationResult {
  ok: boolean;
  // Human-readable, English. Used verbatim in the 400 body / inline FE error.
  error?: string;
  // Total decoded byte count across all attachments (handy for logging).
  totalDecodedBytes: number;
}

// Decoded binary size of a base64 string WITHOUT decoding it: each 4 base64
// chars carry 3 bytes, minus 1 per '=' pad char. Mirrors delivery-orders.ts's
// `Math.floor(pdfBase64.length * 0.75)` estimate but exact enough for the cap.
export function decodedBase64Bytes(contentBase64: string): number {
  const s = (contentBase64 ?? "").trim();
  if (s.length === 0) return 0;
  const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - padding;
}

function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

export function isAllowedMailAttachment(filename: string): boolean {
  const ext = fileExtension((filename ?? "").trim());
  return (MAIL_ATTACH_ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
}

// Validate the whole batch the way the route must: count cap, per-extension
// allow-list, and a COMBINED decoded-size cap. Returns a single English error
// for the first violation (interactive path → reject clearly, don't drop).
export function validateMailAttachments(
  attachments: MailAttachmentInput[] | undefined,
): MailAttachmentValidationResult {
  const list = attachments ?? [];
  if (list.length === 0) return { ok: true, totalDecodedBytes: 0 };

  if (list.length > MAIL_ATTACH_MAX_COUNT) {
    return {
      ok: false,
      error: `You can attach at most ${MAIL_ATTACH_MAX_COUNT} files.`,
      totalDecodedBytes: 0,
    };
  }

  let total = 0;
  for (const a of list) {
    const filename = (a?.filename ?? "").trim();
    const contentBase64 = (a?.contentBase64 ?? "").trim();
    if (!filename || !contentBase64) {
      return {
        ok: false,
        error: "Each attachment needs a filename and file content.",
        totalDecodedBytes: total,
      };
    }
    if (!isAllowedMailAttachment(filename)) {
      return {
        ok: false,
        error: `"${filename}" is not an allowed type. Only images and PDF files can be attached.`,
        totalDecodedBytes: total,
      };
    }
    total += decodedBase64Bytes(contentBase64);
  }

  if (total > MAIL_ATTACH_MAX_TOTAL_BYTES) {
    return {
      ok: false,
      error: "Attachments exceed the 5 MB limit.",
      totalDecodedBytes: total,
    };
  }

  return { ok: true, totalDecodedBytes: total };
}
