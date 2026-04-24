import React, { useState, useEffect, useMemo } from "react";
import { cachedFetchJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { useToast } from "@/components/ui/toast";
import {
  fetchVariantsConfig,
  getVariantsConfigSync,
  patchVariantsConfig,
  type VariantsConfig,
} from "@/lib/kv-config";

// ---------- Types ----------
type BOMProcess = {
  dept: string;
  deptCode: string;
  category: string;
  minutes: number;
};

type WIPMaterial = {
  code: string;
  name: string;
  qty: number;
  unit: string;
  inventoryCode?: string;
  autoDetect?: "FABRIC" | "LEG"; // auto-filled from SO item at production time
};

type CodeSegment = {
  type: "word" | "variant";
  variantCategory?: string; // SIZE, HEIGHT, FABRIC, MODULE
  value: string;
  autoDetect?: boolean; // true = value filled from SO item at production time
};

type RawMaterialOption = {
  id: string;
  itemCode: string;
  description: string;
  baseUOM: string;
  itemGroup: string;
};

type WIPComponent = {
  id: string;
  wipCode: string;
  codeSegments?: CodeSegment[];
  wipType: "HEADBOARD" | "DIVAN" | "SOFA_BASE" | "SOFA_CUSHION" | "SOFA_ARMREST" | "SOFA_HEADREST";
  quantity: number;
  processes: BOMProcess[];
  materials?: WIPMaterial[];
  children?: WIPComponent[];
};

type BOMTemplate = {
  id: string;
  productCode: string;
  baseModel: string;
  category: "BEDFRAME" | "SOFA";
  l1Processes: BOMProcess[];
  l1Materials?: WIPMaterial[];
  wipComponents: WIPComponent[];
  autoSeeded?: boolean;
};

type Product = {
  id: string;
  code: string;
  name: string;
  category: string;
  baseModel: string;
  sizeCode: string;
  sizeLabel: string;
};

// ---------- Constants ----------
const DEPT_COLORS: Record<string, string> = {
  FAB_CUT: "#3B82F6",
  FAB_SEW: "#6366F1",
  WOOD_CUT: "#F59E0B",
  FOAM: "#8B5CF6",
  FRAMING: "#F97316",
  WEBBING: "#10B981",
  UPHOLSTERY: "#F43F5E",
  PACKING: "#06B6D4",
};

const DEPT_ORDER = ["FAB_CUT", "FAB_SEW", "WOOD_CUT", "FOAM", "FRAMING", "WEBBING", "UPHOLSTERY", "PACKING"];

const DEPT_LABELS: Record<string, string> = {
  FAB_CUT: "Fab Cut",
  FAB_SEW: "Fab Sew",
  WOOD_CUT: "Wood Cut",
  FOAM: "Foam",
  FRAMING: "Framing",
  WEBBING: "Webbing",
  UPHOLSTERY: "Upholstery",
  PACKING: "Packing",
};

// ---------- Production Time lookup ----------
// Reads the dept × category minutes matrix the user configures in
// /settings/variants → Production Times. BOM process rows use this to
// auto-fill minutes when a category is picked.
// Data lives in D1 under kv_config('variants-config'); the in-memory cache is
// primed at dashboard mount (see DashboardLayout.tsx) so this sync API stays
// ergonomic for the dozens of call sites here.
function getProductionMinutes(deptCode: string, category: string): number {
  if (typeof window === "undefined") return 0;
  const cfg = getVariantsConfigSync();
  return cfg?.productionTimes?.[deptCode]?.[category] ?? 0;
}

// Category options come from the user-configured fabricGroups list
// (Variants & Options → Fabric Groups). These double as the
// production-time categories used by BOM process rows.
function getCategoryOptions(): string[] {
  const DEFAULTS = ["CAT 1", "CAT 2", "CAT 3", "CAT 4", "CAT 5", "CAT 6", "CAT 7"];
  if (typeof window === "undefined") return DEFAULTS;
  const cfg = getVariantsConfigSync();
  const groups = cfg?.fabricGroups;
  return Array.isArray(groups) && groups.length > 0 ? groups : DEFAULTS;
}

const WIP_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  HEADBOARD: { label: "Headboard", color: "#7C3AED" },
  DIVAN: { label: "Divan", color: "#0891B2" },
  SOFA_BASE: { label: "Sofa Base", color: "#059669" },
  SOFA_CUSHION: { label: "Back Cushion", color: "#D97706" },
  SOFA_ARMREST: { label: "Sofa Armrest", color: "#DC2626" },
  SOFA_HEADREST: { label: "Sofa Headrest", color: "#7C3AED" },
};

type VariantCategoryInfo = { category: string; label: string };

function buildWipCode(segments: CodeSegment[]): string {
  return segments
    .map((s) => {
      if (s.autoDetect) return `{${s.variantCategory || "auto"}}`;
      if (s.type === "variant" && !s.value) return `{${s.variantCategory || "?"}}`;
      return s.value;
    })
    .filter(Boolean)
    .join(" ");
}

// ---------- Master Templates (category-level defaults) ----------
// Multiple master templates per category. Bedframes typically have one
// "Default" master, but sofas can have many — one per module type
// (1NA, 2NA, 1A(LHF), 1A(RHF), L(LHF), CNR, 1S, 2S, 3S, ...). When
// applying defaults to a sofa product the picker matches the product's
// sizeCode to a template's moduleKey; a category-level fallback ("Default")
// covers anything that doesn't match.
//
// Master WIP items reuse the full WIPComponent shape so they can carry
// WIP Code segments and unlimited nested sub-WIP children — matching the
// Edit BOM dialog. The id / wipCode are placeholders here and get
// regenerated per-product when generateDefaultBOMParts() applies the
// template.
type MasterWIPItem = WIPComponent;

type MasterTemplate = {
  id: string;          // unique per template, e.g. "BEDFRAME", "SOFA", "SOFA-1A(LHF)"
  category: "BEDFRAME" | "SOFA";
  label: string;       // display name, e.g. "Default", "1A(LHF)"
  moduleKey?: string;  // for sofas: matches Product.sizeCode (e.g. "1A(LHF)")
  isDefault?: boolean; // category fallback used when no moduleKey matches
  l1Processes: BOMProcess[];
  l1Materials: WIPMaterial[];
  wipItems: MasterWIPItem[];
  updatedAt: string;
};

// Legacy localStorage keys — kept for a one-time migration to D1 on first
// hydrate. After that, D1 is the source of truth for master templates.
const MASTER_TPL_KEY = (id: string) => `bom-master-template-${id}`;
const MASTER_TPL_INDEX_KEY = "bom-master-templates-index";
const MASTERS_MIGRATED_FLAG = "bom-masters-migrated-to-d1";

// In-memory cache populated from D1 on app start (see hydrateMasterTemplates).
// Keeping sync load/save APIs against the cache means the dozens of existing
// call sites don't all need to become async.
let cachedMasters: MasterTemplate[] = [];
let cacheHydrated = false;
const hydrateListeners = new Set<() => void>();

function notifyHydrateListeners() {
  for (const cb of hydrateListeners) {
    try {
      cb();
    } catch {
      /* ignore */
    }
  }
}

function authHeaders(): HeadersInit {
  const raw =
    typeof window !== "undefined"
      ? localStorage.getItem("hookka_auth")
      : null;
  if (!raw) return { "content-type": "application/json" };
  try {
    const parsed = JSON.parse(raw) as { token?: string };
    return parsed.token
      ? {
          "content-type": "application/json",
          authorization: `Bearer ${parsed.token}`,
        }
      : { "content-type": "application/json" };
  } catch {
    return { "content-type": "application/json" };
  }
}

async function migrateLocalMastersToD1IfNeeded(): Promise<MasterTemplate[]> {
  if (typeof window === "undefined") return [];
  if (localStorage.getItem(MASTERS_MIGRATED_FLAG) === "1") return [];

  const idxRaw = localStorage.getItem(MASTER_TPL_INDEX_KEY);
  if (!idxRaw) {
    localStorage.setItem(MASTERS_MIGRATED_FLAG, "1");
    return [];
  }

  let ids: string[];
  try {
    ids = JSON.parse(idxRaw);
  } catch {
    localStorage.setItem(MASTERS_MIGRATED_FLAG, "1");
    return [];
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    localStorage.setItem(MASTERS_MIGRATED_FLAG, "1");
    return [];
  }

  const templates: MasterTemplate[] = [];
  for (const id of ids) {
    const raw = localStorage.getItem(MASTER_TPL_KEY(id));
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Partial<MasterTemplate>;
      templates.push({
        id: parsed.id || id,
        category:
          (parsed.category as "BEDFRAME" | "SOFA") ||
          (id === "SOFA" ? "SOFA" : "BEDFRAME"),
        label:
          parsed.label ||
          (id === "BEDFRAME" || id === "SOFA" ? "Default" : id),
        moduleKey: parsed.moduleKey,
        isDefault: parsed.isDefault ?? (id === "BEDFRAME" || id === "SOFA"),
        l1Processes: parsed.l1Processes || [],
        l1Materials: parsed.l1Materials || [],
        wipItems: parsed.wipItems || [],
        updatedAt: parsed.updatedAt || new Date().toISOString(),
      });
    } catch {
      // skip malformed entry
    }
  }

  if (templates.length === 0) {
    localStorage.setItem(MASTERS_MIGRATED_FLAG, "1");
    return [];
  }

  try {
    await fetch("/api/bom-master-templates", {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ templates, replaceAll: false }),
    });
    invalidateCachePrefix("/api/bom-master-templates");
    invalidateCachePrefix("/api/products");
    // Only clear the legacy keys after a successful upload so a failed
    // migration doesn't lose data.
    localStorage.setItem(MASTERS_MIGRATED_FLAG, "1");
    for (const id of ids) localStorage.removeItem(MASTER_TPL_KEY(id));
    localStorage.removeItem(MASTER_TPL_INDEX_KEY);
  } catch {
    // Leave the flag unset so we try again next hydrate.
  }
  return templates;
}

export async function hydrateMasterTemplates(): Promise<void> {
  try {
    await migrateLocalMastersToD1IfNeeded();
    const res = await fetch("/api/bom-master-templates", {
      headers: authHeaders(),
    });
    if (!res.ok) return;
    const json = (await res.json()) as {
      success?: boolean;
      data?: MasterTemplate[];
    };
    if (Array.isArray(json.data)) {
      cachedMasters = json.data;
      cacheHydrated = true;
      notifyHydrateListeners();
    }
  } catch {
    // offline / unauth — leave cache empty; fallback defaults will fill in.
  }
}

export function onMasterTemplatesHydrated(cb: () => void): () => void {
  hydrateListeners.add(cb);
  if (cacheHydrated) cb();
  return () => hydrateListeners.delete(cb);
}

function loadMasterTemplateIndex(): string[] {
  if (cachedMasters.length > 0) return cachedMasters.map((t) => t.id);
  return ["BEDFRAME", "SOFA"];
}

function loadMasterTemplateById(id: string): MasterTemplate | null {
  const hit = cachedMasters.find((t) => t.id === id);
  return hit ?? null;
}

function saveMasterTemplate(tpl: MasterTemplate) {
  const idx = cachedMasters.findIndex((t) => t.id === tpl.id);
  if (idx === -1) cachedMasters.push(tpl);
  else cachedMasters[idx] = tpl;
  // Background push to D1. Fire-and-forget — cache reflects the write
  // immediately for synchronous read sites; the server is authoritative
  // once the page reloads.
  void fetch(`/api/bom-master-templates/${encodeURIComponent(tpl.id)}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify(tpl),
  }).then(() => {
    invalidateCachePrefix("/api/bom-master-templates");
    invalidateCachePrefix("/api/products");
  }).catch(() => {
    /* offline — next hydrate will refresh */
  });
}

function deleteMasterTemplateById(id: string) {
  cachedMasters = cachedMasters.filter((t) => t.id !== id);
  void fetch(`/api/bom-master-templates/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  }).then(() => {
    invalidateCachePrefix("/api/bom-master-templates");
    invalidateCachePrefix("/api/products");
  }).catch(() => {
    /* offline — next hydrate will resolve */
  });
}

// Loads every master template (bedframe + sofa + all sofa modules) for the
// given category, ensuring a "Default" fallback always exists.
function loadAllMasterTemplates(cat: "BEDFRAME" | "SOFA"): MasterTemplate[] {
  const ids = loadMasterTemplateIndex();
  const list: MasterTemplate[] = [];
  for (const id of ids) {
    const tpl = loadMasterTemplateById(id);
    if (tpl && tpl.category === cat) list.push(tpl);
  }
  // Ensure a default template always exists for the category.
  if (!list.some((t) => t.isDefault)) {
    list.unshift(buildFallbackMasterTemplate(cat));
  }
  return list;
}

// Default/fallback master templates used on first open of Master Templates dialog.
function buildFallbackMasterTemplate(cat: "BEDFRAME" | "SOFA"): MasterTemplate {
  if (cat === "BEDFRAME") {
    return {
      id: "BEDFRAME",
      label: "Default",
      isDefault: true,
      category: "BEDFRAME",
      l1Processes: [
        { dept: "Fab Cut", deptCode: "FAB_CUT", category: "CAT 3", minutes: 50 },
        { dept: "Fab Sew", deptCode: "FAB_SEW", category: "CAT 3", minutes: 120 },
        { dept: "Foam", deptCode: "FOAM", category: "CAT 3", minutes: 25 },
      ],
      l1Materials: [
        { code: "", name: "Fabric (from order)", qty: 1, unit: "MTR", autoDetect: "FABRIC" },
        { code: "", name: "Leg (from order)", qty: 4, unit: "PCS", autoDetect: "LEG" },
      ],
      wipItems: [
        {
          id: "master-bedframe-divan",
          wipCode: "",
          codeSegments: [
            { type: "word", value: "Divan" },
            { type: "variant", variantCategory: "DIVAN_HEIGHT", value: "", autoDetect: true },
            { type: "variant", variantCategory: "SIZE", value: "", autoDetect: true },
          ],
          wipType: "DIVAN",
          quantity: 1,
          processes: [
            { dept: "Wood Cut", deptCode: "WOOD_CUT", category: "CAT 1", minutes: 20 },
            { dept: "Framing", deptCode: "FRAMING", category: "CAT 6", minutes: 20 },
            { dept: "Webbing", deptCode: "WEBBING", category: "CAT 1", minutes: 4 },
            { dept: "Upholstery", deptCode: "UPHOLSTERY", category: "CAT 6", minutes: 15 },
            { dept: "Packing", deptCode: "PACKING", category: "CAT 3", minutes: 20 },
          ],
          materials: [
            { code: "", name: "Fabric (from order)", qty: 1, unit: "MTR", autoDetect: "FABRIC" },
            { code: "", name: "Leg (from order)", qty: 1, unit: "PCS", autoDetect: "LEG" },
          ],
          children: [],
        },
        {
          id: "master-bedframe-headboard",
          wipCode: "",
          codeSegments: [
            { type: "word", value: "HB" },
            { type: "variant", variantCategory: "SIZE", value: "", autoDetect: true },
          ],
          wipType: "HEADBOARD",
          quantity: 1,
          processes: [
            { dept: "Wood Cut", deptCode: "WOOD_CUT", category: "CAT 5", minutes: 10 },
            { dept: "Framing", deptCode: "FRAMING", category: "CAT 4", minutes: 40 },
            { dept: "Webbing", deptCode: "WEBBING", category: "CAT 7", minutes: 20 },
            { dept: "Upholstery", deptCode: "UPHOLSTERY", category: "CAT 4", minutes: 40 },
            { dept: "Packing", deptCode: "PACKING", category: "CAT 2", minutes: 30 },
          ],
          materials: [
            { code: "", name: "Fabric (from order)", qty: 1, unit: "MTR", autoDetect: "FABRIC" },
          ],
          children: [],
        },
      ],
      updatedAt: new Date().toISOString(),
    };
  }
  // SOFA
  return {
    id: "SOFA",
    label: "Default",
    isDefault: true,
    category: "SOFA",
    l1Processes: [
      { dept: "Fab Cut", deptCode: "FAB_CUT", category: "CAT 6", minutes: 50 },
      { dept: "Packing", deptCode: "PACKING", category: "CAT 1", minutes: 40 },
      { dept: "Upholstery", deptCode: "UPHOLSTERY", category: "CAT 6", minutes: 20 },
    ],
    l1Materials: [
      { code: "", name: "Fabric (from order)", qty: 1, unit: "MTR", autoDetect: "FABRIC" },
    ],
    wipItems: [
      {
        id: "master-sofa-base",
        wipCode: "",
        codeSegments: [
          { type: "word", value: "Base" },
          { type: "variant", variantCategory: "MODULE", value: "", autoDetect: true },
        ],
        wipType: "SOFA_BASE",
        quantity: 1,
        processes: [
          { dept: "Fab Sew", deptCode: "FAB_SEW", category: "CAT 4", minutes: 150 },
          { dept: "Foam", deptCode: "FOAM", category: "CAT 4", minutes: 30 },
          { dept: "Wood Cut", deptCode: "WOOD_CUT", category: "CAT 4", minutes: 30 },
          { dept: "Framing", deptCode: "FRAMING", category: "CAT 4", minutes: 40 },
          { dept: "Webbing", deptCode: "WEBBING", category: "CAT 4", minutes: 20 },
        ],
        materials: [
          { code: "", name: "Fabric (from order)", qty: 1, unit: "MTR", autoDetect: "FABRIC" },
        ],
        children: [],
      },
      {
        id: "master-sofa-cushion",
        wipCode: "",
        codeSegments: [
          { type: "word", value: "Cushion" },
        ],
        wipType: "SOFA_CUSHION",
        quantity: 1,
        processes: [
          { dept: "Fab Sew", deptCode: "FAB_SEW", category: "CAT 1", minutes: 40 },
          { dept: "Foam", deptCode: "FOAM", category: "CAT 1", minutes: 15 },
          { dept: "Wood Cut", deptCode: "WOOD_CUT", category: "CAT 1", minutes: 15 },
          { dept: "Framing", deptCode: "FRAMING", category: "CAT 1", minutes: 15 },
          { dept: "Webbing", deptCode: "WEBBING", category: "CAT 1", minutes: 15 },
        ],
        materials: [
          { code: "", name: "Fabric (from order)", qty: 1, unit: "MTR", autoDetect: "FABRIC" },
        ],
        children: [],
      },
    ],
    updatedAt: new Date().toISOString(),
  };
}

// Picks the most specific master template for a product. For sofas, looks
// for a template whose moduleKey matches the product's sizeCode (e.g. "1A(LHF)").
// Falls back to the category default. Bedframes always use the bedframe default
// today, but the same pick logic is reused for symmetry.
function getEffectiveMasterTemplateForProduct(product: Product): MasterTemplate {
  const cat = (product.category === "SOFA" ? "SOFA" : "BEDFRAME") as "BEDFRAME" | "SOFA";
  const all = loadAllMasterTemplates(cat);
  // Try moduleKey match first (case-insensitive, exact).
  const sizeKey = (product.sizeCode || "").trim().toUpperCase();
  if (sizeKey) {
    const match = all.find((t) => (t.moduleKey || "").trim().toUpperCase() === sizeKey);
    if (match) return match;
  }
  // Fall back to the category default, then to the first available.
  return all.find((t) => t.isDefault) || all[0] || buildFallbackMasterTemplate(cat);
}

// ---------- BOM Templates Local Persistence ----------
// Legacy localStorage key from the pre-D1 era. Kept only so the load
// effect can remove any stale cache on first mount. No more reads / writes.
const BOM_TEMPLATES_KEY = "hookka-bom-templates-v2";

// ---------- Bulk BOM CSV (Export / Import) ----------
// Flattens every BOM (L1 + nested WIPs) into a single CSV the user can
// edit in Excel. Each row is either a PROCESS or a MATERIAL.
//
// Columns:
//   ProductCode, WipPath, WipCode, WipType, Kind, Index,
//   Dept, Category, Minutes, MatCode, MatName, Qty, Unit, AutoDetect
//
// Match key on re-import: ProductCode + WipPath + Kind + Index.
//   - WipPath "" means the L1 (Finished Good) row
//   - WipPath "0" is the first top-level WIP, "0/1" is its second child, etc.
//   - Index is the row position within the matching processes[] or materials[]
//
// Editable on re-import: Dept, Category, Minutes, MatCode, MatName, Qty,
// Unit, AutoDetect. Adding/removing rows is NOT supported — the structure
// must stay the same so the match keys still line up.
// Header order: presentation columns (Tree/Level/ProductName/WipName) come
// first so the file reads top-to-bottom in Excel as a tree. The importer
// looks up columns by name, so reordering / adding columns is safe — it
// only cares that ProductCode, WipPath, Kind, Index, and the editable
// fields still exist with their exact original names.
const BOM_CSV_HEADER = [
  "Tree", "Level", "ProductCode", "ProductName", "WipName",
  "WipPath", "WipCode", "WipType", "Kind", "Index",
  "Dept", "Category", "Minutes", "MatCode", "MatName", "Qty", "Unit", "AutoDetect",
];

function csvEscape(value: unknown): string {
  const s = value == null ? "" : String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// RFC4180-ish CSV parser that honours quoted fields and escaped quotes.
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { row.push(cell); cell = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; continue; }
    cell += ch; i++;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 0 && !(r.length === 1 && r[0] === ""));
}

