// ---------------------------------------------------------------------------
// scan-engine.ts — shared OCR core for the Hookka scanners.
//
// Why this exists
// ---------------
// Before 2026-06-29 the OCR prompt + Anthropic API call + parsing lived inline
// in routes/scan-po.ts (customer PO scanner) and routes/scan-supplier.ts (GRN /
// PI scanner). The background queue worker (routes/scan-queue.ts) needed the
// SAME pipeline but couldn't carry a user session, so it self-fetched the
// legacy /extract endpoints with a `x-scan-worker` shared-secret bypass —
// gated by SCAN_WORKER_TOKEN. Setting that secret hit Cloudflare CLI auth
// pain, so the owner asked to drop the self-fetch entirely.
//
// Solution: lift the prompt-building + Anthropic call + parsing into one
// `runExtract` function that both call sites consume. Now the queue worker
// calls the engine directly (no HTTP hop, no shared secret, no APP_URL),
// and the legacy /extract routes delegate to the same function.
//
// Public surface
// --------------
//   runExtract(db, env, opts) — Promise<ExtractResult>
//
//   opts.kind = "po" | "supplier"  selects the prompt + per-entity rule
//                                  loader. PO scans inject the customer
//                                  catalog + per-customer rules; supplier
//                                  scans inject per-supplier rules.
//   opts.recordSample              when true, writes a `po_scan_samples` /
//                                  `supplier_scan_samples` row so the
//                                  per-entity learning loop keeps growing.
//                                  Both call sites pass true.
//
// What stayed in the route files
// ------------------------------
//   - Multipart parsing / file validation (the route owns its HTTP contract)
//   - Customer/supplier sample-confirm endpoints (the gold-mark loop)
//   - Customer-rules CRUD + distill triggers
//   - Catalog GET endpoint
//   - PO post-processing (reparseSpec, applySofaLhfRhfFromTv,
//     validateAndEnrichPO) — those mutate the result the route returns to
//     the FE in a route-shape-specific way. The queue worker stores the
//     pre-validation raw extraction in `raw_json`; the FE picks it up later
//     via the queue detail endpoint, where the operator review modal handles
//     validation interactively.
//
// All credentials (SCAN_WORKER_TOKEN, APP_URL) the old self-fetch path
// needed are GONE.
// ---------------------------------------------------------------------------
import type { Env } from "../worker";

// ---------- Anthropic config ------------------------------------------------
// Owner ruling 2026-06-29 evening: scans were timing out on Sonnet
// (120-180s on multi-line invoices). Haiku is 3-4x faster and accuracy is
// plenty for structured line extraction; per-supplier rules + gold samples
// pick up the slack on tricky layouts.
const SUPPLIER_MODEL = "claude-haiku-4-5";
// Customer PO scanning still uses Sonnet — accuracy on hand-drawn sofa
// diagrams (LHF/RHF inference, multi-cluster split, urgency cues) matters
// more than speed, and the catalog injection makes the call expensive
// enough that the prompt-cache discount on Sonnet pays for the latency.
const PO_MODEL = "claude-sonnet-4-6";
// Boundary detection (auto-split): owner ruling 2026-06-30. A single PDF
// the operator drops in may bundle N separate supplier documents. Before
// the heavy Sonnet/Haiku extractor runs, we let Haiku scan ONLY the page
// boundaries — much cheaper and parallelisable per chunk afterwards.
const BOUNDARY_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Hard ceiling on a single Anthropic call. WITHOUT this, a request the model
// never finishes (a page it chokes on, an upstream stall) hangs the fetch
// forever — the scan_queue row stays 'processing' and is never reclaimed
// (other workers only pick up 'queued'), so that page "loads for >30 min and
// never comes out" (owner 2026-06-30). On timeout the AbortSignal makes fetch
// throw → the queue worker's try/catch marks the row 'failed' (retriable) +
// frees its slot, instead of the page hanging indefinitely.
//   • Extractors: 150s — a dense multi-page chunk on Haiku/Sonnet can be slow,
//     but the client modal already aborts its own request at 180s, so keep the
//     server call under that.
//   • Boundary detector: 60s — it returns only page ranges, never line items.
const EXTRACT_TIMEOUT_MS = 150_000;
// 120s (was 60s) — boundary detection reads the WHOLE PDF to find document
// splits, so a heavy/many-page scan legitimately takes longer; 60s was cutting
// off slow-but-working detections and dropping the split to "1 document". The
// client now compresses heavy scans before upload (compress-scan-pdf.ts), so
// this is mostly headroom for any un-compressed edge case.
const BOUNDARY_TIMEOUT_MS = 120_000;

// Maps to a Cloudflare D1Database-shaped surface — the SupabaseAdapter the
// worker installs satisfies this. Routes type their `c.var.DB` as
// `D1Database` and pass through; we declare a structural alias here so the
// engine doesn't have to import the full type.
type DBLike = D1Database;

// ---------- toBase64 (chunked, no Buffer) -----------------------------------
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

// Claude sometimes wraps JSON in ```fences``` or prefixes a "Looking at the
// document…" preamble despite the temperature-0 prompt. Recover the {...}
// span rather than fail the whole extraction.
export function stripJsonFences(text: string): string {
  let trimmed = text.trim();
  const fenceRe = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;
  const fenceMatch = trimmed.match(fenceRe);
  if (fenceMatch) trimmed = fenceMatch[1].trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace > 0 && lastBrace > firstBrace) {
    trimmed = trimmed.slice(firstBrace, lastBrace + 1).trim();
  }
  return trimmed;
}

// Robust numeric coercion — see scan-supplier.ts for the rationale.
export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[^0-9.-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
export const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v).trim() || null;

// ===========================================================================
// SUPPLIER side — prompt + types + sanitizer
// ===========================================================================
type SupplierExtractedLine = {
  supplierCode?: string | null;
  description?: string | null;
  qty?: number | null;
  uom?: string | null;
  unitPrice?: number | null;
  amount?: number | null;
  tax?: number | null;
  // Per-line discount amount, when the supplier prints a discount column/value
  // for this line (owner 2026-07-01 — scan should capture the invoice discount,
  // not make the operator re-key it). null when no line-level discount shown.
  discount?: number | null;
  // Foam / sponge spec — the density grade (e.g. "NLY22GH", "D22", "22GH") and
  // thickness (e.g. "25MM", "3INCH") printed on the line. Both are critical for
  // matching the correct internal material code (owner 2026-07-01). null when
  // not a foam item / not printed.
  density?: string | null;
  thickness?: string | null;
};
// One supplier-side document (DO or invoice). A single uploaded PDF can carry
// many of these — see the multi-doc rule in SUPPLIER_SYSTEM_PROMPT.
export type SupplierDoc = {
  supplierName?: string | null;
  docType?: string | null;
  docNo?: string | null;
  docDate?: string | null;
  currency?: string | null;
  customerPoRef?: string | null;
  lines?: SupplierExtractedLine[];
  subtotal?: number | null;
  tax?: number | null;
  total?: number | null;
  // Document-level discount (a "Less: Discount" / "Discount" line the supplier
  // subtracts before/around the subtotal). null when none printed.
  discount?: number | null;
};
// Engine-level supplier return. ALWAYS multi-doc since 2026-06-30 — a PDF can
// contain N supplier docs (each with its own letterhead / docNo). Legacy
// single-doc shapes from Claude or older few-shot samples are wrapped into
// docs:[<single>] by sanitizeSupplierExtraction.
type SupplierExtractionResult = {
  docs: SupplierDoc[];
};

