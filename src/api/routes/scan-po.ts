// ---------------------------------------------------------------------------
// scan-po.ts — Claude-powered Customer PO OCR route.
//
// HTTP layer + post-processing only — the prompt-building + Anthropic call +
// JSON parsing live in src/api/lib/scan-engine.ts (shared with the
// background queue worker, routes/scan-queue.ts). What stays HERE:
//
//   • Multipart parsing / file validation (this route owns its HTTP contract)
//   • Per-PO post-processing: reparseSpec, applySofaLhfRhfFromTv,
//     validateAndEnrichPO (catalog canonicalisation, hub resolution,
//     LHF/RHF enforcement, no-arm sandwich rule)
//   • One `po_scan_samples` row per parsed PO (each card on the preview UI
//     has its own sampleId so few-shot lifecycle is per-PO)
//   • Sample-confirm + gold-mark + distill triggers
//   • /catalog GET for the operator preview modal
//   • /customer-rules CRUD for per-customer prompt rules
//
// Cost: ~$0.01-0.05 per PO page using claude-sonnet-4-6.
// Setup: `npx wrangler secret put ANTHROPIC_API_KEY`.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { distillCustomerRules } from "../lib/ocr-distill";
import { matchByCompanyName } from "../../lib/company-name-match";
import { cleanCustomerHint } from "../../lib/customer-hint";
import {
  runExtract,
  loadCatalog,
  type Catalog,
} from "../lib/scan-engine";

const app = new Hono<Env>();

const MAX_PDF_BYTES = 32 * 1024 * 1024;

function genId(): string {
  return `pos-${crypto.randomUUID().slice(0, 8)}`;
}

function parseJsonOrNull(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

type DBLike = {
  prepare: (sql: string) => {
    bind: (...args: unknown[]) => DBQuery;
    first: <T>() => Promise<T | null>;
    all: <T>() => Promise<{ results?: T[] }>;
  };
};
type DBQuery = {
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results?: T[] }>;
  run: () => Promise<{ success: boolean; meta: { changes: number } }>;
};

// ===========================================================================
// Types — describe the FE contract; runExtract returns the same shape (raw,
// pre-validation), this file enriches it before responding.
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
  rawSpec: string | null;
  diagramOrder: number | null;
};

