/**
 * PO PDF Text Parser
 *
 * Parses customer PO text (extracted from PDF) into structured data
 * that can be used to auto-create Sales Orders.
 *
 * Supported formats:
 * - Houzs Century (HOK- prefix, PO-XXXXXX format)
 * - Carress (PO/YYMM-XXX format)
 * - The Conts (similar to Houzs)
 */

// ─── Types ──────────────────────────────────────────────────────────────

export type ParsedPOItem = {
  lineNo: number;
  rawDescription: string;
  productCode: string;      // e.g. "2009(A)-(K)"
  baseModel: string;        // e.g. "2009(A)"
  sizeCode: string;         // e.g. "K", "Q", "2S", "1A(LHF)"
  category: "BEDFRAME" | "SOFA" | "UNKNOWN";
  quantity: number;
  fabricCode: string;        // e.g. "PC151-01", "GD2502-14"
  divanHeightInches: number;
  legHeightInches: number;
  gapInches: number;
  seatHeight: string;        // for sofas, e.g. "28"
  specialOrder: string;
  notes: string;
};

export type ParsedPO = {
  poNo: string;
  customerName: string;
  customerId: string;        // will be matched after parsing
  deliveryHub: string;       // KL, PG, SRW, SBH
  poDate: string;            // ISO date
  deliveryDate: string;      // ISO date
  yourRefNo: string;         // customer's own SO ref
  terms: string;
  attention: string;
  isUrgent: boolean;
  items: ParsedPOItem[];
  rawText: string;           // original text for debugging
  confidence: number;        // 0-100, how confident the parse is
  warnings: string[];        // things that couldn't be parsed
};

export type POParseResult = {
  success: boolean;
  purchaseOrders: ParsedPO[];
  errors: string[];
};

// ─── Customer Detection ─────────────────────────────────────────────────

function detectCustomer(text: string): { name: string; id: string } {
  const upper = text.toUpperCase();
  if (upper.includes("HOUZS") || upper.includes("HOUZS CENTURY")) {
    return { name: "Houzs Century", id: "cust-1" };
  }
  if (upper.includes("CARRESS")) {
    return { name: "Carress", id: "cust-2" };
  }
  if (upper.includes("THE CONTS") || upper.includes("THECONTS")) {
    return { name: "The Conts", id: "cust-3" };
  }
  return { name: "", id: "" };
}

// ─── Date Parsing ───────────────────────────────────────────────────────

function parseDate(dateStr: string): string {
  if (!dateStr) return "";
  // Try common formats: DD/MM/YYYY, DD-MM-YYYY, DD MMM YYYY, YYYY-MM-DD
  const cleaned = dateStr.trim();

  // DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = cleaned.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  // DD MMM YYYY (e.g. "15 Nov 2025")
  const months: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const dMyMatch = cleaned.match(/(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{4})/i);
  if (dMyMatch) {
    const [, d, m, y] = dMyMatch;
    return `${y}-${months[m.toLowerCase()]}-${d.padStart(2, "0")}`;
  }

  // Already ISO format
  if (/^\d{4}-\d{2}-\d{2}/.test(cleaned)) {
    return cleaned.substring(0, 10);
  }

  return "";
}

// ─── Houzs PO Format Parser ────────────────────────────────────────────

function parseHouzsPO(text: string): ParsedPO[] {
  const results: ParsedPO[] = [];

  // Houzs POs can have multiple POs in one PDF, split by PO number pattern
  // Look for PO header blocks starting with "PO No" or "PO-XXXXXX"
  const poBlocks = splitHouzsBlocks(text);

  for (const block of poBlocks) {
    const po = parseHouzsBlock(block);
    if (po) results.push(po);
  }

  // If no blocks found, try parsing entire text as one PO
  if (results.length === 0) {
    const po = parseHouzsBlock(text);
    if (po) results.push(po);
  }

  return results;
}

function splitHouzsBlocks(text: string): string[] {
  // Split on PO number headers
  const poPattern = /(?=PO\s*(?:No\.?|Number)\s*:?\s*PO-\d+)/gi;
  const parts = text.split(poPattern).filter(p => p.trim().length > 50);

  if (parts.length > 1) return parts;

  // Alternative: split by repeated header patterns
  const altPattern = /(?=Purchase\s+Order[\s\S]{0,50}PO-\d+)/gi;
  const altParts = text.split(altPattern).filter(p => p.trim().length > 50);

  return altParts.length > 1 ? altParts : [text];
}

