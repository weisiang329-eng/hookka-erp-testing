// ---------------------------------------------------------------------------
// CncTemplatePanel — shows the CNC fabric-cutting templates linked to ONE
// product, with DGT / PRJ / EMF download buttons. Self-contained: fetches
// /api/cnc-templates?productCode=<code> via useCachedJson, optionally narrows
// by `size` client-side.
//
// Reused inside the Products detail/expanded row so the operator can grab the
// cutting file for the BUYI E-DIGIT cutter without leaving the product page.
// ---------------------------------------------------------------------------
import { useMemo, useRef, useState } from "react";
import { useCachedJson, invalidateCache, invalidateCachePrefix } from "@/lib/cached-fetch";
import { Scissors, Upload, Loader2 } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { uploadCncFiles } from "@/lib/cnc-import";

// Mirror the shape returned by GET /api/cnc-templates.
export type CncTemplate = {
  id: string;
  productCode: string;
  sizeLabel: string;
  fabricWidth: string;
  pieceLabel: string;
  totalHeight: string;
  material: "fabric" | "wood";
  displayName: string;
  folder: string;
  hasDgt: boolean;
  hasPrj: boolean;
  hasEmf: boolean;
  sizeBytes: number;
  updatedAt: string;
};

type CncTemplatesResponse = { success?: boolean; data?: CncTemplate[] };

// Loosely normalise a size string for comparison — strip spaces, the inch
// mark, and lowercase. So `28"`, `28`, and ` 28 ` all match.
function normalizeSize(s: string): string {
  return String(s ?? "")
    .replace(/["\s]/g, "")
    .toLowerCase();
}

// Per-kind download button. Renders as an anchor that the browser follows to
// the backend's 302-redirect download URL. Opens in a new tab so the operator
// keeps the product page open.
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
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center rounded-md border border-[#A8CAD2] bg-[#E0EDF0] px-2 py-0.5 text-[11px] font-medium text-[#3E6570] hover:bg-[#D2E4E8] transition-colors"
    >
      {label}
    </a>
  );
}

export function CncTemplatePanel({
  productCode,
  size,
}: {
  productCode: string;
  size?: string;
}) {
  // Skip the fetch entirely if no productCode is known yet (null URL is the
  // documented "don't fetch" signal for useCachedJson).
  const url = productCode
    ? `/api/cnc-templates?productCode=${encodeURIComponent(productCode)}`
    : null;
  const { data, loading, refresh } = useCachedJson<CncTemplatesResponse>(url);

  const { toast } = useToast();
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Bulk-upload cutting files for THIS product. We pass this panel's known
  // productCode so the files are filed under THIS product instead of being
  // guessed from the filename. Refresh the panel list afterwards.
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const files = Array.from(input.files || []);
    input.value = ""; // allow re-selecting the same files later
    if (files.length === 0) return;

    setUploading(true);
    try {
      const msg = await uploadCncFiles(files, { productCode });
      toast.success(msg);
      // Refresh this panel and the full library list (both cache keys).
      if (url) invalidateCache(url);
      invalidateCachePrefix("/api/cnc-templates");
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  const templates = useMemo(() => {
    const list = Array.isArray(data?.data) ? data!.data! : [];
    if (!size) return list;
    const target = normalizeSize(size);
    if (!target) return list;
    return list.filter((t) => normalizeSize(t.sizeLabel) === target);
  }, [data, size]);

  return (
    <div className="bg-[#FAF9F7] border border-[#E5E7EB] rounded-lg p-4">
      <div className="flex items-center gap-2 mb-2">
        <Scissors className="h-4 w-4 text-[#6B5C32]" strokeWidth={1.75} />
        <h4 className="text-sm font-semibold text-[#374151]">CNC Cutting Template</h4>

        {/* Bulk upload for this product. Opens a hidden multi-file picker. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            fileInputRef.current?.click();
          }}
          disabled={uploading}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-[#A8CAD2] bg-[#E0EDF0] px-2 py-0.5 text-[11px] font-medium text-[#3E6570] hover:bg-[#D2E4E8] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {uploading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Upload className="h-3 w-3" />
          )}
          {uploading ? "Uploading…" : "Upload"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".dgt,.prj,.emf"
          multiple
          className="hidden"
          onClick={(e) => e.stopPropagation()}
          onChange={handleUpload}
        />
      </div>

      {loading && templates.length === 0 ? (
        <div className="text-xs text-[#9CA3AF] animate-pulse">Loading cutting templates…</div>
      ) : templates.length === 0 ? (
        <div className="text-xs text-[#9CA3AF] italic">
          No cutting template linked for this product
        </div>
      ) : (
        <div className="space-y-1.5">
          {templates.map((t) => (
            <div
              key={t.id}
              className="flex flex-wrap items-center gap-2 bg-white rounded-md px-3 py-2 border border-[#E5E7EB]"
            >
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-[#111827] truncate">{t.displayName}</div>
                <div className="text-[11px] text-[#6B7280] truncate">
                  {[
                    t.sizeLabel,
                    t.totalHeight ? `${t.totalHeight} cm` : "",
                    t.pieceLabel,
                    t.fabricWidth,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {t.hasDgt && <FileButton templateId={t.id} kind="dgt" label="DGT" />}
                {t.hasPrj && <FileButton templateId={t.id} kind="prj" label="PRJ" />}
                {t.hasEmf && <FileButton templateId={t.id} kind="emf" label="EMF" />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default CncTemplatePanel;
