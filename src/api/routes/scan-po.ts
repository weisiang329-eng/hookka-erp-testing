// ---------------------------------------------------------------------------
// scan-po.ts — Claude-powered Customer PO OCR route.
//
// Two endpoints:
//   POST /api/scan-po/extract             — upload a PDF, get structured JSON
//   POST /api/scan-po/samples/:id/confirm — save the user-corrected JSON
//                                            as a few-shot example
//
// Setup:
//   npx wrangler secret put ANTHROPIC_API_KEY   (enter your key when prompted)
//
// Costs: ~$0.01-0.05 per PO page using claude-sonnet-4-6.
//
// CATALOG INJECTION
// =================
// On every /extract call we pull the live catalog (customers, products, fabrics,
// variants-config) from the DB and inject it into the Claude prompt as a
// prompt-cached prefix. This means:
//   • Adding a new fabric/SKU is immediately visible to Claude — zero retrain
//     step. The next /extract call sees it.
//   • Anthropic prompt caching gives a ~90% discount for repeated calls
//     within 5 minutes (catalog block is identical until the DB changes).
//
// MULTI-PO PER PDF
// ================
// One physical PDF often contains many separate POs (one per page). Schema is
// `{ pos: PO[] }`. We insert one `po_scan_samples` row per PO so each card in
// the preview UI has its own sampleId and few-shot lifecycle.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";

const app = new Hono<Env>();

const MAX_PDF_BYTES = 32 * 1024 * 1024;
const CLAUDE_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function genId(): string {
  return `pos-${crypto.randomUUID().slice(0, 8)}`;
}

// ArrayBuffer -> base64. Workers don't expose Node's Buffer; the chunked loop
// keeps stack usage bounded for large files.
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

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenceRe = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;
  const m = trimmed.match(fenceRe);
  return (m ? m[1] : trimmed).trim();
}

// ===========================================================================
// Catalog
// ===========================================================================
type CatalogCustomer = {
  id: string;
  code: string;
  name: string;
  hubs: { shortName: string; state: string | null }[];
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
type Catalog = {
  customers: CatalogCustomer[];
  bedframes: CatalogProduct[];
  sofas: CatalogProduct[];
  accessories: CatalogProduct[];
  fabrics: CatalogFabric[];
  variants: CatalogVariants;
};

type DBLike = { prepare: (sql: string) => { bind: (...args: unknown[]) => DBQuery; first: <T>() => Promise<T | null>; all: <T>() => Promise<{ results?: T[] }> } };
type DBQuery = { first: <T>() => Promise<T | null>; all: <T>() => Promise<{ results?: T[] }>; run: () => Promise<{ success: boolean; meta: { changes: number } }> };

async function loadCatalog(db: DBLike, orgId: string): Promise<Catalog> {
  const [custRes, hubRes, prodRes, fabRes, kvRes] = await Promise.all([
    db
      .prepare(
        "SELECT id, code, name FROM customers WHERE orgId = ? AND isActive = 1 ORDER BY code",
      )
      .bind(orgId)
      .all<{ id: string; code: string; name: string }>(),
    db
      .prepare(
        "SELECT customerId, shortName, state FROM delivery_hubs WHERE orgId = ?",
      )
      .bind(orgId)
      .all<{ customerId: string; shortName: string; state: string | null }>(),
    db
      .prepare(
        "SELECT code, name, category, sizeLabel FROM products WHERE orgId = ? AND status = 'ACTIVE' ORDER BY category, code",
      )
      .bind(orgId)
      .all<{ code: string; name: string; category: string; sizeLabel: string | null }>(),
    db
      .prepare(
        "SELECT fabricCode, fabricDescription, priceTier FROM fabric_trackings ORDER BY fabricCode",
      )
      .bind()
      .all<{ fabricCode: string; fabricDescription: string | null; priceTier: string | null }>(),
    db
      .prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind("variants-config")
      .first<{ value: string }>(),
  ]);

  const hubsByCust = new Map<string, { shortName: string; state: string | null }[]>();
  for (const h of hubRes.results ?? []) {
    const list = hubsByCust.get(h.customerId) ?? [];
    list.push({ shortName: h.shortName, state: h.state });
    hubsByCust.set(h.customerId, list);
  }

  const customers: CatalogCustomer[] = (custRes.results ?? []).map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
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
    bedframe: { divanHeights: [], legHeights: [], gaps: [], totalHeights: [], specials: [] },
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
      // Bad JSON — leave variants empty; Claude will infer from PDF text.
    }
  }

  return { customers, bedframes, sofas, accessories, fabrics, variants };
}

