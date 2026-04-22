import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, Save, SlidersHorizontal, AlertCircle, Check, Download, Upload } from "lucide-react";

type ListKey =
  | "divanHeights"
  | "legHeights"
  | "sizes"
  | "fabricGroups"
  | "sofaModules"
  | "specials";

// Production time matrix: deptCode -> category -> minutes
// Used by BOM process rows: picking (dept + category) auto-fills minutes.
type ProductionTimes = Record<string, Record<string, number>>;

type VariantConfig = Record<ListKey, string[]> & {
  productionTimes: ProductionTimes;
};

const STORAGE_KEY = "hookka-variants-config";

const DEPT_ORDER = ["FAB_CUT", "FAB_SEW", "WOOD_CUT", "FOAM", "FRAMING", "WEBBING", "UPHOLSTERY", "PACKING"] as const;
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

const DEFAULT_FABRIC_GROUPS = ["CAT 1", "CAT 2", "CAT 3", "CAT 4", "CAT 5", "CAT 6", "CAT 7"];

function buildDefaultProductionTimes(cats: string[]): ProductionTimes {
  const out: ProductionTimes = {};
  for (const d of DEPT_ORDER) {
    out[d] = {};
    for (const c of cats) out[d][c] = 0;
  }
  return out;
}

const DEFAULT_CONFIG: VariantConfig = {
  divanHeights: ["6\"", "8\"", "10\"", "12\""],
  legHeights: ["0\"", "2\"", "4\"", "6\""],
  sizes: ["3FT", "4FT", "4.5FT", "5FT", "6FT", "7FT", "183x190CM"],
  fabricGroups: DEFAULT_FABRIC_GROUPS,
  sofaModules: ["2S", "3S", "L-SHAPE", "CHAISE", "OTTOMAN"],
  specials: ["PU LEATHER", "WIRELESS CHARGING", "USB PORTS", "STORAGE"],
  productionTimes: buildDefaultProductionTimes(DEFAULT_FABRIC_GROUPS),
};

type TabKey = ListKey | "productionTimes";

const TAB_META: { key: TabKey; label: string; description: string }[] = [
  { key: "divanHeights", label: "Divan Heights", description: "Available divan height options (inches)" },
  { key: "legHeights", label: "Leg Heights", description: "Available leg height options (inches)" },
  { key: "sizes", label: "Sizes", description: "Standard bedframe / sofa sizes" },
  { key: "fabricGroups", label: "BOM Categories", description: "Shared category list (CAT 1, CAT 2, ...). Used by BOM process rows and the Production Times matrix, and also doubles as the fabric pricing category." },
  { key: "sofaModules", label: "Sofa Modules", description: "Available sofa module configurations" },
  { key: "specials", label: "Specials", description: "Special feature tags for products" },
  { key: "productionTimes", label: "Production Times", description: "Minutes per department × category. BOM picks a category and the minutes are filled automatically." },
];

// The Products > Maintenance tab and the Sales > Create form both write into
// this same localStorage key, but they store objects like `{value, priceSen}`
// while this page stores plain strings. Coerce every entry to its string form
// on load so `{entry}` renders never see a raw object (React error #31).
function coerceToStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") out.push(item);
    else if (item && typeof item === "object") {
      const val = (item as { value?: unknown }).value;
      if (typeof val === "string") out.push(val);
      else if (typeof val === "number") out.push(String(val));
    }
    // silently drop anything else — nulls, numbers sneaking in, etc.
  }
  return out;
}

function loadConfig(): VariantConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw) as Partial<VariantConfig>;
    // Normalise string-array fields. Object-array writes from other pages get
    // reduced to their `.value` strings here.
    const stringFields: (keyof VariantConfig)[] = [
      "divanHeights",
      "legHeights",
      "sizes",
      "specials",
    ];
    const cleaned: Record<string, unknown> = { ...parsed };
    for (const k of stringFields) {
      if (k in cleaned) cleaned[k] = coerceToStringArray(cleaned[k]);
    }
    const merged: VariantConfig = {
      ...DEFAULT_CONFIG,
      ...(cleaned as Partial<VariantConfig>),
      productionTimes:
        parsed.productionTimes && Object.keys(parsed.productionTimes).length > 0
          ? parsed.productionTimes
          : buildDefaultProductionTimes(parsed.fabricGroups || DEFAULT_FABRIC_GROUPS),
    };
    return merged;
  } catch {
    return DEFAULT_CONFIG;
  }
}

function saveConfig(cfg: VariantConfig) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    // ignore
  }
}

