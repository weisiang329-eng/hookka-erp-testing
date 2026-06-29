// ---------------------------------------------------------------------------
// Supplier-document OCR — supplier-side counterpart to scan-po-modal.tsx.
//
// Two modes (mirrors how this modal is reused across the procurement module):
//
//   • mode="apply" (default, BACKWARD-COMPAT) — single-file pick → /extract
//     → review → hand the extraction back to the host page via onApply.
//     Used by GRN create (where the host page owns the line-by-line match
//     against an existing PO/GRN draft). Behaviour identical to the
//     431-line predecessor: same retry/abort, same gold-confirm.
//
//   • mode="create-pi" (NEW) — Batch-2 redesign requested by owner: a
//     3-step wizard ("1. Upload" → "2. Preview" → "3. Create") with
//     multi-file drag-drop, per-file editable preview cards, and an
//     in-modal "Create N PIs as DRAFT" action. Each card is its own PI
//     payload (supplier, purchase company, invoice date, supplier
//     invoice/DO no, line items); pressing Create POSTs each card to
//     /api/purchase-invoices in parallel.
//
// Backed by routes/scan-supplier.ts. Per-supplier learning: passing a
// supplierId injects that supplier's distilled ocrPromptRules; the "Mark
// as gold" toggle on each preview card re-distils on confirm.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { MaterialPicker, type MaterialOption } from "@/components/material-picker";
import type { Supplier, RawMaterial, SupplierMaterialBinding } from "@/types";
import {
  X,
  Upload,
  Camera,
  Loader2,
  ScanLine,
  Check,
  FileText,
  CheckCircle,
  AlertTriangle,
  Star,
  Sparkles,
  Plus,
  Trash2,
} from "lucide-react";

// ─── Shared types (kept exported for callers) ─────────────────────────────

export type ExtractedSupplierLine = {
  supplierCode?: string | null;
  description?: string | null;
  qty?: number | null;
  uom?: string | null;
  unitPrice?: number | null;
  amount?: number | null;
};
export type SupplierExtraction = {
  supplierName?: string | null;
  docType?: string | null;
  docNo?: string | null;
  docDate?: string | null;
  currency?: string | null;
  lines?: ExtractedSupplierLine[];
  subtotal?: number | null;
  tax?: number | null;
  total?: number | null;
};

// ─── Props ────────────────────────────────────────────────────────────────

type ApplyModeProps = {
  mode?: "apply";
  open: boolean;
  onClose: () => void;
  supplierId?: string | null;
  supplierName?: string | null;
  poContext?: string;
  onApply: (ex: SupplierExtraction) => void;
  title?: string;
};

type Organisation = { code: string; name: string; isActive?: boolean };

type CreatePIModeProps = {
  mode: "create-pi";
  open: boolean;
  onClose: () => void;
  /** Suppliers list (caller already fetched /api/suppliers). */
  suppliers: Supplier[];
  /** Active raw materials (caller already filtered isActive). */
  rawMaterials: RawMaterial[];
  /** Supplier ↔ material bindings (caller already fetched). */
  bindings: SupplierMaterialBinding[];
  /** Purchase company registry (caller already fetched /api/organisations). */
  organisations: Organisation[];
  /** Optional default supplier (e.g. when host already has one selected). */
  defaultSupplierId?: string | null;
  /** Called after at least one PI is created (host can refresh + navigate). */
  onCreated: (piIds: string[]) => void;
  title?: string;
};

type Props = ApplyModeProps | CreatePIModeProps;

// ─── Helpers ──────────────────────────────────────────────────────────────

const num = (v: number | null | undefined) =>
  v === null || v === undefined || Number.isNaN(v) ? "" : String(v);

let uploadSeq = 0;
function makeUploadId(): string {
  uploadSeq += 1;
  return `sup-upload-${Date.now().toString(36)}-${uploadSeq}`;
}

// Borrowed verbatim from the 431-line predecessor: retry transient OCR
// failures + abort wedged calls past 90s. One file per request — multi-file
// callers run this in parallel.
async function runExtractOnce(
  file: File,
  opts: {
    supplierId?: string | null;
    supplierName?: string | null;
    poContext?: string;
  },
): Promise<
  | { kind: "ok"; data: SupplierExtraction; sampleId: string | null }
  | { kind: "fail"; error: string }