function parseHouzsBlock(block: string): ParsedPO | null {
  const warnings: string[] = [];

  // Extract PO number: PO-XXXXXX
  const poNoMatch = block.match(/PO-(\d{6})/);
  if (!poNoMatch) return null;
  const poNo = `PO-${poNoMatch[1]}`;

  // Extract Purchase Location (delivery hub)
  let hub = "";
  const locMatch = block.match(/Purchase\s+Location\s*:?\s*(KL|PG|SRW|SBH)/i);
  if (locMatch) {
    hub = locMatch[1].toUpperCase();
  }

  // Extract dates
  let poDate = "";
  let deliveryDate = "";
  const dateMatch = block.match(/Date\s*:?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{4})/i);
  if (dateMatch) poDate = parseDate(dateMatch[1]);

  const ddMatch = block.match(/Delivery\s+Date\s*:?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{4})/i);
  if (ddMatch) deliveryDate = parseDate(ddMatch[1]);

  // Extract Your Ref No
  let yourRefNo = "";
  const refMatch = block.match(/Your\s+Ref\s*(?:No\.?)?\s*:?\s*([A-Z0-9\-/]+)/i);
  if (refMatch) yourRefNo = refMatch[1];

  // Extract terms
  let terms = "";
  const termsMatch = block.match(/Terms?\s*:?\s*(NET\s*\d+|COD|C\.O\.D)/i);
  if (termsMatch) terms = termsMatch[1].replace(/\s+/g, "");

  // Check urgent
  const isUrgent = /URGENT/i.test(block);

  // Parse items
  const items = parseHouzsItems(block, warnings);

  const customer = detectCustomer(block);

  return {
    poNo,
    customerName: customer.name || "Houzs Century",
    customerId: customer.id || "cust-1",
    deliveryHub: hub,
    poDate,
    deliveryDate,
    yourRefNo,
    terms: terms || "NET30",
    attention: "",
    isUrgent,
    items,
    rawText: block,
    confidence: calculateConfidence(items, warnings),
    warnings,
  };
}

function parseHouzsItems(block: string, _warnings: string[]): ParsedPOItem[] {
  const items: ParsedPOItem[] = [];
  const lines = block.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Try to match bedframe item: HOK-XXXX(X) (size) or HOK-XXXX (size)
    const bedframeMatch = line.match(/HOK-(\d{4}(?:\([A-Z]+\))*(?:\(HF\)\(W\))?)\s*\(([A-Z]+)\)/i);
    if (bedframeMatch) {
      const [, model, size] = bedframeMatch;
      // Look for config in next lines or same line
      const configText = findConfigText(lines, i);
      const config = parseBedframeConfig(configText);

      items.push({
        lineNo: items.length + 1,
        rawDescription: line,
        productCode: `${model}-(${size})`,
        baseModel: model,
        sizeCode: size,
        category: "BEDFRAME",
        quantity: extractQuantity(line) || 1,
        fabricCode: config.fabricCode,
        divanHeightInches: config.divanHeight,
        legHeightInches: config.legHeight,
        gapInches: config.gap,
        seatHeight: "",
        specialOrder: config.specialOrder,
        notes: "",
      });
      continue;
    }

    // Try to match sofa item: HOK-XXXX SOFA
    const sofaMatch = line.match(/HOK-(\d{4})\s+SOFA/i);
    if (sofaMatch) {
      const baseModel = sofaMatch[1];
      // Look for module config in next lines
      const configText = findConfigText(lines, i);
      const sofaItems = parseSofaModules(baseModel, configText, line);

      for (const item of sofaItems) {
        item.lineNo = items.length + 1;
        items.push(item);
      }
      continue;
    }

    // Try to match Carress-style bedframe: XXXXModelName/FabX-Size (config)
    const caressMatch = line.match(/(\d{4})([A-Za-z()]+)\/(?:Fab\d+)-([A-Za-z]+)\s*\(([^)]+)\)/i);
    if (caressMatch) {
      const [, modelNo, _modelName, sizeName, configStr] = caressMatch;
      const sizeCode = mapSizeName(sizeName);
      const config = parseCaressConfig(configStr);

      items.push({
        lineNo: items.length + 1,
        rawDescription: line,
        productCode: `${modelNo}-(${sizeCode})`,
        baseModel: modelNo,
        sizeCode,
        category: "BEDFRAME",
        quantity: extractQuantity(line) || 1,
        fabricCode: config.fabricCode,
        divanHeightInches: config.divanHeight,
        legHeightInches: config.legHeight,
        gapInches: config.gap,
        seatHeight: "",
        specialOrder: config.specialOrder,
        notes: "",
      });
      continue;
    }

    // Try generic product code pattern: NUMBER(optional suffix)-(SIZE)
    const genericMatch = line.match(/(\d{4}(?:\([A-Z]+\))*)[\s-]+\(([A-Z]+)\)/i);
    if (genericMatch && !line.match(/^(PO|Date|Term|Deliver|Purchase|Total|Sub|Your|Attn)/i)) {
      const [, model, size] = genericMatch;
      const configText = findConfigText(lines, i);
      const config = parseBedframeConfig(configText);

      items.push({
        lineNo: items.length + 1,
        rawDescription: line,
        productCode: `${model}-(${size})`,
        baseModel: model,
        sizeCode: size,
        category: "BEDFRAME",
        quantity: extractQuantity(line) || 1,
        fabricCode: config.fabricCode,
        divanHeightInches: config.divanHeight,
        legHeightInches: config.legHeight,
        gapInches: config.gap,
        seatHeight: "",
        specialOrder: config.specialOrder,
        notes: "",
      });
    }
  }

  return items;
}

