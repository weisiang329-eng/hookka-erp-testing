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
export async function uploadCncFiles(
  files: File[],
  opts?: { productCode?: string; displayName?: string },
): Promise<string> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);

  // Optional overrides chosen at upload time. When a productCode is supplied,
  // the server files every grouped row under it instead of the filename-parsed
  // code. displayName, when supplied, overrides the auto-derived display name.
  const productCode = opts?.productCode?.trim();
  if (productCode) fd.append("productCode", productCode);
  const displayName = opts?.displayName?.trim();
  if (displayName) fd.append("displayName", displayName);

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

// Editable metadata fields for a CNC template (model re-assignment etc.). Every
// field is optional — only the provided ones are changed server-side.
export type CncTemplateEdit = {
  productCode?: string;
  sizeLabel?: string;
  fabricWidth?: string;
  pieceLabel?: string;
  totalHeight?: string;
  displayName?: string;
};

/**
 * Save edited metadata for one CNC template (PATCH /api/cnc-templates/:id) and
 * return the updated row. Throws with a clear message on failure so the caller
 * can toast it. Does NOT touch the uploaded files — only the model / size /
 * piece / height / display name.
 */
export async function updateCncTemplate(
  id: string,
  edit: CncTemplateEdit,
): Promise<CncTemplate> {
  const res = await fetch(`/api/cnc-templates/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edit),
  });

  let body: { success?: boolean; data?: CncTemplate; error?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Non-JSON — fall through to the status-based message below.
  }

  if (!res.ok || body.success === false || !body.data) {
    throw new Error(body.error || `Save failed (HTTP ${res.status}).`);
  }
  return body.data;
}

// One cutting file (any of the three kinds) attached to a manual create.
export type CncFileSet = Partial<Record<"dgt" | "prj" | "emf", File>>;

// Fields for a manually-created CNC template. productCode + displayName are
// required (the server enforces both). The size parameter is carried in
// `totalHeight` for BOTH categories — it reads as the total height (cm) for a
// bedframe and as the seat size for a sofa; the library UI relabels it per
// category. Files are optional, so the operator can pre-create an empty slot
// and upload the .dgt/.prj/.emf later.
export type CncTemplateCreate = {
  productCode: string;
  displayName: string;
  sizeLabel?: string;
  pieceLabel?: string;
  totalHeight?: string;
  fabricWidth?: string;
  files?: CncFileSet;
};

/**
 * Manually create one CNC template (POST /api/cnc-templates, multipart) and
 * return the created row. Files are optional. Throws a clear message on failure
 * (e.g. a 503 when storage isn't configured) so the caller can toast it.
 */
export async function createCncTemplate(
  input: CncTemplateCreate,
): Promise<CncTemplate> {
  const fd = new FormData();
  fd.append("productCode", input.productCode);
  fd.append("displayName", input.displayName);
  if (input.sizeLabel != null) fd.append("sizeLabel", input.sizeLabel);
  if (input.pieceLabel != null) fd.append("pieceLabel", input.pieceLabel);
  if (input.totalHeight != null) fd.append("totalHeight", input.totalHeight);
  if (input.fabricWidth != null) fd.append("fabricWidth", input.fabricWidth);
  for (const kind of ["dgt", "prj", "emf"] as const) {
    const f = input.files?.[kind];
    if (f && f.size > 0) fd.append(kind, f);
  }

  const res = await fetch("/api/cnc-templates", { method: "POST", body: fd });

  let body: { success?: boolean; data?: CncTemplate; error?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Non-JSON — fall through to the status-based message below.
  }

  if (res.status === 503) {
    throw new Error(
      body.error || "File storage isn't configured yet. Ask an admin to set it up.",
    );
  }
  if (!res.ok || body.success === false || !body.data) {
    throw new Error(body.error || `Create failed (HTTP ${res.status}).`);
  }
  return body.data;
}

/**
 * Delete one CNC template (DELETE /api/cnc-templates/:id). Removes the stored
 * files and the row. Throws a clear message on failure.
 */
export async function deleteCncTemplate(id: string): Promise<void> {
  const res = await fetch(`/api/cnc-templates/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

  let body: { success?: boolean; error?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Non-JSON — fall through to the status-based message below.
  }

  if (!res.ok || body.success === false) {
    throw new Error(body.error || `Delete failed (HTTP ${res.status}).`);
  }
}