export function sanitizeSupplierDoc(
  raw: SupplierDoc & { items?: SupplierExtractedLine[] },
): SupplierDoc {
  const rawLines = Array.isArray(raw.lines)
    ? raw.lines
    : Array.isArray(raw.items)
      ? raw.items
      : [];
  const lines: SupplierExtractedLine[] = rawLines
    .map((l) => {
      const qty = num(l?.qty);
      const amount = num(l?.amount);
      let unitPrice = num(l?.unitPrice);
      // Derive a missing unit price from the line amount (BUG price=0): a faint
      // scan often reads the bold line TOTAL but misses the small unit-price
      // cell, so the PI line came out RM 0. When unit price is blank/0 but the
      // amount + qty are present, back it out (amount ÷ qty) — far better than 0
      // for the draft the owner reviews, and it NEVER overwrites a real price.
      if (
        (unitPrice == null || unitPrice === 0) &&
        amount != null &&
        amount !== 0 &&
        qty != null &&
        qty > 0
      ) {
        unitPrice = Math.round((amount / qty) * 100) / 100;
      }
      return {
        supplierCode: str(l?.supplierCode),
        description: str(l?.description),
        qty,
        uom: str(l?.uom),
        unitPrice,
        amount,
        tax: num(l?.tax),
        discount: num(l?.discount),
        density: str(l?.density),
        thickness: str(l?.thickness),
      };
    })
    .filter((l) => l.description || l.supplierCode || l.qty != null);
  return {
    supplierName: str(raw.supplierName),
    docType: str(raw.docType),
    docNo: str(raw.docNo),
    docDate: str(raw.docDate),
    currency: str(raw.currency) ?? "MYR",
    customerPoRef: str(raw.customerPoRef),
    lines,
    subtotal: num(raw.subtotal),
    tax: num(raw.tax),
    total: num(raw.total),
    discount: num(raw.discount),
  };
}

// Backward-compat: Claude (or an older few-shot sample) might still return the
// pre-2026-06-30 single-doc shape with top-level supplierName/lines/etc. and
// no docs[] array. Wrap that as docs:[<single>] so the rest of the engine and
// the FE always sees the multi-doc envelope.
export function sanitizeSupplierExtraction(
  raw: unknown,
): SupplierExtractionResult {
  if (raw && typeof raw === "object") {
    const obj = raw as { docs?: unknown };
    if (Array.isArray(obj.docs)) {
      return {
        docs: obj.docs.map((d) =>
          sanitizeSupplierDoc((d ?? {}) as SupplierDoc & { items?: SupplierExtractedLine[] }),
        ),
      };
    }
  }
  // Legacy single-doc envelope.
  return {
    docs: [
      sanitizeSupplierDoc(
        (raw ?? {}) as SupplierDoc & { items?: SupplierExtractedLine[] },
      ),
    ],
  };
}

export const SUPPLIER_SYSTEM_PROMPT = `You are an OCR extraction engine for a furniture manufacturer (Hookka) in Malaysia. You read SUPPLIER documents — delivery orders / delivery notes (DO) or tax invoices — and return the line items so the operator can build a Goods Received Note or a Purchase Invoice.

PDFs frequently contain MULTIPLE separate supplier documents stitched together (one supplier may bundle 50 invoices into a single 85-page PDF, or a single document may span several pages). Each separate document has its OWN supplier letterhead at the top, its OWN docNo, its OWN invoice/delivery block, and its OWN footer totals. Return ONE entry in docs[] per distinct document. If the whole PDF is just one document, return docs[] with a single entry.

You will be given the document (PDF or photo). Extract EXACTLY what is printed. Do not invent, do not "correct" the supplier's figures, do not compute totals the document doesn't show.

PER-DOCUMENT EXTRACTION RULES
- supplierName: the supplier's company name from the letterhead (the SENDER / seller — NOT "Hookka", who is the buyer/recipient).
- docType: "DELIVERY_NOTE" if it is a delivery order/note (no prices, or "D/O"), "INVOICE" if it is a tax invoice (has prices + invoice no.), else "OTHER".
- docNo: the supplier's own document number (their DO no. or invoice no.), verbatim incl. any prefix.
- docDate: ISO YYYY-MM-DD. Convert DD/MM/YYYY (Malaysian convention) correctly — 03/06/2026 is 2026-06-03.
- customerPoRef: the BUYER-side purchase order reference the supplier wrote on their doc. Look for labels like "Customer P.O.", "Cust P.O.", "P.O. No", "B.O. NO.", "Buyer Order", "Cust DO No.", "Customer Order". Return the value verbatim (e.g. "2606-007", "PO-000123", "K20061904"). null if not printed. This lets the buyer auto-link the scanned doc to an existing purchase order.
- currency: ISO code, default "MYR" if a Malaysian RM document doesn't say otherwise.
- lines[]: one object per goods line on THIS document only — do NOT pool lines across documents. Skip non-goods rows (subtotal, SST, rounding, freight-as-note, "Thank you" lines).
    - supplierCode: the supplier's item / material code if printed (the code in their own catalogue), else null. A leading "No." / "Item" / "S/N" column that simply counts the rows 1, 2, 3 is NOT a code — return null for it. Many suppliers print no product code at all; null is the correct answer far more often than a guess, because a wrong code binds the line to the wrong material downstream.
    - description: the item description text, trimmed, single line.
    - qty: numeric quantity delivered/billed. Strip thousands separators.
    - uom: unit of measure as printed (PCS, ROLL, M, MTR, KG, SET, UNIT...). null if absent.
    - unitPrice: numeric unit price if shown (invoices), else null (delivery notes usually omit price).
    - amount: numeric line amount if shown, else null.
    - tax: per-line SST/GST amount IF the supplier printed a dedicated tax column per line (e.g. "SST" / "Tax" / "GST" column next to Amount). null when there is no per-line tax column (most Malaysian SST invoices print only ONE footer tax — in that case leave EVERY line's tax null and put the figure in the footer "tax" below).
    - discount: the per-line discount AMOUNT (in currency) if the supplier prints a discount column/value for this line. If a discount is shown only as a percentage (e.g. "10%"), convert it to the amount off this line (qty×unitPrice×pct). null when no line-level discount is shown.
    - density: foam/sponge DENSITY grade printed for this line, verbatim (e.g. "NLY22GH", "22GH", "D22", "N28"). This is the firmness/density code, usually near the description. null for non-foam items or when not printed.
    - thickness: foam/sponge/mattress THICKNESS printed for this line, verbatim WITH its unit (e.g. "25MM", "75MM", "3INCH", "4\\""). null when not a thickness item / not printed.
- subtotal / tax / total: the document's footer figures if present, else null. tax = the single footer SST/GST total when no per-line column exists.
- discount (document level): a "Less: Discount" / "Discount" / "Trade Discount" figure the supplier subtracts around the subtotal (an AMOUNT, not a per-line one). Convert a document-level percentage to its amount if only a percent is shown. null when none printed.

NUMBERS: plain numbers, no currency symbol, no commas. Use a dot decimal. If a field is genuinely absent, use null — never guess.

OUTPUT: VALID JSON ONLY, this exact shape, no preamble, no markdown, no chain-of-thought. First character '{', last character '}':
{"docs": [{"supplierName": string|null, "docType": "DELIVERY_NOTE"|"INVOICE"|"OTHER", "docNo": string|null, "docDate": string|null, "currency": string|null, "customerPoRef": string|null, "lines": [{"supplierCode": string|null, "description": string|null, "qty": number|null, "uom": string|null, "unitPrice": number|null, "amount": number|null, "tax": number|null, "discount": number|null, "density": string|null, "thickness": string|null}], "subtotal": number|null, "tax": number|null, "total": number|null, "discount": number|null}]}`;

