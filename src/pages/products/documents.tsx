// ---------------------------------------------------------------------------
// Product Document Library ("Production Docs") — per-variant.
//
// Every product variant (e.g. 5530-1A) carries a categorised set of
// production documents so a new hire can pull up everything for the model
// they're assigned and start working: fabric layout + sewing diagram, foam
// assembly + specs, wood specs + frame assembly, the CNC cut files (linked
// from the CNC Template module — single source of truth), plus a construction
// guide and a product walkthrough.
//
// Storage: reuses the existing file system (POST/GET/DELETE /api/files →
// Supabase Storage, images + PDF, 50 MB). Each slot is namespaced by
// resourceType = "product:<category>", resourceId = product.id, so ALL of a
// product's docs come back in ONE GET /api/files?resourceId=<id> and we group
// them client-side. No backend change.
//
// CNC slots (Stage 2) link to the CNC Template module rather than re-uploading.
// Export pack (Stage 3) bundles everything into one PDF for onboarding.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft, FileText, Upload, Trash2, Eye, Scissors, Layers, TreePine,
  Cpu, GraduationCap, Loader2, Download, ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { cachedFetchJson } from "@/lib/cached-fetch";
import type { Product } from "@/types";

const RT_PREFIX = "product:";

type FileAsset = {
  id: string;
  resourceType: string;
  resourceId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
};

// Client shape from GET /api/cnc-templates (fabric cutter files for a model).
type CncTemplate = {
  id: string;
  productCode: string;
  sizeLabel: string;
  pieceLabel: string;
  displayName: string;
  hasDgt: boolean;
  hasPrj: boolean;
  hasEmf: boolean;
};

type SlotDef = { key: string; label: string; hint?: string };
type GroupDef = {
  title: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: any;
  accent: string;
  slots: SlotDef[];
  // CNC group is special — files live in the CNC Template module, not here.
  cncLink?: boolean;
};

// The fixed taxonomy the owner described. Labels are English (UI rule); the
// keys are stable resourceType suffixes — do NOT rename once docs exist.
const GROUPS: GroupDef[] = [
  {
    title: "Fabric",
    icon: Scissors,
    accent: "#6B5C32",
    slots: [
      { key: "fabric-layout", label: "Fabric Layout", hint: "排版图" },
      { key: "sewing", label: "Sewing Diagram", hint: "车工图" },
    ],
  },
  {
    title: "Foam",
    icon: Layers,
    accent: "#8A6D3B",
    slots: [
      { key: "foam-assembly", label: "Foam Assembly", hint: "拼凑图" },
      { key: "foam-specs", label: "Foam Specs / Cutting Sheet", hint: "规格" },
    ],
  },
  {
    title: "Wood",
    icon: TreePine,
    accent: "#7A5C3A",
    slots: [
      { key: "wood-specs", label: "Wood Specs", hint: "木材规格" },
      { key: "wood-frame", label: "Frame Assembly", hint: "木架组装图" },
    ],
  },
  {
    title: "CNC Cut Files",
    icon: Cpu,
    accent: "#4B5563",
    cncLink: true,
    slots: [
      { key: "cnc-fabric", label: "Fabric CNC" },
      { key: "cnc-wood", label: "Wood CNC" },
    ],
  },
  {
    title: "Onboarding",
    icon: GraduationCap,
    accent: "#2F6F4F",
    slots: [
      { key: "construction", label: "Construction Guide", hint: "施工图" },
      { key: "walkthrough", label: "Product Walkthrough", hint: "产品讲解" },
    ],
  },
];

