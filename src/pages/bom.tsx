import React, { useState, useEffect, useMemo, useDeferredValue } from "react";
import { useNavigate } from "react-router-dom";
import { cachedFetchJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { getVariantsConfigSync } from "@/lib/kv-config";
import { resolveWipTokens, type BomVariantContext } from "@/api/lib/bom-wip-breakdown";
import type {
  MaterialScaling,
  MaterialScalingDimension,
} from "@/api/lib/material-scaling";

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
  // Wastage % (industry-standard scrap factor). Consumption expands the line by
  // (1 + wastePct/100) — see po-cost-cascade.ts. Meaningful for cut / bulk
  // materials (fabric / foam / wood offcuts + defects); discrete parts (screws,
  // legs, mechanism) stay 0. Optional; absent / 0 = no wastage (unchanged).
  wastePct?: number;
  inventoryCode?: string;
  autoDetect?: "FABRIC" | "LEG"; // auto-filled from SO item at production time
  // Optional dimension scaling rules — multiple rules stack across
  // independent dimensions (e.g. divan height AND gap each contribute).
  // At consumption time qty expands as
  //   effectiveQty = qty + Σ over rules:
  //                    max(0, SOLine[rule.dim] - rule.baseValue) * rule.perUnit
  // (floor: orders smaller than baseline still consume baseQty per rule).
  // See src/api/lib/material-scaling.ts for the apply helpers.
  scaling?: MaterialScaling[];
  // FILLER (sponge) cut size in inches (owner 2026-07-30). When this material
  // resolves to a sheet raw material (with a sheet size), consumption deducts
  // cutArea ÷ sheetArea of a sheet per piece instead of whole pieces. Only
  // shown/used for FILLER-group materials.
  cutLengthIn?: number;
  cutWidthIn?: number;
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

type BOMCategory = "BEDFRAME" | "SOFA" | "ACCESSORY";

type BOMTemplate = {
  id: string;
  productCode: string;
  baseModel: string;
  category: BOMCategory;
  l1Processes: BOMProcess[];
  l1Materials?: WIPMaterial[];
  wipComponents: WIPComponent[];
  autoSeeded?: boolean;
  // Set by /api/bom/templates rowToTemplate. Optional locally because some
  // code paths (master-template seeding, auto-generated rows) build a
  // BOMTemplate-shaped object without it. The Dept-Pivot editor filters on
  // it to avoid showing duplicate ACTIVE+DRAFT rows for the same product.
  versionStatus?: "DRAFT" | "ACTIVE" | "OBSOLETE";
  // ISO date — also set by rowToTemplate. Used by the selectedTemplate
  // resolver to break ties when multiple ACTIVE rows exist for the same
  // productCode (matches production-builder's `ORDER BY effectiveFrom DESC`).
  effectiveFrom?: string;
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
  FOAM_CUTTING: "#A78BFA",
  FOAM: "#8B5CF6",
  FRAMING: "#F97316",
  WEBBING: "#10B981",
  UPHOLSTERY: "#F43F5E",
  PACKING: "#06B6D4",
};

const DEPT_ORDER = ["FAB_CUT", "FAB_SEW", "WOOD_CUT", "FOAM_CUTTING", "FOAM", "FRAMING", "WEBBING", "UPHOLSTERY", "PACKING"];

// Labels MUST cover every code in DEPT_ORDER — the process-dept <select> renders
// DEPT_ORDER and looks each code up here, so a missing entry shipped a BLANK
// option (FOAM_CUTTING did exactly that). FOAM displays as "Foam Bonding"
// system-wide (owner 2026-07-30); FOAM_CUTTING is the separate tracking stage
// that runs immediately before it. Matches departments.ts's runtime self-apply.
const DEPT_LABELS: Record<string, string> = {
  FAB_CUT: "Fab Cut",
  FAB_SEW: "Fab Sew",
  WOOD_CUT: "Wood Cut",
  FOAM_CUTTING: "Foam Cutting",
  FOAM: "Foam Bonding",
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
// A BOM material is a FILLER (sponge / sheet) when the raw material it points
// to belongs to a FILLER item group — then its consumption is area-based
// (cut size ÷ sheet size). autoDetect (fabric / leg) lines are never filler.
function isFillerMaterial(m: WIPMaterial, rawMaterials: RawMaterialOption[]): boolean {
  if (m.autoDetect) return false;
  const code = m.code || m.inventoryCode;
  if (!code) return false;
  const rm = rawMaterials.find((o) => o.itemCode === code);
  return !!rm && /FILLER/i.test(rm.itemGroup || "");
}

// Reusable kit sub-BOMs (owner 2026-07-31). A mechanism / leg SKU can be bound
// (on the Component Kits page) to the screws it always needs; any BOM line that
// picks such a SKU auto-explodes the screws at consumption time. We surface a
// small read-only "auto-adds screws" hint on those lines so the author knows
// the screws are covered WITHOUT re-listing them (the whole point of 乙). The
// parent-code set is loaded once from /api/component-boms into this module-level
// set; the top-level BOM page load re-renders the tree after populating it, so
// the hint appears on first paint after data arrives. It is purely advisory —
// consumption reads the kit server-side regardless.
const KIT_PARENT_CODES = new Set<string>();
function materialHasKit(m: WIPMaterial): boolean {
  const code = m.code || m.inventoryCode;
  return !!code && KIT_PARENT_CODES.has(code);
}

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
  id: string;          // unique per template, e.g. "BEDFRAME", "SOFA", "ACCESSORY", "SOFA-1A(LHF)"
  category: BOMCategory;
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

// Sprint 7: dashboard auth lives in a HttpOnly cookie auto-attached by the
// browser via api-client's `credentials: 'include'` shim, and CSRF is
// injected there too. This local helper used to fish a Bearer token out of
// localStorage; now it just returns the JSON content-type.
function authHeaders(): HeadersInit {
  return { "content-type": "application/json" };
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
          (parsed.category as BOMCategory) ||
          (id === "SOFA" ? "SOFA" : id === "ACCESSORY" ? "ACCESSORY" : "BEDFRAME"),
        label:
          parsed.label ||
          (id === "BEDFRAME" || id === "SOFA" || id === "ACCESSORY" ? "Default" : id),
        moduleKey: parsed.moduleKey,
        isDefault: parsed.isDefault ?? (id === "BEDFRAME" || id === "SOFA" || id === "ACCESSORY"),
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

// eslint-disable-next-line react-refresh/only-export-components -- co-located master-template cache helpers used by the BOM page
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

// eslint-disable-next-line react-refresh/only-export-components -- co-located master-template cache helpers used by the BOM page
export function onMasterTemplatesHydrated(cb: () => void): () => void {
  hydrateListeners.add(cb);
  if (cacheHydrated) cb();
  return () => hydrateListeners.delete(cb);
}

function loadMasterTemplateIndex(): string[] {
  if (cachedMasters.length > 0) return cachedMasters.map((t) => t.id);
  return ["BEDFRAME", "SOFA", "ACCESSORY"];
}

function loadMasterTemplateById(id: string): MasterTemplate | null {
  const hit = cachedMasters.find((t) => t.id === id);
  return hit ?? null;
}

async function saveMasterTemplate(tpl: MasterTemplate): Promise<void> {
  const idx = cachedMasters.findIndex((t) => t.id === tpl.id);
  if (idx === -1) cachedMasters.push(tpl);
  else cachedMasters[idx] = tpl;
  // Push to D1 and surface failures to the caller. Cache reflects the write
  // immediately for synchronous read sites; the server is authoritative once
  // the page reloads. Callers that want fire-and-forget can `void` the result.
  const res = await fetch(`/api/bom-master-templates/${encodeURIComponent(tpl.id)}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify(tpl),
  });
  if (!res.ok) {
    throw new Error(`Failed to save template ${tpl.id}: HTTP ${res.status}`);
  }
  invalidateCachePrefix("/api/bom-master-templates");
  invalidateCachePrefix("/api/products");
}

async function deleteMasterTemplateById(id: string): Promise<void> {
  cachedMasters = cachedMasters.filter((t) => t.id !== id);
  const res = await fetch(`/api/bom-master-templates/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Failed to delete template ${id}: HTTP ${res.status}`);
  }
  invalidateCachePrefix("/api/bom-master-templates");
  invalidateCachePrefix("/api/products");
}

// Loads every master template (bedframe + sofa + all sofa modules) for the
// given category, ensuring a "Default" fallback always exists.
function loadAllMasterTemplates(cat: BOMCategory): MasterTemplate[] {
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
function buildFallbackMasterTemplate(cat: BOMCategory): MasterTemplate {
  if (cat === "ACCESSORY") {
    // Pillows and other accessories — no WIP components, just the three
    // finished-good processes (fabric cut / sew / packing).
    return {
      id: "ACCESSORY",
      label: "Default",
      isDefault: true,
      category: "ACCESSORY",
      l1Processes: [
        { dept: "Fab Cut", deptCode: "FAB_CUT", category: "CAT 1", minutes: 10 },
        { dept: "Fab Sew", deptCode: "FAB_SEW", category: "CAT 1", minutes: 20 },
        { dept: "Packing", deptCode: "PACKING", category: "CAT 1", minutes: 5 },
      ],
      l1Materials: [
        { code: "", name: "Fabric (from order)", qty: 1, unit: "MTR", autoDetect: "FABRIC" },
      ],
      wipItems: [],
      updatedAt: new Date().toISOString(),
    };
  }
  if (cat === "BEDFRAME") {
    return {
      id: "BEDFRAME",
      label: "Default",
      isDefault: true,
      category: "BEDFRAME",
      l1Processes: [
        { dept: "Fab Cut", deptCode: "FAB_CUT", category: "CAT 3", minutes: 50 },
        { dept: "Fab Sew", deptCode: "FAB_SEW", category: "CAT 3", minutes: 120 },
        { dept: "Foam Bonding", deptCode: "FOAM", category: "CAT 3", minutes: 25 },
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
          { dept: "Foam Bonding", deptCode: "FOAM", category: "CAT 4", minutes: 30 },
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
          { dept: "Foam Bonding", deptCode: "FOAM", category: "CAT 1", minutes: 15 },
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
  const cat: BOMCategory =
    product.category === "SOFA" ? "SOFA"
    : product.category === "ACCESSORY" ? "ACCESSORY"
    : "BEDFRAME";
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

// Patch applied to a WIPMaterial when the user picks "from SO" in the picker.
// Clears any concrete inventory link, sets the autoDetect kind, and seeds a
// sensible default UOM (fabric is sold by metre, legs by piece).
function autoDetectMaterialPatch(kind: "FABRIC" | "LEG"): Partial<WIPMaterial> {
  return {
    autoDetect: kind,
    code: "",
    inventoryCode: "",
    name: kind === "FABRIC" ? "Fabric (from order)" : "Leg (from order)",
    unit: kind === "FABRIC" ? "MTR" : "PCS",
  };
}

// ---------- Raw Material Select (searchable dropdown from inventory) ----------
function RawMaterialSelect({
  value,
  materials,
  onSelect,
  onSelectAutoDetect,
}: {
  value: string;
  materials: RawMaterialOption[];
  onSelect: (rm: RawMaterialOption) => void;
  // When provided, renders two pinned options at the top of the dropdown
  // ("Fabric from SO" / "Leg from SO") that bind the material row to the
  // SO line's fabric or leg height instead of a fixed inventory item.
  onSelectAutoDetect?: (kind: "FABRIC" | "LEG") => void;
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

  const showAutoDetect = !!onSelectAutoDetect && !search.trim();

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
          {showAutoDetect && (
            <div className="border-b border-gray-100 bg-[#F4F8FA]">
              <button
                onClick={() => { onSelectAutoDetect!("FABRIC"); setOpen(false); }}
                className="w-full text-left px-2 py-1.5 hover:bg-[#E0EDF0] transition-colors"
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] px-1.5 py-0.5 bg-[#E0EDF0] text-[#3E6570] rounded font-semibold border border-[#A8CAD2]">from SO</span>
                  <span className="text-xs font-medium text-[#3E6570]">Fabric (follow sales order)</span>
                </div>
                <div className="text-[10px] text-gray-500 mt-0.5">Resolves to SO item fabricCode at production time</div>
              </button>
              <button
                onClick={() => { onSelectAutoDetect!("LEG"); setOpen(false); }}
                className="w-full text-left px-2 py-1.5 hover:bg-[#E0EDF0] transition-colors"
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] px-1.5 py-0.5 bg-[#E0EDF0] text-[#3E6570] rounded font-semibold border border-[#A8CAD2]">from SO</span>
                  <span className="text-xs font-medium text-[#3E6570]">Leg (follow sales order)</span>
                </div>
                <div className="text-[10px] text-gray-500 mt-0.5">Resolves to SO item legHeightInches at production time</div>
              </button>
            </div>
          )}
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

// ---------- Material Scaling Editor ----------
// Inline three-input row that lives directly under each material row in
// the BOM editor. Lets the user attach a dimension-scaling rule:
//
//   { dimension, baseValue, perUnit }
//
// At consumption time the qty expands as:
//
//   effective = qty + max(0, SOLine[dim] - baseValue) * perUnit
//
// (See src/api/lib/material-scaling.ts for the apply path.) Leaving the
// dimension dropdown on "none" removes the scaling rule entirely. The
// editor renders inline + always-visible so the user can see at a glance
// which materials scale and which don't, without an extra toggle click.
// Labels match the SO line entry form (Total Height / Gap / Divan Height /
// Leg Height / Sofa Size) so authors don't have to map between two
// different vocabularies. Underlying value strings stay the same so the
// resolver in api/lib/material-scaling.ts keeps working.
const SCALING_DIM_OPTIONS: Array<{ value: MaterialScalingDimension; label: string }> = [
  { value: "totalHeight", label: "Total Height" },
  { value: "gap", label: "Gap" },
  { value: "divan", label: "Divan Height" },
  { value: "leg", label: "Leg Height" },
  { value: "seatHeight", label: "Sofa Size" },
];

// Accept both the new array shape AND legacy single-object data still
// living in saved bom_versions.tree blobs. Returns a fresh array safe
// to mutate.
function normaliseScaling(
  scaling: MaterialScaling | MaterialScaling[] | undefined,
): MaterialScaling[] {
  if (!scaling) return [];
  if (Array.isArray(scaling)) return scaling.slice();
  // Legacy single-object → 1-element array.
  return [scaling];
}

function MaterialScalingEditor({
  scaling,
  unit,
  onChange,
}: {
  // Accept legacy single-object or undefined at runtime even though the
  // declared WIPMaterial.scaling is now MaterialScaling[]. Saved BOMs
  // pre-array still flow through here; normaliseScaling handles them.
  scaling: MaterialScaling[] | MaterialScaling | undefined;
  unit: string;
  onChange: (next: MaterialScaling[] | undefined) => void;
}) {
  const rules = normaliseScaling(scaling);

  function emit(next: MaterialScaling[]) {
    onChange(next.length === 0 ? undefined : next);
  }

  function updateRule(idx: number, patch: Partial<MaterialScaling>) {
    const next = rules.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    emit(next);
  }

  function removeRule(idx: number) {
    emit(rules.filter((_, i) => i !== idx));
  }

  function addRule() {
    emit([
      ...rules,
      { dimension: "totalHeight", baseValue: 24, perUnit: 0 },
    ]);
  }

  // No rules yet: render only the "+ Add scaling" affordance so existing
  // unscaled materials keep their compact one-liner in the BOM tree.
  if (rules.length === 0) {
    return (
      <div className="ml-7 mb-1 flex items-center gap-1.5 text-[10px] text-gray-500">
        <button
          type="button"
          onClick={addRule}
          className="text-[10px] text-[#3E6570] hover:text-[#2A4A55] underline"
          title="Add a dimension scaling rule"
        >
          + Add scaling
        </button>
      </div>
    );
  }

  return (
    <div className="ml-7 mb-1 flex flex-col gap-1 text-[10px] text-gray-500">
      {rules.map((rule, idx) => (
        <div
          key={idx}
          className="flex flex-wrap items-center gap-1.5"
        >
          <span className="text-gray-400">Scale by</span>
          <select
            value={rule.dimension}
            onChange={(e) =>
              updateRule(idx, {
                dimension: e.target.value as MaterialScalingDimension,
              })
            }
            className="text-[10px] border border-gray-200 rounded px-1 py-0.5 bg-white"
          >
            {SCALING_DIM_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="text-gray-400">base</span>
          <input
            type="number" onFocus={(e) => e.currentTarget.select()}
            value={Number.isFinite(rule.baseValue) ? rule.baseValue : 0}
            step="1"
            min="0"
            onChange={(e) =>
              updateRule(idx, { baseValue: parseFloat(e.target.value) || 0 })
            }
            className="text-[10px] border border-gray-200 rounded px-1 py-0.5 w-12 bg-white"
            title="Smallest size at which the recorded qty applies"
          />
          <span className="text-gray-400">in, qty +</span>
          <input
            type="number" onFocus={(e) => e.currentTarget.select()}
            value={Number.isFinite(rule.perUnit) ? rule.perUnit : 0}
            step="0.01"
            min="0"
            onChange={(e) =>
              updateRule(idx, { perUnit: parseFloat(e.target.value) || 0 })
            }
            className="text-[10px] border border-gray-200 rounded px-1 py-0.5 w-14 bg-white"
            title="Extra qty per 1 inch over base"
          />
          <span className="text-gray-400">{unit || "unit"}/inch over base</span>
          <button
            type="button"
            onClick={() => removeRule(idx)}
            className="text-[#9A3A2D] hover:text-[#7A2E24] ml-1"
            title="Remove this scaling rule"
          >
            <svg
              className="w-3 h-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          onClick={addRule}
          className="text-[10px] text-[#3E6570] hover:text-[#2A4A55] underline"
          title="Stack another scaling rule on a different dimension"
        >
          + Add another
        </button>
      </div>
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
  const totalMin =
    wip.processes.reduce((s, p) => s + p.minutes, 0) * (wip.quantity || 1);
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
  const wipMin =
    wip.processes.reduce((s, p) => s + p.minutes, 0) * (wip.quantity || 1);
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

// Recursively walk a WIP subtree summing process minutes × node's OWN
// quantity. Quantity does NOT compound from parent to child — in this
// codebase a WIP's `quantity` is "how many of this WIP exist in one
// finished good" (per-FG semantic), not "per parent unit". Top-level
// already encodes that ("Divan x2" = 2 divans per FG); child WIPs do
// the same ("Foam x2" = 2 foams per FG, NOT 2 foams per divan). The
// pre-existing top-level-only sum at this call site multiplied by
// w.quantity directly, so this walker just extends that semantic to
// nested children.
function sumWipTreeMinutes(wips: WIPComponent[]): number {
  let total = 0;
  for (const w of wips) {
    const own = (w.processes || []).reduce((s, p) => s + p.minutes, 0);
    total += own * (w.quantity || 1);
    if (w.children?.length) total += sumWipTreeMinutes(w.children);
  }
  return total;
}

// Per-dept aggregation matching sumWipTreeMinutes — same per-node qty,
// no compounding.
function accumulateDeptMinutes(
  wips: WIPComponent[],
  out: Record<string, number>,
): void {
  for (const w of wips) {
    const q = w.quantity || 1;
    for (const p of w.processes || []) {
      out[p.deptCode] = (out[p.deptCode] || 0) + p.minutes * q;
    }
    if (w.children?.length) accumulateDeptMinutes(w.children, out);
  }
}

// Builds a self-contained HTML document for printing / save-as-PDF. The
// browser's print dialog handles the actual PDF conversion so we don't
// need any extra dependency.
function buildBOMPrintDoc(template: BOMTemplate, product: Product): string {
  const l1Min = template.l1Processes.reduce((s, p) => s + p.minutes, 0);
  const wipMin = sumWipTreeMinutes(template.wipComponents);
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

  <div class="footer">Hookka Manufacturing ERP · Confidential — for internal &amp; partner use only</div>
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
  // Recursive walk so child WIPs (foam/frame/wood/fabric inside divan,
  // headboard) get counted. Previous code only summed top-level WIPs and
  // missed every dept that lived on a child node.
  const wipMin = sumWipTreeMinutes(template.wipComponents);
  const totalMin = l1Min + wipMin;

  // Department breakdown — same recursion so depts nested under divan /
  // headboard (Wood Cut, Framing, Webbing, Foam, Fab Sew, Fab Cut) show
  // up alongside the top-level Upholstery / Packing.
  const deptMinutes: Record<string, number> = {};
  for (const p of template.l1Processes) {
    deptMinutes[p.deptCode] = (deptMinutes[p.deptCode] || 0) + p.minutes;
  }
  accumulateDeptMinutes(template.wipComponents, deptMinutes);

  const routingSteps = DEPT_ORDER.filter((d) => deptMinutes[d]).map((code) => ({
    code,
    minutes: deptMinutes[code],
    color: DEPT_COLORS[code],
  }));

  return (
    <div className="space-y-4">
      {/* Header with Edit */}
      <div className="flex flex-wrap items-center justify-between gap-2">
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
  const cat: BOMCategory =
    product.category === "SOFA" ? "SOFA"
    : product.category === "ACCESSORY" ? "ACCESSORY"
    : "BEDFRAME";
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

  // Auto-generate default BOM when product is selected.
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot seed of editor state when the user picks a product */
  useEffect(() => {
    if (!selected) return;
    const parts = generateDefaultBOMParts(selected);
    setL1Processes(parts.l1Processes);
    setL1Materials(parts.l1Materials);
    setWipComponents(parts.wipComponents);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCode]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function addL1Process() {
    setL1Processes((prev) => [
      ...prev,
      { dept: "Fab Sew", deptCode: "FAB_SEW", category: "CAT 3", minutes: 30 },
    ]);
  }

  function removeL1Process(i: number) {
    setL1Processes((prev) => prev.filter((_, idx) => idx !== i));
  }

  function updateL1Process(i: number, field: string, value: string | number | MaterialScaling[] | undefined) {
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

  function updateWIP(i: number, field: string, value: string | number | MaterialScaling[] | undefined) {
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

  function updateWIPProcess(wi: number, pi: number, field: string, value: string | number | MaterialScaling[] | undefined) {
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
  function updateWIPMaterial(wi: number, mi: number, field: string, value: string | number | MaterialScaling[] | undefined) {
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
          ? { ...w, materials: (w.materials || []).map((m, midx) => midx === mi ? { ...m, code: rm.itemCode, name: rm.description, unit: rm.baseUOM, inventoryCode: rm.itemCode, autoDetect: undefined } : m) }
          : w
      )
    );
  }
  function setMaterialAutoDetect(wi: number, mi: number, kind: "FABRIC" | "LEG") {
    const patch = autoDetectMaterialPatch(kind);
    setWipComponents((prev) =>
      prev.map((w, idx) =>
        idx === wi
          ? { ...w, materials: (w.materials || []).map((m, midx) => midx === mi ? { ...m, ...patch } : m) }
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
      category: selected.category as BOMCategory,
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
                        type="number" onFocus={(e) => e.currentTarget.select()}
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
                      <div key={mi} className="bg-white rounded">
                        <div className="flex items-center gap-2 px-2 py-1.5">
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
                              onSelectAutoDetect={(kind) => setMaterialAutoDetect(wi, mi, kind)}
                            />
                          )}
                          <input type="number" onFocus={(e) => e.currentTarget.select()} value={m.qty} onChange={(e) => updateWIPMaterial(wi, mi, "qty", parseFloat(e.target.value) || 0)} className="text-xs border border-gray-200 rounded px-1.5 py-1 w-14" />
                          <input type="number" onFocus={(e) => e.currentTarget.select()} value={m.wastePct ?? ""} onChange={(e) => updateWIPMaterial(wi, mi, "wastePct", parseFloat(e.target.value) || 0)} placeholder="0" title="Wastage % — cut / bulk materials (fabric / foam / wood) have offcut + defect waste; leave 0 for discrete parts (screws / legs / mechanism)" className="text-xs border border-gray-200 rounded px-1.5 py-1 w-12" />
                          <span className="text-[10px] text-gray-400 whitespace-nowrap" title="Wastage % — cut / bulk materials (fabric / foam / wood) have offcut + defect waste; leave 0 for discrete parts (screws / legs / mechanism)">% waste</span>
                          <span className="text-[10px] text-gray-400 w-8">{m.unit || "PCS"}</span>
                          {materialHasKit(m) && (
                            <span className="text-[10px] text-[#1D4ED8] whitespace-nowrap" title="This SKU has a Component Kit — its bound screws/parts are auto-added to consumption. Manage them on the Component Kits page.">+ kit</span>
                          )}
                          {isFillerMaterial(m, rawMaterials) && (
                            <span className="flex items-center gap-0.5 text-[10px] text-[#B8601A] whitespace-nowrap" title="Cut size in INCHES (length × width) — consumes cutArea ÷ sheetArea of a sheet">
                              cut
                              <input type="number" placeholder="L" onFocus={(e) => e.currentTarget.select()} value={m.cutLengthIn ?? ""} onChange={(e) => updateWIPMaterial(wi, mi, "cutLengthIn", parseFloat(e.target.value) || 0)} className="w-11 border border-[#E8B786] rounded px-1 py-0.5" />
                              ×
                              <input type="number" placeholder="W" onFocus={(e) => e.currentTarget.select()} value={m.cutWidthIn ?? ""} onChange={(e) => updateWIPMaterial(wi, mi, "cutWidthIn", parseFloat(e.target.value) || 0)} className="w-11 border border-[#E8B786] rounded px-1 py-0.5" />
                              in
                            </span>
                          )}
                          <button onClick={() => removeWIPMaterial(wi, mi)} className="text-[#9A3A2D] hover:text-[#7A2E24]">
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                          </button>
                        </div>
                        <MaterialScalingEditor
                          scaling={m.scaling}
                          unit={m.unit || "PCS"}
                          onChange={(s) => updateWIPMaterial(wi, mi, "scaling", s)}
                        />
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
  onSelectMaterialAutoDetect,
  onUpdateMaterial,
  onWrap,
  onMoveUp,
  onMoveDown,
  onMoveProcessUp,
  onMoveProcessDown,
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
  onUpdate: (path: number[], field: string, value: string | number | MaterialScaling[] | undefined) => void;
  onUpdateSegments: (path: number[], segs: CodeSegment[]) => void;
  onAddProcess: (path: number[]) => void;
  onRemoveProcess: (path: number[], pi: number) => void;
  onUpdateProcess: (path: number[], pi: number, field: string, value: string | number | MaterialScaling[] | undefined) => void;
  onAddMaterial: (path: number[]) => void;
  onRemoveMaterial: (path: number[], mi: number) => void;
  onSelectMaterial: (path: number[], mi: number, rm: RawMaterialOption) => void;
  onSelectMaterialAutoDetect: (path: number[], mi: number, kind: "FABRIC" | "LEG") => void;
  onUpdateMaterial: (path: number[], mi: number, field: string, value: string | number | MaterialScaling[] | undefined) => void;
  onWrap?: (path: number[], si: number) => void;
  onMoveUp?: (path: number[], si: number) => void;
  onMoveDown?: (path: number[], si: number) => void;
  onMoveProcessUp?: (path: number[], pi: number) => void;
  onMoveProcessDown?: (path: number[], pi: number) => void;
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
              <input type="number" onFocus={(e) => e.currentTarget.select()} value={sub.quantity} onChange={(e) => onUpdate(childPath, "quantity", parseInt(e.target.value) || 1)} className={`text-xs ${c.border} border rounded px-1.5 py-1 w-12 bg-white`} min={1} />
              <span className="text-[10px] text-gray-500">PCS</span>
              {onWrap && (
                <button
                  onClick={() => onWrap(path, si)}
                  className={`ml-auto text-[10px] px-1.5 py-0.5 rounded ${c.btn}`}
                  title="Wrap this sub-WIP inside a new parent (upstream)"
                >
                  + Above
                </button>
              )}
              {onMoveUp && (
                <button
                  onClick={() => onMoveUp(path, si)}
                  disabled={si === 0}
                  className={`text-[10px] px-1.5 py-0.5 rounded ${c.btn} disabled:opacity-30 disabled:cursor-not-allowed ${onWrap ? "" : "ml-auto"}`}
                  title="Move up"
                >
                  ↑
                </button>
              )}
              {onMoveDown && (
                <button
                  onClick={() => onMoveDown(path, si)}
                  disabled={si === children.length - 1}
                  className={`text-[10px] px-1.5 py-0.5 rounded ${c.btn} disabled:opacity-30 disabled:cursor-not-allowed`}
                  title="Move down"
                >
                  ↓
                </button>
              )}
              <button onClick={() => onRemove(path, si)} className={`text-[#9A3A2D] hover:text-[#7A2E24] ${onWrap || onMoveUp || onMoveDown ? "" : "ml-auto"}`}>
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
                {onMoveProcessUp && (
                  <button onClick={() => onMoveProcessUp(childPath, pi)} disabled={pi === 0} className="ml-auto text-[10px] px-1.5 py-0.5 bg-[#E0EDF0] text-[#3E6570] rounded hover:bg-[#A8CAD2] disabled:opacity-30 disabled:cursor-not-allowed" title="Move process up">↑</button>
                )}
                {onMoveProcessDown && (
                  <button onClick={() => onMoveProcessDown(childPath, pi)} disabled={pi === sub.processes.length - 1} className={`text-[10px] px-1.5 py-0.5 bg-[#E0EDF0] text-[#3E6570] rounded hover:bg-[#A8CAD2] disabled:opacity-30 disabled:cursor-not-allowed ${onMoveProcessUp ? "" : "ml-auto"}`} title="Move process down">↓</button>
                )}
                <button onClick={() => onRemoveProcess(childPath, pi)} className={`text-[#9A3A2D] hover:text-[#7A2E24] ${onMoveProcessUp || onMoveProcessDown ? "" : "ml-auto"}`}>
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
              <div key={mi} className="bg-white rounded">
                <div className="flex items-center gap-2 px-2 py-1.5">
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
                      onSelectAutoDetect={(kind) => onSelectMaterialAutoDetect(childPath, mi, kind)}
                    />
                  )}
                  <input type="number" onFocus={(e) => e.currentTarget.select()} value={m.qty} onChange={(e) => onUpdateMaterial(childPath, mi, "qty", parseFloat(e.target.value) || 0)} className="text-xs border border-gray-200 rounded px-1.5 py-1 w-14" />
                  <input type="number" onFocus={(e) => e.currentTarget.select()} value={m.wastePct ?? ""} onChange={(e) => onUpdateMaterial(childPath, mi, "wastePct", parseFloat(e.target.value) || 0)} placeholder="0" title="Wastage % — cut / bulk materials (fabric / foam / wood) have offcut + defect waste; leave 0 for discrete parts (screws / legs / mechanism)" className="text-xs border border-gray-200 rounded px-1.5 py-1 w-12" />
                  <span className="text-[10px] text-gray-400 whitespace-nowrap" title="Wastage % — cut / bulk materials (fabric / foam / wood) have offcut + defect waste; leave 0 for discrete parts (screws / legs / mechanism)">% waste</span>
                  <span className="text-[10px] text-gray-400 w-8">{m.unit || "PCS"}</span>
                  {materialHasKit(m) && (
                    <span className="text-[10px] text-[#1D4ED8] whitespace-nowrap" title="This SKU has a Component Kit — its bound screws/parts are auto-added to consumption. Manage them on the Component Kits page.">+ kit</span>
                  )}
                  {isFillerMaterial(m, rawMaterials) && (
                    <span className="flex items-center gap-0.5 text-[10px] text-[#B8601A] whitespace-nowrap" title="Cut size in INCHES (length × width) — consumes cutArea ÷ sheetArea of a sheet">
                      cut
                      <input type="number" placeholder="L" onFocus={(e) => e.currentTarget.select()} value={m.cutLengthIn ?? ""} onChange={(e) => onUpdateMaterial(childPath, mi, "cutLengthIn", parseFloat(e.target.value) || 0)} className="w-11 border border-[#E8B786] rounded px-1 py-0.5" />
                      ×
                      <input type="number" placeholder="W" onFocus={(e) => e.currentTarget.select()} value={m.cutWidthIn ?? ""} onChange={(e) => onUpdateMaterial(childPath, mi, "cutWidthIn", parseFloat(e.target.value) || 0)} className="w-11 border border-[#E8B786] rounded px-1 py-0.5" />
                      in
                    </span>
                  )}
                  <button onClick={() => onRemoveMaterial(childPath, mi)} className="text-[#9A3A2D] hover:text-[#7A2E24]">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
                <MaterialScalingEditor
                  scaling={m.scaling}
                  unit={m.unit || "PCS"}
                  onChange={(s) => onUpdateMaterial(childPath, mi, "scaling", s)}
                />
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
              onSelectMaterialAutoDetect={onSelectMaterialAutoDetect}
              onUpdateMaterial={onUpdateMaterial}
              onWrap={onWrap}
              onMoveUp={onMoveUp}
              onMoveDown={onMoveDown}
              onMoveProcessUp={onMoveProcessUp}
              onMoveProcessDown={onMoveProcessDown}
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

// ---------- WIP tree flattening (two-pane editor) ----------
//
// The WIP editor used to render the whole tree INLINE and recursively, so each
// nesting level ate ~20px of horizontal room inside a fixed 720px dialog: by
// level 3 the inputs were ~600px wide and the CAT select was clipped to
// "CAT 3". Depth also drove four clashing background colours stacked inside
// each other.
//
// Flattening the tree lets the left pane carry the STRUCTURE (indent + a 3px
// colour bar) while the right pane edits ONE node at full width. A level-5
// node is then exactly as editable as a level-1 node.

/** One node of the WIP tree, addressed by its top-level index + child path. */
interface WipTreeRow {
  wi: number;
  path: number[];
  node: WIPComponent;
  depth: number;
  /** Stable key for selection / collapse state, e.g. "2" or "2.0.1". */
  key: string;
  hasChildren: boolean;
}

function wipRowKey(wi: number, path: number[]): string {
  return [wi, ...path].join(".");
}

/**
 * Depth-first flatten. `collapsed` keys prune their subtree from the OUTPUT
 * only — the data is untouched, so collapsing can never lose a node.
 */
function flattenWipTree(
  roots: WIPComponent[],
  collapsed: Set<string>,
): WipTreeRow[] {
  const out: WipTreeRow[] = [];
  const walk = (nodes: WIPComponent[], wi: number, path: number[], depth: number): void => {
    nodes.forEach((node, i) => {
      const nextPath = depth === 0 ? [] : [...path, i];
      const key = wipRowKey(wi, nextPath);
      const children = node.children ?? [];
      out.push({ wi, path: nextPath, node, depth, key, hasChildren: children.length > 0 });
      if (children.length > 0 && !collapsed.has(key)) {
        walk(children, wi, nextPath, depth + 1);
      }
    });
  };
  roots.forEach((root, wi) => {
    const key = wipRowKey(wi, []);
    const children = root.children ?? [];
    out.push({ wi, path: [], node: root, depth: 0, key, hasChildren: children.length > 0 });
    if (children.length > 0 && !collapsed.has(key)) {
      walk(children, wi, [], 1);
    }
  });
  return out;
}

/** Depth → the 3px accent bar. Replaces the old stacked background colours:
 *  the hierarchy still reads, but the eye isn't fighting four fills at once. */
const WIP_DEPTH_BAR = ["#3E6570", "#6B4A6D", "#B8601A", "#4F7C3A", "#9A3A2D"];
function depthBar(depth: number): string {
  return WIP_DEPTH_BAR[depth % WIP_DEPTH_BAR.length];
}

/** Resolve a node by (wi, path) — null when the path no longer exists. */
function wipNodeAt(roots: WIPComponent[], wi: number, path: number[]): WIPComponent | null {
  let node: WIPComponent | undefined = roots[wi];
  for (const i of path) {
    if (!node) return null;
    node = (node.children ?? [])[i];
  }
  return node ?? null;
}

/**
 * The RIGHT pane: one WIP node, edited at full width regardless of how deep it
 * sits. Every callback is (wi, path, …) so the same component serves a
 * top-level component and a level-5 sub-WIP identically — which is the whole
 * point of flattening the tree.
 */
function WipNodeDetail({
  node,
  wi,
  path,
  depth,
  fabricOptions,
  variantCategories,
  rawMaterials,
  onUpdate,
  onUpdateSegments,
  onAddProcess,
  onRemoveProcess,
  onUpdateProcess,
  onMoveProcess,
  onAddMaterial,
  onRemoveMaterial,
  onUpdateMaterial,
  onSelectMaterial,
  onSelectMaterialAuto,
  onAddChild,
  onRemove,
  onMove,
  onWrap,
}: {
  node: WIPComponent;
  wi: number;
  path: number[];
  depth: number;
  fabricOptions: string[];
  variantCategories: VariantCategoryInfo[];
  rawMaterials: RawMaterialOption[];
  onUpdate: (wi: number, path: number[], field: string, value: string | number | MaterialScaling[] | undefined) => void;
  onUpdateSegments: (wi: number, path: number[], segs: CodeSegment[]) => void;
  onAddProcess: (wi: number, path: number[]) => void;
  onRemoveProcess: (wi: number, path: number[], pi: number) => void;
  onUpdateProcess: (wi: number, path: number[], pi: number, field: string, value: string | number | MaterialScaling[] | undefined) => void;
  onMoveProcess: (wi: number, path: number[], pi: number, dir: -1 | 1) => void;
  onAddMaterial: (wi: number, path: number[]) => void;
  onRemoveMaterial: (wi: number, path: number[], mi: number) => void;
  onUpdateMaterial: (wi: number, path: number[], mi: number, field: string, value: string | number | MaterialScaling[] | undefined) => void;
  onSelectMaterial: (wi: number, path: number[], mi: number, rm: RawMaterialOption) => void;
  onSelectMaterialAuto: (wi: number, path: number[], mi: number, kind: "FABRIC" | "LEG") => void;
  onAddChild: (wi: number, path: number[]) => void;
  onRemove: (wi: number, path: number[]) => void;
  onMove: (wi: number, path: number[], dir: -1 | 1) => void;
  /** Wrap this sub-WIP inside a new parent. Absent for top-level nodes. */
  onWrap?: (wi: number, path: number[]) => void;
}) {
  // One grid template shared by the header row and every process row, so the
  // columns line up instead of drifting the way the old inline flex rows did.
  const procGrid = "grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_84px_28px_28px_28px] gap-2 items-center";
  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="h-5 w-[3px] shrink-0" style={{ backgroundColor: depthBar(depth) }} />
        <span className="text-[15px] font-medium text-[#111827] truncate">
          {node.wipCode || WIP_TYPE_LABELS[node.wipType]?.label || "(unnamed)"}
        </span>
        <span className="text-[11px] text-gray-400 shrink-0">
          {depth === 0 ? "level 1" : `level ${depth + 1}`}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button onClick={() => onMove(wi, path, -1)} className="px-1.5 py-1 text-xs text-gray-500 hover:bg-gray-100 rounded" title="Move up">↑</button>
          <button onClick={() => onMove(wi, path, 1)} className="px-1.5 py-1 text-xs text-gray-500 hover:bg-gray-100 rounded" title="Move down">↓</button>
          {/* Insert a NEW parent above this node — only meaningful for a
              sub-WIP, since a top-level component has no parent to wrap into. */}
          {onWrap && path.length > 0 && (
            <button
              onClick={() => onWrap(wi, path)}
              className="px-2 py-1 text-xs rounded bg-[#F1E6F0] text-[#6B4A6D] hover:bg-[#D1B7D0]"
              title="Wrap this component inside a new parent (upstream)"
            >
              + Above
            </button>
          )}
          <button onClick={() => onAddChild(wi, path)} className="px-2 py-1 text-xs rounded bg-[#E0EDF0] text-[#3E6570] hover:bg-[#A8CAD2]">+ Sub-WIP</button>
          <button onClick={() => onRemove(wi, path)} className="px-1.5 py-1 text-[#9A3A2D] hover:bg-[#F9E1DA] rounded" title="Delete">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
        </div>
      </div>

      {/* Type + quantity */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={node.wipType}
          onChange={(e) => onUpdate(wi, path, "wipType", e.target.value)}
          className="text-sm border border-[#E2DDD8] rounded px-2.5 py-1.5 bg-white"
        >
          {Object.entries(WIP_TYPE_LABELS).map(([k, v]) => (<option key={k} value={k}>{v.label}</option>))}
        </select>
        <input
          type="number"
          min={1}
          value={node.quantity}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => onUpdate(wi, path, "quantity", parseInt(e.target.value) || 1)}
          className="text-sm border border-[#E2DDD8] rounded px-2.5 py-1.5 w-20 bg-white"
        />
        <span className="text-xs text-gray-500">PCS</span>
      </div>

      {/* WIP code */}
      <div>
        <div className="text-xs font-medium text-[#6B7280] mb-1.5">WIP Code</div>
        <WIPCodeBuilder
          segments={node.codeSegments || (node.wipCode ? [{ type: "word" as const, value: node.wipCode }] : [{ type: "word" as const, value: "" }])}
          onChange={(segs) => onUpdateSegments(wi, path, segs)}
          fabricOptions={fabricOptions}
          variantCategories={variantCategories}
        />
      </div>

      {/* Processes */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-medium text-[#6B7280]">Processes</span>
          <button onClick={() => onAddProcess(wi, path)} className="text-xs text-[#3E6570] hover:underline">+ Process</button>
        </div>
        {node.processes.length === 0 ? (
          <p className="rounded border border-dashed border-[#E2DDD8] py-3 text-center text-xs text-gray-400">No processes</p>
        ) : (
          <>
            <div className={`${procGrid} px-1 pb-1 text-[11px] text-gray-400`}>
              <span>Department</span><span>Category</span><span className="text-right">Minutes</span><span /><span /><span />
            </div>
            <div className="space-y-1.5">
              {node.processes.map((p, pi) => (
                <div key={pi} className={procGrid}>
                  <select value={p.deptCode} onChange={(e) => onUpdateProcess(wi, path, pi, "deptCode", e.target.value)} className="text-sm border border-[#E2DDD8] rounded px-2 py-1.5 bg-white">
                    {DEPT_ORDER.map((d) => (<option key={d} value={d}>{DEPT_LABELS[d]}</option>))}
                  </select>
                  <select value={p.category} onChange={(e) => onUpdateProcess(wi, path, pi, "category", e.target.value)} className="text-sm border border-[#E2DDD8] rounded px-2 py-1.5 bg-white">
                    <option value="">CAT</option>
                    {getCategoryOptions().map((c) => (<option key={c} value={c}>{c}</option>))}
                  </select>
                  <span className="text-sm text-gray-700 bg-[#FAF9F7] border border-[#E2DDD8] rounded px-2 py-1.5 text-right tabular-nums">{p.minutes}</span>
                  <button onClick={() => onMoveProcess(wi, path, pi, -1)} disabled={pi === 0} className="text-xs text-gray-500 hover:bg-gray-100 rounded py-1 disabled:opacity-30" title="Move up">↑</button>
                  <button onClick={() => onMoveProcess(wi, path, pi, 1)} disabled={pi === node.processes.length - 1} className="text-xs text-gray-500 hover:bg-gray-100 rounded py-1 disabled:opacity-30" title="Move down">↓</button>
                  <button onClick={() => onRemoveProcess(wi, path, pi)} className="text-[#9A3A2D] hover:bg-[#F9E1DA] rounded py-1" title="Remove">
                    <svg className="w-3.5 h-3.5 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Raw materials */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-medium text-[#6B7280]">Raw Materials</span>
          <button onClick={() => onAddMaterial(wi, path)} className="text-xs text-[#4F7C3A] hover:underline">+ Material</button>
        </div>
        {(node.materials || []).length === 0 ? (
          <p className="rounded border border-dashed border-[#E2DDD8] py-3 text-center text-xs text-gray-400">No materials added</p>
        ) : (
          <div className="space-y-1.5">
            {(node.materials || []).map((m, mi) => (
              <div key={mi} className="rounded border border-[#E2DDD8] bg-white">
                <div className="flex flex-wrap items-center gap-2 px-2.5 py-2">
                  {m.autoDetect ? (
                    <span className="text-xs px-2 py-1 bg-[#E0EDF0] text-[#3E6570] rounded border border-[#A8CAD2] whitespace-nowrap">
                      {m.autoDetect === "FABRIC" ? "Fabric from order" : "Leg from order"}
                    </span>
                  ) : (
                    <RawMaterialSelect
                      value={m.code ? `${m.code}` : ""}
                      materials={rawMaterials}
                      onSelect={(rm) => onSelectMaterial(wi, path, mi, rm)}
                      onSelectAutoDetect={(kind) => onSelectMaterialAuto(wi, path, mi, kind)}
                    />
                  )}
                  <input type="number" onFocus={(e) => e.currentTarget.select()} value={m.qty} onChange={(e) => onUpdateMaterial(wi, path, mi, "qty", parseFloat(e.target.value) || 0)} className="text-sm border border-[#E2DDD8] rounded px-2 py-1.5 w-20" title="Quantity" />
                  <input type="number" onFocus={(e) => e.currentTarget.select()} value={m.wastePct ?? ""} onChange={(e) => onUpdateMaterial(wi, path, mi, "wastePct", parseFloat(e.target.value) || 0)} placeholder="0" title="Wastage % — cut / bulk materials (fabric / foam / wood) have offcut + defect waste; leave 0 for discrete parts (screws / legs / mechanism)" className="text-sm border border-[#E2DDD8] rounded px-2 py-1.5 w-16" />
                  <span className="text-xs text-gray-400 whitespace-nowrap">% waste</span>
                  <span className="text-xs text-gray-400">{m.unit || "PCS"}</span>
                  {materialHasKit(m) && (
                    <span className="text-xs text-[#1D4ED8] whitespace-nowrap" title="This SKU has a Component Kit — its bound screws/parts are auto-added to consumption.">+ kit</span>
                  )}
                  {isFillerMaterial(m, rawMaterials) && (
                    <span className="flex items-center gap-1 text-xs text-[#B8601A] whitespace-nowrap" title="Cut size in INCHES (length × width)">
                      cut
                      <input type="number" placeholder="L" onFocus={(e) => e.currentTarget.select()} value={m.cutLengthIn ?? ""} onChange={(e) => onUpdateMaterial(wi, path, mi, "cutLengthIn", parseFloat(e.target.value) || 0)} className="w-14 border border-[#E8B786] rounded px-1.5 py-1" />
                      ×
                      <input type="number" placeholder="W" onFocus={(e) => e.currentTarget.select()} value={m.cutWidthIn ?? ""} onChange={(e) => onUpdateMaterial(wi, path, mi, "cutWidthIn", parseFloat(e.target.value) || 0)} className="w-14 border border-[#E8B786] rounded px-1.5 py-1" />
                      in
                    </span>
                  )}
                  <button onClick={() => onRemoveMaterial(wi, path, mi)} className="ml-auto text-[#9A3A2D] hover:bg-[#F9E1DA] rounded p-1" title="Remove">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
                <MaterialScalingEditor
                  scaling={m.scaling}
                  unit={m.unit || "PCS"}
                  onChange={(s) => onUpdateMaterial(wi, path, mi, "scaling", s)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
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
  const { confirm } = useConfirm();
  const [l1Processes, setL1Processes] = useState<BOMProcess[]>([]);
  const [l1Materials, setL1Materials] = useState<WIPMaterial[]>([]);
  const [wipComponents, setWipComponents] = useState<WIPComponent[]>([]);
  const [tab, setTab] = useState<"l1" | "wip">("l1");
  // Two-pane WIP editor: the left tree owns selection + collapse, the right
  // pane edits whichever node is selected at full width.
  const [selectedWipKey, setSelectedWipKey] = useState<string | null>(null);
  const [collapsedWip, setCollapsedWip] = useState<Set<string>>(new Set());
  const [showCopyFrom, setShowCopyFrom] = useState(false);
  const [showLoadDefault, setShowLoadDefault] = useState(false);

  // Master templates (1NA / 2A(LHF) / CNR / 1S / …) loaded from localStorage.
  // Refreshed every time the dialog opens so edits made in the Master
  // Templates dialog show up immediately in the Load Default picker.
  const [masterTemplates, setMasterTemplates] = useState<MasterTemplate[]>([]);
  /* eslint-disable react-hooks/set-state-in-effect -- mirror master-template cache into local state when dialog opens */
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
  /* eslint-enable react-hooks/set-state-in-effect */

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

  // Initialize from template when opened.
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot seed of editor state when dialog opens with a template */
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
  /* eslint-enable react-hooks/set-state-in-effect */

  // Load a specific master template from the Load Default picker.
  // When masterId is null, falls back to the product-aware auto-resolver
  // (same behaviour as the old single-button Load Default).
  async function loadDefault(masterId: string | null) {
    const master = masterId ? loadMasterTemplateById(masterId) : null;
    const label = master?.label || "auto-matched";
    if (
      !(await confirm({
        title: "Load master template",
        message: `Load "${label}" master template? This will replace current L1 processes, L1 materials, and WIP components.`,
      }))
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
  async function copyFromTemplate(sourceId: string) {
    const src = allTemplates.find((t) => t.id === sourceId);
    if (!src) return;
    if (!(await confirm({ title: "Copy BOM", message: `Copy BOM from ${src.productCode}? This will replace current content.` }))) return;
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
  function updateL1Material(i: number, field: string, value: string | number | MaterialScaling[] | undefined) {
    setL1Materials((prev) => prev.map((m, idx) => (idx === i ? { ...m, [field]: value } : m)));
  }
  function selectL1Material(i: number, rm: RawMaterialOption) {
    setL1Materials((prev) =>
      prev.map((m, idx) => (idx === i ? { ...m, code: rm.itemCode, name: rm.description, unit: rm.baseUOM, inventoryCode: rm.itemCode, autoDetect: undefined } : m))
    );
  }
  function setL1MaterialAutoDetect(i: number, kind: "FABRIC" | "LEG") {
    const patch = autoDetectMaterialPatch(kind);
    setL1Materials((prev) => prev.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
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
  function updateL1Process(i: number, field: string, value: string | number | MaterialScaling[] | undefined) {
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
  function updateWIP(i: number, field: string, value: string | number | MaterialScaling[] | undefined) {
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
  function updateWIPProcess(wi: number, pi: number, field: string, value: string | number | MaterialScaling[] | undefined) {
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
  function updateWIPMaterial(wi: number, mi: number, field: string, value: string | number | MaterialScaling[] | undefined) {
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

  function updateSubWIPAtPath(wi: number, path: number[], field: string, value: string | number | MaterialScaling[] | undefined) {
    setWipComponents((prev) =>
      prev.map((w, idx) => idx !== wi ? w : updateAtPath(w, path, (node) => ({ ...node, [field]: value })))
    );
  }

  function updateSubWIPSegmentsAtPath(wi: number, path: number[], segs: CodeSegment[]) {
    setWipComponents((prev) =>
      prev.map((w, idx) => idx !== wi ? w : updateAtPath(w, path, (node) => ({ ...node, codeSegments: segs, wipCode: buildWipCode(segs) })))
    );
  }

  // --- Reordering (owner 2026-07-30: "工序要能插在中间") ---------------------
  // The editor only ever APPENDS a new process / WIP to the end of its list, so
  // to place one in the middle you add it then step it up. dir = -1 (up) / +1
  // (down); the swap is a no-op at a list boundary. All use the same
  // updateAtPath spine as every other mutation so nesting depth is irrelevant.

  // Move a process within a nested WIP node's processes[].
  function moveProcessAtPath(wi: number, path: number[], pi: number, dir: -1 | 1) {
    setWipComponents((prev) =>
      prev.map((w, idx) => idx !== wi ? w : updateAtPath(w, path, (node) => {
        const list = [...node.processes];
        const j = pi + dir;
        if (pi < 0 || pi >= list.length || j < 0 || j >= list.length) return node;
        [list[pi], list[j]] = [list[j], list[pi]];
        return { ...node, processes: list };
      }))
    );
  }
  // Move a sub-WIP among its siblings (the children[] of the node at path).
  function moveSubWIPAtPath(wi: number, path: number[], si: number, dir: -1 | 1) {
    setWipComponents((prev) =>
      prev.map((w, idx) => idx !== wi ? w : updateAtPath(w, path, (node) => {
        const list = [...(node.children || [])];
        const j = si + dir;
        if (si < 0 || si >= list.length || j < 0 || j >= list.length) return node;
        [list[si], list[j]] = [list[j], list[si]];
        return { ...node, children: list };
      }))
    );
  }
  // Wrap sibling si inside a new empty parent WIP (an upstream grouping level),
  // so a new stage can be inserted ABOVE an existing one in the hierarchy.
  function wrapSubWIPAtPath(wi: number, path: number[], si: number) {
    setWipComponents((prev) =>
      prev.map((w, idx) => idx !== wi ? w : updateAtPath(w, path, (node) => {
        const list = node.children || [];
        const target = list[si];
        if (!target) return node;
        const wrapper: WIPComponent = {
          id: `sub-wip-${Date.now()}`,
          wipCode: "",
          codeSegments: [{ type: "word" as const, value: "" }],
          wipType: (product.category === "SOFA" ? "SOFA_BASE" : "DIVAN") as WIPComponent["wipType"],
          quantity: 1,
          processes: [],
          materials: [],
          children: [target],
        };
        const next = [...list];
        next.splice(si, 1, wrapper);
        return { ...node, children: next };
      }))
    );
  }
  // Move a top-level (L1) WIP component among the roots.
  function moveWIP(wi: number, dir: -1 | 1) {
    setWipComponents((prev) => {
      const j = wi + dir;
      if (wi < 0 || wi >= prev.length || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[wi], next[j]] = [next[j], next[wi]];
      return next;
    });
  }
  // Move a process within a top-level (L1) WIP component's processes[].
  function moveWIPProcess(wi: number, pi: number, dir: -1 | 1) {
    setWipComponents((prev) =>
      prev.map((w, idx) => {
        if (idx !== wi) return w;
        const list = [...w.processes];
        const j = pi + dir;
        if (pi < 0 || pi >= list.length || j < 0 || j >= list.length) return w;
        [list[pi], list[j]] = [list[j], list[pi]];
        return { ...w, processes: list };
      })
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
        materials: (node.materials || []).map((m, i) => i === mi ? { ...m, code: rm.itemCode, name: rm.description, unit: rm.baseUOM, inventoryCode: rm.itemCode, autoDetect: undefined } : m),
      })))
    );
  }
  function setMaterialAutoDetectAtPath(wi: number, path: number[], mi: number, kind: "FABRIC" | "LEG") {
    const patch = autoDetectMaterialPatch(kind);
    setWipComponents((prev) =>
      prev.map((w, idx) => idx !== wi ? w : updateAtPath(w, path, (node) => ({
        ...node,
        materials: (node.materials || []).map((m, i) => i === mi ? { ...m, ...patch } : m),
      })))
    );
  }
  function updateMaterialAtPath(wi: number, path: number[], mi: number, field: string, value: string | number | MaterialScaling[] | undefined) {
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
  function updateProcessAtPath(wi: number, path: number[], pi: number, field: string, value: string | number | MaterialScaling[] | undefined) {
    setWipComponents((prev) =>
      prev.map((w, idx) => idx !== wi ? w : updateAtPath(w, path, (node) => ({
        ...node,
        processes: node.processes.map((p, i) => {
          if (i !== pi) return p;
          // Mirror updateWIPProcess (top-level) behavior so nested Sub-WIP
          // process edits auto-derive minutes from Production Times the same
          // way the L1 row does. Without the dept/category cases below, the
          // user changes "Category: CAT 5 -> CAT 6" inside a Sub-WIP row and
          // ONLY category mutates - minutes still display the old value, so
          // the edit looks like a no-op.
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

  // ── Depth-agnostic adapters ───────────────────────────────────────────────
  // Two parallel handler families exist: `xxxWIP(wi, …)` for top-level nodes
  // and `xxxAtPath(wi, path, …)` for nested ones. The two-pane editor renders
  // ONE detail panel for whichever node is selected, so it needs a single set
  // of callbacks; these dispatch on path depth and keep both families intact.
  const isRoot = (path: number[]): boolean => path.length === 0;

  const nUpdate = (wi: number, path: number[], field: string, value: string | number | MaterialScaling[] | undefined) =>
    isRoot(path) ? updateWIP(wi, field, value) : updateSubWIPAtPath(wi, path, field, value);
  const nUpdateSegments = (wi: number, path: number[], segs: CodeSegment[]) =>
    isRoot(path) ? updateWIPSegments(wi, segs) : updateSubWIPSegmentsAtPath(wi, path, segs);

  const nAddProcess = (wi: number, path: number[]) =>
    isRoot(path) ? addWIPProcess(wi) : addProcessAtPath(wi, path);
  const nRemoveProcess = (wi: number, path: number[], pi: number) =>
    isRoot(path) ? removeWIPProcess(wi, pi) : removeProcessAtPath(wi, path, pi);
  const nUpdateProcess = (wi: number, path: number[], pi: number, field: string, value: string | number | MaterialScaling[] | undefined) =>
    isRoot(path) ? updateWIPProcess(wi, pi, field, value) : updateProcessAtPath(wi, path, pi, field, value);
  const nMoveProcess = (wi: number, path: number[], pi: number, dir: -1 | 1) =>
    isRoot(path) ? moveWIPProcess(wi, pi, dir) : moveProcessAtPath(wi, path, pi, dir);

  const nAddMaterial = (wi: number, path: number[]) =>
    isRoot(path) ? addWIPMaterial(wi) : addMaterialAtPath(wi, path);
  const nRemoveMaterial = (wi: number, path: number[], mi: number) =>
    isRoot(path) ? removeWIPMaterial(wi, mi) : removeMaterialAtPath(wi, path, mi);
  const nUpdateMaterial = (wi: number, path: number[], mi: number, field: string, value: string | number | MaterialScaling[] | undefined) =>
    isRoot(path) ? updateWIPMaterial(wi, mi, field, value) : updateMaterialAtPath(wi, path, mi, field, value);
  const nSelectMaterial = (wi: number, path: number[], mi: number, rm: RawMaterialOption) =>
    isRoot(path) ? selectMaterial(wi, mi, rm) : selectMaterialAtPath(wi, path, mi, rm);
  const nSelectMaterialAuto = (wi: number, path: number[], mi: number, kind: "FABRIC" | "LEG") =>
    isRoot(path) ? setMaterialAutoDetect(wi, mi, kind) : setMaterialAutoDetectAtPath(wi, path, mi, kind);

  /** Remove a node wherever it sits; clears selection so the pane can't point
   *  at something that no longer exists. */
  const nRemove = (wi: number, path: number[]) => {
    if (isRoot(path)) removeWIP(wi);
    else removeSubWIPAtPath(wi, path.slice(0, -1), path[path.length - 1]);
    setSelectedWipKey(null);
  };
  const nMove = (wi: number, path: number[], dir: -1 | 1) => {
    if (isRoot(path)) moveWIP(wi, dir);
    else moveSubWIPAtPath(wi, path.slice(0, -1), path[path.length - 1], dir);
  };

  function selectMaterial(wi: number, mi: number, rm: RawMaterialOption) {
    setWipComponents((prev) =>
      prev.map((w, idx) =>
        idx === wi
          ? { ...w, materials: (w.materials || []).map((m, midx) => midx === mi ? { ...m, code: rm.itemCode, name: rm.description, unit: rm.baseUOM, inventoryCode: rm.itemCode, autoDetect: undefined } : m) }
          : w
      )
    );
  }
  function setMaterialAutoDetect(wi: number, mi: number, kind: "FABRIC" | "LEG") {
    const patch = autoDetectMaterialPatch(kind);
    setWipComponents((prev) =>
      prev.map((w, idx) =>
        idx === wi
          ? { ...w, materials: (w.materials || []).map((m, midx) => midx === mi ? { ...m, ...patch } : m) }
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
      <div className="bg-white rounded-xl shadow-xl w-[min(1160px,95vw)] max-h-[85vh] flex flex-col">
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
                        onClick={() => void loadDefault(mt.id)}
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
                        onClick={() => void copyFromTemplate(t.id)}
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
        <div className={`flex-1 min-h-0 ${tab === "wip" ? "overflow-hidden" : "overflow-y-auto px-6 py-4 space-y-4"}`}>
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
                  <div key={i} className="bg-[#EEF3E4] border border-[#C6DBA8] rounded-md">
                    <div className="flex items-center gap-2 px-3 py-2">
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
                          onSelectAutoDetect={(kind) => setL1MaterialAutoDetect(i, kind)}
                        />
                      )}
                      <input type="number" onFocus={(e) => e.currentTarget.select()} value={m.qty} onChange={(e) => updateL1Material(i, "qty", parseFloat(e.target.value) || 0)} className="text-xs border border-[#C6DBA8] rounded px-1.5 py-1 w-14 bg-white" />
                      <input type="number" onFocus={(e) => e.currentTarget.select()} value={m.wastePct ?? ""} onChange={(e) => updateL1Material(i, "wastePct", parseFloat(e.target.value) || 0)} placeholder="0" title="Wastage % — cut / bulk materials (fabric / foam / wood) have offcut + defect waste; leave 0 for discrete parts (screws / legs / mechanism)" className="text-xs border border-[#C6DBA8] rounded px-1.5 py-1 w-12 bg-white" />
                      <span className="text-[10px] text-gray-400 whitespace-nowrap" title="Wastage % — cut / bulk materials (fabric / foam / wood) have offcut + defect waste; leave 0 for discrete parts (screws / legs / mechanism)">% waste</span>
                      <span className="text-[10px] text-gray-500 w-8">{m.unit || "PCS"}</span>
                      <button onClick={() => removeL1Material(i)} className="ml-auto p-1 hover:bg-[#F9E1DA] rounded text-[#9A3A2D]">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    </div>
                    <div className="px-3 pb-1.5">
                      <MaterialScalingEditor
                        scaling={m.scaling}
                        unit={m.unit || "PCS"}
                        onChange={(s) => updateL1Material(i, "scaling", s)}
                      />
                    </div>
                  </div>
                ))}
                {l1Materials.length === 0 && (
                  <p className="text-[11px] text-gray-400 italic px-1">No L1 raw materials. Click &ldquo;+ Add Material&rdquo; or use Load Default.</p>
                )}
              </div>
            </>
          )}

          {tab === "wip" && (() => {
            // TWO-PANE (owner 2026-08-03): the tree used to render inline and
            // recursively, so every nesting level stole horizontal room from
            // the inputs — by level 3 the category select was clipped to
            // "CAT 3". Structure now lives on the LEFT and editing on the
            // RIGHT, so a level-5 node is exactly as editable as a level-1 one.
            const rows = flattenWipTree(wipComponents, collapsedWip);
            const sel = rows.find((r) => r.key === selectedWipKey) ?? rows[0] ?? null;
            const node = sel ? wipNodeAt(wipComponents, sel.wi, sel.path) : null;
            const toggle = (key: string) =>
              setCollapsedWip((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              });
            return (
              <div className="grid h-full grid-cols-[240px_minmax(0,1fr)]">
                {/* ── Structure ─────────────────────────────────────────── */}
                <div className="flex min-h-0 flex-col border-r border-[#E2DDD8] bg-[#FAF9F7]">
                  <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#E2DDD8]">
                    <span className="text-xs font-medium text-[#6B7280]">
                      WIP Components ({wipComponents.length})
                    </span>
                    <button
                      onClick={addWIPComponent}
                      className="text-xs px-2 py-1 bg-[#6B5C32] text-white rounded hover:bg-[#5A4D2A]"
                    >
                      + Add
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-2 space-y-1">
                    {rows.length === 0 && (
                      <p className="px-2 py-6 text-center text-xs text-gray-400">
                        No WIP components yet.
                      </p>
                    )}
                    {rows.map((r) => {
                      const active = sel?.key === r.key;
                      const procs = r.node.processes?.length ?? 0;
                      const mats = (r.node.materials ?? []).length;
                      return (
                        <div
                          key={r.key}
                          style={{ marginLeft: r.depth * 12, borderLeftColor: depthBar(r.depth) }}
                          className={`border-l-[3px] cursor-pointer px-2 py-1.5 ${
                            active ? "bg-white shadow-sm" : "bg-transparent hover:bg-white/60"
                          }`}
                          onClick={() => setSelectedWipKey(r.key)}
                        >
                          <div className="flex items-center gap-1.5">
                            {r.hasChildren ? (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggle(r.key);
                                }}
                                className="text-gray-400 hover:text-gray-700 leading-none"
                                aria-label={collapsedWip.has(r.key) ? "Expand" : "Collapse"}
                              >
                                {collapsedWip.has(r.key) ? "\u25B8" : "\u25BE"}
                              </button>
                            ) : (
                              <span className="w-[9px]" />
                            )}
                            <span
                              className={`truncate text-[13px] ${active ? "font-medium text-[#111827]" : "text-[#374151]"}`}
                              title={r.node.wipCode || WIP_TYPE_LABELS[r.node.wipType]?.label}
                            >
                              {r.node.wipCode || WIP_TYPE_LABELS[r.node.wipType]?.label || "(unnamed)"}
                            </span>
                          </div>
                          <div className="ml-[15px] text-[11px] text-gray-400">
                            {r.node.quantity} pcs · {procs} proc{mats > 0 ? ` · ${mats} mat` : ""}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* ── Detail ────────────────────────────────────────────── */}
                <div className="min-h-0 overflow-y-auto px-5 py-4">
                  {!node || !sel ? (
                    <p className="py-16 text-center text-sm text-gray-400">
                      Select a component on the left to edit it.
                    </p>
                  ) : (
                    <WipNodeDetail
                      node={node}
                      wi={sel.wi}
                      path={sel.path}
                      depth={sel.depth}
                      fabricOptions={fabricOptions}
                      variantCategories={productVariantCategories}
                      rawMaterials={rawMaterials}
                      onUpdate={nUpdate}
                      onUpdateSegments={nUpdateSegments}
                      onAddProcess={nAddProcess}
                      onRemoveProcess={nRemoveProcess}
                      onUpdateProcess={nUpdateProcess}
                      onMoveProcess={nMoveProcess}
                      onAddMaterial={nAddMaterial}
                      onRemoveMaterial={nRemoveMaterial}
                      onUpdateMaterial={nUpdateMaterial}
                      onSelectMaterial={nSelectMaterial}
                      onSelectMaterialAuto={nSelectMaterialAuto}
                      onAddChild={(wi, path) => addSubWIPAtPath(wi, path)}
                      onRemove={nRemove}
                      onMove={nMove}
                      onWrap={(wi, path) =>
                        wrapSubWIPAtPath(wi, path.slice(0, -1), path[path.length - 1])
                      }
                    />
                  )}
                </div>
              </div>
            );
          })()}
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
  const { confirm } = useConfirm();
  const [tab, setTab] = useState<BOMCategory>("BEDFRAME");
  // We now keep a LIST of master templates per category. Bedframes typically
  // have one ("Default"), sofas can have many — one per module type
  // (1NA, 2A(LHF), L(RHF), CNR, 1S, ...). selectedId tracks which template
  // in the list is currently being edited.
  const [bedframeList, setBedframeList] = useState<MasterTemplate[]>(() => [buildFallbackMasterTemplate("BEDFRAME")]);
  const [sofaList, setSofaList] = useState<MasterTemplate[]>(() => [buildFallbackMasterTemplate("SOFA")]);
  const [accessoryList, setAccessoryList] = useState<MasterTemplate[]>(() => [buildFallbackMasterTemplate("ACCESSORY")]);
  const [selectedBedframeId, setSelectedBedframeId] = useState<string>("BEDFRAME");
  const [selectedSofaId, setSelectedSofaId] = useState<string>("SOFA");
  const [selectedAccessoryId, setSelectedAccessoryId] = useState<string>("ACCESSORY");
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
    : tab === "SOFA"
    ? [
        { category: "PRODUCT_CODE", label: "Product Code" },
        { category: "MODEL", label: "Model" },
        { category: "SEAT_SIZE", label: "Seat Size" },
        { category: "MODULE", label: "Module" },
        { category: "FABRIC", label: "Fabric" },
        { category: "SPECIAL", label: "Special" },
      ]
    : [
        // ACCESSORY — pillows etc.; minimal variant set.
        { category: "PRODUCT_CODE", label: "Product Code" },
        { category: "SIZE", label: "Size" },
        { category: "FABRIC", label: "Fabric" },
      ];

  /* eslint-disable react-hooks/set-state-in-effect -- mirror master-template cache + seed default selection when edit dialog opens */
  useEffect(() => {
    if (!open) return;
    const load = () => {
      const bf = loadAllMasterTemplates("BEDFRAME");
      const sf = loadAllMasterTemplates("SOFA");
      const ac = loadAllMasterTemplates("ACCESSORY");
      setBedframeList(bf);
      setSofaList(sf);
      setAccessoryList(ac);
      setSelectedBedframeId(
        (prev) => prev || bf.find((t) => t.isDefault)?.id || bf[0]?.id || "BEDFRAME",
      );
      setSelectedSofaId(
        (prev) => prev || sf.find((t) => t.isDefault)?.id || sf[0]?.id || "SOFA",
      );
      setSelectedAccessoryId(
        (prev) => prev || ac.find((t) => t.isDefault)?.id || ac[0]?.id || "ACCESSORY",
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
  /* eslint-enable react-hooks/set-state-in-effect */

  const currentList =
    tab === "BEDFRAME" ? bedframeList : tab === "SOFA" ? sofaList : accessoryList;
  const setCurrentList =
    tab === "BEDFRAME" ? setBedframeList : tab === "SOFA" ? setSofaList : setAccessoryList;
  const selectedId =
    tab === "BEDFRAME" ? selectedBedframeId : tab === "SOFA" ? selectedSofaId : selectedAccessoryId;
  const setSelectedId =
    tab === "BEDFRAME" ? setSelectedBedframeId : tab === "SOFA" ? setSelectedSofaId : setSelectedAccessoryId;
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
      label: tab === "SOFA" ? "New Module" : tab === "ACCESSORY" ? "New Accessory" : "New Variant",
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
    // eslint-disable-next-line react-hooks/purity -- timestamp ID generation; only invoked from a click handler, never during render
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
  async function deleteTemplate() {
    if (!current || current.isDefault) {
      toast.warning("Cannot delete the default template for this category.");
      return;
    }
    const ok = await confirm({
      title: "Delete master template?",
      message: `Delete master template "${current.label}"? This cannot be undone after Save.`,
      danger: true,
    });
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
  function moveL1Process(i: number, dir: -1 | 1) {
    setCurrent((prev) => {
      const list = [...prev.l1Processes];
      const j = i + dir;
      if (i < 0 || i >= list.length || j < 0 || j >= list.length) return prev;
      [list[i], list[j]] = [list[j], list[i]];
      return { ...prev, l1Processes: list };
    });
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

  function makeEmptyWIP(category: BOMCategory): WIPComponent {
    // Accessory has no canonical WIP type — fall back to SOFA_BASE just as a
    // neutral placeholder if a user adds a WIP to an accessory master template.
    const wipType = (
      category === "BEDFRAME" ? "DIVAN"
      : category === "SOFA" ? "SOFA_BASE"
      : "SOFA_BASE"
    ) as WIPComponent["wipType"];
    // Seed default code segments: {PRODUCT_CODE from order} + WIP-type word
    // (e.g. "DIVAN", "HEADBOARD"). The user can then add size / heights /
    // fabric segments as needed.
    const typeLabel = WIP_TYPE_LABELS[wipType]?.label || wipType;
    const codeSegments: CodeSegment[] = [
      { type: "variant", variantCategory: "PRODUCT_CODE", value: "", autoDetect: true },
      { type: "word", value: typeLabel },
    ];
    return {
      // eslint-disable-next-line react-hooks/purity -- WIP id generation; only invoked from addWIP click handler, never during render
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
  // 删除 WIP — 把它的 children 提升到它原本的位置（不级联删除下游）
  function removeWIP(wi: number) {
    setCurrent((prev) => {
      const target = prev.wipItems[wi];
      if (!target) return prev;
      const next = [...prev.wipItems];
      next.splice(wi, 1, ...(target.children || []));
      return { ...prev, wipItems: next };
    });
  }
  // 把 wi 这个 WIP 包进一个新的空 WIP（成为它的上游 / 父节点）
  function wrapWIPAt(idx: number) {
    setCurrent((prev) => {
      const target = prev.wipItems[idx];
      if (!target) return prev;
      const wrapper: WIPComponent = { ...makeEmptyWIP(prev.category), children: [target] };
      const next = [...prev.wipItems];
      next.splice(idx, 1, wrapper);
      return { ...prev, wipItems: next };
    });
  }
  function moveWIPUp(wi: number) {
    if (wi <= 0) return;
    setCurrent((prev) => {
      const next = [...prev.wipItems];
      [next[wi - 1], next[wi]] = [next[wi], next[wi - 1]];
      return { ...prev, wipItems: next };
    });
  }
  function moveWIPDown(wi: number) {
    setCurrent((prev) => {
      if (wi < 0 || wi >= prev.wipItems.length - 1) return prev;
      const next = [...prev.wipItems];
      [next[wi], next[wi + 1]] = [next[wi + 1], next[wi]];
      return { ...prev, wipItems: next };
    });
  }
  function mutateWIP(wi: number, path: number[], updater: (w: WIPComponent) => WIPComponent) {
    setCurrent((prev) => ({
      ...prev,
      wipItems: prev.wipItems.map((w, idx) => idx === wi ? updateAtPath(w, path, updater) : w),
    }));
  }

  function updateWIPAtPath(wi: number, path: number[], field: string, value: string | number | MaterialScaling[] | undefined) {
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
  // 删除 sub-WIP — 把被删节点的 children 提升到它原本的位置（不级联删除下游）
  function removeSubWIPAtPath(wi: number, path: number[], si: number) {
    mutateWIP(wi, path, (node) => {
      const list = node.children || [];
      const target = list[si];
      if (!target) return node;
      const next = [...list];
      next.splice(si, 1, ...(target.children || []));
      return { ...node, children: next };
    });
  }
  // 把 si 这个 sub-WIP 包进一个新的空 WIP（成为它的上游 / 父节点）
  function wrapSubWIPAtPath(wi: number, path: number[], si: number) {
    mutateWIP(wi, path, (node) => {
      const list = node.children || [];
      const target = list[si];
      if (!target) return node;
      const wrapper: WIPComponent = { ...makeEmptyWIP(current.category), children: [target] };
      const next = [...list];
      next.splice(si, 1, wrapper);
      return { ...node, children: next };
    });
  }
  function moveSubWIPUpAtPath(wi: number, path: number[], si: number) {
    if (si <= 0) return;
    mutateWIP(wi, path, (node) => {
      const next = [...(node.children || [])];
      if (si >= next.length) return node;
      [next[si - 1], next[si]] = [next[si], next[si - 1]];
      return { ...node, children: next };
    });
  }
  function moveSubWIPDownAtPath(wi: number, path: number[], si: number) {
    mutateWIP(wi, path, (node) => {
      const list = node.children || [];
      if (si < 0 || si >= list.length - 1) return node;
      const next = [...list];
      [next[si], next[si + 1]] = [next[si + 1], next[si]];
      return { ...node, children: next };
    });
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
  // Reorder a process within a nested WIP node (owner 2026-07-30: insert-in-middle).
  function moveProcessAtPath(wi: number, path: number[], pi: number, dir: -1 | 1) {
    mutateWIP(wi, path, (node) => {
      const list = [...node.processes];
      const j = pi + dir;
      if (pi < 0 || pi >= list.length || j < 0 || j >= list.length) return node;
      [list[pi], list[j]] = [list[j], list[pi]];
      return { ...node, processes: list };
    });
  }
  function updateProcessAtPath(wi: number, path: number[], pi: number, field: string, value: string | number | MaterialScaling[] | undefined) {
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
  function updateMaterialAtPath(wi: number, path: number[], mi: number, field: string, value: string | number | MaterialScaling[] | undefined) {
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

  async function handleSave() {
    const now = new Date().toISOString();
    // Persist every template in all lists, plus pending deletions. We await
    // every PUT/DELETE so an HTTP failure surfaces as a real error toast
    // instead of silently dropping writes (the in-memory cache would lie to
    // the next synchronous read until page reload).
    const saves = [...bedframeList, ...sofaList, ...accessoryList].map((t) =>
      saveMasterTemplate({ ...t, updatedAt: now }),
    );
    const deletes = deletedIds.map((id) => deleteMasterTemplateById(id));
    try {
      await Promise.all([...saves, ...deletes]);
    } catch (err) {
      toast.error(
        `Failed to save master templates: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    setEditMode(false);
    toast.success(
      `Master templates saved — Bedframe: ${bedframeList.length}, Sofa: ${sofaList.length}, Accessory: ${accessoryList.length}` +
      (deletedIds.length > 0 ? `, Deleted: ${deletedIds.length}` : "")
    );
    onClose();
  }

  async function handleReset() {
    if (!current) return;
    const ok = await confirm({
      title: "Clear template?",
      message:
        `Clear template "${current.label}"?\n\n` +
        `This will empty all L1 processes, L1 materials, and WIP items.\n` +
        `(Changes are only persisted after you click "Save Templates".)`,
      danger: true,
    });
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
            <button
              onClick={() => setTab("ACCESSORY")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md ${tab === "ACCESSORY" ? "bg-[#6B5C32] text-white" : "bg-[#FAF9F7] text-gray-600 hover:bg-[#E2DDD8]"}`}
            >
              Accessory
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
                      Copy into <span className="text-[#6B5C32] font-semibold">{tab === "BEDFRAME" ? "Bedframe" : tab === "SOFA" ? "Sofa" : "Accessory"}</span> from…
                    </div>
                    {(["BEDFRAME", "SOFA", "ACCESSORY"] as const).map((cat) => {
                      const list = cat === "BEDFRAME" ? bedframeList : cat === "SOFA" ? sofaList : accessoryList;
                      if (list.length === 0) return null;
                      return (
                        <div key={cat}>
                          <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-gray-400">
                            {cat === "BEDFRAME" ? "Bedframe templates" : cat === "SOFA" ? "Sofa templates" : "Accessory templates"}
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
              placeholder={tab === "SOFA" ? "matches Product.sizeCode (e.g. 1A(LHF))" : tab === "ACCESSORY" ? "(optional — accessory sub-type)" : "(leave blank — used as fallback)"}
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
                  <button onClick={() => moveL1Process(i, -1)} disabled={i === 0} className="ml-auto text-xs px-1.5 py-0.5 bg-white border border-[#E8D597] text-[#9C6F1E] rounded hover:bg-[#FAEFCB] disabled:opacity-30 disabled:cursor-not-allowed" title="Move process up">↑</button>
                  <button onClick={() => moveL1Process(i, 1)} disabled={i === current.l1Processes.length - 1} className="text-xs px-1.5 py-0.5 bg-white border border-[#E8D597] text-[#9C6F1E] rounded hover:bg-[#FAEFCB] disabled:opacity-30 disabled:cursor-not-allowed" title="Move process down">↓</button>
                  <button onClick={() => removeL1Process(i)} className="p-1 hover:bg-[#F9E1DA] rounded text-[#9A3A2D]">
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
                  <input type="number" onFocus={(e) => e.currentTarget.select()} value={m.qty} onChange={(e) => updateL1Material(i, "qty", parseFloat(e.target.value) || 0)} className="text-xs border border-[#C6DBA8] rounded px-1.5 py-1 w-14 bg-white" />
                  <input type="number" onFocus={(e) => e.currentTarget.select()} value={m.wastePct ?? ""} onChange={(e) => updateL1Material(i, "wastePct", parseFloat(e.target.value) || 0)} placeholder="0" title="Wastage % — cut / bulk materials (fabric / foam / wood) have offcut + defect waste; leave 0 for discrete parts (screws / legs / mechanism)" className="text-xs border border-[#C6DBA8] rounded px-1.5 py-1 w-12 bg-white" />
                  <span className="text-[10px] text-gray-400 whitespace-nowrap" title="Wastage % — cut / bulk materials (fabric / foam / wood) have offcut + defect waste; leave 0 for discrete parts (screws / legs / mechanism)">% waste</span>
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
                    <input type="number" onFocus={(e) => e.currentTarget.select()} value={w.quantity} onChange={(e) => updateWIPAtPath(wi, [], "quantity", parseInt(e.target.value) || 1)} className="text-sm border border-[#A8CAD2] rounded px-2 py-1 w-16 bg-white" min={1} />
                    <span className="text-xs text-gray-500">PCS</span>
                    <button
                      onClick={() => wrapWIPAt(wi)}
                      className="ml-auto text-[10px] px-1.5 py-0.5 bg-[#A8CAD2] text-[#3E6570] rounded hover:bg-[#8FB4BD]"
                      title="Wrap this WIP inside a new parent (upstream)"
                    >
                      + Above
                    </button>
                    <button
                      onClick={() => moveWIPUp(wi)}
                      disabled={wi === 0}
                      className="text-[10px] px-1.5 py-0.5 bg-[#A8CAD2] text-[#3E6570] rounded hover:bg-[#8FB4BD] disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Move up"
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => moveWIPDown(wi)}
                      disabled={wi === current.wipItems.length - 1}
                      className="text-[10px] px-1.5 py-0.5 bg-[#A8CAD2] text-[#3E6570] rounded hover:bg-[#8FB4BD] disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Move down"
                    >
                      ↓
                    </button>
                    <button onClick={() => removeWIP(wi)} className="p-1 hover:bg-[#F9E1DA] rounded text-[#9A3A2D]">
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
                    <div key={mi} className="bg-white rounded">
                      <div className="flex items-center gap-2 px-2 py-1.5">
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
                        <input type="number" onFocus={(e) => e.currentTarget.select()} value={m.qty} onChange={(e) => updateMaterialAtPath(wi, [], mi, "qty", parseFloat(e.target.value) || 0)} className="text-xs border border-gray-200 rounded px-1.5 py-1 w-14" />
                        <input type="number" onFocus={(e) => e.currentTarget.select()} value={m.wastePct ?? ""} onChange={(e) => updateMaterialAtPath(wi, [], mi, "wastePct", parseFloat(e.target.value) || 0)} placeholder="0" title="Wastage % — cut / bulk materials (fabric / foam / wood) have offcut + defect waste; leave 0 for discrete parts (screws / legs / mechanism)" className="text-xs border border-gray-200 rounded px-1.5 py-1 w-12" />
                        <span className="text-[10px] text-gray-400 whitespace-nowrap" title="Wastage % — cut / bulk materials (fabric / foam / wood) have offcut + defect waste; leave 0 for discrete parts (screws / legs / mechanism)">% waste</span>
                        <span className="text-[10px] text-gray-400 w-8">{m.unit || "PCS"}</span>
                        <button onClick={() => removeMaterialAtPath(wi, [], mi)} className="text-[#9A3A2D] hover:text-[#7A2E24]">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                      <MaterialScalingEditor
                        scaling={m.scaling}
                        unit={m.unit || "PCS"}
                        onChange={(s) => updateMaterialAtPath(wi, [], mi, "scaling", s)}
                      />
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
                    onSelectMaterialAutoDetect={(path, mi, kind) => setMaterialAutoDetectAtPath(wi, path, mi, kind)}
                    onUpdateMaterial={(path, mi, field, value) => updateMaterialAtPath(wi, path, mi, field, value)}
                    onWrap={(path, si) => wrapSubWIPAtPath(wi, path, si)}
                    onMoveUp={(path, si) => moveSubWIPUpAtPath(wi, path, si)}
                    onMoveDown={(path, si) => moveSubWIPDownAtPath(wi, path, si)}
                    onMoveProcessUp={(path, pi) => moveProcessAtPath(wi, path, pi, -1)}
                    onMoveProcessDown={(path, pi) => moveProcessAtPath(wi, path, pi, 1)}
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

// ---------- Production Times ----------
// The inline Production Times matrix DIALOG was removed 2026-08-01 per owner —
// the dedicated WIP Times module is the single place those minutes are edited
// now. The read-side lookup (getProductionMinutes, near the top of this file)
// is untouched: BOM process rows still auto-fill minutes from the same
// variants-config matrix when a category is picked.

// Sample variant context for token resolution in catalog-level views. There is
// no SO line driving variant values here, so we fall back to the same defaults
// `buildWipCodeDisplay` uses for the BOM Structure tree (DIVAN_HEIGHT=8",
// LEG_HEIGHT=2"). Product fields override where present.
function buildSampleVariantCtx(p: Product | undefined, t: BOMTemplate): BomVariantContext {
  return {
    productCode: p?.code || t.productCode,
    model: p?.baseModel || t.baseModel,
    sizeLabel: p?.sizeLabel || (t.category === "SOFA" ? "3-Seater" : "6FT"),
    sizeCode: p?.sizeCode || "",
    fabricCode: "PC151-01",
    divanHeightInches: 8,
    legHeightInches: 2,
    gapInches: 0,
  };
}

// ---------- RawMaterial Batch Editor Dialog ----------
// Per-row inline-edit UX (was previously paired with Batch Edit Categories,
// which got removed 2026-04-29). For raw materials across every WIP step
// in every BOM template.
//
// SCOPE: this dialog manages WHAT raw materials each WIP step consumes —
// not HOW MUCH (qty stays untouched, owned by the per-BOM Edit dialog and
// the dimension-scaling formula coming later). So it only edits material
// code (and the unit/name that ride along with the chosen material) plus
// row deletion.
//
// Each row = one (template, WIP step, materialIndex) tuple. Bulk operations:
//   • Replace material in selected rows (skips autoDetect rows)
//   • Delete selected rows (queued — applied on Save)
//
// Persistence: dirty rows are grouped by templateId, each template's
// wipComponents JSON is mutated locally, then PUT /api/bom/templates/:id
// is called per template. We don't have a bulk-material-edit endpoint yet
// (the existing bulk-process-edit only handles processes); per-template
// PUTs run in parallel, which is fine for the tens-to-low-hundreds dirty
// templates this UI realistically produces.
type MatRow = {
  rowKey: string;
  templateId: string;
  productCode: string;
  baseModel: string;
  bomCategory: BOMCategory;
  // Path through wipComponents to the WIP node owning this material.
  // Always non-empty (top-level WIP at minimum). Materials don't live on
  // L1 like processes do.
  path: number[];
  wipType: WIPComponent["wipType"];
  wipLabel: string;
  // Distinct dept codes pulled off this WIP step's processes[]. Used by
  // the "filter by department" dropdown so the user can pick e.g. FAB_CUT
  // and see every WIP step that goes through Fab Cut.
  deptCodes: string[];
  // Index into the WIP node's materials[] for existing rows. -1 for
  // placeholder + isNew rows (those don't exist on the server yet).
  matIndex: number;
  // Placeholder rows are emitted once per WIP step regardless of whether
  // it has materials, so the user can click "+ Add material" and stamp a
  // new material entry into that step. Placeholder rows are never dirty
  // and are skipped on save.
  isPlaceholder: boolean;
  // Newly-added rows (created by clicking + on a placeholder) get
  // appended to the WIP's materials[] on save instead of mutating an
  // existing index.
  isNew: boolean;
  // Initial values captured when rows were built — used to compute dirtiness
  // and to roll back via Discard Changes.
  initialCode: string;
  initialName: string;
  initialUnit: string;
  initialQty: number;
  // Live (possibly edited) values.
  code: string;
  name: string;
  unit: string;
  qty: number;
  // Scaling rules — currently editable in this dialog ONLY for newly-added
  // rows (isNew=true). Existing rows render qty/scaling as readonly to
  // preserve the dialog's primary "batch replace material" semantic
  // (mass-changing per-row qty across N BOMs is rarely what the user
  // wants — that flow lives in the per-BOM Edit dialog instead).
  scaling?: MaterialScaling[];
  inventoryCode?: string;
  autoDetect?: "FABRIC" | "LEG";
  toDelete: boolean;
};

function buildMatRows(
  templates: BOMTemplate[],
  products: Product[] = [],
): MatRow[] {
  const rows: MatRow[] = [];
  // Mirror DeptPivot's wipLabel resolution path so {DIVAN_HEIGHT}/{SIZE}/etc.
  // tokens render as "8" Divan-6FT" instead of the literal template (BUG
  // 2026-04-29 — user reported "WIP names are different" because the raw
  // wipCode template was leaking through to the UI). Same `buildSampleVariantCtx`
  // helper used by `buildDeptPivotRows` so the two dialogs read identically.
  const productByCode = new Map(products.map((p) => [p.code, p]));
  function walk(t: BOMTemplate, w: WIPComponent, path: number[]) {
    const rawLabel =
      w.wipCode || WIP_TYPE_LABELS[w.wipType]?.label || w.wipType;
    const ctx = buildSampleVariantCtx(productByCode.get(t.productCode), t);
    const wipLabel = resolveWipTokens(rawLabel, ctx) || rawLabel;
    const deptCodes = Array.from(
      new Set(
        (w.processes || [])
          .map((p) => p.deptCode)
          .filter((d): d is string => Boolean(d)),
      ),
    );
    (w.materials || []).forEach((m, mi) => {
      rows.push({
        rowKey: `${t.id}|${path.join("-")}|${mi}`,
        templateId: t.id,
        productCode: t.productCode,
        baseModel: t.baseModel,
        bomCategory: t.category,
        path: [...path],
        wipType: w.wipType,
        wipLabel,
        deptCodes,
        matIndex: mi,
        isPlaceholder: false,
        isNew: false,
        initialCode: m.code || "",
        initialName: m.name || "",
        initialUnit: m.unit || "PCS",
        initialQty: m.qty || 0,
        code: m.code || "",
        name: m.name || "",
        unit: m.unit || "PCS",
        qty: m.qty || 0,
        scaling: normaliseScaling(m.scaling),
        inventoryCode: m.inventoryCode,
        autoDetect: m.autoDetect,
        toDelete: false,
      });
    });
    // Always emit one placeholder per WIP step so the user can add a
    // (possibly first) material to it. Hidden when the active material
    // filter is non-empty (an empty WIP step has no material to match).
    rows.push({
      rowKey: `${t.id}|${path.join("-")}|+`,
      templateId: t.id,
      productCode: t.productCode,
      baseModel: t.baseModel,
      bomCategory: t.category,
      path: [...path],
      wipType: w.wipType,
      wipLabel,
      deptCodes,
      matIndex: -1,
      isPlaceholder: true,
      isNew: false,
      initialCode: "",
      initialName: "",
      initialUnit: "",
      initialQty: 0,
      code: "",
      name: "",
      unit: "",
      qty: 0,
      toDelete: false,
    });
    (w.children || []).forEach((c, ci) => walk(t, c, [...path, ci]));
  }
  for (const t of templates) {
    t.wipComponents.forEach((w, wi) => walk(t, w, [wi]));
  }
  return rows;
}

function isRowDirty(r: MatRow): boolean {
  if (r.isPlaceholder) return false;
  if (r.toDelete) return true;
  if (r.isNew) return true;
  // Qty is NOT considered — see SCOPE note above. Material identity
  // (code / name / unit ride together via RawMaterialSelect) is what we
  // track here.
  return (
    r.code !== r.initialCode ||
    r.name !== r.initialName ||
    r.unit !== r.initialUnit
  );
}

function BatchEditMaterialsDialog({
  open,
  onClose,
  templates,
  rawMaterials,
  products,
  onTemplatesUpdated,
}: {
  open: boolean;
  onClose: () => void;
  templates: BOMTemplate[];
  rawMaterials: RawMaterialOption[];
  // Threaded through so buildMatRows can resolve {DIVAN_HEIGHT}/{SIZE}
  // tokens via buildSampleVariantCtx, same path DeptPivot uses.
  products: Product[];
  onTemplatesUpdated: (updated: BOMTemplate[]) => void;
}) {
  const { toast } = useToast();
  const [rows, setRows] = useState<MatRow[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [searchText, setSearchText] = useState("");
  // Defer searchText so the filter useMemo doesn't re-run on every keystroke.
  // Input itself stays controlled by `searchText`; filtering uses `searchTextDeferred`.
  const searchTextDeferred = useDeferredValue(searchText);
  const [filterCategory, setFilterCategory] = useState<"ALL" | BOMCategory>("ALL");
  const [filterWipType, setFilterWipType] = useState<string>("");
  // Default Department to the first one (Fab Cut) so the dialog opens
  // already scoped — same UX as DeptPivot. Otherwise an empty default
  // dumps all 3563 rows on the user with no useful starting point.
  const [filterDept, setFilterDept] = useState<string>(DEPT_ORDER[0]);
  // Model filter (productCode dropdown), mirrors DeptPivot's modelFilter.
  const [filterModel, setFilterModel] = useState<string>("");
  // Multi-select: when empty, no material filter; otherwise rows whose
  // material `code` is in the set are kept.
  const [filterMaterials, setFilterMaterials] = useState<Set<string>>(new Set());
  const [materialFilterOpen, setMaterialFilterOpen] = useState(false);
  const [bulkMaterial, setBulkMaterial] = useState<RawMaterialOption | null>(null);
  const [saving, setSaving] = useState(false);
  // Monotonic counter so each "+ Add material" click produces a unique
  // rowKey for the new row (rowKey collisions break React reconciliation
  // and the dirty/selected Sets).
  const newRowCounterRef = React.useRef(0);

  /* eslint-disable react-hooks/set-state-in-effect -- reset dialog state on each open */
  useEffect(() => {
    if (!open) return;
    setRows(buildMatRows(templates, products));
    setSelectedKeys(new Set());
    setSearchText("");
    setFilterCategory("ALL");
    setFilterWipType("");
    // Default Department to first one — same as the initial useState. Reset
    // here on every open so re-opening doesn't carry the previous session's
    // selection.
    setFilterDept(DEPT_ORDER[0]);
    setFilterModel("");
    setFilterMaterials(new Set());
    setMaterialFilterOpen(false);
    setBulkMaterial(null);
    setSaving(false);
    newRowCounterRef.current = 0;
  }, [open, templates, products]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const dirtyCount = useMemo(() => rows.filter(isRowDirty).length, [rows]);
  const dirtyTemplateCount = useMemo(() => {
    const ids = new Set<string>();
    for (const r of rows) if (isRowDirty(r)) ids.add(r.templateId);
    return ids.size;
  }, [rows]);

  // Distinct WIP types / dept codes / material codes — for filters. WIP
  // types and dept codes come from EVERY row (including placeholders) so
  // the dropdowns surface every WIP step the user has, even ones that
  // have no materials yet. Material codes only come from non-placeholder
  // rows since you can't filter by something that doesn't exist.
  const wipTypeOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) s.add(r.wipType);
    return Array.from(s).sort();
  }, [rows]);

  const deptCodeOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) for (const d of r.deptCodes) s.add(d);
    // Preserve canonical DEPT_ORDER for the ones we know; tack any unknown
    // dept codes on at the end so we don't silently drop them.
    const known = DEPT_ORDER.filter((d) => s.has(d));
    const extra = Array.from(s)
      .filter((d) => !DEPT_ORDER.includes(d as (typeof DEPT_ORDER)[number]))
      .sort();
    return [...known, ...extra];
  }, [rows]);

  const materialCodeOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) {
      if (r.isPlaceholder) continue;
      if (r.code) s.add(r.code);
    }
    return Array.from(s).sort();
  }, [rows]);

  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (filterCategory !== "ALL" && r.bomCategory !== filterCategory) return false;
      if (filterWipType && r.wipType !== filterWipType) return false;
      if (filterDept && !r.deptCodes.includes(filterDept)) return false;
      if (filterModel && r.productCode !== filterModel) return false;
      // Material multi-select: when set, drop rows that don't match. Also
      // drop placeholder rows (they have no material code to compare —
      // showing them when filtering for specific materials would be noise).
      if (filterMaterials.size > 0) {
        if (r.isPlaceholder) return false;
        if (!filterMaterials.has(r.code)) return false;
      }
      if (searchTextDeferred.trim()) {
        const q = searchTextDeferred.toLowerCase();
        if (
          !r.productCode.toLowerCase().includes(q) &&
          !r.baseModel.toLowerCase().includes(q) &&
          !r.code.toLowerCase().includes(q) &&
          !r.name.toLowerCase().includes(q) &&
          !r.wipLabel.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [rows, filterCategory, filterWipType, filterDept, filterModel, filterMaterials, searchTextDeferred]);

  // Distinct model dropdown options — derived from full row set so the
  // option list is stable when other filters narrow the visible rows.
  const modelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.productCode) set.add(r.productCode);
    return Array.from(set).sort();
  }, [rows]);

  const allFilteredSelected =
    filteredRows.length > 0 && filteredRows.every((r) => selectedKeys.has(r.rowKey));

  function toggleAllFiltered() {
    if (allFilteredSelected) {
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        for (const r of filteredRows) next.delete(r.rowKey);
        return next;
      });
    } else {
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        for (const r of filteredRows) next.add(r.rowKey);
        return next;
      });
    }
  }

  function toggleOne(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function updateRow(key: string, changes: Partial<MatRow>) {
    setRows((prev) => prev.map((r) => (r.rowKey === key ? { ...r, ...changes } : r)));
  }

  function selectMaterialForRow(key: string, rm: RawMaterialOption) {
    updateRow(key, {
      code: rm.itemCode,
      name: rm.description,
      unit: rm.baseUOM,
      inventoryCode: rm.itemCode,
      autoDetect: undefined,
    });
  }

  // Convert an existing concrete row to "from SO" (autoDetect). Reuses the
  // same patch shape the per-BOM editor uses so the material's serialized
  // form ends up identical regardless of which dialog the user clicked
  // through to author it.
  function setRowAutoDetect(key: string, kind: "FABRIC" | "LEG") {
    const patch = autoDetectMaterialPatch(kind);
    updateRow(key, {
      autoDetect: patch.autoDetect,
      code: patch.code ?? "",
      name: patch.name ?? "",
      unit: patch.unit ?? "PCS",
      inventoryCode: patch.inventoryCode,
    });
  }

  // Build a "new material" row from a placeholder. Inserts BEFORE the
  // placeholder in the rows array so the placeholder stays parked at the
  // bottom of its WIP step, ready to accept another addition.
  function addMaterialFromPlaceholder(
    placeholderKey: string,
    rm: RawMaterialOption,
  ) {
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.rowKey === placeholderKey);
      if (idx < 0) return prev;
      const ph = prev[idx];
      if (!ph.isPlaceholder) return prev;
      const counter = ++newRowCounterRef.current;
      const newRow: MatRow = {
        ...ph,
        rowKey: `${ph.rowKey}~new${counter}`,
        matIndex: -1,
        isPlaceholder: false,
        isNew: true,
        code: rm.itemCode,
        name: rm.description,
        unit: rm.baseUOM,
        inventoryCode: rm.itemCode,
        autoDetect: undefined,
        qty: 1,
        scaling: undefined,
        initialCode: "",
        initialName: "",
        initialUnit: "",
        initialQty: 0,
        toDelete: false,
      };
      return [...prev.slice(0, idx), newRow, ...prev.slice(idx)];
    });
  }

  // Same as addMaterialFromPlaceholder but stamps autoDetect (FABRIC/LEG)
  // instead of a concrete inventory pick. The qty default is 1 in the
  // unit the autoDetect kind canonically uses (MTR for fabric, PCS for
  // leg). qty + scaling are now editable inline on the new row (Wei Siang
  // 2026-05-05 — having to flip to the per-BOM Edit dialog just to set
  // qty was a real two-step pain).
  function addAutoDetectFromPlaceholder(
    placeholderKey: string,
    kind: "FABRIC" | "LEG",
  ) {
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.rowKey === placeholderKey);
      if (idx < 0) return prev;
      const ph = prev[idx];
      if (!ph.isPlaceholder) return prev;
      const counter = ++newRowCounterRef.current;
      const patch = autoDetectMaterialPatch(kind);
      const newRow: MatRow = {
        ...ph,
        rowKey: `${ph.rowKey}~new${counter}`,
        matIndex: -1,
        isPlaceholder: false,
        isNew: true,
        code: patch.code ?? "",
        name: patch.name ?? "",
        unit: patch.unit ?? "PCS",
        inventoryCode: patch.inventoryCode,
        autoDetect: patch.autoDetect,
        qty: 1,
        scaling: undefined,
        initialCode: "",
        initialName: "",
        initialUnit: "",
        initialQty: 0,
        toDelete: false,
      };
      return [...prev.slice(0, idx), newRow, ...prev.slice(idx)];
    });
  }

  // Inline updaters for qty + scaling on newly-added rows. These don't
  // touch existing (non-isNew) rows to keep batch-replace semantics
  // intact — qty/scaling for already-saved materials still live in the
  // per-BOM Edit dialog.
  function updateNewRowQty(rowKey: string, qty: number) {
    setRows((prev) =>
      prev.map((r) =>
        r.rowKey === rowKey && r.isNew ? { ...r, qty } : r,
      ),
    );
  }
  function updateNewRowScaling(
    rowKey: string,
    scaling: MaterialScaling[] | undefined,
  ) {
    setRows((prev) =>
      prev.map((r) =>
        r.rowKey === rowKey && r.isNew ? { ...r, scaling } : r,
      ),
    );
  }

  // Toggle delete on a row. New (isNew) rows are simply removed from the
  // local array since they have no server-side counterpart to mark.
  function toggleRowDelete(key: string) {
    setRows((prev) => {
      const r = prev.find((row) => row.rowKey === key);
      if (!r) return prev;
      if (r.isNew) {
        // Drop unsaved row entirely.
        setSelectedKeys((sel) => {
          if (!sel.has(key)) return sel;
          const next = new Set(sel);
          next.delete(key);
          return next;
        });
        return prev.filter((row) => row.rowKey !== key);
      }
      return prev.map((row) =>
        row.rowKey === key ? { ...row, toDelete: !row.toDelete } : row,
      );
    });
  }

  function targetsForBulk(): MatRow[] {
    if (selectedKeys.size > 0) {
      return filteredRows.filter((r) => selectedKeys.has(r.rowKey));
    }
    return filteredRows;
  }

  // Bulk apply — does the right thing per row type:
  //   • placeholder → add a new material to that WIP step
  //   • autoDetect  → skip (Fabric/Leg from order can't be replaced)
  //   • regular     → replace the existing material
  function bulkReplaceMaterial() {
    if (!bulkMaterial) {
      toast.warning("Pick a material first.");
      return;
    }
    const targets = targetsForBulk();
    if (targets.length === 0) {
      toast.warning("No rows to apply to.");
      return;
    }
    const targetKeys = new Set(targets.map((r) => r.rowKey));
    let replaced = 0;
    let added = 0;
    let skipped = 0;
    setRows((prev) => {
      const out: MatRow[] = [];
      for (const r of prev) {
        if (!targetKeys.has(r.rowKey)) {
          out.push(r);
          continue;
        }
        if (r.isPlaceholder) {
          const counter = ++newRowCounterRef.current;
          out.push({
            ...r,
            rowKey: `${r.rowKey}~new${counter}`,
            matIndex: -1,
            isPlaceholder: false,
            isNew: true,
            code: bulkMaterial.itemCode,
            name: bulkMaterial.description,
            unit: bulkMaterial.baseUOM,
            inventoryCode: bulkMaterial.itemCode,
            qty: 1,
            initialCode: "",
            initialName: "",
            initialUnit: "",
            initialQty: 0,
            toDelete: false,
          });
          out.push(r); // keep placeholder for next add
          added++;
        } else if (r.autoDetect) {
          out.push(r);
          skipped++;
        } else {
          out.push({
            ...r,
            code: bulkMaterial.itemCode,
            name: bulkMaterial.description,
            unit: bulkMaterial.baseUOM,
            inventoryCode: bulkMaterial.itemCode,
          });
          replaced++;
        }
      }
      return out;
    });
    const parts: string[] = [];
    if (replaced > 0) parts.push(`replaced ${replaced}`);
    if (added > 0) parts.push(`added ${added}`);
    if (skipped > 0) parts.push(`${skipped} skipped (auto-detect)`);
    toast.success(`${parts.join(" · ") || "no-op"}. Click Save to persist.`);
  }

  function bulkToggleDelete(markDeleted: boolean) {
    if (selectedKeys.size === 0) {
      toast.warning("Select rows first.");
      return;
    }
    let touched = 0;
    let dropped = 0;
    setRows((prev) => {
      const out: MatRow[] = [];
      for (const r of prev) {
        if (!selectedKeys.has(r.rowKey)) {
          out.push(r);
          continue;
        }
        if (r.isPlaceholder) {
          out.push(r); // can't delete a placeholder
          continue;
        }
        if (r.isNew && markDeleted) {
          // Drop unsaved new row entirely.
          dropped++;
          continue;
        }
        out.push({ ...r, toDelete: markDeleted });
        touched++;
      }
      return out;
    });
    if (dropped > 0) {
      // Clear those rowKeys from selection too — they no longer exist.
      setSelectedKeys((sel) => {
        const next = new Set(sel);
        for (const k of sel) {
          if (!rows.find((r) => r.rowKey === k && (r.isPlaceholder || (!r.isNew)))) {
            next.delete(k);
          }
        }
        return next;
      });
    }
    const verb = markDeleted ? "Marked" : "Restored";
    const dropMsg = dropped > 0 ? `, dropped ${dropped} unsaved` : "";
    toast.success(`${verb} ${touched} row${touched !== 1 ? "s" : ""}${dropMsg}.`);
  }

  function discardChanges() {
    setRows(buildMatRows(templates, products));
    setSelectedKeys(new Set());
    toast.info("Discarded all changes.");
  }

  async function handleSave() {
    if (dirtyCount === 0) {
      toast.warning("No changes to save.");
      return;
    }
    setSaving(true);
    try {
      // Group dirty rows by templateId.
      const dirtyByTpl = new Map<string, MatRow[]>();
      for (const r of rows) {
        if (!isRowDirty(r)) continue;
        const arr = dirtyByTpl.get(r.templateId);
        if (arr) arr.push(r);
        else dirtyByTpl.set(r.templateId, [r]);
      }

      const tplById = new Map(templates.map((t) => [t.id, t] as const));
      const updatedClones: BOMTemplate[] = [];
      const failed: string[] = [];

      function getNode(
        tree: WIPComponent[],
        path: number[],
      ): WIPComponent | null {
        if (path.length === 0) return null;
        let node: WIPComponent | undefined = tree[path[0]];
        for (let i = 1; i < path.length && node; i++) {
          node = node.children?.[path[i]];
        }
        return node || null;
      }

      const ops = Array.from(dirtyByTpl.entries()).map(async ([tplId, edits]) => {
        const t = tplById.get(tplId);
        if (!t) {
          failed.push(tplId);
          return;
        }
        // Deep-clone the WIP tree so we don't mutate state until the PUT
        // succeeds.
        const clone: BOMTemplate = {
          ...t,
          wipComponents: JSON.parse(
            JSON.stringify(t.wipComponents),
          ) as WIPComponent[],
        };
        // Order matters because matIndex shifts as we mutate the array:
        //   1. updates  — mutate in place, no shift
        //   2. deletes  — by descending matIndex (later indices first so
        //                 earlier ones stay valid)
        //   3. inserts  — append to materials[]; new materials don't have
        //                 a stable matIndex anyway
        const updates = edits.filter((e) => !e.toDelete && !e.isNew);
        const deletes = edits
          .filter((e) => e.toDelete && !e.isNew)
          .sort((a, b) => b.matIndex - a.matIndex);
        const inserts = edits.filter((e) => e.isNew && !e.toDelete);

        for (const e of updates) {
          const node = getNode(clone.wipComponents, e.path);
          if (!node || !node.materials || !node.materials[e.matIndex]) continue;
          const m = node.materials[e.matIndex];
          // Always sync identity (code / name / unit) AND autoDetect from
          // the row. Two flows hit this:
          //   1. concrete → concrete (replace material): autoDetect stays
          //      undefined on both sides, identity rewritten.
          //   2. concrete → "from SO" autoDetect: row carries autoDetect
          //      kind + cleared code/inventoryCode + name="Fabric (from
          //      order)". Stamping autoDetect lets the cascade resolver
          //      pick up the SO-bound substitution.
          // Qty is intentionally NOT touched — see SCOPE note at top.
          m.code = e.code;
          m.name = e.name;
          m.unit = e.unit;
          m.autoDetect = e.autoDetect;
          m.inventoryCode = e.autoDetect ? undefined : e.inventoryCode;
        }
        for (const e of deletes) {
          const node = getNode(clone.wipComponents, e.path);
          if (!node || !node.materials) continue;
          node.materials.splice(e.matIndex, 1);
        }
        for (const e of inserts) {
          const node = getNode(clone.wipComponents, e.path);
          if (!node) continue;
          if (!node.materials) node.materials = [];
          node.materials.push({
            code: e.code,
            name: e.name,
            unit: e.unit,
            qty: e.qty,
            // Persist scaling rules captured inline in the dialog (Wei
            // Siang 2026-05-05). Empty / undefined scaling stays absent
            // so the WIPMaterial JSON shape isn't bloated.
            scaling: e.scaling && e.scaling.length > 0 ? e.scaling : undefined,
            inventoryCode: e.autoDetect ? undefined : e.inventoryCode,
            autoDetect: e.autoDetect,
          });
        }

        try {
          const res = await fetch(
            `/api/bom/templates/${encodeURIComponent(tplId)}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(clone),
            },
          );
          const json = (await res.json().catch(() => null)) as
            | { success?: boolean; error?: string }
            | null;
          if (!res.ok || !json?.success) {
            failed.push(tplId);
          } else {
            updatedClones.push(clone);
          }
        } catch {
          failed.push(tplId);
        }
      });

      await Promise.all(ops);

      const cloneById = new Map(updatedClones.map((c) => [c.id, c] as const));
      if (updatedClones.length > 0) {
        const next = templates.map((t) => cloneById.get(t.id) || t);
        onTemplatesUpdated(next);
        invalidateCachePrefix("/api/bom");
      }

      const okCount = updatedClones.length;
      if (failed.length === 0) {
        toast.success(
          `Saved ${okCount} BOM template${okCount !== 1 ? "s" : ""}.`,
        );
        onClose();
      } else {
        toast.warning(
          `Saved ${okCount}; ${failed.length} failed. Dialog stays open — re-edit the failed BOMs and save again.`,
        );
        // Note: onTemplatesUpdated above propagates the succeeded clones
        // back to the parent; the dialog's open-effect rebuilds rows from
        // the new templates prop on next render. Failed templates revert
        // to their server state too — their unsaved edits are lost. This
        // is a known limitation of the per-template PUT model; the user
        // sees which BOMs failed via the toast and can retry.
      }
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-[920px] max-w-[95vw] max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-[#E2DDD8]">
          <h2 className="text-lg font-bold text-[#111827]">
            Batch Edit Raw Materials
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Filter → replace, add, or delete materials. Each WIP step has a
            "+" row at the end to add a new material. Auto-detect rows
            (Fabric/Leg from order) can only be deleted.
          </p>
        </div>

        {/* Body */}
        <div className="px-6 py-4 overflow-y-auto flex-1 space-y-4">
          {/* Filters */}
          <div className="bg-[#FAF9F7] rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium text-gray-500 uppercase tracking-wider">
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"/></svg>
              Filter
            </div>
            <div className="grid grid-cols-6 gap-2">
              <input
                type="text"
                placeholder="Search BOM / material..."
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                className="border border-[#E2DDD8] rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-[#6B5C32] bg-white"
              />
              <select
                value={filterCategory}
                onChange={(e) =>
                  setFilterCategory(e.target.value as "ALL" | BOMCategory)
                }
                className="border border-[#E2DDD8] rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-[#6B5C32] bg-white"
              >
                <option value="ALL">All Categories</option>
                <option value="BEDFRAME">Bedframe</option>
                <option value="SOFA">Sofa</option>
                <option value="ACCESSORY">Accessory</option>
              </select>
              <select
                value={filterWipType}
                onChange={(e) => setFilterWipType(e.target.value)}
                className="border border-[#E2DDD8] rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-[#6B5C32] bg-white"
              >
                <option value="">All WIP Types</option>
                {wipTypeOptions.map((w) => (
                  <option key={w} value={w}>
                    {WIP_TYPE_LABELS[w]?.label || w}
                  </option>
                ))}
              </select>
              <select
                value={filterDept}
                onChange={(e) => setFilterDept(e.target.value)}
                className="border border-[#E2DDD8] rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-[#6B5C32] bg-white"
                title="Department is required — pick one to scope the rows. Mirrors DeptPivot's UX."
              >
                {/* No "All Departments" option per user 2026-04-29 — opening
                    the dialog with no scope dumped 3000+ rows and was unusable.
                    The dialog defaults to DEPT_ORDER[0] (Fab Cut). */}
                {deptCodeOptions.map((d) => (
                  <option key={d} value={d}>
                    {DEPT_LABELS[d] || d}
                  </option>
                ))}
              </select>
              <select
                value={filterModel}
                onChange={(e) => setFilterModel(e.target.value)}
                className="border border-[#E2DDD8] rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-[#6B5C32] bg-white"
                title="Filter rows to a single Model (productCode)."
              >
                <option value="">All Models</option>
                {modelOptions.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              {/* Multi-select material filter — opens a checkbox popover. */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setMaterialFilterOpen((v) => !v)}
                  className="w-full text-left border border-[#E2DDD8] rounded-lg px-2 py-1.5 text-sm bg-white hover:bg-gray-50 flex items-center justify-between gap-1"
                >
                  <span className="truncate">
                    {filterMaterials.size === 0
                      ? "All Materials"
                      : filterMaterials.size === 1
                      ? Array.from(filterMaterials)[0]
                      : `${filterMaterials.size} materials`}
                  </span>
                  <svg className="w-3 h-3 flex-shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {materialFilterOpen && (
                  <div className="absolute z-20 mt-1 w-[260px] right-0 max-h-[260px] overflow-y-auto bg-white border border-[#E2DDD8] rounded-lg shadow-lg p-1.5 space-y-0.5">
                    <div className="flex items-center justify-between px-1 py-1 border-b border-[#E2DDD8]">
                      <span className="text-[10px] text-gray-500 uppercase tracking-wider">
                        {filterMaterials.size} selected
                      </span>
                      <div className="flex items-center gap-2">
                        {filterMaterials.size > 0 && (
                          <button
                            onClick={() => setFilterMaterials(new Set())}
                            className="text-[10px] text-[#9A3A2D] hover:underline"
                          >
                            Clear
                          </button>
                        )}
                        <button
                          onClick={() => setMaterialFilterOpen(false)}
                          className="text-[10px] text-gray-500 hover:underline"
                        >
                          Close
                        </button>
                      </div>
                    </div>
                    {materialCodeOptions.length === 0 && (
                      <p className="text-xs text-gray-400 p-2 text-center">
                        No material codes in any BOM yet.
                      </p>
                    )}
                    {materialCodeOptions.map((c) => {
                      const checked = filterMaterials.has(c);
                      return (
                        <label
                          key={c}
                          className={`flex items-center gap-2 px-2 py-1 rounded text-xs cursor-pointer ${
                            checked ? "bg-[#EEF3E4]" : "hover:bg-[#FAF9F7]"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setFilterMaterials((prev) => {
                                const next = new Set(prev);
                                if (next.has(c)) next.delete(c);
                                else next.add(c);
                                return next;
                              });
                            }}
                            className="rounded border-gray-300 text-[#6B5C32] focus:ring-[#6B5C32]"
                          />
                          <span className="font-mono truncate">{c}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            {(searchText ||
              filterCategory !== "ALL" ||
              filterWipType ||
              filterDept !== DEPT_ORDER[0] ||
              filterModel ||
              filterMaterials.size > 0) && (
              <button
                onClick={() => {
                  setSearchText("");
                  setFilterCategory("ALL");
                  setFilterWipType("");
                  // Department is required — reset to default, NOT empty.
                  setFilterDept(DEPT_ORDER[0]);
                  setFilterModel("");
                  setFilterMaterials(new Set());
                }}
                className="text-xs text-gray-500 hover:text-[#9A3A2D] flex items-center gap-1"
              >
                <span>✕</span> Clear filters
              </button>
            )}
          </div>

          {/* Bulk-fill bar */}
          <div className="flex flex-wrap items-end gap-2 border border-[#E2DDD8] rounded-lg p-3 bg-[#FFF8E7]">
            <div className="flex-1 min-w-[220px]">
              <label className="block text-[10px] font-medium text-gray-700 mb-0.5">
                Replace material in {selectedKeys.size > 0 ? `${selectedKeys.size} selected` : `${filteredRows.length} visible`}
              </label>
              <div className="flex items-center gap-1">
                <RawMaterialSelect
                  value={bulkMaterial?.itemCode || ""}
                  materials={rawMaterials}
                  onSelect={(rm) => setBulkMaterial(rm)}
                />
                <button
                  onClick={bulkReplaceMaterial}
                  disabled={!bulkMaterial}
                  className="px-2 py-1 text-xs bg-[#6B5C32] text-white rounded hover:bg-[#5A4D2A] disabled:opacity-40"
                >
                  Apply
                </button>
              </div>
            </div>
            <div className="flex items-end gap-1">
              <button
                onClick={() => bulkToggleDelete(true)}
                disabled={selectedKeys.size === 0}
                className="px-2 py-1 text-xs bg-[#9A3A2D] text-white rounded hover:bg-[#7A2E24] disabled:opacity-40"
                title="Mark selected rows for deletion"
              >
                Delete selected
              </button>
              <button
                onClick={() => bulkToggleDelete(false)}
                disabled={selectedKeys.size === 0}
                className="px-2 py-1 text-xs bg-white border border-[#E2DDD8] rounded hover:bg-gray-50 disabled:opacity-40"
                title="Unmark deletion on selected rows"
              >
                Restore
              </button>
            </div>
          </div>

          {/* Row counter / select-all / discard */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-700">
              <span className="font-semibold">{dirtyCount}</span> dirty ·{" "}
              <span className="font-semibold">{selectedKeys.size}</span> selected ·
              Showing {filteredRows.length} of {rows.length}
            </span>
            <div className="flex items-center gap-3">
              <button
                onClick={toggleAllFiltered}
                className="text-xs text-[#6B5C32] hover:underline font-medium"
              >
                {allFilteredSelected
                  ? `Deselect ${filteredRows.length}`
                  : `Select ${filteredRows.length} filtered`}
              </button>
              {selectedKeys.size > 0 && (
                <button
                  onClick={() => setSelectedKeys(new Set())}
                  className="text-xs text-[#9A3A2D] hover:underline"
                >
                  Clear selection
                </button>
              )}
              {dirtyCount > 0 && (
                <button
                  onClick={discardChanges}
                  className="text-xs text-[#9A3A2D] hover:underline"
                >
                  Discard changes
                </button>
              )}
            </div>
          </div>

          {/* Rows */}
          <div className="border border-[#E2DDD8] rounded-lg overflow-hidden">
            <div className="grid grid-cols-[28px_minmax(110px,1fr)_minmax(110px,1fr)_minmax(220px,2fr)_70px_50px_28px] gap-2 px-3 py-2 bg-[#FAF9F7] text-[10px] font-medium text-gray-500 uppercase tracking-wider border-b border-[#E2DDD8]">
              <span></span>
              <span>BOM</span>
              <span>WIP Step</span>
              <span>Material</span>
              <span className="text-right">Qty</span>
              <span>Unit</span>
              <span></span>
            </div>
            <div className="max-h-[360px] overflow-y-auto">
              {filteredRows.length === 0 && (
                <p className="text-sm text-gray-400 p-4 text-center">
                  {rows.length === 0
                    ? "No BOM templates loaded."
                    : "No rows match the current filters."}
                </p>
              )}
              {/* Per-WIP-step material count, used to label the placeholder
                  row "+ Add another material" instead of "+ Select material..."
                  when at least one material is already present. Helps the
                  operator realize the placeholder is persistent — they can
                  keep clicking it to add more rows to the same WIP step. */}
              {(() => null)()}
              {filteredRows.map((r) => {
                const isSelected = selectedKeys.has(r.rowKey);
                const dirty = isRowDirty(r);
                const wipColor = WIP_TYPE_LABELS[r.wipType]?.color || "#6B7280";
                // Count non-placeholder, non-deleted siblings in the same
                // (templateId, path) bucket — drives the "Add another"
                // language on the placeholder row.
                const siblingMaterialCount = r.isPlaceholder
                  ? rows.filter(
                      (x) =>
                        !x.isPlaceholder &&
                        !x.toDelete &&
                        x.templateId === r.templateId &&
                        x.path.length === r.path.length &&
                        x.path.every((seg, i) => seg === r.path[i]),
                    ).length
                  : 0;
                const rowTone = r.isPlaceholder
                  ? "bg-[#FAF9F7]/40 hover:bg-[#FAF9F7]"
                  : r.toDelete
                  ? "bg-[#F9E1DA] line-through text-gray-400"
                  : r.isNew
                  ? "bg-[#EEF3E4]"
                  : dirty
                  ? "bg-[#EEF3E4]"
                  : isSelected
                  ? "bg-[#FAEFCB]/60"
                  : "hover:bg-[#FAF9F7]";
                return (
                  <React.Fragment key={r.rowKey}>
                  <div
                    className={`grid grid-cols-[28px_minmax(110px,1fr)_minmax(110px,1fr)_minmax(220px,2fr)_70px_50px_28px] gap-2 px-3 py-1.5 items-center border-b border-[#E2DDD8] last:border-b-0 text-xs ${rowTone}`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOne(r.rowKey)}
                      className="rounded border-gray-300 text-[#6B5C32] focus:ring-[#6B5C32]"
                    />
                    <div className="min-w-0 truncate">
                      <span className="font-medium text-[#111827]">
                        {r.productCode}
                      </span>
                      <span className="ml-1 text-[10px] text-gray-400">
                        {r.baseModel}
                      </span>
                    </div>
                    <div
                      className="px-1.5 py-0.5 rounded text-[10px] font-medium truncate inline-block max-w-full"
                      style={{
                        backgroundColor: `${wipColor}20`,
                        color: wipColor,
                      }}
                      title={r.wipLabel}
                    >
                      {r.wipLabel}
                    </div>
                    {r.isPlaceholder ? (
                      <div className="flex items-center gap-1">
                        <span
                          className="text-[10px] text-[#4F7C3A] font-medium pl-1 pr-1 whitespace-nowrap"
                          title={
                            siblingMaterialCount > 0
                              ? "Click again to add another material — the + row is persistent"
                              : "Pick a material to add it to this WIP step."
                          }
                        >
                          {siblingMaterialCount > 0 ? "+ Add another" : "+"}
                        </span>
                        <RawMaterialSelect
                          value=""
                          materials={rawMaterials}
                          onSelect={(rm) => addMaterialFromPlaceholder(r.rowKey, rm)}
                          onSelectAutoDetect={(kind) => addAutoDetectFromPlaceholder(r.rowKey, kind)}
                        />
                      </div>
                    ) : r.autoDetect ? (
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] px-1.5 py-0.5 bg-[#E0EDF0] text-[#3E6570] rounded font-medium border border-[#A8CAD2] whitespace-nowrap">
                          {r.autoDetect === "FABRIC"
                            ? "Fabric from order"
                            : "Leg from order"}
                        </span>
                      </div>
                    ) : (
                      <RawMaterialSelect
                        value={r.code}
                        materials={rawMaterials}
                        onSelect={(rm) => selectMaterialForRow(r.rowKey, rm)}
                        onSelectAutoDetect={(kind) => setRowAutoDetect(r.rowKey, kind)}
                      />
                    )}
                    {r.isNew ? (
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={r.qty}
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) =>
                          updateNewRowQty(
                            r.rowKey,
                            parseFloat(e.target.value) || 0,
                          )
                        }
                        className="text-right text-xs border border-[#C6DBA8] rounded px-1.5 py-1 w-full bg-white tabular-nums"
                        title="Qty per FG (scaling rules below stack on top)"
                      />
                    ) : (
                      <span
                        className="text-right text-xs text-gray-500 tabular-nums px-1.5 py-1"
                        title={
                          r.isPlaceholder
                            ? "Pick a material to add it to this WIP step."
                            : "Qty for existing materials is managed in the per-BOM Edit dialog (this dialog is for batch replace / add / delete)."
                        }
                      >
                        {r.isPlaceholder ? "—" : r.qty}
                      </span>
                    )}
                    <span className="text-[10px] text-gray-500">
                      {r.isPlaceholder ? "" : r.unit}
                    </span>
                    {r.isPlaceholder ? (
                      <span className="w-3.5 h-3.5" />
                    ) : (
                      <button
                        onClick={() => toggleRowDelete(r.rowKey)}
                        className="text-[#9A3A2D] hover:text-[#7A2E24]"
                        title={
                          r.isNew
                            ? "Discard this unsaved row"
                            : r.toDelete
                            ? "Restore"
                            : "Delete"
                        }
                      >
                        {r.toDelete ? (
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 12a9 9 0 0118 0M3 12a9 9 0 009 9M3 12l3-3m0 6l-3-3" />
                          </svg>
                        ) : (
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        )}
                      </button>
                    )}
                  </div>
                  {/* Inline scaling editor for new rows. Reuses the same
                      <MaterialScalingEditor> the per-BOM Edit dialog uses,
                      so the rule shape + UX are identical. Skipped on
                      delete-flagged rows (no point editing what's about
                      to be deleted). */}
                  {r.isNew && !r.toDelete && (
                    <div className={`px-3 pb-1.5 ${rowTone} border-b border-[#E2DDD8]`}>
                      <MaterialScalingEditor
                        scaling={r.scaling}
                        unit={r.unit}
                        onChange={(next) => updateNewRowScaling(r.rowKey, next)}
                      />
                    </div>
                  )}
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[#E2DDD8] flex items-center justify-between">
          <span className="text-xs text-gray-500">
            {dirtyCount > 0
              ? `Will save ${dirtyCount} edit${dirtyCount !== 1 ? "s" : ""} across ${dirtyTemplateCount} BOM${dirtyTemplateCount !== 1 ? "s" : ""}`
              : "Edit rows or use Bulk fill above."}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm border border-[#E2DDD8] rounded-lg text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={dirtyCount === 0 || saving}
              className="px-4 py-2 text-sm bg-[#6B5C32] text-white rounded-lg hover:bg-[#5A4D2A] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving
                ? "Saving..."
                : `Save ${dirtyCount} Change${dirtyCount !== 1 ? "s" : ""}`}
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
  const [products, setProducts] = useState<Product[]>([]);
  const [templates, setTemplates] = useState<BOMTemplate[]>([]);
  const [rawMaterials, setRawMaterials] = useState<RawMaterialOption[]>([]);
  const [fabricOptions, setFabricOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedProductCode, setSelectedProductCode] = useState<string>("");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<"ALL" | BOMCategory>("ALL");
  // Pending-only filter: toggled by clicking the "N pending BOM" badge.
  // When true, the product list filters down to products that don't yet
  // have a BOM template (i.e. code not in `existingCodes`).
  const [pendingOnly, setPendingOnly] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const navigate = useNavigate();
  const [showMaster, setShowMaster] = useState(false);
  const [showBatchEditMat, setShowBatchEditMat] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const [pData, tData, invData, kitData] = await Promise.all([
          cachedFetchJson<{ success?: boolean; data?: unknown }>("/api/products"),
          cachedFetchJson<{ success?: boolean; data?: unknown }>("/api/bom/templates"),
          cachedFetchJson<{ success?: boolean; data?: { rawMaterials?: unknown[] } }>("/api/inventory"),
          cachedFetchJson<{ success?: boolean; data?: { parentCode?: string }[] }>("/api/component-boms"),
        ]);

        // Populate the reusable-kit hint set (module-level; see materialHasKit).
        if (kitData && kitData.success && Array.isArray(kitData.data)) {
          KIT_PARENT_CODES.clear();
          for (const k of kitData.data) {
            if (k?.parentCode) KIT_PARENT_CODES.add(k.parentCode);
          }
        }

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
      const json = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
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
    if (pendingOnly) {
      list = list.filter((p) => !existingCodes.has(p.code));
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
  }, [products, categoryFilter, search, pendingOnly, existingCodes]);

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
  // Pick ACTIVE first, then any version sorted by effectiveFrom DESC.
  // Mirrors src/api/routes/_shared/production-builder.ts (the path job_cards
  // are built from). Without this filter, when a product carries a parallel
  // DRAFT v2.0 alongside its live v1.0, `find` would return whichever row
  // came first in the unsorted list — so the BOM tree could render CAT 6 /
  // 40m off the DRAFT while job_cards (and Production Sheet) correctly show
  // CAT 2 / 80m off the ACTIVE row. The Dept-Pivot dialog already filters
  // to ACTIVE-only (see comment at the activeOnly filter); this brings the
  // BOM tree + EditBOMDialog selection in line with the rest of the system.
  const selectedTemplate = useMemo(() => {
    const matches = templates.filter((t) => t.productCode === selectedProductCode);
    if (matches.length === 0) return null;
    const active = matches.filter((t) => (t.versionStatus ?? "ACTIVE") === "ACTIVE");
    const pool = active.length > 0 ? active : matches;
    // Most recent effectiveFrom wins. Empty/missing strings sort last so a
    // freshly-flipped DRAFT->ACTIVE row beats the legacy ACTIVE row.
    return [...pool].sort((a, b) => {
      const af = a.effectiveFrom || "";
      const bf = b.effectiveFrom || "";
      if (af === bf) return 0;
      if (!af) return 1;
      if (!bf) return -1;
      return bf.localeCompare(af);
    })[0] || null;
  }, [templates, selectedProductCode]);

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
            <button
              type="button"
              onClick={() => setPendingOnly((v) => !v)}
              title={pendingOnly ? "Clear pending-only filter" : "Show only products without a BOM template"}
              aria-pressed={pendingOnly}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors border ${
                pendingOnly
                  ? "bg-[#9C6F1E] border-[#9C6F1E] text-white ring-2 ring-[#9C6F1E]/30"
                  : "bg-[#FAEFCB] border-[#E8D597] text-[#9C6F1E] hover:bg-[#F6E4A4]"
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${pendingOnly ? "bg-white" : "bg-[#9C6F1E] animate-pulse"}`} />
              <span className="text-sm font-medium">{pendingCount} pending BOM</span>
              {pendingOnly && (
                <span className="text-[10px] uppercase tracking-wide opacity-80">filter on</span>
              )}
            </button>
          )}
          {/* Export / Import BOM CSV buttons removed 2026-04-28 per user
              request - inline editors (RawMaterial Batch Editor +
              Production Categories Editor) cover the spreadsheet round-trip
              use case directly. Batch Edit Categories button removed
              2026-04-29 per user — Production Categories Editor covers it. */}
          <button
            onClick={() => setShowBatchEditMat(true)}
            title="Batch edit raw materials (qty / replace / delete) across every BOM's WIP steps"
            className="flex items-center gap-2 px-3 py-2 bg-white border border-[#E2DDD8] rounded-lg text-sm text-gray-700 hover:bg-[#FAF9F7]"
          >
            <svg className="w-4 h-4 text-[#4F7C3A]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
            RawMaterial Batch Editor
          </button>
          {/* Production Categories Editor + Production Times buttons removed
              2026-08-01 per owner — the dedicated WIP Times module covers both
              use cases, so these BOM-local duplicates were redundant surface.
              The Production Times LOOKUP (getProductionTimes) is untouched:
              BOM process rows still auto-fill minutes from that matrix. */}
          <button
            onClick={() => navigate("/bom/component-kits")}
            title="Component Kits — bind a mechanism / leg SKU to the screws it always needs"
            className="flex items-center gap-2 px-3 py-2 bg-white border border-[#E2DDD8] rounded-lg text-sm text-gray-700 hover:bg-[#FAF9F7]"
          >
            <svg className="w-4 h-4 text-[#6B5C32]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
            </svg>
            Component Kits
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
      <BatchEditMaterialsDialog
        open={showBatchEditMat}
        onClose={() => setShowBatchEditMat(false)}
        templates={templates}
        rawMaterials={rawMaterials}
        products={products}
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
              {(["ALL", "BEDFRAME", "SOFA", "ACCESSORY"] as const).map((cat) => (
                <button
                  key={cat}
                  onClick={() => setCategoryFilter(cat)}
                  className={`flex-1 px-2 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    categoryFilter === cat
                      ? "bg-[#6B5C32] text-white"
                      : "bg-[#FAF9F7] text-gray-600 hover:bg-[#E2DDD8]"
                  }`}
                >
                  {cat === "ALL" ? "All" : cat === "BEDFRAME" ? "Bedframe" : cat === "SOFA" ? "Sofa" : "Accessory"}
                </button>
              ))}
            </div>
            {pendingOnly && (
              <div className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-[#FAEFCB] border border-[#E8D597] text-[11px] text-[#9C6F1E]">
                <span>Showing {filteredProducts.length} pending</span>
                <button
                  type="button"
                  onClick={() => setPendingOnly(false)}
                  className="text-[10px] uppercase tracking-wide hover:underline"
                >
                  Clear
                </button>
              </div>
            )}
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
                      category: selectedProduct.category as BOMCategory,
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
                      category: selectedProduct.category as BOMCategory,
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
