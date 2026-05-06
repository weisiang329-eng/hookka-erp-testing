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

// Try several recovery strategies to coerce Claude's output into a JSON
// string — Claude sometimes wraps the result in fences, sometimes adds a
// "Looking at the PDF..." preamble, sometimes both. We'd rather parse a
// best-effort substring than fail the whole extraction.
function stripJsonFences(text: string): string {
  let trimmed = text.trim();

  // 1) ```json … ``` or ``` … ```
  const fenceRe = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;
  const fenceMatch = trimmed.match(fenceRe);
  if (fenceMatch) trimmed = fenceMatch[1].trim();

  // 2) Strip any chain-of-thought preamble Claude prefixes. The valid
  //    payload always starts with `{` (object) — find the first one and
  //    take from there to the matching closing brace at end.
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace > 0 && lastBrace > firstBrace) {
    trimmed = trimmed.slice(firstBrace, lastBrace + 1).trim();
  }

  return trimmed;
}

// ===========================================================================
// Catalog
// ===========================================================================
type CatalogCustomer = {
  id: string;
  code: string;
  name: string;
  // Per-customer OCR rules — operator-authored prose injected into the
  // prompt so Claude knows that customer's quirks (notation, urgency cues,
  // size codes, diagram conventions). null/empty when the customer has no
  // bespoke rules yet — in which case nothing extra is injected.
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
        "SELECT id, code, name, ocrPromptRules FROM customers WHERE orgId = ? AND isActive = 1 ORDER BY code",
      )
      .bind(orgId)
      .all<{ id: string; code: string; name: string; ocrPromptRules: string | null }>(),
    db
      .prepare(
        "SELECT id, customerId, shortName, state FROM delivery_hubs WHERE orgId = ?",
      )
      .bind(orgId)
      .all<{ id: string; customerId: string; shortName: string; state: string | null }>(),
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

  const hubsByCust = new Map<string, { id: string; shortName: string; state: string | null }[]>();
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

// Self-applying migration — adds the `ocrPromptRules` column to `customers`
// the first time any /extract or /customer-rules call runs in a fresh
// isolate. Mirrors the `ensurePendingMigrations` pattern in sales-orders.ts
// so Supabase stays forward-compatible without a separate deploy step.
let scanPoColumnsPromise: Promise<void> | null = null;
function ensureScanPoColumns(db: DBLike): Promise<void> {
  if (scanPoColumnsPromise) return scanPoColumnsPromise;
  scanPoColumnsPromise = (async () => {
    const stmts = [
      "ALTER TABLE customers ADD COLUMN IF NOT EXISTS ocrPromptRules TEXT",
    ];
    for (const sql of stmts) {
      try {
        await db.prepare(sql).bind().run();
      } catch {
        // best-effort; column may already exist or DDL transiently rejected
      }
    }
  })();
  return scanPoColumnsPromise;
}

// Per-customer rules are injected as a separate prompt block tagged with the
// customer code. We render ALL customers' blocks (even empty ones) and tell
// Claude to consult only the block for the customer it identifies. This keeps
// the prefix cacheable (single shape that only changes when rules change in
// the DB) and avoids the chicken-and-egg of needing the customer ID before
// the LLM call. Customers with no rules render as a stub so Claude doesn't
// hunt for a missing block.
function formatCustomerRules(c: Catalog): string {
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
      lines.push("(no customer-specific rules — apply universal rules only)");
    } else {
      lines.push(body);
    }
    lines.push(`</customer>`);
    lines.push("");
  }
  return lines.join("\n");
}

