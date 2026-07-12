// ---------------------------------------------------------------------------
// Hookka AI — attachment ingest helpers.
//
// Wei Siang drops photos / Excel / PDF / CSV into the chat and expects the
// assistant to understand them in Hookka context — read a paper PO photo
// and find the matching Sales Order, ingest an Excel of Customer POs and
// say which ones we already have, etc.
//
// What lives here:
//   1. Strict MIME / extension allow-list (rejects .exe / .bat / .ps1 etc.)
//   2. Size guardrails (10 MB per file, 5 files per message)
//   3. Pure parsers:
//        - Image     → returns as-is (the model does vision directly)
//        - PDF       → returns as-is to Anthropic's document content block
//                      (Anthropic supports PDFs natively up to 32MB / 100p)
//        - .xlsx/.xls → SheetJS `xlsx` → JSON rows per sheet
//        - .csv      → native string splitter (RFC 4180-ish)
//
// Cloudflare Workers compatibility notes:
//   - `xlsx` (SheetJS) is pure-JS and works in Workers — already in deps.
//   - `pdf-parse` is NODE-ONLY (depends on `fs`, `Buffer.from(file)`). We
//     do NOT use it. Instead we use Anthropic's native document content
//     block (`type: "document", source: { type: "base64", media_type: "application/pdf" }`)
//     which Claude Sonnet handles end-to-end. The model gets the actual
//     PDF bytes, not extracted text — better accuracy on tables, logos,
//     handwritten notes.
//   - For CSV we don't pull a library — a hand-rolled splitter handles the
//     99% case (RFC 4180 quoted fields, escaped quotes).
// ---------------------------------------------------------------------------

import type { AnthropicContentBlock } from "./anthropic-client";

// ---------------------------------------------------------------------------
// Limits and allow-lists
// ---------------------------------------------------------------------------

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB per file
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_EXTRACTED_TEXT_BYTES = 50 * 1024; // 50 KB cap per file

// Allow-listed MIME types. Anything else is rejected at intake.
const ALLOWED_MIME = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/csv",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

// Belt-and-braces extension block-list. Even if the operator/browser sets
// a benign MIME type, names ending in these are dropped — protects against
// the "double-extension" trick (foo.csv.exe).
const BLOCKED_EXTENSIONS = new Set<string>([
  ".exe",
  ".bat",
  ".cmd",
  ".com",
  ".js",
  ".mjs",
  ".cjs",
  ".vbs",
  ".vbe",
  ".ps1",
  ".sh",
  ".jar",
  ".scr",
  ".msi",
  ".dll",
  ".app",
  ".dmg",
  ".pkg",
]);

export type AttachmentKind = "image" | "pdf" | "spreadsheet" | "csv" | "text";

export type IncomingAttachment = {
  /** Original filename as supplied by the browser. */
  name: string;
  /** MIME type as supplied by the browser. */
  mediaType: string;
  /** Base64-encoded bytes. */
  base64: string;
};

export type AttachmentRejection = {
  name: string;
  reason: string;
};

export type ParsedAttachment = {
  /** Stable in-message id — referenced by tools (e.g. analyze_image). */
  id: string;
  /** Display name shown to the model in the system note. */
  name: string;
  mediaType: string;
  kind: AttachmentKind;
  sizeBytes: number;
  /**
   * Anthropic content block(s) representing this file. For images and PDFs
   * this is a single `image` / `document` block. For spreadsheets/CSV it's
   * a `text` block containing the JSON-serialised rows (capped at
   * MAX_EXTRACTED_TEXT_BYTES).
   */
  blocks: AnthropicContentBlock[];
  /** For spreadsheets/CSV: structured rows that downstream tools can fetch. */
  parsedRows?: ParsedSpreadsheet;
  /** Truncation flag — true when the extracted text exceeded the budget. */
  truncated?: boolean;
};

export type ParsedSheet = {
  name: string;
  rowCount: number;
  /** Header row — first non-empty row of the sheet. May be empty. */
  headers: string[];
  /** Body rows. Each row is an array aligned to headers (or raw if no header detected). */
  rows: Record<string, unknown>[];
};

export type ParsedSpreadsheet = {
  sheets: ParsedSheet[];
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx < 0) return "";
  return name.slice(idx).toLowerCase();
}