function findConfigText(lines: string[], currentIndex: number): string {
  // Look at current line and next 3 lines for configuration info
  const relevantLines: string[] = [];
  for (let j = currentIndex; j < Math.min(currentIndex + 4, lines.length); j++) {
    relevantLines.push(lines[j]);
  }
  return relevantLines.join(" ");
}

function parseBedframeConfig(text: string): {
  divanHeight: number;
  legHeight: number;
  gap: number;
  fabricCode: string;
  specialOrder: string;
} {
  const result = { divanHeight: 8, legHeight: 0, gap: 10, fabricCode: "", specialOrder: "" };

  // Divan height: "Divan:8inch", "DIVAN 8''", "DIVAN 8\""
  const divanMatch = text.match(/Divan\s*:?\s*(\d+)\s*(?:inch|''|"|in)/i);
  if (divanMatch) result.divanHeight = parseInt(divanMatch[1]);

  // Leg height: "+legs 2''", "+noleg", "LEGS 2''"
  const legMatch = text.match(/(?:leg|legs)\s*:?\s*(\d+)\s*(?:inch|''|"|in)/i);
  if (legMatch) result.legHeight = parseInt(legMatch[1]);
  if (/noleg/i.test(text)) result.legHeight = 0;

  // Gap: "M.Gap:14inch", "GAP 12''"
  const gapMatch = text.match(/(?:M\.?\s*)?Gap\s*:?\s*(\d+)\s*(?:inch|''|"|in)/i);
  if (gapMatch) result.gap = parseInt(gapMatch[1]);

  // Fabric code: "Col:PC151-01", "COL:GD2502-14"
  const fabricMatch = text.match(/Col(?:ou?r)?\s*:?\s*([A-Z0-9][\w-]+)/i);
  if (fabricMatch) result.fabricCode = fabricMatch[1];

  // Special order: "DIVAN CURVE", "SPECIAL", "WING"
  if (/DIVAN\s*CURVE/i.test(text)) result.specialOrder = "DIVAN CURVE";
  if (/WING/i.test(text)) result.specialOrder = "WING";

  return result;
}

function parseSofaModules(baseModel: string, text: string, originalLine: string): ParsedPOItem[] {
  const items: ParsedPOItem[] = [];

  // Look for module definitions like: 2S(28")/COL:GD2502-14
  // or compound: 1A(LHF)+CNR+2NA+L(RHF)/COL:KN390-2
  // NOTE: modulePattern is currently unused but kept for reference of the
  // full grammar we eventually want to support for sofa module parsing.
  // TODO: replace the ad-hoc module regex below with this unified pattern.
  void /((?:\d?[A-Z]+(?:\([A-Z]+\))?(?:\(\d+"\))?(?:\+|$))+)\s*\/?\s*(?:COL\s*:?\s*)?([A-Z0-9][\w-]*)?/gi;

  // First try to find fabric code
  let fabricCode = "";
  const fabMatch = text.match(/COL\s*:?\s*([A-Z0-9][\w-]+)/i);
  if (fabMatch) fabricCode = fabMatch[1];

  // Find module string with height
  // Pattern: 1A(LHF)(28")+CNR+2NA+L(RHF) or 2S(28")
  const moduleStr = text.match(/((?:[\dL](?:NA|S|A(?:\([LR]HF\))?|(?:\([LR]HF\)))?(?:\(\d+"\))?(?:\s*\+\s*)?)+(?:CNR|CSL|STOOL)?(?:\s*\+\s*(?:[\dL](?:NA|S|A(?:\([LR]HF\))?|(?:\([LR]HF\)))?(?:\(\d+"\))?))*)/i);

  if (!moduleStr) {
    // Fallback: treat as single module
    const singleMatch = text.match(/(\d[A-Z]+(?:\([A-Z]+\))?)\s*\((\d+)"\)/i);
    if (singleMatch) {
      items.push({
        lineNo: 0,
        rawDescription: originalLine,
        productCode: `${baseModel}-${singleMatch[1]}`,
        baseModel,
        sizeCode: singleMatch[1],
        category: "SOFA",
        quantity: extractQuantity(originalLine) || 1,
        fabricCode,
        divanHeightInches: 0,
        legHeightInches: 0,
        gapInches: 0,
        seatHeight: singleMatch[2],
        specialOrder: "",
        notes: "",
      });
    }
    return items;
  }

  // Parse the module string: split by +
  const modules = moduleStr[0].split(/\s*\+\s*/).filter(Boolean);
  let seatHeight = "";

  for (const mod of modules) {
    // Extract height if present: 2S(28")
    const heightMatch = mod.match(/\((\d+)"\)/);
    if (heightMatch) seatHeight = heightMatch[1];

    // Extract module code: 2S, 1A(LHF), CNR, L(RHF), 2NA
    const codeMatch = mod.replace(/\(\d+"\)/g, "").trim();
    if (!codeMatch) continue;

    items.push({
      lineNo: 0,
      rawDescription: originalLine,
      productCode: `${baseModel}-${codeMatch}`,
      baseModel,
      sizeCode: codeMatch,
      category: "SOFA",
      quantity: extractQuantity(originalLine) || 1,
      fabricCode,
      divanHeightInches: 0,
      legHeightInches: 0,
      gapInches: 0,
      seatHeight: seatHeight || "28",
      specialOrder: "",
      notes: "",
    });
  }

  return items;
}

function parseCaressConfig(configStr: string): {
  divanHeight: number;
  legHeight: number;
  gap: number;
  fabricCode: string;
  specialOrder: string;
} {
  const result = { divanHeight: 8, legHeight: 0, gap: 10, fabricCode: "", specialOrder: "" };

  const divanMatch = configStr.match(/DIVAN\s+(\d+)/i);
  if (divanMatch) result.divanHeight = parseInt(divanMatch[1]);

  const legMatch = configStr.match(/LEGS?\s+(\d+)/i);
  if (legMatch) result.legHeight = parseInt(legMatch[1]);

  const gapMatch = configStr.match(/GAP\s+(\d+)/i);
  if (gapMatch) result.gap = parseInt(gapMatch[1]);

  return result;
}

function mapSizeName(name: string): string {
  const map: Record<string, string> = {
    king: "K", queen: "Q", single: "S", supersingle: "SS",
    superking: "SK", k: "K", q: "Q", s: "S", ss: "SS", sk: "SK",
  };
  return map[name.toLowerCase()] || name.toUpperCase();
}

function extractQuantity(line: string): number {
  // Look for a standalone quantity number, typically at the start or after item description
  // Pattern: qty column usually has just a number 1-99
  const qtyMatch = line.match(/\b(\d{1,2})\s*(?:pcs?|units?|set|nos?)?\s*$/i);
  if (qtyMatch) return parseInt(qtyMatch[1]);

  // Or at the beginning after line number
  const lineQtyMatch = line.match(/^\d+\s+.*?\s+(\d{1,2})\s+/);
  if (lineQtyMatch) return parseInt(lineQtyMatch[1]);

  return 0;
}

function calculateConfidence(items: ParsedPOItem[], warnings: string[]): number {
  if (items.length === 0) return 0;

  let score = 100;

  // Deductions
  score -= warnings.length * 5;

  for (const item of items) {
    if (!item.fabricCode) score -= 5;
    if (!item.baseModel) score -= 15;
    if (item.quantity === 0) score -= 10;
  }

  return Math.max(0, Math.min(100, score));
}

// ─── Main Parse Function ────────────────────────────────────────────────

export function parsePOText(text: string): POParseResult {
  const errors: string[] = [];

  if (!text || text.trim().length < 50) {
    return { success: false, purchaseOrders: [], errors: ["PDF text too short or empty — this might be a scanned image (not supported yet)."] };
  }

  // Detect format and customer
  const customer = detectCustomer(text);

  let purchaseOrders: ParsedPO[] = [];

  // Try Houzs format first (most common ~90%)
  if (customer.name === "Houzs Century" || text.includes("PO-")) {
    purchaseOrders = parseHouzsPO(text);
  }

  // Try Carress format
  if (purchaseOrders.length === 0 && (customer.name === "Carress" || text.includes("PO/"))) {
    purchaseOrders = parseCaressPO(text);
  }

  // Generic fallback
  if (purchaseOrders.length === 0) {
    purchaseOrders = parseHouzsPO(text); // Try Houzs parser as generic fallback
    if (purchaseOrders.length === 0) {
      errors.push("Could not detect PO format. Supported: Houzs Century (PO-XXXXXX), Carress (PO/YYMM-XXX).");
    }
  }

  return {
    success: purchaseOrders.length > 0,
    purchaseOrders,
    errors,
  };
}

function parseCaressPO(text: string): ParsedPO[] {
  const warnings: string[] = [];

  // Extract PO number: PO/YYMM-XXX
  const poNoMatch = text.match(/PO\/(\d{4}-\d+)/);
  if (!poNoMatch) return [];

  const poNo = `PO/${poNoMatch[1]}`;

  // Extract dates
  let poDate = "";
  const dateMatch = text.match(/Date\s*:?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{4})/i);
  if (dateMatch) poDate = parseDate(dateMatch[1]);

  let deliveryDate = "";
  const ddMatch = text.match(/Delivery\s*(?:Date)?\s*:?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{4})/i);
  if (ddMatch) deliveryDate = parseDate(ddMatch[1]);

  // Parse items — Carress format has different structure
  const items = parseHouzsItems(text, warnings); // Reuse with some overlap

  return [{
    poNo,
    customerName: "Carress",
    customerId: "cust-2",
    deliveryHub: "KL",
    poDate,
    deliveryDate,
    yourRefNo: "",
    terms: "NET30",
    attention: "",
    isUrgent: false,
    items,
    rawText: text,
    confidence: calculateConfidence(items, warnings),
    warnings,
  }];
}

// ─── Hub Mapping ────────────────────────────────────────────────────────

export function mapDeliveryHub(customerName: string, hubCode: string): { hubId: string; hubName: string; state: string } {
  const houzsHubs: Record<string, { hubId: string; hubName: string; state: string }> = {
    KL: { hubId: "hub-h1", hubName: "Houzs KL", state: "KL" },
    PG: { hubId: "hub-h2", hubName: "Houzs PG", state: "PG" },
    SRW: { hubId: "hub-h3", hubName: "Houzs SRW", state: "SRW" },
    SBH: { hubId: "hub-h4", hubName: "Houzs SBH", state: "SBH" },
  };

  if (customerName === "Houzs Century" && houzsHubs[hubCode]) {
    return houzsHubs[hubCode];
  }

  if (customerName === "Carress") {
    return { hubId: "hub-c1", hubName: "Carress KL", state: "KL" };
  }

  if (customerName === "The Conts") {
    return { hubId: "hub-t1", hubName: "The Conts KL", state: "KL" };
  }

  return { hubId: "", hubName: "", state: hubCode };
}
