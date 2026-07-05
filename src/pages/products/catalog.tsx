// ---------------------------------------------------------------------------
// Product Catalog ("Modular") — a FAMILY-based, photo-first view of Products.
//
// Auto-derived: every product FAMILY that exists in Products becomes one tile
// (one tile per family, mirroring the CNC "one Model = one File" logic), so
// nothing is forgotten — add a product, its family shows up here. A family is
// the leading base of the SKU code (see familyOf), one level coarser than the
// stored baseModel: 1003 / 1003(A) / 1003(A)(HF)(W) all collapse into ONE
// "1003" tile, and every size SKU under them. Photos are uploaded per family
// and stored via the existing file system (resourceType="modular",
// resourceId=familyKey) — no backend / schema change. Clicking a tile drills
// in to the family's variants (grouped by their stored baseModel) and their
// size SKUs, each keeping its Production Docs link.
//
// Rendered as a third view mode on the Products page (SKU Master · Catalog ·
// Maintenance). Click a tile to manage its photos and see the SKUs under it.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Box, Images, Upload, Trash2, Loader2, X, FileText, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { PhotoCropDialog } from "@/components/ui/PhotoCropDialog";
import { familyOf } from "@/lib/product-family";
import { uploadFileAsset } from "@/lib/upload-file";

const RT_MODULAR = "modular";

// Minimal product shape this catalog reads. Kept structural (NOT the shared
// @/types Product) so the Products page can pass its own local CatalogProduct[] —
// whose `category` is a plain string — without a type-identity clash under the
// strict build.
type CatalogProduct = {
  id: string;
  code: string;
  name: string;
  category: string;
  baseModel: string;
  sizeLabel: string;
};

type FileAsset = {
  id: string;
  resourceType: string;
  resourceId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
  /** Cover ordering: lowest first (0 = cover). Add-on column, may be null. */
  sortOrder?: number | null;
};

// Cover-first ordering: the file with the lowest sort_order is the cover;
// ties / unset fall back to newest-uploaded first. Shared by the tile grid
// and the catalogue PDF so both agree on which photo is the cover.
function comparePhotos(a: FileAsset, b: FileAsset): number {
  const ao = a.sortOrder ?? 1e9;
  const bo = b.sortOrder ?? 1e9;
  if (ao !== bo) return ao - bo;
  return (b.uploadedAt || "").localeCompare(a.uploadedAt || "");
}

// A config variant inside a family: the stored baseModel (e.g. "1003(A)") and
// its size SKUs underneath. Used to make the drill-down readable.
type ModelVariant = {
  baseModel: string;
  products: CatalogProduct[];
};

type ModelGroup = {
  familyKey: string;
  category: string;
  name: string;
  variantCount: number;
  sizeLabels: string[];
  products: CatalogProduct[];
  /** baseModel sub-groups for the drill-down (e.g. 1003 / 1003(A) / 1003(A)(HF)(W)). */
  variants: ModelVariant[];
};

// One tile per FAMILY (familyOf the code, e.g. 1003 covers 1003 / 1003(A) /
// 1003(A)(HF)(W) and all their sizes). familyOf falls back to the trimmed,
// uppercased code when a code is blank so a stray SKU still surfaces (never
// silently dropped). Inside each family the products are sub-grouped by their
// stored baseModel for a readable drill-down.
function buildModelGroups(products: CatalogProduct[]): ModelGroup[] {
  const map = new Map<string, CatalogProduct[]>();
  for (const p of products) {
    const key = familyOf(p.code) || p.code;
    const arr = map.get(key);
    if (arr) arr.push(p);
    else map.set(key, [p]);
  }
  const groups: ModelGroup[] = [];
  for (const [familyKey, ps] of map) {
    const sizeLabels = Array.from(
      new Set(ps.map((p) => p.sizeLabel).filter((s): s is string => !!s)),
    ).sort();
    // Sub-group by stored baseModel (the config variant) for the drill-down.
    const variantMap = new Map<string, CatalogProduct[]>();
    for (const p of ps) {
      const vKey = p.baseModel || p.code;
      const arr = variantMap.get(vKey);
      if (arr) arr.push(p);
      else variantMap.set(vKey, [p]);
    }
    const variants: ModelVariant[] = Array.from(variantMap.entries())
      .map(([baseModel, vps]) => ({
        baseModel,
        products: vps.slice().sort((a, b) => a.code.localeCompare(b.code)),
      }))
      .sort((a, b) => a.baseModel.localeCompare(b.baseModel));
    groups.push({
      familyKey,
      category: ps[0].category,
      name: ps[0].name,
      variantCount: ps.length,
      sizeLabels,
      products: ps.slice().sort((a, b) => a.code.localeCompare(b.code)),
      variants,
    });
  }
  groups.sort((a, b) =>
    a.category !== b.category
      ? a.category.localeCompare(b.category)
      : a.familyKey.localeCompare(b.familyKey),
  );
  return groups;
}