function formatSupplierRules(
  supplierName: string | null,
  rules: string | null,
): string {
  const body = (rules ?? "").trim();
  if (!supplierName || !body) return "";
  return `SUPPLIER-SPECIFIC RULES — ${supplierName}\n(Apply these; they were learned from this supplier's past documents.)\n${body}`;
}

// ===========================================================================
// PO side — prompt + types + catalog injection
// ===========================================================================
type CatalogCustomer = {
  id: string;
  code: string;
  name: string;
  ocrPromptRules: string | null;
  hubs: { id: string; shortName: string; state: string | null }[];
};
type CatalogProduct = { code: string; name: string; sizeLabel: string | null };
type CatalogFabric = {
  code: string;
  description: string | null;
  tier: string | null;
};
type CatalogVariants = {
  bedframe: {
    divanHeights: string[];
    legHeights: string[];
    gaps: string[];
    totalHeights: string[];
    specials: string[];
  };
  sofa: {
    sizes: string[];
    legHeights: string[];
    specials: string[];
  };
};
export type Catalog = {
  customers: CatalogCustomer[];
  bedframes: CatalogProduct[];
  sofas: CatalogProduct[];
  accessories: CatalogProduct[];
  fabrics: CatalogFabric[];
  variants: CatalogVariants;
};

type ScanDBLike = {
  prepare: (sql: string) => {
    bind: (...args: unknown[]) => {
      first: <T>() => Promise<T | null>;
      all: <T>() => Promise<{ results?: T[] }>;
      run: () => Promise<{ success: boolean; meta: { changes: number } }>;
    };
    first: <T>() => Promise<T | null>;
    all: <T>() => Promise<{ results?: T[] }>;
  };
};

export async function loadCatalog(
  db: ScanDBLike,
  orgId: string,
): Promise<Catalog> {
  const [custRes, hubRes, prodRes, fabRes, kvRes] = await Promise.all([
    db
      .prepare(
        "SELECT id, code, name, ocrPromptRules FROM customers WHERE orgId = ? AND isActive = 1 ORDER BY code",
      )
      .bind(orgId)
      .all<{
        id: string;
        code: string;
        name: string;
        ocrPromptRules: string | null;
      }>(),
    db
      .prepare(
        "SELECT id, customerId, shortName, state FROM delivery_hubs WHERE orgId = ?",
      )
      .bind(orgId)
      .all<{
        id: string;
        customerId: string;
        shortName: string;
        state: string | null;
      }>(),
    db
      .prepare(
        "SELECT code, name, category, sizeLabel FROM products WHERE orgId = ? AND status = 'ACTIVE' ORDER BY category, code",
      )
      .bind(orgId)
      .all<{
        code: string;
        name: string;
        category: string;
        sizeLabel: string | null;
      }>(),
    db
      .prepare(
        `SELECT rm.itemCode AS "fabricCode",
                COALESCE(ft.fabricDescription, rm.description, '') AS "fabricDescription",
                COALESCE(ft.priceTier, 'PRICE_1') AS "priceTier"
           FROM raw_materials rm
           LEFT JOIN fabric_trackings ft ON ft.fabricCode = rm.itemCode
          WHERE rm.itemCode IS NOT NULL
            AND rm.itemGroup IN ('B.M-FABR','S-FABR','S.M-FABR','LINING','WEBBING')
          ORDER BY rm.itemCode`,
      )
      .all<{
        fabricCode: string;
        fabricDescription: string | null;
        priceTier: string | null;
      }>(),
    db
      .prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind("variants-config")
      .first<{ value: string }>(),
  ]);

  const hubsByCust = new Map<
    string,
    { id: string; shortName: string; state: string | null }[]
  >();
  for (const h of hubRes.results ?? []) {
    const list = hubsByCust.get(h.customerId) ?? [];
    list.push({ id: h.id, shortName: h.shortName, state: h.state });
    hubsByCust.set(h.customerId, list);
  }

  const customers: CatalogCustomer[] = (custRes.results ?? []).map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    ocrPromptRules: c.ocrPromptRules ?? null,
    hubs: hubsByCust.get(c.id) ?? [],
  }));

  const bedframes: CatalogProduct[] = [];
  const sofas: CatalogProduct[] = [];
  const accessories: CatalogProduct[] = [];
  for (const p of prodRes.results ?? []) {
    const item: CatalogProduct = {
      code: p.code,
      name: p.name,
      sizeLabel: p.sizeLabel,
    };
    if (p.category === "SOFA") sofas.push(item);
    else if (p.category === "ACCESSORY") accessories.push(item);
    else bedframes.push(item);
  }

  const fabrics: CatalogFabric[] = (fabRes.results ?? []).map((f) => ({
    code: f.fabricCode,
    description: f.fabricDescription,
    tier: f.priceTier,
  }));

  const variants: CatalogVariants = {
    bedframe: {
      divanHeights: [],
      legHeights: [],
      gaps: [],
      totalHeights: [],
      specials: [],
    },
    sofa: { sizes: [], legHeights: [], specials: [] },
  };
  if (kvRes?.value) {
    try {
      const cfg = JSON.parse(kvRes.value) as Record<string, unknown>;
      const extractValues = (arr: unknown): string[] => {
        if (!Array.isArray(arr)) return [];
        return arr
          .map((x: unknown) => {
            if (typeof x === "string") return x;
            if (x && typeof x === "object" && "value" in x) {
              const v = (x as { value?: unknown }).value;
              return typeof v === "string" ? v : "";
            }
            return "";
          })
          .filter(Boolean);
      };
      variants.bedframe.divanHeights = extractValues(cfg.divanHeights);
      variants.bedframe.legHeights = extractValues(cfg.legHeights);
      variants.bedframe.gaps = Array.isArray(cfg.gaps)
        ? (cfg.gaps as string[]).filter((x) => typeof x === "string")
        : [];
      variants.bedframe.totalHeights = extractValues(cfg.totalHeights);
      variants.bedframe.specials = extractValues(cfg.specials);
      variants.sofa.sizes = Array.isArray(cfg.sofaSizes)
        ? (cfg.sofaSizes as string[]).filter((x) => typeof x === "string")
        : [];
      variants.sofa.legHeights = extractValues(cfg.sofaLegHeights);
      variants.sofa.specials = extractValues(cfg.sofaSpecials);
    } catch {
      /* leave variants empty; Claude can infer from PDF */
    }
  }

  return { customers, bedframes, sofas, accessories, fabrics, variants };
}