function formatCatalog(c: Catalog): string {
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
  lines.push(`Divan Heights: ${c.variants.bedframe.divanHeights.join(", ") || "—"}`);
  lines.push(`Leg Heights: ${c.variants.bedframe.legHeights.join(", ") || "—"}`);
  lines.push(`Gaps: ${c.variants.bedframe.gaps.join(", ") || "—"}`);
  lines.push(`Total Heights: ${c.variants.bedframe.totalHeights.join(", ") || "—"}`);
  lines.push(`Specials: ${c.variants.bedframe.specials.join(" | ") || "—"}`);

  lines.push("");
  lines.push("=== SOFA VARIANTS ===");
  lines.push(`Sizes (seat heights): ${c.variants.sofa.sizes.join(", ") || "—"}`);
  lines.push(`Leg Heights: ${c.variants.sofa.legHeights.join(", ") || "—"}`);
  lines.push(`Specials: ${c.variants.sofa.specials.join(" | ") || "—"}`);

  return lines.join("\n");
}

// ===========================================================================
// Prompt
// ===========================================================================
const SYSTEM_PROMPT = `You extract structured data from furniture purchase order PDFs at Hookka Manufacturing.

PDFs frequently contain MULTIPLE separate POs (one per page). Extract each into its own pos[] entry.

EXTRACTION RULES
================
1. customerName = the company that ISSUED the PO (top-of-page letterhead/header).
2. customerCode = matched against CUSTOMERS catalog by name. null if unknown.
3. customerPO = the PO number (e.g. "PO-008711"). The exact field label varies.
4. customerState = the issuing customer's state from their address.
5. yourRefNo = "Your Ref No." field value.
6. transferredSO = "Transferred SO" column on each line item (may be null).
7. deliveryHub = "Purchase Location" or hub shortName (KL/PG/JB/...). Match against the customer's hubs in CUSTOMERS catalog.
8. deliveryDate = "Delivery Date" field as YYYY-MM-DD. CRITICAL — strikethrough means INVALIDATED: when the printed date has a strikethrough/crossout line through it, that date is no longer valid. Look elsewhere on the same page for the replacement date — anywhere it appears (handwritten, in red, beside line items, in the Purchase Location field, near the signature, etc.). Whatever you find is the real deliveryDate. Same rule applies to per-line item dates in the "Transferred SO" column. DD.MM.YYYY / DD/MM/YYYY format converts to YYYY-MM-DD.
9. isUrgent = true when PDF shows "URGENT", "SUPER URGENT", or similar emphasis (often red).
10. pageNumbers = 1-indexed list of source PDF pages this PO occupies. Most POs span exactly one page (e.g. [3]); a multi-page PO lists every page (e.g. [4, 5]). Used to attach the original page image to the SO for customer disputes — accuracy here matters.

ITEM EXTRACTION (CATEGORY-AWARE)
=================================
Identify each item's category by matching productCode against the catalog (BEDFRAME / SOFA / ACCESSORY).

[BEDFRAME]
- productCode: match against BEDFRAME PRODUCTS. Different customers write the same SKU differently — normalize before matching:
  • "2009(A)Trion" / "Trion 2009(A)" / "HOK-2009(A)" → look up "2009(A)" stem with the size suffix to find catalog code (e.g. "2009(A)-(K)").
  • "1013Jager" / "Jager 1013" → "1013" stem.
  • "HOK-1007 (K)" → already normalized.
  • Strip family-name words like "Trion", "Jager", "Cody", "Fenrir", "Regal", "Hilton", "Celene" — they're descriptive aliases of the numeric model.
  • Strip "HOK-" prefix when matching (catalog may have it or not).
  • Combine the model stem with the size token to find an exact catalog match. If no exact match, leave productCode as the original text + add specialNotes "unmatched product".
- sizeLabel: the size, normalized to short code: King→(K), Queen→(Q), Single→(S), SuperSingle→(SS), SuperKing→(SK), SuperPlus→(SP). Sometimes already in catalog form like "(K)", "(Q)".
- "Fab3" / "Fab2" / "Fab1" tokens = fabric price tier (PRICE_3/2/1). NOT a fabric code. Do NOT put into fabricCode. Drop it from productCode matching.
- fabricCode: the COLOR/COL/Col value (e.g. "PC151-02"). Match against FABRICS catalog. Common keys: "Col", "COL", "color", "COLOR", "col".
- divanHeightInches: parse the FULL number BEFORE the "+" in spec. ALWAYS use the entire number, not just the leading digit.
    "Divan10+4" → divanHeightInches=10 (NOT 1)
    "Divan:8inch+noleg" → divanHeightInches=8
    "DRAWER:12"" → divanHeightInches=12 (NOT 1; the drawer height IS the divan height)
    "DRAWER:14"" → 14 (NOT 1)
    "8"DIVAN+2"LEG" → divanHeightInches=8
    "divan:10inch+noleg" → 10
- legHeightInches: parse the FULL number AFTER the "+" sign. NEVER strip digits.
    "Divan10+4" → legHeightInches=4
    "Divan10+1" → 1
    "8"DIVAN+2"LEG" → 2
    null when followed by "no leg"/"NOLEG"/"no legs"/"+nolegs".
- gapInches: parse the FULL number after "Gap"/"gap"/"GAP"/"M.Gap"/"M'GP"/"MATTRESSGAP"/"MATTRESS GAP" keyword. ALWAYS use entire number.
    "gap12" → gapInches=12 (NOT 1)
    "MATTRESSGAP:14"" → 14 (NOT 1)
    "Gap:13"" → 13
    "M.Gap:12"" → 12
    "12"MATTRESS GAP" → 12

CRITICAL: when spec says "10", "12", "14", "16" — these are TWO-digit inch measurements. Return the full number (10, 12, 14, 16). Never truncate to the first digit (1).
- noLeg: true if spec contains any case of "no leg", "noleg", "no legs". When true, legHeightInches MUST be null.
- specialOrder: match against BEDFRAME Specials catalog. Examples:
    "HB straight"/"HB STR" → "HB Straight"
    "Left Drawer"/"L DRAWER" / "L'DRAWER" → "Left Drawer"
    "Right Drawer"/"R DRAWER" / "R'DRAWER" → "Right Drawer"
    "Front Drawer"/"FRONT DRAWER" → "Front Drawer"
    "Divan above full cover" / "Divan top fully cover" → "Divan Top Fully Cover"
    "Divan full cover" → "Divan Full Cover"
    "HB fully cover" → "HB Fully Cover"
  CRITICAL — when only "DRAWER" is written without L/R/F label: LOOK AT THE HAND-DRAWN DIAGRAM in the PDF body. Arrows pointing LEFT (←) at the headboard end → "Left Drawer". Arrows pointing RIGHT (→) → "Right Drawer". Arrows pointing toward the FOOT of the bed (↓ at the bottom or front) → "Front Drawer". When no diagram is present and side is unclear, pick "Front Drawer" + add specialNotes "drawer side unclear".
- specialNotes: free-form remainder when no special matches (e.g. handwritten urgency dates).

[SOFA]
- productCode: match against SOFA PRODUCTS (e.g. "5530-2A(LHF)"). Customer PDFs often abbreviate — normalize before matching:
  • "HK5531/28"(2+L Seater)" / "HK5531/24"(3 Seater)" → model 5531 with seat height 28/24, configuration "2-Seater + L-piece" (means TWO line items: a 2A module + an L module).
  • "HK5531/24"(2 Seater + Lshape)" → same as "2+L Seater": split into 5531-2A + 5531-L.
  • "HK5531/28"(2+LSeater)" → same.
  • Strip "HK" prefix, trim quotes/spaces.
  • Module shorthand mapping: "2 Seater" → 2A, "3 Seater" → 3S, "L"/"Lshape" → L, "1 Seater" → 1A, "Stool" → STOOL, "CNR" → CNR. Default to (LHF) when LHF/RHF not specified — operator will fix in preview.
  • Multi-module configurations like "2+L Seater" produce MULTIPLE items[] entries (one per module). Quantity divides equally — most often qty=1 per module.
- sizeLabel: seat height in inches (24/26/28/30/32/35). Catalog: SOFA Sizes.
- fabricCode: from "COL:XXX" / "COLOUR:XXX" / "/KN390-2 SAND" / "/PC151-01" — match against FABRICS catalog.
- legHeightInches: sofa leg height (catalog: SOFA Leg Heights). null if not stated.
- specialOrder: match against SOFA Specials.
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
      "deliveryDate": "YYYY-MM-DD" | null,
      "isUrgent": boolean,
      "pageNumbers": number[],
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
        "transferredSO": string | null
      }]
    }
  ]
}`;

