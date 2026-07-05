// ---------------------------------------------------------------------------
// Product Document Library ("Production Docs") — per-variant.
//
// Organised around the CNC Cutting Template (the single source of truth for a
// model's cutting files, owned by the CNC Template module). Everything a new
// hire needs for a model sits in two stacked sections:
//
//   1. CNC Cutting Template — the model's fabric AND wood cutting files, linked
//      READ-ONLY from the CNC Template module. Uploads happen there, never
//      here, so there is exactly one place a cutting file can live.
//   2. Supporting Documents — reference docs that are NOT machine cutting files
//      (sewing diagram, foam specs, frame assembly), uploaded straight to the
//      product and placed under the CNC Cutting Template.
//
// Storage for the supporting docs: reuses the existing file system (POST/GET/
// DELETE /api/files → Supabase Storage, images + PDF, 50 MB). Each slot is
// namespaced by resourceType = "product:<category>", resourceId = product.id,
// so ALL of a product's docs come back in ONE GET /api/files?resourceId=<id>
// and we group them client-side. No backend change.
//
// Export pack bundles everything into one PDF for onboarding.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft, FileText, Upload, Trash2, Eye, Scissors, TreePine,
  Cpu, Loader2, Download, ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cachedFetchJson } from "@/lib/cached-fetch";
import { uploadFileAsset } from "@/lib/upload-file";
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

// Client shape from GET /api/cnc-templates. `material` splits the model's
// cutting files into the fabric cutter (BUYI E-DIGIT) vs the wood router.
type CncTemplate = {
  id: string;
  productCode: string;
  sizeLabel: string;
  pieceLabel: string;
  displayName: string;
  material: "fabric" | "wood";
  hasDgt: boolean;
  hasPrj: boolean;
  hasEmf: boolean;
};

type SlotDef = { key: string; label: string; hint?: string };

// Supporting documents that live UNDER the CNC Cutting Template. These are
// reference docs (not machine cutting files) uploaded straight to the product.
// The cutting files themselves are owned by the CNC Template module and shown
// read-only above — never re-uploaded here (single source of truth). Labels are
// English (UI rule); keys are stable resourceType suffixes — do NOT rename once
// docs exist.
const DOC_SLOTS: SlotDef[] = [
  { key: "sewing", label: "Sewing Diagram" },
  { key: "foam-specs", label: "Foam Specs / Cutting Sheet" },
  { key: "wood-frame", label: "Frame Assembly" },
];

const ALL_SLOT_KEYS = DOC_SLOTS.map((s) => s.key);

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

      {/* Section 1 — CNC Cutting Template (the anchor; cutting files live in the
          CNC Template module and are shown here read-only, fabric + wood). */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Cpu className="h-4 w-4 text-[#4B5563]" /> CNC Cutting Template
              </CardTitle>
              <p className="text-xs text-[#9CA3AF] mt-1">
                Linked from the CNC Template module — the single home for this model&apos;s cutting files.
              </p>
            </div>
            <Link to={`/cnc-templates?model=${encodeURIComponent(product.baseModel || product.code)}`}>
              <Button type="button" variant="outline" size="sm">
                <ExternalLink className="h-3.5 w-3.5" /> Open in CNC Template
              </Button>
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          <CncSlots product={product} />
        </CardContent>
      </Card>

      {/* Section 2 — Supporting documents, placed under the CNC Cutting
          Template. Reference material a new hire studies, uploaded here. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FileText className="h-4 w-4 text-[#6B5C32]" /> Supporting Documents
          </CardTitle>
          <p className="text-xs text-[#9CA3AF] mt-1">
            Reference docs for this model — sewing, foam and frame guides.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {DOC_SLOTS.map((slot) => (
              <DocSlot
                key={slot.key}
                productId={product.id}
                slot={slot}
                files={bySlot[slot.key] ?? []}
                onChanged={() => reloadFiles(product.id)}
                toast={toast}
              />
            ))}
          </div>
        </CardContent>
      </Card>
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
  const { confirm } = useConfirm();

  async function upload(file: File) {
    setBusy(true);
    try {
      const r = await uploadFileAsset({
        file,
        resourceType: `${RT_PREFIX}${slot.key}`,
        resourceId: productId,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      if (r.verified) {
        toast.success(`${slot.label}: uploaded`);
      } else {
        // Row saved but bytes not yet servable — never claim clean success.
        toast.error(`${slot.label}: uploaded, but it can't be opened yet — wait a few seconds and check it opens before using it`);
      }
      onChanged();
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove(f: FileAsset) {
    if (!(await confirm({ title: "Delete file?", message: `Delete "${f.filename}"?`, danger: true }))) return;
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

// ---- CNC cutting files (read-only, linked from the CNC Template module) ----
// The model's cutting files split into Fabric (BUYI E-DIGIT cutter) and Wood
// (router). Both come from /api/cnc-templates — the single source of truth — so
// there is no upload here; the "Open in CNC Template" button manages them.
function CncSlots({ product }: { product: Product }) {
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

  const fabric = useMemo(() => cncFiles.filter((t) => t.material !== "wood"), [cncFiles]);
  const wood = useMemo(() => cncFiles.filter((t) => t.material === "wood"), [cncFiles]);

  if (loadingCnc) {
    return <Loader2 className="h-4 w-4 animate-spin text-[#6B5C32]" />;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <CncMaterialList
        label="Fabric Cutting Files"
        icon={<Scissors className="h-3.5 w-3.5 text-[#6B5C32]" />}
        templates={fabric}
        emptyText={`No fabric cutting files for ${model} yet.`}
      />
      <CncMaterialList
        label="Wood Cutting Files"
        icon={<TreePine className="h-3.5 w-3.5 text-[#7A5C3A]" />}
        templates={wood}
        emptyText={`No wood cutting files for ${model} yet.`}
      />
    </div>
  );
}

// One material column (Fabric or Wood) of the CNC Cutting Template section.
function CncMaterialList({
  label, icon, templates, emptyText,
}: {
  label: string;
  icon: ReactNode;
  templates: CncTemplate[];
  emptyText: string;
}) {
  const kinds: Array<{ k: "dgt" | "prj" | "emf"; has: (t: CncTemplate) => boolean }> = [
    { k: "dgt", has: (t) => t.hasDgt },
    { k: "prj", has: (t) => t.hasPrj },
    { k: "emf", has: (t) => t.hasEmf },
  ];

  return (
    <div className="rounded-md border border-[#E2DDD8] p-3">
      <div className="flex items-center gap-2 mb-2 text-sm font-medium text-[#374151]">
        {icon} {label}
        <span className="text-[#9CA3AF] font-normal text-xs ml-auto">{templates.length} file{templates.length === 1 ? "" : "s"}</span>
      </div>
      {templates.length === 0 ? (
        <p className="text-xs text-[#9CA3AF] italic">{emptyText}</p>
      ) : (
        <ul className="space-y-1">
          {templates.map((t) => (
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
  );
}

// Bundle every uploaded supporting doc (ordered by slot) into one study PDF.
// pdf-lib is dynamically imported inside the generator so it stays out of the
// initial bundle. CNC cutter files (.dgt/.prj/.emf) are machine files, not
// study material, so they're intentionally excluded.
async function exportPack(
  product: Product,
  files: FileAsset[],
  setExporting: (b: boolean) => void,
  toast: ReturnType<typeof useToast>["toast"],
) {
  const labelByKey: Record<string, string> = {};
  DOC_SLOTS.forEach((s) => { labelByKey[s.key] = s.label; });
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