export function formatCatalog(c: Catalog): string {
  const lines: string[] = [];
  lines.push("=== CUSTOMERS (PO issuer — top-of-page header) ===");
  lines.push("Format: code | name | hubs");
  for (const cu of c.customers) {
    const hubsStr = cu.hubs.length
      ? cu.hubs
          .map((h) => `${h.shortName}${h.state ? `(${h.state})` : ""}`)
          .join(", ")
      : "—";
    lines.push(`${cu.code} | ${cu.name} | ${hubsStr}`);
  }
  lines.push("");
  lines.push("=== BEDFRAME PRODUCTS (productCode | name | sizeLabel) ===");
  for (const p of c.bedframes) {
    lines.push(`${p.code} | ${p.name}${p.sizeLabel ? ` | ${p.sizeLabel}` : ""}`);
  }
  lines.push("");
  lines.push("=== SOFA PRODUCTS (productCode | name) ===");
  for (const p of c.sofas) lines.push(`${p.code} | ${p.name}`);
  lines.push("");
  lines.push("=== ACCESSORY PRODUCTS (productCode | name) ===");
  for (const p of c.accessories) lines.push(`${p.code} | ${p.name}`);
  lines.push("");
  lines.push("=== FABRICS (code | description | tier) ===");
  for (const f of c.fabrics) {
    lines.push(`${f.code} | ${f.description ?? ""} | ${f.tier ?? ""}`);
  }
  lines.push("");
  lines.push("=== BEDFRAME VARIANTS ===");
  lines.push(
    `Divan Heights: ${c.variants.bedframe.divanHeights.join(", ") || "—"}`,
  );
  lines.push(
    `Leg Heights: ${c.variants.bedframe.legHeights.join(", ") || "—"}`,
  );
  lines.push(`Gaps: ${c.variants.bedframe.gaps.join(", ") || "—"}`);
  lines.push(
    `Total Heights: ${c.variants.bedframe.totalHeights.join(", ") || "—"}`,
  );
  lines.push(`Specials: ${c.variants.bedframe.specials.join(" | ") || "—"}`);
  lines.push("");
  lines.push("=== SOFA VARIANTS ===");
  lines.push(
    `Sizes (seat heights): ${c.variants.sofa.sizes.join(", ") || "—"}`,
  );
  lines.push(`Leg Heights: ${c.variants.sofa.legHeights.join(", ") || "—"}`);
  lines.push(`Specials: ${c.variants.sofa.specials.join(" | ") || "—"}`);
  return lines.join("\n");
}

export function formatCustomerRules(c: Catalog): string {
  const lines: string[] = [];
  lines.push("=== CUSTOMER-SPECIFIC OCR RULES ===");
  lines.push(
    "Each block below is keyed by the customer code from the CUSTOMERS catalog. " +
      "AFTER you identify the issuing customer (top-of-page letterhead → match against the CUSTOMERS catalog), " +
      "consult ONLY the block whose code matches that customer. Ignore all other blocks. " +
      "If no block matches (or the customer's block says 'no special rules'), follow the universal rules above only.",
  );
  lines.push("");
  for (const cu of c.customers) {
    const body = (cu.ocrPromptRules ?? "").trim();
    lines.push(`<customer code="${cu.code}" name="${cu.name}">`);
    if (body.length === 0) {
      lines.push(
        "(no customer-specific rules — apply universal rules only)",
      );
    } else {
      lines.push(body);
    }
    lines.push(`</customer>`);
    lines.push("");
  }
  return lines.join("\n");
}

