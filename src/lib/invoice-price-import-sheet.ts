// ---------------------------------------------------------------------------
// invoice-price-import-sheet — read an edited Detail Listing workbook into rows.
//
// Pure: an array-of-arrays in, `ImportRow[]` out. The file itself is opened by
// the caller (xlsx is dynamic-imported so it stays out of the main bundle);
// everything that can be wrong about the SHAPE of a sheet is decided here,
// where a test can reach it.
//
// ## Columns are found BY NAME
//
// Never by position. The operator will hide columns, reorder them, and paste a
// subset into a fresh sheet — all of which are reasonable things to do to a
// spreadsheet, and all of which break a positional reader silently. A name that
// is missing is an error with the name in it; a name that moved is a non-event.
//
// ## What counts as "the file is wrong"
//
// A missing `Line ID` column is fatal: without it nothing can be matched, and
// guessing from row order is exactly the mistake this whole feature is built to
// avoid. A missing `Unit Price` is equally fatal — it is the baseline that
// detects someone else having edited the invoice while the sheet was open.
//
// Missing PRICE columns are not fatal. A sheet that only carries `Base` is a
// perfectly sensible thing to hand back when base is all you fixed, and the
// planner already treats an absent column the same way it treats a blank cell:
// do not touch.
// ---------------------------------------------------------------------------

import type { ImportRow } from "./invoice-price-import";

/** Header text → the field it feeds. Matched case- and space-insensitively. */
const COLUMN_MAP: Record<string, keyof ImportRow> = {
  "line id": "lineId",
  "doc. no.": "invoiceNo",
  "doc no": "invoiceNo",
  "invoice no": "invoiceNo",
  "unit price": "exportedUnit",
  base: "base",
  divan: "divan",
  leg: "leg",
  "t.height": "totalHeight",
  "t height": "totalHeight",
  "total height": "totalHeight",
  special: "special",
  discount: "discount",
};

const norm = (v: unknown): string =>
  String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export type SheetReadResult =
  | { ok: true; rows: ImportRow[]; ignoredColumns: string[] }
  | { ok: false; error: string };

/**
 * @param aoa Sheet as an array of arrays, header row first.
 */
export function readImportSheet(aoa: unknown[][]): SheetReadResult {
  if (!Array.isArray(aoa) || aoa.length === 0) {
    return { ok: false, error: "The file is empty." };
  }
  const header = aoa[0];
  if (!Array.isArray(header)) {
    return { ok: false, error: "The first row is not a header row." };
  }

  const index: Partial<Record<keyof ImportRow, number>> = {};
  const ignoredColumns: string[] = [];
  header.forEach((cell, i) => {
    const key = COLUMN_MAP[norm(cell)];
    if (key === undefined) {
      const label = String(cell ?? "").trim();
      if (label) ignoredColumns.push(label);
      return;
    }
    // First occurrence wins ONLY because a duplicate header is refused below.
    if (index[key] === undefined) index[key] = i;
    else index[key] = -1; // marker: seen twice
  });

  for (const [key, at] of Object.entries(index)) {
    if (at === -1) {
      return {
        ok: false,
        error: `The sheet has two columns that both mean "${key}". Delete one — which was meant cannot be decided here.`,
      };
    }
  }

  if (index.lineId === undefined) {
    return {
      ok: false,
      error:
        'No "Line ID" column. That column is how a row is matched to an invoice line — ' +
        "without it, matching would fall back to row order, which is exactly what this import refuses to do. " +
        "Export a fresh Detail Listing and edit that.",
    };
  }
  if (index.exportedUnit === undefined) {
    return {
      ok: false,
      error:
        'No "Unit Price" column. It is the baseline each edit was made against — ' +
        "it is what detects the invoice having been changed while your file was open.",
    };
  }

  const rows: ImportRow[] = [];
  for (let r = 1; r < aoa.length; r++) {
    const line = aoa[r];
    if (!Array.isArray(line)) continue;
    // A wholly empty row is what a spreadsheet leaves behind after a delete.
    if (line.every((c) => c === null || c === undefined || String(c).trim() === "")) continue;

    const at = (k: keyof ImportRow) => {
      const i = index[k];
      return i === undefined ? undefined : (line[i] as number | string | undefined);
    };
    rows.push({
      lineId: at("lineId") as string | undefined,
      invoiceNo: at("invoiceNo") as string | undefined,
      exportedUnit: at("exportedUnit"),
      base: at("base"),
      divan: at("divan"),
      leg: at("leg"),
      totalHeight: at("totalHeight"),
      special: at("special"),
      discount: at("discount"),
    });
  }

  if (rows.length === 0) {
    return { ok: false, error: "The file has a header but no data rows." };
  }
  return { ok: true, rows, ignoredColumns };
}
