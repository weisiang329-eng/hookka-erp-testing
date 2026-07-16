// ---------------------------------------------------------------------------
// Hookka AI — export / report generation primitives.
//
// Server-side builders for CSV, Excel (xlsx), and PDF documents. Output is
// uploaded to Supabase Storage under the `hookka-files` bucket and surfaced
// to the chat as a short-lived signed download URL (1 hour TTL).
//
// Design rules:
//   * READ-ONLY data path. We never mutate domain tables — only write to
//     storage, and only to the per-org export prefix. The assistant route
//     already gates on SUPER_ADMIN.
//   * Workers-runtime compatible. xlsx (sheetjs) and pdf-lib are both pure
//     JS — no native bindings, no canvas, no DOM. jsPDF is also available
//     but its node build wants Buffer, so server-side we use pdf-lib for
//     the assistant exports. Client-side PDFs (generate-*-pdf.ts) keep
//     using jsPDF unchanged.
//   * Caps: 10_000 rows per export, 5 MB per file. Anything bigger should
//     be a scheduled async job, not a synchronous tool call.
//   * Signed URLs: 1 hour TTL. Never expose generated files publicly —
//     leaking the bucket prefix MUST NOT leak another tenant's exports.
// ---------------------------------------------------------------------------

import * as XLSX from "xlsx";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { putFile, signedDownloadUrl } from "./supabase-storage";
import { winAnsi } from "./unified-do-invoice-pdf";

type StorageEnv = {
  SUPABASE_PROJECT_REF?: string;
  SUPABASE_SERVICE_KEY?: string;
};

export const EXPORT_BUCKET = "hookka-files";
export const EXPORT_PREFIX = "assistant-exports";
export const EXPORT_SIGNED_URL_TTL_SECONDS = 3600; // 1 hour
export const MAX_EXPORT_ROWS = 10_000;
export const MAX_EXPORT_BYTES = 5 * 1024 * 1024; // 5 MB

export type ExportResult = {
  downloadUrl: string;
  filename: string;
  byteSize: number;
  rowCount: number;
  contentType: string;
  storageKey: string;
};

// ---------------------------------------------------------------------------
// Filename hygiene
// ---------------------------------------------------------------------------

const SAFE_FILENAME_RE = /[^a-zA-Z0-9._-]+/g;

/**
 * Strip path separators and other unsafe characters from a caller-supplied
 * filename. Forces a sane extension if missing. Defensive — the storage
 * key already lives under an opaque uuid prefix, so a hostile filename
 * can't escape the org sandbox, but a clean name makes the "Save As..."
 * dialog readable.
 */