type ExtractedPO = {
  customerPO: string;
  customerName: string;
  customerCode: string | null;
  customerId: string | null;
  customerState: string | null;
  deliveryHub: string | null;
  deliveryHubId: string | null;
  yourRefNo: string | null;
  customerSO: string | null;
  deliveryDate: string | null;
  isUrgent: boolean;
  pageNumbers: number[];
  tvPosition: "top" | "bottom" | "left" | "right" | "none";
  items: ExtractedItem[];
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

  const noLegRe = /\b(no\s*leg(?:s)?|noleg(?:s)?)\b/i;
  const noLegMatch = noLegRe.test(spec);

  const divanRe = /(?:divan|drawer)[\s:.-]*(\d+(?:\.\d+)?)/i;
  const divanMatch = spec.match(divanRe);

  let legMatch: RegExpMatchArray | null = null;
  if (!noLegMatch) {
    legMatch =
      spec.match(/\+\s*(\d+(?:\.\d+)?)\s*(?:"|inch|in|leg)/i) ??
      spec.match(/(\d+(?:\.\d+)?)\s*"?\s*leg/i);
  }

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
// SOFA LHF/RHF enforcer.
//
// Background: Claude consistently flips LHF/RHF the wrong way when asked to
// reason about TV-position-relative viewpoint, even with worked examples in
// the prompt. So we now have Claude report SPATIAL FACTS only (tvPosition +
// per-item diagramOrder) and apply the swap deterministically server-side.
//
// Hookka convention: LHF/RHF is from the perspective of someone STANDING AT
// THE TV looking at the sofa. So:
//   • TV at TOP of diagram     → viewer faces DOWN → diagram L=RHF, R=LHF.
//   • TV at BOTTOM of diagram  → viewer faces UP   → diagram L=LHF, R=RHF.
//   • TV on LEFT of diagram    → leftmost = LHF.
//   • TV on RIGHT of diagram   → leftmost = RHF.
//   • tvPosition = "none"      → leave Claude's guess alone and warn.
// ===========================================================================
function setSideSuffix(code: string, side: "LHF" | "RHF"): string {
  return code.replace(/\((?:LHF|RHF)\)/gi, `(${side})`);
}

function applySofaLhfRhfFromTv(po: ExtractedPO): Warning[] {
  const warnings: Warning[] = [];
  const sofaItems = po.items
    .map((it, idx) => ({ it, idx }))
    .filter((x) => x.it.category === "SOFA");
  if (sofaItems.length === 0) return warnings;

  const armed = sofaItems.filter((x) =>
    /\((?:LHF|RHF)\)/i.test(x.it.productCode || ""),
  );
  if (armed.length < 2) {
    if (po.tvPosition === "none" && armed.length > 0) {
      warnings.push({
        field: "tvPosition",
        value: "none",
        message:
          "TV/front marker not detected in sofa diagram — LHF/RHF may be wrong; verify in preview.",
      });
    }
    return warnings;
  }

  if (po.tvPosition === "none") {
    warnings.push({
      field: "tvPosition",
      value: "none",
      message:
        "TV/front marker not detected in sofa diagram — LHF/RHF may be wrong; verify in preview.",
    });
    return warnings;
  }

  const sortedArmed = [...armed].sort((a, b) => {
    const aOrder = a.it.diagramOrder;
    const bOrder = b.it.diagramOrder;
    if (aOrder == null && bOrder == null) return a.idx - b.idx;
    if (aOrder == null) return 1;
    if (bOrder == null) return -1;
    return aOrder - bOrder;
  });

  const leftmost = sortedArmed[0];
  const rightmost = sortedArmed[sortedArmed.length - 1];

  let leftmostSide: "LHF" | "RHF";
  let rightmostSide: "LHF" | "RHF";
  switch (po.tvPosition) {
    case "top":
      leftmostSide = "RHF";
      rightmostSide = "LHF";
      break;
    case "bottom":
      leftmostSide = "LHF";
      rightmostSide = "RHF";
      break;
    case "left":
      leftmostSide = "LHF";
      rightmostSide = "RHF";
      break;
    case "right":
      leftmostSide = "RHF";
      rightmostSide = "LHF";
      break;
    default:
      return warnings;
  }

  po.items[leftmost.idx] = {
    ...leftmost.it,
    productCode: setSideSuffix(leftmost.it.productCode || "", leftmostSide),
  };
  if (rightmost.idx !== leftmost.idx) {
    po.items[rightmost.idx] = {
      ...rightmost.it,
      productCode: setSideSuffix(rightmost.it.productCode || "", rightmostSide),
    };
  }
  return warnings;
}

// ===========================================================================
// Validation
// ===========================================================================
function normalizeForMatch(s: string): string {
  return s
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map((seg) => seg.replace(/(?:^|(?<=\D))0+(?=\d)/g, ""))
    .join("");
}

function validateAndEnrichPO(po: ExtractedPO, catalog: Catalog): Warning[] {
  const warnings: Warning[] = [];

  const productCodes = new Set(
    [...catalog.bedframes, ...catalog.sofas, ...catalog.accessories].map((p) =>
      p.code.toUpperCase(),
    ),
  );
  const productCanon = new Map<string, string>();
  for (const p of [
    ...catalog.bedframes,
    ...catalog.sofas,
    ...catalog.accessories,
  ]) {
    productCanon.set(p.code.toUpperCase(), p.code);
  }
  const fabricCodes = new Set(catalog.fabrics.map((f) => f.code.toUpperCase()));
  const fabricCanon = new Map<string, string>();
  for (const f of catalog.fabrics) fabricCanon.set(f.code.toUpperCase(), f.code);
  const fabricCanonByNorm = new Map<string, string>();
  for (const f of catalog.fabrics) {
    fabricCanonByNorm.set(normalizeForMatch(f.code), f.code);
  }
  const productCanonByNorm = new Map<string, string>();
  for (const p of [
    ...catalog.bedframes,
    ...catalog.sofas,
    ...catalog.accessories,
  ]) {
    productCanonByNorm.set(normalizeForMatch(p.code), p.code);
  }
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

  let matchedCustomer: Catalog["customers"][number] | undefined;
  if (po.customerCode) {
    matchedCustomer = customerByCode.get(po.customerCode.toUpperCase());
  }
  if (!matchedCustomer && po.customerName) {
    matchedCustomer = customerByName.get(po.customerName.toUpperCase());
  }
  // Tolerant fallback (BUG-2026-07-01): a PO printed with the full legal name
  // ("Houzs Century Sdn Bhd") must still match the catalog's short form
  // ("Houzs Century"). Ignores the Sdn Bhd / Berhad / PLT suffix + spacing +
  // punctuation, and only auto-matches when the normalized name is UNIQUE —
  // never guesses between two same-normalizing companies. Runs AFTER the exact
  // code/name matches so an exact hit always wins.
  if (!matchedCustomer && po.customerName) {
    matchedCustomer =
      matchByCompanyName(catalog.customers, po.customerName) ?? undefined;
  }
  // Last resort — resolve the customer from a delivery hub printed on the PO.
  // A hub short name ("Houzs KL") is OUR identifier, so it ties the scanned
  // document back to our records even when the company name differs (owner
  // 2026-07-01: "原本就是 documentation match 回我们的东西"). Unique-guarded:
  // if two customers own a same-named hub, stay unmatched rather than guess.
  if (!matchedCustomer && po.deliveryHub) {
    const hubTarget = po.deliveryHub.trim().toUpperCase();
    let hubHit: Catalog["customers"][number] | undefined;
    let ambiguous = false;
    for (const cust of catalog.customers) {
      if (cust.hubs.some((h) => h.shortName.toUpperCase() === hubTarget)) {
        if (hubHit) {
          ambiguous = true;
          break;
        }
        hubHit = cust;
      }
    }
    if (hubHit && !ambiguous) matchedCustomer = hubHit;
  }
  if (matchedCustomer) {
    po.customerId = matchedCustomer.id;
    if (!po.customerCode) po.customerCode = matchedCustomer.code;
  } else {
    po.customerId = null;
    warnings.push({
      field: "customerName",
      value: po.customerName ?? "",
      message:
        "Customer not in catalog — please match manually before creating SO.",
    });
  }

  if (po.yourRefNo) po.yourRefNo = po.yourRefNo.toUpperCase();
  if (po.customerSO) po.customerSO = po.customerSO.toUpperCase();
  if (po.deliveryHub) po.deliveryHub = po.deliveryHub.toUpperCase();

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
  if (!po.deliveryHubId && po.deliveryHub == null) {
    po.deliveryHubId = null;
  }
  warnings.push(...applySofaLhfRhfFromTv(po));

  if (po.items.some((i) => i.category === "SOFA" || i.category === "ACCESSORY")) {
    const itemRank = (item: ExtractedItem): number => {
      if (item.category === "ACCESSORY") return 4;
      const c = (item.productCode || "").toUpperCase();
      if (c.includes("STOOL")) return 3;
      if (c.includes("(LHF)")) return 0;
      if (c.includes("(RHF)")) return 2;
      return 1;
    };
    po.items.sort((a, b) => itemRank(a) - itemRank(b));
  }

  for (const item of po.items) {
    if (item.category !== "SOFA" && item.category !== "ACCESSORY") {
      reparseSpec(item);
    }
    if (item.fabricCode) {
      const upper = item.fabricCode.toUpperCase();
      let canon = fabricCanon.get(upper);
      if (!canon) canon = fabricCanonByNorm.get(normalizeForMatch(item.fabricCode));
      item.fabricCode = canon ?? "";
    }
    if (item.productCode) {
      const upper = item.productCode.toUpperCase();
      let canon = productCanon.get(upper);
      if (!canon) {
        const dropOne = upper.replace(/-1([A-Z])/, "-$1");
        if (dropOne !== upper) canon = productCanon.get(dropOne);
      }
      if (!canon) {
        const addOne = upper.replace(/-([A-Z])(\(|$)/, "-1$1$2");
        if (addOne !== upper) canon = productCanon.get(addOne);
      }
      if (!canon) {
        canon = productCanonByNorm.get(normalizeForMatch(item.productCode));
      }
      item.productCode = canon ?? "";
    }
    if (item.productCode && item.specialOrder) {
      const productInfo = [
        ...catalog.bedframes,
        ...catalog.sofas,
        ...catalog.accessories,
      ].find((p) => p.code === item.productCode);
      if (productInfo) {
        const normName = productInfo.name
          .toLowerCase()
          .replace(/[()]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const tokens = item.specialOrder
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const kept = tokens.filter((t) => {
          const norm = t.toLowerCase().replace(/\s+/g, " ").trim();
          return !normName.includes(norm);
        });
        item.specialOrder = kept.length > 0 ? kept.join(", ") : null;
      }
    }
    if (item.transferredSO) item.transferredSO = item.transferredSO.toUpperCase();
  }

  if (po.deliveryHub) {
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
// GET /api/scan-po/catalog
// ===========================================================================
app.get("/catalog", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;
  const orgId = getOrgId(c);

  const catalog = await loadCatalog(c.var.DB as unknown as Parameters<typeof loadCatalog>[0], orgId);
  return c.json({
    success: true,
    data: {
      customers: catalog.customers.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        hubs: c.hubs.map((h) => ({
          id: h.id,
          shortName: h.shortName,
          state: h.state,
        })),
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
  const lowerName = name.toLowerCase();
  const isPdf = mime === "application/pdf" || lowerName.endsWith(".pdf");
  const isImage =
    mime === "image/jpeg" ||
    mime === "image/png" ||
    mime === "image/webp" ||
    lowerName.endsWith(".jpg") ||
    lowerName.endsWith(".jpeg") ||
    lowerName.endsWith(".png") ||
    lowerName.endsWith(".webp");
  if (!isPdf && !isImage) {
    return c.json(
      { success: false, error: "Only PDF or image (JPEG/PNG/WebP) files are accepted." },
      400,
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  const orgId = getOrgId(c);
  const createdBy = (c.get("userId" as never) as string | undefined) ?? null;
  // Fallback hint only — the first token of the FILE NAME. Owner 2026-08-05:
  // 「为什么它会收到像 PO2068 这样的东西？非常奇怪」— operators name files after the
  // PO ("PO 2608-027.pdf", "9752.pdf"), so this token is routinely the PO
  // NUMBER, and it was being filed as the customer. cleanCustomerHint drops
  // anything that is plainly a document-number fragment; NULL is honest and the
  // dashboard folds it into 'Unidentified' rather than inventing a customer
  // called 'PO'.
  const customerHintGuess = cleanCustomerHint(name.split(/[-_ .]/)[0]?.slice(0, 40));

  // Delegate prompt-building + Anthropic call + JSON parse to the shared
  // engine. recordSample:false because this route writes its OWN per-PO
  // sample rows below (one row per parsed PO, each with its own sampleId
  // so the FE can drive the gold-mark lifecycle per card).
  const engineResult = await runExtract(c.var.DB, c.env, {
    kind: "po",
    bytes: arrayBuffer,
    mimeType: mime,
    fileName: name,
    orgId,
    createdBy,
    recordSample: false,
  });

  // Need the catalog for post-processing (validateAndEnrichPO). Reload
  // here rather than smuggling it back through runExtract — keeps the
  // engine's surface small and the route's needs explicit.
  const catalog = await loadCatalog(c.var.DB as unknown as Parameters<typeof loadCatalog>[0], orgId);

  if (!engineResult.ok) {
    // Failure path — persist a single sample row of the failure blob for
    // forensic inspection (legacy behaviour).
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
          JSON.stringify({ error: engineResult.error }),
          createdBy,
        )
        .run();
    } catch (e) {
      console.error("po_scan_samples insert failed:", (e as Error).message);
    }
    return c.json(
      {
        success: false,
        error: engineResult.error,
        sampleId,
      },
      502,
    );
  }

  const parsed = engineResult.data as { pos: ExtractedPO[] };
  const cacheHit = engineResult.meta?.cacheHit ?? false;
  const cacheCreated = engineResult.meta?.cacheCreated ?? false;

  type SamplePayload = {
    sampleId: string;
    extracted: ExtractedPO;
    warnings: Warning[];
  };
  const samples: SamplePayload[] = [];

  for (const po of parsed.pos) {
    if (po.tvPosition === undefined || po.tvPosition === null) {
      po.tvPosition = "none";
    }
    if (Array.isArray(po.items)) {
      for (const it of po.items) {
        if (it.diagramOrder === undefined) it.diagramOrder = null;
      }
    }
    const sampleId = genId();
    // Snapshot the extraction BEFORE enrichment — `rawExtracted` is the OCR
    // accuracy baseline, so it must stay exactly what Claude returned. The
    // enrichment then runs first only so its catalog match is available for the
    // hint below; it mutates `po`, never this string.
    const rawExtracted = JSON.stringify(po);
    const warnings = validateAndEnrichPO(po, catalog);

    // Prefer the RESOLVED customer's catalog name over the letterhead spelling
    // (owner 2026-08-05). validateAndEnrichPO already ran the full chain —
    // customerCode → exact name → tolerant name (Sdn Bhd) → delivery hub — so
    // 'Houzs Century Sdn Bhd' and 'Houzs Century' both store the ONE catalog
    // name and stop splitting one customer across several dashboard rows.
    // Unmatched falls back to the letterhead text, then to the file-name guess;
    // both are cleaned, so a PO number never lands here as a "customer".
    const resolvedCustomer = po.customerId
      ? catalog.customers.find((x) => x.id === po.customerId)
      : undefined;
    const customerHint =
      resolvedCustomer?.name ??
      cleanCustomerHint(po.customerName) ??
      customerHintGuess;

    try {
      await (c.var.DB as unknown as DBLike)
        .prepare(
          `INSERT INTO po_scan_samples (id, customerHint, poIdentifier, rawExtracted, correctedJson, createdBy)
           VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .bind(
          sampleId,
          customerHint,
          po.customerPO ?? null,
          rawExtracted,
          createdBy,
        )
        .run();
    } catch (e) {
      console.error("po_scan_samples insert failed:", (e as Error).message);
    }
    samples.push({ sampleId, extracted: po, warnings });
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

  // The operator's own pick is the most authoritative customer signal we ever
  // get: the preview modal's customer <select> writes customerId + the catalog
  // name onto the PO before it is confirmed. Promote it to `customerHint` so
  // the accuracy dashboard files this sample under the real customer instead of
  // the letterhead spelling — or, worse, the file name (owner 2026-08-05:
  // 「为什么它会收到像 PO2068 这样的东西？非常奇怪」). Only ever OVERWRITES with a
  // resolved catalog name; a failed lookup leaves the stored hint untouched.
  let pickedHint: string | null = null;
  const corrected: unknown =
    typeof body.correctedJson === "string"
      ? parseJsonOrNull(body.correctedJson)
      : body.correctedJson;
  const pickedCustomerId =
    corrected && typeof corrected === "object"
      ? (corrected as { customerId?: unknown }).customerId
      : null;
  if (typeof pickedCustomerId === "string" && pickedCustomerId) {
    try {
      const row = await (c.var.DB as unknown as DBLike)
        .prepare("SELECT name FROM customers WHERE id = ?")
        .bind(pickedCustomerId)
        .first<{ name: string | null }>();
      pickedHint = cleanCustomerHint(row?.name);
    } catch {
      /* best-effort — never fail an import over the accuracy sample */
    }
  }

  const result = pickedHint
    ? await (c.var.DB as unknown as DBLike)
        .prepare(
          "UPDATE po_scan_samples SET correctedJson = ?, isGold = ?, customerHint = ? WHERE id = ?",
        )
        .bind(payload, goldFlag, pickedHint, id)
        .run()
    : await (c.var.DB as unknown as DBLike)
        .prepare("UPDATE po_scan_samples SET correctedJson = ?, isGold = ? WHERE id = ?")
        .bind(payload, goldFlag, id)
        .run();

  if (!result.success || result.meta.changes === 0) {
    return c.json(
      { success: false, error: "Sample not found or update failed." },
      404,
    );
  }

  let distillQueued = false;
  if (goldFlag === 1) {
    try {
      const orgId = getOrgId(c);
      const sample = await (c.var.DB as unknown as DBLike)
        .prepare("SELECT customerHint FROM po_scan_samples WHERE id = ?")
        .bind(id)
        .first<{ customerHint: string | null }>();
      const hint = (sample?.customerHint ?? "").trim();
      if (hint) {
        const cust = await (c.var.DB as unknown as DBLike)
          .prepare(
            `SELECT id FROM customers
               WHERE orgId = ? AND isActive = 1
                 AND (
                       UPPER(name) = UPPER(?)
                    OR regexp_replace(UPPER(?), '[^A-Z0-9]', '', 'g')
                         LIKE regexp_replace(UPPER(name), '[^A-Z0-9]', '', 'g') || '%'
                 )
               ORDER BY LENGTH(name) DESC
               LIMIT 1`,
          )
          .bind(orgId, hint, hint)
          .first<{ id: string }>();
        if (cust?.id && c.executionCtx?.waitUntil) {
          c.executionCtx.waitUntil(
            distillCustomerRules(c.var.DB, c.env, orgId, cust.id)
              .then((r) => {
                if (r.status === "error") {
                  console.warn(
                    `[scan-po gold→distill] ${cust.id}: ${r.reason ?? "unknown"}`,
                  );
                }
              })
              .catch((e) =>
                console.warn("[scan-po gold→distill] threw:", e),
              ),
          );
          distillQueued = true;
        }
      }
    } catch (e) {
      console.warn("[scan-po gold→distill] dispatch skipped:", e);
    }
  }

  return c.json({ success: true, distillQueued });
});

// ===========================================================================
// GET /api/scan-po/samples/by-po/:poIdentifier
// ===========================================================================
app.get("/samples/by-po/:poIdentifier", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;
  const poIdentifier = c.req.param("poIdentifier");
  if (!poIdentifier) {
    return c.json({ success: false, error: "Missing poIdentifier." }, 400);
  }
  const row = await (c.var.DB as unknown as DBLike)
    .prepare(
      `SELECT id, customerHint, poIdentifier, rawExtracted, correctedJson, isGold, createdAt
         FROM po_scan_samples
         WHERE poIdentifier = ?
         ORDER BY createdAt DESC
         LIMIT 1`,
    )
    .bind(poIdentifier)
    .first<{
      id: string;
      customerHint: string | null;
      poIdentifier: string | null;
      rawExtracted: string | null;
      correctedJson: string | null;
      isGold: number | null;
      createdAt: string | null;
    }>();
  if (!row) {
    return c.json({ success: false, error: "Sample not found." }, 404);
  }
  let raw: unknown = null;
  let corrected: unknown = null;
  try {
    if (row.rawExtracted) raw = JSON.parse(row.rawExtracted);
  } catch {
    raw = row.rawExtracted;
  }
  try {
    if (row.correctedJson) corrected = JSON.parse(row.correctedJson);
  } catch {
    corrected = row.correctedJson;
  }
  return c.json({
    success: true,
    data: {
      id: row.id,
      customerHint: row.customerHint,
      poIdentifier: row.poIdentifier,
      isGold: row.isGold === 1,
      createdAt: row.createdAt,
      rawExtracted: raw,
      correctedJson: corrected,
    },
  });
});

// ===========================================================================
// PATCH /api/scan-po/samples/by-po/:poIdentifier
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
    .prepare("UPDATE po_scan_samples SET isGold = ? WHERE poIdentifier = ?")
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
// GET/PUT /api/scan-po/customer-rules/:customerId
// ===========================================================================
app.get("/customer-rules/:customerId", async (c) => {
  const denied = await requirePermission(c, "customers", "read");
  if (denied) return denied;

  const customerId = c.req.param("customerId");
  const orgId = getOrgId(c);
  const row = await (c.var.DB as unknown as DBLike)
    .prepare(
      "SELECT id, code, name, ocrPromptRules FROM customers WHERE id = ? AND orgId = ?",
    )
    .bind(customerId, orgId)
    .first<{
      id: string;
      code: string;
      name: string;
      ocrPromptRules: string | null;
    }>();
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

  const value = body.ocrPromptRules;
  if (value.length > 32_000) {
    return c.json(
      { success: false, error: "ocrPromptRules too long (max 32000 chars)." },
      400,
    );
  }

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

// ===========================================================================
// POST /api/scan-po/customer-rules/:customerId/distill
// ===========================================================================
app.post("/customer-rules/:customerId/distill", async (c) => {
  const denied = await requirePermission(c, "customers", "update");
  if (denied) return denied;

  const customerId = c.req.param("customerId");
  const orgId = getOrgId(c);

  const result = await distillCustomerRules(
    c.var.DB,
    c.env,
    orgId,
    customerId,
  );

  if (result.status === "distilled") {
    return c.json({
      success: true,
      rulesGenerated: result.rulesGenerated ?? "",
      sampleCount: result.sampleCount ?? 0,
      tokensIn: result.tokensIn ?? 0,
      tokensOut: result.tokensOut ?? 0,
    });
  }

  const reason = result.reason ?? "Rule distillation failed.";
  if (result.status === "skipped") {
    return c.json({ success: false, error: reason }, 400);
  }
  if (reason.startsWith("ANTHROPIC_API_KEY not configured")) {
    return c.json({ success: false, error: reason }, 500);
  }
  if (reason === "Customer not found.") {
    return c.json({ success: false, error: reason }, 404);
  }
  if (reason === "Customer update failed after distillation.") {
    return c.json({ success: false, error: reason }, 500);
  }
  return c.json({ success: false, error: reason }, 502);
});

export type { SampleRow };

export default app;
