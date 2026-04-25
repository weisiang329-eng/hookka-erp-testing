"use client";

import { useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { parsePOText, mapDeliveryHub, type ParsedPO, type POParseResult } from "@/lib/po-parser";
import { Upload, FileText, CheckCircle, AlertTriangle, X, ChevronDown, ChevronRight, Loader2, Sparkles } from "lucide-react";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: (soIds: string[]) => void;
};

type StepState = "upload" | "preview" | "creating" | "done";

// Shape returned by POST /api/scan-po/extract.
type ClaudeExtractedItem = {
  productCode: string;
  description: string | null;
  quantity: number;
  sizeLabel: string | null;
  fabricCode: string | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  gapInches: number | null;
  specialOrder: string | null;
  unitPrice: number | null;
};

type ClaudeExtractedPO = {
  customerPO: string;
  customerName: string;
  customerState: string | null;
  deliveryDate: string | null;
  items: ClaudeExtractedItem[];
};

type ClaudeScanRow = {
  sampleId: string;
  extracted: ClaudeExtractedPO;
  file: File;
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
  const fileInputRef = useRef<HTMLInputElement>(null);

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

    // --- Pass 1: try Claude OCR (per-file) -----------------------------
    const claudeSuccesses: ClaudeScanRow[] = [];
    const claudeFailures: File[] = [];
    const claudeWarnings: string[] = [];

    for (const file of pdfFiles) {
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/scan-po/extract", { method: "POST", body: fd });
        const data = await res.json() as {
          success?: boolean;
          error?: string;
          data?: { sampleId: string; extracted: ClaudeExtractedPO };
        };
        if (res.ok && data.success && data.data?.extracted) {
          claudeSuccesses.push({
            sampleId: data.data.sampleId,
            extracted: data.data.extracted,
            file,
          });
        } else {
          claudeFailures.push(file);
          claudeWarnings.push(`${file.name}: ${data.error || `HTTP ${res.status}`}`);
        }
      } catch (err) {
        claudeFailures.push(file);
        claudeWarnings.push(`${file.name}: ${err instanceof Error ? err.message : "Network error"}`);
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
        // Feedback loop: save the (edited) JSON back so future extractions
        // can use it as a few-shot example. Fire-and-forget — a failure
        // here shouldn't block SO creation.
        fetch(`/api/scan-po/samples/${row.sampleId}/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ correctedJson: po }),
        }).catch(() => {});

        const hub = mapDeliveryHub(po.customerName, po.customerState ?? "");

        const soItems = po.items.map((item, idx) => ({
          lineNo: idx + 1,
          lineSuffix: `-${String(idx + 1).padStart(2, "0")}`,
          productCode: item.productCode,
          productName: item.description ?? item.productCode,
          sizeLabel: item.sizeLabel ?? "",
          fabricCode: item.fabricCode ?? "",
          quantity: item.quantity || 1,
          gapInches: item.gapInches ?? 0,
          divanHeightInches: item.divanHeightInches ?? 0,
          legHeightInches: item.legHeightInches ?? 0,
          specialOrder: item.specialOrder ?? "",
          notes: "",
        }));

        const body = {
          customerId: "",
          customerName: po.customerName,
          customerState: po.customerState ?? hub.state ?? "",
          customerPOId: po.customerPO,
          deliveryHubId: hub.hubId,
          companySODate: new Date().toISOString().split("T")[0],
          hookkaExpectedDD: po.deliveryDate,
          items: soItems,
          source: "PO_SCAN_CLAUDE",
        };

        const res = await fetch("/api/sales-orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
          headers: { "Content-Type": "application/json" },
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
  claudeRows, setClaudeRows, usedClaude, result, selectedPOs, expandedPO, onTogglePO, onExpandPO, onBack, onConfirm,
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
            selected={selectedPOs.has(idx)}
            expanded={expandedPO === idx}
            onToggle={() => onTogglePO(idx)}
            onExpand={() => onExpandPO(expandedPO === idx ? null : idx)}
            onUpdate={(patch) => updateClaudeRow(idx, patch)}
            onUpdateItem={(itemIdx, patch) => updateClaudeItem(idx, itemIdx, patch)}
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
  row, selected, expanded, onToggle, onExpand, onUpdate, onUpdateItem,
}: {
  row: ClaudeScanRow;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
  onExpand: () => void;
  onUpdate: (patch: Partial<ClaudeExtractedPO>) => void;
  onUpdateItem: (itemIdx: number, patch: Partial<ClaudeExtractedItem>) => void;
}) {
  const po = row.extracted;
  const totalQty = po.items.reduce((s, i) => s + (i.quantity || 1), 0);

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
            </div>

            {expanded && (
              <div className="mt-2 border border-[#E2DDD8] rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-[#F5F5F5] text-xs text-[#6B7280]">
                      <th className="px-2 py-1 text-left">#</th>
                      <th className="px-2 py-1 text-left">Product</th>
                      <th className="px-2 py-1 text-left">Size</th>
                      <th className="px-2 py-1 text-left">Fabric</th>
                      <th className="px-2 py-1 text-center">Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {po.items.map((item, i) => (
                      <tr key={i} className="border-t border-[#E2DDD8]">
                        <td className="px-2 py-1 text-[#9CA3AF]">{i + 1}</td>
                        <td className="px-2 py-1">
                          <input
                            className="w-full px-1 py-0.5 text-xs border border-transparent hover:border-[#E2DDD8] rounded"
                            value={item.productCode}
                            onChange={e => onUpdateItem(i, { productCode: e.target.value })}
                          />
                        </td>
                        <td className="px-2 py-1">
                          <input
                            className="w-full px-1 py-0.5 text-xs border border-transparent hover:border-[#E2DDD8] rounded"
                            value={item.sizeLabel ?? ""}
                            onChange={e => onUpdateItem(i, { sizeLabel: e.target.value || null })}
                          />
                        </td>
                        <td className="px-2 py-1">
                          <input
                            className="w-full px-1 py-0.5 text-xs border border-transparent hover:border-[#E2DDD8] rounded"
                            value={item.fabricCode ?? ""}
                            onChange={e => onUpdateItem(i, { fabricCode: e.target.value || null })}
                          />
                        </td>
                        <td className="px-2 py-1 text-center">
                          <input
                            type="number"
                            className="w-16 px-1 py-0.5 text-xs border border-transparent hover:border-[#E2DDD8] rounded text-center"
                            value={item.quantity}
                            onChange={e => onUpdateItem(i, { quantity: Number(e.target.value) || 0 })}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