// ===========================================================================
// Prompt
// ===========================================================================
const SYSTEM_PROMPT = `You extract structured data from furniture purchase order PDFs at Hookka Manufacturing.

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
- divanHeightInches: parse the FULL number that follows the divan keyword. ALWAYS read the entire numeric token, not just the leading digit. The inch mark (") and any text after it are NOT part of the number.
    "Divan10+4" → divanHeightInches=10 (NOT 1)
    "Divan:8inch+noleg" → 8
    "DRAWER:12"" → 12 (drawer height IS divan height when DRAWER variant)
    "DRAWER:14"" → 14
    "divan:12"divan NO leg" → divanHeightInches=12 (NOT 1; the trailing word "divan" + "NO leg" is just spec text, the number is 12)
    "divan:10inch+noleg" → 10
    "8"DIVAN+2"LEG" → 8
    "8inch DIVAN" → 8
    "Divan above full cover/PC151-03/Divan8+2/gap12" → 8 (use the second "Divan8" — first is just text)
  Whenever you see a digit followed by another digit before any non-digit character, the value is the multi-digit number (e.g. "12" → 12, "16" → 16). Single-digit values 1-9 are valid; never confuse a leading digit of a 2-digit number for a 1.
- legHeightInches: parse the FULL number AFTER the "+" sign. NEVER strip digits.
    "Divan10+4" → legHeightInches=4
    "Divan10+1" → 1
    "8"DIVAN+2"LEG" → 2
    null when followed by "no leg"/"NOLEG"/"no legs"/"+nolegs".
- gapInches: parse the FULL number after "Gap"/"gap"/"GAP"/"M.Gap"/"M'GP"/"MATTRESSGAP"/"MATTRESS GAP" keyword. ALWAYS use entire number.
    "gap12" → gapInches=12 (NOT 1)
    "gap:10"" → 10 (NOT 1)
    "MATTRESSGAP:14"" → 14 (NOT 1)
    "Gap:13"" → 13
    "M.Gap:12"" → 12
    "12"MATTRESS GAP" → 12

CRITICAL: when spec contains "10", "12", "14", "16" — these are TWO-digit inch measurements. Return the full number (10, 12, 14, 16). Never truncate to the first digit (1). If you see "12"" with the trailing inch quote, the value is 12, NOT 1. The inch quote (") is a unit marker, not a digit separator.
- noLeg: true if spec contains any case of "no leg", "noleg", "no legs". When true, legHeightInches MUST be null.
- specialOrder: match against BEDFRAME Specials catalog. Examples:
    "HB straight"/"HB STR" → "HB Straight"
    "Divan above full cover" / "Divan top fully cover" → "Divan Top Fully Cover"
    "Divan full cover" → "Divan Full Cover"
    "HB fully cover" → "HB Fully Cover"

  DRAWER position rule (priority order, stop at first match):
    1. Explicit text wins: "Left Drawer" / "L Drawer" / "L'DRAWER" / "LEFT DRAWER" → "Left Drawer".
    2. "Right Drawer" / "R Drawer" / "R'DRAWER" / "RIGHT DRAWER" → "Right Drawer".
    3. "Front Drawer" / "F Drawer" / "FRONT DRAWER" → "Front Drawer".
    4. Only "DRAWER" / "DRAWERS" written with NO L/R/F label → LOOK AT THE HAND-DRAWN DIAGRAM on the same page. The diagram is usually a rectangle (the bed) with arrow marks (←, →, ↑, ↓) showing which side the drawer slides out from:
       • Arrows on the LEFT edge of the rectangle pointing left (←) → "Left Drawer".
       • Arrows on the RIGHT edge pointing right (→) → "Right Drawer".
       • Arrows on the BOTTOM/FOOT edge pointing down or out of the foot → "Front Drawer".
       • If the diagram clearly shows multiple arrows on one side, that's the answer.
    5. Only if NO diagram is present AND no L/R/F label: leave specialOrder=null + add specialNotes="drawer side missing — operator to confirm".
- specialNotes: free-form remainder when no special matches (e.g. handwritten urgency dates).
- rawSpec: copy the EXACT spec text line(s) under each Description verbatim, including punctuation, slashes, and inch marks. Examples to copy verbatim:
    PC151-02/Divan10+4/gap12
    Pc151-02/divan8+4/gap12
    col:pc151-01/gap:10"/divan:12"divan NO leg
    DRAWER:12"/COLOR:PC151-01/MATTRESSGAP:14"
    M.Gap:12"/Color:PC151-01/Divan:8"+0
  This field is the source of truth for the server-side regex post-processor; do NOT rephrase or simplify the spec line.

[SOFA]
- productCode: match against SOFA PRODUCTS (e.g. "5530-2A(LHF)"). Customer PDFs use a fixed module taxonomy — internalise this BEFORE attempting any extraction:

  HOOKKA SOFA MODULE CATALOG (memorise — use these EXACT codes)
  ==============================================================
  Catalog format: "MODEL-MODULE(SIDE)" e.g. "5530-2A(LHF)".

  SINGLE-SEATER (1 person):
    • 1A(LHF)  — single armed, arm on LEFT  (use when 1-seater is leftmost in chain or pair)
    • 1A(RHF)  — single armed, arm on RIGHT (use when 1-seater is rightmost)
    • 1NA      — single NO arm (sandwiched between other pieces)

  DOUBLE-SEATER (2 people):
    • 2A(LHF)  — double armed, arm on LEFT  (leftmost in chain)
    • 2A(RHF)  — double armed, arm on RIGHT (rightmost in chain)
    • 2NA      — double NO arm (sandwiched)

  STANDALONE PIECES (S-suffix = single continuous body, BOTH arms):
    • 1S       — standalone single-seater armchair (BOTH arms, not chained). Different from 1A.
    • 2S       — standalone 2-seater (BOTH arms, single body, not part of a multi-module chain).
    • 3S       — standalone 3-seater (BOTH arms, single body — one armrest on each end with no centre split).
    Use the S-variant when:
      - The diagram shows ONE continuous box (not joined with "+" to other modules).
      - The PDF text doesn't break into "+"-joined parts.
    Use the A / NA variants when:
      - Diagram shows multiple boxes chained with "+" or drawn side-by-side.
      - PDF text uses "1+1+1", "1+2+L", "2+L", etc.

  3NA — three-piece no arm (rare; only when sandwiched and 3 seats wide).

  L-PIECE / CHAISE:
    • 1L(LHF)  — L-shape, left version  (leftmost in chain)
    • 1L(RHF)  — L-shape, right version (rightmost in chain)
    Catalog sometimes writes these as "L(LHF)" / "L(RHF)" without the leading 1 — both forms are valid, match either.

  CORNER / ACCESSORY:
    • CNR      — corner connector (joins two perpendicular sections at 90°)
    • STOOL    — ottoman / footstool

  MIRROR-PAIR LOGIC (CRITICAL):
    LHF and RHF are MIRRORS of each other. In a sofa containing two armed pieces, ALWAYS output one LHF + one RHF — NEVER two of the same side.

  ★★★ LHF / RHF VIEWPOINT CONVENTION — DEPENDS ON TV POSITION ★★★

  Hookka's LHF / RHF designation is from the perspective of someone STANDING
  WHERE THE TV IS, FACING the sofa. The mapping from diagram-positions to
  LHF / RHF therefore DEPENDS on where the TV is drawn in the diagram. There
  is NO universal "flip everything" rule — you must locate the TV first.

  STEP 1: Locate the TV / facing reference in the diagram.
    Look for a small box labelled "TV" or for written cues like
    "TV here", "facing TV", or arrow markers showing "this side faces TV".
    The TV is the FRONT of the room — the viewer stands here and looks AT
    the sofa.

  STEP 2: Determine the viewer's left/right based on TV position.

    TV at the TOP of the diagram (most common): viewer faces DOWN.
      → diagram-LEFT becomes viewer's RIGHT (RHF)
      → diagram-RIGHT becomes viewer's LEFT (LHF)
      Letters are swapped — diagram L/R reverses.

    TV at the BOTTOM of the diagram: viewer faces UP.
      → diagram-LEFT becomes viewer's LEFT (LHF)
      → diagram-RIGHT becomes viewer's RIGHT (RHF)
      No swap — natural reading.

    TV on the LEFT side of the diagram: viewer faces RIGHT (rotate 90°).
      → top of diagram → viewer's LEFT (LHF)
      → bottom of diagram → viewer's RIGHT (RHF)

    TV on the RIGHT side of the diagram: viewer faces LEFT.
      → top of diagram → viewer's RIGHT (RHF)
      → bottom of diagram → viewer's LEFT (LHF)

  STEP 3: Verify using the L-shape's backrest direction.
    The backrest of an L-piece is drawn as a short line along the FRONT of
    the seat (the side nearest the TV). The L-extension (chaise leg)
    sticks out to one side. If the L-extension is on the viewer's LEFT
    when standing at the TV, it is L(LHF). If on the viewer's RIGHT, it
    is L(RHF). This should agree with what STEP 2 told you — if it
    doesn't, re-check the TV position.

  STEP 4: When the diagram has NO TV marker AND no other facing cue:
    Default to "TV at top" (the most common Hookka convention). Set
    specialNotes to "TV position not marked — default front-facing assumed,
    operator to verify L/R" so the operator knows to double-check.

  CRITICAL: Inner / sandwiched pieces always stay NA (no LHF / RHF suffix)
  regardless of viewpoint, because they have no arms.

  Worked example A — PO/2605-003 (TV at top of diagram):
    Diagram shows (left → right):  [ 28" 28" joined ] + [ 28" with L-flap ]
    The joined 28"+28" pair is on the diagram's LEFT, so it's on the TV-viewer's RIGHT → 2A(RHF).
    The L-piece is on the diagram's RIGHT, so it's on the TV-viewer's LEFT → 1L(LHF).
    Output: 5531-1L(LHF) + 5531-2A(RHF).

  Worked example B — PO/2605-010 (no TV marker, dimensions only):
    Diagram shows (left → right):  [ tall narrow 200cm × 28" box ] + [ 28" 28" joined ]
    The tall narrow box on the LEFT is the L-shape (chaise extension), so it's on the TV-viewer's RIGHT → 1L(RHF).
    The joined 28"+28" pair on the RIGHT is the 2A, so it's on the TV-viewer's LEFT → 2A(LHF).
    Output: 5531-1L(RHF) + 5531-2A(LHF).

  Worked example C — PO/2605-013 (printed text says "3 Seater" but diagram splits into TWO clusters):
    Description: "HK5531/24"(3 Seater)/KN390-1 PEARL"
    Diagram: TV at top. Below: [ 24" 24" joined ] + [ 24" alone ]
    Even though the printed text says "3 Seater", the DIAGRAM shows two separate clusters joined by "+" — this means it's a 2A + 1A chain, NOT a single 3S unit.
    The joined 24"+24" pair on the diagram's LEFT is 2A → TV-viewer's RIGHT → 2A(RHF).
    The standalone 24" on the diagram's RIGHT is 1A → TV-viewer's LEFT → 1A(LHF).
    Output: 5531-1A(LHF) + 5531-2A(RHF).
    Lesson: when printed text says "N Seater" but the diagram shows multiple "+"-separated clusters, the DIAGRAM WINS — split into the modules drawn.

  Hookka rule: ALWAYS use the front-facing viewpoint (someone standing at the TV, looking AT the sofa). NEVER use the back-of-sofa viewpoint. The diagram's left/right is REVERSED from this convention. Apply this rule even when no TV marker is drawn — the convention is universal.

  ARM-INFERENCE RULE (master rule for resolving NA vs A):
  For any chain of modules joined by "+" signs:
  • OUTERMOST positions (first and last in the chain) HAVE ARMS — they form the sides of the sofa.
    → numeric outers become "1A" / "2A" with mirrored sides (left=LHF, right=RHF).
    → "L" / "CNR" outers stay as L / CNR (already imply an arm/corner).
  • INNER positions (anything sandwiched between two outers) HAVE NO ARM — their arms would collide with neighbours.
    → numeric inners become "1NA" / "2NA" / "3NA" etc.
  • Mirror-pair exception: when EXACTLY two outer modules and zero inners, both are arm modules ("1A(LHF) + 1A(RHF)" or "L(LHF) + L(RHF)").

  PDF-shorthand → catalog mapping:
  • "1R" alone or with "1R" sibling → 1A. Pair "1R+1R" → 1A(LHF) + 1A(RHF) (mirror).
  • "1+1" / "1A+1A" / two boxes side-by-side → 1A(LHF) + 1A(RHF).
  • "1+2+1" / "1+1NA+1" / "1A+1NA+1A" → 1A(LHF) + 1NA + 1A(RHF). The middle "2" or "1NA" is no-arm because it's sandwiched.
  • "1+2+L" → 1A(LHF) + 2NA + L(RHF). Left outer is 1A, middle is 2NA (sandwiched), right outer L is the corner extension.
  • "L+2+L" → L(LHF) + 2NA + L(RHF).
  • "1R+1NA+1R" / "1A+1NA+1A" → 1A(LHF) + 1NA + 1A(RHF) (NA already explicit).
  • "2+L Seater" / "2A+L" → 2A(LHF or as drawn) + L(LHF or as drawn).
  • "2+1+1" / "2A+1+1" → 2A(LHF) + 1NA + 1A(RHF) — middle 1 sandwiched is 1NA, but trailing 1 is outer so 1A(RHF).
  • "L+L+CNR" → L(LHF) + L(RHF) + CNR (corner).
  • "3 Seater" with ONE single continuous drawn box → 3S (do NOT split).
  • "3 Seater" with THREE separate drawn boxes → 1A(LHF) + 1NA + 1A(RHF).

  GOLDEN RULE: every "+" in the config string OR every separate hand-drawn box in the diagram is ITS OWN LINE ITEM. Inner numeric pieces become NA; outer pieces become A / L / CNR. Never collapse multiple boxes into a single N-seater unless the customer explicitly drew ONE continuous box.

  ★ ALWAYS INSPECT THE HAND-DRAWN DIAGRAM ★
  The printed text spec ("(1+2+L)", "1R+1R", "3 Seater") is OFTEN AMBIGUOUS by itself — you cannot reliably tell A vs S vs NA from text alone. The diagram is the source of truth:
    - Count the BOXES — that's the line-item count.
    - Look at the gaps/joiners — boxes joined with "+" are separate modules; boxes drawn merged (no "+", no gap) are one body (use S-variant).
    - Read box positions left → right — leftmost arm-piece is LHF, rightmost is RHF, sandwiched are NA.
    - Look at any small flap/L-shape on the side — that indicates an arm OR an L-extension on that side.
  When the printed text and the diagram conflict, the DIAGRAM WINS.

  Naming conventions:
  • Strip "HK" prefix when matching ("HK5531" → "5531").
  • Strip family-name aliases on bedframe; sofa codes are pure numeric models like 5530, 5531, 5536, 9068, 9028.
  • Old model numbers (8030, 9068, 9028, 5540) may map to current codes — operator will correct, output original if unsure.
  • Default to (LHF) when only ONE armed module appears and the diagram doesn't disambiguate; operator flips in preview.
  • In a mirrored pair ALWAYS output one (LHF) + one (RHF) — never two of the same side.

- sizeLabel: seat height in inches (24/26/28/30/32/35). Catalog: SOFA Sizes.
- fabricCode: from "COL:XXX" / "COLOUR:XXX" / "/KN390-2 SAND" / "/PC151-01" — match against FABRICS catalog. Sometimes a fabric appears as "BO315-2 Feather" — capture the code "BO315-2" only (drop the trailing variant word).
- legHeightInches: sofa leg height (catalog: SOFA Leg Heights). null if not stated.
- specialOrder: match against SOFA Specials. MULTIPLE specials are common on sofa POs — they often appear as bullet points in handwritten margin notes alongside the diagram. Inspect handwritten notes (in any language: English, Bahasa, Chinese) and pick all that match. Format: comma-separated string e.g. "Nylon Fabric, 5537 Backrest, Back Fully Cover".
  Pattern recognition cheat-sheet for handwriting:
    • "back fully cover" / "back rest fully cover" → "Back Fully Cover"
    • "bottom wrap nylon" / "wrap bottom to nylon" / "bottom wrap to umbrella fabric" / "umbrella fabric" / "umbra fabric" → "Nylon Fabric"  (umbrella/umbra fabric IS nylon fabric — same thing)
    • "headrest firm" / "head rest firm a little" → "Headrest Firm"
    • "back rest tak mahu pasang" / "don't install backrest" / "install at customer house" / "back rest tak mau pasang" → "Backrest Install at Customer Site"
    • "seat cushion fully cover" / "back fully cover" → "Seat Cushion Fully Cover"
    • "Replace 5540 headrest" / "Backrest change 5540" / "5540 headrest" / "8030 headrest" / "5540 = 5537" / "change to 5540" / "headrest change 5540" → "5537 Backrest"  (5540 and 8030 are model numbers that map to the 5537 Backrest spec)
    • "Bottom change to umbrella fabric" / "Bottom change to nylon" / "bottom umbrella" → "Nylon Fabric"
    • "Separate Backrest Packing" → "Separate Backrest Packing"
  Always inspect ALL handwritten margin notes (with #/* bullets) and red-pen annotations — they carry production-critical specials that aren't in the printed Description line.
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
        "rawSpec": string | null
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
  // Raw spec line text exactly as it appears on the PDF — used by the
  // server-side regex to overrule Claude when number extraction looks
  // off (LLMs occasionally truncate "10" to "1" even at temperature 0).
  rawSpec: string | null;
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
  // Server-resolved hub ID — set by validateAndEnrichPO when deliveryHub
  // matches one of the customer's hubs. Used as the actual foreign key
  // in the SO create body. Frontend can also set this from the dropdown.
  deliveryHubId: string | null;
  yourRefNo: string | null;
  // Customer's internal SO number from the "S/O No." field on the PDF.
  // Often equal to yourRefNo on HOUZS / CARRES POs, sometimes different.
  // Maps to sales_orders.customerSOId in the SO create body.
  customerSO: string | null;
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
// Server-side spec re-parser — overrules Claude on number extraction.
// LLMs occasionally truncate "10" to "1" or "12" to "1" even at temp=0;
// regex on the raw spec line is bulletproof for these patterns.
// ===========================================================================
function reparseSpec(item: ExtractedItem): void {
  if (!item.rawSpec) return;
  const spec = item.rawSpec;

  // No-leg first — many specs read "8inch + No Legs" or "no leg" or "NOLEG".
  // If matched, leg is null regardless of any number.
  const noLegRe = /\b(no\s*leg(?:s)?|noleg(?:s)?)\b/i;
  const noLegMatch = noLegRe.test(spec);

  // Divan height: number that follows "divan" / "drawer" keyword.
  // Examples: "Divan10+4" → 10. "Divan:8inch" → 8. "DRAWER:12"" → 12.
  // "Divan 8\" + No Legs" → 8. "Divan8+0" → 8.
  const divanRe = /(?:divan|drawer)[\s:.-]*(\d+(?:\.\d+)?)/i;
  const divanMatch = spec.match(divanRe);

  // Leg height: number that follows the "+" or "leg" keyword. Skip when
  // noLeg is true. Patterns: "Divan10+4" → 4. "8\"DIVAN+2\"LEG" → 2.
  // "+2 leg" → 2. "Divan10+1" → 1.
  let legMatch: RegExpMatchArray | null = null;
  if (!noLegMatch) {
    legMatch =
      spec.match(/\+\s*(\d+(?:\.\d+)?)\s*(?:"|inch|in|leg)/i) ??
      spec.match(/(\d+(?:\.\d+)?)\s*"?\s*leg/i);
  }

  // Gap: number after gap-family keywords.
  const gapRe =
    /(?:m['.\s]*gap|m\s*gap|mattress\s*gap|mattressgap|gap)[\s:.-]*(\d+(?:\.\d+)?)/i;
  const gapMatch = spec.match(gapRe);

  if (divanMatch) {
    const v = Number(divanMatch[1]);
    if (Number.isFinite(v)) item.divanHeightInches = v;
  }
  if (noLegMatch) {
    item.noLeg = true;
    item.legHeightInches = null;
  } else if (legMatch) {
    const v = Number(legMatch[1]);
    if (Number.isFinite(v)) {
      item.legHeightInches = v;
      item.noLeg = false;
    }
  }
  if (gapMatch) {
    const v = Number(gapMatch[1]);
    if (Number.isFinite(v)) item.gapInches = v;
  }
}

// ===========================================================================
// Validation
// ===========================================================================
// Side-effect: enriches `po` with customerId when customerCode/customerName
// matches a row in the catalog AND normalises text fields to their canonical
// catalog casing (e.g. "pc151-01" → "PC151-01", "hc8799" → "HC8799").
// Returns warnings for everything that didn't match — UI shows them as red
// badges per card.
function validateAndEnrichPO(po: ExtractedPO, catalog: Catalog): Warning[] {
  const warnings: Warning[] = [];

  // Build canonical-casing lookup tables: upper-case key → catalog form.
  // Lets us swap "pc151-01" → "PC151-01" without changing schema.
  const productCodes = new Set(
    [...catalog.bedframes, ...catalog.sofas, ...catalog.accessories].map((p) =>
      p.code.toUpperCase(),
    ),
  );
  const productCanon = new Map<string, string>();
  for (const p of [...catalog.bedframes, ...catalog.sofas, ...catalog.accessories]) {
    productCanon.set(p.code.toUpperCase(), p.code);
  }
  const fabricCodes = new Set(catalog.fabrics.map((f) => f.code.toUpperCase()));
  const fabricCanon = new Map<string, string>();
  for (const f of catalog.fabrics) fabricCanon.set(f.code.toUpperCase(), f.code);
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

  // Resolve customerId FIRST — hub normalisation below depends on knowing
  // which customer's hubs to scope the match to.
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

  // Normalise reference fields to upper case — these are short alphanumeric
  // identifiers (e.g. "hc8799", "TCF0431", "HC14096") and the operator
  // wants a single canonical casing on screen.
  if (po.yourRefNo) po.yourRefNo = po.yourRefNo.toUpperCase();
  if (po.customerSO) po.customerSO = po.customerSO.toUpperCase();
  if (po.deliveryHub) po.deliveryHub = po.deliveryHub.toUpperCase();

  // Hub matching is customer-scoped. Catalog hub shortNames are
  // customer-prefixed ("Houzs PG", "Carress KL"…), but PDFs typically
  // only write the location code ("PG", "KL"). Match by suffix WITHIN
  // the matched customer's own hubs, then snap to the canonical
  // shortName so the UI shows the full hub name.
  if (po.deliveryHub && matchedCustomer) {
    const ph = po.deliveryHub.toUpperCase();
    const candidate = matchedCustomer.hubs.find((h) => {
      const u = h.shortName.toUpperCase();
      return u === ph || u.endsWith(` ${ph}`) || u.endsWith(`-${ph}`);
    });
    if (candidate) {
      po.deliveryHub = candidate.shortName;
      po.deliveryHubId = candidate.id;
    }
  }
  // Fallback: if Claude didn't extract a hub but the customer has a single
  // default hub, leave po.deliveryHub null but pass nothing — operator
  // will pick from the dropdown explicitly.
  if (!po.deliveryHubId && po.deliveryHub == null) {
    po.deliveryHubId = null;
  }
  // Hookka house convention: list sofa items in LHF → NA / inner → RHF
  // order, regardless of how Claude returned them. Operator wants the
  // leftmost (LHF) piece always at line 1 so production planning sees a
  // consistent layout.
  if (po.items.some((i) => i.category === "SOFA")) {
    const sideRank = (code: string): number => {
      const c = (code || "").toUpperCase();
      if (c.includes("(LHF)")) return 0;
      if (c.includes("(RHF)")) return 2;
      return 1; // NA / standalone (1S/2S/3S/CNR/STOOL)
    };
    po.items.sort((a, b) => sideRank(a.productCode) - sideRank(b.productCode));
  }

  for (const item of po.items) {
    // Regex re-parse the spec line to overrule any Claude truncation
    // mistakes (e.g. "10" reported as 1). Bedframe-specific; skipped for
    // SOFA / ACCESSORY where the spec format is different.
    if (item.category !== "SOFA" && item.category !== "ACCESSORY") {
      reparseSpec(item);
    }
    // Fabric: snap to catalog canonical casing if matched, else just upper.
    if (item.fabricCode) {
      const upper = item.fabricCode.toUpperCase();
      item.fabricCode = fabricCanon.get(upper) ?? upper;
    }
    // Product: snap to catalog form so "hok-1007 (k)" → "HOK-1007 (K)".
    // Also handle 1-prefix mismatch — Claude sometimes outputs
    // "5531-1L(LHF)" but the catalog stores "5531-L(LHF)" (or vice
    // versa for some models). Try toggling the "1" prefix before the
    // module letter and snap to whichever form the catalog has.
    if (item.productCode) {
      const upper = item.productCode.toUpperCase();
      let canon = productCanon.get(upper);
      if (!canon) {
        // "5531-1L(LHF)" → "5531-L(LHF)"
        const dropOne = upper.replace(/-1([A-Z])/, "-$1");
        if (dropOne !== upper) canon = productCanon.get(dropOne);
      }
      if (!canon) {
        // "5531-L(LHF)" → "5531-1L(LHF)"
        const addOne = upper.replace(/-([A-Z])(\(|$)/, "-1$1$2");
        if (addOne !== upper) canon = productCanon.get(addOne);
      }
      if (canon) item.productCode = canon;
    }
    // Transferred-SO references.
    if (item.transferredSO) item.transferredSO = item.transferredSO.toUpperCase();
  }

  if (po.deliveryHub) {
    // After the customer-scoped snap above, deliveryHub should equal one
    // of the matched customer's hub shortNames; if it doesn't (or no
    // customer was matched), fall back to the global set.
    const ph = po.deliveryHub.toUpperCase();
    const inCustomerHubs = matchedCustomer?.hubs.some(
      (h) => h.shortName.toUpperCase() === ph,
    );
    const inGlobalHubs = hubShortNames.has(ph);
    if (!inCustomerHubs && !inGlobalHubs) {
      warnings.push({
        field: "deliveryHub",
        value: po.deliveryHub,
        message: "Delivery hub not in catalog.",
      });
    }
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
  await ensureScanPoColumns(c.var.DB as unknown as DBLike);
  const catalog = await loadCatalog(c.var.DB as unknown as DBLike, orgId);
  return c.json({
    success: true,
    data: {
      customers: catalog.customers.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        // Hubs as objects { id, shortName, state } so the modal can populate
        // a real dropdown bound to the matched customer's hubs and pass
        // the actual hub ID into the SO create body (not the shortName).
        hubs: c.hubs.map((h) => ({ id: h.id, shortName: h.shortName, state: h.state })),
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
  await ensureScanPoColumns(c.var.DB as unknown as DBLike);
  const catalog = await loadCatalog(c.var.DB as unknown as DBLike, orgId);
  const catalogText = formatCatalog(catalog);
  const customerRulesText = formatCustomerRules(catalog);

  const createdBy = (c.get("userId" as never) as string | undefined) ?? null;
  const customerHintGuess = name.split(/[-_ .]/)[0]?.slice(0, 40) ?? null;

  // Cached prefix = SYSTEM_PROMPT + catalog + per-customer rules. Refreshes
  // only when DB changes (catalog row, fabric, or customer.ocrPromptRules
  // edit). Anthropic prompt-caching gives ~90% discount on cache hits within
  // 5 min, so a stable shape across requests matters more than cherry-picking
  // only the matched customer's block.
  const cachedPrefix = `${SYSTEM_PROMPT}\n\nCATALOG\n=======\n${catalogText}\n\n${customerRulesText}`;

  // Phase 5: pull a few-shot pool of operator-confirmed extractions. Gold-
  // marked rows (operator hit "Mark as gold reference") win over plain
  // confirms; rows from the same customer hint win over generic. Capped
  // at 3 examples to keep tokens reasonable. Loaded outside the cache
  // boundary so adding a new gold sample doesn't invalidate the catalog
  // cache for everyone.
  let fewShotText = "";
  try {
    const examples = await (c.var.DB as unknown as DBLike)
      .prepare(
        `SELECT id, correctedJson, isGold, customerHint
           FROM po_scan_samples
           WHERE correctedJson IS NOT NULL
           ORDER BY
             (CASE WHEN customerHint = ? THEN 0 ELSE 1 END),
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
    // Few-shot is best-effort. If the column isn't there yet (migration
    // hasn't applied) we just skip it.
  }

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
        // temperature=0 makes Claude maximally deterministic. Critical for
        // OCR — the operator reported "first run correct, second run
        // wrong" with the default temperature=1.0. With t=0 the same PDF
        // + same prompt should produce identical output every time, so
        // any wrong field becomes a reproducible bug we can prompt-fix
        // instead of a flaky lottery.
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
              ...(fewShotText
                ? [{ type: "text", text: fewShotText }]
                : []),
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
                text:
                  "Extract all POs from the PDF above using the rules + catalog. " +
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

  let body: { correctedJson?: unknown; gold?: unknown };
  try {
    body = (await c.req.json()) as { correctedJson?: unknown; gold?: unknown };
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
  const goldFlag = body.gold === true ? 1 : 0;

  // Self-apply the isGold column so older Supabase instances stay
  // forward-compatible without needing a deploy-ordered migration.
  try {
    await (c.var.DB as unknown as DBLike)
      .prepare(
        "ALTER TABLE po_scan_samples ADD COLUMN IF NOT EXISTS isGold INTEGER NOT NULL DEFAULT 0",
      )
      .bind()
      .run();
  } catch {
    /* best-effort */
  }

  const result = await (c.var.DB as unknown as DBLike)
    .prepare("UPDATE po_scan_samples SET correctedJson = ?, isGold = ? WHERE id = ?")
    .bind(payload, goldFlag, id)
    .run();

  if (!result.success || result.meta.changes === 0) {
    return c.json(
      { success: false, error: "Sample not found or update failed." },
      404,
    );
  }

  return c.json({ success: true });
});

