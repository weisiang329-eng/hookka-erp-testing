// ---------------------------------------------------------------------------
// Product Catalog ("Modular") — a Model-based, photo-first view of Products.
//
// Auto-derived: every baseModel that exists in Products becomes one Modular
// tile (one tile per Model, mirroring the CNC "one Model = one File" logic),
// so nothing is forgotten — add a product, its model shows up here. Photos are
// uploaded per Model and stored via the existing file system
// (resourceType="modular", resourceId=baseModel) — no backend / schema change.
//
// Rendered as a third view mode on the Products page (SKU Master · Catalog ·
// Maintenance). Click a tile to manage its photos and see the SKUs under it.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Box, Images, Upload, Trash2, Loader2, X, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import type { Product } from "@/types";

const RT_MODULAR = "modular";

type FileAsset = {
  id: string;
  resourceType: string;
  resourceId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
};

type ModelGroup = {
  baseModel: string;
  category: string;
  name: string;
  variantCount: number;
  sizeLabels: string[];
  products: Product[];
};

// One Modular per baseModel. Falls back to the product code when a product has
// no baseModel so a stray SKU still surfaces (never silently dropped).
function buildModelGroups(products: Product[]): ModelGroup[] {
  const map = new Map<string, Product[]>();
  for (const p of products) {
    const key = p.baseModel || p.code;
    const arr = map.get(key);
    if (arr) arr.push(p);
    else map.set(key, [p]);
  }
  const groups: ModelGroup[] = [];
  for (const [baseModel, ps] of map) {
    const sizeLabels = Array.from(
      new Set(ps.map((p) => p.sizeLabel).filter((s): s is string => !!s)),
    ).sort();
    groups.push({
      baseModel,
      category: ps[0].category,
      name: ps[0].name,
      variantCount: ps.length,
      sizeLabels,
      products: ps.slice().sort((a, b) => a.code.localeCompare(b.code)),
    });
  }
  groups.sort((a, b) =>
    a.category !== b.category
      ? a.category.localeCompare(b.category)
      : a.baseModel.localeCompare(b.baseModel),
  );
  return groups;
}