function exportBOMsCSV(templates: BOMTemplate[]) {
  const rows: string[][] = [BOM_CSV_HEADER];

  // Sort templates alphabetically by product code so re-exports diff cleanly.
  const sorted = [...templates].sort((a, b) =>
    (a.productCode || "").localeCompare(b.productCode || "")
  );

  // Build a tree-style label: 2 spaces per level + "└─ <wipCode>" for nested
  // WIPs, or "📦 <productCode>" for the FG (L1) row. Pure spaces (no tabs)
  // so Excel doesn't collapse them. Empty wipCode falls back to wipType.
  const fgTree = (productCode: string) => `📦 ${productCode}`;
  const wipTree = (depth: number, wipLabel: string) =>
    " ".repeat(depth * 2) + "└─ " + wipLabel;
  const levelLabel = (depth: number) => (depth === 0 ? "FG" : `L${depth + 1}`);

  for (let ti = 0; ti < sorted.length; ti++) {
    const t = sorted[ti];
    const productName = t.baseModel || "";
    const fgTreeStr = fgTree(t.productCode);

    // L1 processes (FG)
    t.l1Processes.forEach((p, i) => {
      rows.push([
        fgTreeStr, "FG", t.productCode, productName, "",
        "", "L1", "FG", "PROCESS", String(i),
        p.deptCode, p.category, String(p.minutes),
        "", "", "", "", "",
      ]);
    });
    // L1 materials (FG)
    (t.l1Materials || []).forEach((m, i) => {
      rows.push([
        fgTreeStr, "FG", t.productCode, productName, "",
        "", "L1", "FG", "MATERIAL", String(i),
        "", "", "",
        m.code || "", m.name || "", String(m.qty), m.unit || "", m.autoDetect || "",
      ]);
    });

    // Recursive walk over WIPs (depth-first). Depth 1 = L2 (first WIP layer
    // under the FG); depth 2 = L3; etc.
    const walk = (wips: WIPComponent[], parentPath: string, depth: number) => {
      wips.forEach((w, idx) => {
        const path = parentPath ? `${parentPath}/${idx}` : String(idx);
        const wipCode = w.wipCode || "";
        const wipName = wipCode || (w.wipType ? WIP_TYPE_LABELS[w.wipType]?.label || w.wipType : "");
        const treeStr = wipTree(depth, wipName || w.wipType || "WIP");
        const lvl = levelLabel(depth);

        w.processes.forEach((p, i) => {
          rows.push([
            treeStr, lvl, t.productCode, productName, wipName,
            path, wipCode, w.wipType, "PROCESS", String(i),
            p.deptCode, p.category, String(p.minutes),
            "", "", "", "", "",
          ]);
        });
        (w.materials || []).forEach((m, i) => {
          rows.push([
            treeStr, lvl, t.productCode, productName, wipName,
            path, wipCode, w.wipType, "MATERIAL", String(i),
            "", "", "",
            m.code || "", m.name || "", String(m.qty), m.unit || "", m.autoDetect || "",
          ]);
        });
        if (w.children && w.children.length > 0) walk(w.children, path, depth + 1);
      });
    };
    walk(t.wipComponents, "", 1);

    // Blank separator row between products (not after the last one). The
    // importer guards against fully-blank rows by checking Kind === "" and
    // skipping silently — see applyBOMsCSV below.
    if (ti < sorted.length - 1) {
      rows.push(new Array(BOM_CSV_HEADER.length).fill(""));
    }
  }
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bom-export-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Walks templates and produces a fresh copy with the CSV rows applied.
// Returns { updated, missed } where missed are rows whose match key didn't
// resolve (e.g. typo'd product code or path).
function applyBOMsCSV(
  templates: BOMTemplate[],
  csvText: string,
  rawMaterials: RawMaterialOption[],
): { updated: BOMTemplate[]; matched: number; missed: number } {
  const rows = parseCSV(csvText);
  if (rows.length < 2) return { updated: templates, matched: 0, missed: 0 };
  const header = rows[0].map((s) => s.trim());
  const colIdx: Record<string, number> = {};
  BOM_CSV_HEADER.forEach((h) => { colIdx[h] = header.indexOf(h); });

  // Index raw materials by code so we can re-link names/units when only the
  // code changes.
  const rmByCode: Record<string, RawMaterialOption> = {};
  for (const rm of rawMaterials) rmByCode[rm.itemCode] = rm;

  // Deep clone templates so we never mutate the caller's state in place.
  const updated: BOMTemplate[] = JSON.parse(JSON.stringify(templates));
  const byCode: Record<string, BOMTemplate> = {};
  for (const t of updated) byCode[t.productCode] = t;

  // Helper: walk a WIP path like "0/1/2" inside wipComponents.
  const resolveWipNode = (tpl: BOMTemplate, path: string): WIPComponent | null => {
    if (!path) return null;
    const parts = path.split("/").map((p) => parseInt(p, 10)).filter((n) => !isNaN(n));
    let node: WIPComponent | undefined = tpl.wipComponents[parts[0]];
    for (let i = 1; i < parts.length; i++) {
      if (!node || !node.children) return null;
      node = node.children[parts[i]];
    }
    return node || null;
  };

  let matched = 0;
  let missed = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const productCode = row[colIdx.ProductCode]?.trim();
    const wipPath = row[colIdx.WipPath]?.trim() || "";
    const kind = row[colIdx.Kind]?.trim();
    const index = parseInt(row[colIdx.Index] || "0", 10);
    // Skip presentation-only rows (blank separators between products, or
    // future HEADER section rows). These have no Kind and shouldn't count
    // against the missed total.
    if (!kind || kind === "HEADER") continue;
    const tpl = byCode[productCode];
    if (!tpl) { missed++; continue; }

    // Resolve the parent (L1 of template, or a WIP node) and its target
    // processes/materials array.
    let processes: BOMProcess[] | null = null;
    let materials: WIPMaterial[] | null = null;
    if (wipPath === "") {
      processes = tpl.l1Processes;
      if (!tpl.l1Materials) tpl.l1Materials = [];
      materials = tpl.l1Materials;
    } else {
      const node = resolveWipNode(tpl, wipPath);
      if (!node) { missed++; continue; }
      processes = node.processes;
      if (!node.materials) node.materials = [];
      materials = node.materials;
    }

    if (kind === "PROCESS" && processes && processes[index]) {
      const dept = row[colIdx.Dept]?.trim();
      const category = row[colIdx.Category]?.trim();
      const minutesRaw = row[colIdx.Minutes]?.trim();
      const minutes = minutesRaw === "" ? processes[index].minutes : parseInt(minutesRaw || "0", 10);
      processes[index] = {
        ...processes[index],
        deptCode: dept || processes[index].deptCode,
        dept: DEPT_LABELS[dept] || processes[index].dept,
        category: category || processes[index].category,
        minutes: isNaN(minutes) ? processes[index].minutes : minutes,
      };
      matched++;
    } else if (kind === "MATERIAL" && materials && materials[index]) {
      const code = row[colIdx.MatCode]?.trim();
      const name = row[colIdx.MatName]?.trim();
      const qtyRaw = row[colIdx.Qty]?.trim();
      const qty = qtyRaw === "" ? materials[index].qty : parseFloat(qtyRaw || "0");
      const unit = row[colIdx.Unit]?.trim();
      const autoDetectRaw = row[colIdx.AutoDetect]?.trim();
      const autoDetect = autoDetectRaw === "FABRIC" || autoDetectRaw === "LEG" ? autoDetectRaw : undefined;
      // If the user re-pointed the row at a different inventory code,
      // re-link the description/unit from the catalogue.
      const linked = code ? rmByCode[code] : undefined;
      materials[index] = {
        ...materials[index],
        code: code ?? materials[index].code,
        name: linked ? linked.description : (name || materials[index].name),
        qty: isNaN(qty) ? materials[index].qty : qty,
        unit: linked ? linked.baseUOM : (unit || materials[index].unit),
        inventoryCode: linked ? linked.itemCode : materials[index].inventoryCode,
        autoDetect,
      };
      matched++;
    } else {
      missed++;
    }
  }

  return { updated, matched, missed };
}

// ---------- Routing Pill ----------
function RoutingPill({ process }: { process: BOMProcess }) {
  const color = DEPT_COLORS[process.deptCode] || "#6B7280";
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap"
      style={{ backgroundColor: `${color}15`, color, border: `1px solid ${color}40` }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
      {DEPT_LABELS[process.deptCode] || process.dept}
      <span className="opacity-70">{process.category}</span>
      <span className="font-semibold">{process.minutes}m</span>
    </span>
  );
}