const ALL_SLOT_KEYS = GROUPS.flatMap((g) => g.slots.map((s) => s.key));

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export default function ProductDocumentsPage() {
  const { id } = useParams();
  const { toast } = useToast();
  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [files, setFiles] = useState<FileAsset[]>([]);
  const [exporting, setExporting] = useState(false);

  // ONE call for all of this product's docs; group by category suffix.
  const reloadFiles = useCallback(async (productId: string) => {
    try {
      const res = await fetch(`/api/files?resourceId=${encodeURIComponent(productId)}`);
      const j = (await res.json().catch(() => null)) as { success?: boolean; data?: FileAsset[] } | null;
      if (res.ok && j?.success && Array.isArray(j.data)) {
        setFiles(j.data.filter((f) => f.resourceType.startsWith(RT_PREFIX)));
      }
    } catch {
      // leave existing list; per-action errors are surfaced on upload/delete
    }
  }, []);

  // Load the product + its documents on mount (mirrors bom.tsx). setState runs
  // inside the async IIFE so it's deferred, not a synchronous effect-body set.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pData = await cachedFetchJson<{ success?: boolean; data?: Product[] }>("/api/products");
        if (cancelled) return;
        const found =
          (pData?.success && Array.isArray(pData.data)
            ? pData.data.find((p) => p.id === id) || pData.data.find((p) => p.code === id)
            : null) ?? null;
        setProduct(found);
        if (found?.id) await reloadFiles(found.id);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id, reloadFiles]);

  const bySlot = useMemo(() => {
    const map: Record<string, FileAsset[]> = {};
    for (const k of ALL_SLOT_KEYS) map[k] = [];
    for (const f of files) {
      const cat = f.resourceType.slice(RT_PREFIX.length);
      if (map[cat]) map[cat].push(f);
    }
    return map;
  }, [files]);

  const totalDocs = files.length;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-[#6B5C32]" />
      </div>
    );
  }

  if (!product) {
    return (
      <div className="space-y-6">
        <Link to="/products" className="inline-flex items-center gap-2 text-sm text-[#6B5C32] hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to Products
        </Link>
        <Card><CardContent className="py-12 text-center text-[#9CA3AF]">Product not found.</CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link to="/products" className="inline-flex items-center gap-2 text-sm text-[#6B5C32] hover:underline">
        <ArrowLeft className="h-4 w-4" /> Back to Products
      </Link>

      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-[#1F1D1B]">{product.code}</h1>
            <Badge variant="status" status={product.category} />
          </div>
          <p className="text-xs text-[#6B7280] mt-0.5">
            {product.name}
            <span className="text-[#9CA3AF]"> · Production Docs · {totalDocs} file{totalDocs === 1 ? "" : "s"}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to={`/products/${product.id}/bom`}>
            <Button type="button" variant="outline" size="sm"><FileText className="h-3.5 w-3.5" /> BOM</Button>
          </Link>
          <Button
            type="button"
            size="sm"
            onClick={() => exportPack(product, files, setExporting, toast)}
            disabled={exporting || totalDocs === 0}
            className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
            title={totalDocs === 0 ? "Upload documents first" : "Bundle every document into one PDF a new hire can study"}
          >
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {exporting ? "Building…" : "Export Pack"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {GROUPS.map((g) => (
          <Card key={g.title}>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <g.icon className="h-4 w-4" style={{ color: g.accent }} /> {g.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {g.cncLink ? (
                <CncSlots
                  product={product}
                  woodFiles={bySlot["cnc-wood"] ?? []}
                  onChanged={() => reloadFiles(product.id)}
                  toast={toast}
                />
              ) : (
                g.slots.map((slot) => (
                  <DocSlot
                    key={slot.key}
                    productId={product.id}
                    slot={slot}
                    files={bySlot[slot.key] ?? []}
                    onChanged={() => reloadFiles(product.id)}
                    toast={toast}
                  />
                ))
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ---- One upload slot (a category) ----
function DocSlot({
  productId, slot, files, onChanged, toast,
}: {
  productId: string;
  slot: SlotDef;
  files: FileAsset[];
  onChanged: () => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("resourceType", `${RT_PREFIX}${slot.key}`);
      fd.append("resourceId", productId);
      const res = await fetch("/api/files", { method: "POST", body: fd });
      const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (!res.ok || !j?.success) {
        toast.error(j?.error || `Upload failed (${res.status})`);
        return;
      }
      toast.success(`${slot.label}: uploaded`);
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
      if (!res.ok || !j?.success) {
        toast.error(j?.error || `Delete failed (${res.status})`);
        return;
      }
      toast.success("Deleted");
      onChanged();
    } catch {
      toast.error("Delete failed — network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-[#E2DDD8] p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium text-[#374151]">
          {slot.label}
          {slot.hint ? <span className="text-[#9CA3AF] font-normal ml-1.5 text-xs">{slot.hint}</span> : null}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/heic,application/pdf"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }}
        />
        <Button
          type="button" variant="outline" size="sm" disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Upload
        </Button>
      </div>
      {files.length === 0 ? (
        <p className="text-xs text-[#9CA3AF] italic">No file yet.</p>
      ) : (
        <ul className="space-y-1">
          {files.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-2 text-sm rounded bg-[#FAF9F7] px-2 py-1.5">
              <span className="flex items-center gap-2 min-w-0">
                <FileText className="h-3.5 w-3.5 text-[#6B5C32] shrink-0" />
                <span className="truncate text-[#1F1D1B]" title={f.filename}>{f.filename}</span>
                <span className="text-[#9CA3AF] text-xs shrink-0">{fmtSize(f.sizeBytes)}</span>
              </span>
              <span className="flex items-center gap-1 shrink-0">
                <a
                  href={`/api/files/${f.id}/download`} target="_blank" rel="noreferrer"
                  className="p-1 rounded hover:bg-[#E2DDD8] text-[#6B5C32]" title="View / download"
                >
                  <Eye className="h-3.5 w-3.5" />
                </a>
                <button
                  type="button" onClick={() => remove(f)} disabled={busy}
                  className="p-1 rounded hover:bg-[#9A3A2D]/10 text-[#9A3A2D]" title="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- CNC slots ----
// Fabric CNC = the model's cutter files, linked READ-ONLY from the CNC Template
// module (single source of truth — the BUYI fabric cutter owns .dgt/.prj/.emf).
// Wood CNC = uploaded directly to the product (wood router files are a different
// format and aren't in the fabric-cutter module; the slot sits ready until you
// have them).
function CncSlots({
  product, woodFiles, onChanged, toast,
}: {
  product: Product;
  woodFiles: FileAsset[];
  onChanged: () => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const model = product.baseModel || product.code;
  const [cncFiles, setCncFiles] = useState<CncTemplate[]>([]);
  const [loadingCnc, setLoadingCnc] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/cnc-templates?productCode=${encodeURIComponent(model)}`);
        const j = (await res.json().catch(() => null)) as { success?: boolean; data?: CncTemplate[] } | null;
        if (!cancelled && res.ok && j?.success && Array.isArray(j.data)) setCncFiles(j.data);
      } catch {
        /* leave empty */
      } finally {
        if (!cancelled) setLoadingCnc(false);
      }
    })();
    return () => { cancelled = true; };
  }, [model]);

  const kinds: Array<{ k: "dgt" | "prj" | "emf"; has: (t: CncTemplate) => boolean }> = [
    { k: "dgt", has: (t) => t.hasDgt },
    { k: "prj", has: (t) => t.hasPrj },
    { k: "emf", has: (t) => t.hasEmf },
  ];

  return (
    <div className="space-y-4">
      {/* Fabric CNC — linked from the CNC Template module */}
      <div className="rounded-md border border-[#E2DDD8] p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-medium text-[#374151]">
            Fabric CNC <span className="text-[#9CA3AF] font-normal text-xs ml-1">from CNC Template</span>
          </div>
          <Link to={`/cnc-templates?model=${encodeURIComponent(model)}`}>
            <Button type="button" variant="outline" size="sm"><ExternalLink className="h-3.5 w-3.5" /> Open</Button>
          </Link>
        </div>
        {loadingCnc ? (
          <Loader2 className="h-4 w-4 animate-spin text-[#6B5C32]" />
        ) : cncFiles.length === 0 ? (
          <p className="text-xs text-[#9CA3AF] italic">No fabric CNC files for {model} yet.</p>
        ) : (
          <ul className="space-y-1">
            {cncFiles.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2 text-sm rounded bg-[#FAF9F7] px-2 py-1.5">
                <span className="flex items-center gap-2 min-w-0">
                  <Cpu className="h-3.5 w-3.5 text-[#4B5563] shrink-0" />
                  <span className="truncate text-[#1F1D1B]" title={t.displayName}>
                    {t.pieceLabel || t.displayName || "Template"}
                    {t.sizeLabel ? <span className="text-[#9CA3AF]"> · {t.sizeLabel}</span> : null}
                  </span>
                </span>
                <span className="flex items-center gap-1 shrink-0">
                  {kinds.filter((kd) => kd.has(t)).map((kd) => (
                    <a
                      key={kd.k}
                      href={`/api/cnc-templates/${t.id}/file/${kd.k}`}
                      target="_blank" rel="noreferrer"
                      className="px-1.5 py-0.5 rounded bg-[#E0EDF0] text-[#3E6570] text-[10px] font-semibold uppercase hover:bg-[#cfe3e8]"
                      title={`Download ${kd.k.toUpperCase()}`}
                    >
                      {kd.k}
                    </a>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Wood CNC — uploaded to the product (not in the fabric-cutter module) */}
      <DocSlot
        productId={product.id}
        slot={{ key: "cnc-wood", label: "Wood CNC", hint: "木 — router files" }}
        files={woodFiles}
        onChanged={onChanged}
        toast={toast}
      />
    </div>
  );
}

// Bundle every uploaded doc (ordered by the category groups) into one study
// PDF. pdf-lib is dynamically imported inside the generator so it stays out of
// the initial bundle. CNC cutter files (.dgt/.prj/.emf) are machine files, not
// study material, so they're intentionally excluded.
async function exportPack(
  product: Product,
  files: FileAsset[],
  setExporting: (b: boolean) => void,
  toast: ReturnType<typeof useToast>["toast"],
) {
  const labelByKey: Record<string, string> = {};
  GROUPS.forEach((g) => g.slots.forEach((s) => { labelByKey[s.key] = `${g.title} · ${s.label}`; }));
  const ordered = ALL_SLOT_KEYS.flatMap((k) =>
    files
      .filter((f) => f.resourceType === `${RT_PREFIX}${k}`)
      .map((f) => ({ id: f.id, filename: f.filename, contentType: f.contentType, categoryLabel: labelByKey[k] || k })),
  );
  if (ordered.length === 0) {
    toast.error("No documents to export yet.");
    return;
  }
  setExporting(true);
  try {
    const { generateProductPackPdf } = await import("@/lib/generate-product-pack-pdf");
    await generateProductPackPdf(
      { code: product.code, name: product.name, category: product.category },
      ordered,
    );
    toast.success("Study pack downloaded");
  } catch {
    toast.error("Could not build the study pack.");
  } finally {
    setExporting(false);
  }
}