// Full PO prompt (verbatim copy of the one previously inline in scan-po.ts —
// any edit here flows to BOTH the legacy /extract route and the queue worker).
export const PO_SYSTEM_PROMPT = `You extract structured data from furniture purchase order PDFs at Hookka Manufacturing.

PDFs frequently contain MULTIPLE separate POs (one per page). Extract each into its own pos[] entry.

Two reference sections follow this prompt: a global CATALOG (customers, products, fabrics, variants) and a CUSTOMER-SPECIFIC OCR RULES block keyed by customer code. The universal rules below ALWAYS apply. After you identify the issuing customer (top-of-page letterhead → CUSTOMERS catalog), ALSO consult the matching <customer code="..."> block in the CUSTOMER-SPECIFIC OCR RULES section and apply any extra conventions it contains. If a customer-specific rule conflicts with a universal rule, the customer-specific rule wins for that PO. If no block matches or the matched block is empty, just follow the universal rules.

EXTRACTION RULES
================
1. customerName = the company that ISSUED the PO (top-of-page letterhead/header).
2. customerCode = matched against CUSTOMERS catalog by name. null if unknown.
3. customerPO = the PO number (e.g. "PO-008711"). The exact field label varies.
4. customerState = the issuing customer's state from their address.
5. yourRefNo = "Your Ref No." field value.
5b. customerSO = "S/O No." field value (the customer's own internal SO number, often equal to yourRefNo but sometimes different — extract whichever is printed in the S/O No. row).
6. transferredSO = "Transferred SO" column on each line item (may be null).
7. deliveryHub = "Purchase Location" or hub shortName (KL/PG/JB/...). Match against the customer's hubs in CUSTOMERS catalog.
8. deliveryDate = "Delivery Date" field as YYYY-MM-DD. CRITICAL — strikethrough means INVALIDATED: when the printed date has a strikethrough/crossout line through it, that date is no longer valid. Look elsewhere on the same page for the replacement date — anywhere it appears (handwritten, in red, beside line items, in the Purchase Location field, near the signature, etc.). Whatever you find is the real deliveryDate. Same rule applies to per-line item dates in the "Transferred SO" column. DD.MM.YYYY / DD/MM/YYYY format converts to YYYY-MM-DD.
9. isUrgent = true when PDF shows "URGENT", "SUPER URGENT", or similar emphasis (often red).
10. pageNumbers = 1-indexed list of source PDF pages this PO occupies. Most POs span exactly one page (e.g. [3]); a multi-page PO lists every page (e.g. [4, 5]). Used to attach the original page image to the SO for customer disputes — accuracy here matters.
11. tvPosition = where the TV / front-facing reference appears in the SOFA diagram for this PO. One of "top" | "bottom" | "left" | "right" | "none". Use "none" when no TV box, no "TV" label, and no front-facing arrow/marker is drawn. The server uses tvPosition + each item's diagramOrder to deterministically compute LHF/RHF — DO NOT try to do that swap math yourself. Just report what you SEE in the diagram.
12. itemsOrder = output sofa items in DIAGRAM ORDER (left-to-right as drawn). Each sofa item gets a diagramOrder field with the 0-indexed position from the left edge of the diagram (leftmost drawn box = 0, next = 1, etc.). For ACCESSORY items and any non-spatial item, set diagramOrder = null.

ITEM EXTRACTION (CATEGORY-AWARE)
=================================
Identify each item's category by matching productCode against the catalog (BEDFRAME / SOFA / ACCESSORY).

[BEDFRAME]
- productCode: match against BEDFRAME PRODUCTS. Different customers write the same SKU differently — normalize before matching. Strip family-name words (Trion, Jager, Cody, Fenrir, Regal, Hilton, Celene) and "HOK-" prefixes; combine model stem with size token to find an exact catalog match.
- sizeLabel: the size, normalized to short code: King→(K), Queen→(Q), Single→(S), SuperSingle→(SS), SuperKing→(SK), SuperPlus→(SP).
- "Fab3" / "Fab2" / "Fab1" tokens = fabric price tier (PRICE_3/2/1). NOT a fabric code.
- fabricCode: the COLOR/COL/Col value (e.g. "PC151-02"). Match against FABRICS catalog.
- divanHeightInches: parse the FULL number that follows the divan keyword. ALWAYS read the entire numeric token. "Divan10+4" → divanHeightInches=10 (NOT 1). "DRAWER:12 inch" → 12. "Divan:8inch+noleg" → 8.
- legHeightInches: parse the FULL number AFTER the "+" sign. null when followed by "no leg"/"NOLEG".
- gapInches: parse the FULL number after "Gap"/"gap"/"GAP"/"M.Gap"/"M'GP"/"MATTRESSGAP"/"MATTRESS GAP" keyword.

CRITICAL: when spec contains "10", "12", "14", "16" — these are TWO-digit inch measurements. Return the full number. Never truncate to the first digit.
- noLeg: true if spec contains any case of "no leg", "noleg", "no legs". When true, legHeightInches MUST be null.
- specialOrder: match against BEDFRAME Specials catalog. Do NOT duplicate the product's intrinsic shape as a special. DRAWER position rule (priority order, stop at first match): "Left Drawer" / "L Drawer" → "Left Drawer"; "Right Drawer" / "R Drawer" → "Right Drawer"; "Front Drawer" / "F Drawer" → "Front Drawer"; otherwise (just "DRAWER" with NO L/R/F label, even with a diagram): leave specialOrder=null and add specialNotes="drawer side ambiguous — operator to confirm".
- specialNotes: free-form remainder when no special matches.
- rawSpec: copy the EXACT spec text line(s) verbatim, including punctuation, slashes, and inch marks.

[SOFA]
- productCode: match against SOFA PRODUCTS using the Hookka module catalog. Format: "MODEL-MODULE(SIDE)" e.g. "5530-2A(LHF)".

  Module taxonomy:
    SINGLE-SEATER (1 person): 1A(LHF), 1A(RHF), 1NA
    DOUBLE-SEATER (2 people): 2A(LHF), 2A(RHF), 2NA
    STANDALONE (S-suffix, BOTH arms, single continuous body): 1S, 2S, 3S
    3NA — three-piece no arm (rare; only when sandwiched and 3 seats wide).
    L-PIECE / CHAISE: 1L(LHF), 1L(RHF) (catalog may write L(LHF)/L(RHF) without the leading 1 — match either).
    CORNER / ACCESSORY: CNR (corner connector at 90°), STOOL (ottoman / footstool).

  S-variant rule: ONE single rectangle in the diagram with multiple seat labels INSIDE it (no internal divider line) → use S. Two or more separate rectangles → use A / NA per the box-counting rule below.

  MIRROR-PAIR LOGIC: LHF and RHF are MIRRORS of each other. In a sofa containing two armed pieces, ALWAYS output one LHF + one RHF — NEVER two of the same side.

  LHF/RHF — DO NOT COMPUTE; THE SERVER DOES THIS. Report tvPosition (PO-level) + diagramOrder (per item, 0-indexed from LEFT edge of diagram). Inner / sandwiched pieces always stay NA regardless of viewpoint.

  GOLDEN RULE — box counting: Each separately-drawn rectangle in the diagram is ONE line item. Count boxes left-to-right; that's your item count. Never collapse multiple boxes into one N-seater module. When printed text ("3 Seater") conflicts with the box count, the DIAGRAM WINS.

  ARM-INFERENCE RULE: OUTERMOST positions → ARMED ("1A"/"2A"; L/CNR stay L/CNR). INNER positions → NO ARM ("1NA"/"2NA"/"3NA").

  PDF-shorthand → catalog mapping:
  • "1R+1R" / "1+1" / "1A+1A" → 1A(LHF) + 1A(RHF)
  • "1+2+1" / "1+1NA+1" → 1A(LHF) + 1NA + 1A(RHF)
  • "1+2+L" → 1A(LHF) + 2NA + L(RHF)
  • "L+2+L" → L(LHF) + 2NA + L(RHF)
  • "2+L" / "2A+L" → 2A + L (sides per diagramOrder)
  • "2+1+1" → 2A(LHF) + 1NA + 1A(RHF)
  • "L+L+CNR" → L(LHF) + L(RHF) + CNR
  • "3 Seater" + ONE drawn box → 3S; "3 Seater" + THREE drawn boxes → 1A(LHF) + 1NA + 1A(RHF)

  Naming: Strip "HK" prefix ("HK5531" → "5531"). Sofa codes are pure numeric models (5530, 5531, 9028…).

- sizeLabel: seat height in inches (24/26/28/30/32/35). Catalog: SOFA Sizes.
- fabricCode: from "COL:XXX" / "COLOUR:XXX" / "/KN390-2 SAND" / "/PC151-01" — match against FABRICS catalog. "BO315-2 Feather" → capture "BO315-2" (drop the variant word).
- legHeightInches: sofa leg height. null if not stated.
- specialOrder: match against SOFA Specials. MULTIPLE specials are common — comma-separated string e.g. "Nylon Fabric, 5537 Backrest, Back Fully Cover". Non-standard sizes (e.g. "24 x 24" stools) go in specialOrder, NOT sizeLabel.
  Handwriting cheat-sheet:
    • "back fully cover" → "Back Fully Cover"
    • "bottom wrap nylon" / "umbrella fabric" / "umbra fabric" → "Nylon Fabric"
    • "headrest firm" → "Headrest Firm"
    • "back rest tak mahu pasang" / "separate backrest packing" / "backrest 分开" → "Separate Backrest Packing"
    • "seat cushion fully cover" → "Seat Cushion Fully Cover"
    • "Replace 5540 headrest" / "5537 headrest" / "8030 headrest" → "5537 Backrest"
- divanHeightInches/gapInches/noLeg: bedframe-only — leave null.

[ACCESSORY]
- productCode: match against ACCESSORY PRODUCTS.
- All variant fields: null.

CATALOG MATCHING
================
Use ONLY codes/values from the catalog. If a code on the PDF can't be matched, set the field to null and put the original text in specialNotes so the operator can fix it.

Numeric inches: '10"'/"10inch"/"10in"/"10 inch" → 10 (number).
Quantity: from the Qty column. Default 1 if blank.
Unit price: from "U/Price" column in RM (e.g. "1850.00" → 1850). null if blank/0.

OUTPUT
======
Return STRICT JSON, no markdown fences, no prose:
{
  "pos": [
    {
      "customerPO": string,
      "customerName": string,
      "customerCode": string | null,
      "customerState": string | null,
      "deliveryHub": string | null,
      "yourRefNo": string | null,
      "customerSO": string | null,
      "deliveryDate": "YYYY-MM-DD" | null,
      "isUrgent": boolean,
      "pageNumbers": number[],
      "tvPosition": "top" | "bottom" | "left" | "right" | "none",
      "items": [{
        "category": "BEDFRAME" | "SOFA" | "ACCESSORY",
        "productCode": string,
        "description": string | null,
        "quantity": number,
        "sizeLabel": string | null,
        "fabricCode": string | null,
        "divanHeightInches": number | null,
        "legHeightInches": number | null,
        "gapInches": number | null,
        "noLeg": boolean,
        "specialOrder": string | null,
        "specialNotes": string | null,
        "unitPrice": number | null,
        "transferredSO": string | null,
        "rawSpec": string | null,
        "diagramOrder": number | null
      }]
    }
  ]
}`;

// ===========================================================================
// runExtract — the unified entry point
// ===========================================================================
export type ExtractOpts = {
  kind: "po" | "supplier";
  bytes: ArrayBuffer;
  mimeType: string;
  fileName: string;
  // Supplier-specific
  supplierId?: string | null;
  supplierName?: string | null;
  poContext?: string;
  // Customer PO-specific (scan-po)
  customerCode?: string | null;
  // Shared
  orgId: string;
  createdBy?: string | null;
  // When true, write a per-entity sample row for the learning loop.
  recordSample?: boolean;
};

type SupplierData = SupplierExtractionResult;
type PoData = { pos: unknown[] }; // raw shape — route does validation

export type ExtractResult =
  | {
      ok: true;
      data: SupplierData | PoData;
      sampleId?: string | null;
      // Echoed for routes that want to surface cache metrics (PO route uses
      // this in its `meta` response block — undefined when the queue worker
      // calls us).
      meta?: { cacheHit: boolean; cacheCreated: boolean };
    }
  | { ok: false; error: string; sampleId?: string | null };