// ===========================================================================
// PATCH /api/scan-po/samples/by-po/:poIdentifier — bulk-unmark gold by PO
// (or set, with body { gold: true }). Lets the operator undo a misclick on
// the gold-reference button without hunting for individual sample IDs.
// ===========================================================================
app.patch("/samples/by-po/:poIdentifier", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;
  const poIdentifier = c.req.param("poIdentifier");
  if (!poIdentifier) {
    return c.json({ success: false, error: "Missing poIdentifier." }, 400);
  }
  let body: { gold?: unknown };
  try {
    body = (await c.req.json()) as { gold?: unknown };
  } catch {
    return c.json({ success: false, error: "Invalid JSON body." }, 400);
  }
  const goldFlag = body.gold === true ? 1 : 0;

  // Self-apply isGold column in case migration hasn't propagated.
  try {
    await (c.var.DB as unknown as DBLike)
      .prepare(
        "ALTER TABLE po_scan_samples ADD COLUMN IF NOT EXISTS isGold INTEGER NOT NULL DEFAULT 0",
      )
      .bind()
      .run();
  } catch {
    /* best-effort */
  }

  const result = await (c.var.DB as unknown as DBLike)
    .prepare(
      "UPDATE po_scan_samples SET isGold = ? WHERE poIdentifier = ?",
    )
    .bind(goldFlag, poIdentifier)
    .run();

  return c.json({
    success: true,
    poIdentifier,
    gold: goldFlag === 1,
    updated: result.meta.changes,
  });
});