// ---------- WIP Code Builder (3-5 segment combination) ----------
function WIPCodeBuilder({
  segments,
  onChange,
  fabricOptions,
  variantCategories,
}: {
  segments: CodeSegment[];
  onChange: (segs: CodeSegment[]) => void;
  fabricOptions: string[];
  variantCategories: VariantCategoryInfo[];
}) {
  function addSegment() {
    if (segments.length >= 5) return;
    onChange([...segments, { type: "word", value: "" }]);
  }
  function removeSegment(i: number) {
    if (segments.length <= 1) return;
    onChange(segments.filter((_, idx) => idx !== i));
  }
  function updateSegment(i: number, updates: Partial<CodeSegment>) {
    onChange(
      segments.map((s, idx) => {
        if (idx !== i) return s;
        const next = { ...s, ...updates };
        // When switching type or category, reset value
        if (updates.type && updates.type !== s.type) next.value = "";
        if (updates.variantCategory && updates.variantCategory !== s.variantCategory) next.value = "";
        // Default to "from order" (autoDetect) for categories that come straight
        // from the SO item, so the user doesn't have to click "auto" every time.
        const AUTO_DEFAULT = ["PRODUCT_CODE", "MODEL", "SIZE", "SEAT_SIZE", "MODULE", "DIVAN_HEIGHT", "LEG_HEIGHT", "TOTAL_HEIGHT", "FABRIC"];
        if (
          next.type === "variant" &&
          next.variantCategory &&
          AUTO_DEFAULT.includes(next.variantCategory) &&
          !next.value &&
          updates.autoDetect === undefined
        ) {
          next.autoDetect = true;
        }
        return next;
      })
    );
  }

  const preview = buildWipCode(segments);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1 flex-wrap">
        {segments.map((seg, i) => (
          <div key={i} className="flex items-center gap-0.5 bg-white border border-gray-200 rounded-md p-0.5">
            {/* Type selector */}
            <select
              value={seg.type === "word" ? "word" : (seg.variantCategory || "SIZE")}
              onChange={(e) => {
                const val = e.target.value;
                if (val === "word") {
                  updateSegment(i, { type: "word", variantCategory: undefined });
                } else {
                  updateSegment(i, { type: "variant", variantCategory: val });
                }
              }}
              className="text-[10px] border-0 bg-gray-100 rounded px-1 py-0.5 font-medium text-gray-600 focus:outline-none"
              style={{ width: "62px" }}
            >
              <option value="word">Text</option>
              {variantCategories.map((vc) => (
                <option key={vc.category} value={vc.category}>{vc.label}</option>
              ))}
              {!variantCategories.some(vc => vc.category === "FABRIC") && (
                <option value="FABRIC">Fabric</option>
              )}
            </select>

            {/* Value input — autoDetect shows badge, Fabric uses dropdown, rest is free text */}
            {seg.autoDetect ? (
              <button
                type="button"
                onClick={() => updateSegment(i, { autoDetect: false, value: seg.value || "" })}
                title="Click to enter manual value instead"
                className="text-[10px] px-1.5 py-0.5 bg-[#E0EDF0] text-[#3E6570] rounded font-medium border border-[#A8CAD2] whitespace-nowrap hover:bg-[#E0EDF0] cursor-pointer"
              >
                from order
              </button>
            ) : seg.variantCategory === "FABRIC" ? (
              <div className="flex items-center gap-0.5">
                <select
                  value={seg.value}
                  onChange={(e) => updateSegment(i, { value: e.target.value })}
                  className="text-xs border-0 bg-transparent px-0.5 py-0.5 focus:outline-none max-w-[100px]"
                >
                  <option value="">pick...</option>
                  {fabricOptions.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => updateSegment(i, { autoDetect: true })}
                  title="Auto-detect from order"
                  className="text-[9px] px-1 py-0.5 text-[#3E6570] hover:text-[#3E6570] hover:bg-[#E0EDF0] rounded"
                >
                  auto
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-0.5">
                <input
                  value={seg.value}
                  onChange={(e) => updateSegment(i, { value: e.target.value })}
                  placeholder={seg.type === "word" ? "type..." : (variantCategories.find(vc => vc.category === seg.variantCategory)?.label || "type...")}
                  className="text-xs border-0 bg-transparent px-1 py-0.5 w-20 focus:outline-none"
                />
                {seg.type === "variant" && ["PRODUCT_CODE", "MODEL", "SIZE", "SEAT_SIZE", "MODULE", "DIVAN_HEIGHT", "LEG_HEIGHT", "TOTAL_HEIGHT", "FABRIC"].includes(seg.variantCategory || "") && (
                  <button
                    type="button"
                    onClick={() => updateSegment(i, { autoDetect: true })}
                    title="Auto-detect from order"
                    className="text-[9px] px-1 py-0.5 text-[#3E6570] hover:text-[#3E6570] hover:bg-[#E0EDF0] rounded"
                  >
                    auto
                  </button>
                )}
              </div>
            )}

            {/* Remove */}
            {segments.length > 1 && (
              <button onClick={() => removeSegment(i)} className="text-gray-300 hover:text-[#9A3A2D] px-0.5">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        ))}

        {segments.length < 5 && (
          <button
            onClick={addSegment}
            className="text-[10px] px-1.5 py-1 bg-gray-100 text-gray-500 rounded hover:bg-gray-200 font-medium"
          >
            +
          </button>
        )}
      </div>

      {preview && (
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray-400">Code:</span>
            <span className="text-xs font-mono font-semibold text-[#111827] bg-[#FAEFCB] px-1.5 py-0.5 rounded border border-[#E8D597]">
              {preview}
            </span>
          </div>
          {segments.some(s => s.autoDetect) && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-400">Sample:</span>
              <span className="text-[11px] font-mono text-gray-500 bg-gray-50 px-1.5 py-0.5 rounded border border-gray-200">
                {segments.map((s) => {
                  if (!s.autoDetect) return s.value;
                  const isSofa = variantCategories.some((v) => v.category === "MODULE");
                  // For sofas: SIZE = physical seat size (e.g. 3-Seater),
                  // MODULE = configuration code (1NA, 2A, 1S, L(LHF) ...).
                  // These are TWO different dimensions — never reuse the
                  // same sample value for both.
                  const examples: Record<string, string> = isSofa
                    ? { PRODUCT_CODE: "5530-1NA", MODEL: "5530", SIZE: "3-Seater", SEAT_SIZE: '30"', MODULE: "1NA", FABRIC: "PC151-01" }
                    : { PRODUCT_CODE: "1003-(K)", MODEL: "1003", SIZE: "6FT", DIVAN_HEIGHT: '8"', LEG_HEIGHT: '2"', TOTAL_HEIGHT: '10"', FABRIC: "PC151-01" };
                  return examples[s.variantCategory || ""] || s.variantCategory || "?";
                }).filter(Boolean).join(" ")}
              </span>
              <span className="text-[9px] text-gray-400 italic">from SO item</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Raw Material Select (searchable dropdown from inventory) ----------
function RawMaterialSelect({
  value,
  materials,
  onSelect,
}: {
  value: string;
  materials: RawMaterialOption[];
  onSelect: (rm: RawMaterialOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search.trim()) return materials.slice(0, 50);
    const q = search.toLowerCase();
    return materials.filter(
      (m) => m.itemCode.toLowerCase().includes(q) || m.description.toLowerCase().includes(q)
    ).slice(0, 50);
  }, [materials, search]);

  return (
    <div className="relative flex-1">
      <button
        type="button"
        onClick={() => { setOpen(!open); setSearch(""); }}
        className="w-full text-left text-xs border border-gray-200 rounded px-1.5 py-1 bg-white hover:bg-gray-50 truncate font-mono"
      >
        {value || <span className="text-gray-400">Select material...</span>}
      </button>

      {open && (
        <div className="absolute top-full left-0 z-50 mt-0.5 w-[320px] bg-white border border-gray-200 rounded-lg shadow-lg">
          <div className="p-1.5">
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by code or description..."
              className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/40"
            />
          </div>
          <div className="max-h-[200px] overflow-y-auto divide-y divide-gray-100">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-xs text-gray-400 text-center">No materials found</div>
            ) : (
              filtered.map((rm) => (
                <button
                  key={rm.id}
                  onClick={() => { onSelect(rm); setOpen(false); }}
                  className="w-full text-left px-2 py-1.5 hover:bg-[#FAF9F7] transition-colors"
                >
                  <div className="text-xs font-mono font-medium text-[#111827]">{rm.itemCode}</div>
                  <div className="text-[10px] text-gray-500 truncate">{rm.description} · {rm.baseUOM}</div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- WIP Tree Node ----------
// Resolves a WIP code for display by replacing autoDetect placeholders
// ({DIVAN_HEIGHT}, {FABRIC}, etc.) with sample values so the tree shows
// a realistic preview instead of raw placeholder tokens.
function buildWipCodeDisplay(segments: CodeSegment[] | undefined, product?: Product): string {
  if (!segments || segments.length === 0) return "";
  const isSofa = product?.category === "SOFA";
  // For sofas: SIZE = seat size (3-Seater / L210cm), MODULE = config (1NA).
  // Product.sizeCode currently doubles as the module key for sofas, so we
  // treat sizeLabel as the seat size and sizeCode as the module.
  const samples: Record<string, string> = {
    PRODUCT_CODE: product?.code || (isSofa ? "5530-1NA" : "1003-(K)"),
    MODEL: product?.baseModel || (isSofa ? "5530" : "1003"),
    SIZE: product?.sizeLabel || (isSofa ? "3-Seater" : "6FT"),
    SEAT_SIZE: isSofa ? '30"' : "",
    DIVAN_HEIGHT: '8"',
    LEG_HEIGHT: '2"',
    TOTAL_HEIGHT: '10"',
    FABRIC: "PC151-01",
    MODULE: product?.sizeCode || (isSofa ? "1NA" : ""),
    SPECIAL: "STD",
  };
  return segments
    .map((s) => {
      if (s.type === "word") return s.value;
      const cat = s.variantCategory || "";
      if (s.value && !s.autoDetect) return s.value;
      return samples[cat] || s.value || `{${cat}}`;
    })
    .filter(Boolean)
    .join(" ");
}

// Level → color mapping that mirrors the Master Template editor.
// L2 (top WIP)  → blue   (matches editor L1 WIP container)
// L3 (depth=0)  → purple
// L4 (depth=1)  → orange
// L5 (depth=2)  → emerald
// L6 (depth=3)  → rose
const WIP_LEVEL_COLORS = [
  { container: "bg-[#E0EDF0] border-[#A8CAD2]", badge: "bg-[#E0EDF0] text-[#3E6570]", divider: "border-[#A8CAD2]/60", title: "text-[#3E6570]" },
  { container: "bg-[#F1E6F0] border-[#D1B7D0]", badge: "bg-[#F1E6F0] text-[#6B4A6D]", divider: "border-[#D1B7D0]/60", title: "text-[#6B4A6D]" },
  { container: "bg-[#FBE4CE] border-[#E8B786]", badge: "bg-[#FBE4CE] text-[#B8601A]", divider: "border-[#E8B786]/60", title: "text-[#B8601A]" },
  { container: "bg-emerald-50 border-emerald-300", badge: "bg-emerald-200 text-emerald-800", divider: "border-emerald-200/60", title: "text-emerald-700" },
  { container: "bg-[#F9E1DA] border-[#E8B2A1]", badge: "bg-[#F9E1DA] text-[#9A3A2D]", divider: "border-[#E8B2A1]/60", title: "text-[#9A3A2D]" },
];

function WIPNode({ wip, product, level = 1 }: { wip: WIPComponent; product?: Product; level?: number }) {
  const [expanded, setExpanded] = useState(true);
  const wipStyle = WIP_TYPE_LABELS[wip.wipType] || { label: wip.wipType, color: "#6B7280" };
  const totalMin = wip.processes.reduce((s, p) => s + p.minutes, 0);
  const displayCode = buildWipCodeDisplay(wip.codeSegments, product) || wip.wipCode;
  const children = wip.children || [];
  const materials = wip.materials || [];
  const colorIdx = Math.min(level - 1, WIP_LEVEL_COLORS.length - 1);
  const colors = WIP_LEVEL_COLORS[colorIdx];

  return (
    <div className="ml-6 mt-2">
      {/* Connector line */}
      <div className="flex items-center mb-1">
        <div className="w-4 h-px bg-gray-300" />
        <svg className="w-3 h-3 text-gray-400 -ml-0.5" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
        </svg>
      </div>

      <div className={`border rounded-lg overflow-hidden ${colors.container}`}>
        <div
          className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
          onClick={() => setExpanded(!expanded)}
        >
          <svg
            className={`w-4 h-4 text-gray-500 transition-transform flex-shrink-0 ${expanded ? "rotate-90" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>

          <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${colors.badge}`}>
            L{level + 1}
          </span>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm text-[#111827]">{displayCode}</span>
              <span
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                style={{ backgroundColor: `${wipStyle.color}20`, color: wipStyle.color }}
              >
                {wipStyle.label}
              </span>
              <span className="text-xs text-gray-500">x {wip.quantity} PCS</span>
            </div>
          </div>

          <div className="text-right flex-shrink-0">
            <div className="text-sm font-semibold text-[#111827]">{totalMin} min</div>
            <div className="text-xs text-gray-500">{(totalMin / 60).toFixed(1)} hrs</div>
          </div>
        </div>

        {expanded && wip.processes.length > 0 && (
          <div className="px-4 pb-2 flex flex-wrap gap-1.5">
            {wip.processes.map((p, i) => (
              <RoutingPill key={i} process={p} />
            ))}
          </div>
        )}

        {expanded && materials.length > 0 && (
          <div className={`px-4 pb-3 pt-1 border-t ${colors.divider}`}>
            <div className={`text-[10px] font-semibold uppercase mb-1 ${colors.title}`}>Raw Materials</div>
            <div className="flex flex-wrap gap-1.5">
              {materials.map((m, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 bg-white border border-[#C6DBA8] text-[#4F7C3A] rounded"
                >
                  {m.autoDetect ? (
                    <span className="text-[#3E6570]">{m.autoDetect === "FABRIC" ? "Fabric (from order)" : "Leg (from order)"}</span>
                  ) : (
                    <span>{m.name || m.code || "—"}</span>
                  )}
                  <span className="text-gray-400">× {m.qty} {m.unit}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Recursive sub-WIP children — unlimited nesting */}
      {expanded && children.length > 0 && (
        <div className="border-l-2 border-gray-200 ml-4">
          {children.map((child) => (
            <WIPNode key={child.id} wip={child} product={product} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- BOM Tree View ----------
// Renders one WIP component (and its children) as plain HTML for the
// printable PDF view. Mirrors the WIPNode component but produces static
// markup so it can live in a popup window.
function wipToPrintHtml(wip: WIPComponent, level: number, product: Product): string {
  const colors = ["#dbeafe", "#ede9fe", "#ffedd5", "#d1fae5", "#ffe4e6"];
  const bg = colors[(level - 1) % colors.length];
  const wipMin = wip.processes.reduce((s, p) => s + p.minutes, 0);
  const wipCodeText = buildWipCodeDisplay(wip.codeSegments, product) || wip.wipCode || "";
  const procs = wip.processes
    .map((p) => `<span class="pill">${p.dept} · ${p.category} · ${p.minutes}m</span>`)
    .join(" ");
  const mats = (wip.materials || [])
    .map((m) => {
      const label = m.autoDetect
        ? (m.autoDetect === "FABRIC" ? "Fabric (from order)" : "Leg (from order)")
        : (m.name || m.code || "—");
      return `<span class="mat">${label} × ${m.qty} ${m.unit}</span>`;
    })
    .join(" ");
  const children = (wip.children || []).map((c) => wipToPrintHtml(c, level + 1, product)).join("");
  return `
    <div class="wip" style="background:${bg};margin-left:${(level - 1) * 16}px;">
      <div class="wip-head">
        <span class="badge">L${level + 1}</span>
        <span class="wip-code">${wipCodeText}</span>
        <span class="wip-qty">× ${wip.quantity}</span>
        <span class="wip-min">${wipMin}m</span>
      </div>
      ${procs ? `<div class="row">${procs}</div>` : ""}
      ${mats ? `<div class="row mats">${mats}</div>` : ""}
      ${children}
    </div>
  `;
}

// Builds a self-contained HTML document for printing / save-as-PDF. The
// browser's print dialog handles the actual PDF conversion so we don't
// need any extra dependency.
function buildBOMPrintDoc(template: BOMTemplate, product: Product): string {
  const l1Min = template.l1Processes.reduce((s, p) => s + p.minutes, 0);
  const wipMin = template.wipComponents.reduce(
    (s, w) => s + w.processes.reduce((ws, p) => ws + p.minutes, 0) * w.quantity,
    0
  );
  const totalMin = l1Min + wipMin;
  const l1Procs = template.l1Processes
    .map((p) => `<span class="pill">${p.dept} · ${p.category} · ${p.minutes}m</span>`)
    .join(" ");
  const l1Mats = (template.l1Materials || [])
    .map((m) => {
      const label = m.autoDetect
        ? (m.autoDetect === "FABRIC" ? "Fabric (from order)" : "Leg (from order)")
        : (m.name || m.code || "—");
      return `<span class="mat">${label} × ${m.qty} ${m.unit}</span>`;
    })
    .join(" ");
  const wips = template.wipComponents.map((w) => wipToPrintHtml(w, 1, product)).join("");
  const today = new Date().toLocaleDateString("en-MY", { year: "numeric", month: "short", day: "numeric" });
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>BOM ${product.code} — Hookka</title>
  <style>
    @page { size: A4; margin: 16mm; }
    body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #111827; font-size: 11px; }
    .header { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #6B5C32; padding-bottom: 8px; margin-bottom: 16px; }
    .brand { font-size: 18px; font-weight: 700; color: #6B5C32; letter-spacing: 0.5px; }
    .brand small { display:block; font-size:9px; font-weight:500; color:#9CA3AF; letter-spacing:1px; text-transform:uppercase; }
    .meta { text-align: right; font-size: 10px; color: #6B7280; }
    h1 { font-size: 14px; margin: 12px 0 4px; }
    .sub { font-size: 11px; color: #6B7280; margin-bottom: 12px; }
    .stats { display: flex; gap: 8px; margin-bottom: 14px; }
    .stat { flex: 1; border: 1px solid #E2DDD8; border-radius: 6px; padding: 6px 8px; }
    .stat .lbl { font-size: 9px; color: #9CA3AF; text-transform: uppercase; }
    .stat .val { font-size: 13px; font-weight: 700; }
    .fg { background: #FEF3C7; border: 1px solid #FCD34D; border-radius: 6px; padding: 8px 10px; margin-bottom: 6px; }
    .fg-head { display: flex; justify-content: space-between; font-size: 12px; font-weight: 600; }
    .row { margin-top: 4px; line-height: 1.8; }
    .pill { display:inline-block; background:#fff; border:1px solid #E2DDD8; border-radius:99px; padding:1px 6px; font-size:9px; margin-right:3px; }
    .mat { display:inline-block; background:#fff; border:1px solid #BBF7D0; color:#15803D; border-radius:4px; padding:1px 6px; font-size:9px; margin-right:3px; }
    .wip { border:1px solid #E2DDD8; border-radius:6px; padding:6px 10px; margin-top:4px; }
    .wip-head { display:flex; align-items:center; gap:6px; font-size:11px; font-weight:600; }
    .badge { display:inline-block; padding:1px 5px; background:#fff; border:1px solid #C7D2FE; color:#3730A3; border-radius:99px; font-size:9px; font-weight:700; }
    .wip-code { flex:1; }
    .wip-qty { color:#6B7280; font-weight:500; }
    .wip-min { color:#111827; font-weight:600; }
    .footer { margin-top:24px; padding-top:8px; border-top:1px solid #E2DDD8; font-size:9px; color:#9CA3AF; text-align:center; }
    @media print { .no-print { display:none; } }
    .no-print { position: fixed; top: 8px; right: 8px; }
    .no-print button { background:#6B5C32; color:#fff; border:0; padding:8px 14px; border-radius:6px; cursor:pointer; font-size:12px; }
  </style>
</head>
<body>
  <div class="no-print"><button onclick="window.print()">Print / Save as PDF</button></div>
  <div class="header">
    <div class="brand">HOOKKA<small>Furniture Manufacturing</small></div>
    <div class="meta">
      <div><strong>Bill of Materials</strong></div>
      <div>Generated: ${today}</div>
    </div>
  </div>

  <h1>${product.code} — ${product.name}</h1>
  <div class="sub">Category: ${template.category} &nbsp;·&nbsp; Base Model: ${template.baseModel}</div>

  <div class="stats">
    <div class="stat"><div class="lbl">Total Time</div><div class="val">${(totalMin / 60).toFixed(1)} hrs</div></div>
    <div class="stat"><div class="lbl">L1 (FG)</div><div class="val">${l1Min} min</div></div>
    <div class="stat"><div class="lbl">WIP</div><div class="val">${wipMin} min</div></div>
    <div class="stat"><div class="lbl">WIP Components</div><div class="val">${template.wipComponents.length}</div></div>
  </div>

  <div class="fg">
    <div class="fg-head"><span>FG &nbsp; ${product.code}</span><span>${totalMin} min</span></div>
    ${l1Procs ? `<div class="row">${l1Procs}</div>` : ""}
    ${l1Mats ? `<div class="row mats">${l1Mats}</div>` : ""}
  </div>

  ${wips}

  <div class="footer">Hookka ERP · Confidential — for internal &amp; partner use only</div>
  <script>setTimeout(function(){ window.focus(); }, 100);</script>
</body>
</html>`;
}

function exportBOMToPDF(template: BOMTemplate, product: Product, w: Window) {
  const html = buildBOMPrintDoc(template, product);
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function BOMTreeView({ template, product, onEdit }: { template: BOMTemplate; product: Product; onEdit: () => void }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(true);
  const l1Min = template.l1Processes.reduce((s, p) => s + p.minutes, 0);
  const wipMin = template.wipComponents.reduce(
    (s, w) => s + w.processes.reduce((ws, p) => ws + p.minutes, 0) * w.quantity,
    0
  );
  const totalMin = l1Min + wipMin;

  // Department breakdown
  const deptMinutes: Record<string, number> = {};
  for (const p of template.l1Processes) {
    deptMinutes[p.deptCode] = (deptMinutes[p.deptCode] || 0) + p.minutes;
  }
  for (const w of template.wipComponents) {
    for (const p of w.processes) {
      deptMinutes[p.deptCode] = (deptMinutes[p.deptCode] || 0) + p.minutes * w.quantity;
    }
  }

  const routingSteps = DEPT_ORDER.filter((d) => deptMinutes[d]).map((code) => ({
    code,
    minutes: deptMinutes[code],
    color: DEPT_COLORS[code],
  }));

  return (
    <div className="space-y-4">
      {/* Header with Edit */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[#111827]">
          {product.code} — {product.name}
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              const w = window.open("", "_blank", "width=900,height=1100");
              if (!w) { toast.warning("Please allow popups to export the BOM as PDF."); return; }
              exportBOMToPDF(template, product, w);
            }}
            title="Open print-friendly view to save as PDF"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-[#E2DDD8] rounded-lg hover:bg-[#FAF9F7] text-[#6B5C32]"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Export PDF
          </button>
          <button
            onClick={onEdit}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-[#E2DDD8] rounded-lg hover:bg-[#FAF9F7] text-[#6B5C32]"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
            </svg>
            Edit BOM
          </button>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white rounded-lg border border-[#E2DDD8] px-4 py-3">
          <div className="text-xs text-gray-500">Total Time</div>
          <div className="text-lg font-bold text-[#111827]">{(totalMin / 60).toFixed(1)} hrs</div>
          <div className="text-xs text-gray-400">{totalMin} minutes</div>
        </div>
        <div className="bg-white rounded-lg border border-[#E2DDD8] px-4 py-3">
          <div className="text-xs text-gray-500">L1 (FG) Time</div>
          <div className="text-lg font-bold text-[#9C6F1E]">{l1Min} min</div>
          <div className="text-xs text-gray-400">{template.l1Processes.length} processes</div>
        </div>
        <div className="bg-white rounded-lg border border-[#E2DDD8] px-4 py-3">
          <div className="text-xs text-gray-500">WIP Time</div>
          <div className="text-lg font-bold text-[#3E6570]">{wipMin} min</div>
          <div className="text-xs text-gray-400">{template.wipComponents.length} components</div>
        </div>
        <div className="bg-white rounded-lg border border-[#E2DDD8] px-4 py-3">
          <div className="text-xs text-gray-500">Departments</div>
          <div className="text-lg font-bold text-[#111827]">{routingSteps.length}</div>
          <div className="text-xs text-gray-400">active depts</div>
        </div>
      </div>

      {/* BOM Tree */}
      <div className="bg-white rounded-lg border border-[#E2DDD8] p-4">
        <h2 className="text-sm font-semibold text-[#111827] mb-3">BOM Structure</h2>

        {/* FG root node */}
        <div className="bg-[#FAEFCB] border border-[#E8D597] rounded-lg overflow-hidden">
          <div
            className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
            onClick={() => setExpanded(!expanded)}
          >
            <svg
              className={`w-4 h-4 text-gray-500 transition-transform flex-shrink-0 ${expanded ? "rotate-90" : ""}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>

            <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-[#FAEFCB] text-[#9C6F1E]">
              FG
            </span>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm text-[#111827]">{product.code}</span>
                <span className="text-xs text-gray-600">{product.name}</span>
              </div>
              <div className="flex items-center gap-3 mt-0.5 text-xs text-gray-500">
                <span>Category: <strong className="text-gray-700">{template.category}</strong></span>
                <span>Base: <strong className="text-gray-700">{template.baseModel}</strong></span>
              </div>
            </div>

            <div className="text-right flex-shrink-0">
              <div className="text-sm font-semibold text-[#111827]">{totalMin} min</div>
              <div className="text-xs text-gray-500">{(totalMin / 60).toFixed(1)} hrs</div>
            </div>
          </div>

          {/* L1 routing pills */}
          {expanded && template.l1Processes.length > 0 && (
            <div className="px-4 pb-2 flex flex-wrap gap-1.5">
              {template.l1Processes.map((p, i) => (
                <RoutingPill key={i} process={p} />
              ))}
            </div>
          )}

          {/* L1 raw materials */}
          {expanded && (template.l1Materials || []).length > 0 && (
            <div className="px-4 pb-3 pt-1 border-t border-[#E8D597]/60">
              <div className="text-[10px] font-semibold uppercase text-[#9C6F1E] mb-1">L1 Raw Materials</div>
              <div className="flex flex-wrap gap-1.5">
                {(template.l1Materials || []).map((m, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 bg-white border border-[#C6DBA8] text-[#4F7C3A] rounded"
                  >
                    {m.autoDetect ? (
                      <span className="text-[#3E6570]">{m.autoDetect === "FABRIC" ? "Fabric (from order)" : "Leg (from order)"}</span>
                    ) : (
                      <span>{m.name || m.code || "—"}</span>
                    )}
                    <span className="text-gray-400">× {m.qty} {m.unit}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* WIP children */}
        {expanded && (
          <div className="border-l-2 border-gray-200 ml-4">
            {template.wipComponents.map((wip) => (
              <WIPNode key={wip.id} wip={wip} product={product} />
            ))}
          </div>
        )}
      </div>

      {/* Routing Flow */}
      <div className="bg-white rounded-lg border border-[#E2DDD8] p-4">
        <h2 className="text-sm font-semibold text-[#111827] mb-3">Department Routing Flow</h2>
        <div className="flex items-center gap-1 flex-wrap">
          {routingSteps.map((step, i) => (
            <div key={step.code} className="flex items-center gap-1">
              <div
                className="flex flex-col items-center px-3 py-2 rounded-lg border min-w-[80px]"
                style={{ backgroundColor: `${step.color}10`, borderColor: `${step.color}40` }}
              >
                <span className="text-[10px] font-medium" style={{ color: step.color }}>
                  {step.code.replace("_", " ")}
                </span>
                <span className="text-sm font-bold" style={{ color: step.color }}>
                  {step.minutes}m
                </span>
              </div>
              {i < routingSteps.length - 1 && (
                <svg className="w-4 h-4 text-gray-300 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                </svg>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Department Breakdown */}
      <div className="bg-white rounded-lg border border-[#E2DDD8] p-4">
        <h2 className="text-sm font-semibold text-[#111827] mb-3">Department Time Breakdown</h2>
        <div className="space-y-2">
          {routingSteps.map((step) => {
            const pct = totalMin > 0 ? (step.minutes / totalMin) * 100 : 0;
            return (
              <div key={step.code} className="flex items-center gap-3">
                <div className="w-24 flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: step.color }} />
                  <span className="text-xs text-gray-600 truncate">{DEPT_LABELS[step.code]}</span>
                </div>
                <div className="flex-1 h-5 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${pct}%`, backgroundColor: step.color }}
                  />
                </div>
                <div className="w-16 text-right text-xs font-medium text-gray-700">
                  {step.minutes} min
                </div>
                <div className="w-12 text-right text-xs text-gray-400">
                  {pct.toFixed(0)}%
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------- Sofa Module Parser ----------
// Derives structural counts from a sofa module sizeCode. Mirror of the
// server-side helper in mock-data.ts (deriveSofaModuleCounts) — kept as a
// local copy so this page has no mock-data import dependency.
//   NA  suffix  → No Arm (middle section piece), 0 arms
//   A   suffix  → Armed end-piece of a sectional, 1 arm
//   S   suffix  → Standalone complete sofa, 2 arms
//   L(LHF/RHF)  → L-shape chaise, 2 seats, 1 arm
//   CNR         → Corner piece, 1 seat, 0 arms
// Back cushion qty = seats (one back cushion per seat).
function deriveSofaModuleCounts(sizeCode: string): {
  seats: number;
  arms: number;
  armSide: "Left" | "Right";
} {
  const code = (sizeCode || "").trim().toUpperCase();
  const armSide: "Left" | "Right" = code.includes("LHF")
    ? "Left"
    : code.includes("RHF")
    ? "Right"
    : "Left";
  if (code === "CNR") return { seats: 1, arms: 0, armSide };
  if (/^L\(/.test(code)) return { seats: 2, arms: 1, armSide };
  const m = code.match(/^(\d+)(NA|A|S)/);
  if (m) {
    const seats = Number(m[1]);
    const kind = m[2];
    const arms = kind === "NA" ? 0 : kind === "S" ? 2 : 1;
    return { seats, arms, armSide };
  }
  return { seats: 1, arms: 0, armSide };
}

// ---------- Default BOM Generator ----------
// Applies the saved master template (or fallback) to a specific product,
// generating per-WIP code segments and bumping divan qty for large sizes.
// Used by CreateBOMDialog, the "Complete BOM" pending button, and the
// EditBOMDialog "Load Default" action.
// `masterOverride` lets the caller pick a specific master template from the
// Load Default picker (dropdown showing all user-defined masters: 1A(LHF),
// 2NA, CNR, 1S, etc). When omitted, falls back to the auto-resolver which
// picks by product.sizeCode match.
function generateDefaultBOMParts(
  product: Product,
  masterOverride?: MasterTemplate,
): {
  l1Processes: BOMProcess[];
  l1Materials: WIPMaterial[];
  wipComponents: WIPComponent[];
} {
  const cat = (product.category === "SOFA" ? "SOFA" : "BEDFRAME") as "BEDFRAME" | "SOFA";
  const isBedframe = cat === "BEDFRAME";
  // Use the explicit override when the user picked one from the Load Default
  // menu; otherwise fall back to the product-aware resolver (SOFA-1A(LHF)
  // style auto-match on sizeCode).
  const master = masterOverride || getEffectiveMasterTemplateForProduct(product);

  // Load Default copies the master template verbatim — all variant segments
  // stay as autoDetect placeholders so Load Default output is identical to
  // the master. Variants (PRODUCT_CODE, SIZE, DIVAN_HEIGHT, FABRIC...) are
  // all resolved from the SO line at production time.
  const resolveSegs = (masterSegs: CodeSegment[] | undefined, wipType: string): CodeSegment[] => {
    if (!masterSegs || masterSegs.length === 0) {
      const segs: CodeSegment[] = [];
      segs.push({ type: "variant", variantCategory: "PRODUCT_CODE", value: "", autoDetect: true });
      segs.push({ type: "word", value: WIP_TYPE_LABELS[wipType]?.label || wipType });
      segs.push({ type: "variant", variantCategory: "SIZE", value: "", autoDetect: true });
      if (isBedframe) {
        segs.push({ type: "variant", variantCategory: "DIVAN_HEIGHT", value: "", autoDetect: true });
        segs.push({ type: "variant", variantCategory: "LEG_HEIGHT", value: "", autoDetect: true });
      }
      return segs;
    }
    // Pass through verbatim — same segments as master.
    return masterSegs.map((s) => ({ ...s }));
  };

  const now = Date.now();
  let counter = 0;

  // Derive sofa module counts (seats → cushion qty, NA/A/S → arm count)
  // once per generation so nested walks share the same derivation.
  const sofaCounts = !isBedframe
    ? deriveSofaModuleCounts(product.sizeCode || "")
    : null;

  const walk = (item: WIPComponent): WIPComponent => {
    const segs = resolveSegs(item.codeSegments, item.wipType);
    let qty = item.quantity;

    // Bedframe divan qty by bed size — bi-directional clamp so S/SS always
    // get 1pc divan and K/Q/SK/SP always get 2pc, regardless of what the
    // master template stored.
    if (item.wipType === "DIVAN") {
      if (["K", "Q", "SK", "SP"].includes(product.sizeCode)) {
        qty = 2;
      } else if (["S", "SS"].includes(product.sizeCode)) {
        qty = 1;
      }
    }

    // Sofa cushion/armrest qty derived from the module's sizeCode.
    // Back cushion qty = seat count. Armrest qty handled at template
    // construction (NA → 0, LHF/RHF → 1, S → 2) so we just defer to the
    // stored quantity here — the walk never multiplies armrest counts.
    if (sofaCounts && item.wipType === "SOFA_CUSHION") {
      qty = sofaCounts.seats;
    }
    counter += 1;
    return {
      id: `def-${item.wipType.toLowerCase()}-${now + counter}`,
      wipCode: buildWipCode(segs),
      codeSegments: segs,
      wipType: item.wipType,
      quantity: qty,
      processes: item.processes.map((p) => ({ ...p })),
      materials: (item.materials || []).map((m) => ({ ...m })),
      children: (item.children || []).map(walk),
    };
  };
  const wipComponents: WIPComponent[] = master.wipItems.map(walk);

  return {
    l1Processes: master.l1Processes.map((p) => ({ ...p })),
    l1Materials: master.l1Materials.map((m) => ({ ...m })),
    wipComponents,
  };
}

// ---------- Create BOM Dialog ----------
// Intentionally unused — kept as a reference implementation. The live UI uses
// `EditBOMDialog` instead (the "Create new" flow is invoked via an empty
// template in the edit dialog). Do NOT remove without archiving the create
// logic elsewhere first.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function CreateBOMDialog({
  open,
  onClose,
  products,
  existingCodes,
  onCreated,
  rawMaterials,
  fabricOptions,
}: {
  open: boolean;
  onClose: () => void;
  products: Product[];
  existingCodes: Set<string>;
  onCreated: (t: BOMTemplate) => void;
  rawMaterials: RawMaterialOption[];
  fabricOptions: string[];
}) {
  const [selectedCode, setSelectedCode] = useState("");
  const [prodSearch, setProdSearch] = useState("");
  const [l1Processes, setL1Processes] = useState<BOMProcess[]>([
    { dept: "Fab Cut", deptCode: "FAB_CUT", category: "CAT 3", minutes: 30 },
  ]);
  const [l1Materials, setL1Materials] = useState<WIPMaterial[]>([]);
  const [wipComponents, setWipComponents] = useState<WIPComponent[]>([]);
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const availableProducts = useMemo(() => {
    return products.filter((p) => !existingCodes.has(p.code));
  }, [products, existingCodes]);

  const filteredAvailable = useMemo(() => {
    if (!prodSearch.trim()) return availableProducts;
    const q = prodSearch.toLowerCase();
    return availableProducts.filter(
      (p) => p.code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
    );
  }, [availableProducts, prodSearch]);

  const productVariantCategories: VariantCategoryInfo[] = useMemo(() => {
    const sel = products.find((p) => p.code === selectedCode);
    if (!sel) return [{ category: "SIZE", label: "Size" }, { category: "FABRIC", label: "Fabric" }];
    const cat = (sel as Product & { category?: string }).category;
    if (cat === "BEDFRAME") return [
      { category: "PRODUCT_CODE", label: "Product Code" }, { category: "SIZE", label: "Size" },
      { category: "DIVAN_HEIGHT", label: "Divan Height" }, { category: "LEG_HEIGHT", label: "Leg Height" },
      { category: "TOTAL_HEIGHT", label: "Total Height" },
      { category: "FABRIC", label: "Fabric" }, { category: "SPECIAL", label: "Special" },
    ];
    if (cat === "SOFA") return [
      { category: "PRODUCT_CODE", label: "Product Code" },
      { category: "MODEL", label: "Model" },
      { category: "SEAT_SIZE", label: "Seat Size" },
      { category: "MODULE", label: "Module" }, { category: "FABRIC", label: "Fabric" },
      { category: "SPECIAL", label: "Special" },
    ];
    return [{ category: "PRODUCT_CODE", label: "Product Code" }, { category: "SIZE", label: "Size" }, { category: "FABRIC", label: "Fabric" }];
  }, [products, selectedCode]);

  const selected = products.find((p) => p.code === selectedCode);

  // Auto-generate default BOM when product is selected
  useEffect(() => {
    if (!selected) return;
    const parts = generateDefaultBOMParts(selected);
    setL1Processes(parts.l1Processes);
    setL1Materials(parts.l1Materials);
    setWipComponents(parts.wipComponents);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCode]);

  function addL1Process() {
    setL1Processes((prev) => [
      ...prev,
      { dept: "Fab Sew", deptCode: "FAB_SEW", category: "CAT 3", minutes: 30 },
    ]);
  }

  function removeL1Process(i: number) {
    setL1Processes((prev) => prev.filter((_, idx) => idx !== i));
  }

  function updateL1Process(i: number, field: string, value: string | number) {
    setL1Processes((prev) =>
      prev.map((p, idx) => {
        if (idx !== i) return p;
        if (field === "deptCode") {
          const code = value as string;
          const minutes = getProductionMinutes(code, p.category) || p.minutes;
          return { ...p, deptCode: code, dept: DEPT_LABELS[code] || code, minutes };
        }
        if (field === "category") {
          const minutes = getProductionMinutes(p.deptCode, value as string);
          return { ...p, category: value as string, minutes };
        }
        return { ...p, [field]: value };
      })
    );
  }

  function addWIPComponent() {
    const wipType = selected?.category === "SOFA" ? "SOFA_BASE" : "DIVAN";
    const isBedframe = selected?.category === "BEDFRAME";
    // Auto-populate code segments from product data
    const autoSegments: CodeSegment[] = [];
    if (selected) {
      // Add product code segment
      if (selected.baseModel) {
        autoSegments.push({ type: "variant", variantCategory: "PRODUCT_CODE", value: selected.baseModel });
      }
      // Add WIP type as text
      autoSegments.push({ type: "word", value: WIP_TYPE_LABELS[wipType]?.label || wipType });
      // Add size from product (auto-detect from order)
      autoSegments.push({ type: "variant", variantCategory: "SIZE", value: selected.sizeLabel || "", autoDetect: true });
      // For bedframes, add divan height and leg height as auto-detect from order
      if (isBedframe) {
        autoSegments.push({ type: "variant", variantCategory: "DIVAN_HEIGHT", value: "", autoDetect: true });
        autoSegments.push({ type: "variant", variantCategory: "LEG_HEIGHT", value: "", autoDetect: true });
      }
    }
    if (autoSegments.length === 0) {
      autoSegments.push({ type: "word", value: "" });
    }
    setWipComponents((prev) => [
      ...prev,
      {
        id: `new-wip-${Date.now()}`,
        wipCode: buildWipCode(autoSegments),
        codeSegments: autoSegments,
        wipType: wipType as WIPComponent["wipType"],
        quantity: 1,
        processes: [
          { dept: "Wood Cut", deptCode: "WOOD_CUT", category: "CAT 1", minutes: 20 },
          { dept: "Framing", deptCode: "FRAMING", category: "CAT 4", minutes: 20 },
        ],
        materials: (() => {
          const mats: WIPMaterial[] = [];
          mats.push({ code: "", name: "Fabric (from order)", qty: 1, unit: "MTR", autoDetect: "FABRIC" });
          if (isBedframe) mats.push({ code: "", name: "Leg (from order)", qty: 1, unit: "PCS", autoDetect: "LEG" });
          return mats;
        })(),
        children: [],
      },
    ]);
  }

  function removeWIP(i: number) {
    setWipComponents((prev) => prev.filter((_, idx) => idx !== i));
  }

  function updateWIP(i: number, field: string, value: string | number) {
    setWipComponents((prev) =>
      prev.map((w, idx) => (idx === i ? { ...w, [field]: value } : w))
    );
  }

  function addWIPProcess(wi: number) {
    setWipComponents((prev) =>
      prev.map((w, idx) =>
        idx === wi
          ? {
              ...w,
              processes: [
                ...w.processes,
                { dept: "Packing", deptCode: "PACKING", category: "CAT 3", minutes: 20 },
              ],
            }
          : w
      )
    );
  }

  function removeWIPProcess(wi: number, pi: number) {
    setWipComponents((prev) =>
      prev.map((w, idx) =>
        idx === wi ? { ...w, processes: w.processes.filter((_, pidx) => pidx !== pi) } : w
      )
    );
  }

  function updateWIPProcess(wi: number, pi: number, field: string, value: string | number) {
    setWipComponents((prev) =>
      prev.map((w, idx) =>
        idx === wi
          ? {
              ...w,
              processes: w.processes.map((p, pidx) => {
                if (pidx !== pi) return p;
                if (field === "deptCode") {
                  const code = value as string;
                  const minutes = getProductionMinutes(code, p.category) || p.minutes;
                  return { ...p, deptCode: code, dept: DEPT_LABELS[code] || code, minutes };
                }
                if (field === "category") {
                  const minutes = getProductionMinutes(p.deptCode, value as string);
                  return { ...p, category: value as string, minutes };
                }
                return { ...p, [field]: value };
              }),
            }
          : w
      )
    );
  }

  function updateWIPSegments(wi: number, segs: CodeSegment[]) {
    setWipComponents((prev) =>
      prev.map((w, idx) =>
        idx === wi ? { ...w, codeSegments: segs, wipCode: buildWipCode(segs) } : w
      )
    );
  }
  function addWIPMaterial(wi: number) {
    setWipComponents((prev) =>
      prev.map((w, idx) =>
        idx === wi
          ? { ...w, materials: [...(w.materials || []), { code: "", name: "", qty: 1, unit: "PCS" }] }
          : w
      )
    );
  }
  function removeWIPMaterial(wi: number, mi: number) {
    setWipComponents((prev) =>
      prev.map((w, idx) =>
        idx === wi ? { ...w, materials: (w.materials || []).filter((_, midx) => midx !== mi) } : w
      )
    );
  }
  function updateWIPMaterial(wi: number, mi: number, field: string, value: string | number) {
    setWipComponents((prev) =>
      prev.map((w, idx) =>
        idx === wi
          ? { ...w, materials: (w.materials || []).map((m, midx) => midx === mi ? { ...m, [field]: value } : m) }
          : w
      )
    );
  }
  function selectMaterial(wi: number, mi: number, rm: RawMaterialOption) {
    setWipComponents((prev) =>
      prev.map((w, idx) =>
        idx === wi
          ? { ...w, materials: (w.materials || []).map((m, midx) => midx === mi ? { ...m, code: rm.itemCode, name: rm.description, unit: rm.baseUOM, inventoryCode: rm.itemCode } : m) }
          : w
      )
    );
  }

  function handleCreate() {
    if (!selected) return;
    const newTemplate: BOMTemplate = {
      id: `bom-new-${Date.now()}`,
      productCode: selected.code,
      baseModel: selected.baseModel,
      category: selected.category as "BEDFRAME" | "SOFA",
      l1Processes,
      l1Materials,
      wipComponents: wipComponents.map((w, i) => ({
        ...w,
        id: `wip-new-${Date.now()}-${i}`,
        wipCode: w.wipCode || `${selected.code}-WIP-${i + 1}`,
      })),
    };
    onCreated(newTemplate);
    // Reset
    setSelectedCode("");
    setProdSearch("");
    setL1Processes([{ dept: "Fab Cut", deptCode: "FAB_CUT", category: "CAT 3", minutes: 30 }]);
    setL1Materials([]);
    setWipComponents([]);
    setStep(1);
    onClose();
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-xl w-[720px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
          <div>
            <h2 className="text-lg font-bold text-[#111827]">Create BOM Template</h2>
            <p className="text-xs text-gray-500 mt-0.5">Step {step} of 3</p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Step indicator */}
        <div className="px-6 py-3 border-b border-[#E2DDD8] flex gap-2">
          {[1, 2, 3].map((s) => (
            <div key={s} className={`flex-1 h-1 rounded-full ${step >= s ? "bg-[#6B5C32]" : "bg-gray-200"}`} />
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {step === 1 && (
            <>
              <label className="text-sm font-medium text-[#111827]">Select Product</label>
              <input
                type="text"
                placeholder="Search products without BOM..."
                value={prodSearch}
                onChange={(e) => setProdSearch(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-[#E2DDD8] rounded-md bg-[#FAF9F7] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40"
              />
              <div className="max-h-[300px] overflow-y-auto border border-[#E2DDD8] rounded-md divide-y divide-[#E2DDD8]">
                {filteredAvailable.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-gray-400">
                    {availableProducts.length === 0 ? "All products already have BOM templates" : "No matching products"}
                  </div>
                ) : (
                  filteredAvailable.slice(0, 50).map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setSelectedCode(p.code)}
                      className={`w-full text-left px-3 py-2 transition-colors ${
                        selectedCode === p.code ? "bg-[#6B5C32]/10" : "hover:bg-[#FAF9F7]"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="text-sm font-medium text-[#111827]">{p.code}</span>
                          <span className="text-xs text-gray-500 ml-2">{p.name}</span>
                        </div>
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                          p.category === "BEDFRAME" ? "bg-[#FAEFCB] text-[#9C6F1E]" : "bg-[#E0EDF0] text-[#3E6570]"
                        }`}>
                          {p.category}
                        </span>
                      </div>
                    </button>
                  ))
                )}
              </div>
              {filteredAvailable.length > 50 && (
                <p className="text-xs text-gray-400">Showing first 50 of {filteredAvailable.length} products</p>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-[#111827]">
                  L1 Processes (Finished Good)
                </label>
                <button
                  onClick={addL1Process}
                  className="text-xs px-2 py-1 bg-[#6B5C32] text-white rounded hover:bg-[#5A4D2A]"
                >
                  + Add Process
                </button>
              </div>
              <div className="space-y-2">
                {l1Processes.map((p, i) => (
                  <div key={i} className="flex items-center gap-2 bg-[#FAF9F7] rounded-md px-3 py-2">
                    <select
                      value={p.deptCode}
                      onChange={(e) => updateL1Process(i, "deptCode", e.target.value)}
                      className="text-sm border border-[#E2DDD8] rounded px-2 py-1 bg-white"
                    >
                      {DEPT_ORDER.map((d) => (
                        <option key={d} value={d}>{DEPT_LABELS[d]}</option>
                      ))}
                    </select>
                    <select
                      value={p.category}
                      onChange={(e) => updateL1Process(i, "category", e.target.value)}
                      className="text-sm border border-[#E2DDD8] rounded px-2 py-1 w-20 bg-white"
                    >
                      <option value="">CAT</option>
                      {getCategoryOptions().map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                    <span className="text-sm text-gray-700 bg-[#FAF9F7] border border-[#E2DDD8] rounded px-2 py-1 w-20 text-center tabular-nums">{p.minutes}</span>
                    <span className="text-xs text-gray-400">min</span>
                    <button onClick={() => removeL1Process(i)} className="ml-auto p-1 hover:bg-[#F9E1DA] rounded text-[#9A3A2D]">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-[#111827]">
                  WIP Components
                </label>
                <button
                  onClick={addWIPComponent}
                  className="text-xs px-2 py-1 bg-[#6B5C32] text-white rounded hover:bg-[#5A4D2A]"
                >
                  + Add WIP
                </button>
              </div>

              {wipComponents.length === 0 && (
                <div className="text-center py-8 text-sm text-gray-400 bg-[#FAF9F7] rounded-lg border border-dashed border-[#E2DDD8]">
                  No WIP components yet. Click &ldquo;+ Add WIP&rdquo; to add one.
                </div>
              )}

              <div className="space-y-4">
                {wipComponents.map((w, wi) => (
                  <div key={w.id} className="border border-[#A8CAD2] rounded-lg bg-[#E0EDF0] p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <select
                        value={w.wipType}
                        onChange={(e) => updateWIP(wi, "wipType", e.target.value)}
                        className="text-sm border border-[#A8CAD2] rounded px-2 py-1 bg-white"
                      >
                        {Object.entries(WIP_TYPE_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>{v.label}</option>
                        ))}
                      </select>
                      <input
                        type="number"
                        value={w.quantity}
                        onChange={(e) => updateWIP(wi, "quantity", parseInt(e.target.value) || 1)}
                        className="text-sm border border-[#A8CAD2] rounded px-2 py-1 w-16 bg-white"
                        min={1}
                      />
                      <span className="text-xs text-gray-500">PCS</span>
                      <button onClick={() => removeWIP(wi)} className="ml-auto p-1 hover:bg-[#F9E1DA] rounded text-[#9A3A2D]">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>

                    {/* WIP Code Builder */}
                    <div className="bg-white rounded-md px-2 py-1.5 border border-[#A8CAD2]">
                      <div className="text-[10px] font-medium text-[#3E6570] mb-1">WIP Code (Word + Variant combination)</div>
                      <WIPCodeBuilder
                        segments={w.codeSegments || [{ type: "word" as const, value: "" }]}
                        onChange={(segs) => updateWIPSegments(wi, segs)}
                        fabricOptions={fabricOptions}
                        variantCategories={productVariantCategories}
                      />
                    </div>

                    {/* Processes */}
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-[#3E6570]">Processes</span>
                      <button
                        onClick={() => addWIPProcess(wi)}
                        className="text-[10px] px-1.5 py-0.5 bg-[#E0EDF0] text-[#3E6570] rounded hover:bg-[#A8CAD2]"
                      >
                        + Process
                      </button>
                    </div>
                    {w.processes.map((p, pi) => (
                      <div key={pi} className="flex items-center gap-2 bg-white rounded px-2 py-1.5">
                        <select
                          value={p.deptCode}
                          onChange={(e) => updateWIPProcess(wi, pi, "deptCode", e.target.value)}
                          className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white"
                        >
                          {DEPT_ORDER.map((d) => (
                            <option key={d} value={d}>{DEPT_LABELS[d]}</option>
                          ))}
                        </select>
                        <select
                          value={p.category}
                          onChange={(e) => updateWIPProcess(wi, pi, "category", e.target.value)}
                          className="text-xs border border-gray-200 rounded px-1.5 py-1 w-16 bg-white"
                        >
                          <option value="">CAT</option>
                          {getCategoryOptions().map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                        <span className="text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded px-1.5 py-1 w-14 text-center tabular-nums">{p.minutes}</span>
                        <span className="text-[10px] text-gray-400">min</span>
                        <button onClick={() => removeWIPProcess(wi, pi)} className="ml-auto text-[#9A3A2D] hover:text-[#7A2E24]">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}

                    {/* Raw Materials */}
                    <div className="flex items-center justify-between mt-2">
                      <span className="text-xs font-medium text-[#4F7C3A]">Raw Materials</span>
                      <button onClick={() => addWIPMaterial(wi)} className="text-[10px] px-1.5 py-0.5 bg-[#EEF3E4] text-[#4F7C3A] rounded hover:bg-[#C6DBA8]">+ Material</button>
                    </div>
                    {(w.materials || []).map((m, mi) => (
                      <div key={mi} className="flex items-center gap-2 bg-white rounded px-2 py-1.5">
                        {m.autoDetect ? (
                          <div className="flex items-center gap-1.5 flex-1">
                            <span className="text-[10px] px-1.5 py-0.5 bg-[#E0EDF0] text-[#3E6570] rounded font-medium border border-[#A8CAD2] whitespace-nowrap">
                              {m.autoDetect === "FABRIC" ? "Fabric from order" : "Leg from order"}
                            </span>
                            <span className="text-[10px] text-gray-400 italic">
                              {m.autoDetect === "FABRIC" ? "SO item fabricCode" : "SO item legHeightInches"}
                            </span>
                          </div>
                        ) : (
                          <RawMaterialSelect
                            value={m.code ? `${m.code}` : ""}
                            materials={rawMaterials}
                            onSelect={(rm) => selectMaterial(wi, mi, rm)}
                          />
                        )}
                        <input type="number" value={m.qty} onChange={(e) => updateWIPMaterial(wi, mi, "qty", parseFloat(e.target.value) || 0)} className="text-xs border border-gray-200 rounded px-1.5 py-1 w-14" />
                        <span className="text-[10px] text-gray-400 w-8">{m.unit || "PCS"}</span>
                        <button onClick={() => removeWIPMaterial(wi, mi)} className="text-[#9A3A2D] hover:text-[#7A2E24]">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                    ))}
                    {(w.materials || []).length === 0 && (
                      <p className="text-[10px] text-gray-400 pl-2">No materials added</p>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[#E2DDD8] flex items-center justify-between">
          <div>
            {step > 1 && (
              <button
                onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)}
                className="px-4 py-2 text-sm border border-[#E2DDD8] rounded-lg text-gray-600 hover:bg-gray-50"
              >
                Back
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm border border-[#E2DDD8] rounded-lg text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
            {step < 3 ? (
              <button
                onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3)}
                disabled={step === 1 && !selectedCode}
                className="px-4 py-2 text-sm bg-[#6B5C32] text-white rounded-lg hover:bg-[#5A4D2A] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            ) : (
              <button
                onClick={handleCreate}
                className="px-4 py-2 text-sm bg-[#6B5C32] text-white rounded-lg hover:bg-[#5A4D2A]"
              >
                Create BOM
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Collapsible Group ----------
function CollapsibleGroup({
  baseModel, prods, existingCodes, selectedProductCode, onSelect,
}: {
  baseModel: string;
  prods: Product[];
  existingCodes: Set<string>;
  selectedProductCode: string;
  onSelect: (code: string) => void;
}) {
  // Auto-expand if a product in this group is selected
  const hasSelected = prods.some((p) => p.code === selectedProductCode);
  const [expanded, setExpanded] = useState(hasSelected);

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 bg-[#FAF9F7] border-b border-[#E2DDD8] sticky top-0 z-10 hover:bg-[#E2DDD8]/50 transition-colors"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <svg
              className={`w-3 h-3 text-gray-400 transition-transform flex-shrink-0 ${expanded ? "rotate-90" : ""}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            <span className="text-xs font-semibold text-[#6B5C32]">{baseModel}</span>
            <span className="text-[10px] text-gray-400">({prods.length})</span>
          </div>
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
            prods[0].category === "BEDFRAME"
              ? "bg-[#FAEFCB] text-[#9C6F1E]"
              : "bg-[#E0EDF0] text-[#3E6570]"
          }`}>
            {prods[0].category}
          </span>
        </div>
      </button>
      {expanded && prods.map((p) => {
        const hasBOM = existingCodes.has(p.code);
        return (
          <button
            key={p.id}
            onClick={() => onSelect(p.code)}
            className={`w-full text-left px-3 pl-7 py-2 border-b border-[#E2DDD8]/50 transition-colors ${
              selectedProductCode === p.code
                ? "bg-[#6B5C32]/10 border-l-2 border-l-[#6B5C32]"
                : "hover:bg-[#FAF9F7]"
            }`}
          >
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-[#111827] truncate">{p.code}</span>
              {!hasBOM && (
                <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-[#FAEFCB] text-[#9C6F1E] flex-shrink-0">
                  PENDING
                </span>
              )}
            </div>
            <div className="text-xs text-gray-500 truncate">{p.name}</div>
          </button>
        );
      })}
    </div>
  );
}

// ---------- Recursive Sub-WIP Tree ----------
function SubWIPTree({
  children,
  wi,
  path,
  onAdd,
  onRemove,
  onUpdate,
  onUpdateSegments,
  onAddProcess,
  onRemoveProcess,
  onUpdateProcess,
  onAddMaterial,
  onRemoveMaterial,
  onSelectMaterial,
  onUpdateMaterial,
  fabricOptions,
  variantCategories,
  rawMaterials,
  depth = 0,
}: {
  children: WIPComponent[];
  wi: number;
  path: number[];
  onAdd: (path: number[]) => void;
  onRemove: (path: number[], si: number) => void;
  onUpdate: (path: number[], field: string, value: string | number) => void;
  onUpdateSegments: (path: number[], segs: CodeSegment[]) => void;
  onAddProcess: (path: number[]) => void;
  onRemoveProcess: (path: number[], pi: number) => void;
  onUpdateProcess: (path: number[], pi: number, field: string, value: string | number) => void;
  onAddMaterial: (path: number[]) => void;
  onRemoveMaterial: (path: number[], mi: number) => void;
  onSelectMaterial: (path: number[], mi: number, rm: RawMaterialOption) => void;
  onUpdateMaterial: (path: number[], mi: number, field: string, value: string | number) => void;
  fabricOptions: string[];
  variantCategories: VariantCategoryInfo[];
  rawMaterials: RawMaterialOption[];
  depth?: number;
}) {
  const colors = [
    { border: "border-[#D1B7D0]", bg: "bg-[#F1E6F0]", label: "text-[#6B4A6D]", btn: "bg-[#D1B7D0] text-[#6B4A6D] hover:bg-[#D1B7D0]" },
    { border: "border-[#E8B786]", bg: "bg-[#FBE4CE]", label: "text-[#B8601A]", btn: "bg-[#E8B786] text-[#B8601A] hover:bg-[#E8B786]" },
    { border: "border-emerald-300", bg: "bg-emerald-100", label: "text-emerald-800", btn: "bg-emerald-300 text-emerald-900 hover:bg-emerald-400" },
    { border: "border-[#E8B2A1]", bg: "bg-[#F9E1DA]", label: "text-[#9A3A2D]", btn: "bg-[#E8B2A1] text-[#9A3A2D] hover:bg-[#E8B2A1]" },
  ];
  const c = colors[depth % colors.length];

  return (
    <>
      <div className="flex items-center justify-between mt-2">
        <span className={`text-xs font-medium ${c.label}`}>
          {depth === 0 ? "Sub-WIP Components" : `Sub-WIP (Level ${depth + 1})`}
        </span>
        <button onClick={() => onAdd(path)} className={`text-[10px] px-1.5 py-0.5 rounded ${c.btn}`}>+ Sub-WIP</button>
      </div>
      {children.map((sub, si) => {
        const childPath = [...path, si];
        return (
          <div key={sub.id} className={`ml-3 ${c.border} border rounded-lg ${c.bg} p-2 space-y-1.5`}>
            <div className="flex items-center gap-2">
              <select value={sub.wipType} onChange={(e) => onUpdate(childPath, "wipType", e.target.value)} className={`text-xs ${c.border} border rounded px-1.5 py-1 bg-white`}>
                {Object.entries(WIP_TYPE_LABELS).map(([k, v]) => (<option key={k} value={k}>{v.label}</option>))}
              </select>
              <input type="number" value={sub.quantity} onChange={(e) => onUpdate(childPath, "quantity", parseInt(e.target.value) || 1)} className={`text-xs ${c.border} border rounded px-1.5 py-1 w-12 bg-white`} min={1} />
              <span className="text-[10px] text-gray-500">PCS</span>
              <button onClick={() => onRemove(path, si)} className="text-[#9A3A2D] hover:text-[#7A2E24]">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="ml-1">
              <WIPCodeBuilder
                segments={sub.codeSegments || (sub.wipCode ? [{ type: "word" as const, value: sub.wipCode }] : [{ type: "word" as const, value: "" }])}
                onChange={(segs) => onUpdateSegments(childPath, segs)}
                fabricOptions={fabricOptions}
                variantCategories={variantCategories}
              />
            </div>

            {/* Processes */}
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[#3E6570]">Processes</span>
              <button onClick={() => onAddProcess(childPath)} className="text-[10px] px-1.5 py-0.5 bg-[#E0EDF0] text-[#3E6570] rounded hover:bg-[#A8CAD2]">+ Process</button>
            </div>
            {sub.processes.map((p, pi) => (
              <div key={pi} className="flex items-center gap-2 bg-white rounded px-2 py-1.5">
                <select value={p.deptCode} onChange={(e) => onUpdateProcess(childPath, pi, "deptCode", e.target.value)} className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white">
                  {DEPT_ORDER.map((d) => (<option key={d} value={d}>{DEPT_LABELS[d]}</option>))}
                </select>
                <select value={p.category} onChange={(e) => onUpdateProcess(childPath, pi, "category", e.target.value)} className="text-xs border border-gray-200 rounded px-1.5 py-1 w-16 bg-white">
                  <option value="">CAT</option>
                  {getCategoryOptions().map((c) => (<option key={c} value={c}>{c}</option>))}
                </select>
                <span className="text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded px-1.5 py-1 w-14 text-center tabular-nums">{p.minutes}</span>
                <span className="text-[10px] text-gray-400">min</span>
                <button onClick={() => onRemoveProcess(childPath, pi)} className="ml-auto text-[#9A3A2D] hover:text-[#7A2E24]">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            ))}

            {/* Raw Materials */}
            <div className="flex items-center justify-between mt-1">
              <span className="text-xs font-medium text-[#4F7C3A]">Raw Materials</span>
              <button onClick={() => onAddMaterial(childPath)} className="text-[10px] px-1.5 py-0.5 bg-[#EEF3E4] text-[#4F7C3A] rounded hover:bg-[#C6DBA8]">+ Material</button>
            </div>
            {(sub.materials || []).map((m, mi) => (
              <div key={mi} className="flex items-center gap-2 bg-white rounded px-2 py-1.5">
                {m.autoDetect ? (
                  <div className="flex items-center gap-1.5 flex-1">
                    <span className="text-[10px] px-1.5 py-0.5 bg-[#E0EDF0] text-[#3E6570] rounded font-medium border border-[#A8CAD2] whitespace-nowrap">
                      {m.autoDetect === "FABRIC" ? "Fabric from order" : "Leg from order"}
                    </span>
                    <span className="text-[10px] text-gray-400 italic">
                      {m.autoDetect === "FABRIC" ? "SO item fabricCode" : "SO item legHeightInches"}
                    </span>
                  </div>
                ) : (
                  <RawMaterialSelect
                    value={m.code ? `${m.code}` : ""}
                    materials={rawMaterials}
                    onSelect={(rm) => onSelectMaterial(childPath, mi, rm)}
                  />
                )}
                <input type="number" value={m.qty} onChange={(e) => onUpdateMaterial(childPath, mi, "qty", parseFloat(e.target.value) || 0)} className="text-xs border border-gray-200 rounded px-1.5 py-1 w-14" />
                <span className="text-[10px] text-gray-400 w-8">{m.unit || "PCS"}</span>
                <button onClick={() => onRemoveMaterial(childPath, mi)} className="text-[#9A3A2D] hover:text-[#7A2E24]">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            ))}
            {(sub.materials || []).length === 0 && (
              <p className="text-[10px] text-gray-400 pl-2">No materials added</p>
            )}

            {/* Recursive children */}
            <SubWIPTree
              children={sub.children || []}
              wi={wi}
              path={childPath}
              onAdd={onAdd}
              onRemove={onRemove}
              onUpdate={onUpdate}
              onUpdateSegments={onUpdateSegments}
              onAddProcess={onAddProcess}
              onRemoveProcess={onRemoveProcess}
              onUpdateProcess={onUpdateProcess}
              onAddMaterial={onAddMaterial}
              onRemoveMaterial={onRemoveMaterial}
              onSelectMaterial={onSelectMaterial}
              onUpdateMaterial={onUpdateMaterial}
              fabricOptions={fabricOptions}
              variantCategories={variantCategories}
              rawMaterials={rawMaterials}
              depth={depth + 1}
            />
          </div>
        );
      })}
      {children.length === 0 && (
        <p className="text-[10px] text-gray-400 pl-2">
          {depth === 0 ? "No sub-WIP components" : "No nested sub-WIP"}
        </p>
      )}
    </>
  );
}

// ---------- Edit BOM Dialog ----------
function EditBOMDialog({
  open,
  onClose,
  template,
  product,
  onSaved,
  rawMaterials,
  fabricOptions,
  productVariantCategories,
  allTemplates,
}: {
  open: boolean;
  onClose: () => void;
  template: BOMTemplate;
  product: Product;
  onSaved: (t: BOMTemplate) => void;
  rawMaterials: RawMaterialOption[];
  fabricOptions: string[];
  productVariantCategories: VariantCategoryInfo[];
  allTemplates: BOMTemplate[];
}) {
  const [l1Processes, setL1Processes] = useState<BOMProcess[]>([]);
  const [l1Materials, setL1Materials] = useState<WIPMaterial[]>([]);
  const [wipComponents, setWipComponents] = useState<WIPComponent[]>([]);
  const [tab, setTab] = useState<"l1" | "wip">("l1");
  const [showCopyFrom, setShowCopyFrom] = useState(false);
  const [showLoadDefault, setShowLoadDefault] = useState(false);

  // Master templates (1NA / 2A(LHF) / CNR / 1S / …) loaded from localStorage.
  // Refreshed every time the dialog opens so edits made in the Master
  // Templates dialog show up immediately in the Load Default picker.
  const [masterTemplates, setMasterTemplates] = useState<MasterTemplate[]>([]);
  useEffect(() => {
    if (!open) return;
    const cat = (product.category === "SOFA" ? "SOFA" : "BEDFRAME") as
      | "BEDFRAME"
      | "SOFA";
    setMasterTemplates(loadAllMasterTemplates(cat));
    // When D1 hydration finishes after the dialog is already open, re-pull
    // from the (now-populated) cache so the Load Default picker isn't stuck
    // with stale defaults.
    const unsub = onMasterTemplatesHydrated(() => {
      setMasterTemplates(loadAllMasterTemplates(cat));
    });
    return unsub;
  }, [open, product.category]);

  // The master that the auto-resolver WOULD pick for this product — used to
  // highlight the matching row in the Load Default picker so the user can
  // still see "this is what Load Default used to do" at a glance.
  const autoMatchMasterId = useMemo(() => {
    const sizeKey = (product.sizeCode || "").trim().toUpperCase();
    if (!sizeKey) return null;
    const match = masterTemplates.find(
      (t) => (t.moduleKey || "").trim().toUpperCase() === sizeKey,
    );
    return match?.id || null;
  }, [masterTemplates, product.sizeCode]);

  // Initialize from template when opened
  useEffect(() => {
    if (open) {
      setL1Processes(template.l1Processes.map((p) => ({ ...p })));
      setL1Materials((template.l1Materials || []).map((m) => ({ ...m })));
      setWipComponents(
        template.wipComponents.map((w) => ({
          ...w,
          processes: w.processes.map((p) => ({ ...p })),
        }))
      );
      setTab("l1");
      setShowCopyFrom(false);
      setShowLoadDefault(false);
    }
  }, [open, template]);

  // Load a specific master template from the Load Default picker.
  // When masterId is null, falls back to the product-aware auto-resolver
  // (same behaviour as the old single-button Load Default).
  function loadDefault(masterId: string | null) {
    const master = masterId ? loadMasterTemplateById(masterId) : null;
    const label = master?.label || "auto-matched";
    if (
      !confirm(
        `Load "${label}" master template? This will replace current L1 processes, L1 materials, and WIP components.`,
      )
    ) {
      return;
    }
    const parts = generateDefaultBOMParts(product, master || undefined);
    setL1Processes(parts.l1Processes);
    setL1Materials(parts.l1Materials);
    setWipComponents(parts.wipComponents);
    setShowLoadDefault(false);
  }

  // Copy from another existing template
  function copyFromTemplate(sourceId: string) {
    const src = allTemplates.find((t) => t.id === sourceId);
    if (!src) return;
    if (!confirm(`Copy BOM from ${src.productCode}? This will replace current content.`)) return;
    setL1Processes(src.l1Processes.map((p) => ({ ...p })));
    setL1Materials((src.l1Materials || []).map((m) => ({ ...m })));
    setWipComponents(
      src.wipComponents.map((w) => ({
        ...w,
        id: `wip-copy-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        processes: w.processes.map((p) => ({ ...p })),
        materials: (w.materials || []).map((m) => ({ ...m })),
        children: (w.children || []).map((c) => ({ ...c })),
      }))
    );
    setShowCopyFrom(false);
  }

  // L1 Materials handlers
  function addL1Material() {
    setL1Materials((prev) => [...prev, { code: "", name: "", qty: 1, unit: "PCS" }]);
  }
  function removeL1Material(i: number) {
    setL1Materials((prev) => prev.filter((_, idx) => idx !== i));
  }
  function updateL1Material(i: number, field: string, value: string | number) {
    setL1Materials((prev) => prev.map((m, idx) => (idx === i ? { ...m, [field]: value } : m)));
  }
  function selectL1Material(i: number, rm: RawMaterialOption) {
    setL1Materials((prev) =>
      prev.map((m, idx) => (idx === i ? { ...m, code: rm.itemCode, name: rm.description, unit: rm.baseUOM, inventoryCode: rm.itemCode } : m))
    );
  }

  function addL1Process() {
    setL1Processes((prev) => [
      ...prev,
      { dept: "Fab Sew", deptCode: "FAB_SEW", category: "CAT 3", minutes: 30 },
    ]);
  }
  function removeL1Process(i: number) {
    setL1Processes((prev) => prev.filter((_, idx) => idx !== i));
  }
  function updateL1Process(i: number, field: string, value: string | number) {
    setL1Processes((prev) =>
      prev.map((p, idx) => {
        if (idx !== i) return p;
        if (field === "deptCode") {
          const code = value as string;
          const minutes = getProductionMinutes(code, p.category) || p.minutes;
          return { ...p, deptCode: code, dept: DEPT_LABELS[code] || code, minutes };
        }
        if (field === "category") {
          const minutes = getProductionMinutes(p.deptCode, value as string);
          return { ...p, category: value as string, minutes };
        }
        return { ...p, [field]: value };
      })
    );
  }

  function addWIPComponent() {
    const wipType = product.category === "SOFA" ? "SOFA_BASE" : "DIVAN";
    const isBedframe = product.category === "BEDFRAME";
    // Auto-populate code segments from product data
    const autoSegments: CodeSegment[] = [];
    if (product.code) {
      autoSegments.push({ type: "variant", variantCategory: "PRODUCT_CODE", value: product.code });
    }
    autoSegments.push({ type: "word", value: WIP_TYPE_LABELS[wipType]?.label || wipType });
    // Size, divan height, leg height — auto-detect from order
    autoSegments.push({ type: "variant", variantCategory: "SIZE", value: product.sizeLabel || "", autoDetect: true });
    if (isBedframe) {
      autoSegments.push({ type: "variant", variantCategory: "DIVAN_HEIGHT", value: "", autoDetect: true });
      autoSegments.push({ type: "variant", variantCategory: "LEG_HEIGHT", value: "", autoDetect: true });
    }
    if (autoSegments.length === 0) {
      autoSegments.push({ type: "word", value: "" });
    }
    setWipComponents((prev) => [
      ...prev,
      {
        id: `new-wip-${Date.now()}`,
        wipCode: buildWipCode(autoSegments),
        codeSegments: autoSegments,
        wipType: wipType as WIPComponent["wipType"],
        quantity: 1,
        processes: [
          { dept: "Wood Cut", deptCode: "WOOD_CUT", category: "CAT 1", minutes: 20 },
          { dept: "Framing", deptCode: "FRAMING", category: "CAT 4", minutes: 20 },
        ],
        materials: makeAutoMaterials(),
        children: [],
      },
    ]);
  }
  function removeWIP(i: number) {
    setWipComponents((prev) => prev.filter((_, idx) => idx !== i));
  }
  function updateWIP(i: number, field: string, value: string | number) {
    setWipComponents((prev) =>
      prev.map((w, idx) => (idx === i ? { ...w, [field]: value } : w))
    );
  }
  function addWIPProcess(wi: number) {
    setWipComponents((prev) =>
      prev.map((w, idx) =>
        idx === wi
          ? { ...w, processes: [...w.processes, { dept: "Packing", deptCode: "PACKING", category: "CAT 3", minutes: 20 }] }
          : w
      )
    );
  }
  function removeWIPProcess(wi: number, pi: number) {
    setWipComponents((prev) =>
      prev.map((w, idx) =>
        idx === wi ? { ...w, processes: w.processes.filter((_, pidx) => pidx !== pi) } : w
      )
    );
  }
  function updateWIPProcess(wi: number, pi: number, field: string, value: string | number) {
    setWipComponents((prev) =>
      prev.map((w, idx) =>
        idx === wi
          ? {
              ...w,
              processes: w.processes.map((p, pidx) => {
                if (pidx !== pi) return p;
                if (field === "deptCode") {
                  const code = value as string;
                  const minutes = getProductionMinutes(code, p.category) || p.minutes;
                  return { ...p, deptCode: code, dept: DEPT_LABELS[code] || code, minutes };
                }
                if (field === "category") {
                  const minutes = getProductionMinutes(p.deptCode, value as string);
                  return { ...p, category: value as string, minutes };
                }
                return { ...p, [field]: value };
              }),
            }
          : w
      )
    );
  }
  function addWIPMaterial(wi: number) {
    setWipComponents((prev) =>
      prev.map((w, idx) =>
        idx === wi
          ? { ...w, materials: [...(w.materials || []), { code: "", name: "", qty: 1, unit: "PCS" }] }
          : w
      )
    );
  }
  function removeWIPMaterial(wi: number, mi: number) {
    setWipComponents((prev) =>
      prev.map((w, idx) =>
        idx === wi ? { ...w, materials: (w.materials || []).filter((_, midx) => midx !== mi) } : w
      )
    );
  }
  function updateWIPMaterial(wi: number, mi: number, field: string, value: string | number) {
    setWipComponents((prev) =>
      prev.map((w, idx) =>
        idx === wi
          ? { ...w, materials: (w.materials || []).map((m, midx) => midx === mi ? { ...m, [field]: value } : m) }
          : w
      )
    );
  }
  // --- Recursive Sub-WIP helpers using path-based updates ---
  function makeAutoSegments(): CodeSegment[] {
    const wipType = product.category === "SOFA" ? "SOFA_BASE" : "DIVAN";
    const isBedframe = product.category === "BEDFRAME";
    const segs: CodeSegment[] = [];
    if (product.code) segs.push({ type: "variant", variantCategory: "PRODUCT_CODE", value: product.code });
    segs.push({ type: "word", value: WIP_TYPE_LABELS[wipType]?.label || wipType });
    segs.push({ type: "variant", variantCategory: "SIZE", value: product.sizeLabel || "", autoDetect: true });
    if (isBedframe) {
      segs.push({ type: "variant", variantCategory: "DIVAN_HEIGHT", value: "", autoDetect: true });
      segs.push({ type: "variant", variantCategory: "LEG_HEIGHT", value: "", autoDetect: true });
    }
    return segs.length > 0 ? segs : [{ type: "word", value: "" }];
  }

  function makeAutoMaterials(): WIPMaterial[] {
    const mats: WIPMaterial[] = [];
    // Fabric — auto-detect from SO item's fabricCode
    mats.push({ code: "", name: "Fabric (from order)", qty: 1, unit: "MTR", autoDetect: "FABRIC" });
    // Leg — auto-detect from SO item's leg specification (bedframe only)
    if (product.category === "BEDFRAME") {
      mats.push({ code: "", name: "Leg (from order)", qty: 1, unit: "PCS", autoDetect: "LEG" });
    }
    return mats;
  }

  // Deep update a WIP node at a given path (array of child indices)
  function updateAtPath(wip: WIPComponent, path: number[], updater: (w: WIPComponent) => WIPComponent): WIPComponent {
    if (path.length === 0) return updater(wip);
    const [head, ...rest] = path;
    return { ...wip, children: (wip.children || []).map((c, i) => i === head ? updateAtPath(c, rest, updater) : c) };
  }

  function addSubWIPAtPath(wi: number, path: number[]) {
    const autoSegs = makeAutoSegments();
    const autoMats = makeAutoMaterials();
    const wipType = product.category === "SOFA" ? "SOFA_BASE" : "DIVAN";
    setWipComponents((prev) =>
      prev.map((w, idx) => idx !== wi ? w : updateAtPath(w, path, (node) => ({
        ...node,
        children: [...(node.children || []), {
          id: `sub-wip-${Date.now()}`,
          wipCode: buildWipCode(autoSegs),
          codeSegments: autoSegs,
          wipType: wipType as WIPComponent["wipType"],
          quantity: 1,
          processes: [{ dept: "Wood Cut", deptCode: "WOOD_CUT", category: "CAT 1", minutes: 15 }],
          materials: autoMats,
          children: [],
        }],
      })))
    );
  }

  function removeSubWIPAtPath(wi: number, path: number[], si: number) {
    setWipComponents((prev) =>
      prev.map((w, idx) => idx !== wi ? w : updateAtPath(w, path, (node) => ({
        ...node,
        children: (node.children || []).filter((_, i) => i !== si),
      })))
    );
  }

  function updateSubWIPAtPath(wi: number, path: number[], field: string, value: string | number) {
    setWipComponents((prev) =>
      prev.map((w, idx) => idx !== wi ? w : updateAtPath(w, path, (node) => ({ ...node, [field]: value })))
    );
  }

  function updateSubWIPSegmentsAtPath(wi: number, path: number[], segs: CodeSegment[]) {
    setWipComponents((prev) =>
      prev.map((w, idx) => idx !== wi ? w : updateAtPath(w, path, (node) => ({ ...node, codeSegments: segs, wipCode: buildWipCode(segs) })))
    );
  }

  // Material operations at path
  function addMaterialAtPath(wi: number, path: number[]) {
    setWipComponents((prev) =>
      prev.map((w, idx) => idx !== wi ? w : updateAtPath(w, path, (node) => ({
        ...node,
        materials: [...(node.materials || []), { code: "", name: "", qty: 1, unit: "PCS" }],
      })))
    );
  }
  function removeMaterialAtPath(wi: number, path: number[], mi: number) {
    setWipComponents((prev) =>
      prev.map((w, idx) => idx !== wi ? w : updateAtPath(w, path, (node) => ({
        ...node,
        materials: (node.materials || []).filter((_, i) => i !== mi),
      })))
    );
  }
  function selectMaterialAtPath(wi: number, path: number[], mi: number, rm: RawMaterialOption) {
    setWipComponents((prev) =>
      prev.map((w, idx) => idx !== wi ? w : updateAtPath(w, path, (node) => ({
        ...node,
        materials: (node.materials || []).map((m, i) => i === mi ? { ...m, code: rm.itemCode, name: rm.description, unit: rm.baseUOM, inventoryCode: rm.itemCode } : m),
      })))
    );
  }
  function updateMaterialAtPath(wi: number, path: number[], mi: number, field: string, value: string | number) {
    setWipComponents((prev) =>
      prev.map((w, idx) => idx !== wi ? w : updateAtPath(w, path, (node) => ({
        ...node,
        materials: (node.materials || []).map((m, i) => i === mi ? { ...m, [field]: value } : m),
      })))
    );
  }

  // Process operations at path
  function addProcessAtPath(wi: number, path: number[]) {
    setWipComponents((prev) =>
      prev.map((w, idx) => idx !== wi ? w : updateAtPath(w, path, (node) => ({
        ...node,
        processes: [...node.processes, { dept: "Packing", deptCode: "PACKING", category: "CAT 3", minutes: 20 }],
      })))
    );
  }
  function removeProcessAtPath(wi: number, path: number[], pi: number) {
    setWipComponents((prev) =>
      prev.map((w, idx) => idx !== wi ? w : updateAtPath(w, path, (node) => ({
        ...node,
        processes: node.processes.filter((_, i) => i !== pi),
      })))
    );
  }
  function updateProcessAtPath(wi: number, path: number[], pi: number, field: string, value: string | number) {
    setWipComponents((prev) =>
      prev.map((w, idx) => idx !== wi ? w : updateAtPath(w, path, (node) => ({
        ...node,
        processes: node.processes.map((p, i) => {
          if (i !== pi) return p;
          if (field === "deptCode") return { ...p, deptCode: value as string, dept: DEPT_LABELS[value as string] || (value as string) };
          return { ...p, [field]: value };
        }),
      })))
    );
  }
  function updateWIPSegments(wi: number, segs: CodeSegment[]) {
    setWipComponents((prev) =>
      prev.map((w, idx) =>
        idx === wi ? { ...w, codeSegments: segs, wipCode: buildWipCode(segs) } : w
      )
    );
  }
  function selectMaterial(wi: number, mi: number, rm: RawMaterialOption) {
    setWipComponents((prev) =>
      prev.map((w, idx) =>
        idx === wi
          ? { ...w, materials: (w.materials || []).map((m, midx) => midx === mi ? { ...m, code: rm.itemCode, name: rm.description, unit: rm.baseUOM, inventoryCode: rm.itemCode } : m) }
          : w
      )
    );
  }

  function handleSave() {
    onSaved({
      ...template,
      l1Processes,
      l1Materials,
      wipComponents: wipComponents.map((w) => ({
        ...w,
        wipCode: w.wipCode || `${product.code}-WIP-${wipComponents.indexOf(w) + 1}`,
      })),
    });
    onClose();
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-xl w-[720px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
          <div>
            <h2 className="text-lg font-bold text-[#111827]">Edit BOM — {product.code}</h2>
            <p className="text-xs text-gray-500 mt-0.5">{product.name}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <button
                onClick={() => setShowLoadDefault((v) => !v)}
                title={`Load a master ${product.category} template`}
                className="text-xs px-2.5 py-1.5 bg-[#FAEFCB] text-[#9C6F1E] border border-[#E8D597] rounded hover:bg-[#FAEFCB] flex items-center gap-1"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                Load Default
              </button>
              {showLoadDefault && (
                <div className="absolute right-0 top-full mt-1 w-64 max-h-72 overflow-y-auto bg-white border border-gray-200 rounded-md shadow-lg z-10">
                  <div className="px-3 py-2 text-[10px] uppercase font-semibold text-gray-500 border-b border-gray-100">
                    Load from master template
                  </div>
                  {masterTemplates.map((mt) => {
                    const isAutoMatch = mt.id === autoMatchMasterId;
                    return (
                      <button
                        key={mt.id}
                        onClick={() => loadDefault(mt.id)}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-[#FAEFCB] border-b border-gray-50 last:border-b-0 flex items-center justify-between gap-2"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-gray-900 truncate flex items-center gap-1">
                            {mt.isDefault && <span className="text-[#9C6F1E]">★</span>}
                            {mt.label}
                            {isAutoMatch && (
                              <span className="text-[9px] font-semibold text-[#4F7C3A] bg-[#EEF3E4] px-1 py-0.5 rounded">
                                matches {product.sizeCode}
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-gray-500">
                            {mt.wipItems.length} WIPs · {mt.l1Processes.length} L1 processes
                          </div>
                        </div>
                      </button>
                    );
                  })}
                  {masterTemplates.length === 0 && (
                    <div className="px-3 py-4 text-xs text-gray-400 text-center">
                      No master templates saved yet
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="relative">
              <button
                onClick={() => setShowCopyFrom((v) => !v)}
                className="text-xs px-2.5 py-1.5 bg-[#E0EDF0] text-[#3E6570] border border-[#A8CAD2] rounded hover:bg-[#E0EDF0] flex items-center gap-1"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                Copy From…
              </button>
              {showCopyFrom && (
                <div className="absolute right-0 top-full mt-1 w-64 max-h-64 overflow-y-auto bg-white border border-gray-200 rounded-md shadow-lg z-10">
                  <div className="px-3 py-2 text-[10px] uppercase font-semibold text-gray-500 border-b border-gray-100">
                    Copy from existing BOM
                  </div>
                  {allTemplates
                    .filter((t) => t.id !== template.id && t.category === product.category)
                    .map((t) => (
                      <button
                        key={t.id}
                        onClick={() => copyFromTemplate(t.id)}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-[#E0EDF0] border-b border-gray-50 last:border-b-0"
                      >
                        <div className="font-medium text-gray-900">{t.productCode}</div>
                        <div className="text-[10px] text-gray-500">{t.wipComponents.length} WIPs · {t.l1Processes.length} L1 processes</div>
                      </button>
                    ))}
                  {allTemplates.filter((t) => t.id !== template.id && t.category === product.category).length === 0 && (
                    <div className="px-3 py-4 text-xs text-gray-400 text-center">No other {product.category} templates</div>
                  )}
                </div>
              )}
            </div>
            <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded ml-1">
              <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Tab selector */}
        <div className="px-6 py-3 border-b border-[#E2DDD8] flex gap-2">
          <button
            onClick={() => setTab("l1")}
            className={`px-3 py-1.5 text-xs font-medium rounded-md ${tab === "l1" ? "bg-[#6B5C32] text-white" : "bg-[#FAF9F7] text-gray-600 hover:bg-[#E2DDD8]"}`}
          >
            L1 Processes (FG)
          </button>
          <button
            onClick={() => setTab("wip")}
            className={`px-3 py-1.5 text-xs font-medium rounded-md ${tab === "wip" ? "bg-[#6B5C32] text-white" : "bg-[#FAF9F7] text-gray-600 hover:bg-[#E2DDD8]"}`}
          >
            WIP Components ({wipComponents.length})
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {tab === "l1" && (
            <>
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-[#111827]">L1 Processes (Finished Good)</label>
                <button onClick={addL1Process} className="text-xs px-2 py-1 bg-[#6B5C32] text-white rounded hover:bg-[#5A4D2A]">+ Add Process</button>
              </div>
              <div className="space-y-2">
                {l1Processes.map((p, i) => (
                  <div key={i} className="flex items-center gap-2 bg-[#FAF9F7] rounded-md px-3 py-2">
                    <select value={p.deptCode} onChange={(e) => updateL1Process(i, "deptCode", e.target.value)} className="text-sm border border-[#E2DDD8] rounded px-2 py-1 bg-white">
                      {DEPT_ORDER.map((d) => (<option key={d} value={d}>{DEPT_LABELS[d]}</option>))}
                    </select>
                    <select value={p.category} onChange={(e) => updateL1Process(i, "category", e.target.value)} className="text-sm border border-[#E2DDD8] rounded px-2 py-1 w-20 bg-white">
                      <option value="">CAT</option>
                      {getCategoryOptions().map((c) => (<option key={c} value={c}>{c}</option>))}
                    </select>
                    <span className="text-sm text-gray-700 bg-[#FAF9F7] border border-[#E2DDD8] rounded px-2 py-1 w-20 text-center tabular-nums">{p.minutes}</span>
                    <span className="text-xs text-gray-400">min</span>
                    <button onClick={() => removeL1Process(i)} className="ml-auto p-1 hover:bg-[#F9E1DA] rounded text-[#9A3A2D]">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    </button>
                  </div>
                ))}
              </div>

              {/* L1 Raw Materials (FG-level) */}
              <div className="flex items-center justify-between mt-6 pt-4 border-t border-[#E2DDD8]">
                <div>
                  <label className="text-sm font-medium text-[#111827]">L1 Raw Materials (Finished Good)</label>
                  <p className="text-[10px] text-gray-400 mt-0.5">Materials consumed at FG assembly (e.g. packaging, bolts, final-assembly hardware)</p>
                </div>
                <button onClick={addL1Material} className="text-xs px-2 py-1 bg-[#4F7C3A] text-white rounded hover:bg-[#3D6329]">+ Add Material</button>
              </div>
              <div className="space-y-2">
                {l1Materials.map((m, i) => (
                  <div key={i} className="flex items-center gap-2 bg-[#EEF3E4] border border-[#C6DBA8] rounded-md px-3 py-2">
                    {m.autoDetect ? (
                      <div className="flex items-center gap-1.5 flex-1">
                        <span className="text-[10px] px-1.5 py-0.5 bg-[#E0EDF0] text-[#3E6570] rounded font-medium border border-[#A8CAD2] whitespace-nowrap">
                          {m.autoDetect === "FABRIC" ? "Fabric from order" : "Leg from order"}
                        </span>
                        <span className="text-[10px] text-gray-400 italic">
                          {m.autoDetect === "FABRIC" ? "SO item fabricCode" : "SO item legHeightInches"}
                        </span>
                      </div>
                    ) : (
                      <RawMaterialSelect
                        value={m.code ? `${m.code}` : ""}
                        materials={rawMaterials}
                        onSelect={(rm) => selectL1Material(i, rm)}
                      />
                    )}
                    <input type="number" value={m.qty} onChange={(e) => updateL1Material(i, "qty", parseFloat(e.target.value) || 0)} className="text-xs border border-[#C6DBA8] rounded px-1.5 py-1 w-14 bg-white" />
                    <span className="text-[10px] text-gray-500 w-8">{m.unit || "PCS"}</span>
                    <button onClick={() => removeL1Material(i)} className="ml-auto p-1 hover:bg-[#F9E1DA] rounded text-[#9A3A2D]">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                ))}
                {l1Materials.length === 0 && (
                  <p className="text-[11px] text-gray-400 italic px-1">No L1 raw materials. Click &ldquo;+ Add Material&rdquo; or use Load Default.</p>
                )}
              </div>
            </>
          )}

          {tab === "wip" && (
            <>
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-[#111827]">WIP Components</label>
                <button onClick={addWIPComponent} className="text-xs px-2 py-1 bg-[#6B5C32] text-white rounded hover:bg-[#5A4D2A]">+ Add WIP</button>
              </div>
              {wipComponents.length === 0 && (
                <div className="text-center py-8 text-sm text-gray-400 bg-[#FAF9F7] rounded-lg border border-dashed border-[#E2DDD8]">
                  No WIP components. Click &ldquo;+ Add WIP&rdquo; to add one.
                </div>
              )}
              <div className="space-y-4">
                {wipComponents.map((w, wi) => (
                  <div key={w.id} className="border border-[#A8CAD2] rounded-lg bg-[#E0EDF0] p-3 space-y-2">
                    {/* WIP header */}
                    <div className="flex items-center gap-2">
                      <select value={w.wipType} onChange={(e) => updateWIP(wi, "wipType", e.target.value)} className="text-sm border border-[#A8CAD2] rounded px-2 py-1 bg-white">
                        {Object.entries(WIP_TYPE_LABELS).map(([k, v]) => (<option key={k} value={k}>{v.label}</option>))}
                      </select>
                      <input type="number" value={w.quantity} onChange={(e) => updateWIP(wi, "quantity", parseInt(e.target.value) || 1)} className="text-sm border border-[#A8CAD2] rounded px-2 py-1 w-16 bg-white" min={1} />
                      <span className="text-xs text-gray-500">PCS</span>
                      <button onClick={() => removeWIP(wi)} className="ml-auto p-1 hover:bg-[#F9E1DA] rounded text-[#9A3A2D]">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                      </button>
                    </div>

                    {/* WIP Code Builder */}
                    <div className="bg-white rounded-md px-2 py-1.5 border border-[#A8CAD2]">
                      <div className="text-[10px] font-medium text-[#3E6570] mb-1">WIP Code (Word + Variant combination)</div>
                      <WIPCodeBuilder
                        segments={w.codeSegments || (w.wipCode ? [{ type: "word" as const, value: w.wipCode }] : [{ type: "word" as const, value: "" }])}
                        onChange={(segs) => updateWIPSegments(wi, segs)}
                        fabricOptions={fabricOptions}
                        variantCategories={productVariantCategories}
                      />
                    </div>

                    {/* Processes */}
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-[#3E6570]">Processes</span>
                      <button onClick={() => addWIPProcess(wi)} className="text-[10px] px-1.5 py-0.5 bg-[#E0EDF0] text-[#3E6570] rounded hover:bg-[#A8CAD2]">+ Process</button>
                    </div>
                    {w.processes.map((p, pi) => (
                      <div key={pi} className="flex items-center gap-2 bg-white rounded px-2 py-1.5">
                        <select value={p.deptCode} onChange={(e) => updateWIPProcess(wi, pi, "deptCode", e.target.value)} className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white">
                          {DEPT_ORDER.map((d) => (<option key={d} value={d}>{DEPT_LABELS[d]}</option>))}
                        </select>
                        <select value={p.category} onChange={(e) => updateWIPProcess(wi, pi, "category", e.target.value)} className="text-xs border border-gray-200 rounded px-1.5 py-1 w-16 bg-white">
                          <option value="">CAT</option>
                          {getCategoryOptions().map((c) => (<option key={c} value={c}>{c}</option>))}
                        </select>
                        <span className="text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded px-1.5 py-1 w-14 text-center tabular-nums">{p.minutes}</span>
                        <span className="text-[10px] text-gray-400">min</span>
                        <button onClick={() => removeWIPProcess(wi, pi)} className="ml-auto text-[#9A3A2D] hover:text-[#7A2E24]">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                    ))}

                    {/* Materials */}
                    <div className="flex items-center justify-between mt-2">
                      <span className="text-xs font-medium text-[#4F7C3A]">Raw Materials</span>
                      <button onClick={() => addWIPMaterial(wi)} className="text-[10px] px-1.5 py-0.5 bg-[#EEF3E4] text-[#4F7C3A] rounded hover:bg-[#C6DBA8]">+ Material</button>
                    </div>
                    {(w.materials || []).map((m, mi) => (
                      <div key={mi} className="flex items-center gap-2 bg-white rounded px-2 py-1.5">
                        {m.autoDetect ? (
                          <div className="flex items-center gap-1.5 flex-1">
                            <span className="text-[10px] px-1.5 py-0.5 bg-[#E0EDF0] text-[#3E6570] rounded font-medium border border-[#A8CAD2] whitespace-nowrap">
                              {m.autoDetect === "FABRIC" ? "Fabric from order" : "Leg from order"}
                            </span>
                            <span className="text-[10px] text-gray-400 italic">
                              {m.autoDetect === "FABRIC" ? "SO item fabricCode" : "SO item legHeightInches"}
                            </span>
                          </div>
                        ) : (
                          <RawMaterialSelect
                            value={m.code ? `${m.code}` : ""}
                            materials={rawMaterials}
                            onSelect={(rm) => selectMaterial(wi, mi, rm)}
                          />
                        )}
                        <input type="number" value={m.qty} onChange={(e) => updateWIPMaterial(wi, mi, "qty", parseFloat(e.target.value) || 0)} className="text-xs border border-gray-200 rounded px-1.5 py-1 w-14" />
                        <span className="text-[10px] text-gray-400 w-8">{m.unit || "PCS"}</span>
                        <button onClick={() => removeWIPMaterial(wi, mi)} className="text-[#9A3A2D] hover:text-[#7A2E24]">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                    ))}
                    {(w.materials || []).length === 0 && (
                      <p className="text-[10px] text-gray-400 pl-2">No materials added</p>
                    )}

                    {/* Sub-WIP (recursive) */}
                    <SubWIPTree
                      children={w.children || []}
                      wi={wi}
                      path={[]}
                      onAdd={(path) => addSubWIPAtPath(wi, path)}
                      onRemove={(path, si) => removeSubWIPAtPath(wi, path, si)}
                      onUpdate={(path, field, value) => updateSubWIPAtPath(wi, path, field, value)}
                      onUpdateSegments={(path, segs) => updateSubWIPSegmentsAtPath(wi, path, segs)}
                      onAddProcess={(path) => addProcessAtPath(wi, path)}
                      onRemoveProcess={(path, pi) => removeProcessAtPath(wi, path, pi)}
                      onUpdateProcess={(path, pi, field, value) => updateProcessAtPath(wi, path, pi, field, value)}
                      onAddMaterial={(path) => addMaterialAtPath(wi, path)}
                      onRemoveMaterial={(path, mi) => removeMaterialAtPath(wi, path, mi)}
                      onSelectMaterial={(path, mi, rm) => selectMaterialAtPath(wi, path, mi, rm)}
                      onUpdateMaterial={(path, mi, field, value) => updateMaterialAtPath(wi, path, mi, field, value)}
                      fabricOptions={fabricOptions}
                      variantCategories={productVariantCategories}
                      rawMaterials={rawMaterials}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[#E2DDD8] flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-[#E2DDD8] rounded-lg text-gray-600 hover:bg-gray-50">Cancel</button>
          <button onClick={handleSave} className="px-4 py-2 text-sm bg-[#6B5C32] text-white rounded-lg hover:bg-[#5A4D2A]">Save Changes</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Master Templates Dialog ----------
function MasterTemplatesDialog({
  open,
  onClose,
  rawMaterials,
  fabricOptions,
}: {
  open: boolean;
  onClose: () => void;
  rawMaterials: RawMaterialOption[];
  fabricOptions: string[];
}) {
  const { toast } = useToast();
  const [tab, setTab] = useState<"BEDFRAME" | "SOFA">("BEDFRAME");
  // We now keep a LIST of master templates per category. Bedframes typically
  // have one ("Default"), sofas can have many — one per module type
  // (1NA, 2A(LHF), L(RHF), CNR, 1S, ...). selectedId tracks which template
  // in the list is currently being edited.
  const [bedframeList, setBedframeList] = useState<MasterTemplate[]>(() => [buildFallbackMasterTemplate("BEDFRAME")]);
  const [sofaList, setSofaList] = useState<MasterTemplate[]>(() => [buildFallbackMasterTemplate("SOFA")]);
  const [selectedBedframeId, setSelectedBedframeId] = useState<string>("BEDFRAME");
  const [selectedSofaId, setSelectedSofaId] = useState<string>("SOFA");
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  // Default to edit mode on so Save always works. Edit lock was causing
  // confusion — users tried to save without realising the inputs were
  // locked behind pointer-events-none.
  const [editMode, setEditMode] = useState(true);
  // Copy-from picker popover state.
  const [showCopyPicker, setShowCopyPicker] = useState(false);

  // Variant categories depend on tab — used by WIPCodeBuilder for master-level
  // placeholders that get resolved to actual product variants at apply time.
  const variantCategories: VariantCategoryInfo[] = tab === "BEDFRAME"
    ? [
        { category: "PRODUCT_CODE", label: "Product Code" },
        { category: "SIZE", label: "Size" },
        { category: "DIVAN_HEIGHT", label: "Divan Height" },
        { category: "LEG_HEIGHT", label: "Leg Height" },
        { category: "TOTAL_HEIGHT", label: "Total Height" },
        { category: "FABRIC", label: "Fabric" },
        { category: "SPECIAL", label: "Special" },
      ]
    : [
        { category: "PRODUCT_CODE", label: "Product Code" },
        { category: "MODEL", label: "Model" },
        { category: "SEAT_SIZE", label: "Seat Size" },
        { category: "MODULE", label: "Module" },
        { category: "FABRIC", label: "Fabric" },
        { category: "SPECIAL", label: "Special" },
      ];

  useEffect(() => {
    if (!open) return;
    const load = () => {
      const bf = loadAllMasterTemplates("BEDFRAME");
      const sf = loadAllMasterTemplates("SOFA");
      setBedframeList(bf);
      setSofaList(sf);
      setSelectedBedframeId(
        (prev) => prev || bf.find((t) => t.isDefault)?.id || bf[0]?.id || "BEDFRAME",
      );
      setSelectedSofaId(
        (prev) => prev || sf.find((t) => t.isDefault)?.id || sf[0]?.id || "SOFA",
      );
    };
    load();
    setDeletedIds([]);
    setTab("BEDFRAME");
    setEditMode(true);
    // Re-sync when D1 hydration lands after the dialog is already open so
    // the edit lists reflect authoritative D1 data, not fallback defaults.
    return onMasterTemplatesHydrated(load);
  }, [open]);

  const currentList = tab === "BEDFRAME" ? bedframeList : sofaList;
  const setCurrentList = tab === "BEDFRAME" ? setBedframeList : setSofaList;
  const selectedId = tab === "BEDFRAME" ? selectedBedframeId : selectedSofaId;
  const setSelectedId = tab === "BEDFRAME" ? setSelectedBedframeId : setSelectedSofaId;
  const current = currentList.find((t) => t.id === selectedId) || currentList[0] || buildFallbackMasterTemplate(tab);

  const setCurrent = (updater: (prev: MasterTemplate) => MasterTemplate) => {
    setCurrentList((prev) => prev.map((t) => (t.id === selectedId ? updater(t) : t)));
  };

  // Create a brand-new empty template in the current category.
  function addTemplate() {
    const id = `${tab}-NEW-${Date.now().toString(36).slice(-5).toUpperCase()}`;
    const tpl: MasterTemplate = {
      id,
      category: tab,
      label: tab === "SOFA" ? "New Module" : "New Variant",
      moduleKey: "",
      isDefault: false,
      l1Processes: [],
      l1Materials: [],
      wipItems: [],
      updatedAt: new Date().toISOString(),
    };
    setCurrentList((prev) => [...prev, tpl]);
    setSelectedId(id);
  }

  // Duplicate a template (deep-clone) into the CURRENT category. If no
  // source is given, copies the currently-selected template. The picker
  // popover lets users copy from any template across both categories,
  // so e.g. a sofa variant can be seeded from another sofa variant or
  // even from a bedframe template.
  function copyTemplate(source?: MasterTemplate) {
    const src = source || current;
    if (!src) return;
    const ts = Date.now().toString(36).slice(-5).toUpperCase();
    const id = `${tab}-COPY-${ts}`;
    const cloned: MasterTemplate = JSON.parse(JSON.stringify(src));
    cloned.id = id;
    cloned.category = tab; // re-home into current tab regardless of source
    cloned.label = `${src.label} (copy)`;
    cloned.moduleKey = "";
    cloned.isDefault = false;
    cloned.updatedAt = new Date().toISOString();
    // Refresh inner WIP ids so React keys stay unique across copies.
    const reid = (w: WIPComponent): WIPComponent => ({
      ...w,
      id: `${id}-wip-${Math.random().toString(36).slice(2, 8)}`,
      children: (w.children || []).map(reid),
    });
    cloned.wipItems = cloned.wipItems.map(reid);
    setCurrentList((prev) => [...prev, cloned]);
    setSelectedId(id);
  }

  // Delete the selected template. The category default cannot be deleted.
  function deleteTemplate() {
    if (!current || current.isDefault) {
      toast.warning("Cannot delete the default template for this category.");
      return;
    }
    const ok = window.confirm(`Delete master template "${current.label}"? This cannot be undone after Save.`);
    if (!ok) return;
    setDeletedIds((prev) => [...prev, current.id]);
    setCurrentList((prev) => {
      const next = prev.filter((t) => t.id !== current.id);
      const fallback = next.find((t) => t.isDefault) || next[0];
      if (fallback) setSelectedId(fallback.id);
      return next;
    });
  }

  function updateTemplateMeta(field: "label" | "moduleKey", value: string) {
    setCurrent((prev) => ({ ...prev, [field]: value }));
  }

  // ----- L1 Processes -----
  function addL1Process() {
    setCurrent((prev) => ({
      ...prev,
      l1Processes: [...prev.l1Processes, { dept: DEPT_LABELS["FAB_CUT"], deptCode: "FAB_CUT", category: "CAT 1", minutes: 0 }],
    }));
  }
  function removeL1Process(i: number) {
    setCurrent((prev) => ({ ...prev, l1Processes: prev.l1Processes.filter((_, idx) => idx !== i) }));
  }
  function updateL1Process(i: number, field: keyof BOMProcess, value: string | number) {
    setCurrent((prev) => ({
      ...prev,
      l1Processes: prev.l1Processes.map((p, idx) => {
        if (idx !== i) return p;
        if (field === "deptCode") {
          const code = value as string;
          const minutes = getProductionMinutes(code, p.category) || p.minutes;
          return { ...p, deptCode: code, dept: DEPT_LABELS[code] || code, minutes };
        }
        if (field === "category") {
          const minutes = getProductionMinutes(p.deptCode, value as string);
          return { ...p, category: value as string, minutes };
        }
        return { ...p, [field]: value };
      }),
    }));
  }

  // ----- L1 Materials -----
  function addL1Material() {
    setCurrent((prev) => ({
      ...prev,
      l1Materials: [...prev.l1Materials, { code: "", name: "", qty: 1, unit: "PCS" }],
    }));
  }
  function removeL1Material(i: number) {
    setCurrent((prev) => ({ ...prev, l1Materials: prev.l1Materials.filter((_, idx) => idx !== i) }));
  }
  function updateL1Material(i: number, field: keyof WIPMaterial, value: string | number) {
    setCurrent((prev) => ({
      ...prev,
      l1Materials: prev.l1Materials.map((m, idx) => (idx === i ? { ...m, [field]: value } : m)),
    }));
  }
  function selectL1Material(i: number, rm: RawMaterialOption) {
    setCurrent((prev) => ({
      ...prev,
      l1Materials: prev.l1Materials.map((m, idx) =>
        idx === i ? { ...m, code: rm.itemCode, name: rm.description, unit: rm.baseUOM, inventoryCode: rm.itemCode, autoDetect: undefined } : m
      ),
    }));
  }
  function setL1MaterialAutoDetect(i: number, mode: "FABRIC" | "LEG" | "NONE") {
    setCurrent((prev) => ({
      ...prev,
      l1Materials: prev.l1Materials.map((m, idx) => {
        if (idx !== i) return m;
        if (mode === "NONE") return { ...m, autoDetect: undefined };
        return {
          ...m,
          autoDetect: mode,
          code: "",
          name: mode === "FABRIC" ? "Fabric (from order)" : "Leg (from order)",
          unit: mode === "FABRIC" ? "MTR" : "PCS",
        };
      }),
    }));
  }

  // ----- WIP items (path-based: path=[] is the WIP root, path=[0] is first child, etc.) -----
  function updateAtPath(wip: WIPComponent, path: number[], updater: (w: WIPComponent) => WIPComponent): WIPComponent {
    if (path.length === 0) return updater(wip);
    const [head, ...rest] = path;
    return { ...wip, children: (wip.children || []).map((c, i) => i === head ? updateAtPath(c, rest, updater) : c) };
  }

  function makeEmptyWIP(category: "BEDFRAME" | "SOFA"): WIPComponent {
    const wipType = (category === "BEDFRAME" ? "DIVAN" : "SOFA_BASE") as WIPComponent["wipType"];
    // Seed default code segments: {PRODUCT_CODE from order} + WIP-type word
    // (e.g. "DIVAN", "HEADBOARD"). The user can then add size / heights /
    // fabric segments as needed.
    const typeLabel = WIP_TYPE_LABELS[wipType]?.label || wipType;
    const codeSegments: CodeSegment[] = [
      { type: "variant", variantCategory: "PRODUCT_CODE", value: "", autoDetect: true },
      { type: "word", value: typeLabel },
    ];
    return {
      id: `master-wip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      wipCode: buildWipCode(codeSegments),
      codeSegments,
      wipType,
      quantity: 1,
      processes: [],
      materials: [],
      children: [],
    };
  }

  function addWIP() {
    setCurrent((prev) => ({ ...prev, wipItems: [...prev.wipItems, makeEmptyWIP(prev.category)] }));
  }
  function removeWIP(wi: number) {
    setCurrent((prev) => ({ ...prev, wipItems: prev.wipItems.filter((_, idx) => idx !== wi) }));
  }
  function mutateWIP(wi: number, path: number[], updater: (w: WIPComponent) => WIPComponent) {
    setCurrent((prev) => ({
      ...prev,
      wipItems: prev.wipItems.map((w, idx) => idx === wi ? updateAtPath(w, path, updater) : w),
    }));
  }

  function updateWIPAtPath(wi: number, path: number[], field: string, value: string | number) {
    mutateWIP(wi, path, (node) => ({ ...node, [field]: value }));
  }
  function updateWIPSegmentsAtPath(wi: number, path: number[], segs: CodeSegment[]) {
    mutateWIP(wi, path, (node) => ({ ...node, codeSegments: segs, wipCode: buildWipCode(segs) }));
  }

  // Sub-WIP children
  function addSubWIPAtPath(wi: number, path: number[]) {
    mutateWIP(wi, path, (node) => ({
      ...node,
      children: [...(node.children || []), makeEmptyWIP(current.category)],
    }));
  }
  function removeSubWIPAtPath(wi: number, path: number[], si: number) {
    mutateWIP(wi, path, (node) => ({
      ...node,
      children: (node.children || []).filter((_, i) => i !== si),
    }));
  }

  // Processes at path
  function addProcessAtPath(wi: number, path: number[]) {
    mutateWIP(wi, path, (node) => ({
      ...node,
      processes: [...node.processes, { dept: DEPT_LABELS["WOOD_CUT"], deptCode: "WOOD_CUT", category: "CAT 1", minutes: 0 }],
    }));
  }
  function removeProcessAtPath(wi: number, path: number[], pi: number) {
    mutateWIP(wi, path, (node) => ({ ...node, processes: node.processes.filter((_, i) => i !== pi) }));
  }
  function updateProcessAtPath(wi: number, path: number[], pi: number, field: string, value: string | number) {
    mutateWIP(wi, path, (node) => ({
      ...node,
      processes: node.processes.map((p, i) => {
        if (i !== pi) return p;
        if (field === "deptCode") {
          const code = value as string;
          const minutes = getProductionMinutes(code, p.category) || p.minutes;
          return { ...p, deptCode: code, dept: DEPT_LABELS[code] || code, minutes };
        }
        if (field === "category") {
          const minutes = getProductionMinutes(p.deptCode, value as string);
          return { ...p, category: value as string, minutes };
        }
        return { ...p, [field]: value };
      }),
    }));
  }

  // Materials at path
  function addMaterialAtPath(wi: number, path: number[]) {
    mutateWIP(wi, path, (node) => ({
      ...node,
      materials: [...(node.materials || []), { code: "", name: "", qty: 1, unit: "PCS" }],
    }));
  }
  function removeMaterialAtPath(wi: number, path: number[], mi: number) {
    mutateWIP(wi, path, (node) => ({ ...node, materials: (node.materials || []).filter((_, i) => i !== mi) }));
  }
  function updateMaterialAtPath(wi: number, path: number[], mi: number, field: string, value: string | number) {
    mutateWIP(wi, path, (node) => ({
      ...node,
      materials: (node.materials || []).map((m, i) => (i === mi ? { ...m, [field]: value } : m)),
    }));
  }
  function selectMaterialAtPath(wi: number, path: number[], mi: number, rm: RawMaterialOption) {
    mutateWIP(wi, path, (node) => ({
      ...node,
      materials: (node.materials || []).map((m, i) =>
        i === mi ? { ...m, code: rm.itemCode, name: rm.description, unit: rm.baseUOM, inventoryCode: rm.itemCode, autoDetect: undefined } : m
      ),
    }));
  }
  function setMaterialAutoDetectAtPath(wi: number, path: number[], mi: number, mode: "FABRIC" | "LEG" | "NONE") {
    mutateWIP(wi, path, (node) => ({
      ...node,
      materials: (node.materials || []).map((m, i) => {
        if (i !== mi) return m;
        if (mode === "NONE") return { ...m, autoDetect: undefined };
        return {
          ...m,
          autoDetect: mode,
          code: "",
          name: mode === "FABRIC" ? "Fabric (from order)" : "Leg (from order)",
          unit: mode === "FABRIC" ? "MTR" : "PCS",
        };
      }),
    }));
  }

  function handleSave() {
    const now = new Date().toISOString();
    // Persist every template in both lists. saveMasterTemplate updates the
    // in-memory cache and fires an async PUT to /api/bom-master-templates/:id.
    [...bedframeList, ...sofaList].forEach((t) => saveMasterTemplate({ ...t, updatedAt: now }));
    // Apply pending deletions (also async to D1).
    deletedIds.forEach((id) => deleteMasterTemplateById(id));
    setEditMode(false);
    toast.success(
      `Master templates saved — Bedframe: ${bedframeList.length}, Sofa: ${sofaList.length}` +
      (deletedIds.length > 0 ? `, Deleted: ${deletedIds.length}` : "")
    );
    onClose();
  }

  function handleReset() {
    if (!current) return;
    const ok = typeof window !== "undefined"
      ? window.confirm(
          `Clear template "${current.label}"?\n\n` +
          `This will empty all L1 processes, L1 materials, and WIP items.\n` +
          `(Changes are only persisted after you click "Save Templates".)`
        )
      : true;
    if (!ok) return;
    setCurrent((prev) => ({ ...prev, l1Processes: [], l1Materials: [], wipItems: [] }));
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-xl w-[760px] max-h-[88vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
          <div>
            <h2 className="text-lg font-bold text-[#111827]">Master BOM Templates</h2>
            <p className="text-xs text-gray-500 mt-0.5">Category-level defaults used when creating new BOMs</p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tab selector */}
        <div className="px-6 py-3 border-b border-[#E2DDD8] flex items-center justify-between">
          <div className="flex gap-2">
            <button
              onClick={() => setTab("BEDFRAME")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md ${tab === "BEDFRAME" ? "bg-[#6B5C32] text-white" : "bg-[#FAF9F7] text-gray-600 hover:bg-[#E2DDD8]"}`}
            >
              Bedframe
            </button>
            <button
              onClick={() => setTab("SOFA")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md ${tab === "SOFA" ? "bg-[#6B5C32] text-white" : "bg-[#FAF9F7] text-gray-600 hover:bg-[#E2DDD8]"}`}
            >
              Sofa
            </button>
          </div>
          <div className="flex items-center gap-2">
            {!editMode ? (
              <button
                onClick={() => setEditMode(true)}
                className="text-[11px] px-3 py-1 bg-[#6B5C32] text-white rounded hover:bg-[#5A4D2A] inline-flex items-center gap-1"
              >
                ✏️ Edit
              </button>
            ) : (
              <span className="text-[11px] px-2 py-1 bg-[#EEF3E4] text-[#4F7C3A] border border-[#C6DBA8] rounded">
                Edit mode — unlocked
              </span>
            )}
            <button
              onClick={handleReset}
              disabled={!editMode}
              className="text-[11px] px-2 py-1 bg-[#FAEFCB] text-[#9C6F1E] border border-[#E8D597] rounded hover:bg-[#FAEFCB] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Clear all
            </button>
          </div>
        </div>

        {/* Template selector — list of templates in this category with
            New / Copy / Delete actions, plus inline label + moduleKey editors */}
        <div className="px-6 py-3 border-b border-[#E2DDD8] bg-[#FAF9F7] space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            {currentList.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                className={`px-2.5 py-1 text-[11px] rounded-full border transition-colors ${
                  t.id === selectedId
                    ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                    : "bg-white text-gray-600 border-[#E2DDD8] hover:bg-[#FAF9F7]"
                }`}
                title={t.moduleKey ? `Module: ${t.moduleKey}` : t.isDefault ? "Category default" : "Variant"}
              >
                {t.isDefault && <span className="mr-1">★</span>}
                {t.label}
                {t.moduleKey && <span className="ml-1 opacity-70">[{t.moduleKey}]</span>}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-1.5">
              <button
                onClick={addTemplate}
                disabled={!editMode}
                className="text-[10px] px-2 py-1 bg-white border border-[#E2DDD8] rounded hover:bg-white text-gray-600 disabled:opacity-40"
                title="Create a new empty template"
              >
                + New
              </button>
              <div className="relative">
                <button
                  onClick={() => setShowCopyPicker((v) => !v)}
                  disabled={!editMode}
                  className="text-[10px] px-2 py-1 bg-white border border-[#E2DDD8] rounded hover:bg-[#FAF9F7] text-gray-600 disabled:opacity-40"
                  title="Copy from another template (any category)"
                >
                  ⧉ Copy from…
                </button>
                {showCopyPicker && editMode && (
                  <div className="absolute right-0 top-full mt-1 z-50 w-64 bg-white border border-[#E2DDD8] rounded-md shadow-lg max-h-80 overflow-y-auto">
                    <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-gray-500 border-b border-[#E2DDD8] bg-[#FAF9F7] sticky top-0">
                      Copy into <span className="text-[#6B5C32] font-semibold">{tab === "BEDFRAME" ? "Bedframe" : "Sofa"}</span> from…
                    </div>
                    {(["BEDFRAME", "SOFA"] as const).map((cat) => {
                      const list = cat === "BEDFRAME" ? bedframeList : sofaList;
                      if (list.length === 0) return null;
                      return (
                        <div key={cat}>
                          <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-gray-400">
                            {cat === "BEDFRAME" ? "Bedframe templates" : "Sofa templates"}
                          </div>
                          {list.map((t) => (
                            <button
                              key={t.id}
                              onClick={() => {
                                copyTemplate(t);
                                setShowCopyPicker(false);
                              }}
                              className="w-full text-left px-3 py-1.5 text-xs hover:bg-[#FAF9F7] flex items-center gap-1.5"
                            >
                              {t.isDefault && <span className="text-[#9C6F1E]">★</span>}
                              <span className="text-gray-700">{t.label}</span>
                              {t.moduleKey && <span className="text-gray-400">[{t.moduleKey}]</span>}
                            </button>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <button
                onClick={deleteTemplate}
                disabled={!editMode || !!current?.isDefault}
                className="text-[10px] px-2 py-1 bg-[#F9E1DA] border border-[#E8B2A1] rounded hover:bg-[#F9E1DA] text-[#9A3A2D] disabled:opacity-40 disabled:cursor-not-allowed"
                title={current?.isDefault ? "Default template cannot be deleted" : "Delete this template"}
              >
                Delete
              </button>
            </div>
          </div>

          {/* Inline label + moduleKey editor for the selected template. */}
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-gray-500 uppercase tracking-wide">Label</label>
            <input
              value={current?.label || ""}
              onChange={(e) => updateTemplateMeta("label", e.target.value)}
              disabled={!editMode}
              placeholder="e.g. 1A(LHF)"
              className="text-xs border border-[#E2DDD8] rounded px-2 py-1 bg-white w-32 disabled:bg-gray-50"
            />
            <label className="text-[10px] text-gray-500 uppercase tracking-wide ml-2">Module Key</label>
            <input
              value={current?.moduleKey || ""}
              onChange={(e) => updateTemplateMeta("moduleKey", e.target.value)}
              disabled={!editMode}
              placeholder={tab === "SOFA" ? "matches Product.sizeCode (e.g. 1A(LHF))" : "(leave blank — used as fallback)"}
              className="text-xs border border-[#E2DDD8] rounded px-2 py-1 bg-white flex-1 disabled:bg-gray-50"
            />
            {current?.isDefault && (
              <span className="text-[10px] text-[#9C6F1E] bg-[#FAEFCB] border border-[#E8D597] rounded px-2 py-1">
                Default — used as fallback
              </span>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className={`space-y-5 ${!editMode ? "[&_input]:pointer-events-none [&_select]:pointer-events-none [&_button]:pointer-events-none opacity-70" : ""}`}>
          {/* L1 Processes */}
          <div>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-[#111827]">L1 Processes (Finished Good)</label>
              <button onClick={addL1Process} className="text-xs px-2 py-1 bg-[#9C6F1E] text-white rounded hover:bg-[#7A560F]">+ Add Process</button>
            </div>
            <div className="space-y-2 mt-2">
              {current.l1Processes.map((p, i) => (
                <div key={i} className="flex items-center gap-2 bg-[#FAEFCB] border border-[#E8D597] rounded-md px-3 py-2">
                  <select value={p.deptCode} onChange={(e) => updateL1Process(i, "deptCode", e.target.value)} className="text-sm border border-[#E8D597] rounded px-2 py-1 bg-white">
                    {DEPT_ORDER.map((d) => (<option key={d} value={d}>{DEPT_LABELS[d]}</option>))}
                  </select>
                  <select value={p.category} onChange={(e) => updateL1Process(i, "category", e.target.value)} className="text-sm border border-[#E8D597] rounded px-2 py-1 w-20 bg-white">
                    <option value="">CAT</option>
                    {getCategoryOptions().map((c) => (<option key={c} value={c}>{c}</option>))}
                  </select>
                  <span className="text-sm text-gray-700 bg-[#FAEFCB] border border-[#E8D597] rounded px-2 py-1 w-20 text-center tabular-nums">{p.minutes}</span>
                  <span className="text-xs text-gray-400">min</span>
                  <button onClick={() => removeL1Process(i)} className="ml-auto p-1 hover:bg-[#F9E1DA] rounded text-[#9A3A2D]">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  </button>
                </div>
              ))}
              {current.l1Processes.length === 0 && (
                <p className="text-[11px] text-gray-400 italic px-1">No L1 processes. Click &ldquo;+ Add Process&rdquo;.</p>
              )}
            </div>
          </div>

          {/* L1 Materials */}
          <div className="pt-4 border-t border-[#E2DDD8]">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-[#111827]">L1 Raw Materials</label>
                <p className="text-[10px] text-gray-400 mt-0.5">FG-level materials. Use auto-detect to pull from SO item at production.</p>
              </div>
              <button onClick={addL1Material} className="text-xs px-2 py-1 bg-[#4F7C3A] text-white rounded hover:bg-[#3D6329]">+ Add Material</button>
            </div>
            <div className="space-y-2 mt-2">
              {current.l1Materials.map((m, i) => (
                <div key={i} className="flex items-center gap-2 bg-[#EEF3E4] border border-[#C6DBA8] rounded-md px-3 py-2">
                  {m.autoDetect ? (
                    <div className="flex items-center gap-1.5 flex-1">
                      <span className="text-[10px] px-1.5 py-0.5 bg-[#E0EDF0] text-[#3E6570] rounded font-medium border border-[#A8CAD2] whitespace-nowrap">
                        {m.autoDetect === "FABRIC" ? "Fabric from order" : "Leg from order"}
                      </span>
                      <span className="text-[10px] text-gray-400 italic">
                        {m.autoDetect === "FABRIC" ? "SO item fabricCode" : "SO item legHeightInches"}
                      </span>
                    </div>
                  ) : (
                    <RawMaterialSelect
                      value={m.code ? `${m.code}` : ""}
                      materials={rawMaterials}
                      onSelect={(rm) => selectL1Material(i, rm)}
                    />
                  )}
                  <select
                    value={m.autoDetect || "NONE"}
                    onChange={(e) => setL1MaterialAutoDetect(i, e.target.value as "FABRIC" | "LEG" | "NONE")}
                    className="text-[10px] border border-[#C6DBA8] rounded px-1 py-1 bg-white"
                    title="Auto-detect mode"
                  >
                    <option value="NONE">Manual</option>
                    <option value="FABRIC">Auto: Fabric</option>
                    <option value="LEG">Auto: Leg</option>
                  </select>
                  <input type="number" value={m.qty} onChange={(e) => updateL1Material(i, "qty", parseFloat(e.target.value) || 0)} className="text-xs border border-[#C6DBA8] rounded px-1.5 py-1 w-14 bg-white" />
                  <span className="text-[10px] text-gray-500 w-8">{m.unit || "PCS"}</span>
                  <button onClick={() => removeL1Material(i)} className="ml-auto p-1 hover:bg-[#F9E1DA] rounded text-[#9A3A2D]">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
              ))}
              {current.l1Materials.length === 0 && (
                <p className="text-[11px] text-gray-400 italic px-1">No L1 raw materials.</p>
              )}
            </div>
          </div>

          {/* WIP items */}
          <div className="pt-4 border-t border-[#E2DDD8]">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-[#111827]">WIP Items</label>
              <button onClick={addWIP} className="text-xs px-2 py-1 bg-[#6B5C32] text-white rounded hover:bg-[#5A4D2A]">+ Add WIP</button>
            </div>
            <div className="space-y-4 mt-2">
              {current.wipItems.map((w, wi) => (
                <div key={w.id || wi} className="border border-[#A8CAD2] rounded-lg bg-[#E0EDF0] p-3 space-y-2">
                  {/* WIP header */}
                  <div className="flex items-center gap-2">
                    <select value={w.wipType} onChange={(e) => updateWIPAtPath(wi, [], "wipType", e.target.value)} className="text-sm border border-[#A8CAD2] rounded px-2 py-1 bg-white">
                      {Object.entries(WIP_TYPE_LABELS).map(([k, v]) => (<option key={k} value={k}>{v.label}</option>))}
                    </select>
                    <input type="number" value={w.quantity} onChange={(e) => updateWIPAtPath(wi, [], "quantity", parseInt(e.target.value) || 1)} className="text-sm border border-[#A8CAD2] rounded px-2 py-1 w-16 bg-white" min={1} />
                    <span className="text-xs text-gray-500">PCS</span>
                    <button onClick={() => removeWIP(wi)} className="ml-auto p-1 hover:bg-[#F9E1DA] rounded text-[#9A3A2D]">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    </button>
                  </div>

                  {/* WIP Code builder */}
                  <div className="bg-white border border-[#A8CAD2] rounded-md p-2">
                    <p className="text-[10px] font-semibold text-[#3E6570] uppercase tracking-wide mb-1">WIP Code (Word + Variant combination)</p>
                    <WIPCodeBuilder
                      segments={w.codeSegments || [{ type: "word" as const, value: "" }]}
                      onChange={(segs) => updateWIPSegmentsAtPath(wi, [], segs)}
                      fabricOptions={fabricOptions}
                      variantCategories={variantCategories}
                    />
                    <div className="text-[10px] text-gray-400 mt-1">
                      Code preview: <span className="font-mono text-gray-600">{buildWipCode(w.codeSegments || []) || "(empty — fills from variant at apply time)"}</span>
                    </div>
                  </div>

                  {/* Processes */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-[#3E6570]">Processes</span>
                    <button onClick={() => addProcessAtPath(wi, [])} className="text-[10px] px-1.5 py-0.5 bg-[#E0EDF0] text-[#3E6570] rounded hover:bg-[#A8CAD2]">+ Process</button>
                  </div>
                  {w.processes.map((p, pi) => (
                    <div key={pi} className="flex items-center gap-2 bg-white rounded px-2 py-1.5">
                      <select value={p.deptCode} onChange={(e) => updateProcessAtPath(wi, [], pi, "deptCode", e.target.value)} className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white">
                        {DEPT_ORDER.map((d) => (<option key={d} value={d}>{DEPT_LABELS[d]}</option>))}
                      </select>
                      <select value={p.category} onChange={(e) => updateProcessAtPath(wi, [], pi, "category", e.target.value)} className="text-xs border border-gray-200 rounded px-1.5 py-1 w-16 bg-white">
                        <option value="">CAT</option>
                        {getCategoryOptions().map((c) => (<option key={c} value={c}>{c}</option>))}
                      </select>
                      <span className="text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded px-1.5 py-1 w-14 text-center tabular-nums">{p.minutes}</span>
                      <span className="text-[10px] text-gray-400">min</span>
                      <button onClick={() => removeProcessAtPath(wi, [], pi)} className="ml-auto text-[#9A3A2D] hover:text-[#7A2E24]">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    </div>
                  ))}
                  {w.processes.length === 0 && (
                    <p className="text-[10px] text-gray-400 pl-2">No processes added</p>
                  )}

                  {/* Materials */}
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-xs font-medium text-[#4F7C3A]">Raw Materials</span>
                    <button onClick={() => addMaterialAtPath(wi, [])} className="text-[10px] px-1.5 py-0.5 bg-[#EEF3E4] text-[#4F7C3A] rounded hover:bg-[#C6DBA8]">+ Material</button>
                  </div>
                  {(w.materials || []).map((m, mi) => (
                    <div key={mi} className="flex items-center gap-2 bg-white rounded px-2 py-1.5">
                      {m.autoDetect ? (
                        <div className="flex items-center gap-1.5 flex-1">
                          <span className="text-[10px] px-1.5 py-0.5 bg-[#E0EDF0] text-[#3E6570] rounded font-medium border border-[#A8CAD2] whitespace-nowrap">
                            {m.autoDetect === "FABRIC" ? "Fabric from order" : "Leg from order"}
                          </span>
                          <span className="text-[10px] text-gray-400 italic">
                            {m.autoDetect === "FABRIC" ? "SO item fabricCode" : "SO item legHeightInches"}
                          </span>
                        </div>
                      ) : (
                        <RawMaterialSelect
                          value={m.code ? `${m.code}` : ""}
                          materials={rawMaterials}
                          onSelect={(rm) => selectMaterialAtPath(wi, [], mi, rm)}
                        />
                      )}
                      <select
                        value={m.autoDetect || "NONE"}
                        onChange={(e) => setMaterialAutoDetectAtPath(wi, [], mi, e.target.value as "FABRIC" | "LEG" | "NONE")}
                        className="text-[10px] border border-gray-200 rounded px-1 py-1 bg-white"
                        title="Auto-detect mode"
                      >
                        <option value="NONE">Manual</option>
                        <option value="FABRIC">Auto: Fabric</option>
                        <option value="LEG">Auto: Leg</option>
                      </select>
                      <input type="number" value={m.qty} onChange={(e) => updateMaterialAtPath(wi, [], mi, "qty", parseFloat(e.target.value) || 0)} className="text-xs border border-gray-200 rounded px-1.5 py-1 w-14" />
                      <span className="text-[10px] text-gray-400 w-8">{m.unit || "PCS"}</span>
                      <button onClick={() => removeMaterialAtPath(wi, [], mi)} className="text-[#9A3A2D] hover:text-[#7A2E24]">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    </div>
                  ))}
                  {(w.materials || []).length === 0 && (
                    <p className="text-[10px] text-gray-400 pl-2">No materials added</p>
                  )}

                  {/* Sub-WIP Components (unlimited nesting) */}
                  <SubWIPTree
                    children={w.children || []}
                    wi={wi}
                    path={[]}
                    onAdd={(path) => addSubWIPAtPath(wi, path)}
                    onRemove={(path, si) => removeSubWIPAtPath(wi, path, si)}
                    onUpdate={(path, field, value) => updateWIPAtPath(wi, path, field, value)}
                    onUpdateSegments={(path, segs) => updateWIPSegmentsAtPath(wi, path, segs)}
                    onAddProcess={(path) => addProcessAtPath(wi, path)}
                    onRemoveProcess={(path, pi) => removeProcessAtPath(wi, path, pi)}
                    onUpdateProcess={(path, pi, field, value) => updateProcessAtPath(wi, path, pi, field, value)}
                    onAddMaterial={(path) => addMaterialAtPath(wi, path)}
                    onRemoveMaterial={(path, mi) => removeMaterialAtPath(wi, path, mi)}
                    onSelectMaterial={(path, mi, rm) => selectMaterialAtPath(wi, path, mi, rm)}
                    onUpdateMaterial={(path, mi, field, value) => updateMaterialAtPath(wi, path, mi, field, value)}
                    fabricOptions={fabricOptions}
                    variantCategories={variantCategories}
                    rawMaterials={rawMaterials}
                  />
                </div>
              ))}
              {current.wipItems.length === 0 && (
                <div className="text-center py-8 text-sm text-gray-400 bg-[#FAF9F7] rounded-lg border border-dashed border-[#E2DDD8]">
                  No WIP items. Click &ldquo;+ Add WIP&rdquo; to add one.
                </div>
              )}
            </div>
          </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[#E2DDD8] flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-[#E2DDD8] rounded-lg text-gray-600 hover:bg-gray-50">Cancel</button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm bg-[#6B5C32] text-white rounded-lg hover:bg-[#5A4D2A]"
          >
            Save Templates
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Production Times Dialog ----------
// Inline version of the Production Times matrix from /settings/variants.
// Reads/writes the same localStorage key so BOM process rows pick up changes.

type ProductionTimes = Record<string, Record<string, number>>;

function buildDefaultProductionTimes(cats: string[]): ProductionTimes {
  const out: ProductionTimes = {};
  for (const d of DEPT_ORDER) {
    out[d] = {};
    for (const c of cats) out[d][c] = 0;
  }
  return out;
}

// Production times + fabricGroups are persisted in D1 under kv_config('variants-config').
// We hydrate through the shared kv-config cache so the Products maintenance page and
// this dialog never disagree about what's stored.

function ProductionTimesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [categories, setCategories] = useState<string[]>([]);
  const [times, setTimes] = useState<ProductionTimes>({});
  const [dirty, setDirty] = useState(false);
  const [toastMsg, setToastMsg] = useState("");
  const [editingCat, setEditingCat] = useState<{ index: number; value: string } | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  // Hydrate from D1 (via the kv-config cache) whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    const defaults = ["CAT 1", "CAT 2", "CAT 3", "CAT 4", "CAT 5", "CAT 6", "CAT 7"];
    const applyConfig = (cfg: VariantsConfig | null) => {
      const fg = cfg?.fabricGroups;
      const cats = Array.isArray(fg) && fg.length > 0 ? fg : defaults;
      const pt =
        cfg?.productionTimes && Object.keys(cfg.productionTimes).length > 0
          ? cfg.productionTimes
          : buildDefaultProductionTimes(cats);
      setCategories(cats);
      setTimes(pt);
    };

    // Optimistic render from the in-memory cache if already hydrated.
    applyConfig(getVariantsConfigSync());
    // Always re-fetch to pick up any changes since last hydrate.
    void fetchVariantsConfig().then(applyConfig);
    setDirty(false);
  }, [open]);

  function showToast(msg: string) {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 2000);
  }

  function updateTime(deptCode: string, category: string, value: number) {
    setTimes((prev) => ({
      ...prev,
      [deptCode]: { ...(prev[deptCode] || {}), [category]: value },
    }));
    setDirty(true);
  }

  function handleSave() {
    try {
      // patchVariantsConfig merges into whatever else is stored (divanHeights,
      // specials, etc) so other settings remain untouched. Save is debounced
      // on the client; we show the toast optimistically.
      patchVariantsConfig({ productionTimes: times, fabricGroups: categories });
      setDirty(false);
      showToast("Production times saved");
    } catch {
      showToast("Failed to save");
    }
  }

  function addCategory() {
    const nextNum = categories.length + 1;
    const newCat = `CAT ${nextNum}`;
    setCategories((prev) => [...prev, newCat]);
    setTimes((prev) => {
      const next = { ...prev };
      for (const d of DEPT_ORDER) {
        next[d] = { ...(next[d] || {}), [newCat]: 0 };
      }
      return next;
    });
    setDirty(true);
  }

  function deleteCategory(catIndex: number) {
    if (categories.length <= 1) return;
    const catName = categories[catIndex];
    if (!window.confirm(`Delete "${catName}"? All times for this category will be lost.`)) return;
    setCategories((prev) => prev.filter((_, i) => i !== catIndex));
    setTimes((prev) => {
      const next = { ...prev };
      for (const d of DEPT_ORDER) {
        const deptTimes = { ...(next[d] || {}) };
        delete deptTimes[catName];
        next[d] = deptTimes;
      }
      return next;
    });
    setDirty(true);
  }

  function commitRename(catIndex: number, newName: string) {
    const trimmed = newName.trim();
    const oldName = categories[catIndex];
    if (!trimmed || trimmed === oldName) {
      setEditingCat(null);
      return;
    }
    setCategories((prev) => prev.map((c, i) => (i === catIndex ? trimmed : c)));
    setTimes((prev) => {
      const next = { ...prev };
      for (const d of DEPT_ORDER) {
        const deptTimes = { ...(next[d] || {}) };
        deptTimes[trimmed] = deptTimes[oldName] ?? 0;
        delete deptTimes[oldName];
        next[d] = deptTimes;
      }
      return next;
    });
    setEditingCat(null);
    setDirty(true);
  }

  function exportCSV() {
    const header = ["Department", ...categories].join(",");
    const lines = DEPT_ORDER.map((d) => {
      const row = [DEPT_LABELS[d], ...categories.map((c) => String(times[d]?.[c] ?? 0))];
      return row.join(",");
    });
    const csv = [header, ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `production-times-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("CSV exported");
  }

  function importCSV(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || "");
        const rows = text.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
        if (rows.length < 2) { showToast("CSV is empty"); return; }
        const header = rows[0].split(",").map((s) => s.trim());
        const cats = header.slice(1).filter(Boolean);
        const labelToCode: Record<string, string> = {};
        for (const code of DEPT_ORDER) labelToCode[DEPT_LABELS[code].toLowerCase()] = code;
        const nextTimes: ProductionTimes = buildDefaultProductionTimes(cats);
        for (let i = 1; i < rows.length; i++) {
          const cells = rows[i].split(",").map((s) => s.trim());
          const deptLabel = (cells[0] || "").toLowerCase();
          const code = labelToCode[deptLabel];
          if (!code) continue;
          for (let j = 0; j < cats.length; j++) {
            const v = parseInt(cells[j + 1] || "0", 10);
            nextTimes[code][cats[j]] = isNaN(v) ? 0 : v;
          }
        }
        // Also update categories in config (D1 via shared kv-config cache).
        if (cats.length > 0) patchVariantsConfig({ fabricGroups: cats });
        setCategories(cats.length > 0 ? cats : categories);
        setTimes(nextTimes);
        setDirty(true);
        showToast("CSV imported — review and Save");
      } catch {
        showToast("Failed to parse CSV");
      }
    };
    reader.readAsText(file);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-[900px] max-w-[95vw] max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-[#E2DDD8] flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-[#111827]">Production Times</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Minutes per department x category. BOM picks a category and the minutes are auto-filled.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {dirty && (
              <span className="inline-flex items-center gap-1.5 text-xs text-[#9C6F1E] bg-[#FAEFCB] border border-[#E8D597] rounded-md px-2 py-1">
                Unsaved
              </span>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importCSV(f);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 border border-[#E2DDD8] rounded-md text-gray-600 hover:bg-[#FAF9F7]"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M17 8l-5-5m0 0L7 8m5-5v12" />
              </svg>
              Import CSV
            </button>
            <button
              onClick={exportCSV}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 border border-[#E2DDD8] rounded-md text-gray-600 hover:bg-[#FAF9F7]"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4" />
              </svg>
              Export CSV
            </button>
            <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Matrix */}
        <div className="flex-1 overflow-auto p-6">
          <table className="w-full text-sm border border-[#E2DDD8] rounded-md overflow-hidden">
            <thead className="bg-[#FAF9F7]">
              <tr>
                <th className="text-left px-3 py-2 text-xs font-semibold text-gray-600 border-b border-[#E2DDD8]">Department</th>
                {categories.map((cat, catIdx) => (
                  <th key={cat} className="text-center px-2 py-2 text-xs font-semibold text-gray-600 border-b border-[#E2DDD8] min-w-[90px]">
                    <div className="flex items-center justify-center gap-1 group">
                      {editingCat?.index === catIdx ? (
                        <input
                          autoFocus
                          type="text"
                          value={editingCat.value}
                          onChange={(e) => setEditingCat({ index: catIdx, value: e.target.value })}
                          onBlur={() => commitRename(catIdx, editingCat.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename(catIdx, editingCat.value);
                            if (e.key === "Escape") setEditingCat(null);
                          }}
                          className="w-16 text-xs border border-[#6B5C32] rounded px-1 py-0.5 text-center focus:outline-none bg-white"
                        />
                      ) : (
                        <span
                          className="cursor-pointer hover:text-[#6B5C32] hover:underline"
                          title="Click to rename"
                          onClick={() => setEditingCat({ index: catIdx, value: cat })}
                        >
                          {cat}
                        </span>
                      )}
                      {categories.length > 1 && (
                        <button
                          onClick={() => deleteCategory(catIdx)}
                          title={`Delete ${cat}`}
                          className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-[#9A3A2D] transition-opacity leading-none"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </th>
                ))}
                <th className="text-center px-2 py-2 border-b border-[#E2DDD8] min-w-[90px]">
                  <button
                    onClick={addCategory}
                    title="Add new category"
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 border border-dashed border-[#6B5C32] text-[#6B5C32] rounded hover:bg-[#6B5C32]/10 transition-colors"
                  >
                    <span className="text-base leading-none">+</span>
                    Add
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {DEPT_ORDER.map((d) => (
                <tr key={d} className="hover:bg-[#FAF9F7]/50">
                  <td className="px-3 py-2 text-xs font-medium text-[#111827] border-b border-[#E2DDD8]">{DEPT_LABELS[d]}</td>
                  {categories.map((cat) => {
                    const val = times[d]?.[cat] ?? 0;
                    return (
                      <td key={cat} className="border-b border-[#E2DDD8] p-1">
                        <div className="flex items-center justify-center gap-1">
                          <input
                            type="number"
                            value={val}
                            onChange={(e) => updateTime(d, cat, parseInt(e.target.value) || 0)}
                            className="w-14 text-xs border border-[#E2DDD8] rounded px-1 py-1 bg-white text-center focus:outline-none focus:border-[#6B5C32]"
                            min={0}
                          />
                          <span className="text-[9px] text-gray-400">m</span>
                        </div>
                      </td>
                    );
                  })}
                  <td className="border-b border-[#E2DDD8]" />
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[11px] text-gray-400 mt-3">
            When you set a process&apos;s category in BOM, the minutes are auto-filled from this matrix.
          </p>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[#E2DDD8] flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-[#E2DDD8] rounded-lg text-gray-600 hover:bg-gray-50">
            Close
          </button>
          <button
            onClick={handleSave}
            disabled={!dirty}
            className="px-4 py-2 text-sm bg-[#6B5C32] text-white rounded-lg hover:bg-[#5A4D2A] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Save Times
          </button>
        </div>

        {/* Toast */}
        {toastMsg && (
          <div className="fixed bottom-6 right-6 inline-flex items-center gap-2 px-4 py-2.5 bg-[#4F7C3A] text-white rounded-lg shadow-lg text-sm z-[60]">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            {toastMsg}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Batch Edit Categories Dialog ----------
function BatchEditCategoriesDialog({
  open,
  onClose,
  templates,
  onTemplatesUpdated,
}: {
  open: boolean;
  onClose: () => void;
  templates: BOMTemplate[];
  onTemplatesUpdated: (updated: BOMTemplate[]) => void;
}) {
  const { toast } = useToast();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deptCode, setDeptCode] = useState(DEPT_ORDER[0]);
  const [newCategory, setNewCategory] = useState("");
  // Smart filters
  const [searchText, setSearchText] = useState("");
  const [filterCategory, setFilterCategory] = useState<"ALL" | "BEDFRAME" | "SOFA">("ALL");
  const [filterBaseModel, setFilterBaseModel] = useState("");
  const [filterCurrentCat, setFilterCurrentCat] = useState("");

  // Collect all distinct categories across all templates' processes
  const allCategories = useMemo(() => {
    const cats = new Set<string>();
    function collectFromProcesses(procs: BOMProcess[]) {
      for (const p of procs) {
        if (p.category) cats.add(p.category);
      }
    }
    function collectFromWip(wips: WIPComponent[]) {
      for (const w of wips) {
        collectFromProcesses(w.processes);
        if (w.children) collectFromWip(w.children);
      }
    }
    for (const t of templates) {
      collectFromProcesses(t.l1Processes);
      collectFromWip(t.wipComponents);
    }
    const configCats = getCategoryOptions();
    for (const c of configCats) cats.add(c);
    return Array.from(cats).sort();
  }, [templates]);

  // Unique base models for filter dropdown
  const uniqueBaseModels = useMemo(() => {
    const models = new Set<string>();
    for (const t of templates) {
      if (t.baseModel) models.add(t.baseModel);
    }
    return Array.from(models).sort();
  }, [templates]);

  // Get current category for a template in the selected dept
  function getCurrentDeptCategory(t: BOMTemplate): string {
    // Check l1Processes first
    const l1Match = t.l1Processes.find((p) => p.deptCode === deptCode);
    if (l1Match?.category) return l1Match.category;
    // Check WIP processes
    function findInWip(wips: WIPComponent[]): string {
      for (const w of wips) {
        const match = w.processes.find((p) => p.deptCode === deptCode);
        if (match?.category) return match.category;
        if (w.children) {
          const childResult = findInWip(w.children);
          if (childResult) return childResult;
        }
      }
      return "";
    }
    return findInWip(t.wipComponents);
  }

  // Unique current categories for the selected dept
  const uniqueCurrentCats = useMemo(() => {
    const cats = new Set<string>();
    for (const t of templates) {
      const cat = getCurrentDeptCategory(t);
      if (cat) cats.add(cat);
    }
    return Array.from(cats).sort();
  }, [templates, deptCode]);

  // Filtered templates
  const filteredTemplates = useMemo(() => {
    return templates.filter((t) => {
      if (filterCategory !== "ALL" && t.category !== filterCategory) return false;
      if (filterBaseModel && t.baseModel !== filterBaseModel) return false;
      if (filterCurrentCat) {
        const cur = getCurrentDeptCategory(t);
        if (cur !== filterCurrentCat) return false;
      }
      if (searchText) {
        const q = searchText.toLowerCase();
        if (
          !t.productCode.toLowerCase().includes(q) &&
          !t.baseModel.toLowerCase().includes(q)
        ) return false;
      }
      return true;
    });
  }, [templates, filterCategory, filterBaseModel, filterCurrentCat, searchText, deptCode]);

  useEffect(() => {
    if (!open) return;
    setSelectedIds(new Set());
    setDeptCode(DEPT_ORDER[0]);
    setNewCategory(allCategories[0] || "CAT 1");
    setSearchText("");
    setFilterCategory("ALL");
    setFilterBaseModel("");
    setFilterCurrentCat("");
  }, [open, allCategories]);

  const allFilteredSelected = filteredTemplates.length > 0 && filteredTemplates.every((t) => selectedIds.has(t.id));

  function toggleAllFiltered() {
    if (allFilteredSelected) {
      // Deselect only filtered ones
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const t of filteredTemplates) next.delete(t.id);
        return next;
      });
    } else {
      // Select all filtered ones (add to existing selection)
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const t of filteredTemplates) next.add(t.id);
        return next;
      });
    }
  }

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function updateProcessCategory(procs: BOMProcess[], dept: string, cat: string): BOMProcess[] {
    return procs.map((p) =>
      p.deptCode === dept ? { ...p, category: cat, minutes: getProductionMinutes(dept, cat) } : p
    );
  }

  function updateWipComponents(wips: WIPComponent[], dept: string, cat: string): WIPComponent[] {
    return wips.map((w) => ({
      ...w,
      processes: updateProcessCategory(w.processes, dept, cat),
      children: w.children ? updateWipComponents(w.children, dept, cat) : undefined,
    }));
  }

  function handleApply() {
    if (selectedIds.size === 0) {
      toast.warning("No templates selected.");
      return;
    }
    if (!newCategory) {
      toast.warning("Please select a category.");
      return;
    }
    let updatedCount = 0;
    const updated = templates.map((t) => {
      if (!selectedIds.has(t.id)) return t;
      updatedCount++;
      return {
        ...t,
        l1Processes: updateProcessCategory(t.l1Processes, deptCode, newCategory),
        wipComponents: updateWipComponents(t.wipComponents, deptCode, newCategory),
      };
    });

    onTemplatesUpdated(updated);
    toast.success(`Updated ${updatedCount} template${updatedCount !== 1 ? "s" : ""} — ${DEPT_LABELS[deptCode]} → ${newCategory}`);
    onClose();
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-[720px] max-w-[95vw] max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-[#E2DDD8]">
          <h2 className="text-lg font-bold text-[#111827]">Batch Edit Categories</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Filter → Select All Filtered → Apply. Change categories across many templates in seconds.
          </p>
        </div>

        {/* Body */}
        <div className="px-6 py-4 overflow-y-auto flex-1 space-y-4">
          {/* Department & New Category selectors */}
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-700 mb-1">Department</label>
              <select
                value={deptCode}
                onChange={(e) => { setDeptCode(e.target.value); setFilterCurrentCat(""); }}
                className="w-full border border-[#E2DDD8] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#6B5C32]"
              >
                {DEPT_ORDER.map((d) => (
                  <option key={d} value={d}>{DEPT_LABELS[d]}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-700 mb-1">New Category</label>
              <select
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                className="w-full border border-[#E2DDD8] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#6B5C32]"
              >
                {allCategories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Smart Filters */}
          <div className="bg-[#FAF9F7] rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium text-gray-500 uppercase tracking-wider">
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"/></svg>
              Filter Templates
            </div>
            <div className="grid grid-cols-4 gap-2">
              <input
                type="text"
                placeholder="Search code / model..."
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                className="col-span-2 border border-[#E2DDD8] rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-[#6B5C32] bg-white"
              />
              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value as "ALL" | "BEDFRAME" | "SOFA")}
                className="border border-[#E2DDD8] rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-[#6B5C32] bg-white"
              >
                <option value="ALL">All Types</option>
                <option value="BEDFRAME">Bedframe</option>
                <option value="SOFA">Sofa</option>
              </select>
              <select
                value={filterBaseModel}
                onChange={(e) => setFilterBaseModel(e.target.value)}
                className="border border-[#E2DDD8] rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-[#6B5C32] bg-white"
              >
                <option value="">All Models</option>
                {uniqueBaseModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={filterCurrentCat}
                onChange={(e) => setFilterCurrentCat(e.target.value)}
                className="border border-[#E2DDD8] rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-[#6B5C32] bg-white"
              >
                <option value="">Current {DEPT_LABELS[deptCode]} Category: All</option>
                {uniqueCurrentCats.map((c) => (
                  <option key={c} value={c}>Current: {c}</option>
                ))}
              </select>
              {(searchText || filterCategory !== "ALL" || filterBaseModel || filterCurrentCat) && (
                <button
                  onClick={() => { setSearchText(""); setFilterCategory("ALL"); setFilterBaseModel(""); setFilterCurrentCat(""); }}
                  className="text-xs text-gray-500 hover:text-[#9A3A2D] flex items-center gap-1"
                >
                  <span>✕</span> Clear filters
                </button>
              )}
            </div>
          </div>

          {/* Template selection */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-gray-700">
                {selectedIds.size} selected · Showing {filteredTemplates.length} of {templates.length}
              </label>
              <div className="flex items-center gap-3">
                <button
                  onClick={toggleAllFiltered}
                  className="text-xs text-[#6B5C32] hover:underline font-medium"
                >
                  {allFilteredSelected ? `Deselect All ${filteredTemplates.length}` : `Select All ${filteredTemplates.length} Filtered`}
                </button>
                {selectedIds.size > 0 && (
                  <button
                    onClick={() => setSelectedIds(new Set())}
                    className="text-xs text-[#9A3A2D] hover:underline"
                  >
                    Clear Selection
                  </button>
                )}
              </div>
            </div>
            <div className="border border-[#E2DDD8] rounded-lg max-h-[280px] overflow-y-auto">
              {filteredTemplates.length === 0 && (
                <p className="text-sm text-gray-400 p-4 text-center">No templates match the current filters.</p>
              )}
              {filteredTemplates.map((t) => {
                const curCat = getCurrentDeptCategory(t);
                return (
                  <label
                    key={t.id}
                    className={`flex items-center gap-3 px-3 py-2 hover:bg-[#FAF9F7] cursor-pointer border-b border-[#E2DDD8] last:border-b-0 ${
                      selectedIds.has(t.id) ? "bg-[#FAEFCB]/60" : ""
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(t.id)}
                      onChange={() => toggleOne(t.id)}
                      className="rounded border-gray-300 text-[#6B5C32] focus:ring-[#6B5C32]"
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-[#111827]">{t.productCode}</span>
                      <span className="ml-2 text-xs text-gray-400">{t.baseModel}</span>
                    </div>
                    {curCat && (
                      <span className="text-[10px] text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
                        {curCat}
                      </span>
                    )}
                    <span
                      className="text-[10px] font-medium px-1.5 py-0.5 rounded"
                      style={{
                        backgroundColor: t.category === "BEDFRAME" ? "#DBEAFE" : "#D1FAE5",
                        color: t.category === "BEDFRAME" ? "#1E40AF" : "#065F46",
                      }}
                    >
                      {t.category}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[#E2DDD8] flex items-center justify-between">
          <span className="text-xs text-gray-500">
            {selectedIds.size > 0
              ? `Will update ${selectedIds.size} template${selectedIds.size !== 1 ? "s" : ""}: ${DEPT_LABELS[deptCode]} → ${newCategory}`
              : "Select templates to batch update"}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm border border-[#E2DDD8] rounded-lg text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              disabled={selectedIds.size === 0}
              className="px-4 py-2 text-sm bg-[#6B5C32] text-white rounded-lg hover:bg-[#5A4D2A] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Apply to {selectedIds.size} Template{selectedIds.size !== 1 ? "s" : ""}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Main Page ----------
export default function BOMManagementPage() {
  const { toast } = useToast();
  const bomCsvInputRef = React.useRef<HTMLInputElement | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [templates, setTemplates] = useState<BOMTemplate[]>([]);
  const [rawMaterials, setRawMaterials] = useState<RawMaterialOption[]>([]);
  const [fabricOptions, setFabricOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedProductCode, setSelectedProductCode] = useState<string>("");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<"ALL" | "BEDFRAME" | "SOFA">("ALL");
  const [showEdit, setShowEdit] = useState(false);
  const [showMaster, setShowMaster] = useState(false);
  const [showProductionTimes, setShowProductionTimes] = useState(false);
  const [showBatchEditCat, setShowBatchEditCat] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const [pData, tData, invData] = await Promise.all([
          cachedFetchJson<{ success?: boolean; data?: unknown }>("/api/products"),
          cachedFetchJson<{ success?: boolean; data?: unknown }>("/api/bom/templates"),
          cachedFetchJson<{ success?: boolean; data?: { rawMaterials?: unknown[] } }>("/api/inventory"),
        ]);

        if (pData && pData.success) setProducts(pData.data as Product[]);
        if (tData && tData.success) {
          // Normalise every template: l1Processes / wipComponents are
          // accessed with .forEach / .reduce / .map all over render, so
          // any null from D1 or a stale cache entry would crash the whole
          // page (the caller then hits the ErrorBoundary). Coerce to []
          // on read — safer than null-guarding every downstream call site.
          const raw = tData.data as BOMTemplate[];
          const safe = Array.isArray(raw)
            ? raw.map((t) => ({
                ...t,
                l1Processes: Array.isArray(t?.l1Processes) ? t.l1Processes : [],
                wipComponents: Array.isArray(t?.wipComponents) ? t.wipComponents : [],
              }))
            : [];
          setTemplates(safe);
          // D1 is authoritative now. The old localStorage overlay (from
          // pre-D1 days) would otherwise keep resurrecting stale BOMs and
          // pushing them back to the server on every mount, undoing every
          // bulk reapply run.
          if (typeof window !== "undefined") {
            try { localStorage.removeItem(BOM_TEMPLATES_KEY); } catch { /* ignore */ }
          }
        }
        if (invData && invData.success && invData.data?.rawMaterials) {
          setRawMaterials((invData.data.rawMaterials as (RawMaterialOption & Record<string, unknown>)[]).map((rm) => ({
            id: rm.id, itemCode: rm.itemCode, description: rm.description, baseUOM: rm.baseUOM, itemGroup: rm.itemGroup,
          })));
          // Extract fabric codes for variant builder
          const fabrics = (invData.data.rawMaterials as RawMaterialOption[])
            .filter((rm) => rm.itemGroup === "B.M-FABR" || rm.itemGroup === "S.M-FABR")
            .map((rm) => rm.itemCode);
          setFabricOptions(fabrics);
        }
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const existingCodes = useMemo(() => new Set(templates.map((t) => t.productCode)), [templates]);
  const pendingCount = useMemo(() => products.filter((p) => !existingCodes.has(p.code)).length, [products, existingCodes]);

  // D1 is the source of truth. Individual BOM edits go through
  // `PUT /api/bom/templates/:id` below so each save only touches one row
  // instead of replacing the whole table. No localStorage write-back.

  async function handleBOMEdited(t: BOMTemplate) {
    // Optimistic update — render instantly, roll back on server error.
    setTemplates((prev) => prev.map((old) => (old.id === t.id ? t : old)));
    try {
      const res = await fetch(
        `/api/bom/templates/${encodeURIComponent(t.id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(t),
        },
      );
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || `HTTP ${res.status}`);
      }
      invalidateCachePrefix("/api/bom");
      invalidateCachePrefix("/api/products");
    } catch (err) {
      // Roll back by reloading the current server state for this product.
      toast.error(
        `Failed to save BOM: ${err instanceof Error ? err.message : "unknown error"}`,
      );
      try {
        invalidateCachePrefix("/api/bom");
        const rj = await cachedFetchJson<{ success?: boolean; data?: BOMTemplate[] }>("/api/bom/templates");
        if (rj?.success) setTemplates(rj.data as BOMTemplate[]);
      } catch { /* ignore */ }
    }
  }

  // Bulk BOM CSV — flat export of every BOM's processes and materials so
  // the user can edit Categories and Raw Materials in Excel and re-import.
  function handleExportBOMsCSV() {
    if (templates.length === 0) {
      toast.warning("No BOMs to export.");
      return;
    }
    exportBOMsCSV(templates);
  }

  function handleImportBOMsCSV(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const result = applyBOMsCSV(templates, text, rawMaterials);
      setTemplates(result.updated);
      toast.success(
        `Import complete — Updated: ${result.matched}, Skipped: ${result.missed}`
      );
    };
    reader.readAsText(file);
  }

  // Master templates only auto-push to bedframes during the initial setup
  // (above). Subsequent edits to the master template do NOT override
  // existing bedframe BOMs.
  const handleMasterClosed = () => {
    setShowMaster(false);
  };

  // Filter products
  const filteredProducts = useMemo(() => {
    let list = products;
    if (categoryFilter !== "ALL") {
      list = list.filter((p) => p.category === categoryFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (p) =>
          p.code.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q) ||
          p.baseModel.toLowerCase().includes(q)
      );
    }
    return list;
  }, [products, categoryFilter, search]);

  // Group by baseModel
  const groupedProducts = useMemo(() => {
    const groups: Record<string, Product[]> = {};
    for (const p of filteredProducts) {
      if (!groups[p.baseModel]) groups[p.baseModel] = [];
      groups[p.baseModel].push(p);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredProducts]);

  // Selected product & template
  const selectedProduct = useMemo(
    () => products.find((p) => p.code === selectedProductCode) || null,
    [products, selectedProductCode]
  );
  const selectedTemplate = useMemo(
    () => templates.find((t) => t.productCode === selectedProductCode) || null,
    [templates, selectedProductCode]
  );

  // Derive variant categories from product category — matches SO variant setup
  const productVariantCategories: VariantCategoryInfo[] = useMemo(() => {
    if (!selectedProduct) return [
      { category: "SIZE", label: "Size" },
      { category: "FABRIC", label: "Fabric" },
    ];
    const cat = (selectedProduct as Product & { category?: string }).category;
    if (cat === "BEDFRAME") {
      return [
        { category: "PRODUCT_CODE", label: "Product Code" },
        { category: "SIZE", label: "Size" },
        { category: "DIVAN_HEIGHT", label: "Divan Height" },
        { category: "LEG_HEIGHT", label: "Leg Height" },
        { category: "TOTAL_HEIGHT", label: "Total Height" },
        { category: "FABRIC", label: "Fabric" },
        { category: "SPECIAL", label: "Special" },
      ];
    }
    if (cat === "SOFA") {
      return [
        { category: "PRODUCT_CODE", label: "Product Code" },
        { category: "MODEL", label: "Model" },
        { category: "SEAT_SIZE", label: "Seat Size" },
        { category: "MODULE", label: "Module" },
        { category: "FABRIC", label: "Fabric" },
        { category: "SPECIAL", label: "Special" },
      ];
    }
    return [
      { category: "PRODUCT_CODE", label: "Product Code" },
      { category: "SIZE", label: "Size" },
      { category: "FABRIC", label: "Fabric" },
    ];
  }, [selectedProduct]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        <svg className="animate-spin w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
        Loading BOM data...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#111827]">Bill of Materials</h1>
          <p className="text-sm text-gray-500 mt-1">
            Production routing and WIP component definitions for all products
          </p>
        </div>
        <div className="flex items-center gap-2">
          {pendingCount > 0 && (
            <div className="flex items-center gap-2 px-3 py-2 bg-[#FAEFCB] border border-[#E8D597] rounded-lg">
              <span className="w-2 h-2 rounded-full bg-[#9C6F1E] animate-pulse" />
              <span className="text-sm text-[#9C6F1E] font-medium">{pendingCount} pending BOM</span>
            </div>
          )}
          <input
            ref={bomCsvInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleImportBOMsCSV(f);
              e.target.value = "";
            }}
          />
          <button
            onClick={handleExportBOMsCSV}
            title="Export every BOM as a flat CSV (edit categories / raw materials in Excel)"
            className="flex items-center gap-2 px-3 py-2 bg-white border border-[#E2DDD8] rounded-lg text-sm text-gray-700 hover:bg-[#FAF9F7]"
          >
            <svg className="w-4 h-4 text-[#6B5C32]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4" />
            </svg>
            Export BOMs
          </button>
          <button
            onClick={() => bomCsvInputRef.current?.click()}
            title="Import an edited BOM CSV — matched by ProductCode + WipPath + Kind + Index"
            className="flex items-center gap-2 px-3 py-2 bg-white border border-[#E2DDD8] rounded-lg text-sm text-gray-700 hover:bg-[#FAF9F7]"
          >
            <svg className="w-4 h-4 text-[#6B5C32]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M17 8l-5-5m0 0L7 8m5-5v12" />
            </svg>
            Import BOMs
          </button>
          <button
            onClick={() => setShowBatchEditCat(true)}
            title="Batch edit production categories across multiple BOM templates"
            className="flex items-center gap-2 px-3 py-2 bg-white border border-[#E2DDD8] rounded-lg text-sm text-gray-700 hover:bg-[#FAF9F7]"
          >
            <svg className="w-4 h-4 text-[#6B5C32]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" />
            </svg>
            Batch Edit Categories
          </button>
          <button
            onClick={() => setShowProductionTimes(true)}
            title="Production Times — minutes per department x category"
            className="flex items-center gap-2 px-3 py-2 bg-white border border-[#E2DDD8] rounded-lg text-sm text-gray-700 hover:bg-[#FAF9F7]"
          >
            <svg className="w-4 h-4 text-[#6B5C32]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Production Times
          </button>
          <button
            onClick={() => setShowMaster(true)}
            title="Edit master BOM templates per category"
            className="flex items-center gap-2 px-3 py-2 bg-white border border-[#E2DDD8] rounded-lg text-sm text-gray-700 hover:bg-[#FAF9F7]"
          >
            <svg className="w-4 h-4 text-[#6B5C32]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Master Templates
          </button>
        </div>
      </div>
      <MasterTemplatesDialog open={showMaster} onClose={handleMasterClosed} rawMaterials={rawMaterials} fabricOptions={fabricOptions} />
      <ProductionTimesDialog open={showProductionTimes} onClose={() => setShowProductionTimes(false)} />
      <BatchEditCategoriesDialog
        open={showBatchEditCat}
        onClose={() => setShowBatchEditCat(false)}
        templates={templates}
        onTemplatesUpdated={(updated) => setTemplates(updated)}
      />

      <div className="flex gap-6 min-h-[calc(100vh-180px)]">
        {/* Left panel: Product list */}
        <div className="w-[340px] flex-shrink-0 flex flex-col bg-white rounded-lg border border-[#E2DDD8] overflow-hidden">
          {/* Search & Filter */}
          <div className="p-3 border-b border-[#E2DDD8] space-y-2">
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="Search products..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm border border-[#E2DDD8] rounded-md bg-[#FAF9F7] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40 focus:border-[#6B5C32]"
              />
            </div>
            <div className="flex gap-1">
              {(["ALL", "BEDFRAME", "SOFA"] as const).map((cat) => (
                <button
                  key={cat}
                  onClick={() => setCategoryFilter(cat)}
                  className={`flex-1 px-2 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    categoryFilter === cat
                      ? "bg-[#6B5C32] text-white"
                      : "bg-[#FAF9F7] text-gray-600 hover:bg-[#E2DDD8]"
                  }`}
                >
                  {cat === "ALL" ? "All" : cat === "BEDFRAME" ? "Bedframe" : "Sofa"}
                </button>
              ))}
            </div>
            <div className="text-xs text-gray-400">
              {filteredProducts.length} products in {groupedProducts.length} groups
            </div>
          </div>

          {/* Product list */}
          <div className="flex-1 overflow-y-auto">
            {groupedProducts.map(([baseModel, prods]) => (
              <CollapsibleGroup
                key={baseModel}
                baseModel={baseModel}
                prods={prods}
                existingCodes={existingCodes}
                selectedProductCode={selectedProductCode}
                onSelect={setSelectedProductCode}
              />
            ))}
            {groupedProducts.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-gray-400">
                No products match your search
              </div>
            )}
          </div>
        </div>

        {/* Right panel: BOM detail */}
        <div className="flex-1 min-w-0">
          {selectedProduct && selectedTemplate ? (
            <>
              <BOMTreeView template={selectedTemplate} product={selectedProduct} onEdit={() => setShowEdit(true)} />
              <EditBOMDialog
                open={showEdit}
                onClose={() => setShowEdit(false)}
                template={selectedTemplate}
                product={selectedProduct}
                onSaved={handleBOMEdited}
                rawMaterials={rawMaterials}
                fabricOptions={fabricOptions}
                productVariantCategories={productVariantCategories}
                allTemplates={templates}
              />
            </>
          ) : selectedProduct && !selectedTemplate ? (
            <div className="bg-white rounded-lg border border-[#E2DDD8] p-6">
              <div className="flex items-center gap-3 mb-4">
                <span className="text-[10px] font-semibold uppercase px-2 py-1 rounded bg-[#FAEFCB] text-[#9C6F1E]">PENDING</span>
                <div>
                  <h2 className="text-lg font-bold text-[#111827]">{selectedProduct.code}</h2>
                  <p className="text-sm text-gray-500">{selectedProduct.name}</p>
                </div>
              </div>
              <p className="text-sm text-gray-600 mb-4">
                This product does not have a BOM template yet. Click below to configure its production routing and WIP components.
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    // Pre-fill from default template generator (category-aware)
                    const parts = generateDefaultBOMParts(selectedProduct);
                    const prefilled: BOMTemplate = {
                      id: `bom-${Date.now()}`,
                      productCode: selectedProduct.code,
                      baseModel: selectedProduct.baseModel,
                      category: selectedProduct.category as "BEDFRAME" | "SOFA",
                      l1Processes: parts.l1Processes,
                      l1Materials: parts.l1Materials,
                      wipComponents: parts.wipComponents,
                    };
                    setTemplates((prev) => [...prev, prefilled]);
                    setShowEdit(true);
                  }}
                  className="flex items-center gap-2 px-4 py-2.5 bg-[#6B5C32] text-white rounded-lg hover:bg-[#5A4D2A] text-sm font-medium"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  Create from Default Template
                </button>
                <button
                  onClick={() => {
                    const blank: BOMTemplate = {
                      id: `bom-${Date.now()}`,
                      productCode: selectedProduct.code,
                      baseModel: selectedProduct.baseModel,
                      category: selectedProduct.category as "BEDFRAME" | "SOFA",
                      l1Processes: [],
                      l1Materials: [],
                      wipComponents: [],
                    };
                    setTemplates((prev) => [...prev, blank]);
                    setShowEdit(true);
                  }}
                  className="flex items-center gap-2 px-4 py-2.5 bg-white text-gray-600 border border-[#E2DDD8] rounded-lg hover:bg-[#FAF9F7] text-sm font-medium"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  Start Blank
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full bg-white rounded-lg border border-[#E2DDD8]">
              <div className="text-center">
                <svg className="w-16 h-16 text-gray-200 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
                <h3 className="text-sm font-medium text-gray-500">Select a product</h3>
                <p className="text-xs text-gray-400 mt-1">Choose a product from the list to view its BOM</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
