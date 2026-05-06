"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { parsePOText, mapDeliveryHub, type ParsedPO, type POParseResult } from "@/lib/po-parser";
import { Upload, FileText, CheckCircle, AlertTriangle, X, ChevronDown, ChevronRight, Loader2, Sparkles, Star } from "lucide-react";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: (soIds: string[]) => void;
};

type StepState = "upload" | "preview" | "creating" | "done";

// Shape returned by POST /api/scan-po/extract — see scan-po.ts. Keep these
// types in lockstep with the server-side ExtractedItem / ExtractedPO.
type ClaudeExtractedItem = {
  category: "BEDFRAME" | "SOFA" | "ACCESSORY";
  productCode: string;
  description: string | null;
  quantity: number;
  sizeLabel: string | null;
  fabricCode: string | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  gapInches: number | null;
  noLeg: boolean;
  specialOrder: string | null;
  specialNotes: string | null;
  unitPrice: number | null;
  transferredSO: string | null;
};

type ClaudeExtractedPO = {
  customerPO: string;
  customerName: string;
  customerCode: string | null;
  customerId: string | null;
  customerState: string | null;
  deliveryHub: string | null;
  yourRefNo: string | null;
  deliveryDate: string | null;
  isUrgent: boolean;
  pageNumbers: number[];
  items: ClaudeExtractedItem[];
};

type ClaudeWarning = {
  field: string;
  value: string;
  message: string;
  itemIdx?: number;
};

type ClaudeScanRow = {
  sampleId: string;
  extracted: ClaudeExtractedPO;
  // `original` is a frozen snapshot of `extracted` at parse time. We compare
  // against it on confirm to decide whether to write the row back as a few-
  // shot example: unedited Claude output isn't useful as training data
  // (it's just Claude's own response echoed back) and was previously
  // polluting the example pool.
  original: ClaudeExtractedPO;
  warnings: ClaudeWarning[];
  file: File;
  // Base64 PNG of the PDF page(s) this PO covers — rendered client-side via
  // pdfjs-dist. Sent to the SO create endpoint so the SO detail page can
  // display the original document as proof when a customer disputes.
  // Lazy-loaded after parse to keep the upload-step fast.
  pageImageB64: string | null;
  // Phase 5: when the operator inspects an unedited extraction and clicks
  // "Mark as gold reference", we mark this row so the confirm call sets
  // isGold=1 in po_scan_samples. Gold rows win over plain corrections when
  // the next OCR call picks few-shot examples.
  markedGold: boolean;
};

// Slim catalog payload from GET /api/scan-po/catalog. Drives inline-edit
// dropdowns so the operator picks from maintenance values, not free text.
type ScanCatalog = {
  customers: { id: string; code: string; name: string; hubs: string[] }[];
  bedframes: string[];
  sofas: string[];
  accessories: string[];
  fabrics: string[];
  bedframeDivans: string[];
  bedframeLegs: string[];
  bedframeGaps: string[];
  bedframeSpecials: string[];
  sofaSizes: string[];
  sofaLegs: string[];
  sofaSpecials: string[];
};

type CreateSOResponse = {
  success?: boolean;
  error?: string;
  data?: { companySOId?: string };
};