// ===========================================================================
// Types
// ===========================================================================
type ExtractedItem = {
  category: "BEDFRAME" | "SOFA" | "ACCESSORY";
  productCode: string;
  description: string | null;
  quantity: number;
  sizeLabel: string | null;
  fabricCode: string | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  gapInches: number | null;
  noLeg: boolean;
  specialOrder: string | null;
  specialNotes: string | null;
  unitPrice: number | null;
  transferredSO: string | null;
};

type ExtractedPO = {
  customerPO: string;
  customerName: string;
  customerCode: string | null;
  // customerId is server-enriched after Claude returns — Claude doesn't see
  // customer IDs (only codes) so this is filled in by name/code lookup. Lets
  // the SO create call go through without a separate customer-resolution step.
  customerId: string | null;
  customerState: string | null;
  deliveryHub: string | null;
  yourRefNo: string | null;
  deliveryDate: string | null;
  isUrgent: boolean;
  // 1-indexed page numbers from the source PDF that this PO occupies. Used
  // by the frontend to render that page set into a single PNG attachment
  // for the SO (proof-of-source for customer disputes).
  pageNumbers: number[];
  items: ExtractedItem[];
};

type ExtractionResult = { pos: ExtractedPO[] };

type AnthropicResponse = {
  content?: Array<{ type: string; text?: string }>;
  error?: { type: string; message: string };
  usage?: { cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
};

type Warning = {
  field: string;
  value: string;
  message: string;
  itemIdx?: number;
};

// ===========================================================================
// Validation
// ===========================================================================
// Side-effect: enriches `po` with customerId when customerCode/customerName
// matches a row in the catalog. Returns warnings for everything that didn't
// match — UI shows them as red badges per card.
function validateAndEnrichPO(po: ExtractedPO, catalog: Catalog): Warning[] {
  const warnings: Warning[] = [];
  const productCodes = new Set(
    [...catalog.bedframes, ...catalog.sofas, ...catalog.accessories].map((p) =>
      p.code.toUpperCase(),
    ),
  );
  const fabricCodes = new Set(catalog.fabrics.map((f) => f.code.toUpperCase()));
  const customerByCode = new Map(
    catalog.customers.map((c) => [c.code.toUpperCase(), c]),
  );
  const customerByName = new Map(
    catalog.customers.map((c) => [c.name.toUpperCase(), c]),
  );
  const hubShortNames = new Set(
    catalog.customers.flatMap((c) =>
      c.hubs.map((h) => h.shortName.toUpperCase()),
    ),
  );

  // Resolve customerId — try code first, then name.
  let matchedCustomer: CatalogCustomer | undefined;
  if (po.customerCode) {
    matchedCustomer = customerByCode.get(po.customerCode.toUpperCase());
  }
  if (!matchedCustomer && po.customerName) {
    matchedCustomer = customerByName.get(po.customerName.toUpperCase());
  }
  if (matchedCustomer) {
    po.customerId = matchedCustomer.id;
    if (!po.customerCode) po.customerCode = matchedCustomer.code;
  } else {
    po.customerId = null;
    warnings.push({
      field: "customerName",
      value: po.customerName ?? "",
      message: "Customer not in catalog — please match manually before creating SO.",
    });
  }

  if (po.deliveryHub && !hubShortNames.has(po.deliveryHub.toUpperCase())) {
    warnings.push({
      field: "deliveryHub",
      value: po.deliveryHub,
      message: "Delivery hub not in catalog.",
    });
  }

  for (let i = 0; i < po.items.length; i++) {
    const item = po.items[i];
    if (item.productCode && !productCodes.has(item.productCode.toUpperCase())) {
      warnings.push({
        field: "productCode",
        value: item.productCode,
        message: `Item ${i + 1}: product code not in SKU master.`,
        itemIdx: i,
      });
    }
    if (item.fabricCode && !fabricCodes.has(item.fabricCode.toUpperCase())) {
      warnings.push({
        field: "fabricCode",
        value: item.fabricCode,
        message: `Item ${i + 1}: fabric code not in fabric catalog.`,
        itemIdx: i,
      });
    }
  }

  return warnings;
}

// ===========================================================================
// GET /api/scan-po/catalog — slim catalog payload for the preview modal.
// Lets inline-edit dropdowns (fabric, divan, special, etc.) source values
// directly from maintenance instead of the operator typing free text.
// ===========================================================================
app.get("/catalog", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const catalog = await loadCatalog(c.var.DB as unknown as DBLike, orgId);
  return c.json({
    success: true,
    data: {
      customers: catalog.customers.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        hubs: c.hubs.map((h) => h.shortName),
      })),
      bedframes: catalog.bedframes.map((p) => p.code),
      sofas: catalog.sofas.map((p) => p.code),
      accessories: catalog.accessories.map((p) => p.code),
      fabrics: catalog.fabrics.map((f) => f.code),
      bedframeDivans: catalog.variants.bedframe.divanHeights,
      bedframeLegs: catalog.variants.bedframe.legHeights,
      bedframeGaps: catalog.variants.bedframe.gaps,
      bedframeSpecials: catalog.variants.bedframe.specials,
      sofaSizes: catalog.variants.sofa.sizes,
      sofaLegs: catalog.variants.sofa.legHeights,
      sofaSpecials: catalog.variants.sofa.specials,
    },
  });
});