// ===========================================================================
// GET /api/scan-po/customer-rules/:customerId — read this customer's rules
// PUT /api/scan-po/customer-rules/:customerId — replace this customer's rules
//
// Operator workflow: hit GET to see the current value, edit the prose, PUT
// it back. Rules are plain text (Markdown-ish). Empty string clears the rules
// (the customer's <customer> block in the prompt will render as a stub).
// RBAC: gated by `customers:update` so the same role that can edit other
// customer fields can edit OCR rules.
// ===========================================================================
app.get("/customer-rules/:customerId", async (c) => {
  const denied = await requirePermission(c, "customers", "read");
  if (denied) return denied;
  await ensureScanPoColumns(c.var.DB as unknown as DBLike);
  const customerId = c.req.param("customerId");
  const orgId = getOrgId(c);
  const row = await (c.var.DB as unknown as DBLike)
    .prepare(
      "SELECT id, code, name, ocrPromptRules FROM customers WHERE id = ? AND orgId = ?",
    )
    .bind(customerId, orgId)
    .first<{ id: string; code: string; name: string; ocrPromptRules: string | null }>();
  if (!row) {
    return c.json({ success: false, error: "Customer not found." }, 404);
  }
  return c.json({
    success: true,
    data: {
      customerId: row.id,
      customerCode: row.code,
      customerName: row.name,
      ocrPromptRules: row.ocrPromptRules ?? "",
    },
  });
});

