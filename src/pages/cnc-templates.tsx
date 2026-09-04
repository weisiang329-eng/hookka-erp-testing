// ---------------------------------------------------------------------------
// /cnc-templates — CNC Cutting Templates library (two-level drill-down).
//
// Level 1  Models      — every bedframe / sofa model (from the product
//                        catalogue, plus any model that already has files),
//                        grouped by Bedframe / Sofa / Other.
// Level 2  Size / seat — click a model to open its size buckets:
//                          · BEDFRAME → Single / Super Single / Queen / King
//                            (always shown, even when empty, so the operator
//                            can fill them in).
//                          · SOFA     → the seat-config buckets it already has
//                            (2A, 1A, …) plus any Combo the operator creates.
// Level 3  Files       — click a bucket to see the actual cutting templates
//                        (DGT / PRJ / EMF), with Add, Upload, Edit and Delete.
//
// The size parameter is stored in the existing `totalHeight` field for BOTH
// categories — it reads as the total height (cm) for a bedframe and as the seat
// size for a sofa; the UI labels it per category. Category itself is DERIVED
// from the product catalogue (matched on the model code), so no schema change
// is needed. Everything is also manually creatable.
//
// File BYTES live in Supabase Storage; this page only ever sees metadata +
// hasDgt/hasPrj/hasEmf booleans. Downloads anchor to
// GET /api/cnc-templates/:id/file/:kind (a 302 to a short-lived signed URL).
// ---------------------------------------------------------------------------
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { Card, CardContent } from "@/components/ui/card";
import { SkeletonTable } from "@/components/ui/skeleton";
import {
  Scissors,
  Search,
  Upload,
  Loader2,
  Pencil,
  Check,
  X,
  Plus,
  Trash2,
  ArrowLeft,
  ChevronRight,
  Bed,
  Sofa,
  Package,
} from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  uploadCncFiles,
  updateCncTemplate,
  createCncTemplate,
  deleteCncTemplate,
} from "@/lib/cnc-import";
import type { CncTemplate } from "@/components/cnc/CncTemplatePanel";
import type { Product } from "@/types";
import { useSofaSeatHeights } from "@/lib/use-sofa-seat-heights";

type Category = "BEDFRAME" | "SOFA" | "OTHER";

// Fallback bed sizes for a bedframe model that has no sized product variants
// yet. The real buckets are DERIVED per-model from the products' sizeLabels
// (see bedSizesByBase), so non-standard / custom sizes (200×200, 220×220, …)
// appear automatically — we do NOT hard-limit to the four standard sizes.
const STANDARD_BED_SIZE_LABELS = ["3FT", "3.5FT", "5FT", "6FT"] as const;

// Friendly label for a bedframe size: the four standard FT sizes get their bed
// name; anything else (custom / oversized) shows its dimension. Display only —
// the bucket KEY stays the raw size label so no size is ever lost or merged.
function prettyBedSize(label: string): string {
  const k = String(label ?? "").trim().toUpperCase().replace(/\s/g, "");
  const names: Record<string, string> = {
    "6FT": "King",
    "5FT": "Queen",
    "3.5FT": "Super Single",
    "3FT": "Single",
  };
  if (names[k]) return names[k];
  const m = k.match(/^(\d+)CMX(\d+)CM$/);
  if (m) return `${m[1]}×${m[2]}`;
  return String(label ?? "").trim();
}

// Sort key for bed sizes: FT sizes (3–6) sort ahead of cm dimensions (150+).
function bedSizeSortKey(label: string): number {
  const n = Number.parseFloat(String(label ?? ""));
  return Number.isFinite(n) ? n : 99999;
}

// Standard sofa seat sizes (matches SEAT_HEIGHT_OPTIONS / variants-config).
// Follows Maintenance → Sofa → Sizes (owner 2026-08-21). This one at least
// carried 26"; six of the eight copies did not.

type CncTemplatesResponse = { success?: boolean; data?: CncTemplate[] };
type ProductsResponse = { success?: boolean; data?: Product[] };

// Collapse a SKU code to its MODEL code: everything before the first dash or
// space.
//   "1005-(K)"      → "1005"   (bedframe bed-size variant)
//   "5535-1A(LHF)"  → "5535"   (sofa seat-config variant)
//   "5530-STOOL"    → "5530"
//   "1003(A)"       → "1003(A)" (parenthesised model variant, NO dash — kept
//                                as its own model, e.g. Hilton vs Hilton-A)
// So all of a model's variants group under one card, and the suffix becomes the
// Level-2 bucket (bed size / seat config).
function baseProductCode(code: string): string {
  const raw = String(code ?? "").trim();
  if (!raw) return raw;
  return raw.split(/[\s-]/)[0].trim();
}

// The variant suffix after the first dash/space — the inverse of
// baseProductCode. "5535-1A(LHF)" → "1A(LHF)", "1005-(K)" → "(K)", "5535" → "".
function variantSuffix(code: string): string {
  const raw = String(code ?? "").trim();
  const m = raw.match(/^[^\s-]+[\s-]+(.+)$/);
  return m ? m[1].trim() : "";
}

// A clean MODEL name for the card: the product name with its variant config
// token removed, so "SOFA 5535 1A(LHF)" reads as "SOFA 5535". Bedframe names
// (no dash variant) pass through unchanged.
function cleanModelName(name: string, code: string): string {
  const suf = variantSuffix(code);
  let out = String(name ?? "").trim();
  if (suf) out = out.split(suf).join(" ").replace(/\s{2,}/g, " ").trim();
  return out;
}

// Pull the frame size (e.g. "6FT", "3.5FT") out of a product name for the card
// badge. Empty when the name has no FT size (e.g. sofas).
function frameSizeBadge(name: string): string {
  const m = String(name ?? "").match(/\(\s*(\d+(?:\.\d+)?)\s*FT\s*\)/i);
  return m ? `${m[1]}FT` : "";
}

