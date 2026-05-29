// ---------------------------------------------------------------------------
// /cnc-templates — CNC Cutting Templates library.
//
// Lists every fabric-cutting file for the BUYI E-DIGIT cutter, grouped by
// product code. Each row exposes DGT / PRJ / EMF download buttons (each an
// anchor to GET /api/cnc-templates/:id/file/:kind, which 302-redirects to the
// real download URL). Client-side search filters the loaded list by
// productCode / displayName / pieceLabel.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useCachedJson } from "@/lib/cached-fetch";
import { Card, CardContent } from "@/components/ui/card";
import { SkeletonTable } from "@/components/ui/skeleton";
import { Scissors, Search } from "lucide-react";
import type { CncTemplate } from "@/components/cnc/CncTemplatePanel";

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

  const { data, loading } = useCachedJson<CncTemplatesResponse>("/api/cnc-templates");

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
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[#9CA3AF]" />
        <input
          type="text"
          placeholder="Search by product code, name, or piece…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-md border border-[#E2DDD8] bg-white pl-8 pr-3 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
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
        <SkeletonTable rows={6} columns={5} />
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
                        <th className="px-3 py-2">Fabric Width</th>
                        <th className="px-3 py-2">Piece</th>
                        <th className="px-3 py-2">Files</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((t) => (
                        <tr key={t.id} className="border-b border-[#F3F4F6] last:border-0">
                          <td className="px-3 py-2 text-[#111827]">{t.displayName}</td>
                          <td className="px-3 py-2 text-[#6B7280]">{t.sizeLabel || "—"}</td>
                          <td className="px-3 py-2 text-[#6B7280]">{t.fabricWidth || "—"}</td>
                          <td className="px-3 py-2 text-[#6B7280]">{t.pieceLabel || "—"}</td>
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
                        </tr>
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