function decodeBase64ToBytes(b64: string): Uint8Array {
  // atob is available in Cloudflare Workers and in Node 18+. We strip any
  // data URL prefix so the same helper works whether the browser sent us
  // raw base64 or a `data:...` URL.
  const cleaned = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bin = atob(cleaned);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function kindFor(mediaType: string, name: string): AttachmentKind | null {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType === "application/pdf") return "pdf";
  if (
    mediaType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mediaType === "application/vnd.ms-excel" ||
    /\.xlsx?$/i.test(name)
  ) {
    return "spreadsheet";
  }
  if (mediaType === "text/csv" || /\.csv$/i.test(name)) return "csv";
  if (mediaType === "text/plain" || /\.txt$/i.test(name)) return "text";
  return null;
}

export function validateIncoming(
  attachment: IncomingAttachment,
): { ok: true } | { ok: false; reason: string } {
  if (!attachment.name || typeof attachment.name !== "string") {
    return { ok: false, reason: "missing filename" };
  }
  if (BLOCKED_EXTENSIONS.has(extensionOf(attachment.name))) {
    return { ok: false, reason: "executable file types are not allowed" };
  }
  if (!attachment.mediaType || !ALLOWED_MIME.has(attachment.mediaType)) {
    // Fall through if extension hints at an allowed kind (browsers
    // sometimes send application/octet-stream for .csv).
    const ext = extensionOf(attachment.name);
    const hinted = ext === ".csv" || ext === ".xlsx" || ext === ".xls";
    if (!hinted) {
      return { ok: false, reason: `unsupported type: ${attachment.mediaType || "unknown"}` };
    }
  }
  // Base64 inflates by ~33% — quick byte-budget check before we even decode.
  const approxBytes = Math.floor((attachment.base64.length * 3) / 4);
  if (approxBytes > MAX_ATTACHMENT_BYTES) {
    return { ok: false, reason: `file too large (max 10 MB)` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// CSV parser — RFC 4180-ish. Handles quoted fields, escaped quotes,
// embedded newlines. Returns an array of arrays. The caller picks the
// first row as headers.
// ---------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      cur.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      // swallow — handled by \n
      i++;
      continue;
    }
    if (ch === "\n") {
      cur.push(field);
      rows.push(cur);
      cur = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Trailing field / row
  if (field.length > 0 || cur.length > 0) {
    cur.push(field);
    rows.push(cur);
  }
  // Drop trailing empty row caused by a final newline.
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === "")) {
    rows.pop();
  }
  return rows;
}

function csvRowsToObjects(rows: string[][]): ParsedSheet {
  if (rows.length === 0) {
    return { name: "csv", rowCount: 0, headers: [], rows: [] };
  }
  const headers = rows[0].map((h, idx) => (h && h.trim()) || `col_${idx + 1}`);
  const body: Record<string, unknown>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row: Record<string, unknown> = {};
    for (let c = 0; c < headers.length; c++) {
      row[headers[c]] = rows[r][c] ?? "";
    }
    body.push(row);
  }
  return { name: "csv", rowCount: body.length, headers, rows: body };
}

// ---------------------------------------------------------------------------
// Excel parser — dynamic-imports SheetJS so the cold-start cost only hits
// when an Excel file actually shows up. Returns rows per sheet.
// ---------------------------------------------------------------------------

export async function parseExcelBytes(
  bytes: Uint8Array,
): Promise<ParsedSpreadsheet> {
  // Dynamic import keeps the ~420KB lib out of the cold-start path when no
  // attachment is in play.
  const XLSX = await import("xlsx");
  const wb = XLSX.read(bytes, { type: "array" });
  const sheets: ParsedSheet[] = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    // defval:"" gives every column a value even when blank — keeps row
    // shapes consistent so downstream matching doesn't trip on missing
    // keys. raw:false coerces dates / numbers to strings, which is what
    // the model wants for display.
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      raw: false,
    });
    const stringAoa: string[][] = aoa.map((row) =>
      (Array.isArray(row) ? row : []).map((cell) =>
        cell == null ? "" : String(cell),
      ),
    );
    const parsed = csvRowsToObjects(stringAoa);
    parsed.name = name;
    sheets.push(parsed);
  }
  return { sheets };
}