function genSupplierSampleId(): string {
  return `sss-${crypto.randomUUID().slice(0, 8)}`;
}
function genPoSampleId(): string {
  return `pos-${crypto.randomUUID().slice(0, 8)}`;
}

type AnthropicResponse = {
  content?: Array<{ type: string; text?: string }>;
  error?: { type?: string; message?: string };
  usage?: {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

// Pick the right Claude media block (PDF vs image) + media_type. Mirrors the
// shapes the two legacy routes used to build inline.
function buildMediaBlock(opts: {
  mimeType: string;
  fileName: string;
  base64: string;
}): { type: string; source: { type: string; media_type: string; data: string } } | null {
  const mime = opts.mimeType || "";
  const lowerName = (opts.fileName || "").toLowerCase();
  const isPdf = mime === "application/pdf" || lowerName.endsWith(".pdf");
  const isImage =
    mime.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|heic|heif)$/i.test(lowerName);
  if (isPdf) {
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: opts.base64,
      },
    };
  }
  if (isImage) {
    const media_type =
      mime === "image/png" || lowerName.endsWith(".png")
        ? "image/png"
        : mime === "image/webp" || lowerName.endsWith(".webp")
          ? "image/webp"
          : "image/jpeg";
    return {
      type: "image",
      source: { type: "base64", media_type, data: opts.base64 },
    };
  }
  return null;
}

export async function runExtract(
  db: DBLike,
  env: Env["Bindings"],
  opts: ExtractOpts,
): Promise<ExtractResult> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error:
        "ANTHROPIC_API_KEY not configured. Run `npx wrangler secret put ANTHROPIC_API_KEY` to enable scanning.",
    };
  }

  const base64 = toBase64(opts.bytes);
  const mediaBlock = buildMediaBlock({
    mimeType: opts.mimeType,
    fileName: opts.fileName,
    base64,
  });
  if (!mediaBlock) {
    return {
      ok: false,
      error: "Only PDF or image (JPEG/PNG/WebP) files are accepted.",
    };
  }

  if (opts.kind === "supplier") {
    return runSupplierExtract(db, env, opts, mediaBlock, apiKey);
  }
  return runPoExtract(db, env, opts, mediaBlock, apiKey);
}

