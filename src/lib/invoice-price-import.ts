// ---------------------------------------------------------------------------
// invoice-price-import — turn an edited Detail Listing sheet into a PLAN.
//
// Pure. Given the rows a spreadsheet produced and the lines as they stand in
// the database right now, it returns what would change and what is refused,
// with a reason per refusal. The preview and the apply run this SAME function,
// so what you are shown and what gets written cannot drift apart.
//
// ## Why this file is defensive to the point of rudeness
//
// On 2026-08-20 the price editor wrote RM 0 into 112 lines across 17 SENT
// invoices, because a missing value was read as zero (BUG-2026-08-20-158). A
// spreadsheet is that same hazard with the volume turned up: an empty cell and
// a zero look identical, Excel silently reformats codes and drops leading
// zeros, and by the time a file comes back the invoice may have moved on.
//
// So the rules here are stated as refusals, not as best guesses:
//
//   BLANK MEANS DO NOT TOUCH. Not zero. To price something at nothing you type
//   an explicit 0, and the plan reports those separately so nobody sets a line
//   free by leaving a cell empty. (NetSuite ships the same idea as an
//   "Overwrite blank fields" switch that is OFF by default.)
//
//   THE FILE MUST SAY WHAT IT WAS BASED ON. Every exported row carries the Unit
//   Price at export time. If the line no longer charges that, the row is
//   refused — someone edited it while the sheet was open, and silently winning
//   that race is how one person's work disappears.
//
//   MATCH ON LINE ID, NEVER ON POSITION. An invoice can carry the same product
//   code on several lines (INV-2608-031 has 1007-(Q) four times), and the
//   operator will sort and filter the sheet. Row order means nothing.
//
//   AN UNKNOWN ROW IS AN ERROR, NOT A SKIP. A file that half-applies while
//   looking complete is worse than one that is rejected outright.
// ---------------------------------------------------------------------------

/** One row as the sheet produced it. Blank cells arrive as "" or undefined. */
export type ImportRow = {
  lineId?: string | null;
  invoiceNo?: string | null;
  /** The Unit Price column as exported — the baseline this edit was made against. */
  exportedUnit?: number | string | null;
  base?: number | string | null;
  divan?: number | string | null;
  leg?: number | string | null;
  totalHeight?: number | string | null;
  special?: number | string | null;
  discount?: number | string | null;
};

/** A line as it stands in the database now. */
export type CurrentLine = {
  id: string;
  invoiceNo: string;
  invoiceId: string;
  invoiceStatus: string;
  invoicePaidSen: number;
  quantity: number;
  unitPriceSen: number;
  basePriceSen: number;
  divanPriceSen: number;
  legPriceSen: number;
  totalHeightPriceSen: number;
  specialOrderPriceSen: number;
  discountSen: number;
};

export type PlannedChange = {
  lineId: string;
  invoiceNo: string;
  invoiceId: string;
  before: { base: number; divan: number; leg: number; totalHeight: number; special: number; discount: number; unit: number };
  after: { base: number; divan: number; leg: number; totalHeight: number; special: number; discount: number; unit: number };
  /** Which columns the sheet actually filled in. */
  touched: string[];
  /** The new unit price is 0 and the line currently charges something. */
  makesFree: boolean;
};

export type Rejection = { row: number; lineId: string; invoiceNo: string; reason: string };

export type ImportPlan = {
  changes: PlannedChange[];
  rejections: Rejection[];
  /** Rows that parsed fine and ask for nothing — every editable cell blank. */
  untouched: number;
};

/**
 * A cell the operator left alone.
 *
 * `null`, `undefined` and `""` are ABSENT. `0` and `"0"` are a real, deliberate
 * zero. Whitespace is absent — a cell someone spaced into is not a number.
 */
export function cellIsBlank(v: number | string | null | undefined): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "number") return false;
  return String(v).trim() === "";
}

/**
 * Ringgit as the sheet wrote it → whole sen.
 *
 * Returns NaN for anything that is not a number, so the caller refuses the row
 * rather than silently importing a 0. Excel loves to hand back "1,039.50" and
 * "RM 480.00"; both are accepted, anything else is not.
 */
export function rmCellToSen(v: number | string): number {
  if (typeof v === "number") return Math.round(v * 100);
  const cleaned = String(v).replace(/[,\s]/g, "").replace(/^RM/i, "");
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return Number.NaN;
  return Math.round(Number(cleaned) * 100);
}

const COMPONENTS = [
  ["base", "basePriceSen"],
  ["divan", "divanPriceSen"],
  ["leg", "legPriceSen"],
  ["totalHeight", "totalHeightPriceSen"],
  ["special", "specialOrderPriceSen"],
] as const;

