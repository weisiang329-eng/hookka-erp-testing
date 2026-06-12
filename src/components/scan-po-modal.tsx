"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useId } from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { parsePOText, mapDeliveryHub, type ParsedPO, type POParseResult } from "@/lib/po-parser";
import { Upload, FileText, CheckCircle, AlertTriangle, X, ChevronDown, ChevronRight, Loader2, Sparkles, Star, Plus } from "lucide-react";

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
  rawSpec: string | null;
  // 0-indexed left-to-right position in the SOFA diagram. Server uses this
  // + ExtractedPO.tvPosition to deterministically apply LHF/RHF. Internal
  // diagnostic — no UI; operator overrides via the productCode dropdown.
  diagramOrder: number | null;
  // Free-text per-line specials with their own surcharge — operator-added
  // in the preview when a custom spec ("Custom Foam Density 35D") doesn't
  // match the master Specials catalog. AI never populates this — defaults
  // to []. Mirrors src/pages/sales/create.tsx customSpecials.
  customSpecials: { description: string; surchargeSen: number }[];
};

type ClaudeExtractedPO = {
  customerPO: string;
  customerName: string;
  customerCode: string | null;
  customerId: string | null;
  customerState: string | null;
  deliveryHub: string | null;
  deliveryHubId: string | null;
  yourRefNo: string | null;
  customerSO: string | null;
  deliveryDate: string | null;
  isUrgent: boolean;
  pageNumbers: number[];
  // Where Claude saw the TV / front-facing marker in the sofa diagram. Server
  // uses this + each sofa item's diagramOrder to deterministically apply
  // LHF/RHF. Internal diagnostic — no UI; operator overrides via the
  // productCode dropdown if the auto-flip is wrong.
  tvPosition: "top" | "bottom" | "left" | "right" | "none";
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
  customers: {
    id: string;
    code: string;
    name: string;
    hubs: { id: string; shortName: string; state: string | null }[];
  }[];
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

// An uploaded PDF paired with a stable unique id. Two files can share a
// name (e.g. both "PO.pdf" dragged from different folders), which used to
// collide in the name-keyed progress / page-accounting maps — one file's
// status would overwrite the other's. Keying every per-file map by `id`
// instead of `file.name` keeps them independent. Display still uses
// `file.name`.
type UploadedFile = { id: string; file: File };

let uploadSeq = 0;
function makeUploadId(): string {
  uploadSeq += 1;
  return `upload-${Date.now().toString(36)}-${uploadSeq}`;
}

export function ScanPOModal({ open, onClose, onCreated }: Props) {
  const [step, setStep] = useState<StepState>("upload");
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [parsing, setParsing] = useState(false);
  // Per-file OCR status, keyed by the file's stable upload id (NOT name —
  // two uploads can share a name). Lets the operator see each PDF advance
  // through queued → scanning → done/failed during a batch instead of one
  // generic "Parsing..." spinner. Display-only — does not affect the
  // upload/queue/OCR logic.
  const [fileProgress, setFileProgress] = useState<Record<string, "queued" | "scanning" | "done" | "failed">>({});
  // Page-level progress so a multi-page PDF shows movement ("3 / 8 pages")
  // instead of sitting at "0 of 1 file" — the per-FILE bar only flips once
  // every page of that file finishes, which reads as stuck (owner 2026-06-12).
  const [pageProgress, setPageProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
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
    setFileProgress({});
    setPageProgress({ done: 0, total: 0 });
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

  // True while a scan/parse is running or SOs are being created — in-flight
  // work that an accidental click would silently throw away.
  const isBusy = parsing || step === "creating";

  // Close requested via an EXPLICIT control (header ✕ / a Cancel button).
  // When busy, confirm first so the operator can't lose a scan/parse in
  // progress with one stray click; otherwise close immediately.
  const requestClose = () => {
    if (
      isBusy &&
      !window.confirm(
        "A scan is still in progress. Close and discard the work in progress?",
      )
    ) {
      return;
    }
    handleClose();
  };

  // Click on the dimmed overlay margin is INERT — never closes the modal,
  // busy or idle. A stray margin click used to wipe the entire scan/preview
  // (the operator would lose every extracted+edited PO to one misclick).
  // Owner 2026-06-12: "应该要打叉才可以关掉" — the modal closes ONLY via the
  // explicit header ✕ (requestClose, which confirms while a scan is running).
  const handleOverlayClick = () => {
    /* intentional no-op — closing is ✕-only, see comment above */
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

    // Tag each upload with a stable unique id so same-named files don't
    // collide in the progress / page-accounting maps below.
    const uploaded: UploadedFile[] = pdfFiles.map((f) => ({ id: makeUploadId(), file: f }));
    setFiles(uploaded);
    setParsing(true);
    setErrors([]);
    // Seed every file as "queued" so the UploadStep list renders a row per
    // PDF the moment processing starts. Status keyed by stable upload id.
    setFileProgress(Object.fromEntries(uploaded.map((u) => [u.id, "queued" as const])));

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
    const claudeFailures: UploadedFile[] = [];
    const claudeWarnings: string[] = [];

    type PageJob = { uf: UploadedFile; pageNo: number; pageFile: File };
    const allJobs: PageJob[] = [];
    for (const uf of uploaded) {
      try {
        const pages = await splitPdfIntoPages(uf.file);
        for (const p of pages) allJobs.push({ uf, pageNo: p.pageNo, pageFile: p.file });
      } catch (err) {
        claudeFailures.push(uf);
        claudeWarnings.push(
          `${uf.file.name}: failed to split PDF — ${err instanceof Error ? err.message : "unknown"}`,
        );
        setFileProgress((prev) => ({ ...prev, [uf.id]: "failed" }));
      }
    }
    // Every successfully-split page is one unit of scan progress. Total is
    // fixed here; `done` ticks up as each batch settles (below) so the
    // operator watches "N / total pages" climb instead of a frozen file bar.
    setPageProgress({ done: 0, total: allJobs.length });

    // Concurrency limiter — Anthropic tier-1 caps at 30K input tokens / min
    // (~2 of our catalog-injected requests in flight at once). Going wider
    // hits 429s on every page after the first. Sequential pairs keep us
    // under the limit while still ~5× faster than fully serial. Once the
    // operator's Anthropic tier is raised this can be bumped.
    type JobRes =
      | { kind: "ok"; job: PageJob; samples: Array<{ sampleId: string; extracted: ClaudeExtractedPO; warnings: ClaudeWarning[] }> }
      | { kind: "fail"; job: PageJob; error: string };

    const runOne = async (job: PageJob): Promise<JobRes> => {
      const fd = new FormData();
      fd.append("file", job.pageFile);
      // Retry policy: Anthropic flakes for several reasons that all warrant
      // backing off and trying again rather than dropping the page on the
      // floor:
      //   429  rate limit (Retry-After header present)
      //   500  upstream internal error (transient, no header)
      //   502  bad-gateway from our worker wrapping the Anthropic body
      //   503  service unavailable
      //   504  gateway timeout
      //   529  Anthropic-specific "Overloaded" — common during peak hours
      // Up to 3 attempts with exponential-ish backoff (5s, 15s, 35s) — the
      // Anthropic Retry-After header overrides the default delay when given.
      const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
      const BASE_DELAYS = [5, 15, 35]; // seconds between attempts
      const MAX_ATTEMPTS = 3;
      let lastError = "";
      // A wedged extract (backend or Anthropic never responds) used to freeze
      // the whole scan at "0 of N done" forever — fetch has no built-in
      // timeout, so one hung page froze the batch and the file stuck on
      // "scanning". Abort each attempt past 90s (a slow OCR page legitimately
      // takes ~30-60s) so a hung request becomes a retryable failure instead
      // of an eternal hang (owner 2026-06-12: "卡住了").
      const PER_ATTEMPT_TIMEOUT_MS = 90_000;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        let res: Response;
        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);
        try {
          res = await fetch("/api/scan-po/extract", {
            method: "POST",
            body: fd,
            signal: controller.signal,
          });
        } catch (err) {
          clearTimeout(abortTimer);
          // Timed-out (aborted) or a transient network drop — back off and
          // retry like a 5xx rather than hanging the scan on one wedged page.
          lastError = controller.signal.aborted
            ? `extract timed out after ${PER_ATTEMPT_TIMEOUT_MS / 1000}s`
            : err instanceof Error
              ? err.message
              : "network error";
          if (attempt < MAX_ATTEMPTS - 1) {
            await new Promise((r) => setTimeout(r, BASE_DELAYS[attempt] * 1000));
            continue;
          }
          return { kind: "fail", job, error: lastError };
        }
        clearTimeout(abortTimer);
        const data = await res
          .json()
          .catch(() => ({ success: false, error: `HTTP ${res.status} (non-JSON body)` }))
          .then(
            (j) =>
              j as {
                success?: boolean;
                error?: string;
                data?: {
                  samples?: Array<{
                    sampleId: string;
                    extracted: ClaudeExtractedPO;
                    warnings: ClaudeWarning[];
                  }>;
                };
              },
          );
        if (res.ok && data.success && Array.isArray(data.data?.samples)) {
          return { kind: "ok", job, samples: data.data.samples };
        }
        lastError = data.error || `HTTP ${res.status}`;
        // Detect upstream retryable failures by HTTP status OR by sniffing
        // the error string the backend forwarded (`"Anthropic 500: ..."`,
        // `"Anthropic: overloaded_error: Overloaded"`).
        const statusRetryable = RETRYABLE_STATUS.has(res.status);
        const messageRetryable =
          /Anthropic\s+(?:429|500|502|503|504|529)\b/i.test(lastError) ||
          /overloaded_error|overloaded|rate_limit/i.test(lastError);
        const shouldRetry = (statusRetryable || messageRetryable) && attempt < MAX_ATTEMPTS - 1;
        if (!shouldRetry) {
          return { kind: "fail", job, error: lastError };
        }
        const headerWait = Number(res.headers.get("retry-after") || "0");
        const waitSec = headerWait > 0 ? Math.min(60, headerWait) : BASE_DELAYS[attempt];
        await new Promise((r) => setTimeout(r, waitSec * 1000));
      }
      return { kind: "fail", job, error: lastError || "retry exhausted" };
    };

    // Concurrency picked to fit the operator's Anthropic tier rate limit
    // (each request consumes ~14K input tokens including the cached
    // catalog block, which still counts toward the per-minute cap):
    //   Tier 1 (30K/min)  → 2
    //   Tier 2 (80K/min)  → 5  ← current
    //   Tier 3 (200K/min) → 12
    //   Tier 4+ (400K+)   → 20+
    // Bump this constant after upgrading; long-term this should be a
    // server-served config so it tunes without a redeploy.
    const CONCURRENCY = 5;
    const claudeResults: PromiseSettledResult<JobRes>[] = [];
    // Per-file page-job accounting so the progress list flips a file to
    // done/failed only once every one of its pages has settled. A file
    // is "failed" if any of its pages failed (mirrors claudeFailures).
    const remainingPages: Record<string, number> = {};
    const fileHadFailure: Record<string, boolean> = {};
    for (const job of allJobs) {
      remainingPages[job.uf.id] = (remainingPages[job.uf.id] ?? 0) + 1;
    }
    for (let i = 0; i < allJobs.length; i += CONCURRENCY) {
      const batch = allJobs.slice(i, i + CONCURRENCY);
      // Mark every file in this batch "scanning" as its first page starts.
      setFileProgress((prev) => {
        const next = { ...prev };
        for (const job of batch) {
          if (next[job.uf.id] === "queued") next[job.uf.id] = "scanning";
        }
        return next;
      });
      const settled = await Promise.allSettled(batch.map(runOne));
      claudeResults.push(...settled);
      // Tick page progress up by this batch so "N / total pages" climbs after
      // every CONCURRENCY-sized chunk settles — visible movement on a slow,
      // multi-page scan (owner 2026-06-12: stop it reading as "stuck").
      setPageProgress((p) => ({ ...p, done: Math.min(p.total, p.done + batch.length) }));
      // After the batch settles, decrement each file's outstanding page
      // count and flip it to done/failed once all its pages are accounted
      // for. A rejected promise counts as a failure for its file.
      const completedFiles: { id: string; failed: boolean }[] = [];
      for (let b = 0; b < batch.length; b++) {
        const job = batch[b];
        const s = settled[b];
        const pageFailed = s.status === "rejected" || s.value.kind === "fail";
        if (pageFailed) fileHadFailure[job.uf.id] = true;
        remainingPages[job.uf.id] -= 1;
        if (remainingPages[job.uf.id] === 0) {
          completedFiles.push({ id: job.uf.id, failed: !!fileHadFailure[job.uf.id] });
        }
      }
      if (completedFiles.length > 0) {
        setFileProgress((prev) => {
          const next = { ...prev };
          for (const cf of completedFiles) {
            next[cf.id] = cf.failed ? "failed" : "done";
          }
          return next;
        });
      }
    }

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
        // Skip samples with zero items — those come from continuation
        // pages where the PDF header repeats but the line-item table is
        // empty. Showing them as empty cards just clutters the modal.
        for (const s of v.samples) {
          if (!s.extracted.items || s.extracted.items.length === 0) continue;
          const extracted = {
            ...s.extracted,
            pageNumbers: [v.job.pageNo],
            // Backfill optional fields older API responses (or cached
            // few-shot replays) may omit. customSpecials is operator-only
            // — Claude never populates it — but the type requires it on
            // every item so the row UI can edit safely.
            items: s.extracted.items.map((it) => ({
              ...it,
              customSpecials: Array.isArray(it.customSpecials) ? it.customSpecials : [],
            })),
          };
          claudeSuccesses.push({
            sampleId: s.sampleId,
            extracted,
            // Deep clone for diff comparison. Cheap (PO is small).
            original: JSON.parse(JSON.stringify(extracted)) as ClaudeExtractedPO,
            warnings: s.warnings ?? [],
            file: v.job.uf.file,
            pageImageB64: null,
            markedGold: false,
          });
        }
      } else {
        if (!claudeFailures.some((cf) => cf.id === v.job.uf.id)) claudeFailures.push(v.job.uf);
        claudeWarnings.push(`${v.job.uf.file.name} page ${v.job.pageNo}: ${v.error}`);
      }
    }

    // --- Pass 2: template-match fallback for any file Claude failed on -
    let fallbackResult: POParseResult | null = null;
    if (claudeFailures.length > 0) {
      try {
        const allPOs: ParsedPO[] = [];
        const allErrors: string[] = [...claudeWarnings];

        for (const uf of claudeFailures) {
          const text = await extractPdfText(uf.file);
          const result = parsePOText(text);
          if (result.success) allPOs.push(...result.purchaseOrders);
          if (result.errors.length > 0) {
            allErrors.push(`${uf.file.name}: ${result.errors.join(", ")}`);
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
        //   1. po.deliveryHubId — server-resolved match against the
        //      customer's hubs (or operator's dropdown selection).
        //   2. Heuristic from customer name + state — legacy fallback.
        const hub = mapDeliveryHub(po.customerName, po.customerState ?? "");
        const resolvedHubId = po.deliveryHubId || hub.hubId;

        // OCR rule: only productCode + variant numerics + fabricCode +
        // specialOrder go into the SO body. EVERYTHING ELSE (productName,
        // sizeLabel, sizeCode) is left empty so the SO create endpoint
        // resolves them from the product master / catalog. The PDF text
        // is reference-only — never persisted as the canonical value.
        //
        // specialOrder: Claude may return free-form tokens that don't
        // match the catalog Specials list (e.g. "Nylon Fabric, Headrest
        // Firm" when only "Headrest Firm" is a real special). The chip
        // editor only adds catalog values, but if the operator never
        // opens the chip the raw Claude string would persist. Filter
        // here at save-time so non-catalog tokens are dropped silently.
        const soItems = po.items.map((item, idx) => {
          const specialList =
            item.category === "SOFA"
              ? (catalog?.sofaSpecials ?? [])
              : (catalog?.bedframeSpecials ?? []);
          const cleanedSpecialOrder = (item.specialOrder ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .filter((tok) =>
              specialList.length === 0
                ? true // no catalog loaded → don't drop, fall back to raw
                : specialList.some((c) => c.toLowerCase() === tok.toLowerCase()),
            )
            .join(", ");

          // For sofa: seat height lives on the LINE (variant), not in the
          // product master. SO create page sends BOTH sizeLabel + seatHeight
          // when a sofa seat is picked (see src/pages/sales/create.tsx
          // line 1087: setting seatHeight + sizeLabel to the same value).
          // Mirror that here so:
          //   - sales_order_items.sizeLabel stores the seat height (e.g. '28"')
          //     and renders correctly in the Draft items review modal +
          //     SO list Size column.
          //   - body.seatHeight feeds the price resolver in sales-orders.ts
          //     line 1690 (cpSeatHeightPrices / resolvedProduct.seatHeightPrices).
          // For BEDFRAME: leave sizeLabel/sizeCode empty so the backend
          // resolves them from the product master (e.g. "5FT" from
          // 1003-(K)).
          const sofaSeat =
            item.category === "SOFA" && item.sizeLabel
              ? item.sizeLabel.replace(/[^\d.]/g, "")
              : "";
          return {
            lineNo: idx + 1,
            lineSuffix: `-${String(idx + 1).padStart(2, "0")}`,
            productCode: item.productCode,
            productName: "", // backend → resolvedProduct.name
            itemCategory: item.category,
            // SOFA: send seat height so it lands in DB sizeLabel and renders
            // in every reader (list, detail, draft review). Backend
            // normalises "28" → '28"' (sales-orders.ts:1788).
            // BEDFRAME / ACCESSORY: empty → backend resolves from product
            // master.
            sizeLabel: item.category === "SOFA" ? sofaSeat : "",
            sizeCode: "", // backend → resolvedProduct.sizeCode
            fabricCode: item.fabricCode ?? "",
            // Seat height also goes on a separate field so the price
            // resolver can match against product.seatHeightPrices.
            seatHeight: sofaSeat,
            quantity: item.quantity || 1,
            gapInches: item.gapInches ?? 0,
            divanHeightInches: item.divanHeightInches ?? 0,
            legHeightInches: item.noLeg ? null : item.legHeightInches,
            specialOrder: cleanedSpecialOrder,
            // Operator-added free-text specials with their own surcharge.
            // Server appends each to specialOrder text as "OTHER: <desc>"
            // and stores the structured form in sales_order_items.custom_specials.
            customSpecials: (item.customSpecials ?? [])
              .filter((cs) => cs.description.trim().length > 0),
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
          };
        });

        // customerId comes from the backend's catalog match (validateAndEnrichPO).
        // If null, the SO create call will fail — surface a clearer error.
        if (!po.customerId) {
          errs.push(`${po.customerPO}: Customer "${po.customerName}" not in catalog. Add the customer first, then re-scan.`);
          continue;
        }

        // Catalog-bound: prefer values from the loaded catalog over the
        // PDF-extracted ones. If the catalog hasn't loaded yet (best-effort
        // fetch) we fall back to po.* — still safer than blank because the
        // backend only persists customerId/customerCode is dropped anyway.
        const catalogCust = catalog?.customers.find((c) => c.id === po.customerId);
        const catalogCustomerName = catalogCust?.name ?? po.customerName;
        const catalogCustomerCode = catalogCust?.code ?? po.customerCode ?? null;
        const catalogCustomerState =
          catalogCust?.hubs.find((h) => h.id === resolvedHubId)?.state ??
          po.customerState ??
          hub.state ??
          "";

        const body = {
          customerId: po.customerId,
          customerName: catalogCustomerName,
          customerCode: catalogCustomerCode,
          customerState: catalogCustomerState,
          customerPOId: po.customerPO,
          // Customer's own reference goes into the SO header's `reference`
          // field — that's what the SO list / detail page reads. Sending
          // it as `yourRefNo` (the PDF field name) was being silently
          // dropped by the SO create endpoint.
          reference: po.yourRefNo ?? null,
          yourRefNo: po.yourRefNo ?? null,
          // Customer's internal SO number from the PDF's "S/O No." field —
          // populates sales_orders.customerSOId so the SO list shows it
          // alongside Customer PO.
          customerSOId: po.customerSO ?? null,
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
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={handleOverlayClick}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col"
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
          <Button variant="ghost" size="sm" onClick={requestClose}>
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
              fileProgress={fileProgress}
              pageProgress={pageProgress}
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
  files, parsing, fileProgress, pageProgress, errors, fileInputRef, onFiles, onDrop,
}: {
  files: UploadedFile[];
  parsing: boolean;
  fileProgress: Record<string, "queued" | "scanning" | "done" | "failed">;
  pageProgress: { done: number; total: number };
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
      {/* Drop zone */}
      <div
        className={`border-2 border-dashed border-[#D1D5DB] rounded-xl p-12 text-center transition-colors ${
          parsing ? "cursor-default" : "hover:border-[#6B5C32] hover:bg-[#FAFAF9] cursor-pointer"
        }`}
        onDragOver={e => e.preventDefault()}
        onDrop={onDrop}
        onClick={() => { if (!parsing) fileInputRef.current?.click(); }}
      >
        {parsing ? (
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-12 w-12 text-[#6B5C32] animate-spin" />
            <p className="text-lg font-medium text-[#1F1D1B]">
              Scanning {files.length} PDF{files.length > 1 ? "s" : ""}...
            </p>
            <p className="text-sm text-[#6B7280]">
              {pageProgress.total > 0
                ? `${pageProgress.done} / ${pageProgress.total} pages scanned`
                : "Preparing pages…"}{" "}
              — extracting items, fabric, config
            </p>
            {files.length > 1 && (
              <p className="text-xs text-[#9CA3AF]">
                {doneCount} of {files.length} files complete
              </p>
            )}
            <p className="text-xs text-[#9CA3AF]">
              AI reads each page (~10–60s) — a large or multi-page PO just takes
              a little longer, it isn’t stuck.
            </p>
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

      {/* Per-file progress list — one row per PDF while a batch scans */}
      {parsing && files.length > 0 && (
        <div className="border border-[#E2DDD8] rounded-lg divide-y divide-[#E2DDD8]">
          {files.map((u) => {
            const status = fileProgress[u.id] ?? "queued";
            return (
              <div key={u.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
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

// Per-file status pill for the UploadStep progress list. Plain text +
// Tailwind, no emoji — consistent with the rest of the modal.
function FileStatusBadge({ status }: { status: "queued" | "scanning" | "done" | "failed" }) {
  if (status === "scanning") {
    return (
      <span className="flex items-center gap-1.5 text-xs font-medium text-[#6B5C32] flex-shrink-0">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Scanning
      </span>
    );
  }
  if (status === "done") {
    return (
      <span className="flex items-center gap-1.5 text-xs font-medium text-green-700 flex-shrink-0">
        <CheckCircle className="h-3.5 w-3.5" />
        Done
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex items-center gap-1.5 text-xs font-medium text-red-700 flex-shrink-0">
        <AlertTriangle className="h-3.5 w-3.5" />
        Failed
      </span>
    );
  }
  return (
    <span className="text-xs font-medium text-[#9CA3AF] flex-shrink-0">
      Queued
    </span>
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
        rawSpec: null,
        diagramOrder: null,
        customSpecials: [],
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
  // Move a row up or down in the items array. Used by the ↑↓ buttons in
  // the # cell. Operator request 2026-05-07 — sometimes the OCR extracts
  // sofa modules out of physical order, and the AI's diagramOrder fix
  // only works when a TV marker is drawn. Manual reorder is the fallback.
  const moveClaudeItem = (rowIdx: number, itemIdx: number, dir: -1 | 1) => {
    setClaudeRows(prev => prev.map((r, i) => {
      if (i !== rowIdx) return r;
      const items = [...r.extracted.items];
      const j = itemIdx + dir;
      if (j < 0 || j >= items.length) return r;
      [items[itemIdx], items[j]] = [items[j], items[itemIdx]];
      return { ...r, extracted: { ...r.extracted, items } };
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
      <div className="space-y-3 max-h-[65vh] overflow-y-auto">
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
            onMoveItem={(itemIdx, dir) => moveClaudeItem(idx, itemIdx, dir)}
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
  row, catalog, selected, expanded, onToggle, onExpand, onUpdate, onUpdateItem, onAddItem, onRemoveItem, onMoveItem, onToggleGold,
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
  onMoveItem: (itemIdx: number, dir: -1 | 1) => void;
  onToggleGold: () => void;
}) {
  const po = row.extracted;
  const totalQty = po.items.reduce((s, i) => s + (i.quantity || 1), 0);
  // On tablet (<= lg) the modal is max-w-4xl ~896px; the inner table needed
  // min-w-[64rem] (1024px) which created a nested horizontal scroll inside
  // the modal scrollbar. Hide non-load-bearing OCR-review columns at tablet
  // width so the table fits the modal — operator can still verify the most
  // important fields (Cat, Product, Qty, Special, Price) without scrolling
  // sideways. Divan/Leg/Gap apply only to bedframes, Size + Fabric the
  // operator can re-check by expanding/scrolling.
  const isTablet = useMediaQuery("(max-width: 1024px)");
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
              {/* Delivery Hub dropdown — bound to the matched customer's
                  hubs from the catalog. Operator can override OCR's pick.
                  Falls back to a free-text input only if catalog is null
                  or customer didn't match (no hubs to choose from). */}
              {(() => {
                const matchedCust = catalog?.customers.find(
                  (c) => c.id === po.customerId,
                );
                const hubs = matchedCust?.hubs ?? [];
                if (hubs.length === 0) {
                  return po.deliveryHub ? (
                    <Badge className="border border-[#D1D5DB]">
                      {po.deliveryHub}
                    </Badge>
                  ) : null;
                }
                return (
                  <select
                    className="text-xs px-2 py-0.5 rounded border border-[#D1D5DB] bg-white hover:border-[#9CA3AF]"
                    value={po.deliveryHubId ?? ""}
                    onChange={(e) => {
                      const id = e.target.value || null;
                      const matched = hubs.find((h) => h.id === id);
                      onUpdate({
                        deliveryHubId: id,
                        deliveryHub: matched?.shortName ?? null,
                      });
                    }}
                  >
                    <option value="">— Hub —</option>
                    {hubs.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.shortName}
                      </option>
                    ))}
                  </select>
                );
              })()}
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
              <div className="mt-2 border border-[#E2DDD8] rounded-lg overflow-x-auto">
                <table className={`w-full text-xs ${isTablet ? "" : "min-w-[64rem]"}`}>
                  <thead>
                    <tr className="bg-[#F5F5F5] text-[#6B7280]">
                      <th className="px-1.5 py-1 text-left">#</th>
                      <th className="px-1.5 py-1 text-left">Cat</th>
                      <th className="px-1.5 py-1 text-left">Product</th>
                      <th className="px-1.5 py-1 text-center">Qty</th>
                      {!isTablet && <th className="px-1.5 py-1 text-left">Size</th>}
                      <th className="px-1.5 py-1 text-left">Fabric</th>
                      {!isTablet && <th className="px-1.5 py-1 text-center">Divan</th>}
                      {!isTablet && <th className="px-1.5 py-1 text-center">Leg</th>}
                      {!isTablet && <th className="px-1.5 py-1 text-center">Gap</th>}
                      <th className="px-1.5 py-1 text-left">Special</th>
                      <th className="px-1.5 py-1 text-right">Price (RM)</th>
                      <th className="px-1.5 py-1"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {po.items.map((item, i) => {
                      // Unified product list across all 3 categories — matches
                      // the Sales Order create flow where the user picks a
                      // product from the full catalog and itemCategory binds
                      // automatically. Without this the operator had to click
                      // Cat (BF/SF/AC) FIRST before the product list refreshed,
                      // adding a step every time the AI mis-categorised an item.
                      const allProducts = [
                        ...(catalog?.bedframes ?? []),
                        ...(catalog?.sofas ?? []),
                        ...(catalog?.accessories ?? []),
                      ];
                      const productCategoryFor = (code: string): ClaudeExtractedItem["category"] | null => {
                        if ((catalog?.bedframes ?? []).includes(code)) return "BEDFRAME";
                        if ((catalog?.sofas ?? []).includes(code)) return "SOFA";
                        if ((catalog?.accessories ?? []).includes(code)) return "ACCESSORY";
                        return null;
                      };
                      const productLabel = (code: string): string => {
                        const cat = productCategoryFor(code);
                        const tag = cat === "SOFA" ? "SF" : cat === "ACCESSORY" ? "AC" : cat === "BEDFRAME" ? "BF" : "?";
                        return `${code} · ${tag}`;
                      };
                      // Variant fields (specials, divan, etc.) still depend on
                      // the line's current category — keep that branching.
                      const fabricList = catalog?.fabrics ?? [];
                      const specialList =
                        item.category === "SOFA"
                          ? (catalog?.sofaSpecials ?? [])
                          : (catalog?.bedframeSpecials ?? []);
                      const isUnknownProduct =
                        item.productCode &&
                        allProducts.length > 0 &&
                        !allProducts.some((c) => c.toUpperCase() === item.productCode.toUpperCase());
                      const isUnknownFabric =
                        item.fabricCode &&
                        fabricList.length > 0 &&
                        !fabricList.some((c) => c.toUpperCase() === item.fabricCode!.toUpperCase());
                      const isFirst = i === 0;
                      const isLast = i === po.items.length - 1;
                      return (
                        <tr key={`${row.sampleId}-${i}`} className="border-t border-[#E2DDD8] align-top">
                          <td className="px-1.5 py-1 text-[#9CA3AF]">
                            <div className="flex items-center gap-0.5">
                              <span className="text-xs">{i + 1}</span>
                              <div className="flex flex-col">
                                <button
                                  type="button"
                                  onClick={() => onMoveItem(i, -1)}
                                  disabled={isFirst}
                                  className="text-[10px] leading-none px-0.5 text-[#9CA3AF] hover:text-[#1F1D1B] disabled:opacity-30 disabled:hover:text-[#9CA3AF]"
                                  title="Move up"
                                >▲</button>
                                <button
                                  type="button"
                                  onClick={() => onMoveItem(i, 1)}
                                  disabled={isLast}
                                  className="text-[10px] leading-none px-0.5 text-[#9CA3AF] hover:text-[#1F1D1B] disabled:opacity-30 disabled:hover:text-[#9CA3AF]"
                                  title="Move down"
                                >▼</button>
                              </div>
                            </div>
                          </td>
                          <td className="px-1.5 py-1">
                            <select
                              className="w-full px-1.5 py-1 text-sm border border-transparent hover:border-[#E2DDD8] rounded bg-transparent"
                              value={item.category}
                              onChange={(e) => onUpdateItem(i, { category: e.target.value as ClaudeExtractedItem["category"] })}
                            >
                              <option value="BEDFRAME">BF</option>
                              <option value="SOFA">SF</option>
                              <option value="ACCESSORY">AC</option>
                            </select>
                          </td>
                          <td className="px-1.5 py-1">
                            <SearchableSelect
                              value={item.productCode}
                              options={allProducts}
                              onChange={(v) => {
                                const cat = productCategoryFor(v);
                                onUpdateItem(i, {
                                  productCode: v,
                                  // Auto-rebind itemCategory from the picked
                                  // product. Mirrors src/pages/sales/create.tsx
                                  // selectProduct() — the line's category
                                  // follows the product, not the other way
                                  // around. Cat dropdown stays for manual
                                  // override but rarely needs to be touched.
                                  ...(cat && cat !== item.category ? { category: cat } : {}),
                                });
                              }}
                              placeholder="Search SKU…"
                              widthClass="w-40"
                              warning={!!isUnknownProduct}
                              getLabel={productLabel}
                            />
                          </td>
                          <td className="px-1.5 py-1 text-center">
                            <input
                              type="number"
                              onFocus={(e) => e.currentTarget.select()}
                              className="w-14 px-1.5 py-1 text-sm border border-transparent hover:border-[#E2DDD8] rounded text-center"
                              value={item.quantity}
                              onChange={(e) => onUpdateItem(i, { quantity: Number(e.target.value) || 0 })}
                            />
                          </td>
                          {!isTablet && (
                            <td className="px-1.5 py-1">
                              <input
                                className="w-16 px-1.5 py-1 text-sm border border-transparent hover:border-[#E2DDD8] rounded"
                                value={item.sizeLabel ?? ""}
                                onChange={(e) => onUpdateItem(i, { sizeLabel: e.target.value || null })}
                              />
                            </td>
                          )}
                          <td className="px-1.5 py-1">
                            <SearchableSelect
                              value={item.fabricCode ?? ""}
                              options={fabricList}
                              onChange={(v) => onUpdateItem(i, { fabricCode: v || null })}
                              placeholder="Search fabric…"
                              widthClass="w-36"
                              warning={!!isUnknownFabric}
                            />
                          </td>
                          {!isTablet && (
                            <td className="px-1.5 py-1 text-center">
                              <input
                                list={`div-${row.sampleId}-${i}`}
                                type="number"
                                step="0.5"
                                onFocus={(e) => e.currentTarget.select()}
                                className="w-16 px-1.5 py-1 text-sm border border-transparent hover:border-[#E2DDD8] rounded text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
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
                          )}
                          {!isTablet && (
                            <td className="px-1.5 py-1 text-center">
                              {/* Single dropdown matches the Maintenance leg-height
                                  pattern: "No Leg" + numeric options. The current
                                  value renders as either "No Leg" or e.g. '4"'. */}
                              <select
                                className="w-20 px-1.5 py-1 text-sm border border-transparent hover:border-[#E2DDD8] rounded bg-transparent disabled:opacity-50"
                                value={item.noLeg ? "__NOLEG__" : (item.legHeightInches != null ? String(item.legHeightInches) : "")}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  if (v === "__NOLEG__") {
                                    onUpdateItem(i, { noLeg: true, legHeightInches: null });
                                  } else if (v === "") {
                                    onUpdateItem(i, { noLeg: false, legHeightInches: null });
                                  } else {
                                    onUpdateItem(i, { noLeg: false, legHeightInches: Number(v) });
                                  }
                                }}
                                disabled={item.category === "ACCESSORY"}
                              >
                                <option value="">—</option>
                                <option value="__NOLEG__">No Leg</option>
                                {legValues.map((v) => (
                                  <option key={v} value={v}>{`${v}"`}</option>
                                ))}
                              </select>
                            </td>
                          )}
                          {!isTablet && (
                            <td className="px-1.5 py-1 text-center">
                              <input
                                list={`gap-${row.sampleId}-${i}`}
                                type="number"
                                step="0.5"
                                onFocus={(e) => e.currentTarget.select()}
                                className="w-16 px-1.5 py-1 text-sm border border-transparent hover:border-[#E2DDD8] rounded text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
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
                          )}
                          <td className="px-1.5 py-1">
                            <SpecialMultiSelect
                              value={item.specialOrder ?? ""}
                              options={specialList}
                              onChange={(next) =>
                                onUpdateItem(i, { specialOrder: next || null })
                              }
                            />
                            {/* Other (custom) — free-text specials with own
                                surcharge, mirrors src/pages/sales/create.tsx
                                customSpecials. AI never populates this; only
                                operator adds. */}
                            <div className="mt-1">
                              <button
                                type="button"
                                onClick={() => onUpdateItem(i, {
                                  customSpecials: [
                                    ...(item.customSpecials ?? []),
                                    { description: "", surchargeSen: 0 },
                                  ],
                                })}
                                className="text-xs text-[#6B5C32] hover:text-[#4A3F22] flex items-center gap-0.5"
                              >
                                <Plus className="h-3 w-3" />
                                Custom
                                {item.customSpecials?.length > 0 && (
                                  <span className="text-[#9CA3AF]">({item.customSpecials.length})</span>
                                )}
                              </button>
                              {(item.customSpecials ?? []).map((cs, csIdx) => (
                                <div key={csIdx} className="mt-1 flex items-center gap-1">
                                  <input
                                    type="text"
                                    value={cs.description}
                                    onChange={(e) => {
                                      const next = [...(item.customSpecials ?? [])];
                                      next[csIdx] = { ...next[csIdx], description: e.target.value };
                                      onUpdateItem(i, { customSpecials: next });
                                    }}
                                    placeholder="e.g. Custom Foam 35D"
                                    className="flex-1 px-1.5 py-1 text-xs border border-[#E2DDD8] rounded"
                                  />
                                  <input
                                    type="number"
                                    step="0.01"
                                    onFocus={(e) => e.currentTarget.select()}
                                    value={cs.surchargeSen / 100}
                                    onChange={(e) => {
                                      const next = [...(item.customSpecials ?? [])];
                                      next[csIdx] = {
                                        ...next[csIdx],
                                        surchargeSen: Math.round(parseFloat(e.target.value || "0") * 100),
                                      };
                                      onUpdateItem(i, { customSpecials: next });
                                    }}
                                    className="w-16 px-1.5 py-1 text-xs border border-[#E2DDD8] rounded text-right"
                                    title="RM"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => onUpdateItem(i, {
                                      customSpecials: (item.customSpecials ?? []).filter((_, k) => k !== csIdx),
                                    })}
                                    className="text-[#9CA3AF] hover:text-red-600"
                                    title="Remove custom"
                                  >
                                    <X className="h-2.5 w-2.5" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          </td>
                          <td className="px-1.5 py-1 text-right">
                            <input
                              type="number"
                              step="0.01"
                              onFocus={(e) => e.currentTarget.select()}
                              className="w-20 px-1.5 py-1 text-sm border border-transparent hover:border-[#E2DDD8] rounded text-right"
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

// ─── Inline-edit dropdown coordination ──────────────────────────────────
// Only one inline-edit dropdown (SKU / Fabric SearchableSelect or the
// Special chip picker) may be open at a time across the whole preview —
// otherwise two panels stack and cover each other. Each editor, when it
// opens, fires a document-level custom event tagged with its own instance
// id; every other editor listens and closes itself when the event's id
// isn't its own. Cheaper than threading shared state through PreviewStep →
// every card → every row, and works uniformly across all editor types and
// across rows/cards.
const OPEN_EDITOR_EVENT = "scanpo:inline-editor-open";

function broadcastEditorOpen(id: string) {
  document.dispatchEvent(
    new CustomEvent(OPEN_EDITOR_EVENT, { detail: id }),
  );
}

// Subscribe `close` to fire whenever a DIFFERENT editor opens. Pass the
// editor's own instance id so it ignores its own open broadcast.
function useCloseOnOtherEditorOpen(
  selfId: string,
  isOpen: boolean,
  close: () => void,
) {
  useEffect(() => {
    if (!isOpen) return;
    const onOther = (e: Event) => {
      const openedId = (e as CustomEvent<string>).detail;
      if (openedId !== selfId) close();
    };
    document.addEventListener(OPEN_EDITOR_EVENT, onOther);
    return () => document.removeEventListener(OPEN_EDITOR_EVENT, onOther);
  }, [selfId, isOpen, close]);
}

// Fire `close` on a mousedown that lands outside EVERY supplied ref. Pass
// both the trigger root and the (portaled) panel so a click inside either
// is treated as inside. mousedown rather than click so switching cells is
// a single press.
function useOutsideClick(
  refs: React.RefObject<HTMLElement | null>[],
  isOpen: boolean,
  close: () => void,
) {
  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const inside = refs.some((r) => r.current?.contains(target));
      if (!inside) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // refs identities are stable across renders (useRef); intentionally not
    // in deps so the listener isn't torn down/re-added every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, close]);
}

// Compute fixed-position coords for a panel anchored under a trigger rect.
// The preview table lives inside nested overflow boxes (modal scroller →
// max-h card list → the table's own overflow-x-auto), every one of which
// clips an in-flow absolute panel. Portaling to <body> with these coords
// sidesteps all three. Clamps to the viewport so wide panels never run off
// screen on narrow widths.
function anchorPanelPos(
  rect: DOMRect,
  panelWidth: number,
): { top: number; left: number; width: number } {
  const width = Math.min(panelWidth, window.innerWidth - 16);
  const left = Math.max(
    8,
    Math.min(rect.left, window.innerWidth - width - 8),
  );
  return { top: rect.bottom + 4, left, width };
}

// Searchable single-value combobox — replaces the browser-native
// <input list="…"> + <datalist> combo, which had two annoying quirks:
//   1. On click, browsers usually show the WHOLE list — not filtered.
//   2. No keyboard nav, no clear way to discover that you should type.
// This component shows a labeled input that, on focus or click, opens
// a popover with type-to-filter. Click an option to commit. Click
// outside or press Esc to close.
function SearchableSelect({
  value,
  options,
  onChange,
  placeholder,
  widthClass,
  warning,
  getLabel,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  placeholder?: string;
  widthClass?: string;
  warning?: boolean;
  // Optional decorator — when provided, renders this string in the dropdown
  // list AND uses it for substring search, so callers can stick a category
  // suffix ("5530-1A · SF") onto each option without changing what value
  // gets stored. The closed-state button still shows the bare value (so the
  // table cell stays clean once a pick is made).
  getLabel?: (v: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const selfId = useId();

  const close = useCallback(() => setOpen(false), []);
  // Single-open: close this editor when any other one opens.
  useCloseOnOtherEditorOpen(selfId, open, close);
  // Outside-click closes. Checks BOTH the in-table trigger root AND the
  // portaled panel (the panel lives on <body>, so the trigger ref alone
  // wouldn't contain it — a click on an option would otherwise read as
  // "outside" and dismiss before the option's onClick fires). mousedown
  // (not click) lets a click on another cell's trigger close this one and
  // open that one in a single press.
  useOutsideClick([ref, panelRef], open, close);

  // Anchor the portaled panel under the trigger and keep it tracking on
  // scroll/resize, since the panel lives on <body> not next to the cell.
  /* eslint-disable react-hooks/set-state-in-effect -- measure-then-position a
     portaled panel; synchronous setState in useLayoutEffect is the intended
     pattern for anchoring to a measured DOM rect. */
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (r) setPos(anchorPanelPos(r, 288)); // 288px = w-72
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter((o) => {
        const hay = getLabel ? getLabel(o).toLowerCase() : o.toLowerCase();
        return hay.includes(q);
      })
    : options;

  return (
    <div ref={ref} className={`relative inline-block ${widthClass ?? "w-40"}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setOpen((o) => {
            const next = !o;
            if (next) broadcastEditorOpen(selfId);
            return next;
          });
          setQuery("");
        }}
        className={`w-full text-left px-2 py-1 text-sm border rounded truncate ${
          warning
            ? "border-amber-400 bg-amber-50 text-[#9C6F1E]"
            : "border-[#E2DDD8] hover:border-[#9CA3AF] bg-white"
        }`}
        title={value || placeholder}
      >
        {value || <span className="text-[#9CA3AF]">{placeholder ?? "Select…"}</span>}
        <span className="float-right text-[#9CA3AF]">▾</span>
      </button>
      {open && pos && createPortal(
        // Portaled to <body> so the nested overflow boxes around the table
        // (modal scroller → max-h card list → table overflow-x-auto) can't
        // clip it. Fixed-positioned under the trigger via getBoundingClientRect.
        <div
          ref={panelRef}
          className="fixed z-[61] bg-white border border-[#E2DDD8] rounded-md shadow-lg"
          style={{ top: pos.top, left: pos.left, width: pos.width }}
        >
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              if (e.key === "Enter" && filtered[0]) {
                onChange(filtered[0]);
                close();
              }
            }}
            placeholder="Type to search…"
            className="w-full px-3 py-2 text-sm border-b border-[#E2DDD8] focus:outline-none"
          />
          <div className="max-h-72 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-[#9CA3AF]">No matches</div>
            ) : (
              filtered.slice(0, 100).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => {
                    onChange(opt);
                    close();
                  }}
                  className={`block w-full text-left px-3 py-2 text-sm hover:bg-[#FAF9F7] ${
                    opt === value ? "bg-[#F5F0EB] font-medium" : ""
                  }`}
                >
                  {getLabel ? getLabel(opt) : opt}
                </button>
              ))
            )}
            {filtered.length > 100 && (
              <div className="px-3 py-1 text-[10px] text-[#9CA3AF] border-t border-[#E2DDD8]">
                Showing first 100 of {filtered.length} — narrow your search to see more.
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// Multi-select chip component for the Special Orders cell. Stores as
// comma-separated string for backwards compatibility with the SO body
// (single specialOrder field), splits on display into chips. Operator
// adds via "+ Add" dropdown of remaining options, removes via × on each
// chip. No free-typing — values must come from the catalog.
function SpecialMultiSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (next: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const selfId = useId();
  const selected = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const remaining = options.filter((o) => !selected.includes(o));

  const close = useCallback(() => setPicking(false), []);
  // Single-open: close this picker when any other inline editor opens. The
  // missing outside-click handler here was the main "covered/overlapping"
  // bug — the panel stayed open while the operator clicked other cells.
  useCloseOnOtherEditorOpen(selfId, picking, close);
  // Outside-click closes — checks the chip/+Add root AND the portaled panel.
  useOutsideClick([rootRef, panelRef], picking, close);

  /* eslint-disable react-hooks/set-state-in-effect -- measure-then-position a
     portaled panel; synchronous setState in useLayoutEffect is the intended
     pattern for anchoring to a measured DOM rect. */
  useLayoutEffect(() => {
    if (!picking) { setPos(null); return; }
    const place = () => {
      const r = addBtnRef.current?.getBoundingClientRect();
      if (r) setPos(anchorPanelPos(r, 288)); // 288px = w-72
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [picking]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const add = (opt: string) => {
    const next = [...selected, opt].join(", ");
    onChange(next);
    close();
  };
  const remove = (opt: string) => {
    onChange(selected.filter((s) => s !== opt).join(", "));
  };

  return (
    <div ref={rootRef} className="relative min-w-[18rem] max-w-[22rem]">
      {/* Chips wrap to multiple lines so every label is readable in full. */}
      {/* No horizontal scroll — operator can see the whole chip text at once, */}
      {/* row just gets taller when there are many specials. */}
      <div className="flex flex-wrap items-center gap-1">
        {selected.map((s) => (
          <span
            key={s}
            className="inline-flex items-center gap-0.5 px-2 py-0.5 text-xs rounded bg-[#F5F0EB] text-[#6B5C32] border border-[#E2DDD8] whitespace-nowrap"
          >
            {s}
            <button
              type="button"
              onClick={() => remove(s)}
              className="text-[#9CA3AF] hover:text-red-600"
              title="Remove"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {selected.length === 0 && (
          <span className="text-xs text-[#9CA3AF] italic">none</span>
        )}
        {remaining.length > 0 && (
          <button
            ref={addBtnRef}
            type="button"
            onClick={() =>
              setPicking((p) => {
                const next = !p;
                if (next) broadcastEditorOpen(selfId);
                return next;
              })
            }
            className="text-xs px-2 py-1 rounded border border-dashed border-[#D1D5DB] text-[#6B7280] hover:border-[#6B5C32] hover:text-[#6B5C32] whitespace-nowrap"
          >
            + Add
          </button>
        )}
      </div>
      {picking && pos && remaining.length > 0 && createPortal(
        // Portaled to <body> so the nested overflow boxes around the table
        // can't clip it. Fixed-positioned under the + Add button.
        <div
          ref={panelRef}
          className="fixed z-[61] bg-white border border-[#E2DDD8] rounded-md shadow-lg max-h-72 overflow-y-auto"
          style={{ top: pos.top, left: pos.left, width: pos.width }}
        >
          {remaining.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => add(opt)}
              className="block w-full text-left px-3 py-2 text-sm hover:bg-[#FAF9F7]"
            >
              {opt}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
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