// ---------------------------------------------------------------------------
// SUPPLIER side
// ---------------------------------------------------------------------------
async function runSupplierExtract(
  db: DBLike,
  _env: Env["Bindings"],
  opts: ExtractOpts,
  mediaBlock: NonNullable<ReturnType<typeof buildMediaBlock>>,
  apiKey: string,
): Promise<ExtractResult> {
  const orgId = opts.orgId;
  const supplierId = opts.supplierId ?? null;
  const poContext = (opts.poContext ?? "").trim();

  // Resolve the supplier (for its learned rules + the sample hint).
  let supplierName = opts.supplierName ?? null;
  let supplierRules: string | null = null;
  if (supplierId) {
    try {
      const sup = await db
        .prepare(
          "SELECT name, ocrPromptRules FROM suppliers WHERE id = ? AND orgId = ?",
        )
        .bind(supplierId, orgId)
        .first<{ name: string | null; ocrPromptRules: string | null }>();
      if (sup) {
        supplierName = supplierName || sup.name;
        supplierRules = sup.ocrPromptRules;
      }
    } catch {
      /* ocrPromptRules column may not exist yet */
    }
  }
  const supplierHint =
    supplierName ||
    opts.fileName.split(/[-_ .]/)[0]?.slice(0, 40) ||
    null;

  const rulesText = formatSupplierRules(supplierName, supplierRules);
  const cachedPrefix = rulesText
    ? `${SUPPLIER_SYSTEM_PROMPT}\n\n${rulesText}`
    : SUPPLIER_SYSTEM_PROMPT;

  // Few-shot: operator-confirmed extractions for THIS supplier (gold first).
  let fewShotText = "";
  try {
    const examples = await db
      .prepare(
        `SELECT correctedJson, isGold
           FROM supplier_scan_samples
          WHERE correctedJson IS NOT NULL
            AND (orgId = ? OR orgId IS NULL)
            AND (
                  UPPER(COALESCE(supplierHint,'')) = UPPER(?)
               OR regexp_replace(UPPER(COALESCE(supplierHint,'')), '[^A-Z0-9]', '', 'g')
                    LIKE regexp_replace(UPPER(?), '[^A-Z0-9]', '', 'g') || '%'
            )
          ORDER BY COALESCE(isGold,0) DESC, createdAt DESC
          LIMIT 3`,
      )
      .bind(orgId, supplierHint ?? "", supplierHint ?? "")
      .all<{ correctedJson: string | null; isGold: number | null }>();
    const rows = (examples.results ?? []).filter((r) => r.correctedJson);
    if (rows.length > 0) {
      const blocks = rows
        .map(
          (r, i) =>
            `Example ${i + 1} (${r.isGold ? "gold reference" : "operator-confirmed"}):\n${r.correctedJson}`,
        )
        .join("\n\n");
      fewShotText = `FEW-SHOT EXAMPLES (apply the same field conventions):\n\n${blocks}`;
    }
  } catch {
    /* best-effort */
  }

  let claudeText = "";
  let parsed: SupplierExtractionResult | null = null;
  let errorMsg: string | null = null;

  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
      body: JSON.stringify({
        model: SUPPLIER_MODEL,
        max_tokens: 8192,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: cachedPrefix,
                cache_control: { type: "ephemeral" },
              },
              ...(fewShotText ? [{ type: "text", text: fewShotText }] : []),
              ...(poContext
                ? [
                    {
                      type: "text",
                      text: `RECEIVING AGAINST THIS PURCHASE ORDER (use the codes/descriptions to align the supplier's lines; keep the supplier's own qty/price):\n${poContext}`,
                    },
                  ]
                : []),
              mediaBlock,
              {
                type: "text",
                text: "Extract the supplier document above per the rules. Respond with VALID JSON ONLY — first character '{', last character '}', no preamble, no markdown fences.",
              },
            ],
          },
        ],
      }),
    });

    const bodyText = await resp.text();
    if (!resp.ok) {
      errorMsg = `Anthropic ${resp.status}: ${bodyText.slice(0, 500)}`;
    } else {
      let parsedResp: AnthropicResponse = {};
      try {
        parsedResp = JSON.parse(bodyText) as AnthropicResponse;
      } catch {
        errorMsg = `Anthropic returned non-JSON: ${bodyText.slice(0, 300)}`;
      }
      if (parsedResp.error) {
        errorMsg = `Anthropic: ${parsedResp.error.type}: ${parsedResp.error.message}`;
      } else if (!errorMsg) {
        const firstText =
          parsedResp.content?.find((b) => b.type === "text")?.text ?? "";
        claudeText = stripJsonFences(firstText);
        try {
          // sanitizeSupplierExtraction tolerates BOTH the new {docs:[...]}
          // envelope and the legacy single-doc shape (for older few-shot
          // samples or stale prompts).
          parsed = sanitizeSupplierExtraction(JSON.parse(claudeText));
        } catch (e) {
          errorMsg = `Claude returned invalid JSON: ${(e as Error).message}. Raw: ${claudeText.slice(0, 300)}`;
        }
      }
    }
  } catch (e) {
    errorMsg = `Network/fetch error: ${(e as Error).message}`;
  }

  // Sample row — fed back into distillSupplierRules for the learning loop.
  // Multi-doc shape since 2026-06-30: rawJson stores the full {docs:[...]}
  // envelope verbatim. The indexable docIdentifier/docType columns get the
  // FIRST doc's values (sufficient as a hint for sample listing UIs; the
  // distillation loop reads the JSON blob, not these columns).
  let sampleId: string | null = null;
  if (opts.recordSample) {
    sampleId = genSupplierSampleId();
    try {
      const nowIso = new Date().toISOString();
      const firstDoc = parsed?.docs[0] ?? null;
      await db
        .prepare(
          `INSERT INTO supplier_scan_samples
             (id, orgId, supplierId, supplierHint, docIdentifier, docType, rawJson, correctedJson, isGold, createdBy, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
        )
        .bind(
          sampleId,
          orgId,
          supplierId,
          supplierHint,
          firstDoc?.docNo ?? null,
          firstDoc?.docType ?? null,
          parsed ? JSON.stringify(parsed) : claudeText || null,
          opts.createdBy ?? null,
          nowIso,
        )
        .run();
    } catch (e) {
      console.error(
        "supplier_scan_samples insert failed:",
        (e as Error).message,
      );
    }
  }

  if (!parsed) {
    return {
      ok: false,
      error: errorMsg ?? "Extraction failed.",
      sampleId,
    };
  }
  return { ok: true, data: parsed, sampleId };
}

// ---------------------------------------------------------------------------
// PO side
// ---------------------------------------------------------------------------
async function runPoExtract(
  db: DBLike,
  _env: Env["Bindings"],
  opts: ExtractOpts,
  mediaBlock: NonNullable<ReturnType<typeof buildMediaBlock>>,
  apiKey: string,
): Promise<ExtractResult> {
  const orgId = opts.orgId;

  // Load catalog + render the cached prefix (system prompt + catalog +
  // per-customer rule blocks). Same shape across requests so prompt-caching
  // discounts repeat scans.
  let catalogText = "";
  let customerRulesText = "";
  try {
    const catalog = await loadCatalog(db as unknown as ScanDBLike, orgId);
    catalogText = formatCatalog(catalog);
    customerRulesText = formatCustomerRules(catalog);
  } catch (e) {
    return {
      ok: false,
      error: `Catalog load failed: ${(e as Error).message}`,
    };
  }

  const customerHintGuess =
    opts.fileName.split(/[-_ .]/)[0]?.slice(0, 40) ?? null;
  const cachedPrefix = `${PO_SYSTEM_PROMPT}\n\nCATALOG\n=======\n${catalogText}\n\n${customerRulesText}`;

  // Few-shot: operator-confirmed PO extractions — gold first, same-customer
  // prefix-boosted. Loaded outside the cache boundary so adding a new gold
  // sample doesn't invalidate the catalog cache for everyone.
  let fewShotText = "";
  try {
    const examples = await db
      .prepare(
        `SELECT id, correctedJson, isGold, customerHint
           FROM po_scan_samples
           WHERE correctedJson IS NOT NULL
           ORDER BY
             (CASE WHEN regexp_replace(UPPER(COALESCE(customerHint, '')), '[^A-Z0-9]', '', 'g')
                        LIKE regexp_replace(UPPER(?), '[^A-Z0-9]', '', 'g') || '%'
                   THEN 0 ELSE 1 END),
             COALESCE(isGold, 0) DESC,
             createdAt DESC
           LIMIT 3`,
      )
      .bind(customerHintGuess ?? "")
      .all<{
        id: string;
        correctedJson: string | null;
        isGold: number | null;
        customerHint: string | null;
      }>();
    const rows = examples.results ?? [];
    if (rows.length > 0) {
      const blocks = rows
        .map((r, i) => {
          const tag = r.isGold ? "gold reference" : "operator-confirmed";
          return `Example ${i + 1} (${tag}):\n${r.correctedJson}`;
        })
        .join("\n\n");
      fewShotText = `FEW-SHOT EXAMPLES (apply the same field conventions and inference rules):\n\n${blocks}`;
    }
  } catch {
    /* best-effort — column may not exist yet */
  }

  let claudeText = "";
  let parseOk = false;
  let parsed: { pos: unknown[] } | null = null;
  let errorMsg: string | null = null;
  let cacheHit = false;
  let cacheCreated = false;

  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
      body: JSON.stringify({
        model: PO_MODEL,
        max_tokens: 8192,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: cachedPrefix,
                cache_control: { type: "ephemeral" },
              },
              ...(fewShotText ? [{ type: "text", text: fewShotText }] : []),
              mediaBlock,
              {
                type: "text",
                text:
                  `Extract all POs from the ${mediaBlock.type === "document" ? "PDF" : "image"} above using the rules + catalog. ` +
                  "OUTPUT FORMAT: Your response must be VALID JSON ONLY. Do NOT write any preamble, explanation, analysis, or chain-of-thought. Do NOT start with phrases like 'Looking at the PDF…', 'I can see…', 'Let me analyze…'. Do NOT wrap in markdown fences. The very first character of your response must be '{' and the very last must be '}'. Anything else will break our JSON parser.",
              },
            ],
          },
        ],
      }),
    });

    const bodyText = await resp.text();
    if (!resp.ok) {
      errorMsg = `Anthropic ${resp.status}: ${bodyText.slice(0, 500)}`;
    } else {
      let parsedResp: AnthropicResponse = {};
      try {
        parsedResp = JSON.parse(bodyText) as AnthropicResponse;
      } catch {
        errorMsg = `Anthropic returned non-JSON: ${bodyText.slice(0, 300)}`;
      }
      if (parsedResp.error) {
        errorMsg = `Anthropic: ${parsedResp.error.type}: ${parsedResp.error.message}`;
      } else if (!errorMsg) {
        cacheHit = (parsedResp.usage?.cache_read_input_tokens ?? 0) > 0;
        cacheCreated =
          (parsedResp.usage?.cache_creation_input_tokens ?? 0) > 0;
        const firstText =
          parsedResp.content?.find((b) => b.type === "text")?.text ?? "";
        claudeText = stripJsonFences(firstText);
        try {
          const raw = JSON.parse(claudeText) as { pos?: unknown };
          // Tolerate Claude returning a single PO instead of {pos:[...]}.
          if (Array.isArray((raw as unknown as { items?: unknown }).items)) {
            parsed = { pos: [raw] };
          } else {
            parsed = raw as { pos: unknown[] };
          }
          if (!Array.isArray(parsed?.pos)) {
            errorMsg = "Claude returned no `pos` array.";
          } else {
            parseOk = true;
          }
        } catch (e) {
          errorMsg = `Claude returned invalid JSON: ${(e as Error).message}. Raw: ${claudeText.slice(0, 300)}`;
        }
      }
    }
  } catch (e) {
    errorMsg = `Network/fetch error: ${(e as Error).message}`;
  }

  // Sample insert. The legacy route writes one row per parsed PO (because
  // the route has the validated/enriched PO in hand by then). The queue
  // worker doesn't run validation here, so it can only write a single
  // top-level row carrying the raw extraction blob — the operator
  // confirm path on the queue detail page will set correctedJson later.
  let sampleId: string | null = null;
  if (opts.recordSample) {
    sampleId = genPoSampleId();
    try {
      await db
        .prepare(
          `INSERT INTO po_scan_samples (id, customerHint, poIdentifier, rawExtracted, correctedJson, createdBy)
           VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .bind(
          sampleId,
          customerHintGuess,
          null,
          parsed ? JSON.stringify(parsed) : JSON.stringify({ error: errorMsg, claudeText }),
          opts.createdBy ?? null,
        )
        .run();
    } catch (e) {
      console.error("po_scan_samples insert failed:", (e as Error).message);
    }
  }

  if (!parseOk || !parsed) {
    return {
      ok: false,
      error: errorMsg ?? "Extraction failed.",
      sampleId,
    };
  }
  return {
    ok: true,
    data: parsed,
    sampleId,
    meta: { cacheHit, cacheCreated },
  };
}