// Card display name with the noisy/repetitive bits stripped: the "(6FT)" size
// (shown as a badge instead) and the "(183X190CM)" mattress dimension.
// "HILTON BEDFRAME (6FT) (183X190CM)" → "HILTON BEDFRAME".
function cardDisplayName(name: string): string {
  return String(name ?? "")
    .replace(/\(\s*\d+(?:\.\d+)?\s*FT\s*\)/gi, "")
    .replace(/\(\s*\d+\s*[xX]\s*\d+\s*CM\s*\)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Which bed-size bucket a bedframe template belongs to. Looks at both the
// size label (e.g. "6FT") and the product-code variant suffix (e.g. "-(K)").
// Order matters: test the more specific "Super Single" before "Single", and
// "(SS)" before "(S)".
function bedBucketOf(t: { sizeLabel?: string; productCode?: string }): string | null {
  const hay = `${t.productCode ?? ""} ${t.sizeLabel ?? ""}`.toLowerCase();
  if (/super\s*single|\bss\b|\(ss\)|\b4\s*ft\b|\b4ft\b/.test(hay)) return "Super Single";
  if (/\bsingle\b|\(s\)|\b3\s*ft\b|\b3ft\b|3'/.test(hay)) return "Single";
  if (/\bqueen\b|\(q\)|\b5\s*ft\b|\b5ft\b|5'/.test(hay)) return "Queen";
  if (/\bking\b|\(k\)|\b6\s*ft\b|\b6ft\b|6'/.test(hay)) return "King";
  return null;
}

// Does a size label look like a sofa seat config (2A, 1A(LHF), 3S, NA, …)?
function looksLikeSeatConfig(sizeLabel: string): boolean {
  return /^[1-3]\s*(na|a|s)(\(lhf\)|\(rhf\))?$/i.test(sizeLabel.trim());
}

// Best-effort category for a model from its product (if matched) or, failing
// that, from the shape of its templates.
function deriveCategory(product: Product | undefined, templates: CncTemplate[]): Category {
  if (product?.category === "BEDFRAME") return "BEDFRAME";
  if (product?.category === "SOFA") return "SOFA";
  if (templates.some((t) => bedBucketOf(t))) return "BEDFRAME";
  if (templates.some((t) => looksLikeSeatConfig(t.sizeLabel))) return "SOFA";
  return "OTHER";
}

// Auto-suggest a file/display name for a manual create. Keeps the operator from
// staring at a blank field; always editable.
function suggestName(opts: {
  code: string;
  bucket: string;
  sizeValue: string;
  piece: string;
  category: Category;
}): string {
  const parts = [opts.code.trim(), opts.bucket.trim()];
  if (opts.sizeValue.trim()) {
    parts.push(opts.category === "SOFA" ? opts.sizeValue.trim() : `${opts.sizeValue.trim()}cm`);
  }
  if (opts.piece.trim()) parts.push(opts.piece.trim());
  return parts.filter(Boolean).join(" ");
}

// Group multiple picked files into the {dgt,prj,emf} slots by extension.
function filesByKind(files: File[]): Partial<Record<"dgt" | "prj" | "emf", File>> {
  const out: Partial<Record<"dgt" | "prj" | "emf", File>> = {};
  for (const f of files) {
    const ext = f.name.split(".").pop()?.toLowerCase();
    if (ext === "dgt" || ext === "prj" || ext === "emf") out[ext] = f;
  }
  return out;
}

// Per-kind download button → backend 302-redirect download URL, new tab.
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

// ---------------------------------------------------------------------------

type ModelGroup = {
  code: string;
  name: string;
  category: Category;
  templates: CncTemplate[];
};

type EditDraft = {
  productCode: string;
  displayName: string;
  sizeLabel: string;
  pieceLabel: string;
  totalHeight: string;
  fabricWidth: string;
  material: "fabric" | "wood";
};

type CreateDraft = {
  productCode: string;
  bucket: string; // bed size (BF) or seat config (SOFA) → sizeLabel
  sizeValue: string; // total height cm (BF) or seat size (SOFA) → totalHeight
  pieceLabel: string;
  displayName: string;
  nameEdited: boolean;
  files: File[];
};

export default function CncTemplatesPage() {
  const SEAT_SIZE_OPTIONS = useSofaSeatHeights();
  const { toast } = useToast();
  const { confirm } = useConfirm();

  // Drill-down navigation: null model = Level 1; model + null bucket = Level 2;
  // model + bucket = Level 3.
  const [navModel, setNavModel] = useState<string | null>(null);
  const [navBucket, setNavBucket] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Fabric/wood view filter for the current bucket's template list.
  const [materialFilter, setMaterialFilter] = useState<"all" | "fabric" | "wood">("all");

  const { data, loading, refresh } = useCachedJson<CncTemplatesResponse>(
    "/api/cnc-templates",
  );
  const { data: productsData } = useCachedJson<ProductsResponse>("/api/products");

  const templates = useMemo(
    () => (Array.isArray(data?.data) ? data!.data! : []),
    [data],
  );
  const products = useMemo(
    () => (Array.isArray(productsData?.data) ? productsData!.data! : []),
    [productsData],
  );

  const refreshAll = () => {
    invalidateCachePrefix("/api/cnc-templates");
    refresh();
  };

  // -------------------------------------------------------------------------
  // Build the model list: every bedframe/sofa product (grouped by base code)
  // unioned with any model code that already has templates.
  // -------------------------------------------------------------------------
  const { productByCode, productNameByCode } = useMemo(() => {
    const byCode = new Map<string, Product>();
    const nameByCode = new Map<string, string>();
    for (const p of products) {
      const base = baseProductCode(p.code);
      if (!base) continue;
      if (!byCode.has(base)) byCode.set(base, p);
      // Prefer the bare-model product's name; otherwise clean the variant
      // token out of a variant SKU's name ("SOFA 5535 1A(LHF)" → "SOFA 5535").
      if (p.name && (!nameByCode.has(base) || p.code === base)) {
        nameByCode.set(base, cleanModelName(p.name, p.code));
      }
    }
    return { productByCode: byCode, productNameByCode: nameByCode };
  }, [products]);

  // Per sofa model, the seat-config buckets pulled from the catalogue — e.g.
  // 5535 → {1A(LHF), 1A(RHF), 2A(LHF), ..., CNR, STOOL}. These pre-build the
  // Level-2 buckets (shown even when empty) so the operator just fills them.
  const sofaConfigsByBase = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const p of products) {
      if (p.category !== "SOFA") continue;
      const base = baseProductCode(p.code);
      const suf = variantSuffix(p.code);
      if (!base || !suf) continue;
      if (!m.has(base)) m.set(base, new Set());
      m.get(base)!.add(suf);
    }
    return m;
  }, [products]);

  // Per bedframe model, the size buckets pulled from the catalogue — every
  // sizeLabel its product variants come in (6FT / 5FT / 3.5FT / 3FT, plus
  // non-standard 200×200 / 220×220 / custom dimensions). Plus a
  // sizeCode→sizeLabel map so a template coded "1003-(SK)" with no sizeLabel
  // still lands in the matching bucket.
  const { bedSizesByBase, bedSizeCodeToLabel } = useMemo(() => {
    const byBase = new Map<string, Set<string>>();
    const codeToLabel = new Map<string, string>();
    for (const p of products) {
      if (p.category !== "BEDFRAME") continue;
      const base = baseProductCode(p.code);
      const sl = (p.sizeLabel || "").trim();
      if (base && sl) {
        if (!byBase.has(base)) byBase.set(base, new Set());
        byBase.get(base)!.add(sl);
      }
      if (sl) {
        const suf = variantSuffix(p.code).replace(/[()]/g, "").trim().toUpperCase();
        const code2 = (p.sizeCode || "").trim().toUpperCase();
        if (suf && !codeToLabel.has(suf)) codeToLabel.set(suf, sl);
        if (code2 && !codeToLabel.has(code2)) codeToLabel.set(code2, sl);
      }
    }
    return { bedSizesByBase: byBase, bedSizeCodeToLabel: codeToLabel };
  }, [products]);

  const models = useMemo(() => {
    const map = new Map<string, CncTemplate[]>();
    // Seed from catalogue (so empty models are pre-built and fillable).
    for (const p of products) {
      if (p.category !== "BEDFRAME" && p.category !== "SOFA") continue;
      const base = baseProductCode(p.code);
      if (base && !map.has(base)) map.set(base, []);
    }
    // Add models that already own templates.
    for (const t of templates) {
      const base = baseProductCode(t.productCode) || "—";
      if (!map.has(base)) map.set(base, []);
      map.get(base)!.push(t);
    }
    const list: ModelGroup[] = [];
    for (const [code, ts] of map.entries()) {
      const product = productByCode.get(code);
      list.push({
        code,
        name: productNameByCode.get(code) || product?.name || "",
        category: deriveCategory(product, ts),
        templates: ts,
      });
    }
    return list.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  }, [templates, products, productByCode, productNameByCode]);

  // Level 1 search over code / name / templates' piece+display.
  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.code.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.templates.some((t) =>
          `${t.displayName} ${t.pieceLabel} ${t.sizeLabel}`.toLowerCase().includes(q),
        ),
    );
  }, [models, query]);

  const currentModel = useMemo(
    () => models.find((m) => m.code === navModel) || null,
    [models, navModel],
  );

  // Display label for a bucket key — bed sizes get a friendly name (King / 6FT,
  // or the raw dimension for custom sizes); sofa seat-configs pass through.
  const bucketDisplay = (key: string): string =>
    currentModel?.category === "BEDFRAME" ? prettyBedSize(key) : key;

  // Level 2 buckets for the current model.
  const buckets = useMemo(() => {
    type Bucket = { key: string; label: string; preset: boolean; templates: CncTemplate[] };
    if (!currentModel) return [] as Bucket[];
    if (currentModel.category === "BEDFRAME") {
      // Sizes this model actually comes in (from the catalogue); fall back to
      // the standard FT sizes only when the model has no sized variants.
      const avail = [...(bedSizesByBase.get(currentModel.code) ?? [])];
      const sizes = avail.length ? avail : [...STANDARD_BED_SIZE_LABELS];
      // A template's bucket = its own sizeLabel, else its code suffix mapped
      // through the catalogue ("1003-(SK)" → "200CMX200CM"), else the suffix.
      const keyOf = (t: CncTemplate): string => {
        const sl = (t.sizeLabel || "").trim();
        if (sl) return sl;
        const suf = variantSuffix(t.productCode).replace(/[()]/g, "").trim().toUpperCase();
        if (suf && bedSizeCodeToLabel.has(suf)) return bedSizeCodeToLabel.get(suf)!;
        return suf || "Other";
      };
      const map = new Map<string, CncTemplate[]>();
      for (const s of sizes) map.set(s, []);
      for (const t of currentModel.templates) {
        const k = keyOf(t);
        if (!map.has(k)) map.set(k, []);
        map.get(k)!.push(t);
      }
      return [...map.entries()]
        .map(([key, ts]): Bucket => ({ key, label: prettyBedSize(key), preset: sizes.includes(key), templates: ts }))
        .sort((a, b) => bedSizeSortKey(a.key) - bedSizeSortKey(b.key) || a.key.localeCompare(b.key));
    }
    // SOFA / OTHER → bucket by seat config. Seed the standard configs from the
    // catalogue (so they show even when empty), then slot each template by its
    // code suffix ("5535-1A(LHF)" → "1A(LHF)") or its size label.
    const seeded = sofaConfigsByBase.get(currentModel.code) ?? new Set<string>();
    const map = new Map<string, CncTemplate[]>();
    for (const cfg of seeded) map.set(cfg, []);
    for (const t of currentModel.templates) {
      const key =
        (variantSuffix(t.productCode) || t.sizeLabel || "").trim() ||
        "No seat config";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return [...map.entries()]
      .map(([key, ts]): Bucket => ({ key, label: key, preset: seeded.has(key), templates: ts }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [currentModel, sofaConfigsByBase, bedSizesByBase, bedSizeCodeToLabel]);

  const currentBucketTemplates = useMemo(() => {
    if (!currentModel || navBucket == null) return [];
    const b = buckets.find((x) => x.key === navBucket);
    const list = b ? b.templates : [];
    if (materialFilter === "all") return list;
    return list.filter((t) => (t.material === "wood" ? "wood" : "fabric") === materialFilter);
  }, [currentModel, navBucket, buckets, materialFilter]);

  // -------------------------------------------------------------------------
  // Bulk upload (filename-parsed, optionally scoped to a model).
  // -------------------------------------------------------------------------
  const [uploading, setUploading] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const handleUpload = async (files: File[], scopeCode?: string) => {
    if (files.length === 0) return;
    setUploading(true);
    try {
      const msg = await uploadCncFiles(files, { productCode: scopeCode });
      toast.success(msg);
      refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  // -------------------------------------------------------------------------
  // Inline edit (re-assign model / fix size / piece / height / name).
  // -------------------------------------------------------------------------
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditDraft | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const startEdit = (t: CncTemplate) => {
    setEditingId(t.id);
    setEdit({
      productCode: t.productCode || "",
      displayName: t.displayName || "",
      sizeLabel: t.sizeLabel || "",
      pieceLabel: t.pieceLabel || "",
      totalHeight: t.totalHeight || "",
      fabricWidth: t.fabricWidth || "",
      material: t.material === "wood" ? "wood" : "fabric",
    });
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEdit(null);
  };
  const saveEdit = async () => {
    if (!editingId || !edit) return;
    if (!edit.productCode.trim()) return toast.error("Please enter a model (product code).");
    if (!edit.displayName.trim()) return toast.error("Display name cannot be empty.");
    setSavingEdit(true);
    try {
      await updateCncTemplate(editingId, {
        productCode: edit.productCode.trim(),
        displayName: edit.displayName.trim(),
        sizeLabel: edit.sizeLabel.trim(),
        pieceLabel: edit.pieceLabel.trim(),
        totalHeight: edit.totalHeight.trim(),
        fabricWidth: edit.fabricWidth.trim(),
        material: edit.material,
      });
      toast.success("Template updated.");
      cancelEdit();
      refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSavingEdit(false);
    }
  };

  // -------------------------------------------------------------------------
  // Delete one template.
  // -------------------------------------------------------------------------
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const handleDelete = async (t: CncTemplate) => {
    if (
      !(await confirm({
        title: "Delete template?",
        message: `Delete "${t.displayName || t.id}"? This removes its DGT / PRJ / EMF files. This cannot be undone.`,
        danger: true,
      }))
    )
      return;
    setDeletingId(t.id);
    try {
      await deleteCncTemplate(t.id);
      toast.success("Template deleted.");
      refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setDeletingId(null);
    }
  };

  // -------------------------------------------------------------------------
  // Manual create (Add cutting file), scoped to a model + bucket + category.
  // -------------------------------------------------------------------------
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateDraft | null>(null);
  const createCategory: Category = currentModel?.category ?? "OTHER";
  const openCreate = (presetBucket: string) => {
    if (!currentModel) return;
    const seedBucket =
      presetBucket && presetBucket !== "Other" && presetBucket !== "No seat config"
        ? presetBucket
        : "";
    setCreateDraft({
      productCode: currentModel.code,
      bucket: seedBucket,
      sizeValue: "",
      pieceLabel: "",
      displayName: "",
      nameEdited: false,
      files: [],
    });
  };
  const closeCreate = () => setCreateDraft(null);
  // Keep the auto-suggested name in sync until the operator edits it.
  const createSuggested = createDraft
    ? suggestName({
        code: createDraft.productCode,
        bucket: createDraft.bucket,
        sizeValue: createDraft.sizeValue,
        piece: createDraft.pieceLabel,
        category: createCategory,
      })
    : "";
  const submitCreate = async () => {
    if (!createDraft) return;
    if (!createDraft.productCode.trim()) return toast.error("Model (product code) is required.");
    const displayName = (createDraft.nameEdited ? createDraft.displayName : createSuggested).trim();
    if (!displayName) return toast.error("Please enter a display name.");
    setCreating(true);
    try {
      const saved = await createCncTemplate({
        productCode: createDraft.productCode.trim(),
        displayName,
        sizeLabel: createDraft.bucket.trim(),
        totalHeight: createDraft.sizeValue.trim(),
        pieceLabel: createDraft.pieceLabel.trim(),
        files: filesByKind(createDraft.files),
      });
      toast.success("Cutting template added.");
      refreshAll();
      closeCreate();
      // Jump to the bucket the new template landed in so it's visible.
      if (currentModel?.category === "BEDFRAME") {
        setNavBucket((saved.sizeLabel || createDraft.bucket || navBucket || "").trim() || navBucket);
      } else {
        setNavBucket((saved.sizeLabel || createDraft.bucket || navBucket || "").trim() || navBucket);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create failed.");
    } finally {
      setCreating(false);
    }
  };

  // Navigation helpers — always clear the transient edit/create panels so they
  // never leak across screens. (Done here, not in an effect, to avoid the
  // set-state-in-effect cascade.)
  const goModels = () => {
    cancelEdit();
    closeCreate();
    setNavModel(null);
    setNavBucket(null);
  };
  const goModel = (code: string) => {
    cancelEdit();
    closeCreate();
    setNavModel(code);
    setNavBucket(null);
  };
  const goModelView = () => {
    cancelEdit();
    closeCreate();
    setNavBucket(null);
  };
  const goBucket = (key: string) => {
    cancelEdit();
    closeCreate();
    setNavBucket(key);
  };

  const sizeColLabel = createCategory === "SOFA" ? "Seat Size" : "Total H (cm)";

  // Bed-size dropdown options for the create form — the sizes this model comes
  // in (from the catalogue), or the standard FT sizes if it has none yet.
  const bedSizeOptions = (() => {
    const avail = currentModel ? [...(bedSizesByBase.get(currentModel.code) ?? [])] : [];
    const list = avail.length ? avail : [...STANDARD_BED_SIZE_LABELS];
    return list.sort((a, b) => bedSizeSortKey(a) - bedSizeSortKey(b) || a.localeCompare(b));
  })();

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="space-y-6">
      {/* Header + breadcrumb */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">CNC Cutting Templates</h1>
          <div className="mt-0.5 flex items-center gap-1 text-xs text-[#6B7280]">
            <button
              type="button"
              onClick={goModels}
              className={navModel ? "hover:text-[#6B5C32] hover:underline" : "font-medium text-[#1F1D1B]"}
            >
              All models
            </button>
            {currentModel && (
              <>
                <ChevronRight className="h-3 w-3 text-[#C9C2BA]" />
                <button
                  type="button"
                  onClick={goModelView}
                  className={navBucket ? "hover:text-[#6B5C32] hover:underline" : "font-medium text-[#1F1D1B]"}
                >
                  {currentModel.code}
                </button>
              </>
            )}
            {currentModel && navBucket && (
              <>
                <ChevronRight className="h-3 w-3 text-[#C9C2BA]" />
                <span className="font-medium text-[#1F1D1B]">{bucketDisplay(navBucket)}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ===================== LEVEL 1 — model grid ===================== */}
      {!currentModel && (
        <>
          {/* Search */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative max-w-sm flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[#9CA3AF]" />
              <input
                type="text"
                placeholder="Search model code, name, or piece…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full rounded-md border border-[#E2DDD8] bg-white pl-8 pr-3 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              />
            </div>
          </div>

          {/* Bulk upload card (filename-parsed; pick a model to file it under). */}
          <BulkUploadCard
            products={products}
            uploading={uploading}
            inputRef={uploadInputRef}
            onUpload={handleUpload}
          />

          {loading && templates.length === 0 ? (
            <SkeletonTable rows={6} columns={4} />
          ) : (
            (["BEDFRAME", "SOFA", "OTHER"] as Category[]).map((cat) => {
              const rows = filteredModels.filter((m) => m.category === cat);
              if (rows.length === 0) return null;
              return (
                <div key={cat} className="space-y-2">
                  <h2 className="flex items-center gap-1.5 text-sm font-semibold text-[#6B7280] uppercase tracking-wide px-1">
                    {cat === "BEDFRAME" ? (
                      <Bed className="h-4 w-4" />
                    ) : cat === "SOFA" ? (
                      <Sofa className="h-4 w-4" />
                    ) : (
                      <Package className="h-4 w-4" />
                    )}
                    {cat === "OTHER" ? "Other / Unsorted" : cat}
                    <span className="font-normal text-[#9CA3AF]">({rows.length})</span>
                  </h2>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                    {rows.map((m) => {
                      const fileCount = m.templates.length;
                      const sizeBadge = frameSizeBadge(m.name);
                      const cardName = cardDisplayName(m.name);
                      return (
                        <button
                          key={m.code}
                          type="button"
                          onClick={() => goModel(m.code)}
                          className="flex min-h-[76px] flex-col rounded-lg border border-[#E2DDD8] bg-white px-3 py-2.5 text-left hover:border-[#6B5C32] hover:bg-[#FAF9F7] hover:shadow-sm transition-all"
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-sm font-semibold text-[#1F1D1B]">
                              {m.code}
                            </span>
                            {sizeBadge && (
                              <span className="shrink-0 rounded bg-[#F3F0EA] px-1.5 py-0.5 text-[10px] font-medium text-[#6B5C32]">
                                {sizeBadge}
                              </span>
                            )}
                          </div>
                          {cardName && (
                            <span className="mt-0.5 truncate text-[11px] text-[#6B7280]">
                              {cardName}
                            </span>
                          )}
                          <div className="mt-auto pt-2">
                            {fileCount ? (
                              <span className="inline-flex items-center rounded-full bg-[#E0EDF0] px-2 py-0.5 text-[10px] font-medium text-[#3E6570]">
                                {fileCount} template{fileCount === 1 ? "" : "s"}
                              </span>
                            ) : (
                              <span className="text-[10px] italic text-[#B7B0A8]">No files yet</span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}

          {!loading && filteredModels.length === 0 && (
            <Card>
              <CardContent className="p-12 text-center">
                <Scissors className="h-10 w-10 text-[#E2DDD8] mx-auto mb-3" strokeWidth={1.5} />
                <p className="text-sm font-medium text-[#1F1D1B]">No models found</p>
                <p className="text-xs text-[#6B7280] mt-1">
                  {query ? "Try a different search term." : "Add a product, then upload its cutting files."}
                </p>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* ===================== LEVEL 2 — size / seat buckets ===================== */}
      {currentModel && navBucket == null && (
        <>
          <button
            type="button"
            onClick={goModels}
            className="inline-flex items-center gap-1 text-xs font-medium text-[#6B5C32] hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> All models
          </button>

          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-[#F3F0EA] px-2.5 py-1 text-xs font-medium text-[#6B5C32]">
              {currentModel.category === "BEDFRAME" ? (
                <Bed className="h-3.5 w-3.5" />
              ) : currentModel.category === "SOFA" ? (
                <Sofa className="h-3.5 w-3.5" />
              ) : (
                <Package className="h-3.5 w-3.5" />
              )}
              {currentModel.category === "OTHER" ? "Unsorted" : currentModel.category}
            </span>
            {/* Bulk upload scoped to this model. */}
            <ScopedUploadButton
              uploading={uploading}
              onPick={(files) => handleUpload(files, currentModel.code)}
            />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {buckets.map((b) => (
              <button
                key={b.key}
                type="button"
                onClick={() => goBucket(b.key)}
                className="flex min-h-[72px] flex-col rounded-lg border border-[#E2DDD8] bg-white px-3 py-2.5 text-left hover:border-[#6B5C32] hover:bg-[#FAF9F7] hover:shadow-sm transition-all"
              >
                <span className="truncate text-sm font-semibold text-[#1F1D1B]">{b.label}</span>
                <div className="mt-auto pt-2">
                  {b.templates.length ? (
                    <span className="inline-flex items-center rounded-full bg-[#E0EDF0] px-2 py-0.5 text-[10px] font-medium text-[#3E6570]">
                      {b.templates.length} template{b.templates.length === 1 ? "" : "s"}
                    </span>
                  ) : (
                    <span className="text-[10px] italic text-[#B7B0A8]">Empty</span>
                  )}
                </div>
              </button>
            ))}

            {/* Sofa: add a new seat config / combo bucket. */}
            {currentModel.category !== "BEDFRAME" && (
              <button
                type="button"
                onClick={() => {
                  goBucket("");
                  openCreate("");
                }}
                className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[#CDBf9b] bg-[#FCFBF8] px-3 py-2.5 text-[#6B5C32] hover:bg-[#F3F0EA] transition-colors"
              >
                <Plus className="h-4 w-4" />
                <span className="mt-1 text-[11px] font-medium">New config / Combo</span>
              </button>
            )}
          </div>
        </>
      )}

      {/* ===================== LEVEL 3 — templates in a bucket ===================== */}
      {currentModel && navBucket != null && (
        <>
          <button
            type="button"
            onClick={goModelView}
            className="inline-flex items-center gap-1 text-xs font-medium text-[#6B5C32] hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> {currentModel.code}
          </button>

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-sm font-semibold text-[#1F1D1B]">
              {currentModel.code}
              {navBucket ? ` · ${bucketDisplay(navBucket)}` : ""}
            </h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => openCreate(navBucket || "")}
                className="inline-flex items-center gap-1.5 rounded-md bg-[#6B5C32] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#4D4224] transition-colors"
              >
                <Plus className="h-3.5 w-3.5" /> Add cutting file
              </button>
              <ScopedUploadButton
                uploading={uploading}
                onPick={(files) => handleUpload(files, currentModel.code)}
              />
            </div>
          </div>

          {/* Create form (category-aware). */}
          {createDraft && (
            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-[#1F1D1B]">
                  <Plus className="h-4 w-4 text-[#6B5C32]" /> New cutting template
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <label className="flex flex-col gap-1 text-[11px] font-medium text-[#6B7280]">
                    Model (product code)
                    <input
                      type="text"
                      value={createDraft.productCode}
                      onChange={(e) => setCreateDraft({ ...createDraft, productCode: e.target.value })}
                      className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                    />
                  </label>

                  {/* Bucket: bed-size select (BF) or seat-config text (Sofa). */}
                  {createCategory === "BEDFRAME" ? (
                    <label className="flex flex-col gap-1 text-[11px] font-medium text-[#6B7280]">
                      Bed Size
                      <select
                        value={createDraft.bucket}
                        onChange={(e) =>
                          setCreateDraft({ ...createDraft, bucket: e.target.value })
                        }
                        className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                      >
                        <option value="">— pick —</option>
                        {bedSizeOptions.map((b) => (
                          <option key={b} value={b}>
                            {prettyBedSize(b)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <label className="flex flex-col gap-1 text-[11px] font-medium text-[#6B7280]">
                      Seat Config / Combo
                      <input
                        type="text"
                        value={createDraft.bucket}
                        onChange={(e) => setCreateDraft({ ...createDraft, bucket: e.target.value })}
                        placeholder="e.g. 2A, 1A(LHF), or L(L)+2A(R)"
                        className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                      />
                    </label>
                  )}

                  {/* Size value: total height cm (BF) or seat size (Sofa). */}
                  {createCategory === "SOFA" ? (
                    <label className="flex flex-col gap-1 text-[11px] font-medium text-[#6B7280]">
                      Seat Size
                      <select
                        value={createDraft.sizeValue}
                        onChange={(e) => setCreateDraft({ ...createDraft, sizeValue: e.target.value })}
                        className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                      >
                        <option value="">— pick —</option>
                        {SEAT_SIZE_OPTIONS.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <label className="flex flex-col gap-1 text-[11px] font-medium text-[#6B7280]">
                      Total Height (cm)
                      <input
                        type="text"
                        value={createDraft.sizeValue}
                        onChange={(e) => setCreateDraft({ ...createDraft, sizeValue: e.target.value })}
                        placeholder="e.g. 20"
                        className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                      />
                    </label>
                  )}

                  <label className="flex flex-col gap-1 text-[11px] font-medium text-[#6B7280]">
                    Piece (optional)
                    <input
                      type="text"
                      value={createDraft.pieceLabel}
                      onChange={(e) => setCreateDraft({ ...createDraft, pieceLabel: e.target.value })}
                      placeholder="e.g. ARM / CUSHION / DIVAN"
                      className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                    />
                  </label>

                  <label className="flex flex-col gap-1 text-[11px] font-medium text-[#6B7280]">
                    Display Name
                    <input
                      type="text"
                      value={createDraft.nameEdited ? createDraft.displayName : createSuggested}
                      onChange={(e) =>
                        setCreateDraft({ ...createDraft, displayName: e.target.value, nameEdited: true })
                      }
                      className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                    />
                  </label>
                </div>

                {/* Optional file picker — can also be left empty and uploaded later. */}
                <div className="flex items-center gap-2 flex-wrap">
                  <label className="inline-flex items-center gap-1.5 rounded-md border border-[#A8CAD2] bg-[#E0EDF0] px-2.5 py-1 text-[11px] font-medium text-[#3E6570] hover:bg-[#D2E4E8] cursor-pointer transition-colors">
                    <Upload className="h-3.5 w-3.5" />
                    Choose files (.dgt / .prj / .emf)
                    <input
                      type="file"
                      accept=".dgt,.prj,.emf"
                      multiple
                      className="hidden"
                      onChange={(e) =>
                        setCreateDraft({
                          ...createDraft,
                          files: Array.from(e.target.files || []),
                        })
                      }
                    />
                  </label>
                  {createDraft.files.length > 0 && (
                    <span className="text-[11px] text-[#6B7280]">
                      {createDraft.files.map((f) => f.name).join(", ")}
                    </span>
                  )}
                  <span className="text-[11px] text-[#9CA3AF] italic">
                    Files optional — you can add them later.
                  </span>
                </div>

                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={closeCreate}
                    disabled={creating}
                    className="inline-flex items-center gap-1 rounded-md border border-[#E2DDD8] bg-white px-3 py-1.5 text-xs font-medium text-[#6B7280] hover:bg-[#F3F4F6] disabled:opacity-50 transition-colors"
                  >
                    <X className="h-3.5 w-3.5" /> Cancel
                  </button>
                  <button
                    type="button"
                    onClick={submitCreate}
                    disabled={creating}
                    className="inline-flex items-center gap-1 rounded-md bg-[#6B5C32] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#4D4224] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    {creating ? "Adding…" : "Add template"}
                  </button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Fabric / Wood view filter */}
          {navBucket != null && (
            <div className="flex items-center gap-1.5 mb-3">
              <span className="text-[11px] font-medium text-[#6B7280] mr-1">Show:</span>
              {(["all", "fabric", "wood"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMaterialFilter(m)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors ${
                    materialFilter === m
                      ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                      : "bg-white text-[#6B7280] border-[#E2DDD8] hover:bg-[#F3F0EA]"
                  }`}
                >
                  {m === "all" ? "All" : m === "fabric" ? "Fabric" : "Wood"}
                </button>
              ))}
            </div>
          )}

          {/* Templates table */}
          {currentBucketTemplates.length === 0 && !createDraft ? (
            <Card>
              <CardContent className="p-10 text-center">
                <Scissors className="h-9 w-9 text-[#E2DDD8] mx-auto mb-2.5" strokeWidth={1.5} />
                <p className="text-sm font-medium text-[#1F1D1B]">No cutting files here yet</p>
                <p className="text-xs text-[#6B7280] mt-1">
                  Use “Add cutting file” or “Upload files” to fill this {navBucket ? `${navBucket} ` : ""}slot.
                </p>
              </CardContent>
            </Card>
          ) : currentBucketTemplates.length > 0 ? (
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[10px] font-medium text-[#6B7280] uppercase border-b border-[#E2DDD8]">
                      <th className="px-3 py-2">Display Name</th>
                      <th className="px-3 py-2">{currentModel.category === "BEDFRAME" ? "Bed Size" : "Seat Config"}</th>
                      <th className="px-3 py-2">Piece</th>
                      <th className="px-3 py-2">{sizeColLabel}</th>
                      <th className="px-3 py-2">Files</th>
                      <th className="px-3 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentBucketTemplates.map((t) => (
                      <Fragment key={t.id}>
                        <tr className="border-b border-[#F3F4F6] last:border-0">
                          <td className="px-3 py-2 text-[#111827]">
                            {t.displayName}
                            <span
                              className={`ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                t.material === "wood"
                                  ? "bg-[#EFE6DA] text-[#7A5C3A]"
                                  : "bg-[#E0EDF0] text-[#3E6570]"
                              }`}
                            >
                              {t.material === "wood" ? "Wood" : "Fabric"}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-[#6B7280]">{t.sizeLabel || "—"}</td>
                          <td className="px-3 py-2 text-[#6B7280]">{t.pieceLabel || "—"}</td>
                          <td className="px-3 py-2 text-[#6B7280]">
                            {t.totalHeight
                              ? currentModel.category === "BEDFRAME"
                                ? `${t.totalHeight} cm`
                                : t.totalHeight
                              : "—"}
                          </td>
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
                          <td className="px-3 py-2">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => (editingId === t.id ? cancelEdit() : startEdit(t))}
                                className="inline-flex items-center gap-1 rounded-md border border-[#E2DDD8] bg-white px-2 py-1 text-[11px] font-medium text-[#6B5C32] hover:bg-[#F3F0EA] transition-colors"
                                title="Edit (re-assign model, fix size / piece / height)"
                              >
                                <Pencil className="h-3 w-3" /> Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDelete(t)}
                                disabled={deletingId === t.id}
                                className="inline-flex items-center gap-1 rounded-md border border-[#E7C9C4] bg-white px-2 py-1 text-[11px] font-medium text-[#B4453A] hover:bg-[#FBEEEC] disabled:opacity-50 transition-colors"
                                title="Delete this template"
                              >
                                {deletingId === t.id ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3 w-3" />
                                )}
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                        {editingId === t.id && edit && (
                          <tr className="bg-[#FAF9F7] border-b border-[#E2DDD8]">
                            <td colSpan={6} className="px-3 py-3">
                              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                                {(
                                  [
                                    ["productCode", "Model (product code)", "e.g. 5535"],
                                    ["displayName", "Display Name", ""],
                                    ["sizeLabel", "Size / Seat config", "e.g. King / 2A"],
                                    ["pieceLabel", "Piece", "e.g. ARM / CUSHION"],
                                    ["totalHeight", "Height (cm) / Seat size", "e.g. 20 / 28"],
                                    ["fabricWidth", "Fabric Width", ""],
                                  ] as [keyof EditDraft, string, string][]
                                ).map(([field, label, ph]) => (
                                  <label
                                    key={field}
                                    className="flex flex-col gap-1 text-[11px] font-medium text-[#6B7280]"
                                  >
                                    {label}
                                    <input
                                      type="text"
                                      value={edit[field]}
                                      onChange={(e) => setEdit({ ...edit, [field]: e.target.value })}
                                      placeholder={ph}
                                      className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                                    />
                                  </label>
                                ))}
                              </div>
                              <div className="mt-3">
                                <label className="flex flex-col gap-1 text-[11px] font-medium text-[#6B7280] max-w-[220px]">
                                  Material (fabric / wood)
                                  <select
                                    value={edit.material}
                                    onChange={(e) =>
                                      setEdit({ ...edit, material: e.target.value === "wood" ? "wood" : "fabric" })
                                    }
                                    className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                                  >
                                    <option value="fabric">Fabric</option>
                                    <option value="wood">Wood</option>
                                  </select>
                                </label>
                              </div>
                              <div className="mt-3 flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={cancelEdit}
                                  disabled={savingEdit}
                                  className="inline-flex items-center gap-1 rounded-md border border-[#E2DDD8] bg-white px-3 py-1.5 text-xs font-medium text-[#6B7280] hover:bg-[#F3F4F6] disabled:opacity-50 transition-colors"
                                >
                                  <X className="h-3.5 w-3.5" /> Cancel
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
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bulk-upload card with a searchable model picker (Level 1). Files are
// filename-parsed; picking a model files every file under it.
// ---------------------------------------------------------------------------
function BulkUploadCard({
  products,
  uploading,
  inputRef,
  onUpload,
}: {
  products: Product[];
  uploading: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onUpload: (files: File[], scopeCode?: string) => void;
}) {
  const [picked, setPicked] = useState<Product | null>(null);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = q
      ? products.filter(
          (p) =>
            (p.code || "").toLowerCase().includes(q) ||
            (p.name || "").toLowerCase().includes(q),
        )
      : products;
    return base.slice(0, 50);
  }, [products, search]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="relative min-w-[240px] flex-1 max-w-sm" ref={boxRef}>
            <label className="block text-[11px] font-medium text-[#6B7280] mb-1">
              Model (product) — optional
            </label>
            {picked ? (
              <div className="flex items-center gap-2 rounded-md border border-[#E2DDD8] bg-white px-2.5 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-[#1F1D1B]">
                  <span className="font-medium">{picked.code}</span>
                  <span className="text-[#6B7280]"> — {picked.name}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setPicked(null)}
                  className="shrink-0 text-[#9CA3AF] hover:text-[#6B5C32]"
                  title="Clear selected model"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <input
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                placeholder="Search code or name…"
                autoComplete="off"
                className="w-full rounded-md border border-[#E2DDD8] bg-white px-2.5 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              />
            )}
            {open && !picked && (
              <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-[#E2DDD8] bg-white shadow-lg">
                {filtered.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-[#9CA3AF] italic">No matching products</div>
                ) : (
                  filtered.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setPicked(p);
                        setOpen(false);
                        setSearch("");
                      }}
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

          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-2 rounded-md bg-[#6B5C32] px-3 py-2 text-sm font-medium text-white hover:bg-[#4D4224] disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {uploading ? "Uploading…" : "Upload files"}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".dgt,.prj,.emf"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              e.target.value = "";
              if (files.length) onUpload(files, picked?.code);
            }}
          />
        </div>

        <p className="mt-2 text-[11px] text-[#8B8580]">
          Pick a model so the files are filed under the right product instead of being guessed from
          the name. Leave it blank to use the filename. <span className="font-medium text-[#6B5C32]">.dgt</span>{" "}
          and <span className="font-medium text-[#6B5C32]">.emf</span> are machine files for the BUYI cutter;{" "}
          <span className="font-medium text-[#6B5C32]">.prj</span> is the project file.
        </p>
      </CardContent>
    </Card>
  );
}

// Small "Upload files" button that opens a file picker and hands the files back.
function ScopedUploadButton({
  uploading,
  onPick,
}: {
  uploading: boolean;
  onPick: (files: File[]) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => ref.current?.click()}
        disabled={uploading}
        className="inline-flex items-center gap-1.5 rounded-md border border-[#E2DDD8] bg-white px-3 py-1.5 text-xs font-medium text-[#6B5C32] hover:bg-[#F3F0EA] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
        Upload files
      </button>
      <input
        ref={ref}
        type="file"
        accept=".dgt,.prj,.emf"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = "";
          if (files.length) onPick(files);
        }}
      />
    </>
  );
}