// ---------------------------------------------------------------------------
// Truncation helper — when the structured-row dump exceeds the budget we
// cut it off and append a marker so the model knows there's more.
// ---------------------------------------------------------------------------

function truncateForModel(
  payload: string,
): { text: string; truncated: boolean } {
  if (payload.length <= MAX_EXTRACTED_TEXT_BYTES) {
    return { text: payload, truncated: false };
  }
  const cut = payload.slice(0, MAX_EXTRACTED_TEXT_BYTES);
  return {
    text:
      cut +
      `\n\n[truncated — file content exceeded ${MAX_EXTRACTED_TEXT_BYTES} bytes; only the first portion is shown]`,
    truncated: true,
  };
}

// ---------------------------------------------------------------------------
// Parse a single attachment into model-ready content blocks. Throws on
// internal parser failure (caller catches and emits a friendly error).
// ---------------------------------------------------------------------------

export async function parseAttachment(
  attachment: IncomingAttachment,
  id: string,
): Promise<ParsedAttachment> {
  const kind = kindFor(attachment.mediaType, attachment.name);
  if (!kind) {
    throw new Error(`unsupported attachment kind: ${attachment.mediaType}`);
  }

  const bytes = decodeBase64ToBytes(attachment.base64);
  const sizeBytes = bytes.byteLength;

  if (kind === "image") {
    // Anthropic vision content block. base64 form — `media_type` must
    // match Anthropic's supported list (image/jpeg|png|gif|webp).
    const mediaType =
      attachment.mediaType === "image/jpg" ? "image/jpeg" : attachment.mediaType;
    const blocks: AnthropicContentBlock[] = [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: attachment.base64.includes(",")
            ? attachment.base64.slice(attachment.base64.indexOf(",") + 1)
            : attachment.base64,
        },
      },
    ];
    return { id, name: attachment.name, mediaType, kind, sizeBytes, blocks };
  }

  if (kind === "pdf") {
    // Anthropic supports PDFs as a "document" content block. Better than
    // OCR-ing in Worker because we don't have a Workers-compatible PDF
    // text extractor (`pdf-parse` is Node-only). Claude handles tables,
    // logos, handwriting end-to-end.
    const blocks: AnthropicContentBlock[] = [
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: attachment.base64.includes(",")
            ? attachment.base64.slice(attachment.base64.indexOf(",") + 1)
            : attachment.base64,
        },
      },
    ];
    return {
      id,
      name: attachment.name,
      mediaType: "application/pdf",
      kind,
      sizeBytes,
      blocks,
    };
  }

  if (kind === "spreadsheet") {
    const parsed = await parseExcelBytes(bytes);
    const summary = stringifyForModel(attachment.name, parsed);
    const { text, truncated } = truncateForModel(summary);
    return {
      id,
      name: attachment.name,
      mediaType: attachment.mediaType,
      kind,
      sizeBytes,
      parsedRows: parsed,
      truncated,
      blocks: [{ type: "text", text }],
    };
  }

  if (kind === "csv" || kind === "text") {
    const textRaw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (kind === "csv") {
      const aoa = parseCsv(textRaw);
      const sheet = csvRowsToObjects(aoa);
      const parsed: ParsedSpreadsheet = { sheets: [sheet] };
      const summary = stringifyForModel(attachment.name, parsed);
      const { text, truncated } = truncateForModel(summary);
      return {
        id,
        name: attachment.name,
        mediaType: attachment.mediaType || "text/csv",
        kind,
        sizeBytes,
        parsedRows: parsed,
        truncated,
        blocks: [{ type: "text", text }],
      };
    }
    // Plain text: just inline it (capped).
    const { text, truncated } = truncateForModel(
      `[Attached text file: ${attachment.name}]\n\n${textRaw}`,
    );
    return {
      id,
      name: attachment.name,
      mediaType: attachment.mediaType || "text/plain",
      kind,
      sizeBytes,
      truncated,
      blocks: [{ type: "text", text }],
    };
  }

  // Exhaustive — TypeScript will complain if a kind is added without a branch.
  throw new Error(`unhandled attachment kind: ${String(kind)}`);
}