function titleCase(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

export function ProductCatalog({ products }: { products: CatalogProduct[] }) {
  const { toast } = useToast();
  const [photos, setPhotos] = useState<Record<string, FileAsset[]>>({});
  const [loadingPhotos, setLoadingPhotos] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [openModel, setOpenModel] = useState<ModelGroup | null>(null);

  // ONE request returns every modular photo for the org; group by resourceId
  // (= familyKey) client-side so we don't fire a request per tile.
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
        for (const k of Object.keys(map)) map[k].sort(comparePhotos);
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
      if (q && !`${g.familyKey} ${g.name}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [groups, categoryFilter, search]);

  const withPhotos = filtered.filter((g) => (photos[g.familyKey] ?? []).length > 0).length;

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
              key={`${g.category}:${g.familyKey}`}
              group={g}
              photos={photos[g.familyKey] ?? []}
              onOpen={() => setOpenModel(g)}
            />
          ))}
        </div>
      )}

      {openModel && (
        <ModelDetailDialog
          group={openModel}
          photos={photos[openModel.familyKey] ?? []}
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
            alt={group.familyKey}
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="h-full w-full object-contain group-hover:scale-[1.02] transition-transform"
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
          <span className="text-sm font-semibold text-[#1F1D1B] truncate" title={group.familyKey}>
            {group.familyKey}
          </span>
          <Badge variant="status" status={group.category} />
        </div>
        <p className="text-[11px] text-[#9CA3AF]">
          {group.variants.length > 1 ? `${group.variants.length} variants · ` : ""}
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
  const { confirm } = useConfirm();
  // Crop-on-upload queue (mirrors R&D's PhotoCropDialog flow): each picked
  // file is cropped (square by default) before it's uploaded, so stored
  // photos are already square and fit the tile + catalogue PDF cleanly.
  const [cropQueue, setCropQueue] = useState<File[]>([]);
  const [cropUrl, setCropUrl] = useState<string | null>(null);

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
    let unverified = 0;
    try {
      for (const file of files) {
        // Key the photo by the FAMILY base (e.g. "1003"), not the per-variant
        // baseModel — so ONE photo covers the whole family + all its variants.
        const r = await uploadFileAsset({
          file,
          resourceType: RT_MODULAR,
          resourceId: group.familyKey,
        });
        if (r.ok) {
          ok++;
          if (!r.verified) unverified++;
        } else {
          fail++;
          toast.error(r.error);
        }
      }
      if (ok > 0) toast.success(`${ok} photo${ok === 1 ? "" : "s"} uploaded`);
      if (unverified > 0) {
        toast.error(`${unverified} photo${unverified === 1 ? "" : "s"} can't be opened yet — refresh in a moment and check before using`);
      }
      if (fail > 0 && ok === 0) toast.error("Upload failed");
      onChanged();
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove(f: FileAsset) {
    if (!(await confirm({ title: "Delete photo?", message: `Delete "${f.filename}"?`, danger: true }))) return;
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

  async function setCover(f: FileAsset) {
    setBusy(true);
    try {
      const res = await fetch(`/api/files/${f.id}/cover`, { method: "PATCH" });
      const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (!res.ok || !j?.success) { toast.error(j?.error || "Could not set cover"); return; }
      toast.success("Cover updated");
      onChanged();
    } catch {
      toast.error("Could not set cover — network error");
    } finally {
      setBusy(false);
    }
  }

  const readFileAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = reject;
      r.readAsDataURL(file);
    });

  // Open the crop dialog for the first file in the queue (or finish + reset).
  async function advanceCrop(queue: File[]) {
    if (queue.length === 0) {
      setCropUrl(null);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    try {
      setCropUrl(await readFileAsDataUrl(queue[0]));
    } catch {
      toast.error("Could not read the image file.");
      setCropUrl(null);
    }
  }

  function startCropQueue(files: File[]) {
    if (files.length === 0) return;
    setCropQueue(files);
    void advanceCrop(files);
  }

  async function onCropConfirm(croppedDataUrl: string) {
    const current = cropQueue[0];
    setCropUrl(null);
    try {
      const blob = await (await fetch(croppedDataUrl)).blob();
      const base = (current?.name || "photo").replace(/\.[^.]+$/, "");
      const file = new File([blob], `${base}.jpg`, { type: "image/jpeg" });
      await uploadFiles([file]);
    } catch {
      toast.error("Could not process the cropped image.");
    }
    const rest = cropQueue.slice(1);
    setCropQueue(rest);
    void advanceCrop(rest);
  }

  function onCropCancel() {
    const rest = cropQueue.slice(1);
    setCropUrl(null);
    setCropQueue(rest);
    void advanceCrop(rest);
  }

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={() => !busy && onClose()} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white z-10 flex items-center justify-between p-5 border-b border-[#E2DDD8]">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-[#1F1D1B]">{group.familyKey}</h2>
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
                onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) startCropQueue(fs); }}
              />
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Upload Photos
              </Button>
            </div>
            {photos.length === 0 ? (
              <div className="rounded-md border border-dashed border-[#D8CFC0] bg-[#FAF9F7] p-8 text-center text-sm text-[#9CA3AF]">
                No photos yet. Upload product photos so anyone can recognise this family at a glance — one photo here covers every variant and size under it.
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {photos.map((f, idx) => (
                  <div key={f.id} className="relative group rounded-md overflow-hidden border border-[#E2DDD8] bg-[#FAF9F7]">
                    <a href={`/api/files/${f.id}/download`} target="_blank" rel="noreferrer" title={f.filename}>
                      <img
                        src={`/api/files/${f.id}/download`}
                        alt={f.filename}
                        loading="lazy"
                        className="aspect-square w-full object-contain"
                      />
                    </a>
                    {idx === 0 ? (
                      <span className="absolute top-1 left-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#6B5C32] text-white shadow-sm">
                        <Star className="h-2.5 w-2.5 fill-current" /> Cover
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setCover(f)}
                        disabled={busy}
                        title="Set as cover"
                        className="absolute top-1 left-1 p-1 rounded-md bg-black/55 text-white opacity-0 group-hover:opacity-100 hover:bg-[#6B5C32] transition-opacity"
                      >
                        <Star className="h-3.5 w-3.5" />
                      </button>
                    )}
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

          {/* Variants + SKUs under this family. Each stored baseModel (config
              variant, e.g. 1003 / 1003(A) / 1003(A)(HF)(W)) is a sub-group,
              with its size SKUs listed under it — so the drill-down reads
              top-down: family → variant → size, each keeping its Docs link. */}
          <div>
            <h3 className="text-sm font-semibold text-[#374151] mb-2">
              {group.variants.length > 1
                ? `Variants in this family (${group.variants.length}) · ${group.products.length} SKU${group.products.length === 1 ? "" : "s"}`
                : `SKUs in this family (${group.products.length})`}
            </h3>
            <div className="space-y-3">
              {group.variants.map((v) => (
                <div key={v.baseModel} className="rounded-md border border-[#E2DDD8] overflow-hidden">
                  {group.variants.length > 1 && (
                    <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-[#FAF9F7] border-b border-[#F0ECE9]">
                      <span className="text-xs font-semibold text-[#6B5C32]" title={v.baseModel}>
                        {v.baseModel}
                      </span>
                      <span className="text-[10px] text-[#9CA3AF]">
                        {v.products.length} SKU{v.products.length === 1 ? "" : "s"}
                      </span>
                    </div>
                  )}
                  <div className="divide-y divide-[#F0ECE9]">
                    {v.products.map((p) => (
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
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
    {cropUrl && (
      <PhotoCropDialog
        open
        imageDataUrl={cropUrl}
        aspectRatio={null}
        onConfirm={onCropConfirm}
        onCancel={onCropCancel}
      />
    )}
    </>
  );
}

export default ProductCatalog;
