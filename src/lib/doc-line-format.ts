// ---------------------------------------------------------------------------
// doc-line-format.ts — Workers-pure line/spec formatting for the DO / Invoice /
// CN documents. Extracted verbatim from generate-do-pdf.ts so the SAME logic
// feeds BOTH the browser jsPDF renderers AND the backend pdf-lib generator
// (unified-do-invoice-pdf.ts) — no jsPDF import, so it runs on Cloudflare
// Workers. Keeping ONE copy is the whole point of the DO/Invoice unification:
// the pieces breakdown ("1 HB + 2 Divan"), category banding, and the stacked
// code/name/spec Description can never drift between download and auto-email.
// ---------------------------------------------------------------------------

const num = (v: unknown): string | null =>
  v == null || Number(v) === 0 ? null : `${v}"`;

// "2 DIVAN + 1 HB" -> { text: "1 HB  +  2 DIVAN", total: 3 } (HB first).
export function fmtPieces(pieces?: string | null): { text: string; total: number } {
  const parts = String(pieces || "")
    .split(" + ")
    .map((s) => s.trim())
    .filter(Boolean);
  let total = 0;
  const parsed = parts.map((p) => {
    const mm = p.match(/^(\d+)\s+(.+)$/);
    const n = mm ? Number(mm[1]) : 0;
    total += n;
    return { n, lab: mm ? mm[2] : p };
  });
  const rank = (lab: string) => {
    const u = lab.toUpperCase();
    return u === "HB" ? 0 : u === "DIVAN" ? 1 : 2;
  };
  parsed.sort((a, b) => rank(a.lab) - rank(b.lab));
  return {
    // Drop the leading "1" ONLY for labels that start with a digit (sofa
    // variants like 1A / 2A) — there "1 1A(LHF)" reads as "11A". Keep the
    // count for HB / DIVAN so "1 HB" stays "1 HB".
    text: parsed
      .map((x) => (x.n === 1 && /^\d/.test(x.lab) ? x.lab : `${x.n} ${x.lab}`))
      .join("  +  "),
    total,
  };
}

export const catRank = (cat?: string | null): number => {
  const c = (cat || "").toUpperCase();
  if (c === "BEDFRAME") return 0;
  if (c === "SOFA") return 1;
  if (c === "ACCESSORY") return 2;
  if (c === "SERVICE") return 3;
  return 4;
};

export const catLabel = (cat?: string | null): string => {
  const c = (cat || "").toUpperCase();
  if (c === "BEDFRAME") return "BEDFRAME";
  if (c === "SOFA") return "SOFA";
  if (c === "ACCESSORY") return "ACCESSORY / ADD-ON";
  if (c === "SERVICE") return "SERVICE";
  return "ITEMS";
};

export const uomOf = (cat?: string | null): string =>
  (cat || "").toUpperCase() === "ACCESSORY" ? "UNIT" : "SET";

export type BuildSpecExtra = {
  itemCategory?: string | null;
  divanHeightInches?: number | null;
  legHeightInches?: number | null;
  gapInches?: number | null;
  totalHeightInches?: number | null;
  specialOrder?: string | null;
};

// Stacked Description cell — code / name / build-spec, joined by newlines.
export function describe(
  it: { productCode: string; productName: string; fabricCode: string; sizeLabel: string },
  ex: BuildSpecExtra | undefined,
): string {
  const lines: string[] = [];
  if (it.productCode) lines.push(it.productCode);
  if (it.productName) lines.push(it.productName);

  const cat = (ex?.itemCategory || "").toUpperCase();
  const dv = num(ex?.divanHeightInches);
  const lg = num(ex?.legHeightInches);
  const gp = num(ex?.gapInches);
  const th = num(ex?.totalHeightInches);
  const spec: string[] = [];
  if (it.fabricCode) spec.push(it.fabricCode);

  const hasBfSpec = !!(dv || lg || gp || th);
  if (cat === "BEDFRAME" || (cat !== "SOFA" && cat !== "ACCESSORY" && hasBfSpec)) {
    if (dv) spec.push(`DIVAN ${dv}${lg ? ` + ${lg} LEG` : " + NO LEG"}`);
    else if (lg) spec.push(`${lg} LEG`);
    if (gp) spec.push(`GAP ${gp}`);
    if (th) spec.push(`T.Heights ${th}`);
  } else {
    if (it.sizeLabel) spec.push(`Size: ${it.sizeLabel}`);
    if (lg) spec.push(`${lg} LEG`);
  }
  if (ex?.specialOrder && String(ex.specialOrder).trim())
    spec.push(String(ex.specialOrder).trim());
  if (spec.length) lines.push(spec.join(" / "));
  return lines.join("\n");
}