export default function VariantsPage() {
  const [config, setConfig] = useState<VariantConfig>(DEFAULT_CONFIG);
  const [savedSnapshot, setSavedSnapshot] = useState<string>("");
  const [tab, setTab] = useState<TabKey>("divanHeights");
  const [newValue, setNewValue] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const [toastMsg, setToastMsg] = useState("Variants saved");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const loaded = loadConfig();
    setConfig(loaded);
    setSavedSnapshot(JSON.stringify(loaded));
    // Honor ?tab=... query param for deep links from BOM page.
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const t = params.get("tab");
      if (t) {
        const valid: TabKey[] = ["divanHeights", "legHeights", "sizes", "fabricGroups", "sofaModules", "specials", "productionTimes"];
        if ((valid as string[]).includes(t)) setTab(t as TabKey);
      }
    }
  }, []);

  function showToast(msg: string) {
    setToastMsg(msg);
    setToastVisible(true);
    setTimeout(() => setToastVisible(false), 2000);
  }

  // Export the Categories list + Production Times matrix as CSV.
  // Header row: Department,CAT 1,CAT 2,...
  // Body rows:  one per department, with minutes for each category.
  function exportProductionTimesCSV() {
    const cats = config.fabricGroups;
    const header = ["Department", ...cats].join(",");
    const lines = DEPT_ORDER.map((d) => {
      const row = [DEPT_LABELS[d], ...cats.map((c) => String(config.productionTimes[d]?.[c] ?? 0))];
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

  // Import a previously-exported (or hand-edited) CSV. The header row defines
  // the categories — any new categories show up automatically in fabricGroups.
  // Department names in column 0 are matched case-insensitively against
  // DEPT_LABELS to recover the deptCode.
  function importProductionTimesCSV(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || "");
        const rows = text.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
        if (rows.length < 2) {
          showToast("CSV is empty");
          return;
        }
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
        setConfig((prev) => ({
          ...prev,
          fabricGroups: cats.length > 0 ? cats : prev.fabricGroups,
          productionTimes: nextTimes,
        }));
        showToast("CSV imported — review and Save");
      } catch {
        showToast("Failed to parse CSV");
      }
    };
    reader.readAsText(file);
  }

  const isListTab = tab !== "productionTimes";
  const currentList = isListTab ? (config[tab as ListKey] as string[]) : [];
  const isDirty = useMemo(() => JSON.stringify(config) !== savedSnapshot, [config, savedSnapshot]);

  function addEntry() {
    if (!isListTab) return;
    const v = newValue.trim();
    if (!v) return;
    if (currentList.includes(v)) {
      setNewValue("");
      return;
    }
    setConfig((prev) => ({ ...prev, [tab as ListKey]: [...(prev[tab as ListKey] as string[]), v] }));
    setNewValue("");
  }

  function removeEntry(idx: number) {
    if (!isListTab) return;
    setConfig((prev) => ({ ...prev, [tab as ListKey]: (prev[tab as ListKey] as string[]).filter((_, i) => i !== idx) }));
  }

  function updateProductionTime(deptCode: string, category: string, value: number) {
    setConfig((prev) => ({
      ...prev,
      productionTimes: {
        ...prev.productionTimes,
        [deptCode]: { ...(prev.productionTimes[deptCode] || {}), [category]: value },
      },
    }));
  }

  function handleSave() {
    saveConfig(config);
    setSavedSnapshot(JSON.stringify(config));
    showToast("Variants saved");
  }

  function handleReset() {
    if (!window.confirm("Reset all variants to factory defaults? Unsaved changes will be lost.")) return;
    setConfig(DEFAULT_CONFIG);
  }

  const meta = TAB_META.find((t) => t.key === tab)!;

  return (
    <div className="p-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[#6B5C32]/10 rounded-lg">
            <SlidersHorizontal className="w-6 h-6 text-[#6B5C32]" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-[#111827]">Variants &amp; Options</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Centralized master data for product variants. Used by BOM, Sales Orders, and Production.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isDirty && (
            <span className="inline-flex items-center gap-1.5 text-xs text-[#9C6F1E] bg-[#FAEFCB] border border-[#E8D597] rounded-md px-2 py-1">
              <AlertCircle className="w-3.5 h-3.5" />
              Unsaved changes
            </span>
          )}
          <button
            onClick={handleReset}
            className="text-xs px-3 py-1.5 border border-[#E2DDD8] rounded-md text-gray-600 hover:bg-[#FAF9F7]"
          >
            Reset to defaults
          </button>
          <button
            onClick={handleSave}
            disabled={!isDirty}
            className="inline-flex items-center gap-1.5 text-sm px-4 py-2 bg-[#6B5C32] text-white rounded-md hover:bg-[#5A4D2A] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Save className="w-4 h-4" />
            Save Changes
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-lg border border-[#E2DDD8] overflow-hidden">
        <div className="flex border-b border-[#E2DDD8] bg-[#FAF9F7] overflow-x-auto">
          {TAB_META.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`relative px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
                tab === t.key
                  ? "text-[#6B5C32] bg-white border-b-2 border-[#6B5C32]"
                  : "text-gray-500 hover:text-gray-700 hover:bg-white/50"
              }`}
            >
              {t.label}
              {t.key !== "productionTimes" && (
                <span className="ml-1.5 text-[10px] text-gray-400 font-normal">({(config[t.key as ListKey] as string[]).length})</span>
              )}
            </button>
          ))}
        </div>

        {/* Tab body */}
        <div className="p-6">
          <p className="text-sm text-gray-500 mb-4">{meta.description}</p>

          {tab === "productionTimes" ? (
            <div className="overflow-x-auto">
              <div className="flex items-center justify-end gap-2 mb-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) importProductionTimesCSV(f);
                    e.target.value = "";
                  }}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 border border-[#E2DDD8] rounded-md text-gray-600 hover:bg-[#FAF9F7]"
                >
                  <Upload className="w-3.5 h-3.5" />
                  Import CSV
                </button>
                <button
                  onClick={exportProductionTimesCSV}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 border border-[#E2DDD8] rounded-md text-gray-600 hover:bg-[#FAF9F7]"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export CSV
                </button>
              </div>
              <table className="w-full text-sm border border-[#E2DDD8] rounded-md overflow-hidden">
                <thead className="bg-[#FAF9F7]">
                  <tr>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-gray-600 border-b border-[#E2DDD8]">Department</th>
                    {config.fabricGroups.map((cat) => (
                      <th key={cat} className="text-center px-2 py-2 text-xs font-semibold text-gray-600 border-b border-[#E2DDD8] min-w-[72px]">
                        {cat}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {DEPT_ORDER.map((d) => (
                    <tr key={d} className="hover:bg-[#FAF9F7]/50">
                      <td className="px-3 py-2 text-xs font-medium text-[#111827] border-b border-[#E2DDD8]">{DEPT_LABELS[d]}</td>
                      {config.fabricGroups.map((cat) => {
                        const val = config.productionTimes[d]?.[cat] ?? 0;
                        return (
                          <td key={cat} className="border-b border-[#E2DDD8] p-1">
                            <div className="flex items-center justify-center gap-1">
                              <input
                                type="number"
                                value={val}
                                onChange={(e) => updateProductionTime(d, cat, parseInt(e.target.value) || 0)}
                                className="w-14 text-xs border border-[#E2DDD8] rounded px-1 py-1 bg-white text-center focus:outline-none focus:border-[#6B5C32]"
                                min={0}
                              />
                              <span className="text-[9px] text-gray-400">m</span>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-gray-400 mt-3">
                💡 When you set a process&apos;s category in BOM, the minutes are auto-filled from this matrix — no manual entry needed.
              </p>
            </div>
          ) : (
            <>
          {/* Add row */}
          <div className="flex gap-2 mb-4">
            <input
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addEntry();
                }
              }}
              placeholder={`Add new ${meta.label.toLowerCase().replace(/s$/, "")}...`}
              className="flex-1 text-sm border border-[#E2DDD8] rounded-md px-3 py-2 bg-[#FAF9F7] focus:outline-none focus:border-[#6B5C32] focus:bg-white"
            />
            <button
              onClick={addEntry}
              disabled={!newValue.trim()}
              className="inline-flex items-center gap-1.5 text-sm px-4 py-2 bg-[#6B5C32] text-white rounded-md hover:bg-[#5A4D2A] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus className="w-4 h-4" />
              Add
            </button>
          </div>

          {/* List */}
          <div className="space-y-1.5">
            {currentList.length === 0 ? (
              <div className="text-center py-10 text-sm text-gray-400 bg-[#FAF9F7] rounded-md border border-dashed border-[#E2DDD8]">
                No entries yet. Add one above to get started.
              </div>
            ) : (
              currentList.map((entry, idx) => (
                <div
                  key={`${entry}-${idx}`}
                  className="flex items-center justify-between px-3 py-2 bg-[#FAF9F7] border border-[#E2DDD8] rounded-md hover:bg-white transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-400 font-mono w-6">{idx + 1}</span>
                    <span className="text-sm text-[#111827] font-medium">{entry}</span>
                  </div>
                  <button
                    onClick={() => removeEntry(idx)}
                    className="p-1.5 text-[#9A3A2D] hover:text-[#7A2E24] hover:bg-[#F9E1DA] rounded"
                    title="Remove"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))
            )}
          </div>
            </>
          )}
        </div>
      </div>

      {/* Info footer */}
      <div className="mt-4 text-xs text-gray-400 bg-[#FAF9F7] border border-[#E2DDD8] rounded-md p-3">
        💡 Variants are stored in browser localStorage (<code className="bg-white px-1 rounded">{STORAGE_KEY}</code>) for now.
        Changes apply the next time BOM, SO, or Production forms are rendered.
      </div>

      {/* Toast */}
      {toastVisible && (
        <div className="fixed bottom-6 right-6 inline-flex items-center gap-2 px-4 py-2.5 bg-[#4F7C3A] text-white rounded-lg shadow-lg text-sm animate-in fade-in slide-in-from-bottom-2">
          <Check className="w-4 h-4" />
          {toastMsg}
        </div>
      )}
    </div>
  );
}