export function sanitiseFilename(raw: string, defaultExt: string): string {
  const trimmed = (raw || "").trim();
  const base = trimmed.length > 0 ? trimmed : `export-${Date.now()}`;
  // Replace path separators and other unsafe characters with "-", then
  // collapse runs and trim leading non-alphanumerics (so "../../foo" → "foo"
  // without retaining traversal-looking prefixes).
  let cleaned = base
    .replace(SAFE_FILENAME_RE, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+/, "");
  // Truncate insanely long names — the OS will refuse anything > 255 anyway.
  if (cleaned.length > 120) cleaned = cleaned.slice(0, 120);
  // Ensure correct extension.
  const dot = defaultExt.startsWith(".") ? defaultExt : `.${defaultExt}`;
  if (!cleaned.toLowerCase().endsWith(dot.toLowerCase())) {
    // Strip any other extension first (e.g. ".txt" → "").
    cleaned = cleaned.replace(/\.[a-z0-9]{1,5}$/i, "");
    cleaned += dot;
  }
  if (cleaned.length === 0 || cleaned === dot) {
    cleaned = `export-${Date.now()}${dot}`;
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Escape one CSV cell per RFC 4180. Values containing comma, double-quote,
 * carriage-return, or newline are wrapped in double-quotes; any inner
 * double-quotes are doubled.
 */
export function csvEscapeCell(value: unknown): string {
  if (value == null) return "";
  let s: string;
  if (typeof value === "string") s = value;
  else if (typeof value === "number" || typeof value === "boolean") s = String(value);
  else if (value instanceof Date) s = value.toISOString();
  else s = JSON.stringify(value);
  if (s.length === 0) return "";
  const needsQuote = /[",\r\n]/.test(s);
  if (!needsQuote) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Build a CSV string from an array of row objects. The header row is
 * derived from the union of keys in order of first appearance across the
 * input rows so callers don't need to pre-declare columns. Empty input
 * still emits a single newline so downstream parsers don't choke.
 */
export function buildCsv(rows: Array<Record<string, unknown>>): string {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const headerSet = new Set<string>();
  const headers: string[] = [];
  for (const row of rows) {
    if (row && typeof row === "object") {
      for (const k of Object.keys(row)) {
        if (!headerSet.has(k)) {
          headerSet.add(k);
          headers.push(k);
        }
      }
    }
  }
  const lines: string[] = [];
  lines.push(headers.map((h) => csvEscapeCell(h)).join(","));
  for (const row of rows) {
    const r = (row ?? {}) as Record<string, unknown>;
    lines.push(headers.map((h) => csvEscapeCell(r[h])).join(","));
  }
  // CRLF line endings — Excel on Windows prefers them, and Unix tools
  // tolerate \r\n fine.
  return lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

export type ExcelSheet = {
  name: string;
  rows: Array<Record<string, unknown>>;
  // Optional explicit column order; defaults to first-seen order.
  columns?: string[];
};

const CURRENCY_HINT_RE = /(rm|sen|amount|price|total|subtotal|paid|outstanding|gross|net|cost)/i;
const DATE_HINT_RE = /(date|_at|At$)/;

/**
 * Build an xlsx workbook buffer from a list of sheets. Auto-detects
 * numeric columns and applies a thousands-separator currency format on
 * columns whose name suggests money (rm / sen / amount / total / ...).
 * Date-looking values are formatted as yyyy-mm-dd. Header row is frozen
 * and autofilter is enabled.
 */
export function buildExcelWorkbook(sheets: ExcelSheet[]): Uint8Array {
  const wb = XLSX.utils.book_new();

  for (const sheet of sheets.length > 0 ? sheets : [{ name: "Sheet1", rows: [] }]) {
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    // Resolve header order.
    const headers: string[] =
      sheet.columns && sheet.columns.length > 0
        ? sheet.columns.slice()
        : (() => {
            const seen = new Set<string>();
            const out: string[] = [];
            for (const r of rows) {
              if (r && typeof r === "object") {
                for (const k of Object.keys(r)) {
                  if (!seen.has(k)) {
                    seen.add(k);
                    out.push(k);
                  }
                }
              }
            }
            return out;
          })();

    // Build AOA. Cell-level objects so we can attach number formats.
    const aoa: unknown[][] = [];
    aoa.push(headers.slice());
    for (const r of rows) {
      const row = (r ?? {}) as Record<string, unknown>;
      const cells: unknown[] = headers.map((h) => normaliseCellValue(row[h]));
      aoa.push(cells);
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);

    // Column widths — wider for likely text columns, narrower for ids.
    ws["!cols"] = headers.map((h) => ({
      wch: Math.min(40, Math.max(10, h.length + 4)),
    }));

    // Freeze header row + autofilter the whole range.
    ws["!freeze"] = { xSplit: 0, ySplit: 1 } as unknown as never;
    if (rows.length > 0) {
      ws["!autofilter"] = {
        ref: XLSX.utils.encode_range({
          s: { c: 0, r: 0 },
          e: { c: Math.max(0, headers.length - 1), r: rows.length },
        }),
      };
    }

    // Apply per-column number formats based on header hints.
    for (let c = 0; c < headers.length; c++) {
      const header = headers[c];
      const fmt = pickColumnFormat(header);
      if (!fmt) continue;
      for (let r = 1; r <= rows.length; r++) {
        const addr = XLSX.utils.encode_cell({ c, r });
        const cell = ws[addr];
        if (!cell) continue;
        if (cell.t === "n") {
          cell.z = fmt;
        }
      }
    }

    const sheetName = (sheet.name || "Sheet").slice(0, 31).replace(/[/\\?*[\]]/g, "_");
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  // `array` type returns a Uint8Array — Workers-safe (no Buffer).
  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Uint8Array(buf);
}

function normaliseCellValue(v: unknown): unknown {
  if (v == null) return "-";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "-";
    return v;
  }
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "-";
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === "string") {
    if (v.length === 0) return "-";
    return v;
  }
  return JSON.stringify(v);
}

function pickColumnFormat(header: string): string | null {
  if (CURRENCY_HINT_RE.test(header)) return "$#,##0.00";
  if (DATE_HINT_RE.test(header)) return "yyyy-mm-dd";
  return null;
}

// ---------------------------------------------------------------------------
// PDF — simple_table template
// ---------------------------------------------------------------------------

export type PdfSimpleTable = {
  title: string;
  subtitle?: string;
  columns: string[];
  rows: string[][];
  // Optional totals row, rendered bold below the body.
  totals?: string[];
  // Optional footer note (e.g. generation date, filter description).
  footer?: string;
};

/**
 * Build a single-page (or auto-paginated) PDF with title, subtitle, a
 * tabular body, and a totals row. Uses pdf-lib's StandardFonts so we
 * don't have to embed font files — Helvetica is built in to every PDF
 * reader. Layout is intentionally minimal so it works for any tabular
 * dump the assistant generates.
 */
export async function buildSimpleTablePdf(opts: PdfSimpleTable): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);

  // A4 portrait — 595 × 842 points.
  const pageW = 595;
  const pageH = 842;
  const margin = 36;
  const ink = rgb(0.12, 0.11, 0.11);
  const muted = rgb(0.42, 0.45, 0.48);
  const accent = rgb(0.42, 0.36, 0.2);
  const rule = rgb(0.82, 0.81, 0.78);

  const cols = opts.columns ?? [];
  const rows = opts.rows ?? [];
  const totals = opts.totals;

  const colWidth =
    cols.length > 0 ? (pageW - margin * 2) / cols.length : pageW - margin * 2;

  let page = doc.addPage([pageW, pageH]);
  let y = pageH - margin;

  // Title block. Every drawn string goes through winAnsi so a non-Latin
  // character can't crash this last-resort render either (Helvetica is
  // WinAnsi-only — same guard as the unified generator).
  page.drawText(winAnsi(opts.title), {
    x: margin,
    y: y - 4,
    size: 16,
    font: helvBold,
    color: ink,
  });
  y -= 22;
  if (opts.subtitle) {
    page.drawText(winAnsi(opts.subtitle), {
      x: margin,
      y: y - 4,
      size: 9,
      font: helv,
      color: muted,
    });
    y -= 16;
  }
  // Accent rule
  page.drawRectangle({
    x: margin,
    y: y - 4,
    width: pageW - margin * 2,
    height: 1.2,
    color: accent,
  });
  y -= 16;

  // Header row
  drawTableRow(page, helvBold, cols, margin, y, colWidth, 8.5, ink);
  y -= 6;
  page.drawRectangle({
    x: margin,
    y: y - 1,
    width: pageW - margin * 2,
    height: 0.4,
    color: rule,
  });
  y -= 12;

  // Body
  const rowHeight = 14;
  for (const row of rows) {
    if (y < margin + 40) {
      page = doc.addPage([pageW, pageH]);
      y = pageH - margin;
      drawTableRow(page, helvBold, cols, margin, y, colWidth, 8.5, ink);
      y -= 14;
    }
    drawTableRow(page, helv, row, margin, y, colWidth, 8, ink);
    y -= rowHeight;
  }

  // Totals
  if (totals && totals.length > 0) {
    page.drawRectangle({
      x: margin,
      y: y + 2,
      width: pageW - margin * 2,
      height: 0.4,
      color: rule,
    });
    y -= 4;
    drawTableRow(page, helvBold, totals, margin, y, colWidth, 8.5, ink);
    y -= 16;
  }

  // Footer
  const footerY = margin - 16 < 24 ? 24 : margin - 16;
  page.drawRectangle({
    x: margin,
    y: footerY + 10,
    width: pageW - margin * 2,
    height: 0.3,
    color: rule,
  });
  const footerText =
    opts.footer ??
    `Generated by Hookka AI · ${new Date().toISOString().slice(0, 10)} · Computer-generated document.`;
  page.drawText(winAnsi(footerText), {
    x: margin,
    y: footerY,
    size: 7,
    font: helv,
    color: muted,
  });

  const bytes = await doc.save();
  return bytes;
}

function drawTableRow(
  page: ReturnType<PDFDocument["addPage"]>,
  font: import("pdf-lib").PDFFont,
  cells: string[],
  startX: number,
  y: number,
  colWidth: number,
  size: number,
  color: ReturnType<typeof rgb>,
): void {
  for (let i = 0; i < cells.length; i++) {
    const raw = cells[i] ?? "";
    // winAnsi first (crash-proof), then clip to the column width.
    const text = clipText(font, winAnsi(String(raw)), colWidth - 6, size);
    page.drawText(text, {
      x: startX + i * colWidth + 1,
      y,
      size,
      font,
      color,
    });
  }
}

function clipText(
  font: import("pdf-lib").PDFFont,
  text: string,
  maxWidth: number,
  size: number,
): string {
  if (!text) return "";
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  // Binary chop until it fits, then append an ellipsis.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const candidate = text.slice(0, mid) + "...";
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo) + "...";
}

// ---------------------------------------------------------------------------
// Storage upload + signed URL
// ---------------------------------------------------------------------------

/**
 * Generate a short random id for the storage key. The key is
 * `${EXPORT_PREFIX}/${orgId}/${id}-${filename}`. Random id stops a
 * brute-force walk from guessing other tenants' exports; the orgId in
 * the path is defense-in-depth (Supabase Storage doesn't enforce
 * tenancy by itself).
 */
function uniqueId(): string {
  // crypto.randomUUID is available in Workers and Node 19+.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Upload an export blob to Supabase Storage and return a 1-hour signed
 * URL. Caller is responsible for body size — we enforce a hard 5 MB
 * cap here as defense in depth.
 */
export async function uploadExportAndSign(
  env: StorageEnv,
  orgId: string,
  filename: string,
  body: Uint8Array,
  contentType: string,
): Promise<ExportResult> {
  if (body.byteLength > MAX_EXPORT_BYTES) {
    throw new Error(
      `Export too large (${body.byteLength} bytes; limit ${MAX_EXPORT_BYTES}). Narrow filters or split into multiple files.`,
    );
  }
  if (!orgId || /[^a-zA-Z0-9_-]/.test(orgId)) {
    // Defensive — orgId is set by the tenant middleware from users.orgId.
    // Reject anything that could traverse the bucket prefix.
    throw new Error("Invalid orgId for export upload.");
  }
  const id = uniqueId();
  const safeName = sanitiseFilename(filename, extFromContentType(contentType));
  const key = `${EXPORT_PREFIX}/${orgId}/${id}-${safeName}`;

  await putFile(env, EXPORT_BUCKET, key, body, contentType);
  const url = await signedDownloadUrl(
    env,
    EXPORT_BUCKET,
    key,
    EXPORT_SIGNED_URL_TTL_SECONDS,
  );
  if (!url) {
    // If signing failed (storage not configured), fall through to a stream
    // proxy by returning an internal-only path the chat client can follow.
    // Today the route layer doesn't expose such a proxy for assistant
    // exports, so we error loudly instead of silently producing a 404.
    throw new Error(
      "Failed to produce a signed download URL — Supabase Storage may not be configured for this environment.",
    );
  }

  return {
    downloadUrl: url,
    filename: safeName,
    byteSize: body.byteLength,
    rowCount: 0,
    contentType,
    storageKey: key,
  };
}

function extFromContentType(ct: string): string {
  if (ct.includes("csv")) return "csv";
  if (ct.includes("sheet") || ct.includes("xlsx") || ct.includes("excel")) return "xlsx";
  if (ct.includes("pdf")) return "pdf";
  return "bin";
}

export const CONTENT_TYPES = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
} as const;