export function planInvoicePriceImport(
  rows: ImportRow[],
  current: Map<string, CurrentLine>,
): ImportPlan {
  const changes: PlannedChange[] = [];
  const rejections: Rejection[] = [];
  let untouched = 0;

  // Duplicate ids are found BEFORE anything is planned, so a contradicted line
  // is refused outright rather than having its first occurrence quietly win.
  // Letting the first one through is the repo's own `first-one-wins` class
  // (BUG-2026-07-17-001) — a plausible answer chosen because it happened to be
  // encountered first. If the file says two things about a line, the file is
  // the thing that is wrong.
  const idCounts = new Map<string, number>();
  for (const r of rows) {
    const id = String(r.lineId ?? "").trim();
    if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }

  rows.forEach((row, i) => {
    const rowNo = i + 2; // +1 for the header, +1 because humans count from 1
    const lineId = String(row.lineId ?? "").trim();
    const invoiceNo = String(row.invoiceNo ?? "").trim();
    const reject = (reason: string) => rejections.push({ row: rowNo, lineId, invoiceNo, reason });

    if (!lineId) {
      reject("No Line ID. Export a fresh Detail Listing and edit that — a row without an id cannot be matched to anything.");
      return;
    }
    if ((idCounts.get(lineId) ?? 0) > 1) {
      reject("This Line ID appears more than once in the file. Every copy is refused — the file contradicts itself about this line, and picking one would just be picking the first.");
      return;
    }

    const line = current.get(lineId);
    if (!line) {
      reject("No such line in the system. The invoice may have been edited or the file may be from another environment.");
      return;
    }
    if (invoiceNo && invoiceNo !== line.invoiceNo) {
      reject(`Line belongs to ${line.invoiceNo}, but the file says ${invoiceNo}. Refusing rather than trusting one over the other.`);
      return;
    }
    if (line.invoicePaidSen > 0) {
      reject("The invoice has taken a payment. Prices are not editable once money has moved.");
      return;
    }
    if (line.invoiceStatus !== "DRAFT" && line.invoiceStatus !== "SENT") {
      reject(`The invoice is ${line.invoiceStatus}. Only a DRAFT or an unpaid SENT invoice can be repriced.`);
      return;
    }

    // The baseline. Without it there is nothing to detect a concurrent edit.
    if (cellIsBlank(row.exportedUnit)) {
      reject("The Unit Price column is empty. It is the baseline this edit was made against — do not clear it.");
      return;
    }
    const exported = rmCellToSen(row.exportedUnit as number | string);
    if (Number.isNaN(exported)) {
      reject(`Unit Price "${String(row.exportedUnit)}" is not a number.`);
      return;
    }
    if (exported !== line.unitPriceSen) {
      reject(
        `This line charged ${(exported / 100).toFixed(2)} when the file was exported and charges ` +
          `${(line.unitPriceSen / 100).toFixed(2)} now — someone changed it in the meantime. ` +
          `Export again and redo this row.`,
      );
      return;
    }

    const before = {
      base: line.basePriceSen,
      divan: line.divanPriceSen,
      leg: line.legPriceSen,
      totalHeight: line.totalHeightPriceSen,
      special: line.specialOrderPriceSen,
      discount: line.discountSen,
      unit: line.unitPriceSen,
    };
    const after = { ...before };
    const touched: string[] = [];
    let bad = false;

    for (const [key, dbField] of COMPONENTS) {
      const cell = row[key];
      if (cellIsBlank(cell)) continue; // blank means DO NOT TOUCH
      const sen = rmCellToSen(cell as number | string);
      if (Number.isNaN(sen)) {
        reject(`${key} is "${String(cell)}", which is not a number.`);
        bad = true;
        break;
      }
      if (sen < 0) {
        reject(`${key} is negative. A price component cannot be below zero.`);
        bad = true;
        break;
      }
      if (sen !== before[key]) touched.push(key);
      after[key] = sen;
      void dbField;
    }
    if (bad) return;

    if (!cellIsBlank(row.discount)) {
      const d = rmCellToSen(row.discount as number | string);
      if (Number.isNaN(d) || d < 0) {
        reject(`Discount is "${String(row.discount)}", which is not a usable amount.`);
        return;
      }
      if (d !== before.discount) touched.push("discount");
      after.discount = d;
    }

    if (touched.length === 0) {
      untouched++;
      return;
    }

    after.unit = after.base + after.divan + after.leg + after.totalHeight + after.special;
    changes.push({
      lineId,
      invoiceNo: line.invoiceNo,
      invoiceId: line.invoiceId,
      before,
      after,
      touched,
      makesFree: after.unit === 0 && before.unit > 0,
    });
  });

  return { changes, rejections, untouched };
}
