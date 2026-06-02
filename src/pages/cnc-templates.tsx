// ---------------------------------------------------------------------------
// /cnc-templates — CNC Cutting Templates library.
//
// Lists every fabric-cutting file for the BUYI E-DIGIT cutter, grouped by
// product code. Each row exposes DGT / PRJ / EMF download buttons (each an
// anchor to GET /api/cnc-templates/:id/file/:kind, which 302-redirects to the
// real download URL). Client-side search filters the loaded list by
// productCode / displayName / pieceLabel.
// ---------------------------------------------------------------------------
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useCachedJson, invalidateCache } from "@/lib/cached-fetch";
import { Card, CardContent } from "@/components/ui/card";
import { SkeletonTable } from "@/components/ui/skeleton";
import { Scissors, Search, Upload, Loader2, Pencil, Check, X } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { uploadCncFiles, updateCncTemplate } from "@/lib/cnc-import";
import type { CncTemplate } from "@/components/cnc/CncTemplatePanel";
import type { Product } from "@/types";

// Editable-field draft for the inline row editor. Mirrors the metadata columns
// the operator can change (model re-assignment, size, piece, height, etc.).
type EditDraft = {
  productCode: string;
  displayName: string;
  sizeLabel: string;
  pieceLabel: string;
  totalHeight: string;
  fabricWidth: string;
};

type CncTemplatesResponse = { success?: boolean; data?: CncTemplate[] };

type ProductsResponse = { success?: boolean; data?: Product[] };

// Auto-suggest a sensible file/display name for a chosen product. The naming
// rule the owner wants:
//   - SOFA     → reflect the SEAT SIZE (defaultVariants.seatHeight, else sizeLabel)
//   - BEDFRAME → reflect the TOTAL HEIGHT (divanHeight + legHeight if both known,
//                else sizeLabel)
// Falls back to the product code + name when no size/height is available, so the
// field is never blank. The operator can always edit the result.
function suggestTemplateName(p: Product): string {
  const code = (p.code || "").trim();
  const dv = p.defaultVariants || {};

  if (p.category === "SOFA") {
    const seat = (dv.seatHeight || p.sizeLabel || "").trim();
    return seat ? `${code} ${seat}`.trim() : `${code} ${p.name || ""}`.trim();
  }

  if (p.category === "BEDFRAME") {
    // divanHeight / legHeight are stored as inch strings (e.g. `8"`).
    // parseFloat stops at the `"`, so we get the numeric inches to sum.
    const divan = Number.parseFloat((dv.divanHeight || "").trim());
    const leg = Number.parseFloat((dv.legHeight || "").trim());
    if (Number.isFinite(divan) && Number.isFinite(leg)) {
      // Round to 2 dp then drop any trailing zeros, so "20.00" reads as "20"
      // and "20.50" as "20.5". Keep the inch mark — the source values are
      // inches, so the total is inches too.
      const total = divan + leg;
      const totalStr = String(Number(total.toFixed(2)));
      return `${code} ${totalStr}"`.trim();
    }
    const label = (p.sizeLabel || "").trim();
    return label ? `${code} ${label}`.trim() : `${code} ${p.name || ""}`.trim();
  }

  // ACCESSORY / anything else: just code + name.
  return `${code} ${p.name || ""}`.trim();
}

