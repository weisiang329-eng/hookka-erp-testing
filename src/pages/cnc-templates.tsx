// ---------------------------------------------------------------------------
// /cnc-templates — CNC Cutting Templates library.
//
// Lists every fabric-cutting file for the BUYI E-DIGIT cutter, grouped by
// product code. Each row exposes DGT / PRJ / EMF download buttons (each an
// anchor to GET /api/cnc-templates/:id/file/:kind, which 302-redirects to the
// real download URL). Client-side search filters the loaded list by
// productCode / displayName / pieceLabel.
// ---------------------------------------------------------------------------
import { Fragment, useMemo, useRef, useState } from "react";
import { useCachedJson, invalidateCache } from "@/lib/cached-fetch";
import { Card, CardContent } from "@/components/ui/card";
import { SkeletonTable } from "@/components/ui/skeleton";
import { Scissors, Search, Upload, Loader2, Pencil, Check, X } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { uploadCncFiles, updateCncTemplate } from "@/lib/cnc-import";
import type { CncTemplate } from "@/components/cnc/CncTemplatePanel";

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
      const msg = await uploadCncFiles(files);
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

      {/* Search + Upload */}
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

      {/* Note: .dgt / .emf are machine files for the BUYI cutter. */}
      <p className="text-[11px] text-[#8B8580]">
        <span className="font-medium text-[#6B5C32]">.dgt</span> and{" "}
        <span className="font-medium text-[#6B5C32]">.emf</span> are machine files — open them in
        the BUYI cutter. <span className="font-medium text-[#6B5C32]">.prj</span> is the project
        file.
      </p>

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
