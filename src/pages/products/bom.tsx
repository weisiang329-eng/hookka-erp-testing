import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { useParams } from "react-router-dom";
import { cachedFetchJson } from "@/lib/cached-fetch";

// ---------- Types ----------
// Mirrors the master BOMTemplate shape exposed by /api/bom/templates.
// Kept local to this page so we don't couple to mock-data imports.
type BOMProcess = {
  dept: string;
  deptCode: string;
  category: string;
  minutes: number;
};

type WIPMaterial = {
  code?: string;
  name?: string;
  qty: number;
  unit: string;
  inventoryCode?: string;
  autoDetect?: "FABRIC" | "LEG";
};

type CodeSegment = {
  type: "word" | "variant";
  variantCategory?: string;
  value: string;
  autoDetect?: boolean;
};

type WIPType =
  | "HEADBOARD"
  | "DIVAN"
  | "SOFA_BASE"
  | "SOFA_CUSHION"
  | "SOFA_ARMREST"
  | "SOFA_HEADREST";

type WIPComponent = {
  id: string;
  wipCode: string;
  codeSegments?: CodeSegment[];
  wipType: WIPType;
  quantity: number;
  processes: BOMProcess[];
  materials?: WIPMaterial[];
  children?: WIPComponent[];
};

type BOMVersionStatus = "DRAFT" | "ACTIVE" | "OBSOLETE";