// Per-kind download button. Renders as an anchor the browser follows to the
// backend's 302-redirect download URL. Opens in a new tab so the library page
// stays open.
function FileButton({
  templateId,
  kind,
  label,
}: {
  templateId: string;
  kind: "dgt" | "prj" | "emf";
  label: string;
}) {
  return (
    <a
      href={`/api/cnc-templates/${templateId}/file/${kind}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center rounded-md border border-[#A8CAD2] bg-[#E0EDF0] px-2 py-0.5 text-[11px] font-medium text-[#3E6570] hover:bg-[#D2E4E8] transition-colors"
    >
      {label}
    </a>
  );
}

export default function CncTemplatesPage() {
  const [query, setQuery] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  // Upload-time model picker. The operator picks which product the files are
  // for (instead of relying on the filename), and gets an auto-suggested name
  // they can override before uploading.
  const [pickedProduct, setPickedProduct] = useState<Product | null>(null);
  const [modelSearch, setModelSearch] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [suggestedName, setSuggestedName] = useState("");
  const modelBoxRef = useRef<HTMLDivElement>(null);

  const { data: productsData } = useCachedJson<ProductsResponse>("/api/products");
  const products = useMemo(
    () => (Array.isArray(productsData?.data) ? productsData!.data! : []),
    [productsData],
  );

  // Filter the (large, ~250) product list as the operator types. Match on code
  // or name; cap at 50 results so the dropdown stays light.
  const filteredProducts = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    const base = q
      ? products.filter(
          (p) =>
            (p.code || "").toLowerCase().includes(q) ||
            (p.name || "").toLowerCase().includes(q),
        )
      : products;
    return base.slice(0, 50);
  }, [products, modelSearch]);

  // Choosing a model seeds the auto-suggested name (editable afterwards).
  const selectProduct = (p: Product) => {
    setPickedProduct(p);
    setSuggestedName(suggestTemplateName(p));
    setModelOpen(false);
    setModelSearch("");
  };

  const clearPickedProduct = () => {
    setPickedProduct(null);
    setSuggestedName("");
    setModelSearch("");
  };

  // Close the model dropdown on outside click.
  useEffect(() => {
    if (!modelOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (modelBoxRef.current && !modelBoxRef.current.contains(e.target as Node)) {
        setModelOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [modelOpen]);

  // Inline row editor: which row is open + its working draft + save spinner.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const { data, loading, refresh } = useCachedJson<CncTemplatesResponse>(
    "/api/cnc-templates",
  );

  // Open the editor for a row, seeding the draft from its current values.
  const startEdit = (t: CncTemplate) => {
    setEditingId(t.id);
    setDraft({
      productCode: t.productCode || "",
      displayName: t.displayName || "",
      sizeLabel: t.sizeLabel || "",
      pieceLabel: t.pieceLabel || "",
      totalHeight: t.totalHeight || "",
      fabricWidth: t.fabricWidth || "",
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(null);
  };

  // Save the edited metadata. Requires a model + display name (server enforces
  // the same). On success, drop the cached list so the row re-groups under its
  // (possibly new) model and refetches.
  const saveEdit = async () => {
    if (!editingId || !draft) return;
    if (!draft.productCode.trim()) {
      toast.error("Please enter a model (product code).");
      return;
    }
    if (!draft.displayName.trim()) {
      toast.error("Display name cannot be empty.");
      return;
    }
    setSavingEdit(true);
    try {
      await updateCncTemplate(editingId, {
        productCode: draft.productCode.trim(),
        displayName: draft.displayName.trim(),
        sizeLabel: draft.sizeLabel.trim(),
        pieceLabel: draft.pieceLabel.trim(),
        totalHeight: draft.totalHeight.trim(),
        fabricWidth: draft.fabricWidth.trim(),
      });
      toast.success("Template updated.");
      setEditingId(null);
      setDraft(null);
      invalidateCache("/api/cnc-templates");
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSavingEdit(false);
    }
  };

  // Bulk-upload chosen files, then refresh the library list. The server parses
  // each filename into product/size/width/piece — the operator just picks the
  // .dgt/.prj/.emf files.
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const files = Array.from(input.files || []);
    input.value = ""; // allow re-selecting the same files later
    if (files.length === 0) return;

    setUploading(true);
    try {
      const msg = await uploadCncFiles(files, {
        // Operator-chosen model wins over the filename-parsed code; the
        // auto-suggested (editable) name wins over the filename-derived one.
        productCode: pickedProduct?.code,
        displayName: pickedProduct ? suggestedName : undefined,
      });
      toast.success(msg);
      // Drop the cached list so the new rows show immediately, then refetch.
      invalidateCache("/api/cnc-templates");
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  const templates = useMemo(
    () => (Array.isArray(data?.data) ? data!.data! : []),
    [data],
  );

  // Client-side search over productCode / displayName / pieceLabel.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((t) =>
      [t.productCode, t.displayName, t.pieceLabel]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(q)),
    );
  }, [templates, query]);

  // Group the filtered rows by productCode. Keep group order stable + sorted
  // so the library reads predictably.
  const groups = useMemo(() => {
    const map = new Map<string, CncTemplate[]>();
    for (const t of filtered) {
      const key = t.productCode || "—";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">CNC Cutting Templates</h1>
          <p className="text-xs text-[#6B7280]">
            Fabric-cutting files for the BUYI E-DIGIT cutter, by product &amp; size
          </p>
        </div>
      </div>

      {/* Search */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative max-w-sm flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[#9CA3AF]" />
          <input
            type="text"
            placeholder="Search by product code, name, or piece…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-md border border-[#E2DDD8] bg-white pl-8 pr-3 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
          />
        </div>
      </div>

      {/* Upload panel: pick the model (so the file isn't guessed from its name),
          review the auto-suggested name, then choose the .dgt/.prj/.emf files. */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-end gap-3 flex-wrap">
            {/* Model picker — searchable combobox over /api/products. */}
            <div className="relative min-w-[240px] flex-1 max-w-sm" ref={modelBoxRef}>
              <label className="block text-[11px] font-medium text-[#6B7280] mb-1">
                Model (product)
              </label>
              {pickedProduct ? (
                <div className="flex items-center gap-2 rounded-md border border-[#E2DDD8] bg-white px-2.5 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-[#1F1D1B]">
                    <span className="font-medium">{pickedProduct.code}</span>
                    <span className="text-[#6B7280]"> — {pickedProduct.name}</span>
                  </span>
                  <button
                    type="button"
                    onClick={clearPickedProduct}
                    className="shrink-0 text-[#9CA3AF] hover:text-[#6B5C32]"
                    title="Clear selected model"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <input
                  type="text"
                  value={modelSearch}
                  onChange={(e) => {
                    setModelSearch(e.target.value);
                    setModelOpen(true);
                  }}
                  onFocus={() => setModelOpen(true)}
                  placeholder="Search code or name…"
                  autoComplete="off"
                  className="w-full rounded-md border border-[#E2DDD8] bg-white px-2.5 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                />
              )}
              {modelOpen && !pickedProduct && (
                <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-[#E2DDD8] bg-white shadow-lg">
                  {filteredProducts.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-[#9CA3AF] italic">
                      No matching products
                    </div>
                  ) : (
                    filteredProducts.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => selectProduct(p)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[#F3F0EA]"
                      >
                        <span className="font-medium text-[#1F1D1B]">{p.code}</span>
                        <span className="min-w-0 flex-1 truncate text-[#6B7280]">{p.name}</span>
                        {p.category && (
                          <span className="shrink-0 text-[10px] uppercase tracking-wide text-[#9CA3AF]">
                            {p.category}
                          </span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Auto-suggested (editable) file name. */}
            <div className="min-w-[200px] flex-1 max-w-sm">
              <label className="block text-[11px] font-medium text-[#6B7280] mb-1">
                File name (auto-suggested)
              </label>
              <input
                type="text"
                value={suggestedName}
                onChange={(e) => setSuggestedName(e.target.value)}
                disabled={!pickedProduct}
                placeholder={pickedProduct ? "" : "Pick a model first"}
                className="w-full rounded-md border border-[#E2DDD8] bg-white px-2.5 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32] disabled:bg-[#F3F4F6] disabled:text-[#9CA3AF]"
              />
            </div>

            {/* Bulk upload: opens a hidden multi-file picker (.dgt/.prj/.emf). */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-2 rounded-md bg-[#6B5C32] px-3 py-2 text-sm font-medium text-white hover:bg-[#4D4224] disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {uploading ? "Uploading…" : "Upload files"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".dgt,.prj,.emf"
              multiple
              className="hidden"
              onChange={handleUpload}
            />
          </div>

          <p className="mt-2 text-[11px] text-[#8B8580]">
            Pick the model so the file is filed under the right product instead of
            being guessed from its name. Sofas suggest a name from the seat size;
            bedframes from the total height. Leave the model blank to keep using the
            filename. <span className="font-medium text-[#6B5C32]">.dgt</span> and{" "}
            <span className="font-medium text-[#6B5C32]">.emf</span> are machine files for the BUYI
            cutter; <span className="font-medium text-[#6B5C32]">.prj</span> is the project file.
          </p>
        </CardContent>
      </Card>

      {/* Loading skeleton */}
      {loading && templates.length === 0 ? (
        <SkeletonTable rows={6} columns={6} />
      ) : groups.length === 0 ? (
        /* Empty state */
        <Card>
          <CardContent className="p-12 text-center">
            <Scissors className="h-10 w-10 text-[#E2DDD8] mx-auto mb-3" strokeWidth={1.5} />
            <p className="text-sm font-medium text-[#1F1D1B]">
              {templates.length === 0 ? "No CNC templates yet" : "No matching templates"}
            </p>
            <p className="text-xs text-[#6B7280] mt-1">
              {templates.length === 0
                ? "Cutting files will appear here once they are linked to a product."
                : "Try a different search term."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {groups.map(([code, rows]) => (
            <div key={code} className="space-y-2">
              {/* Product code section header */}
              <h2 className="text-sm font-semibold text-[#6B7280] uppercase tracking-wide px-1">
                {code}
                <span className="ml-2 font-normal text-[#9CA3AF]">
                  ({rows.length} template{rows.length === 1 ? "" : "s"})
                </span>
              </h2>

              <Card>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[10px] font-medium text-[#6B7280] uppercase border-b border-[#E2DDD8]">
                        <th className="px-3 py-2">Display Name</th>
                        <th className="px-3 py-2">Size</th>
                        <th className="px-3 py-2">Piece</th>
                        <th className="px-3 py-2">Total H (cm)</th>
                        <th className="px-3 py-2">Fabric Width</th>
                        <th className="px-3 py-2">Files</th>
                        <th className="px-3 py-2 text-right">Edit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((t) => (
                        <Fragment key={t.id}>
                          <tr className="border-b border-[#F3F4F6] last:border-0">
                            <td className="px-3 py-2 text-[#111827]">{t.displayName}</td>
                            <td className="px-3 py-2 text-[#6B7280]">{t.sizeLabel || "—"}</td>
                            <td className="px-3 py-2 text-[#6B7280]">{t.pieceLabel || "—"}</td>
                            <td className="px-3 py-2 text-[#6B7280]">
                              {t.totalHeight ? `${t.totalHeight} cm` : "—"}
                            </td>
                            <td className="px-3 py-2 text-[#6B7280]">{t.fabricWidth || "—"}</td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-1.5">
                                {t.hasDgt && <FileButton templateId={t.id} kind="dgt" label="DGT" />}
                                {t.hasPrj && <FileButton templateId={t.id} kind="prj" label="PRJ" />}
                                {t.hasEmf && <FileButton templateId={t.id} kind="emf" label="EMF" />}
                                {!t.hasDgt && !t.hasPrj && !t.hasEmf && (
                                  <span className="text-[11px] text-[#9CA3AF] italic">No files</span>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right">
                              <button
                                type="button"
                                onClick={() => (editingId === t.id ? cancelEdit() : startEdit(t))}
                                className="inline-flex items-center gap-1 rounded-md border border-[#E2DDD8] bg-white px-2 py-1 text-[11px] font-medium text-[#6B5C32] hover:bg-[#F3F0EA] transition-colors"
                                title="Edit this template (re-assign model, fix size / piece / height)"
                              >
                                <Pencil className="h-3 w-3" />
                                Edit
                              </button>
                            </td>
                          </tr>
                          {editingId === t.id && draft && (
                            <tr className="bg-[#FAF9F7] border-b border-[#E2DDD8]">
                              <td colSpan={7} className="px-3 py-3">
                                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                                  <label className="flex flex-col gap-1 text-[11px] font-medium text-[#6B7280]">
                                    Model (product code)
                                    <input
                                      type="text"
                                      value={draft.productCode}
                                      onChange={(e) =>
                                        setDraft({ ...draft, productCode: e.target.value })
                                      }
                                      placeholder="e.g. 5535"
                                      className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                                    />
                                  </label>
                                  <label className="flex flex-col gap-1 text-[11px] font-medium text-[#6B7280]">
                                    Display Name
                                    <input
                                      type="text"
                                      value={draft.displayName}
                                      onChange={(e) =>
                                        setDraft({ ...draft, displayName: e.target.value })
                                      }
                                      className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                                    />
                                  </label>
                                  <label className="flex flex-col gap-1 text-[11px] font-medium text-[#6B7280]">
                                    Size
                                    <input
                                      type="text"
                                      value={draft.sizeLabel}
                                      onChange={(e) =>
                                        setDraft({ ...draft, sizeLabel: e.target.value })
                                      }
                                      placeholder="e.g. 6FT / 2S"
                                      className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                                    />
                                  </label>
                                  <label className="flex flex-col gap-1 text-[11px] font-medium text-[#6B7280]">
                                    Piece
                                    <input
                                      type="text"
                                      value={draft.pieceLabel}
                                      onChange={(e) =>
                                        setDraft({ ...draft, pieceLabel: e.target.value })
                                      }
                                      placeholder="e.g. ARM / CUSHION"
                                      className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                                    />
                                  </label>
                                  <label className="flex flex-col gap-1 text-[11px] font-medium text-[#6B7280]">
                                    Total H (cm)
                                    <input
                                      type="text"
                                      value={draft.totalHeight}
                                      onChange={(e) =>
                                        setDraft({ ...draft, totalHeight: e.target.value })
                                      }
                                      placeholder="e.g. 20"
                                      className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                                    />
                                  </label>
                                  <label className="flex flex-col gap-1 text-[11px] font-medium text-[#6B7280]">
                                    Fabric Width
                                    <input
                                      type="text"
                                      value={draft.fabricWidth}
                                      onChange={(e) =>
                                        setDraft({ ...draft, fabricWidth: e.target.value })
                                      }
                                      className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                                    />
                                  </label>
                                </div>
                                <div className="mt-3 flex items-center justify-end gap-2">
                                  <button
                                    type="button"
                                    onClick={cancelEdit}
                                    disabled={savingEdit}
                                    className="inline-flex items-center gap-1 rounded-md border border-[#E2DDD8] bg-white px-3 py-1.5 text-xs font-medium text-[#6B7280] hover:bg-[#F3F4F6] disabled:opacity-50 transition-colors"
                                  >
                                    <X className="h-3.5 w-3.5" />
                                    Cancel
                                  </button>
                                  <button
                                    type="button"
                                    onClick={saveEdit}
                                    disabled={savingEdit}
                                    className="inline-flex items-center gap-1 rounded-md bg-[#6B5C32] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#4D4224] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                  >
                                    {savingEdit ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <Check className="h-3.5 w-3.5" />
                                    )}
                                    {savingEdit ? "Saving…" : "Save"}
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
