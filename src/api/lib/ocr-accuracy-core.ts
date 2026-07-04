// ---------------------------------------------------------------------------
// ocr-accuracy-core.ts — pure diff logic for the OCR accuracy dashboard.
//
// Definition (owner 2026-07-04): a scanned document is a SUCCESS if the
// operator changed NOTHING between what OCR extracted (rawExtracted / rawJson)
// and what they finally imported (correctedJson). ANY change to a meaningful
// field = FAIL, and the changed field name(s) are the fail reason.
//
// Pure + deterministic so it's unit-tested (ocr-accuracy.test.mjs). The route
// (routes/ocr-accuracy.ts) loads the samples + product-category map and calls
// these; all IO stays there.
// ---------------------------------------------------------------------------

export type DiffResult = { changed: boolean; fields: string[] };

// Normalise a scalar for comparison: null/undefined/"" collapse together;
// strings trim + upper-case (codes are case-insensitive on the shop floor);
// numbers compare as numbers so 5 and "5" and 5.0 are equal.
function norm(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const s = String(v).trim();
  if (s === "") return "";
  const n = Number(s);
  if (!Number.isNaN(n) && /^-?\d*\.?\d+$/.test(s)) return String(n);
  return s.toUpperCase();
}

function eq(a: unknown, b: unknown): boolean {
  return norm(a) === norm(b);
}

type AnyRec = Record<string, unknown>;
const asRec = (v: unknown): AnyRec => (v && typeof v === "object" ? (v as AnyRec) : {});
const asArr = (v: unknown): AnyRec[] =>
  Array.isArray(v) ? v.map((x) => asRec(x)) : [];

// Compare the operator-editable fields of a Sales Order scan. Header PO +
// customer, then each line's product/size/fabric/qty/special (matched by
// position — the modal edits rows in place, so index alignment holds).
const SO_HEADER: [string, string][] = [
  ["customerPO", "Customer PO"],
  ["customerName", "Customer"],
];
const SO_LINE: [string, string][] = [
  ["productCode", "Product code"],
  ["sizeCode", "Size"],
  ["fabricCode", "Fabric code"],
  ["quantity", "Qty"],
  ["specialOrder", "Special order"],
];

export function diffSalesOrderSample(raw: unknown, corrected: unknown): DiffResult {
  const r = asRec(raw);
  const c = asRec(corrected);
  const fields = new Set<string>();

  for (const [key, label] of SO_HEADER) {
    if (!eq(r[key], c[key])) fields.add(label);
  }
  const ri = asArr(r.items);
  const ci = asArr(c.items);
  if (ri.length !== ci.length) fields.add("Line added/removed");
  const n = Math.min(ri.length, ci.length);
  for (let i = 0; i < n; i++) {
    for (const [key, label] of SO_LINE) {
      if (!eq(ri[i][key], ci[i][key])) fields.add(label);
    }
  }
  return { changed: fields.size > 0, fields: [...fields] };
}

// Per-LINE diff for the customer × category breakdown (category is a line-level
// concept — one order can mix Sofa + Bedframe). Matches items by position and
// returns each line's productCode (so the route can map it to the Hookka
// catalog category) plus whether that line's own fields were edited.
export type LineDiff = { productCode: string; changed: boolean; fields: string[] };

export function salesOrderLineDiffs(raw: unknown, corrected: unknown): LineDiff[] {
  const ci = asArr(asRec(corrected).items);
  const ri = asArr(asRec(raw).items);
  return ci.map((cLine, i) => {
    const rLine = ri[i] ?? {};
    const fields: string[] = [];
    for (const [key, label] of SO_LINE) {
      if (!eq(rLine[key], cLine[key])) fields.push(label);
    }
    // A line the operator added (no matching raw line) counts as changed.
    const added = i >= ri.length;
    if (added && fields.length === 0) fields.push("Line added");
    return {
      productCode: String(cLine.productCode ?? rLine.productCode ?? "").trim(),
      changed: fields.length > 0 || added,
      fields,
    };
  });
}

// Compare a supplier scan. The supplier envelope is { docs: [ { docNo, lines:
// [...] } ] } (multi-doc since 2026-06-30) OR a single legacy { lines: [...] }.
// We flatten to the list of docs, compare header docNo + each line's
// code/description/qty/price by position.
const SUP_HEADER: [string, string][] = [
  ["docNo", "Doc No"],
  ["supplierName", "Supplier"],
];
const SUP_LINE: [string, string][] = [
  ["supplierCode", "Material code"],
  ["description", "Description"],
  ["qty", "Qty"],
  ["unitPrice", "Unit price"],
];

function docsOf(v: unknown): AnyRec[] {
  const rec = asRec(v);
  if (Array.isArray(rec.docs)) return asArr(rec.docs);
  // Legacy single-doc shape: the envelope itself is the doc.
  return [rec];
}

export function diffSupplierSample(raw: unknown, corrected: unknown): DiffResult {
  const rd = docsOf(raw);
  const cd = docsOf(corrected);
  const fields = new Set<string>();
  if (rd.length !== cd.length) fields.add("Doc added/removed");
  const dn = Math.min(rd.length, cd.length);
  for (let d = 0; d < dn; d++) {
    for (const [key, label] of SUP_HEADER) {
      if (!eq(rd[d][key], cd[d][key])) fields.add(label);
    }
    const rl = asArr(rd[d].lines);
    const cl = asArr(cd[d].lines);
    if (rl.length !== cl.length) fields.add("Line added/removed");
    const ln = Math.min(rl.length, cl.length);
    for (let i = 0; i < ln; i++) {
      for (const [key, label] of SUP_LINE) {
        if (!eq(rl[i][key], cl[i][key])) fields.add(label);
      }
    }
  }
  return { changed: fields.size > 0, fields: [...fields] };
}

// ---- Aggregation helpers (pure) -------------------------------------------

export type Bucket = {
  key: string;
  total: number;
  success: number;
  failFields: Record<string, number>;
};

export function emptyBucket(key: string): Bucket {
  return { key, total: 0, success: 0, failFields: {} };
}

export function addToBucket(b: Bucket, diff: DiffResult): void {
  b.total += 1;
  if (!diff.changed) b.success += 1;
  else for (const f of diff.fields) b.failFields[f] = (b.failFields[f] ?? 0) + 1;
}

/** rate 0–100, 1dp; null when no samples. */
export function rateOf(b: { total: number; success: number }): number | null {
  return b.total === 0 ? null : Math.round((b.success / b.total) * 1000) / 10;
}

/** Top-N fail fields as "Label (count)" strings, most-frequent first. */
export function topFails(failFields: Record<string, number>, n = 3): string[] {
  return Object.entries(failFields)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([label, count]) => `${label} (${count})`);
}
