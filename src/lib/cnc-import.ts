// ---------------------------------------------------------------------------
// Shared bulk-import helper for CNC cutting templates.
//
// Used by both the library page (src/pages/cnc-templates.tsx) and the
// per-product panel (src/components/cnc/CncTemplatePanel.tsx). POSTs the chosen
// files as multipart `files` to /api/cnc-templates/import. The server parses
// each filename into product / size / fabric width / piece — the operator just
// picks the .dgt / .prj / .emf files.
//
// Lives in its own module (not in the page) so React Fast Refresh stays happy:
// a page file may only export its component, not extra functions.
// ---------------------------------------------------------------------------
import type { CncTemplate } from "@/components/cnc/CncTemplatePanel";

// Shape returned by POST /api/cnc-templates/import.
export type CncImportResponse = {
  success?: boolean;
  imported?: number;
  files?: number;
  rows?: CncTemplate[];
  error?: string;
};

/**
 * Upload one or more cutting files in a single bulk-import request and return a
 * human-readable result message (e.g. "Imported 3 templates from 5 files.").
 *
 * - Surfaces a clear, operator-friendly message on a 503 (storage not set up).
 * - Throws on any other failure so the caller can toast the error.
 */
export async function uploadCncFiles(files: File[]): Promise<string> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);

  const res = await fetch("/api/cnc-templates/import", {
    method: "POST",
    body: fd,
  });

  let body: CncImportResponse = {};
  try {
    body = (await res.json()) as CncImportResponse;
  } catch {
    // Non-JSON response — fall through to the status-based messages below.
  }

  if (res.status === 503) {
    throw new Error(
      body.error || "File storage isn't configured yet. Ask an admin to set it up.",
    );
  }
  if (!res.ok || body.success === false) {
    throw new Error(body.error || `Upload failed (HTTP ${res.status}).`);
  }

  const imported = body.imported ?? body.rows?.length ?? 0;
  const fileCount = body.files ?? files.length;
  return `Imported ${imported} template${imported === 1 ? "" : "s"} from ${fileCount} file${fileCount === 1 ? "" : "s"}.`;
}