> {
  const fd = new FormData();
  fd.append("file", file);
  if (opts.supplierId) fd.append("supplierId", opts.supplierId);
  if (opts.supplierName) fd.append("supplierName", opts.supplierName);
  if (opts.poContext) fd.append("poContext", opts.poContext);

  const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
  const DELAYS = [4, 12];
  const MAX = 3;
  let lastErr = "";
  for (let attempt = 0; attempt < MAX; attempt++) {
    const controller = new AbortController();
    // eslint-disable-next-line no-restricted-syntax -- imperative abort timer in an async fetch loop, not a React render
    const timer = setTimeout(() => controller.abort(), 180_000);
    let res: Response;
    try {
      res = await fetch("/api/scan-supplier/extract", {
        method: "POST",
        body: fd,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      lastErr = controller.signal.aborted
        ? "Scan timed out (180s) — large doc or first-time supplier. Retry usually works."
        : e instanceof Error
          ? e.message
          : "Network error";
      if (attempt < MAX - 1) {
        await new Promise((r) =>
          // eslint-disable-next-line no-restricted-syntax -- backoff
          setTimeout(r, DELAYS[attempt] * 1000),
        );
        continue;
      }
      return { kind: "fail", error: lastErr };
    }
    clearTimeout(timer);
    const data = (await res.json().catch(() => ({
      success: false,
      error: `HTTP ${res.status} (non-JSON)`,
    }))) as {
      success?: boolean;
      error?: string;
      data?: SupplierExtraction;
      sampleId?: string;
    };
    if (res.ok && data.success && data.data) {
      return {
        kind: "ok",
        data: { ...data.data, lines: data.data.lines ?? [] },
        sampleId: data.sampleId ?? null,
      };
    }
    lastErr = data.error || `HTTP ${res.status}`;
    if (RETRYABLE.has(res.status) && attempt < MAX - 1) {
      await new Promise((r) =>
        // eslint-disable-next-line no-restricted-syntax -- backoff
        setTimeout(r, DELAYS[attempt] * 1000),
      );
      continue;
    }
    return { kind: "fail", error: lastErr };
  }
  return { kind: "fail", error: lastErr || "retry exhausted" };
}

// ─── Top-level dispatcher ─────────────────────────────────────────────────

export function ScanSupplierModal(props: Props) {
  if (props.mode === "create-pi") return <CreatePIWizard {...props} />;
  return <ApplyModeModal {...(props as ApplyModeProps)} />;
}

// ─── apply-mode modal (backward-compat, single-file) ──────────────────────

function ApplyModeModal({
  open,
  onClose,
  supplierId,
  supplierName,
  poContext,
  onApply,
  title = "Scan supplier document",
}: ApplyModeProps) {
  const [phase, setPhase] = useState<"pick" | "scanning" | "review" | "error">(
    "pick",
  );
  const [error, setError] = useState("");
  const [ex, setEx] = useState<SupplierExtraction | null>(null);
  const [sampleId, setSampleId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setPhase("pick");
    setError("");
    setEx(null);
    setSampleId(null);
    setApplying(false);
  };
  const close = () => {
    reset();
    onClose();
  };

  const runExtract = async (file: File) => {
    setPhase("scanning");
    setError("");
    const res = await runExtractOnce(file, { supplierId, supplierName, poContext });
    if (res.kind === "ok") {
      setEx(res.data);
      setSampleId(res.sampleId);
      setPhase("review");
    } else {
      setError(res.error);
      setPhase("error");
    }
  };

  const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) void runExtract(f);
  };

  const setHeader = (field: keyof SupplierExtraction, value: string) =>
    setEx((p) => (p ? { ...p, [field]: value } : p));

  const setLine = (
    i: number,
    field: keyof ExtractedSupplierLine,
    value: string,
  ) =>
    setEx((p) => {
      if (!p) return p;
      const lines = [...(p.lines ?? [])];
      const numeric =
        field === "qty" || field === "unitPrice" || field === "amount";
      lines[i] = {
        ...lines[i],
        [field]: numeric ? (value === "" ? null : Number(value)) : value,
      };
      return { ...p, lines };
    });

  const removeLine = (i: number) =>
    setEx((p) =>
      p ? { ...p, lines: (p.lines ?? []).filter((_, j) => j !== i) } : p,
    );

  const apply = async (gold: boolean) => {
    if (!ex || applying) return;
    setApplying(true);
    if (sampleId) {
      try {
        await fetch(`/api/scan-supplier/samples/${sampleId}/confirm`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ correctedJson: ex, gold }),
        });
      } catch {
        /* best-effort */
      }
    }
    onApply(ex);
    close();
  };

  if (!open) return null;
  const lines = ex?.lines ?? [];

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={close} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-[#E2DDD8]">
          <h2 className="text-lg font-semibold text-[#1F1D1B] flex items-center gap-2">
            <ScanLine className="h-5 w-5" /> {title}
          </h2>
          <Button variant="ghost" size="icon" onClick={close}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,image/*"
          className="hidden"
          onChange={onFilePicked}
        />
        <input
          ref={camRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={onFilePicked}
        />

        {phase === "pick" && (
          <div className="p-8 flex flex-col items-center gap-4">
            <p className="text-sm text-[#6B7280] text-center">
              Upload the supplier&apos;s delivery note / invoice (PDF or image), or snap a photo with your phone. The system reads every line automatically.
            </p>
            <div className="flex gap-3">
              <Button variant="outline" onClick={() => fileRef.current?.click()}>
                <Upload className="h-4 w-4" /> Upload file
              </Button>
              <Button variant="primary" onClick={() => camRef.current?.click()}>
                <Camera className="h-4 w-4" /> Take photo
              </Button>
            </div>
          </div>
        )}

        {phase === "scanning" && (
          <div className="p-10 flex flex-col items-center gap-3 text-[#6B7280]">
            <Loader2 className="h-7 w-7 animate-spin" />
            <p className="text-sm">Reading… (about 30-60 seconds)</p>
          </div>
        )}

        {phase === "error" && (
          <div className="p-8 flex flex-col items-center gap-4">
            <p className="text-sm text-[#9A3A2D] text-center">Scan failed: {error}</p>
            <Button variant="outline" onClick={reset}>
              Retry
            </Button>
          </div>
        )}

        {phase === "review" && ex && (
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Supplier</label>
                <Input
                  value={ex.supplierName ?? ""}
                  onChange={(e) => setHeader("supplierName", e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Doc No.</label>
                <Input
                  value={ex.docNo ?? ""}
                  onChange={(e) => setHeader("docNo", e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Date</label>
                <Input
                  value={ex.docDate ?? ""}
                  onChange={(e) => setHeader("docDate", e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Type</label>
                <div className="flex h-10 items-center text-sm text-[#374151]">
                  {ex.docType === "INVOICE"
                    ? "Invoice"
                    : ex.docType === "DELIVERY_NOTE"
                      ? "Delivery Note"
                      : ex.docType || "—"}
                </div>
              </div>
            </div>

            <div className="border border-[#E2DDD8] rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-[#F0ECE9] text-[#6B7280]">
                  <tr>
                    <th className="text-left px-2 py-1.5">Code</th>
                    <th className="text-left px-2 py-1.5">Description</th>
                    <th className="text-right px-2 py-1.5 w-20">Qty</th>
                    <th className="text-left px-2 py-1.5 w-16">Unit</th>
                    <th className="text-right px-2 py-1.5 w-24">Unit Price</th>
                    <th className="text-right px-2 py-1.5 w-24">Amount</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-2 py-4 text-center text-[#9CA3AF]">
                        No lines detected — please retake a clearer photo.
                      </td>
                    </tr>
                  )}
                  {lines.map((ln, i) => (
                    <tr key={i} className="border-t border-[#EFEAE6]">
                      <td className="px-1 py-1">
                        <Input
                          className="h-8"
                          value={ln.supplierCode ?? ""}
                          onChange={(e) => setLine(i, "supplierCode", e.target.value)}
                        />
                      </td>
                      <td className="px-1 py-1">
                        <Input
                          className="h-8"
                          value={ln.description ?? ""}
                          onChange={(e) => setLine(i, "description", e.target.value)}
                        />
                      </td>
                      <td className="px-1 py-1">
                        <Input
                          type="number"
                          className="h-8 text-right"
                          value={num(ln.qty)}
                          onChange={(e) => setLine(i, "qty", e.target.value)}
                        />
                      </td>
                      <td className="px-1 py-1">
                        <Input
                          className="h-8"
                          value={ln.uom ?? ""}
                          onChange={(e) => setLine(i, "uom", e.target.value)}
                        />
                      </td>
                      <td className="px-1 py-1">
                        <Input
                          type="number"
                          className="h-8 text-right"
                          value={num(ln.unitPrice)}
                          onChange={(e) => setLine(i, "unitPrice", e.target.value)}
                        />
                      </td>
                      <td className="px-1 py-1">
                        <Input
                          type="number"
                          className="h-8 text-right"
                          value={num(ln.amount)}
                          onChange={(e) => setLine(i, "amount", e.target.value)}
                        />
                      </td>
                      <td className="px-1 py-1 text-center">
                        <button
                          type="button"
                          className="text-[#9CA3AF] hover:text-[#9A3A2D]"
                          onClick={() => removeLine(i)}
                          title="Delete this line"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-xs text-[#9CA3AF]">
              Once everything checks out, click &quot;Apply&quot; to fill these lines into the current form (you still need to review and save). &quot;Save as reference sample&quot; helps this supplier scan more accurately next time.
            </p>

            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={reset}>
                Rescan
              </Button>
              <Button
                variant="outline"
                disabled={applying}
                onClick={() => apply(true)}
                title="Apply, and save this confirmed result as a reference sample (gold) for this supplier to improve future accuracy"
              >
                <Check className="h-4 w-4" /> Apply &amp; save as reference sample
              </Button>
              <Button
                variant="primary"
                disabled={applying || lines.length === 0}
                onClick={() => apply(false)}
              >
                Apply
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── create-pi wizard (NEW, mirrors scan-po-modal shell) ──────────────────

type StepState = "upload" | "preview" | "creating" | "done";

type PreviewLine = {
  // Internal-code binding (resolved from supplier_material_bindings or via
  // the MaterialPicker). Read-only badge in the table; empty until bound.
  materialCode: string;
  // Catalog-resolved description if we found a binding; otherwise the raw
  // OCR description. Always editable.
  materialName: string;
  // Supplier's own SKU (the code on their invoice). Free-text. When this
  // matches a binding for the chosen supplier, materialCode auto-fills.
  supplierSku: string;
  description: string;
  qty: number;
  uom: string;
  unitPriceRM: number;
  amountRM: number; // display-only; recomputed from qty * unitPrice on edit
};

type PreviewCard = {
  id: string;
  fileName: string;
  // Sample id for the gold/confirm endpoint.
  sampleId: string | null;
  // Operator can opt in or out per card; defaults to true.
  include: boolean;
  // Per-card creating spinner — set true between submit and the response.
  creating: boolean;
  // Per-card "PI-CC0001" once the POST returns success.
  createdPiNo: string | null;
  // Per-card error from the POST.
  createError: string | null;
  // Editable header.
  supplierId: string;
  purchaseOrgCode: string;
  invoiceDate: string;
  supplierInvoiceNo: string;
  supplierDoNo: string;
  markedGold: boolean;
  // Editable lines.
  lines: PreviewLine[];
  // Frozen extraction snapshot — used to decide whether to write back the
  // sample as a corrected few-shot example.
  originalExtraction: SupplierExtraction;
};

function makeBlankLine(): PreviewLine {
  return {
    materialCode: "",
    materialName: "",
    supplierSku: "",
    description: "",
    qty: 1,
    uom: "",
    unitPriceRM: 0,
    amountRM: 0,
  };
}

function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}

function CreatePIWizard({
  open,
  onClose,
  suppliers,
  rawMaterials,
  bindings,
  organisations,
  defaultSupplierId,
  onCreated,
  title = "Scan supplier document",
}: CreatePIModeProps) {
  const { confirm } = useConfirm();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<StepState>("upload");
  const [files, setFiles] = useState<{ id: string; file: File }[]>([]);
  const [parsing, setParsing] = useState(false);
  const [fileProgress, setFileProgress] = useState<
    Record<string, "queued" | "scanning" | "done" | "failed">
  >({});
  const [errors, setErrors] = useState<string[]>([]);
  const [cards, setCards] = useState<PreviewCard[]>([]);

  const activeOrgs = useMemo(
    () => organisations.filter((o) => o.isActive !== false),
    [organisations],
  );

  // Reset whenever the modal closes so the next open starts clean.
  const reset = useCallback(() => {
    setStep("upload");
    setFiles([]);
    setParsing(false);
    setFileProgress({});
    setErrors([]);
    setCards([]);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const isBusy = parsing || step === "creating";

  const requestClose = async () => {
    if (
      isBusy &&
      !(await confirm({
        title: "Discard scan in progress?",
        message:
          "A scan is still in progress. Close and discard the work in progress?",
        danger: true,
      }))
    ) {
      return;
    }
    handleClose();
  };

  // ─── Supplier / material lookup helpers ────────────────────────────────
  const supplierById = useCallback(
    (id: string) => suppliers.find((s) => s.id === id) ?? null,
    [suppliers],
  );

  // Build a quick "supplier + supplierSku → binding" lookup so OCR lines
  // can resolve the internal materialCode automatically.
  const bindingsBySupplierSku = useMemo(() => {
    const m = new Map<string, SupplierMaterialBinding>();
    for (const b of bindings) {
      const key = `${b.supplierId}__${(b.supplierSku || "").trim().toUpperCase()}`;
      if (key.endsWith("__")) continue;
      m.set(key, b);
    }
    return m;
  }, [bindings]);

  const resolveBindingFor = useCallback(
    (supplierId: string, supplierSku: string): SupplierMaterialBinding | null => {
      const sku = (supplierSku || "").trim().toUpperCase();
      if (!sku || !supplierId) return null;
      return bindingsBySupplierSku.get(`${supplierId}__${sku}`) ?? null;
    },
    [bindingsBySupplierSku],
  );

  const materialByCode = useMemo(() => {
    const m = new Map<string, RawMaterial>();
    for (const rm of rawMaterials) {
      m.set(rm.itemCode.trim().toUpperCase(), rm);
    }
    return m;
  }, [rawMaterials]);

  const materialOptionsAll: MaterialOption[] = useMemo(
    () =>
      rawMaterials.map((rm) => ({
        itemCode: rm.itemCode,
        description: rm.description,
      })),
    [rawMaterials],
  );

  // ─── Build a card from a successful extraction ─────────────────────────
  const buildCard = useCallback(
    (
      fileName: string,
      ex: SupplierExtraction,
      sampleId: string | null,
    ): PreviewCard => {
      // Try to match the extracted supplierName to a real supplier in the
      // catalog. Failing that, fall back to the host-supplied default.
      const guessName = (ex.supplierName ?? "").trim().toUpperCase();
      const matched = guessName
        ? suppliers.find(
            (s) =>
              s.name.trim().toUpperCase() === guessName ||
              s.code.trim().toUpperCase() === guessName,
          )
        : null;
      const sId = matched?.id ?? defaultSupplierId ?? "";
      const sup = supplierById(sId);
      const orgCode = sup?.purchaseOrgCode ?? activeOrgs[0]?.code ?? "HOOKKA";

      const dt = (ex.docType ?? "").toUpperCase();
      const docNo = (ex.docNo ?? "").trim();
      let supInvNo = "";
      let supDoNo = "";
      if (docNo) {
        if (dt === "INVOICE") supInvNo = docNo;
        else if (dt === "DELIVERY_NOTE") supDoNo = docNo;
        else supInvNo = docNo;
      }

      const docDate =
        ex.docDate && /^\d{4}-\d{2}-\d{2}$/.test(ex.docDate)
          ? ex.docDate
          : todayISO();

      const lines: PreviewLine[] = (ex.lines ?? []).map((ln) => {
        const sku = (ln.supplierCode ?? "").trim();
        const binding = sId ? resolveBindingFor(sId, sku) : null;
        const rm = binding
          ? materialByCode.get(binding.materialCode.trim().toUpperCase())
          : null;
        const qty = Number(ln.qty) || 0;
        const unitPriceRM =
          ln.unitPrice == null || Number.isNaN(Number(ln.unitPrice))
            ? 0
            : Number(ln.unitPrice);
        const amountRM =
          ln.amount == null || Number.isNaN(Number(ln.amount))
            ? qty * unitPriceRM
            : Number(ln.amount);
        return {
          materialCode: rm?.itemCode ?? binding?.materialCode ?? "",
          materialName: rm?.description ?? ln.description ?? "",
          supplierSku: sku,
          description: ln.description ?? "",
          qty: qty > 0 ? qty : 1,
          uom: ln.uom ?? "",
          unitPriceRM,
          amountRM,
        };
      });

      return {
        id: `card-${makeUploadId()}`,
        fileName,
        sampleId,
        include: true,
        creating: false,
        createdPiNo: null,
        createError: null,
        supplierId: sId,
        purchaseOrgCode: orgCode,
        invoiceDate: docDate,
        supplierInvoiceNo: supInvNo,
        supplierDoNo: supDoNo,
        markedGold: false,
        lines: lines.length > 0 ? lines : [makeBlankLine()],
        originalExtraction: ex,
      };
    },
    [suppliers, defaultSupplierId, supplierById, activeOrgs, resolveBindingFor, materialByCode],
  );

  // ─── Drag-drop + multi-file extract ────────────────────────────────────
  const handleFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      const accepted = Array.from(fileList).filter((f) => {
        if (f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")) return true;
        if (f.type.startsWith("image/")) return true;
        const ext = f.name.toLowerCase();
        return /\.(jpe?g|png|webp)$/.test(ext);
      });
      if (accepted.length === 0) {
        setErrors(["Please upload PDF or image files."]);
        return;
      }
      const tooBig = accepted.find((f) => f.size > 32 * 1024 * 1024);
      if (tooBig) {
        setErrors([`${tooBig.name} is over the 32MB limit.`]);
        return;
      }

      const uploaded = accepted.map((f) => ({ id: makeUploadId(), file: f }));
      setFiles(uploaded);
      setErrors([]);
      setParsing(true);
      setFileProgress(Object.fromEntries(uploaded.map((u) => [u.id, "queued" as const])));

      // Kick off all extractions in parallel; one /extract call per file.
      const fanOut = uploaded.map(async (u) => {
        setFileProgress((prev) => ({ ...prev, [u.id]: "scanning" }));
        const supplierIdForHint = defaultSupplierId ?? null;
        const supplierForHint = supplierIdForHint
          ? supplierById(supplierIdForHint)
          : null;
        const r = await runExtractOnce(u.file, {
          supplierId: supplierIdForHint,
          supplierName: supplierForHint?.name ?? null,
        });
        return { upload: u, result: r };
      });

      const results = await Promise.all(fanOut);

      const newCards: PreviewCard[] = [];
      const errs: string[] = [];
      const nextProgress: Record<string, "done" | "failed"> = {};
      for (const { upload, result } of results) {
        if (result.kind === "ok") {
          nextProgress[upload.id] = "done";
          newCards.push(buildCard(upload.file.name, result.data, result.sampleId));
        } else {
          nextProgress[upload.id] = "failed";
          errs.push(`${upload.file.name}: ${result.error}`);
        }
      }
      setFileProgress((prev) => ({ ...prev, ...nextProgress }));
      if (newCards.length === 0) {
        setErrors(errs.length > 0 ? errs : ["Could not extract any documents."]);
        setParsing(false);
        return;
      }
      setCards(newCards);
      setErrors(errs);
      setParsing(false);
      setStep("preview");
    },
    [buildCard, defaultSupplierId, supplierById],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  // ─── Card mutators ─────────────────────────────────────────────────────
  const patchCard = (id: string, patch: Partial<PreviewCard>) =>
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const patchLine = (cardId: string, idx: number, patch: Partial<PreviewLine>) =>
    setCards((prev) =>
      prev.map((c) => {
        if (c.id !== cardId) return c;
        const lines = c.lines.map((l, i) => {
          if (i !== idx) return l;
          const merged = { ...l, ...patch };
          // Keep amount in sync when qty / unitPrice change unless the
          // caller explicitly patched amountRM as well.
          if (
            (patch.qty != null || patch.unitPriceRM != null) &&
            patch.amountRM == null
          ) {
            merged.amountRM =
              (Number(merged.qty) || 0) * (Number(merged.unitPriceRM) || 0);
          }
          return merged;
        });
        return { ...c, lines };
      }),
    );

  const addLine = (cardId: string) =>
    setCards((prev) =>
      prev.map((c) =>
        c.id === cardId ? { ...c, lines: [...c.lines, makeBlankLine()] } : c,
      ),
    );

  const removeLine = (cardId: string, idx: number) =>
    setCards((prev) =>
      prev.map((c) => {
        if (c.id !== cardId) return c;
        const next = c.lines.filter((_, i) => i !== idx);
        return { ...c, lines: next.length > 0 ? next : [makeBlankLine()] };
      }),
    );

  const removeCard = (cardId: string) =>
    setCards((prev) => prev.filter((c) => c.id !== cardId));

  // When the supplier on a card changes, re-resolve each line's internal
  // code from the bindings of the new supplier. We DON'T touch lines the
  // operator already manually bound (materialCode set with a matching
  // supplierSku for the new supplier).
  const onCardSupplierChange = (cardId: string, newSupplierId: string) => {
    setCards((prev) =>
      prev.map((c) => {
        if (c.id !== cardId) return c;
        const sup = suppliers.find((s) => s.id === newSupplierId);
        const orgCode =
          sup?.purchaseOrgCode ?? c.purchaseOrgCode ?? activeOrgs[0]?.code ?? "HOOKKA";
        const newLines = c.lines.map((l) => {
          const binding = resolveBindingFor(newSupplierId, l.supplierSku);
          if (binding) {
            const rm = materialByCode.get(binding.materialCode.trim().toUpperCase());
            return {
              ...l,
              materialCode: rm?.itemCode ?? binding.materialCode,
              // Only overwrite the description if it was blank or auto-derived.
              materialName: l.materialName.trim() ? l.materialName : (rm?.description ?? l.materialName),
            };
          }
          return l;
        });
        return {
          ...c,
          supplierId: newSupplierId,
          purchaseOrgCode: orgCode,
          lines: newLines,
        };
      }),
    );
  };

  // ─── Create the PIs ────────────────────────────────────────────────────
  const includedCards = cards.filter((c) => c.include && !c.createdPiNo);
  const includedCount = includedCards.length;

  const handleCreateAll = async () => {
    if (includedCount === 0) return;
    setStep("creating");
    // Mark each card as "creating" so the per-card row shows a spinner.
    setCards((prev) =>
      prev.map((c) =>
        c.include && !c.createdPiNo
          ? { ...c, creating: true, createError: null }
          : c,
      ),
    );

    const createdIds: string[] = [];

    await Promise.all(
      includedCards.map(async (card) => {
        try {
          // Fire-and-forget gold/correction sample save (best-effort).
          if (card.sampleId) {
            const edited =
              JSON.stringify(card.originalExtraction) !==
              JSON.stringify(serialiseCardAsExtraction(card));
            if (edited || card.markedGold) {
              fetch(`/api/scan-supplier/samples/${card.sampleId}/confirm`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  correctedJson: serialiseCardAsExtraction(card),
                  gold: card.markedGold,
                }),
              }).catch(() => {});
            }
          }

          const sup = supplierById(card.supplierId);
          if (!sup) {
            patchCard(card.id, {
              creating: false,
              createError: "Pick a supplier before creating",
            });
            return;
          }
          const validLines = card.lines.filter(
            (l) => (l.materialName || l.description).trim() !== "",
          );
          if (validLines.length === 0) {
            patchCard(card.id, {
              creating: false,
              createError: "Add at least one line",
            });
            return;
          }
          const payload: Record<string, unknown> = {
            supplierId: sup.id,
            supplierName: sup.name,
            invoiceDate: card.invoiceDate,
            remarks: `Scanned: ${card.fileName}`,
            status: "DRAFT",
            purchaseOrgCode: card.purchaseOrgCode,
            supplierInvoiceNo: card.supplierInvoiceNo.trim() || null,
            supplierDoNo: card.supplierDoNo.trim() || null,
            items: validLines.map((l) => ({
              materialCode: l.materialCode.trim() || null,
              materialName: (l.materialName || l.description).trim(),
              supplierSku: l.supplierSku.trim() || null,
              qty: Number(l.qty) || 0,
              unitPriceSen: Math.round((Number(l.unitPriceRM) || 0) * 100),
              lineType: "STOCKED" as const,
              grnItemId: null,
            })),
          };
          const res = await fetch("/api/purchase-invoices", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          const j = (await res.json().catch(() => null)) as
            | { success?: boolean; error?: string; data?: { piNo?: string; id?: string } }
            | null;
          if (!res.ok || !j?.success) {
            patchCard(card.id, {
              creating: false,
              createError: j?.error || `HTTP ${res.status}`,
            });
            return;
          }
          patchCard(card.id, {
            creating: false,
            createdPiNo: j.data?.piNo ?? "(created)",
            createError: null,
          });
          if (j.data?.id) createdIds.push(j.data.id);
          else if (j.data?.piNo) createdIds.push(j.data.piNo);
        } catch (err) {
          patchCard(card.id, {
            creating: false,
            createError: err instanceof Error ? err.message : "Network error",
          });
        }
      }),
    );

    setStep("done");
    if (createdIds.length > 0) onCreated(createdIds);
  };

  // Reset back to upload when modal closes externally — the setState is the
  // whole point of this effect.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional
    if (!open) reset();
  }, [open, reset]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-6xl max-h-[92vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-[#F5F0EB] flex items-center justify-center">
              <ScanLine className="h-5 w-5 text-[#6B5C32]" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-[#1F1D1B]">{title}</h2>
              <p className="text-sm text-[#6B7280]">
                Upload supplier delivery notes / invoices to auto-create Purchase Invoices
              </p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={requestClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Stepper */}
        <div className="px-6 py-3 bg-[#FAFAF9] border-b border-[#E2DDD8]">
          <div className="flex items-center gap-2 text-sm">
            <StepDot active={step === "upload"} done={step !== "upload"} label="1. Upload" />
            <div className="h-px w-8 bg-[#D1D5DB]" />
            <StepDot
              active={step === "preview"}
              done={step === "creating" || step === "done"}
              label="2. Preview"
            />
            <div className="h-px w-8 bg-[#D1D5DB]" />
            <StepDot active={step === "creating" || step === "done"} done={step === "done"} label="3. Create" />
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {step === "upload" && (
            <UploadStep
              files={files}
              parsing={parsing}
              fileProgress={fileProgress}
              errors={errors}
              fileInputRef={fileInputRef}
              onFiles={handleFiles}
              onDrop={handleDrop}
            />
          )}

          {step === "preview" && (
            <PreviewStep
              cards={cards}
              suppliers={suppliers}
              activeOrgs={activeOrgs}
              materialOptions={materialOptionsAll}
              errors={errors}
              onPatchCard={patchCard}
              onPatchLine={patchLine}
              onAddLine={addLine}
              onRemoveLine={removeLine}
              onRemoveCard={removeCard}
              onSupplierChange={onCardSupplierChange}
              onBack={() => {
                setStep("upload");
                setCards([]);
              }}
              onConfirm={handleCreateAll}
              includedCount={includedCount}
            />
          )}

          {step === "creating" && (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <Loader2 className="h-12 w-12 text-[#6B5C32] animate-spin" />
              <p className="text-lg font-medium text-[#1F1D1B]">Creating Purchase Invoices...</p>
              <p className="text-sm text-[#6B7280]">Processing {includedCount} document{includedCount !== 1 ? "s" : ""}</p>
            </div>
          )}

          {step === "done" && (
            <DoneStep
              cards={cards}
              onClose={handleClose}
              onScanMore={() => reset()}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────

function StepDot({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return (
    <span
      className={`px-3 py-1 rounded-full text-xs font-medium ${
        done
          ? "bg-green-100 text-green-800"
          : active
            ? "bg-[#6B5C32] text-white"
            : "bg-[#F3F4F6] text-[#9CA3AF]"
      }`}
    >
      {done && <CheckCircle className="h-3 w-3 inline mr-1" />}
      {label}
    </span>
  );
}

function FileStatusBadge({ status }: { status: "queued" | "scanning" | "done" | "failed" }) {
  if (status === "scanning") {
    return (
      <span className="flex items-center gap-1.5 text-xs font-medium text-[#6B5C32] flex-shrink-0">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Scanning
      </span>
    );
  }
  if (status === "done") {
    return (
      <span className="flex items-center gap-1.5 text-xs font-medium text-green-700 flex-shrink-0">
        <CheckCircle className="h-3.5 w-3.5" /> Done
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex items-center gap-1.5 text-xs font-medium text-red-700 flex-shrink-0">
        <AlertTriangle className="h-3.5 w-3.5" /> Failed
      </span>
    );
  }
  return <span className="text-xs font-medium text-[#9CA3AF] flex-shrink-0">Queued</span>;
}

function InfoCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="bg-[#FAFAF9] rounded-lg p-4 text-center">
      <div className="flex justify-center mb-1 text-[#6B5C32]">{icon}</div>
      <p className="text-sm font-medium text-[#1F1D1B]">{title}</p>
      <p className="text-xs text-[#6B7280]">{desc}</p>
    </div>
  );
}

function UploadStep({
  files,
  parsing,
  fileProgress,
  errors,
  fileInputRef,
  onFiles,
  onDrop,
}: {
  files: { id: string; file: File }[];
  parsing: boolean;
  fileProgress: Record<string, "queued" | "scanning" | "done" | "failed">;
  errors: string[];
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFiles: (files: FileList | null) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const doneCount = files.filter((u) => {
    const s = fileProgress[u.id];
    return s === "done" || s === "failed";
  }).length;
  return (
    <div className="space-y-4">
      <div
        className={`border-2 border-dashed border-[#D1D5DB] rounded-xl p-12 text-center transition-colors ${
          parsing ? "cursor-default" : "hover:border-[#6B5C32] hover:bg-[#FAFAF9] cursor-pointer"
        }`}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => e.preventDefault()}
        onDrop={onDrop}
        onClick={() => {
          if (!parsing) fileInputRef.current?.click();
        }}
      >
        {parsing ? (
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-12 w-12 text-[#6B5C32] animate-spin" />
            <p className="text-lg font-medium text-[#1F1D1B]">
              Scanning {files.length} file{files.length > 1 ? "s" : ""}...
            </p>
            <p className="text-sm text-[#6B7280]">
              Extracting items, codes, prices
            </p>
            {files.length > 1 && (
              <p className="text-xs text-[#9CA3AF]">
                {doneCount} of {files.length} files complete
              </p>
            )}
            <p className="text-xs text-[#9CA3AF]">
              AI reads each document (~30-60s) — a long invoice just takes a little longer, it isn&apos;t stuck.
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <Upload className="h-12 w-12 text-[#9CA3AF]" />
            <p className="text-lg font-medium text-[#1F1D1B]">Drop PDF files here</p>
            <p className="text-sm text-[#6B7280]">
              or click to browse — supports multiple files (max 32MB each)
            </p>
            <p className="text-xs text-[#9CA3AF]">
              AI-powered extraction works on any supplier delivery note or invoice
            </p>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,application/pdf,.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
          multiple
          className="hidden"
          onChange={(e) => onFiles(e.target.files)}
        />
      </div>

      {parsing && files.length > 0 && (
        <div className="border border-[#E2DDD8] rounded-lg divide-y divide-[#E2DDD8]">
          {files.map((u) => {
            const status = fileProgress[u.id] ?? "queued";
            return (
              <div
                key={u.id}
                className="flex items-center justify-between gap-3 px-4 py-2.5"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <FileText className="h-4 w-4 text-[#9CA3AF] flex-shrink-0" />
                  <span className="text-sm text-[#1F1D1B] truncate">{u.file.name}</span>
                </div>
                <FileStatusBadge status={status} />
              </div>
            );
          })}
        </div>
      )}

      {errors.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 space-y-1">
          {errors.map((err, i) => (
            <p key={i} className="text-sm text-red-700 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              {err}
            </p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        <InfoCard
          icon={<FileText className="h-6 w-6" />}
          title="Upload supplier doc"
          desc="Delivery notes / invoices (PDF or photo)"
        />
        <InfoCard
          icon={<Sparkles className="h-6 w-6" />}
          title="Auto-Parse"
          desc="Extracts codes, descriptions, qty, price"
        />
        <InfoCard
          icon={<CheckCircle className="h-6 w-6" />}
          title="Create as DRAFT"
          desc="Review then create each PI as DRAFT"
        />
      </div>
    </div>
  );
}

function PreviewStep({
  cards,
  suppliers,
  activeOrgs,
  materialOptions,
  errors,
  onPatchCard,
  onPatchLine,
  onAddLine,
  onRemoveLine,
  onRemoveCard,
  onSupplierChange,
  onBack,
  onConfirm,
  includedCount,
}: {
  cards: PreviewCard[];
  suppliers: Supplier[];
  activeOrgs: Organisation[];
  materialOptions: MaterialOption[];
  errors: string[];
  onPatchCard: (id: string, patch: Partial<PreviewCard>) => void;
  onPatchLine: (cardId: string, idx: number, patch: Partial<PreviewLine>) => void;
  onAddLine: (cardId: string) => void;
  onRemoveLine: (cardId: string, idx: number) => void;
  onRemoveCard: (cardId: string) => void;
  onSupplierChange: (cardId: string, newSupplierId: string) => void;
  onBack: () => void;
  onConfirm: () => void;
  includedCount: number;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-[#1F1D1B] flex items-center gap-2">
            Found {cards.length} document{cards.length !== 1 ? "s" : ""}
            <Badge className="bg-violet-50 text-violet-700 border border-violet-200">
              <Sparkles className="h-3 w-3 inline mr-1" /> AI
            </Badge>
          </h3>
          <p className="text-sm text-[#6B7280]">
            {includedCount} selected — edit any field, then create
          </p>
        </div>
      </div>

      {errors.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-1">
          {errors.map((err, i) => (
            <p key={i} className="text-sm text-amber-700 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" /> {err}
            </p>
          ))}
        </div>
      )}

      <div className="space-y-3 max-h-[65vh] overflow-y-auto">
        {cards.map((card) => (
          <PICard
            key={card.id}
            card={card}
            suppliers={suppliers}
            activeOrgs={activeOrgs}
            materialOptions={materialOptions}
            onPatch={(patch) => onPatchCard(card.id, patch)}
            onPatchLine={(idx, patch) => onPatchLine(card.id, idx, patch)}
            onAddLine={() => onAddLine(card.id)}
            onRemoveLine={(idx) => onRemoveLine(card.id, idx)}
            onRemoveCard={() => onRemoveCard(card.id)}
            onSupplierChange={(newId) => onSupplierChange(card.id, newId)}
          />
        ))}
      </div>

      <div className="flex items-center justify-between pt-4 border-t border-[#E2DDD8] sticky bottom-0 bg-white">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button
          variant="primary"
          onClick={onConfirm}
          disabled={includedCount === 0}
        >
          <CheckCircle className="h-4 w-4" />
          Create {includedCount} PI{includedCount !== 1 ? "s" : ""} as DRAFT
        </Button>
      </div>
    </div>
  );
}

function PICard({
  card,
  suppliers,
  activeOrgs,
  materialOptions,
  onPatch,
  onPatchLine,
  onAddLine,
  onRemoveLine,
  onRemoveCard,
  onSupplierChange,
}: {
  card: PreviewCard;
  suppliers: Supplier[];
  activeOrgs: Organisation[];
  materialOptions: MaterialOption[];
  onPatch: (patch: Partial<PreviewCard>) => void;
  onPatchLine: (idx: number, patch: Partial<PreviewLine>) => void;
  onAddLine: () => void;
  onRemoveLine: (idx: number) => void;
  onRemoveCard: () => void;
  onSupplierChange: (newId: string) => void;
}) {
  const totalQty = card.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const totalRM = card.lines.reduce(
    (s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPriceRM) || 0),
    0,
  );

  return (
    <Card
      className={`border-2 transition-colors ${
        card.include ? "border-[#6B5C32] bg-[#FAFAF9]" : "border-[#E2DDD8]"
      }`}
    >
      <CardContent className="p-4 space-y-3">
        {/* Top row — include + supplier + org + invoice date + gold + remove */}
        <div className="flex flex-wrap items-start gap-3">
          <input
            type="checkbox"
            checked={card.include}
            onChange={(e) => onPatch({ include: e.target.checked })}
            disabled={!!card.createdPiNo}
            className="mt-2 h-4 w-4 rounded border-[#D1D5DB] text-[#6B5C32] focus:ring-[#6B5C32]"
          />
          <div className="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div>
              <label className="block text-xs text-[#9CA3AF] mb-0.5">Supplier *</label>
              <select
                className="w-full px-2 py-1.5 text-sm border border-[#E2DDD8] rounded bg-white focus:border-[#6B5C32] focus:outline-none"
                value={card.supplierId}
                onChange={(e) => onSupplierChange(e.target.value)}
                disabled={!!card.createdPiNo}
              >
                <option value="">— Select —</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} - {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-[#9CA3AF] mb-0.5">Purchase company *</label>
              <select
                className="w-full px-2 py-1.5 text-sm border border-[#E2DDD8] rounded bg-white focus:border-[#6B5C32] focus:outline-none"
                value={card.purchaseOrgCode}
                onChange={(e) => onPatch({ purchaseOrgCode: e.target.value })}
                disabled={!!card.createdPiNo}
              >
                {activeOrgs.length === 0 ? (
                  <option value="HOOKKA">HOOKKA</option>
                ) : (
                  activeOrgs.map((o) => (
                    <option key={o.code} value={o.code}>
                      {o.name}
                    </option>
                  ))
                )}
              </select>
            </div>
            <div>
              <label className="block text-xs text-[#9CA3AF] mb-0.5">Invoice Date *</label>
              <Input
                type="date"
                className="h-8"
                value={card.invoiceDate}
                onChange={(e) => onPatch({ invoiceDate: e.target.value })}
                disabled={!!card.createdPiNo}
              />
            </div>
          </div>
          <button
            type="button"
            onClick={() => onPatch({ markedGold: !card.markedGold })}
            disabled={!!card.createdPiNo}
            className={`mt-5 text-[10px] px-2 py-1 rounded border transition-colors flex items-center gap-1 ${
              card.markedGold
                ? "bg-amber-100 text-amber-800 border-amber-300"
                : "bg-white text-[#6B7280] border-[#D1D5DB] hover:border-amber-300"
            } disabled:opacity-50`}
            title="Mark this extraction as a gold reference — future OCR calls will use it as a few-shot example"
          >
            <Star className={`h-3 w-3 ${card.markedGold ? "fill-amber-500 text-amber-500" : ""}`} />
            {card.markedGold ? "Gold" : "Mark gold"}
          </button>
          <button
            type="button"
            onClick={onRemoveCard}
            disabled={!!card.createdPiNo}
            className="mt-5 text-[#9CA3AF] hover:text-[#9A3A2D] disabled:opacity-30"
            title="Remove this card"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>

        {/* Second row — supplier invoice no + DO no */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pl-7">
          <div>
            <label className="block text-xs text-[#9CA3AF] mb-0.5">Supplier Invoice No.</label>
            <Input
              className="h-8"
              value={card.supplierInvoiceNo}
              onChange={(e) => onPatch({ supplierInvoiceNo: e.target.value })}
              placeholder="Supplier's invoice number"
              disabled={!!card.createdPiNo}
            />
          </div>
          <div>
            <label className="block text-xs text-[#9CA3AF] mb-0.5">Supplier DO No.</label>
            <Input
              className="h-8"
              value={card.supplierDoNo}
              onChange={(e) => onPatch({ supplierDoNo: e.target.value })}
              placeholder="Supplier's delivery order number"
              disabled={!!card.createdPiNo}
            />
          </div>
        </div>

        {/* File chip + totals */}
        <div className="flex items-center gap-2 flex-wrap text-xs text-[#6B7280] pl-7">
          <Badge className="bg-violet-50 text-violet-700 border border-violet-200">
            <FileText className="h-3 w-3 inline mr-0.5" /> {card.fileName}
          </Badge>
          <span>{card.lines.length} lines · {totalQty} qty</span>
          <span className="text-[#1F1D1B] font-medium">RM {totalRM.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          {card.creating && (
            <span className="flex items-center gap-1 text-[#6B5C32]">
              <Loader2 className="h-3 w-3 animate-spin" /> Creating...
            </span>
          )}
          {card.createdPiNo && (
            <Badge className="bg-green-100 text-green-800 border border-green-300">
              <CheckCircle className="h-3 w-3 inline mr-0.5" /> Created {card.createdPiNo}
            </Badge>
          )}
          {card.createError && (
            <Badge className="bg-red-100 text-red-800 border border-red-300">
              <AlertTriangle className="h-3 w-3 inline mr-0.5" /> {card.createError}
            </Badge>
          )}
        </div>

        {/* Line items table */}
        <div className="border border-[#E2DDD8] rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[#F0ECE9] text-[#6B7280]">
              <tr>
                <th className="text-left px-2 py-1.5 font-medium" style={{ minWidth: 110 }}>
                  Internal Code
                </th>
                <th className="text-left px-2 py-1.5 font-medium" style={{ minWidth: 130 }}>
                  Supplier SKU
                </th>
                <th className="text-left px-2 py-1.5 font-medium">Description</th>
                <th className="text-right px-2 py-1.5 font-medium w-20">Qty</th>
                <th className="text-left px-2 py-1.5 font-medium w-16">UoM</th>
                <th className="text-right px-2 py-1.5 font-medium w-24">Unit Price</th>
                <th className="text-right px-2 py-1.5 font-medium w-24">Amount</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {card.lines.map((line, i) => (
                <tr key={i} className="border-t border-[#EFEAE6] align-top">
                  {/* Internal Code — badge if bound, picker affordance if not */}
                  <td className="px-2 py-1">
                    {line.materialCode ? (
                      <span
                        className="inline-flex items-center px-2 py-1 rounded text-xs font-mono bg-[#F0ECE9] text-[#1F1D1B]"
                        title="Bound to catalog item"
                      >
                        {line.materialCode}
                        <button
                          type="button"
                          onClick={() =>
                            onPatchLine(i, { materialCode: "", materialName: line.description || line.materialName })
                          }
                          disabled={!!card.createdPiNo}
                          className="ml-1 text-[#9CA3AF] hover:text-[#9A3A2D]"
                          title="Unbind"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ) : (
                      <MaterialPicker
                        className="h-8"
                        inputClassName="h-8 text-xs"
                        placeholder="(pick)"
                        value={line.materialName || line.description}
                        options={materialOptions}
                        onPick={(o) =>
                          onPatchLine(i, {
                            materialCode: o.itemCode,
                            materialName: o.description,
                          })
                        }
                        onTyped={(text) => onPatchLine(i, { materialName: text })}
                      />
                    )}
                  </td>
                  <td className="px-1 py-1">
                    <Input
                      className="h-8 text-xs"
                      value={line.supplierSku}
                      onChange={(e) => onPatchLine(i, { supplierSku: e.target.value })}
                      disabled={!!card.createdPiNo}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <Input
                      className="h-8 text-xs"
                      value={line.materialName || line.description}
                      onChange={(e) => onPatchLine(i, { materialName: e.target.value })}
                      disabled={!!card.createdPiNo}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <Input
                      type="number"
                      className="h-8 text-xs text-right"
                      value={num(line.qty)}
                      onChange={(e) =>
                        onPatchLine(i, { qty: e.target.value === "" ? 0 : Number(e.target.value) })
                      }
                      onFocus={(e) => e.currentTarget.select()}
                      disabled={!!card.createdPiNo}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <Input
                      className="h-8 text-xs"
                      value={line.uom}
                      onChange={(e) => onPatchLine(i, { uom: e.target.value })}
                      disabled={!!card.createdPiNo}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <Input
                      type="number"
                      step="0.01"
                      className="h-8 text-xs text-right"
                      value={num(line.unitPriceRM)}
                      onChange={(e) =>
                        onPatchLine(i, {
                          unitPriceRM: e.target.value === "" ? 0 : Number(e.target.value),
                        })
                      }
                      onFocus={(e) => e.currentTarget.select()}
                      disabled={!!card.createdPiNo}
                    />
                  </td>
                  <td className="px-1 py-1 text-right text-xs text-[#1F1D1B]">
                    {((Number(line.qty) || 0) * (Number(line.unitPriceRM) || 0)).toLocaleString("en-MY", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </td>
                  <td className="px-1 py-1 text-center">
                    <button
                      type="button"
                      onClick={() => onRemoveLine(i)}
                      disabled={!!card.createdPiNo}
                      className="text-[#9CA3AF] hover:text-[#9A3A2D] disabled:opacity-30"
                      title="Remove line"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-2 py-1 bg-[#FAFAF9] border-t border-[#E2DDD8] flex justify-between items-center">
            <button
              type="button"
              onClick={onAddLine}
              disabled={!!card.createdPiNo}
              className="text-xs text-[#6B5C32] hover:underline flex items-center gap-1 disabled:opacity-50"
            >
              <Plus className="h-3 w-3" /> Add line
            </button>
            <span className="text-[10px] text-[#9CA3AF]">
              Internal Code auto-resolves from supplier bindings · click (pick) to bind manually
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function DoneStep({
  cards,
  onClose,
  onScanMore,
}: {
  cards: PreviewCard[];
  onClose: () => void;
  onScanMore: () => void;
}) {
  const created = cards.filter((c) => c.createdPiNo);
  const failed = cards.filter((c) => c.createError);
  return (
    <div className="space-y-6 py-4">
      {created.length > 0 && (
        <div className="text-center">
          <div className="mx-auto h-16 w-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
            <CheckCircle className="h-8 w-8 text-green-600" />
          </div>
          <h3 className="text-xl font-bold text-[#1F1D1B]">
            {created.length} Purchase Invoice{created.length !== 1 ? "s" : ""} Created!
          </h3>
          <p className="text-sm text-[#6B7280] mt-1">
            All created as DRAFT — review and confirm from the invoice detail page
          </p>
        </div>
      )}

      {created.length > 0 && (
        <div className="space-y-2">
          {created.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between bg-green-50 rounded-lg px-4 py-3"
            >
              <div>
                <span className="font-bold text-green-800">{c.createdPiNo}</span>
                <span className="text-sm text-green-600 ml-2">from {c.fileName}</span>
              </div>
              <Badge className="text-green-700 border border-green-300">
                {c.lines.length} lines
              </Badge>
            </div>
          ))}
        </div>
      )}

      {failed.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 space-y-2">
          <p className="font-medium text-red-800">
            {failed.length} document{failed.length !== 1 ? "s" : ""} failed:
          </p>
          {failed.map((c) => (
            <p key={c.id} className="text-sm text-red-700">
              <span className="font-medium">{c.fileName}:</span> {c.createError}
            </p>
          ))}
        </div>
      )}

      <div className="flex items-center justify-center gap-3 pt-4">
        <Button variant="outline" onClick={onScanMore}>
          Scan more
        </Button>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

// ─── Card → SupplierExtraction (for the gold/correction sample write) ────
function serialiseCardAsExtraction(card: PreviewCard): SupplierExtraction {
  return {
    supplierName: card.originalExtraction.supplierName ?? null,
    docType: card.originalExtraction.docType ?? null,
    docNo:
      card.supplierInvoiceNo.trim() ||
      card.supplierDoNo.trim() ||
      card.originalExtraction.docNo ||
      null,
    docDate: card.invoiceDate || card.originalExtraction.docDate || null,
    currency: card.originalExtraction.currency ?? null,
    lines: card.lines.map((l) => ({
      supplierCode: l.supplierSku || null,
      description: (l.materialName || l.description) || null,
      qty: Number(l.qty) || null,
      uom: l.uom || null,
      unitPrice: Number(l.unitPriceRM) || null,
      amount:
        (Number(l.qty) || 0) * (Number(l.unitPriceRM) || 0) || null,
    })),
    subtotal: card.originalExtraction.subtotal ?? null,
    tax: card.originalExtraction.tax ?? null,
    total: card.originalExtraction.total ?? null,
  };
}