// ---------------------------------------------------------------------------
// Build a model-friendly text dump of a parsed spreadsheet — sheet name,
// header row, and first N rows. The full structured data is stored on
// ParsedAttachment.parsedRows so tools can fetch it on demand.
// ---------------------------------------------------------------------------

const PREVIEW_ROWS_PER_SHEET = 25;

function stringifyForModel(
  fileName: string,
  spreadsheet: ParsedSpreadsheet,
): string {
  const lines: string[] = [];
  lines.push(`[Attached spreadsheet: ${fileName}]`);
  for (const sheet of spreadsheet.sheets) {
    lines.push("");
    lines.push(`## Sheet: ${sheet.name} (${sheet.rowCount} rows)`);
    if (sheet.headers.length > 0) {
      lines.push(`Columns: ${sheet.headers.join(" | ")}`);
    }
    const preview = sheet.rows.slice(0, PREVIEW_ROWS_PER_SHEET);
    if (preview.length === 0) {
      lines.push("(no body rows)");
      continue;
    }
    for (const row of preview) {
      const cells = sheet.headers.map((h) => String(row[h] ?? "").trim());
      lines.push("- " + cells.join(" | "));
    }
    if (sheet.rowCount > PREVIEW_ROWS_PER_SHEET) {
      lines.push(`... (${sheet.rowCount - PREVIEW_ROWS_PER_SHEET} more rows in this sheet)`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Per-message attachment intake. Enforces count + size limits and returns
// both successful parses and rejection reasons.
// ---------------------------------------------------------------------------

export async function ingestAttachments(
  attachments: IncomingAttachment[],
): Promise<{
  parsed: ParsedAttachment[];
  rejected: AttachmentRejection[];
}> {
  const parsed: ParsedAttachment[] = [];
  const rejected: AttachmentRejection[] = [];
  const list = Array.isArray(attachments) ? attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE) : [];
  if (Array.isArray(attachments) && attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    for (const dropped of attachments.slice(MAX_ATTACHMENTS_PER_MESSAGE)) {
      rejected.push({
        name: dropped.name || "(unnamed)",
        reason: `dropped — only the first ${MAX_ATTACHMENTS_PER_MESSAGE} files per message are processed`,
      });
    }
  }
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const check = validateIncoming(a);
    if (!check.ok) {
      rejected.push({ name: a.name || "(unnamed)", reason: check.reason });
      continue;
    }
    try {
      const id = `att_${i + 1}`;
      const out = await parseAttachment(a, id);
      parsed.push(out);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rejected.push({ name: a.name, reason: `parse failed: ${msg.slice(0, 200)}` });
    }
  }
  return { parsed, rejected };
}

// ---------------------------------------------------------------------------
// Module-level cache for the assistant route to look up parsed rows when
// the model calls `parse_spreadsheet` / `match_uploaded_data_to_hookka`.
//
// Why a module-level Map: the SSE handler holds a reference to the
// attachment array for the request's lifetime, but the tool dispatcher
// only gets the Hono Context. We stash by request id (set via worker
// middleware as c.var.requestId). Map entries are auto-pruned after
// ATTACHMENT_TTL_MS — well past any in-flight chat turn.
// ---------------------------------------------------------------------------

const ATTACHMENT_TTL_MS = 5 * 60 * 1000; // 5 minutes

type CachedSet = {
  attachments: ParsedAttachment[];
  expiresAt: number;
};

const attachmentCache = new Map<string, CachedSet>();

function pruneExpired(now: number): void {
  for (const [k, v] of attachmentCache.entries()) {
    if (v.expiresAt <= now) attachmentCache.delete(k);
  }
}

export function stashAttachments(
  requestId: string,
  attachments: ParsedAttachment[],
): void {
  const now = Date.now();
  pruneExpired(now);
  attachmentCache.set(requestId, {
    attachments,
    expiresAt: now + ATTACHMENT_TTL_MS,
  });
}

export function lookupAttachments(requestId: string): ParsedAttachment[] {
  pruneExpired(Date.now());
  return attachmentCache.get(requestId)?.attachments ?? [];
}

export function dropAttachments(requestId: string): void {
  attachmentCache.delete(requestId);
}