type BOMTemplate = {
  id: string;
  productCode: string;
  baseModel: string;
  category: "BEDFRAME" | "SOFA";
  l1Processes: BOMProcess[];
  l1Materials?: WIPMaterial[];
  wipComponents: WIPComponent[];
  version: string;
  versionStatus: BOMVersionStatus;
  effectiveFrom: string;
  effectiveTo?: string;
  changeLog?: string;
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

const DEPT_ORDER = [
  "FAB_CUT",
  "FAB_SEW",
  "WOOD_CUT",
  "FOAM",
  "FRAMING",
  "WEBBING",
  "UPHOLSTERY",
  "PACKING",
];

const WIP_TYPE_LABELS: Record<WIPType, { label: string; color: string }> = {
  HEADBOARD: { label: "Headboard", color: "#7C3AED" },
  DIVAN: { label: "Divan", color: "#0891B2" },
  SOFA_BASE: { label: "Sofa Base", color: "#059669" },
  SOFA_CUSHION: { label: "Back Cushion", color: "#D97706" },
  SOFA_ARMREST: { label: "Sofa Armrest", color: "#DC2626" },
  SOFA_HEADREST: { label: "Sofa Headrest", color: "#7C3AED" },
};

// Level color palette — mirrors the /bom editor so this read-only view
// lines up visually with what the user sees when they push master templates.
const WIP_LEVEL_COLORS = [
  { container: "bg-[#E0EDF0] border-[#A8CAD2]", badge: "bg-[#A8CAD2] text-[#3E6570]", divider: "border-[#A8CAD2]/60", title: "text-[#3E6570]" },
  { container: "bg-[#F1E6F0] border-[#D1B7D0]", badge: "bg-[#D1B7D0] text-[#6B4A6D]", divider: "border-[#D1B7D0]/60", title: "text-[#6B4A6D]" },
  { container: "bg-[#FBE4CE] border-[#E8B786]", badge: "bg-[#E8B786] text-[#B8601A]", divider: "border-[#E8B786]/60", title: "text-[#B8601A]" },
  { container: "bg-[#EEF3E4] border-[#C6DBA8]", badge: "bg-[#C6DBA8] text-[#4F7C3A]", divider: "border-[#C6DBA8]/60", title: "text-[#4F7C3A]" },
  { container: "bg-[#F9E1DA] border-[#E8B2A1]", badge: "bg-[#E8B2A1] text-[#9A3A2D]", divider: "border-[#E8B2A1]/60", title: "text-[#9A3A2D]" },
];

const VERSION_STATUS_STYLES: Record<BOMVersionStatus, { bg: string; text: string; border: string; label: string }> = {
  ACTIVE: { bg: "bg-[#EEF3E4]", text: "text-[#4F7C3A]", border: "border-[#C6DBA8]", label: "Active" },
  DRAFT: { bg: "bg-[#FAEFCB]", text: "text-[#9C6F1E]", border: "border-[#E8D597]", label: "Draft" },
  OBSOLETE: { bg: "bg-gray-50", text: "text-gray-500", border: "border-gray-200", label: "Obsolete" },
};

// ---------- WIP code resolver ----------
function resolveSegments(
  segments: CodeSegment[] | undefined,
  product: Product | null,
): string {
  if (!segments || segments.length === 0) return "";
  const isSofa = product?.category === "SOFA";
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

function resolveMaterialLabel(m: WIPMaterial, product: Product | null): string {
  if (m.autoDetect === "FABRIC") {
    const _ = product;
    return "Fabric PC151-01";
  }
  if (m.autoDetect === "LEG") return "Leg (from order)";
  return m.name || m.code || "\u2014";
}

// ---------- Version Status Badge ----------
function VersionStatusBadge({ status }: { status: BOMVersionStatus }) {
  const style = VERSION_STATUS_STYLES[status] || VERSION_STATUS_STYLES.ACTIVE;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${style.bg} ${style.text} ${style.border}`}>
      {style.label}
    </span>
  );
}

// ---------- Routing Pill ----------
function RoutingPill({ step }: { step: BOMProcess }) {
  const color = DEPT_COLORS[step.deptCode] || "#6B7280";
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap"
      style={{ backgroundColor: `${color}15`, color, border: `1px solid ${color}40` }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
      {step.dept
        .replace("Bonding", "")
        .replace("Cutting", "Cut")
        .replace("Sewing", "Sew")}
      <span className="opacity-70">{step.category}</span>
      <span className="font-semibold">{step.minutes}m</span>
    </span>
  );
}

// ---------- WIP Tree Node ----------
function WIPNode({
  wip,
  product,
  level = 1,
}: {
  wip: WIPComponent;
  product: Product | null;
  level?: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const wipStyle =
    WIP_TYPE_LABELS[wip.wipType] || { label: wip.wipType, color: "#6B7280" };
  const totalMin = wip.processes.reduce((s, p) => s + p.minutes, 0);
  const displayCode = resolveSegments(wip.codeSegments, product) || wip.wipCode;
  const children = wip.children || [];
  const materials = wip.materials || [];
  const colorIdx = Math.min(level - 1, WIP_LEVEL_COLORS.length - 1);
  const colors = WIP_LEVEL_COLORS[colorIdx];

  return (
    <div className="ml-6 mt-2">
      <div className="flex items-center mb-1">
        <div className="w-4 h-px bg-gray-300" />
        <svg className="w-3 h-3 text-gray-400 -ml-0.5" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
            clipRule="evenodd"
          />
        </svg>
      </div>

      <div className={`border rounded-lg overflow-hidden ${colors.container}`}>
        <div
          className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
          onClick={() => setExpanded(!expanded)}
        >
          <svg
            className={`w-4 h-4 text-gray-500 transition-transform flex-shrink-0 ${expanded ? "rotate-90" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>

          <span
            className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${colors.badge}`}
          >
            L{level + 1}
          </span>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm text-[#111827]">{displayCode}</span>
              <span
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                style={{
                  backgroundColor: `${wipStyle.color}20`,
                  color: wipStyle.color,
                }}
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
              <RoutingPill key={i} step={p} />
            ))}
          </div>
        )}

        {expanded && materials.length > 0 && (
          <div className={`px-4 pb-3 pt-1 border-t ${colors.divider}`}>
            <div className={`text-[10px] font-semibold uppercase mb-1 ${colors.title}`}>
              Raw Materials
            </div>
            <div className="flex flex-wrap gap-1.5">
              {materials.map((m, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 bg-white border border-[#C6DBA8] text-[#4F7C3A] rounded"
                >
                  <span>{resolveMaterialLabel(m, product)}</span>
                  <span className="text-gray-400">
                    &times; {m.qty} {m.unit}
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

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

// ---------- Routing Flow Chart ----------
function RoutingFlow({ template }: { template: BOMTemplate }) {
  const deptMinutes: Record<string, number> = {};

  for (const p of template.l1Processes) {
    deptMinutes[p.deptCode] = (deptMinutes[p.deptCode] || 0) + p.minutes;
  }

  function walk(node: WIPComponent, multiplier: number) {
    const qty = (node.quantity || 1) * multiplier;
    for (const p of node.processes) {
      deptMinutes[p.deptCode] = (deptMinutes[p.deptCode] || 0) + p.minutes * qty;
    }
    for (const c of node.children || []) walk(c, qty);
  }
  for (const top of template.wipComponents) walk(top, 1);

  const steps = DEPT_ORDER.filter((d) => deptMinutes[d]).map((code) => ({
    code,
    minutes: deptMinutes[code],
    color: DEPT_COLORS[code],
  }));

  if (steps.length === 0) {
    return <div className="text-xs text-gray-400">No routing defined.</div>;
  }

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {steps.map((step, i) => (
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
          {i < steps.length - 1 && (
            <svg className="w-4 h-4 text-gray-300 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                clipRule="evenodd"
              />
            </svg>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------- Version Selector ----------
function VersionSelector({
  versions,
  selectedId,
  onSelect,
}: {
  versions: BOMTemplate[];
  selectedId: string;
  onSelect: (t: BOMTemplate) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = versions.find((v) => v.id === selectedId);

  if (versions.length <= 1) {
    // Single version — just show info, no dropdown
    if (!selected) return null;
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-gray-700">v{selected.version}</span>
        <VersionStatusBadge status={selected.versionStatus} />
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 border border-gray-300 rounded-md bg-white hover:bg-gray-50 text-sm"
      >
        <span className="font-semibold text-gray-700">v{selected?.version || "?"}</span>
        <VersionStatusBadge status={selected?.versionStatus || "ACTIVE"} />
        <svg className={`w-4 h-4 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-20 py-1">
            <div className="px-3 py-1.5 text-[10px] font-semibold uppercase text-gray-400 tracking-wider">
              BOM Versions
            </div>
            {versions
              .sort((a, b) => parseFloat(b.version) - parseFloat(a.version))
              .map((v) => {
                const isSelected = v.id === selectedId;
                return (
                  <button
                    key={v.id}
                    onClick={() => { onSelect(v); setOpen(false); }}
                    className={`w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-3 ${isSelected ? "bg-[#E0EDF0]" : ""}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-semibold ${isSelected ? "text-[#3E6570]" : "text-gray-700"}`}>
                          v{v.version}
                        </span>
                        <VersionStatusBadge status={v.versionStatus} />
                        {isSelected && (
                          <span className="text-[10px] text-[#3E6570] font-medium">(viewing)</span>
                        )}
                      </div>
                      <div className="text-xs text-gray-400 mt-0.5">
                        From {new Date(v.effectiveFrom).toLocaleDateString()}
                        {v.effectiveTo ? ` to ${new Date(v.effectiveTo).toLocaleDateString()}` : ""}
                      </div>
                      {v.changeLog && (
                        <div className="text-xs text-gray-500 mt-0.5 truncate">{v.changeLog}</div>
                      )}
                    </div>
                    {isSelected && (
                      <svg className="w-4 h-4 text-[#3E6570] flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    )}
                  </button>
                );
              })}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- Main Page ----------
export default function BOMPage() {
  const { id } = useParams();
  const [product, setProduct] = useState<Product | null>(null);
  const [allVersions, setAllVersions] = useState<BOMTemplate[]>([]);
  const [template, setTemplate] = useState<BOMTemplate | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [pData, tData] = await Promise.all([
          cachedFetchJson<{ success?: boolean; data?: Product[] }>("/api/products"),
          cachedFetchJson<{ success?: boolean; data?: BOMTemplate[] }>("/api/bom/templates"),
        ]);

        let foundProduct: Product | null = null;
        if (pData?.success) {
          foundProduct =
            (pData.data as Product[]).find((p: Product) => p.id === id) ||
            (pData.data as Product[]).find((p: Product) => p.code === id) ||
            null;
          setProduct(foundProduct);
        }

        if (tData?.success && foundProduct) {
          const list: BOMTemplate[] = (tData.data as BOMTemplate[]) || [];
          // Gather all versions for this product (by productCode, then
          // fall back to baseModel).
          let productVersions = list.filter(
            (t) => t.productCode === foundProduct!.code,
          );
          if (productVersions.length === 0) {
            productVersions = list.filter(
              (t) => t.baseModel === foundProduct!.baseModel,
            );
          }
          setAllVersions(productVersions);

          // Default to the ACTIVE version, or the highest version number
          const active = productVersions.find(
            (t) => t.versionStatus === "ACTIVE",
          );
          setTemplate(
            active ||
            productVersions.sort(
              (a, b) => parseFloat(b.version) - parseFloat(a.version),
            )[0] ||
            null,
          );
        }
      } catch {
        // silent — empty-state UI will render
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  // Find the active version for the non-active banner
  const activeVersion = useMemo(
    () => allVersions.find((v) => v.versionStatus === "ACTIVE"),
    [allVersions],
  );

  const totalMinutes = useMemo(() => {
    if (!template) return 0;
    let total = template.l1Processes.reduce((s, p) => s + p.minutes, 0);
    function walk(n: WIPComponent, mult: number) {
      const qty = (n.quantity || 1) * mult;
      for (const p of n.processes) total += p.minutes * qty;
      for (const c of n.children || []) walk(c, qty);
    }
    for (const top of template.wipComponents) walk(top, 1);
    return total;
  }, [template]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        Loading BOM data...
      </div>
    );
  }

  if (!product) {
    return (
      <div className="space-y-4">
        <Link to="/products" className="text-[#3E6570] hover:underline text-sm">
          &larr; Back to Products
        </Link>
        <div className="text-center py-12 text-gray-500">Product not found</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb + Header */}
      <div>
        <Link to="/products" className="text-[#3E6570] hover:underline text-sm">
          &larr; Back to Products
        </Link>
        <div className="flex items-center justify-between mt-3">
          <div>
            <h1 className="text-xl font-bold text-[#111827]">Bill of Materials</h1>
            <div className="flex items-center gap-3 mt-1">
              <span className="text-sm font-mono font-medium text-gray-700 bg-gray-100 px-2 py-0.5 rounded">
                {product.code}
              </span>
              <span className="text-sm text-gray-600">{product.name}</span>
              <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">
                {product.category}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {template && (
              <VersionSelector
                versions={allVersions}
                selectedId={template.id}
                onSelect={setTemplate}
              />
            )}
            <Link to="/bom"
              className="text-xs px-3 py-1.5 border border-gray-300 rounded-md bg-white hover:bg-gray-50 text-gray-700"
            >
              Edit in BOM Builder
            </Link>
          </div>
        </div>
      </div>

      {!template ? (
        <div className="text-center py-16 bg-white rounded-lg border border-gray-200">
          <svg
            className="w-12 h-12 text-gray-300 mx-auto mb-3"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
            />
          </svg>
          <p className="text-gray-500 text-sm">No BOM template found for this product.</p>
          <p className="text-gray-400 text-xs mt-1 mb-4">
            Create one in the BOM Builder, or push a master template to this category.
          </p>
          <Link to="/bom"
            className="inline-block text-xs px-4 py-2 bg-[#6B5C32] text-white rounded-md hover:bg-[#55481f]"
          >
            Create BOM
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Non-active version banner */}
          {template.versionStatus !== "ACTIVE" && (
            <div
              className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${
                template.versionStatus === "DRAFT"
                  ? "bg-[#FAEFCB] border-[#E8D597] text-[#9C6F1E]"
                  : "bg-gray-50 border-gray-200 text-gray-600"
              }`}
            >
              <svg className="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <div className="flex-1">
                <span className="font-semibold">
                  You are viewing BOM v{template.version} ({template.versionStatus}).
                </span>
                {activeVersion && activeVersion.id !== template.id && (
                  <span className="ml-1">
                    Active version is{" "}
                    <button
                      onClick={() => setTemplate(activeVersion)}
                      className="font-semibold underline hover:no-underline"
                    >
                      v{activeVersion.version}
                    </button>
                    .
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Version info bar */}
          <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-4">
                <div>
                  <div className="text-[10px] font-semibold uppercase text-gray-400">Version</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-lg font-bold text-[#111827]">v{template.version}</span>
                    <VersionStatusBadge status={template.versionStatus} />
                  </div>
                </div>
                <div className="h-8 w-px bg-gray-200" />
                <div>
                  <div className="text-[10px] font-semibold uppercase text-gray-400">Effective From</div>
                  <div className="text-sm text-gray-700 mt-0.5">
                    {new Date(template.effectiveFrom).toLocaleDateString("en-MY", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </div>
                </div>
                {template.effectiveTo && (
                  <>
                    <div className="h-8 w-px bg-gray-200" />
                    <div>
                      <div className="text-[10px] font-semibold uppercase text-gray-400">Effective To</div>
                      <div className="text-sm text-gray-700 mt-0.5">
                        {new Date(template.effectiveTo).toLocaleDateString("en-MY", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </div>
                    </div>
                  </>
                )}
              </div>
              {template.changeLog && (
                <div className="flex-1 min-w-[200px] max-w-md">
                  <div className="text-[10px] font-semibold uppercase text-gray-400">Change Log</div>
                  <div className="text-xs text-gray-600 mt-0.5">{template.changeLog}</div>
                </div>
              )}
            </div>
          </div>

          {/* Summary stats */}
          <div className="grid grid-cols-4 gap-3">
            <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
              <div className="text-xs text-gray-500">Total Time</div>
              <div className="text-lg font-bold text-[#111827]">
                {(totalMinutes / 60).toFixed(1)} hrs
              </div>
              <div className="text-xs text-gray-400">{totalMinutes} minutes</div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
              <div className="text-xs text-gray-500">WIP Components</div>
              <div className="text-lg font-bold text-[#111827]">
                {template.wipComponents.length}
              </div>
              <div className="text-xs text-gray-400">top-level</div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
              <div className="text-xs text-gray-500">L1 Processes</div>
              <div className="text-lg font-bold text-[#111827]">
                {template.l1Processes.length}
              </div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
              <div className="text-xs text-gray-500">Template</div>
              <div className="text-sm font-semibold text-[#111827] truncate">
                {template.productCode}
              </div>
              <div className="text-xs text-gray-400">{template.category}</div>
            </div>
          </div>

          {/* BOM Tree */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-[#111827] mb-3">BOM Structure</h2>

            {/* L1 Processes */}
            {template.l1Processes.length > 0 && (
              <div className="mb-3">
                <div className="text-[10px] font-semibold uppercase text-gray-500 mb-1">
                  L1 Processes (Finished Good)
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {template.l1Processes.map((p, i) => (
                    <RoutingPill key={i} step={p} />
                  ))}
                </div>
              </div>
            )}

            {/* L1 Materials */}
            {template.l1Materials && template.l1Materials.length > 0 && (
              <div className="mb-3">
                <div className="text-[10px] font-semibold uppercase text-gray-500 mb-1">
                  L1 Materials
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {template.l1Materials.map((m, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 bg-white border border-[#C6DBA8] text-[#4F7C3A] rounded"
                    >
                      <span>{resolveMaterialLabel(m, product)}</span>
                      <span className="text-gray-400">
                        &times; {m.qty} {m.unit}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* WIP tree */}
            {template.wipComponents.map((wip) => (
              <WIPNode key={wip.id} wip={wip} product={product} level={1} />
            ))}
          </div>

          {/* Routing Flow */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-[#111827] mb-3">
              Department Routing Flow (Aggregated)
            </h2>
            <RoutingFlow template={template} />
          </div>
        </div>
      )}
    </div>
  );
}
