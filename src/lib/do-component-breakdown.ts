// ---------------------------------------------------------------------------
// DO component breakdown for the customer dispatch notice — "3 × Headboard,
// 3 × Divan, 2 × Sofa".
//
// Derived from the SAME /api/delivery-orders/:id/print-extras per-item data
// (itemCategory + pieces) that feeds the attached DO PDF, and tallied the
// SAME way the Packing List manifest counts physical pieces
// (tallyComponents in generate-do-pdf.ts): each line's BOM pieces string
// ("1 HB + 2 DIVAN", "1 1A(LHF) + 1 STOOL") is parsed part by part — HB and
// DIVAN keep their own buckets, every other piece buckets by the line's
// itemCategory — and lines without a pieces string fall back to quantity ×
// category. The delivery page builds BOTH the PDF and the email fields from
// one fetched extras object so the two can never diverge.
//
// Dependency-free (no jsPDF / react imports) so the delivery page and the
// node:test suite can both import it directly.
// ---------------------------------------------------------------------------

export interface BreakdownItem {
  id: string;
  quantity: number;
}

export interface BreakdownExtras {
  items?: Record<
    string,
    {
      itemCategory?: string | null;
      pieces?: string | null;
      customerPOId?: string | null;
    }
  >;
}

// Customer-friendly bucket for a non-HB/DIVAN piece or a pieces-less line.
function categoryLabel(cat?: string | null): string {
  const c = (cat || "").toUpperCase();
  if (c === "SOFA") return "Sofa";
  if (c === "ACCESSORY") return "Accessory";
  if (c === "SERVICE") return "Service";
  if (c === "BEDFRAME") return "Bedframe";
  return "Item";
}

const LABEL_ORDER = [
  "Headboard",
  "Divan",
  "Bedframe",
  "Sofa",
  "Accessory",
  "Service",
  "Item",
];
const rank = (label: string): number => {
  const i = LABEL_ORDER.indexOf(label);
  return i === -1 ? LABEL_ORDER.length : i;
};

/**
 * Tally a DO's items into "{n} × {label}" buckets, mirroring the Packing
 * List's physical-piece counting. Returns "" when there is nothing to count
 * (caller omits the Items row).
 */
export function buildDoComponentBreakdown(
  items: BreakdownItem[],
  extras?: BreakdownExtras,
): string {
  const tally = new Map<string, number>();
  const add = (label: string, n: number) => {
    if (n <= 0) return;
    tally.set(label, (tally.get(label) || 0) + n);
  };

  for (const it of items || []) {
    const ex = extras?.items?.[it.id];
    const pieces = (ex?.pieces || "").trim();
    if (pieces) {
      // Same "N LABEL + N LABEL" grammar fmtPieces/tallyComponents parse.
      // Pieces without a leading count (single sofa variants like
      // "1A(LHF)") count as 1 — generate-do-pdf prints them without the
      // leading "1", so the email must not drop them.
      for (const part of pieces.split(" + ")) {
        const t = part.trim();
        if (!t) continue;
        const m = t.match(/^(\d+)\s+(.+)$/);
        const n = m ? Number(m[1]) : 1;
        const raw = (m ? m[2] : t).trim().toUpperCase();
        const label =
          raw === "HB"
            ? "Headboard"
            : raw === "DIVAN"
              ? "Divan"
              : categoryLabel(ex?.itemCategory || "SOFA");
        add(label, n);
      }
    } else {
      add(categoryLabel(ex?.itemCategory), Number(it.quantity) || 0);
    }
  }

  return Array.from(tally.entries())
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([label, n]) => `${n} × ${label}`)
    .join(", ");
}

/**
 * Distinct customer PO numbers across the DO's lines (print-extras
 * per-line customerPOId, first-seen order), falling back to the DO-level
 * customerPOId when no line carries one. Feeds the "Your PO No." email row.
 */
export function collectCustomerPOIds(
  items: BreakdownItem[],
  extras?: BreakdownExtras,
  doLevelCustomerPOId?: string | null,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items || []) {
    const po = String(extras?.items?.[it.id]?.customerPOId || "").trim();
    if (po && !seen.has(po)) {
      seen.add(po);
      out.push(po);
    }
  }
  if (out.length === 0) {
    const fallback = String(doLevelCustomerPOId || "").trim();
    if (fallback) out.push(fallback);
  }
  return out;
}