// ===========================================================================
// POST /api/scan-po/extract
// ===========================================================================
type SampleRow = { id: string; correctedJson: string | null };

app.post("/extract", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;

  const apiKey = c.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json(
      {
        success: false,
        error:
          "ANTHROPIC_API_KEY not configured. Run `npx wrangler secret put ANTHROPIC_API_KEY` to enable PO scanning.",
      },
      500,
    );
  }

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch (e) {
    return c.json(
      { success: false, error: `Invalid multipart body: ${(e as Error).message}` },
      400,
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return c.json({ success: false, error: "Missing `file` field." }, 400);
  }

  if (file.size > MAX_PDF_BYTES) {
    return c.json(
      {
        success: false,
        error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 32MB.`,
      },
      400,
    );
  }
  const mime = file.type || "";
  const name = file.name || "";
  const isPdf =
    mime === "application/pdf" || name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    return c.json({ success: false, error: "Only PDF files are accepted." }, 400);
  }

  const arrayBuffer = await file.arrayBuffer();
  const pdfBase64 = toBase64(arrayBuffer);

  const orgId = getOrgId(c);
  const catalog = await loadCatalog(c.var.DB as unknown as DBLike, orgId);
  const catalogText = formatCatalog(catalog);

  const createdBy = (c.get("userId" as never) as string | undefined) ?? null;
  const customerHintGuess = name.split(/[-_ .]/)[0]?.slice(0, 40) ?? null;

  // Cached prefix = SYSTEM_PROMPT + catalog. Refreshes only when DB changes.
  // Anthropic prompt-caching gives ~90% discount on cache hits within 5 min.
  const cachedPrefix = `${SYSTEM_PROMPT}\n\nCATALOG\n=======\n${catalogText}`;

  let claudeText = "";
  let parseOk = false;
  let parsed: ExtractionResult | null = null;
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
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 8192,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: cachedPrefix,
                cache_control: { type: "ephemeral" },
              },
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: pdfBase64,
                },
              },
              {
                type: "text",
                text: "Extract all POs from the PDF above using the rules + catalog. Return strict JSON only.",
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
      let parsedResp: AnthropicResponse;
      try {
        parsedResp = JSON.parse(bodyText) as AnthropicResponse;
      } catch {
        errorMsg = `Anthropic returned non-JSON: ${bodyText.slice(0, 300)}`;
        parsedResp = {};
      }
      if (parsedResp.error) {
        errorMsg = `Anthropic: ${parsedResp.error.type}: ${parsedResp.error.message}`;
      } else {
        cacheHit = (parsedResp.usage?.cache_read_input_tokens ?? 0) > 0;
        cacheCreated = (parsedResp.usage?.cache_creation_input_tokens ?? 0) > 0;
        const firstText =
          parsedResp.content?.find((b) => b.type === "text")?.text ?? "";
        claudeText = stripJsonFences(firstText);
        try {
          const raw = JSON.parse(claudeText) as ExtractionResult;
          // Tolerate Claude returning a single PO instead of {pos:[...]}.
          if (Array.isArray((raw as unknown as { items?: unknown }).items)) {
            parsed = { pos: [raw as unknown as ExtractedPO] };
          } else {
            parsed = raw;
          }
          if (!Array.isArray(parsed.pos)) {
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

  // Persist one row per PO (or one row of the failure blob if extraction failed).
  type SamplePayload = {
    sampleId: string;
    extracted: ExtractedPO;
    warnings: Warning[];
  };
  const samples: SamplePayload[] = [];

  if (!parseOk || !parsed) {
    const sampleId = genId();
    try {
      await (c.var.DB as unknown as DBLike)
        .prepare(
          `INSERT INTO po_scan_samples (id, customerHint, poIdentifier, rawExtracted, correctedJson, createdBy)
           VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .bind(
          sampleId,
          customerHintGuess,
          null,
          JSON.stringify({ error: errorMsg, claudeText }),
          createdBy,
        )
        .run();
    } catch (e) {
      console.error("po_scan_samples insert failed:", (e as Error).message);
    }
    return c.json(
      {
        success: false,
        error: errorMsg ?? "Extraction failed.",
        sampleId,
      },
      502,
    );
  }

  for (const po of parsed.pos) {
    const sampleId = genId();
    try {
      await (c.var.DB as unknown as DBLike)
        .prepare(
          `INSERT INTO po_scan_samples (id, customerHint, poIdentifier, rawExtracted, correctedJson, createdBy)
           VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .bind(
          sampleId,
          po.customerName ?? customerHintGuess,
          po.customerPO ?? null,
          JSON.stringify(po),
          createdBy,
        )
        .run();
    } catch (e) {
      console.error("po_scan_samples insert failed:", (e as Error).message);
    }
    samples.push({ sampleId, extracted: po, warnings: validateAndEnrichPO(po, catalog) });
  }

  return c.json({
    success: true,
    data: {
      samples,
      meta: {
        cacheHit,
        cacheCreated,
        totalPOs: samples.length,
      },
    },
  });
});

// ===========================================================================
// POST /api/scan-po/samples/:id/confirm
// ===========================================================================
app.post("/samples/:id/confirm", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;
  const id = c.req.param("id");
  if (!id) {
    return c.json({ success: false, error: "Missing sample id." }, 400);
  }

  let body: { correctedJson?: unknown };
  try {
    body = (await c.req.json()) as { correctedJson?: unknown };
  } catch {
    return c.json({ success: false, error: "Invalid JSON body." }, 400);
  }

  if (body.correctedJson === undefined) {
    return c.json({ success: false, error: "Missing `correctedJson`." }, 400);
  }

  const payload =
    typeof body.correctedJson === "string"
      ? body.correctedJson
      : JSON.stringify(body.correctedJson);

  const result = await (c.var.DB as unknown as DBLike)
    .prepare("UPDATE po_scan_samples SET correctedJson = ? WHERE id = ?")
    .bind(payload, id)
    .run();

  if (!result.success || result.meta.changes === 0) {
    return c.json(
      { success: false, error: "Sample not found or update failed." },
      404,
    );
  }

  return c.json({ success: true });
});

// Silences "imported but unused" — the type is only used as a structural hint.
export type { SampleRow };

export default app;
