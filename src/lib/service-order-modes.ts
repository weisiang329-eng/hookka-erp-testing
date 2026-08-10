// ---------------------------------------------------------------------------
// service-order-modes.ts — what each resolution mode actually NEEDS from an
// affected-item line, and the tolerant catalogue lookup that turns whatever
// the operator typed into a real `products` row.
//
// WHY THIS FILE EXISTS (bug 2026-08-10):
//   The Spawn Service Order dialog labelled the CODE column "optional" and
//   then posted `productId: null` for every free-text line. Mode REPRODUCE
//   inserts one `production_orders` row per line, and `production_orders`
//   .product_id is a FOREIGN KEY to `products`. The route bound
//   `productId ?? ""` — an empty string is NOT null, so Postgres ran the FK
//   check and rejected the whole transaction. The operator was told the field
//   was optional by the very screen that then failed, and the failure surfaced
//   as a raw constraint name.
//
//   The screen and the server disagreed because each carried its own idea of
//   what a mode requires. They now share THIS module: the dialog disables
//   submit using `validateSpawnLines`, and the route refuses using the SAME
//   call. There is one definition, so they cannot drift apart again.
//
// WHAT EACH MODE NEEDS — derived from what it WRITES, not from taste:
//   REPRODUCE  → INSERT production_orders (product_id FK)   → catalogue product REQUIRED
//   STOCK_SWAP → UPDATE fg_batches (a batch belongs to one
//                product, so we cannot find a batch without
//                first knowing the product)                 → catalogue product REQUIRED
//   REPAIR     → writes nothing but the order + its lines   → free text ALLOWED
//
//   Repair is the escape hatch on purpose: a service case can be about a unit
//   that was never in our catalogue (a customer's own item, a discontinued
//   model, an accessory). Imposing Reproduce's requirement on Repair would
//   block the only mode that legitimately has no product.
//
// Pure + dependency-free so both the browser bundle and the Worker route can
// import it, and so the rules are unit-testable without a database.
// ---------------------------------------------------------------------------

export type ServiceMode = "REPRODUCE" | "STOCK_SWAP" | "REPAIR";

export const SERVICE_MODES: ServiceMode[] = [
  "REPRODUCE",
  "STOCK_SWAP",
  "REPAIR",
];

export type ServiceModeSpec = {
  mode: ServiceMode;
  /** Button title in the dialog. */
  label: string;
  /** Button sub-line in the dialog. */
  blurb: string;
  /** Opens one production_orders row per line (cost_category='REPAIR'). */
  createsProductionOrder: boolean;
  /** Decrements an fg_batches row per line. */
  consumesFinishedStock: boolean;
  /** Every line must resolve to a row in `products`. */
  requiresCatalogueProduct: boolean;
  /**
   * The single sentence the dialog prints under Affected Items and the route
   * quotes back in its refusal, so the operator reads the same rule in both
   * places.
   */
  productRule: string;
};

export const SERVICE_MODE_SPECS: Record<ServiceMode, ServiceModeSpec> = {
  REPRODUCE: {
    mode: "REPRODUCE",
    label: "Reproduce",
    blurb: "Open new PO; ship when ready",
    createsProductionOrder: true,
    consumesFinishedStock: false,
    requiresCatalogueProduct: true,
    productRule:
      "Reproduce opens a production order for each item, so every item must be a product from the catalogue.",
  },
  STOCK_SWAP: {
    mode: "STOCK_SWAP",
    label: "Stock Swap",
    blurb: "Pull from FG, ship now",
    createsProductionOrder: false,
    consumesFinishedStock: true,
    requiresCatalogueProduct: true,
    productRule:
      "Stock Swap takes a unit out of finished-goods stock, so every item must be a product from the catalogue.",
  },
  REPAIR: {
    mode: "REPAIR",
    label: "Repair",
    blurb: "Customer returns; we fix",
    createsProductionOrder: false,
    consumesFinishedStock: false,
    requiresCatalogueProduct: false,
    productRule:
      "Repair records the item and waits for the customer to send it back — it can be something that is not in the catalogue, so a typed description is enough.",
  },
};

export function modeSpec(mode: ServiceMode | null | undefined): ServiceModeSpec | null {
  return mode ? (SERVICE_MODE_SPECS[mode] ?? null) : null;
}

/** True when `mode` cannot be satisfied by a typed description. */
export function requiresCatalogueProduct(
  mode: ServiceMode | null | undefined,
): boolean {
  return modeSpec(mode)?.requiresCatalogueProduct ?? false;
}