// ===========================================================================
// AUTO-SPLIT — boundary detection + pdf-lib chunking
// ===========================================================================
//
// Owner ruling 2026-06-30: a single PDF the operator drops into the scan
// modal may bundle N separate supplier documents (e.g. an 85-page file
// containing 16 invoices, each with its own letterhead + docNo + footer).
// Holding the connection while Sonnet/Haiku reads all 16 in a single
// monolithic call takes 5-10 min and forces the operator to wait for the
// whole batch before any preview lands.
//
// New flow: BEFORE the heavy extractor runs, ask Haiku for ONLY the page-
// range boundaries (one cheap, fast call). If the PDF turned out to be
// just one document, the heavy extractor runs once as before. If it's
// N documents, the queue worker splits the source PDF into N child PDFs
// (via pdf-lib) and re-enqueues each child as a sibling scan_queue row
// under the same batch — each child OCR runs independently and appears
// in the modal preview as soon as it lands.
//
// The boundary detector is intentionally minimal: no line extraction, no
// totals, no catalog injection — just where each document starts and ends.
// max_tokens 4096 is plenty (16 chunks × ~30 tokens each ≈ 500 tokens).

export type DocBoundary = { startPage: number; endPage: number };

const BOUNDARY_SYSTEM_PROMPT = `You receive a multi-page supplier-document PDF that may bundle multiple separate documents (tax invoices, delivery orders) together.

Return ONLY the page-range boundaries — do NOT extract line items or any other data.

Output VALID JSON only, no preamble, no markdown:
{"chunks": [{"startPage": 1, "endPage": 2}, {"startPage": 3, "endPage": 3}, ...]}

Rules:
- Page numbers are 1-indexed.
- Each chunk = ONE supplier document. A tax INVOICE and its matching DELIVERY ORDER (same docNo, same supplier) belong in the SAME chunk — they're part of one document set.
- A new chunk starts when: supplier letterhead changes, OR docNo changes, OR document type switches from one set to a new set.
- Cover every page exactly once. The last chunk's endPage MUST equal the total page count.
- If the PDF is just ONE document (single letterhead, single docNo throughout), return a single chunk covering all pages.

OUTPUT FIRST CHARACTER MUST BE '{', LAST '}'.`;

/**
 * Ask Haiku for the per-document page-range boundaries of a multi-page PDF.
 * Returns `{ chunks: [...] }` on success, or `{ error }` on any failure
 * (network, non-JSON, malformed shape). Callers should treat an error as
 * "fall back to single-chunk" — i.e. process the whole PDF as one document.
 */
export async function detectSupplierDocBoundaries(
  bytes: ArrayBuffer,
  mimeType: string,
  env: Env["Bindings"],
): Promise<{ chunks: DocBoundary[] } | { error: string }> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { error: "ANTHROPIC_API_KEY not configured" };
  }
  // Boundary detection is a PDF-only concern — single-page images are never
  // multi-document. Guard so a misrouted image doesn't burn a Haiku call.
  const isPdf =
    mimeType === "application/pdf" ||
    mimeType === "application/x-pdf" ||
    mimeType === "";
  if (!isPdf) return { error: "boundary detection skipped for non-PDF" };

  const base64 = toBase64(bytes);
  const mediaBlock = {
    type: "document",
    source: {
      type: "base64",
      media_type: "application/pdf",
      data: base64,
    },
  };

  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(BOUNDARY_TIMEOUT_MS),
      body: JSON.stringify({
        model: BOUNDARY_MODEL,
        max_tokens: 4096,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: BOUNDARY_SYSTEM_PROMPT },
              mediaBlock,
              {
                type: "text",
                text: "Return the chunks JSON only. First character '{', last '}'.",
              },
            ],
          },
        ],
      }),
    });
    const bodyText = await resp.text();
    if (!resp.ok) {
      return {
        error: `Anthropic ${resp.status}: ${bodyText.slice(0, 300)}`,
      };
    }
    let parsedResp: AnthropicResponse = {};
    try {
      parsedResp = JSON.parse(bodyText) as AnthropicResponse;
    } catch {
      return { error: `Anthropic returned non-JSON: ${bodyText.slice(0, 200)}` };
    }
    if (parsedResp.error) {
      return {
        error: `Anthropic: ${parsedResp.error.type}: ${parsedResp.error.message}`,
      };
    }
    const firstText =
      parsedResp.content?.find((b) => b.type === "text")?.text ?? "";
    const cleaned = stripJsonFences(firstText);
    let parsed: { chunks?: unknown };
    try {
      parsed = JSON.parse(cleaned) as { chunks?: unknown };
    } catch (e) {
      return {
        error: `Boundary JSON parse failed: ${(e as Error).message}. Raw: ${cleaned.slice(0, 200)}`,
      };
    }
    if (!Array.isArray(parsed.chunks)) {
      return { error: "Boundary response missing chunks[] array" };
    }
    const chunks: DocBoundary[] = [];
    for (const raw of parsed.chunks) {
      if (!raw || typeof raw !== "object") continue;
      const obj = raw as { startPage?: unknown; endPage?: unknown };
      const start = Number(obj.startPage);
      const end = Number(obj.endPage);
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 1 ||
        end < start
      ) {
        return {
          error: `Invalid chunk shape: ${JSON.stringify(raw).slice(0, 100)}`,
        };
      }
      chunks.push({ startPage: start, endPage: end });
    }
    if (chunks.length === 0) {
      return { error: "Boundary detector returned zero chunks" };
    }
    return { chunks };
  } catch (e) {
    return { error: `Network/fetch error: ${(e as Error).message}` };
  }
}

/**
 * Split a source PDF into N child PDFs by the given page-range chunks.
 * pdf-lib is already in the project — used by generate-product-pack-pdf.ts
 * and merge-pdf.ts.
 *
 * Caller is responsible for dropping the source bytes after this returns so
 * worker memory doesn't carry the parent + every child simultaneously.
 */
export async function splitPdfByChunks(
  sourceBytes: ArrayBuffer,
  chunks: DocBoundary[],
): Promise<
  { pdfBytes: Uint8Array; startPage: number; endPage: number }[]
> {
  const { PDFDocument } = await import("pdf-lib");
  const source = await PDFDocument.load(sourceBytes);
  const total = source.getPageCount();
  const result: {
    pdfBytes: Uint8Array;
    startPage: number;
    endPage: number;
  }[] = [];
  for (const c of chunks) {
    // Clamp out-of-range chunks defensively (boundary detector should never
    // return them, but a hallucination shouldn't crash the whole batch).
    const start = Math.max(1, c.startPage);
    const end = Math.min(total, c.endPage);
    if (end < start) continue;
    const child = await PDFDocument.create();
    const pageIdxs: number[] = [];
    for (let p = start - 1; p <= end - 1; p++) pageIdxs.push(p);
    const copied = await child.copyPages(source, pageIdxs);
    for (const p of copied) child.addPage(p);
    const bytes = await child.save();
    result.push({ pdfBytes: bytes, startPage: start, endPage: end });
  }
  return result;
}

/**
 * Read the page count of a PDF without touching its content. Returns 0 on
 * any parsing failure — caller treats that as "single-page-equivalent"
 * (skip the split path).
 */
export async function getPdfPageCount(bytes: ArrayBuffer): Promise<number> {
  try {
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(bytes);
    return doc.getPageCount();
  } catch {
    return 0;
  }
}