app.put("/customer-rules/:customerId", async (c) => {
  const denied = await requirePermission(c, "customers", "update");
  if (denied) return denied;
  await ensureScanPoColumns(c.var.DB as unknown as DBLike);
  const customerId = c.req.param("customerId");
  const orgId = getOrgId(c);

  let body: { ocrPromptRules?: unknown };
  try {
    body = (await c.req.json()) as { ocrPromptRules?: unknown };
  } catch {
    return c.json({ success: false, error: "Invalid JSON body." }, 400);
  }
  if (typeof body.ocrPromptRules !== "string") {
    return c.json(
      { success: false, error: "Missing or non-string `ocrPromptRules`." },
      400,
    );
  }

  // Soft cap so a runaway paste can't blow up the prompt cache. ~32k chars
  // ≈ ~8k tokens — generous for any single customer's quirks doc.
  const value = body.ocrPromptRules;
  if (value.length > 32_000) {
    return c.json(
      { success: false, error: "ocrPromptRules too long (max 32000 chars)." },
      400,
    );
  }

  // Empty string is allowed — it clears the rules so the <customer> block in
  // the prompt renders as a stub. Store as NULL when blank to keep the column
  // tidy.
  const stored = value.trim().length === 0 ? null : value;

  const result = await (c.var.DB as unknown as DBLike)
    .prepare(
      "UPDATE customers SET ocrPromptRules = ? WHERE id = ? AND orgId = ?",
    )
    .bind(stored, customerId, orgId)
    .run();

  if (!result.success || result.meta.changes === 0) {
    return c.json(
      { success: false, error: "Customer not found or update failed." },
      404,
    );
  }

  return c.json({
    success: true,
    data: {
      customerId,
      ocrPromptRules: stored ?? "",
    },
  });
});

// Silences "imported but unused" — the type is only used as a structural hint.
export type { SampleRow };

export default app;