// ---------------------------------------------------------------------------
// Catalogue lookup
// ---------------------------------------------------------------------------

export type CatalogueProduct = { id: string; code: string; name: string };

/**
 * Fold a typed product reference down to the characters that actually carry
 * identity. `1041 (Q)`, `1041-(Q)`, `1041 q` and `1041(Q)` all become `1041Q`.
 *
 * This is the whole reason the reported case failed: the catalogue code is
 * `1041-(Q)` and the operator typed `1041 (Q)` — a space where the code has a
 * hyphen. Verified against production 2026-08-10: folding all 375 product
 * codes this way produces ZERO collisions, so a fold-match is unambiguous
 * enough to accept as an exact hit.
 */
export function normaliseProductKey(raw: string | null | undefined): string {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export type ProductResolution =
  | { status: "resolved"; product: CatalogueProduct; matchedOn: "id" | "code" | "name" }
  | { status: "ambiguous"; typed: string; candidates: CatalogueProduct[] }
  | { status: "unknown"; typed: string; suggestions: CatalogueProduct[] }
  | { status: "blank" };

export type ProductRef = {
  productId?: string | null;
  productCode?: string | null;
  productName?: string | null;
};

const MAX_SUGGESTIONS = 3;

function uniqueById(rows: CatalogueProduct[]): CatalogueProduct[] {
  const seen = new Set<string>();
  const out: CatalogueProduct[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/** Products whose folded code / name is a near miss for `key`. */
function suggestFor(key: string, catalogue: CatalogueProduct[]): CatalogueProduct[] {
  if (!key) return [];
  const hits = catalogue.filter((p) => {
    const codeKey = normaliseProductKey(p.code);
    const nameKey = normaliseProductKey(p.name);
    return (
      codeKey.startsWith(key) ||
      key.startsWith(codeKey) ||
      codeKey.includes(key) ||
      nameKey.includes(key)
    );
  });
  return uniqueById(hits).slice(0, MAX_SUGGESTIONS);
}

/**
 * Resolve whatever the client sent for one line into a catalogue product.
 *
 * Order matters and is deliberate:
 *   1. `productId` — a picker sent it, trust it (but fall through rather than
 *      hard-fail if the id is stale, so a good code/name still saves the line).
 *   2. `productCode` — exact, then folded.
 *   3. `productName` — folded against CODE first, because operators routinely
 *      type the code into the name box (that is exactly what happened in the
 *      reported case), then against the name.
 *
 * A folded match that hits more than one product is `ambiguous`, never a
 * silent pick — guessing which VICTORIA BEDFRAME to build is worse than
 * asking.
 */
export function resolveCatalogueProduct(
  ref: ProductRef,
  catalogue: CatalogueProduct[],
): ProductResolution {
  const id = String(ref.productId ?? "").trim();
  const code = String(ref.productCode ?? "").trim();
  const name = String(ref.productName ?? "").trim();

  if (id) {
    const hit = catalogue.find((p) => p.id === id);
    if (hit) return { status: "resolved", product: hit, matchedOn: "id" };
  }

  const tryField = (
    raw: string,
    field: "code" | "name",
  ): ProductResolution | null => {
    if (!raw) return null;
    const lower = raw.toLowerCase();

    const exact = catalogue.filter((p) => p.code.toLowerCase() === lower);
    if (exact.length === 1)
      return { status: "resolved", product: exact[0], matchedOn: field };

    const key = normaliseProductKey(raw);
    if (!key) return null;

    const byCode = uniqueById(
      catalogue.filter((p) => normaliseProductKey(p.code) === key),
    );
    if (byCode.length === 1)
      return { status: "resolved", product: byCode[0], matchedOn: field };
    if (byCode.length > 1)
      return { status: "ambiguous", typed: raw, candidates: byCode.slice(0, 6) };

    const byName = uniqueById(
      catalogue.filter(
        (p) =>
          p.name.toLowerCase() === lower || normaliseProductKey(p.name) === key,
      ),
    );
    if (byName.length === 1)
      return { status: "resolved", product: byName[0], matchedOn: field };
    if (byName.length > 1)
      return { status: "ambiguous", typed: raw, candidates: byName.slice(0, 6) };

    return null;
  };

  const fromCode = tryField(code, "code");
  if (fromCode) return fromCode;
  const fromName = tryField(name, "name");
  if (fromName) return fromName;

  const typed = code || name || id;
  if (!typed) return { status: "blank" };
  return {
    status: "unknown",
    typed,
    suggestions: suggestFor(normaliseProductKey(typed), catalogue),
  };
}

// ---------------------------------------------------------------------------
// Line validation
// ---------------------------------------------------------------------------

export type SpawnLineInput = ProductRef & {
  qty?: number | string | null;
  resolutionFgBatchId?: string | null;
};

/** One refusal, tied to the row the operator can see. */
export type LineProblem = {
  /** 1-based, matching the row order in the dialog. */
  lineNo: number;
  /** What the operator typed, for the "Line 2 (…)" prefix. Empty when blank. */
  typed: string;
  /** Plain English: what is wrong and what to do. Never a DB identifier. */
  message: string;
};

export type ValidatedLine = {
  lineNo: number;
  productId: string | null;
  productCode: string | null;
  productName: string | null;
  qty: number;
  resolutionFgBatchId: string | null;
};

export type SpawnValidation = {
  problems: LineProblem[];
  lines: ValidatedLine[];
};

function describe(p: CatalogueProduct): string {
  return p.name ? `${p.code} — ${p.name}` : p.code;
}

function lineLabel(lineNo: number, typed: string): string {
  return typed ? `Line ${lineNo} (${typed})` : `Line ${lineNo}`;
}

/**
 * Decide, per line, whether this mode can proceed — and hand back the
 * resolved product so the caller never has to re-derive it.
 *
 * `mode === null` is treated as "nothing decided yet": no product rule is
 * applied, because no side-effect has been chosen. The dialog requires a mode
 * before it will submit.
 */
export function validateSpawnLines(
  mode: ServiceMode | null | undefined,
  lines: SpawnLineInput[],
  catalogue: CatalogueProduct[],
): SpawnValidation {
  const spec = modeSpec(mode);
  const needsProduct = spec?.requiresCatalogueProduct ?? false;
  const problems: LineProblem[] = [];
  const out: ValidatedLine[] = [];

  lines.forEach((ln, idx) => {
    const lineNo = idx + 1;
    const res = resolveCatalogueProduct(ln, catalogue);
    const qty = Math.max(1, Math.floor(Number(ln.qty)) || 1);

    let productId: string | null = null;
    let productCode: string | null = null;
    let productName: string | null = null;

    if (res.status === "resolved") {
      productId = res.product.id;
      productCode = res.product.code;
      productName = res.product.name;
    } else {
      // Keep whatever the operator typed — a Repair line is allowed to be a
      // description, and echoing it back is what makes the error readable.
      productCode = String(ln.productCode ?? "").trim() || null;
      productName = String(ln.productName ?? "").trim() || null;
    }

    if (needsProduct && res.status !== "resolved") {
      const typed =
        res.status === "blank" ? "" : (res as { typed: string }).typed;
      const rule = spec!.productRule;
      let message: string;
      if (res.status === "blank") {
        message = `${lineLabel(lineNo, "")}: no product chosen. ${rule} Pick one from the Product list.`;
      } else if (res.status === "ambiguous") {
        message = `${lineLabel(lineNo, typed)}: more than one catalogue product matches (${res.candidates
          .map((p) => p.code)
          .join(", ")}). Pick the exact one from the Product list.`;
      } else if (res.suggestions.length > 0) {
        message = `${lineLabel(lineNo, typed)}: no catalogue product has that code. Did you mean ${res.suggestions
          .map(describe)
          .join(" or ")}? ${rule} Pick it from the Product list.`;
      } else {
        message = `${lineLabel(lineNo, typed)}: no catalogue product has that code. ${rule} Pick one from the Product list, or switch this order to Repair if the item is not in the catalogue.`;
      }
      problems.push({ lineNo, typed, message });
    }

    if (!needsProduct && !productName && !productCode && !productId) {
      problems.push({
        lineNo,
        typed: "",
        message: `${lineLabel(lineNo, "")}: name the item, or pick it from the Product list.`,
      });
    }

    out.push({
      lineNo,
      productId,
      productCode,
      productName,
      qty,
      resolutionFgBatchId:
        String(ln.resolutionFgBatchId ?? "").trim() || null,
    });
  });

  return { problems, lines: out };
}

/**
 * Fold the per-line problems into the ONE sentence a toast can carry.
 * Always ends by saying nothing was written, because the operator's next
 * question after a red toast is "did half of it save?".
 */
export function spawnProblemsMessage(problems: LineProblem[]): string {
  if (problems.length === 0) return "";
  return `${problems.map((p) => p.message).join(" ")} Nothing was created — fix that and spawn again.`;
}