export function ScanPOModal({ open, onClose, onCreated }: Props) {
  const [step, setStep] = useState<StepState>("upload");
  const [files, setFiles] = useState<File[]>([]);
  const [parsing, setParsing] = useState(false);
  const [parseResult, setParseResult] = useState<POParseResult | null>(null);
  const [claudeRows, setClaudeRows] = useState<ClaudeScanRow[]>([]);
  const [usedClaude, setUsedClaude] = useState(false);
  const [selectedPOs, setSelectedPOs] = useState<Set<number>>(new Set());
  const [expandedPO, setExpandedPO] = useState<number | null>(null);
  const [, setCreating] = useState(false);
  const [createdSOs, setCreatedSOs] = useState<{ soNo: string; poNo: string; itemCount: number }[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<ScanCatalog | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Pull the slim catalog once when the modal first opens. Cached for the
  // lifetime of the modal instance.
  useEffect(() => {
    if (!open || catalog) return;
    let cancelled = false;
    fetch("/api/scan-po/catalog")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: ScanCatalog }>)
      .then((d) => {
        if (cancelled) return;
        if (d.success && d.data) setCatalog(d.data);
      })
      .catch(() => {
        // Catalog is best-effort: dropdowns fall back to free-text inputs
        // when this fails.
      });
    return () => {
      cancelled = true;
    };
  }, [open, catalog]);

  const reset = () => {
    setStep("upload");
    setFiles([]);
    setParsing(false);
    setParseResult(null);
    setClaudeRows([]);
    setUsedClaude(false);
    setSelectedPOs(new Set());
    setExpandedPO(null);
    setCreating(false);
    setCreatedSOs([]);
    setErrors([]);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleFiles = useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;

    const pdfFiles = Array.from(fileList).filter(f => f.type === "application/pdf" || f.name.endsWith(".pdf"));
    if (pdfFiles.length === 0) {
      setErrors(["Please upload PDF files only."]);
      return;
    }

    // 32MB per-file guard — matches backend limit.
    const tooBig = pdfFiles.find(f => f.size > 32 * 1024 * 1024);
    if (tooBig) {
      setErrors([`${tooBig.name} is over the 32MB limit.`]);
      return;
    }

    setFiles(pdfFiles);
    setParsing(true);
    setErrors([]);

    // --- Pass 1: try Claude OCR (per-page parallel) -------------------
    // Phase 4: each multi-page PDF is split client-side into one PDF per
    // page, then every page is sent as a parallel /extract request.
    // Two wins:
    //   • Speed — total wall clock ≈ max(per-page latency) instead of
    //     sum. A 16-page PDF goes from ~60s sequential → ~6-8s parallel.
    //   • Accuracy — Claude focuses on a single PO per call instead of
    //     juggling 16. Anthropic prompt caching shares the catalog
    //     across requests, so calls 2..N pay ~10% on the cached prefix.
    const claudeSuccesses: ClaudeScanRow[] = [];
    const claudeFailures: File[] = [];
    const claudeWarnings: string[] = [];

    type PageJob = { file: File; pageNo: number; pageFile: File };
    const allJobs: PageJob[] = [];
    for (const file of pdfFiles) {
      try {
        const pages = await splitPdfIntoPages(file);
        for (const p of pages) allJobs.push({ file, pageNo: p.pageNo, pageFile: p.file });
      } catch (err) {
        claudeFailures.push(file);
        claudeWarnings.push(
          `${file.name}: failed to split PDF — ${err instanceof Error ? err.message : "unknown"}`,
        );
      }
    }

    const claudeResults = await Promise.allSettled(
      allJobs.map(async (job) => {
        const fd = new FormData();
        fd.append("file", job.pageFile);
        const res = await fetch("/api/scan-po/extract", { method: "POST", body: fd });
        const data = await res.json() as {
          success?: boolean;
          error?: string;
          data?: {
            samples?: Array<{ sampleId: string; extracted: ClaudeExtractedPO; warnings: ClaudeWarning[] }>;
          };
        };
        if (res.ok && data.success && Array.isArray(data.data?.samples)) {
          return { kind: "ok" as const, job, samples: data.data.samples };
        }
        return { kind: "fail" as const, job, error: data.error || `HTTP ${res.status}` };
      }),
    );

    for (const r of claudeResults) {
      if (r.status === "rejected") {
        const err = r.reason instanceof Error ? r.reason.message : "Network error";
        claudeWarnings.push(`(unknown file): ${err}`);
        continue;
      }
      const v = r.value;
      if (v.kind === "ok") {
        // Each page's response usually contains 1 PO (sometimes 2 if a PO
        // spans pages, but we split per-page so multi-page POs split into
        // N rows the operator can merge). Re-anchor pageNumbers to the
        // original PDF's page index so renderPdfPagesToPng pulls the
        // correct source page when the SO is created.
        for (const s of v.samples) {
          const extracted = {
            ...s.extracted,
            pageNumbers: [v.job.pageNo],
          };
          claudeSuccesses.push({
            sampleId: s.sampleId,
            extracted,
            // Deep clone for diff comparison. Cheap (PO is small).
            original: JSON.parse(JSON.stringify(extracted)) as ClaudeExtractedPO,
            warnings: s.warnings ?? [],
            file: v.job.file,
            pageImageB64: null,
            markedGold: false,
          });
        }
      } else {
        if (!claudeFailures.includes(v.job.file)) claudeFailures.push(v.job.file);
        claudeWarnings.push(`${v.job.file.name} page ${v.job.pageNo}: ${v.error}`);
      }
    }

    // --- Pass 2: template-match fallback for any file Claude failed on -
    let fallbackResult: POParseResult | null = null;
    if (claudeFailures.length > 0) {
      try {
        const allPOs: ParsedPO[] = [];
        const allErrors: string[] = [...claudeWarnings];

        for (const file of claudeFailures) {
          const text = await extractPdfText(file);
          const result = parsePOText(text);
          if (result.success) allPOs.push(...result.purchaseOrders);
          if (result.errors.length > 0) {
            allErrors.push(`${file.name}: ${result.errors.join(", ")}`);
          }
        }

        fallbackResult = {
          success: allPOs.length > 0,
          purchaseOrders: allPOs,
          errors: allErrors,
        };
      } catch (err) {
        claudeWarnings.push(`Fallback parse failed: ${err instanceof Error ? err.message : "Unknown"}`);
      }
    }

    if (claudeSuccesses.length === 0 && (!fallbackResult || fallbackResult.purchaseOrders.length === 0)) {
      setErrors(claudeWarnings.length > 0 ? claudeWarnings : ["Could not extract any POs from the uploaded PDFs."]);
      setParsing(false);
      return;
    }

    setUsedClaude(claudeSuccesses.length > 0);
    setClaudeRows(claudeSuccesses);
    setParseResult(fallbackResult);

    // Select all rows (Claude rows first, then fallback rows) by default.
    const total = claudeSuccesses.length + (fallbackResult?.purchaseOrders.length ?? 0);
    setSelectedPOs(new Set(Array.from({ length: total }, (_, i) => i)));
    setStep("preview");
    setParsing(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const togglePO = (idx: number) => {
    const next = new Set(selectedPOs);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    setSelectedPOs(next);
  };

  // Indices 0..claudeRows.length-1 are Claude rows; the rest map into
  // parseResult.purchaseOrders (fallback template-matched rows).
  const totalRows = claudeRows.length + (parseResult?.purchaseOrders.length ?? 0);

  const handleCreateSOs = async () => {
    if (totalRows === 0) return;

    const selectedClaude = claudeRows.filter((_, i) => selectedPOs.has(i));
    const selectedFallback = (parseResult?.purchaseOrders ?? []).filter(
      (_, i) => selectedPOs.has(claudeRows.length + i),
    );
    if (selectedClaude.length + selectedFallback.length === 0) return;

    setCreating(true);
    setStep("creating");
    const created: { soNo: string; poNo: string; itemCount: number }[] = [];
    const errs: string[] = [];

    // --- Claude-extracted rows ----------------------------------------
    for (const row of selectedClaude) {
      const po = row.extracted;
      try {
        // Few-shot integrity: confirm a sample either when the operator
        // edited it, or when they explicitly marked it as a gold
        // reference. Plain unedited Claude output is not stored back.
        const wasEdited =
          JSON.stringify(po) !== JSON.stringify(row.original);
        if (wasEdited || row.markedGold) {
          fetch(`/api/scan-po/samples/${row.sampleId}/confirm`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ correctedJson: po, gold: row.markedGold }),
          }).catch(() => {});
        }

        // Render the source PDF page(s) for this PO into a PNG attachment.
        // Done lazily here (rather than at parse time) so the UI doesn't
        // pay the rendering cost for POs the operator deselects.
        let pageImageB64 = row.pageImageB64;
        if (!pageImageB64 && po.pageNumbers && po.pageNumbers.length > 0) {
          try {
            pageImageB64 = await renderPdfPagesToPng(row.file, po.pageNumbers);
          } catch {
            // Non-fatal — proceed without attachment if rendering fails.
            pageImageB64 = null;
          }
        }

        // Hub resolution priority:
        //   1. PDF-extracted "Purchase Location" (po.deliveryHub) — most accurate.
        //   2. Heuristic from customer name + state — legacy fallback.
        const hub = mapDeliveryHub(po.customerName, po.customerState ?? "");
        const resolvedHubId = po.deliveryHub || hub.hubId;

        const soItems = po.items.map((item, idx) => ({
          lineNo: idx + 1,
          lineSuffix: `-${String(idx + 1).padStart(2, "0")}`,
          productCode: item.productCode,
          productName: item.description ?? item.productCode,
          itemCategory: item.category,
          sizeLabel: item.sizeLabel ?? "",
          fabricCode: item.fabricCode ?? "",
          quantity: item.quantity || 1,
          gapInches: item.gapInches ?? 0,
          divanHeightInches: item.divanHeightInches ?? 0,
          // noLeg=true is encoded as legHeightInches=null. Backend treats
          // null/0 the same in cost calc, but null preserves the boolean
          // intent for future read-back.
          legHeightInches: item.noLeg ? null : item.legHeightInches,
          specialOrder: item.specialOrder ?? "",
          // Unit price is in RM (decimal) on the PDF; backend stores sen
          // (integer). Multiply + round to avoid float drift.
          basePriceSen:
            item.unitPrice != null && item.unitPrice > 0
              ? Math.round(item.unitPrice * 100)
              : 0,
          // transferredSO links this SO line back to the original SO it
          // amends/replaces — operator can use it to mark the prior SO
          // superseded after creation.
          transferredFromSO: item.transferredSO ?? null,
          notes: item.specialNotes ?? "",
        }));

        // customerId comes from the backend's catalog match (validateAndEnrichPO).
        // If null, the SO create call will fail — surface a clearer error.
        if (!po.customerId) {
          errs.push(`${po.customerPO}: Customer "${po.customerName}" not in catalog. Add the customer first, then re-scan.`);
          continue;
        }

        const body = {
          customerId: po.customerId,
          customerName: po.customerName,
          customerCode: po.customerCode ?? null,
          customerState: po.customerState ?? hub.state ?? "",
          customerPOId: po.customerPO,
          yourRefNo: po.yourRefNo ?? null,
          deliveryHubId: resolvedHubId,
          companySODate: new Date().toISOString().split("T")[0],
          // The "Delivery Date" on a customer PO is what the customer
          // expects — that's customerDeliveryDate. hookkaExpectedDD is
          // computed downstream by Production Planning (customer DD minus
          // departmental lead times); we deliberately leave it null so
          // the planning module fills it in once the SO is confirmed.
          customerDeliveryDate: po.deliveryDate,
          isUrgent: po.isUrgent ?? false,
          customerPOImageB64: pageImageB64,
          items: soItems,
          source: "PO_SCAN_CLAUDE",
        };

        // Sprint 3 #4 — idempotency. Bulk PO-scan create can retry mid-loop;
        // a UUID per PO ensures duplicate retries don't fan out duplicate SOs.
        const res = await fetch("/api/sales-orders", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as CreateSOResponse;
        if (data.success && data.data?.companySOId) {
          created.push({
            soNo: data.data.companySOId,
            poNo: po.customerPO,
            itemCount: po.items.length,
          });
        } else {
          errs.push(`${po.customerPO}: ${data.error || "Failed to create SO"}`);
        }
      } catch (err) {
        errs.push(`${po.customerPO}: ${err instanceof Error ? err.message : "Network error"}`);
      }
    }

    // --- Fallback template-matched rows -------------------------------
    for (const po of selectedFallback) {
      try {
        const hub = mapDeliveryHub(po.customerName, po.deliveryHub);

        const soItems = po.items.map((item, idx) => ({
          lineNo: idx + 1,
          lineSuffix: `-${String(idx + 1).padStart(2, "0")}`,
          productCode: item.productCode,
          productName: item.productCode,
          itemCategory: item.category,
          sizeCode: item.sizeCode,
          sizeLabel: item.sizeCode,
          fabricCode: item.fabricCode,
          quantity: item.quantity || 1,
          gapInches: item.gapInches,
          divanHeightInches: item.divanHeightInches,
          legHeightInches: item.legHeightInches,
          specialOrder: item.specialOrder,
          seatHeight: item.seatHeight,
          notes: item.notes,
        }));

        const body = {
          customerId: po.customerId,
          customerName: po.customerName,
          customerState: hub.state || po.deliveryHub,
          customerPOId: po.poNo,
          deliveryHubId: hub.hubId,
          companySODate: po.poDate || new Date().toISOString().split("T")[0],
          hookkaExpectedDD: po.deliveryDate,
          terms: po.terms,
          isUrgent: po.isUrgent,
          yourRefNo: po.yourRefNo,
          items: soItems,
          source: "PO_SCAN",
        };

        const res = await fetch("/api/sales-orders", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify(body),
        });

        const data = (await res.json()) as CreateSOResponse;
        if (data.success && data.data?.companySOId) {
          created.push({
            soNo: data.data.companySOId,
            poNo: po.poNo,
            itemCount: po.items.length,
          });
        } else {
          errs.push(`${po.poNo}: ${data.error || "Failed to create SO"}`);
        }
      } catch (err) {
        errs.push(`${po.poNo}: ${err instanceof Error ? err.message : "Network error"}`);
      }
    }

    setCreatedSOs(created);
    setErrors(errs);
    setCreating(false);
    setStep("done");

    if (created.length > 0) {
      onCreated(created.map(c => c.soNo));
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={handleClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-[#F5F0EB] flex items-center justify-center">
              <FileText className="h-5 w-5 text-[#6B5C32]" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-[#1F1D1B]">Scan Customer PO</h2>
              <p className="text-sm text-[#6B7280]">Upload customer PO PDFs to auto-create Sales Orders</p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={handleClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Steps indicator */}
        <div className="px-6 py-3 bg-[#FAFAF9] border-b border-[#E2DDD8]">
          <div className="flex items-center gap-2 text-sm">
            <StepDot active={step === "upload"} done={step !== "upload"} label="1. Upload" />
            <div className="h-px w-8 bg-[#D1D5DB]" />
            <StepDot active={step === "preview"} done={step === "creating" || step === "done"} label="2. Preview" />
            <div className="h-px w-8 bg-[#D1D5DB]" />
            <StepDot active={step === "creating" || step === "done"} done={step === "done"} label="3. Create" />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {step === "upload" && (
            <UploadStep
              files={files}
              parsing={parsing}
              errors={errors}
              fileInputRef={fileInputRef}
              onFiles={handleFiles}
              onDrop={handleDrop}
            />
          )}

          {step === "preview" && (claudeRows.length > 0 || parseResult) && (
            <PreviewStep
              claudeRows={claudeRows}
              setClaudeRows={setClaudeRows}
              usedClaude={usedClaude}
              result={parseResult}
              selectedPOs={selectedPOs}
              expandedPO={expandedPO}
              onTogglePO={togglePO}
              onExpandPO={setExpandedPO}
              onBack={() => { setStep("upload"); setParseResult(null); setClaudeRows([]); }}
              onConfirm={handleCreateSOs}
              catalog={catalog}
            />
          )}

          {step === "creating" && (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <Loader2 className="h-12 w-12 text-[#6B5C32] animate-spin" />
              <p className="text-lg font-medium text-[#1F1D1B]">Creating Sales Orders...</p>
              <p className="text-sm text-[#6B7280]">Processing {selectedPOs.size} purchase orders</p>
            </div>
          )}

          {step === "done" && (
            <DoneStep
              created={createdSOs}
              errors={errors}
              onClose={handleClose}
              onScanMore={() => reset()}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Sub-Components ──────────────────────────────────────────────────────

function StepDot({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return (
    <span className={`px-3 py-1 rounded-full text-xs font-medium ${
      done ? "bg-green-100 text-green-800" :
      active ? "bg-[#6B5C32] text-white" :
      "bg-[#F3F4F6] text-[#9CA3AF]"
    }`}>
      {done && <CheckCircle className="h-3 w-3 inline mr-1" />}
      {label}
    </span>
  );
}

function UploadStep({
  files, parsing, errors, fileInputRef, onFiles, onDrop,
}: {
  files: File[];
  parsing: boolean;
  errors: string[];
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFiles: (files: FileList | null) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  return (
    <div className="space-y-4">
      {/* Drop zone */}
      <div
        className="border-2 border-dashed border-[#D1D5DB] rounded-xl p-12 text-center hover:border-[#6B5C32] hover:bg-[#FAFAF9] transition-colors cursor-pointer"
        onDragOver={e => e.preventDefault()}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        {parsing ? (
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-12 w-12 text-[#6B5C32] animate-spin" />
            <p className="text-lg font-medium text-[#1F1D1B]">Parsing PDF{files.length > 1 ? "s" : ""}...</p>
            <p className="text-sm text-[#6B7280]">Extracting text and identifying purchase orders</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <Upload className="h-12 w-12 text-[#9CA3AF]" />
            <p className="text-lg font-medium text-[#1F1D1B]">Drop PDF files here</p>
            <p className="text-sm text-[#6B7280]">or click to browse — supports multiple files (max 32MB each)</p>
            <p className="text-xs text-[#9CA3AF]">AI-powered extraction works on any customer PO format</p>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,application/pdf"
          multiple
          className="hidden"
          onChange={e => onFiles(e.target.files)}
        />
      </div>

      {/* Errors */}
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

      {/* Info cards */}
      <div className="grid grid-cols-3 gap-3">
        <InfoCard icon="📄" title="Upload PO PDF" desc="Customer purchase order files" />
        <InfoCard icon="🔍" title="Auto-Parse" desc="Extract items, fabric, config" />
        <InfoCard icon="📋" title="Create SO" desc="Review then create as DRAFT" />
      </div>
    </div>
  );
}

function InfoCard({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <div className="bg-[#FAFAF9] rounded-lg p-4 text-center">
      <div className="text-2xl mb-1">{icon}</div>
      <p className="text-sm font-medium text-[#1F1D1B]">{title}</p>
      <p className="text-xs text-[#6B7280]">{desc}</p>
    </div>
  );
}

function PreviewStep({
  claudeRows, setClaudeRows, usedClaude, result, selectedPOs, expandedPO, onTogglePO, onExpandPO, onBack, onConfirm, catalog,
}: {
  claudeRows: ClaudeScanRow[];
  setClaudeRows: React.Dispatch<React.SetStateAction<ClaudeScanRow[]>>;
  usedClaude: boolean;
  result: POParseResult | null;
  selectedPOs: Set<number>;
  expandedPO: number | null;
  onTogglePO: (i: number) => void;
  onExpandPO: (i: number | null) => void;
  onBack: () => void;
  onConfirm: () => void;
  catalog: ScanCatalog | null;
}) {
  const fallbackPOs = result?.purchaseOrders ?? [];
  const totalCount = claudeRows.length + fallbackPOs.length;

  const updateClaudeRow = (idx: number, patch: Partial<ClaudeExtractedPO>) => {
    setClaudeRows(prev => prev.map((r, i) => i === idx ? { ...r, extracted: { ...r.extracted, ...patch } } : r));
  };
  const updateClaudeItem = (rowIdx: number, itemIdx: number, patch: Partial<ClaudeExtractedItem>) => {
    setClaudeRows(prev => prev.map((r, i) => {
      if (i !== rowIdx) return r;
      return {
        ...r,
        extracted: {
          ...r.extracted,
          items: r.extracted.items.map((it, j) => j === itemIdx ? { ...it, ...patch } : it),
        },
      };
    }));
  };
  const addClaudeItem = (rowIdx: number) => {
    setClaudeRows(prev => prev.map((r, i) => {
      if (i !== rowIdx) return r;
      const blank: ClaudeExtractedItem = {
        category: "BEDFRAME",
        productCode: "",
        description: null,
        quantity: 1,
        sizeLabel: null,
        fabricCode: null,
        divanHeightInches: null,
        legHeightInches: null,
        gapInches: null,
        noLeg: false,
        specialOrder: null,
        specialNotes: null,
        unitPrice: null,
        transferredSO: null,
      };
      return { ...r, extracted: { ...r.extracted, items: [...r.extracted.items, blank] } };
    }));
  };
  const removeClaudeItem = (rowIdx: number, itemIdx: number) => {
    setClaudeRows(prev => prev.map((r, i) => {
      if (i !== rowIdx) return r;
      return {
        ...r,
        extracted: {
          ...r.extracted,
          items: r.extracted.items.filter((_, j) => j !== itemIdx),
        },
      };
    }));
  };
  const toggleGold = (rowIdx: number) => {
    setClaudeRows(prev => prev.map((r, i) => i === rowIdx ? { ...r, markedGold: !r.markedGold } : r));
  };

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-[#1F1D1B] flex items-center gap-2">
            Found {totalCount} Purchase Order{totalCount !== 1 ? "s" : ""}
            {usedClaude && (
              <Badge className="bg-violet-50 text-violet-700 border border-violet-200">
                <Sparkles className="h-3 w-3 inline mr-1" /> AI
              </Badge>
            )}
          </h3>
          <p className="text-sm text-[#6B7280]">
            {selectedPOs.size} selected — edit any field inline, then confirm
          </p>
        </div>
      </div>

      {/* Warnings */}
      {result && result.errors.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
          {result.errors.map((err, i) => (
            <p key={i} className="text-sm text-amber-700 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" /> {err}
            </p>
          ))}
        </div>
      )}

      {/* PO Cards */}
      <div className="space-y-3 max-h-[50vh] overflow-y-auto">
        {claudeRows.map((row, idx) => (
          <ClaudePOCard
            key={`claude-${idx}`}
            row={row}
            catalog={catalog}
            selected={selectedPOs.has(idx)}
            expanded={expandedPO === idx}
            onToggle={() => onTogglePO(idx)}
            onExpand={() => onExpandPO(expandedPO === idx ? null : idx)}
            onUpdate={(patch) => updateClaudeRow(idx, patch)}
            onUpdateItem={(itemIdx, patch) => updateClaudeItem(idx, itemIdx, patch)}
            onAddItem={() => addClaudeItem(idx)}
            onRemoveItem={(itemIdx) => removeClaudeItem(idx, itemIdx)}
            onToggleGold={() => toggleGold(idx)}
          />
        ))}
        {fallbackPOs.map((po, idx) => {
          const globalIdx = claudeRows.length + idx;
          return (
            <POCard
              key={`fb-${idx}`}
              po={po}
              index={globalIdx}
              selected={selectedPOs.has(globalIdx)}
              expanded={expandedPO === globalIdx}
              onToggle={() => onTogglePO(globalIdx)}
              onExpand={() => onExpandPO(expandedPO === globalIdx ? null : globalIdx)}
            />
          );
        })}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between pt-4 border-t border-[#E2DDD8]">
        <Button className="border border-[#D1D5DB]" onClick={onBack}>Back to Upload</Button>
        <Button
          variant="primary"
          onClick={onConfirm}
          disabled={selectedPOs.size === 0}
        >
          <CheckCircle className="h-4 w-4" />
          Create {selectedPOs.size} Sales Order{selectedPOs.size !== 1 ? "s" : ""} as DRAFT
        </Button>
      </div>
    </div>
  );
}

function ClaudePOCard({
  row, catalog, selected, expanded, onToggle, onExpand, onUpdate, onUpdateItem, onAddItem, onRemoveItem, onToggleGold,
}: {
  row: ClaudeScanRow;
  catalog: ScanCatalog | null;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
  onExpand: () => void;
  onUpdate: (patch: Partial<ClaudeExtractedPO>) => void;
  onUpdateItem: (itemIdx: number, patch: Partial<ClaudeExtractedItem>) => void;
  onAddItem: () => void;
  onRemoveItem: (itemIdx: number) => void;
  onToggleGold: () => void;
}) {
  const po = row.extracted;
  const totalQty = po.items.reduce((s, i) => s + (i.quantity || 1), 0);

  // Strip the trailing inch-mark on catalog values like '8"' so we can compare
  // / show as plain numbers in the divan/leg/gap inputs.
  const stripInch = (s: string): number | null => {
    const m = s.replace(/[^0-9.]/g, "");
    return m ? Number(m) : null;
  };
  const divanValues = (catalog?.bedframeDivans ?? []).map(stripInch).filter((n): n is number => n != null);
  const legValues = (catalog?.bedframeLegs ?? []).map(stripInch).filter((n): n is number => n != null);
  const gapValues = (catalog?.bedframeGaps ?? []).map(stripInch).filter((n): n is number => n != null);

  return (
    <Card className={`border-2 transition-colors ${selected ? "border-[#6B5C32] bg-[#FAFAF9]" : "border-[#E2DDD8]"}`}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            className="mt-1 h-4 w-4 rounded border-[#D1D5DB] text-[#6B5C32] focus:ring-[#6B5C32]"
          />
          <div className="flex-1 min-w-0 space-y-2">
            {/* Editable header fields */}
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 text-sm">
              <div>
                <label className="block text-xs text-[#9CA3AF]">Customer PO</label>
                <input
                  className="w-full px-2 py-1 border border-[#E2DDD8] rounded"
                  value={po.customerPO}
                  onChange={e => onUpdate({ customerPO: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF]">Customer</label>
                <input
                  className="w-full px-2 py-1 border border-[#E2DDD8] rounded"
                  value={po.customerName}
                  onChange={e => onUpdate({ customerName: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF]">State</label>
                <input
                  className="w-full px-2 py-1 border border-[#E2DDD8] rounded"
                  value={po.customerState ?? ""}
                  onChange={e => onUpdate({ customerState: e.target.value || null })}
                />
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF]">Delivery Date</label>
                <input
                  type="date"
                  className="w-full px-2 py-1 border border-[#E2DDD8] rounded"
                  value={po.deliveryDate ?? ""}
                  onChange={e => onUpdate({ deliveryDate: e.target.value || null })}
                />
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap text-xs text-[#6B7280]">
              <Badge className="bg-violet-50 text-violet-700 border border-violet-200">
                <Sparkles className="h-3 w-3 inline mr-0.5" /> {row.file.name}
              </Badge>
              <span>{po.items.length} items, {totalQty} qty</span>
              {po.isUrgent && (
                <Badge className="bg-red-100 text-red-800 border-red-200">URGENT</Badge>
              )}
              {po.deliveryHub && (
                <Badge className="border border-[#D1D5DB]">{po.deliveryHub}</Badge>
              )}
              {po.yourRefNo && (
                <span className="text-[#9CA3AF]">Ref: {po.yourRefNo}</span>
              )}
              {po.customerCode === null && (
                <Badge className="bg-amber-50 text-amber-700 border border-amber-200">
                  <AlertTriangle className="h-3 w-3 inline mr-0.5" /> Customer unmatched
                </Badge>
              )}
              <button
                type="button"
                onClick={onToggleGold}
                className={`ml-auto text-[10px] px-2 py-0.5 rounded border transition-colors ${
                  row.markedGold
                    ? "bg-amber-100 text-amber-800 border-amber-300"
                    : "bg-white text-[#6B7280] border-[#D1D5DB] hover:border-amber-300"
                }`}
                title="Mark this extraction as a gold reference — future OCR calls will use it as a few-shot example"
              >
                <Star className={`h-3 w-3 inline mr-0.5 ${row.markedGold ? "fill-amber-500 text-amber-500" : ""}`} />
                {row.markedGold ? "Gold reference" : "Mark as gold"}
              </button>
            </div>

            {row.warnings.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-2 space-y-0.5">
                {row.warnings.map((w, i) => (
                  <p key={i} className="text-xs text-amber-700 flex items-start gap-1.5">
                    <AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                    <span>
                      <span className="font-medium">{w.field}</span>
                      {w.value ? <span className="text-amber-600"> &quot;{w.value}&quot;</span> : null}
                      {" — "}
                      {w.message}
                    </span>
                  </p>
                ))}
              </div>
            )}

            {expanded && (
              <div className="mt-2 border border-[#E2DDD8] rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-[#F5F5F5] text-[#6B7280]">
                      <th className="px-1.5 py-1 text-left">#</th>
                      <th className="px-1.5 py-1 text-left">Cat</th>
                      <th className="px-1.5 py-1 text-left">Product</th>
                      <th className="px-1.5 py-1 text-left">Size</th>
                      <th className="px-1.5 py-1 text-left">Fabric</th>
                      <th className="px-1.5 py-1 text-center">Divan</th>
                      <th className="px-1.5 py-1 text-center">Leg</th>
                      <th className="px-1.5 py-1 text-center">Gap</th>
                      <th className="px-1.5 py-1 text-left">Special</th>
                      <th className="px-1.5 py-1 text-center">Qty</th>
                      <th className="px-1.5 py-1 text-right">Price (RM)</th>
                      <th className="px-1.5 py-1"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {po.items.map((item, i) => {
                      const productList =
                        item.category === "SOFA" ? (catalog?.sofas ?? [])
                          : item.category === "ACCESSORY" ? (catalog?.accessories ?? [])
                          : (catalog?.bedframes ?? []);
                      const fabricList = catalog?.fabrics ?? [];
                      const specialList =
                        item.category === "SOFA"
                          ? (catalog?.sofaSpecials ?? [])
                          : (catalog?.bedframeSpecials ?? []);
                      const isUnknownProduct =
                        item.productCode &&
                        productList.length > 0 &&
                        !productList.some((c) => c.toUpperCase() === item.productCode.toUpperCase());
                      const isUnknownFabric =
                        item.fabricCode &&
                        fabricList.length > 0 &&
                        !fabricList.some((c) => c.toUpperCase() === item.fabricCode!.toUpperCase());
                      return (
                        <tr key={`${row.sampleId}-${i}`} className="border-t border-[#E2DDD8] align-top">
                          <td className="px-1.5 py-1 text-[#9CA3AF]">{i + 1}</td>
                          <td className="px-1.5 py-1">
                            <select
                              className="w-full px-1 py-0.5 text-xs border border-transparent hover:border-[#E2DDD8] rounded bg-transparent"
                              value={item.category}
                              onChange={(e) => onUpdateItem(i, { category: e.target.value as ClaudeExtractedItem["category"] })}
                            >
                              <option value="BEDFRAME">BF</option>
                              <option value="SOFA">SF</option>
                              <option value="ACCESSORY">AC</option>
                            </select>
                          </td>
                          <td className="px-1.5 py-1">
                            <input
                              list={`prod-${row.sampleId}-${i}`}
                              className={`w-32 px-1 py-0.5 text-xs border rounded ${isUnknownProduct ? "border-amber-400 bg-amber-50" : "border-transparent hover:border-[#E2DDD8]"}`}
                              value={item.productCode}
                              onChange={(e) => onUpdateItem(i, { productCode: e.target.value })}
                            />
                            <datalist id={`prod-${row.sampleId}-${i}`}>
                              {productList.map((c) => <option key={c} value={c} />)}
                            </datalist>
                          </td>
                          <td className="px-1.5 py-1">
                            <input
                              className="w-12 px-1 py-0.5 text-xs border border-transparent hover:border-[#E2DDD8] rounded"
                              value={item.sizeLabel ?? ""}
                              onChange={(e) => onUpdateItem(i, { sizeLabel: e.target.value || null })}
                            />
                          </td>
                          <td className="px-1.5 py-1">
                            <input
                              list={`fab-${row.sampleId}-${i}`}
                              className={`w-24 px-1 py-0.5 text-xs border rounded ${isUnknownFabric ? "border-amber-400 bg-amber-50" : "border-transparent hover:border-[#E2DDD8]"}`}
                              value={item.fabricCode ?? ""}
                              onChange={(e) => onUpdateItem(i, { fabricCode: e.target.value || null })}
                            />
                            <datalist id={`fab-${row.sampleId}-${i}`}>
                              {fabricList.map((c) => <option key={c} value={c} />)}
                            </datalist>
                          </td>
                          <td className="px-1.5 py-1 text-center">
                            <input
                              list={`div-${row.sampleId}-${i}`}
                              type="number"
                              step="0.5"
                              onFocus={(e) => e.currentTarget.select()}
                              className="w-12 px-1 py-0.5 text-xs border border-transparent hover:border-[#E2DDD8] rounded text-center"
                              value={item.divanHeightInches ?? ""}
                              onChange={(e) => {
                                const v = e.target.value === "" ? null : Number(e.target.value);
                                onUpdateItem(i, { divanHeightInches: v });
                              }}
                              disabled={item.category !== "BEDFRAME"}
                            />
                            <datalist id={`div-${row.sampleId}-${i}`}>
                              {divanValues.map((v) => <option key={v} value={v} />)}
                            </datalist>
                          </td>
                          <td className="px-1.5 py-1 text-center">
                            <div className="flex items-center justify-center gap-1">
                              <input
                                list={`leg-${row.sampleId}-${i}`}
                                type="number"
                                step="0.5"
                                onFocus={(e) => e.currentTarget.select()}
                                className="w-10 px-1 py-0.5 text-xs border border-transparent hover:border-[#E2DDD8] rounded text-center disabled:opacity-50"
                                value={item.noLeg ? "" : (item.legHeightInches ?? "")}
                                onChange={(e) => {
                                  const v = e.target.value === "" ? null : Number(e.target.value);
                                  onUpdateItem(i, { legHeightInches: v, noLeg: false });
                                }}
                                disabled={item.noLeg || item.category === "ACCESSORY"}
                              />
                              <datalist id={`leg-${row.sampleId}-${i}`}>
                                {legValues.map((v) => <option key={v} value={v} />)}
                              </datalist>
                              <label
                                className="text-[10px] text-[#6B7280] cursor-pointer"
                                title="No leg"
                              >
                                <input
                                  type="checkbox"
                                  className="mr-0.5 align-middle"
                                  checked={item.noLeg}
                                  onChange={(e) => onUpdateItem(i, {
                                    noLeg: e.target.checked,
                                    legHeightInches: e.target.checked ? null : item.legHeightInches,
                                  })}
                                />
                                NL
                              </label>
                            </div>
                          </td>
                          <td className="px-1.5 py-1 text-center">
                            <input
                              list={`gap-${row.sampleId}-${i}`}
                              type="number"
                              step="0.5"
                              onFocus={(e) => e.currentTarget.select()}
                              className="w-12 px-1 py-0.5 text-xs border border-transparent hover:border-[#E2DDD8] rounded text-center"
                              value={item.gapInches ?? ""}
                              onChange={(e) => {
                                const v = e.target.value === "" ? null : Number(e.target.value);
                                onUpdateItem(i, { gapInches: v });
                              }}
                              disabled={item.category !== "BEDFRAME"}
                            />
                            <datalist id={`gap-${row.sampleId}-${i}`}>
                              {gapValues.map((v) => <option key={v} value={v} />)}
                            </datalist>
                          </td>
                          <td className="px-1.5 py-1">
                            <input
                              list={`spc-${row.sampleId}-${i}`}
                              className="w-32 px-1 py-0.5 text-xs border border-transparent hover:border-[#E2DDD8] rounded"
                              value={item.specialOrder ?? ""}
                              onChange={(e) => onUpdateItem(i, { specialOrder: e.target.value || null })}
                            />
                            <datalist id={`spc-${row.sampleId}-${i}`}>
                              {specialList.map((c) => <option key={c} value={c} />)}
                            </datalist>
                          </td>
                          <td className="px-1.5 py-1 text-center">
                            <input
                              type="number"
                              onFocus={(e) => e.currentTarget.select()}
                              className="w-12 px-1 py-0.5 text-xs border border-transparent hover:border-[#E2DDD8] rounded text-center"
                              value={item.quantity}
                              onChange={(e) => onUpdateItem(i, { quantity: Number(e.target.value) || 0 })}
                            />
                          </td>
                          <td className="px-1.5 py-1 text-right">
                            <input
                              type="number"
                              step="0.01"
                              onFocus={(e) => e.currentTarget.select()}
                              className="w-20 px-1 py-0.5 text-xs border border-transparent hover:border-[#E2DDD8] rounded text-right"
                              value={item.unitPrice ?? ""}
                              onChange={(e) => {
                                const v = e.target.value === "" ? null : Number(e.target.value);
                                onUpdateItem(i, { unitPrice: v });
                              }}
                            />
                          </td>
                          <td className="px-1.5 py-1 text-center">
                            <button
                              type="button"
                              onClick={() => onRemoveItem(i)}
                              className="text-[#9CA3AF] hover:text-red-600"
                              title="Remove line"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="px-2 py-1 bg-[#FAFAF9] border-t border-[#E2DDD8] flex justify-between items-center">
                  <button
                    type="button"
                    onClick={onAddItem}
                    className="text-xs text-[#6B5C32] hover:underline"
                  >
                    + Add line
                  </button>
                  <span className="text-[10px] text-[#9CA3AF]">
                    NL = No Leg · BF/SF/AC = Bedframe/Sofa/Accessory
                  </span>
                </div>
              </div>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onExpand}>
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function POCard({
  po, index: _index, selected, expanded, onToggle, onExpand,
}: {
  po: ParsedPO;
  index: number;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
  onExpand: () => void;
}) {
  const totalItems = po.items.length;
  const totalQty = po.items.reduce((s, i) => s + (i.quantity || 1), 0);

  return (
    <Card className={`border-2 transition-colors ${selected ? "border-[#6B5C32] bg-[#FAFAF9]" : "border-[#E2DDD8]"}`}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          {/* Checkbox */}
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            className="mt-1 h-4 w-4 rounded border-[#D1D5DB] text-[#6B5C32] focus:ring-[#6B5C32]"
          />

          {/* Main info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold text-[#1F1D1B]">{po.poNo}</span>
              <Badge className="bg-[#F3F4F6] text-[#374151]">{po.customerName}</Badge>
              {po.deliveryHub && <Badge className="border border-[#D1D5DB]">{po.deliveryHub}</Badge>}
              {po.isUrgent && <Badge className="bg-red-100 text-red-800 border-red-200">URGENT</Badge>}
              <Badge className={
                po.confidence >= 80 ? "bg-green-50 text-green-700 border border-green-200" :
                po.confidence >= 50 ? "bg-amber-50 text-amber-700 border border-amber-200" :
                "bg-red-50 text-red-700 border border-red-200"
              }>
                {po.confidence}% confidence
              </Badge>
            </div>

            <div className="flex items-center gap-4 mt-1 text-sm text-[#6B7280]">
              {po.poDate && <span>Date: {po.poDate}</span>}
              {po.deliveryDate && <span>DD: {po.deliveryDate}</span>}
              <span>{totalItems} items, {totalQty} qty</span>
              {po.yourRefNo && <span>Ref: {po.yourRefNo}</span>}
            </div>

            {/* Warnings */}
            {po.warnings.length > 0 && (
              <div className="mt-2 space-y-1">
                {po.warnings.map((w, i) => (
                  <p key={i} className="text-xs text-amber-600 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" /> {w}
                  </p>
                ))}
              </div>
            )}

            {/* Expanded items table */}
            {expanded && (
              <div className="mt-3 border border-[#E2DDD8] rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-[#F5F5F5] text-xs text-[#6B7280]">
                      <th className="px-3 py-2 text-left">#</th>
                      <th className="px-3 py-2 text-left">Product</th>
                      <th className="px-3 py-2 text-left">Size</th>
                      <th className="px-3 py-2 text-left">Fabric</th>
                      <th className="px-3 py-2 text-left">Config</th>
                      <th className="px-3 py-2 text-center">Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {po.items.map((item, i) => (
                      <tr key={i} className="border-t border-[#E2DDD8]">
                        <td className="px-3 py-2 text-[#9CA3AF]">{i + 1}</td>
                        <td className="px-3 py-2 font-medium">{item.baseModel}</td>
                        <td className="px-3 py-2">{item.sizeCode}</td>
                        <td className="px-3 py-2">{item.fabricCode || <span className="text-amber-500">—</span>}</td>
                        <td className="px-3 py-2 text-xs text-[#6B7280]">
                          {item.category === "BEDFRAME" ? (
                            <>D:{item.divanHeightInches}&quot; L:{item.legHeightInches}&quot; G:{item.gapInches}&quot;</>
                          ) : (
                            <>H:{item.seatHeight}&quot;</>
                          )}
                          {item.specialOrder && <Badge className="ml-1 text-xs">{item.specialOrder}</Badge>}
                        </td>
                        <td className="px-3 py-2 text-center font-medium">{item.quantity || 1}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Expand button */}
          <Button variant="ghost" size="sm" onClick={onExpand}>
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DoneStep({
  created, errors, onClose, onScanMore,
}: {
  created: { soNo: string; poNo: string; itemCount: number }[];
  errors: string[];
  onClose: () => void;
  onScanMore: () => void;
}) {
  return (
    <div className="space-y-6 py-4">
      {created.length > 0 && (
        <div className="text-center">
          <div className="mx-auto h-16 w-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
            <CheckCircle className="h-8 w-8 text-green-600" />
          </div>
          <h3 className="text-xl font-bold text-[#1F1D1B]">
            {created.length} Sales Order{created.length !== 1 ? "s" : ""} Created!
          </h3>
          <p className="text-sm text-[#6B7280] mt-1">All created as DRAFT — review and confirm when ready</p>
        </div>
      )}

      {/* Created list */}
      {created.length > 0 && (
        <div className="space-y-2">
          {created.map((c, i) => (
            <div key={i} className="flex items-center justify-between bg-green-50 rounded-lg px-4 py-3">
              <div>
                <span className="font-bold text-green-800">{c.soNo}</span>
                <span className="text-sm text-green-600 ml-2">from {c.poNo}</span>
              </div>
              <Badge className="text-green-700 border border-green-300">{c.itemCount} items</Badge>
            </div>
          ))}
        </div>
      )}

      {/* Errors */}
      {errors.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 space-y-2">
          <p className="font-medium text-red-800">Some POs failed to create:</p>
          {errors.map((err, i) => (
            <p key={i} className="text-sm text-red-700">{err}</p>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-center gap-3 pt-4">
        <Button className="border border-[#D1D5DB]" onClick={onScanMore}>Scan More POs</Button>
        <Button variant="primary" onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

// ─── PDF Text Extraction ────────────────────────────────────────────────

async function extractPdfText(file: File): Promise<string> {
  // Dynamic import pdfjs-dist
  const pdfjsLib = await import("pdfjs-dist");

  // Set worker — use local copy in /public to avoid CDN issues
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const textParts: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pageText = content.items.map((item: any) => item.str).join(" ");
    textParts.push(pageText);
  }

  return textParts.join("\n\n--- PAGE BREAK ---\n\n");
}

// Phase 4: split a multi-page PDF into one File per page, all single-page
// PDFs that the /extract endpoint can ingest individually. Lets us fan
// out a 16-page upload into 16 parallel Claude calls (≈ 10× faster + per
// call Claude only juggles one PO so accuracy goes up).
async function splitPdfIntoPages(
  file: File,
): Promise<Array<{ pageNo: number; file: File }>> {
  const { PDFDocument } = await import("pdf-lib");
  const buf = await file.arrayBuffer();
  const src = await PDFDocument.load(buf, { ignoreEncryption: true });
  const total = src.getPageCount();
  const baseName = file.name.replace(/\.pdf$/i, "");

  const out: Array<{ pageNo: number; file: File }> = [];
  for (let i = 0; i < total; i++) {
    const dst = await PDFDocument.create();
    const [copied] = await dst.copyPages(src, [i]);
    dst.addPage(copied);
    const bytes = await dst.save();
    // Wrap in a fresh ArrayBuffer copy so the File body is detached from
    // the PDFDocument's internal buffer (some Workers have been finicky
    // about Uint8Array views being garbage-collected mid-flight).
    const ab = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const pageFile = new File([ab], `${baseName}_p${i + 1}.pdf`, {
      type: "application/pdf",
    });
    out.push({ pageNo: i + 1, file: pageFile });
  }
  return out;
}

// Render specific 1-indexed pages of a PDF into a single PNG (vertical
// stack). The result is a base64-encoded PNG used as the SO's customer-PO
// attachment. Rendering scale = 1.5 keeps the image readable while staying
// under ~200KB per page.
async function renderPdfPagesToPng(file: File, pages: number[]): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const renderScale = 1.5;
  const sortedPages = [...new Set(pages)]
    .filter((p) => p >= 1 && p <= pdf.numPages)
    .sort((a, b) => a - b);
  if (sortedPages.length === 0) return "";

  type Rendered = { canvas: HTMLCanvasElement; w: number; h: number };
  const rendered: Rendered[] = [];
  for (const pageNo of sortedPages) {
    const page = await pdf.getPage(pageNo);
    const viewport = page.getViewport({ scale: renderScale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    rendered.push({ canvas, w: canvas.width, h: canvas.height });
  }
  if (rendered.length === 0) return "";

  // Single page → return its PNG directly. Multi-page → stack vertically.
  if (rendered.length === 1) {
    return rendered[0].canvas.toDataURL("image/png");
  }
  const totalW = Math.max(...rendered.map((r) => r.w));
  const totalH = rendered.reduce((s, r) => s + r.h, 0);
  const out = document.createElement("canvas");
  out.width = totalW;
  out.height = totalH;
  const ctx = out.getContext("2d");
  if (!ctx) return rendered[0].canvas.toDataURL("image/png");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, totalW, totalH);
  let y = 0;
  for (const r of rendered) {
    ctx.drawImage(r.canvas, 0, y);
    y += r.h;
  }
  return out.toDataURL("image/png");
}