function titleCase(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

export function ProductCatalog({ products }: { products: Product[] }) {
  const { toast } = useToast();
  const [photos, setPhotos] = useState<Record<string, FileAsset[]>>({});
  const [loadingPhotos, setLoadingPhotos] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [openModel, setOpenModel] = useState<ModelGroup | null>(null);

  // ONE request returns every modular photo for the org; group by resourceId
  // (= baseModel) client-side so we don't fire a request per tile.
  const reloadPhotos = useCallback(async () => {
    try {
      const res = await fetch(`/api/files?resourceType=${RT_MODULAR}`);
      const j = (await res.json().catch(() => null)) as { success?: boolean; data?: FileAsset[] } | null;
      if (res.ok && j?.success && Array.isArray(j.data)) {
        const map: Record<string, FileAsset[]> = {};
        for (const f of j.data) {
          const arr = map[f.resourceId];
          if (arr) arr.push(f);
          else map[f.resourceId] = [f];
        }
        setPhotos(map);
      }
    } catch {
      /* leave existing; per-action errors surface on upload/delete */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await reloadPhotos();
      if (!cancelled) setLoadingPhotos(false);
    })();
    return () => { cancelled = true; };
  }, [reloadPhotos]);

  const groups = useMemo(() => buildModelGroups(products), [products]);
  const categories = useMemo(
    () => ["ALL", ...Array.from(new Set(groups.map((g) => g.category))).sort()],
    [groups],
  );
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return groups.filter((g) => {
      if (categoryFilter !== "ALL" && g.category !== categoryFilter) return false;
      if (q && !`${g.baseModel} ${g.name}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [groups, categoryFilter, search]);

  const withPhotos = filtered.filter((g) => (photos[g.baseModel] ?? []).length > 0).length;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex bg-[#F3F4F6] rounded-lg p-0.5">
          {categories.map((cat) => {
            const active = categoryFilter === cat;
            return (
              <button
                key={cat}
                onClick={() => setCategoryFilter(cat)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  active ? "bg-white text-[#111827] shadow-sm" : "text-[#6B7280] hover:text-[#111827]"
                }`}
              >
                {cat === "ALL" ? "All" : titleCase(cat)}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-[#9CA3AF]">
            {filtered.length} model{filtered.length === 1 ? "" : "s"} · {withPhotos} with photos
          </span>
          <div className="relative">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search models..."
              className="pl-3 pr-7 py-1.5 rounded-md text-xs border border-[#E5E7EB] bg-white focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/30 w-52"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-[#9CA3AF] hover:text-[#111827]"
                title="Clear search"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>

      {loadingPhotos ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-6 w-6 animate-spin text-[#6B5C32]" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-[#E5E7EB] bg-white p-10 text-center text-sm text-[#9CA3AF]">
          No models match.
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {filtered.map((g) => (
            <ModelTile
              key={`${g.category}:${g.baseModel}`}
              group={g}
              photos={photos[g.baseModel] ?? []}
              onOpen={() => setOpenModel(g)}
            />
          ))}
        </div>
      )}

      {openModel && (
        <ModelDetailDialog
          group={openModel}
          photos={photos[openModel.baseModel] ?? []}
          onClose={() => setOpenModel(null)}
          onChanged={reloadPhotos}
          toast={toast}
        />
      )}
    </div>
  );
}

// One catalog tile = one Model. Cover = first photo (inline; <img> ignores the
// download disposition), placeholder otherwise. Click to manage.
function ModelTile({
  group, photos, onOpen,
}: {
  group: ModelGroup;
  photos: FileAsset[];
  onOpen: () => void;
}) {
  const cover = photos[0];
  const [imgFailed, setImgFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group text-left rounded-lg border border-[#E5E7EB] bg-white overflow-hidden hover:shadow-md hover:border-[#D8CFC0] transition-all"
    >
      <div className="relative aspect-[4/3] bg-[#FAF9F7] flex items-center justify-center overflow-hidden">
        {cover && !imgFailed ? (
          <img
            src={`/api/files/${cover.id}/download`}
            alt={group.baseModel}
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="h-full w-full object-cover group-hover:scale-[1.02] transition-transform"
          />
        ) : (
          <div className="flex flex-col items-center gap-1 text-[#C4BCAF]">
            <Box className="h-8 w-8" strokeWidth={1.5} />
            <span className="text-[10px] uppercase tracking-wide">
              {cover ? "Preview unavailable" : "No photo"}
            </span>
          </div>
        )}
        {photos.length > 0 && (
          <span className="absolute top-1.5 right-1.5 inline-flex items-center gap-1 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white">
            <Images className="h-3 w-3" /> {photos.length}
          </span>
        )}
      </div>
      <div className="p-2.5 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-[#1F1D1B] truncate" title={group.baseModel}>
            {group.baseModel}
          </span>
          <Badge variant="status" status={group.category} />
        </div>
        <p className="text-[11px] text-[#6B7280] truncate" title={group.name}>{group.name}</p>
        <p className="text-[11px] text-[#9CA3AF]">
          {group.variantCount} SKU{group.variantCount === 1 ? "" : "s"}
          {group.sizeLabels.length > 0 ? ` · ${group.sizeLabels.slice(0, 4).join(", ")}${group.sizeLabels.length > 4 ? "…" : ""}` : ""}
        </p>
      </div>
    </button>
  );
}

// Manage one Model's photos + see the SKUs under it.
function ModelDetailDialog({
  group, photos, onClose, onChanged, toast,
}: {
  group: ModelGroup;
  photos: FileAsset[];
  onClose: () => void;
  onChanged: () => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setBusy(true);
    let ok = 0;
    let fail = 0;
    try {
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("resourceType", RT_MODULAR);
        fd.append("resourceId", group.baseModel);
        const res = await fetch("/api/files", { method: "POST", body: fd });
        const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
        if (res.ok && j?.success) ok++;
        else { fail++; if (j?.error) toast.error(j.error); }
      }
      if (ok > 0) toast.success(`${ok} photo${ok === 1 ? "" : "s"} uploaded`);
      if (fail > 0 && ok === 0) toast.error("Upload failed");
      onChanged();
    } catch {
      toast.error("Upload failed — network error");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove(f: FileAsset) {
    if (!window.confirm(`Delete "${f.filename}"?`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/files/${f.id}`, { method: "DELETE" });
      const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (!res.ok || !j?.success) { toast.error(j?.error || "Delete failed"); return; }
      toast.success("Deleted");
      onChanged();
    } catch {
      toast.error("Delete failed — network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={() => !busy && onClose()} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white z-10 flex items-center justify-between p-5 border-b border-[#E2DDD8]">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-[#1F1D1B]">{group.baseModel}</h2>
            <Badge variant="status" status={group.category} />
            <span className="text-xs text-[#9CA3AF]">{group.name}</span>
          </div>
          <button type="button" onClick={() => !busy && onClose()} className="text-[#9CA3AF] hover:text-[#374151]">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Photos */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-[#374151]">Photos</h3>
              <input
                ref={inputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/heic"
                multiple
                className="hidden"
                onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) uploadFiles(fs); }}
              />
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Upload Photos
              </Button>
            </div>
            {photos.length === 0 ? (
              <div className="rounded-md border border-dashed border-[#D8CFC0] bg-[#FAF9F7] p-8 text-center text-sm text-[#9CA3AF]">
                No photos yet. Upload product photos so anyone can recognise this model at a glance.
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {photos.map((f) => (
                  <div key={f.id} className="relative group rounded-md overflow-hidden border border-[#E2DDD8] bg-[#FAF9F7]">
                    <a href={`/api/files/${f.id}/download`} target="_blank" rel="noreferrer" title={f.filename}>
                      <img
                        src={`/api/files/${f.id}/download`}
                        alt={f.filename}
                        loading="lazy"
                        className="aspect-square w-full object-cover"
                      />
                    </a>
                    <button
                      type="button"
                      onClick={() => remove(f)}
                      disabled={busy}
                      title="Delete photo"
                      className="absolute top-1 right-1 p-1 rounded-md bg-black/55 text-white opacity-0 group-hover:opacity-100 hover:bg-[#9A3A2D] transition-opacity"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* SKUs under this model */}
          <div>
            <h3 className="text-sm font-semibold text-[#374151] mb-2">
              SKUs in this model ({group.products.length})
            </h3>
            <div className="rounded-md border border-[#E2DDD8] divide-y divide-[#F0ECE9]">
              {group.products.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[#1F1D1B] truncate">{p.code}</div>
                    <div className="text-[11px] text-[#6B7280] truncate">
                      {p.sizeLabel || "—"}{p.name ? ` · ${p.name}` : ""}
                    </div>
                  </div>
                  <Link
                    to={`/products/${p.id}/documents`}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-[#6B5C32] bg-[#F0ECE9] border border-[#D8CFC0] hover:bg-[#E8E2D9] transition-colors shrink-0"
                    onClick={onClose}
                  >
                    <FileText className="h-3 w-3" /> Docs
                  </Link>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ProductCatalog;
