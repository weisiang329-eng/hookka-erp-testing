// ---------------------------------------------------------------------------
// Supplier-document OCR — Phase 3 (UI). The supplier-side twin of
// scan-po-modal.tsx, but deliberately LEAN: a supplier delivery note / invoice
// is a simple line list (code, qty, price), not a furniture PO that needs the
// catalog / size / fabric / sofa-orientation machinery. So this reuses only the
// proven scaffold (file/photo pick → /extract with abort-timeout + retry →
// review → confirm/gold) and hands the reviewed lines back via onApply so each
// host page (GRN, Purchase Invoice) does its own matching/filling.
//
// Backed by routes/scan-supplier.ts (Phase 2). Per-supplier learning: passing
// supplierId injects that supplier's distilled ocrPromptRules; "保存为参考样本"
// (gold) re-distils immediately.
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Upload, Camera, Loader2, ScanLine, Check } from "lucide-react";

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

type Props = {
  open: boolean;
  onClose: () => void;
  /** Inject the supplier's learned OCR rules + scope the few-shot. */
  supplierId?: string | null;
  supplierName?: string | null;
  /** Optional text block of the PO's lines so the model aligns codes/descs. */
  poContext?: string;
  /** Hand the operator-reviewed extraction back to the host page to fill its form. */
  onApply: (ex: SupplierExtraction) => void;
  title?: string;
};

const num = (v: number | null | undefined) =>
  v === null || v === undefined || Number.isNaN(v) ? "" : String(v);

export function ScanSupplierModal({
  open,
  onClose,
  supplierId,
  supplierName,
  poContext,
  onApply,
  title = "扫描供应商单据 / Scan supplier document",
}: Props) {
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
    const fd = new FormData();
    fd.append("file", file);
    if (supplierId) fd.append("supplierId", supplierId);
    if (supplierName) fd.append("supplierName", supplierName);
    if (poContext) fd.append("poContext", poContext);

    // Borrowed from scan-po-modal: a wedged OCR call must not freeze the modal.
    // Abort past 90s and retry transient failures with a short backoff.
    const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
    const DELAYS = [4, 12];
    const MAX = 3;
    let lastErr = "";
    for (let attempt = 0; attempt < MAX; attempt++) {
      const controller = new AbortController();
      // eslint-disable-next-line no-restricted-syntax -- imperative abort timer in an async fetch loop, not a React render; useTimeout is a hook and can't run here
      const timer = setTimeout(() => controller.abort(), 90_000);
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
          ? "识别超时(90s),请重试。"
          : e instanceof Error
            ? e.message
            : "网络错误";
        if (attempt < MAX - 1) {
          await new Promise((r) =>
            // eslint-disable-next-line no-restricted-syntax -- backoff delay in an async retry loop, not a React render
            setTimeout(r, DELAYS[attempt] * 1000),
          );
          continue;
        }
        setError(lastErr);
        setPhase("error");
        return;
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
        setEx({ ...data.data, lines: data.data.lines ?? [] });
        setSampleId(data.sampleId ?? null);
        setPhase("review");
        return;
      }
      lastErr = data.error || `HTTP ${res.status}`;
      if (RETRYABLE.has(res.status) && attempt < MAX - 1) {
        await new Promise((r) =>
          // eslint-disable-next-line no-restricted-syntax -- backoff delay in an async retry loop, not a React render
          setTimeout(r, DELAYS[attempt] * 1000),
        );
        continue;
      }
      setError(lastErr);
      setPhase("error");
      return;
    }
  };

  const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-pick of the same file
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
    // Persist the operator's corrected version (feeds per-supplier learning).
    if (sampleId) {
      try {
        await fetch(`/api/scan-supplier/samples/${sampleId}/confirm`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ correctedJson: ex, gold }),
        });
      } catch {
        /* learning is best-effort — never block the apply */
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
              上传供应商的送货单 / 发票(PDF 或图片),或用手机拍一张。系统会自动读出每一行。
            </p>
            <div className="flex gap-3">
              <Button variant="outline" onClick={() => fileRef.current?.click()}>
                <Upload className="h-4 w-4" /> 上传文件
              </Button>
              <Button variant="primary" onClick={() => camRef.current?.click()}>
                <Camera className="h-4 w-4" /> 拍照
              </Button>
            </div>
          </div>
        )}

        {phase === "scanning" && (
          <div className="p-10 flex flex-col items-center gap-3 text-[#6B7280]">
            <Loader2 className="h-7 w-7 animate-spin" />
            <p className="text-sm">识别中…(约 30–60 秒)</p>
          </div>
        )}

        {phase === "error" && (
          <div className="p-8 flex flex-col items-center gap-4">
            <p className="text-sm text-[#9A3A2D] text-center">识别失败:{error}</p>
            <Button variant="outline" onClick={reset}>
              重试
            </Button>
          </div>
        )}

        {phase === "review" && ex && (
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">供应商</label>
                <Input
                  value={ex.supplierName ?? ""}
                  onChange={(e) => setHeader("supplierName", e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">单号</label>
                <Input
                  value={ex.docNo ?? ""}
                  onChange={(e) => setHeader("docNo", e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">日期</label>
                <Input
                  value={ex.docDate ?? ""}
                  onChange={(e) => setHeader("docDate", e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">类型</label>
                <div className="flex h-10 items-center text-sm text-[#374151]">
                  {ex.docType === "INVOICE"
                    ? "发票"
                    : ex.docType === "DELIVERY_NOTE"
                      ? "送货单"
                      : ex.docType || "—"}
                </div>
              </div>
            </div>

            <div className="border border-[#E2DDD8] rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-[#F0ECE9] text-[#6B7280]">
                  <tr>
                    <th className="text-left px-2 py-1.5">料号</th>
                    <th className="text-left px-2 py-1.5">品名</th>
                    <th className="text-right px-2 py-1.5 w-20">数量</th>
                    <th className="text-left px-2 py-1.5 w-16">单位</th>
                    <th className="text-right px-2 py-1.5 w-24">单价</th>
                    <th className="text-right px-2 py-1.5 w-24">金额</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-2 py-4 text-center text-[#9CA3AF]"
                      >
                        没有读到任何行 — 请重拍一张更清晰的。
                      </td>
                    </tr>
                  )}
                  {lines.map((ln, i) => (
                    <tr key={i} className="border-t border-[#EFEAE6]">
                      <td className="px-1 py-1">
                        <Input
                          className="h-8"
                          value={ln.supplierCode ?? ""}
                          onChange={(e) =>
                            setLine(i, "supplierCode", e.target.value)
                          }
                        />
                      </td>
                      <td className="px-1 py-1">
                        <Input
                          className="h-8"
                          value={ln.description ?? ""}
                          onChange={(e) =>
                            setLine(i, "description", e.target.value)
                          }
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
                          onChange={(e) =>
                            setLine(i, "unitPrice", e.target.value)
                          }
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
                          title="删除这一行"
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
              核对无误后点「套用」会把这些行填进当前表单(你仍需检查并保存)。「保存为参考样本」会让这个供应商以后扫得更准。
            </p>

            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={reset}>
                重扫
              </Button>
              <Button
                variant="outline"
                disabled={applying}
                onClick={() => apply(true)}
                title="套用,并把这次确认的结果存为该供应商的参考样本(gold),提升以后准确度"
              >
                <Check className="h-4 w-4" /> 套用并保存为参考样本
              </Button>
              <Button
                variant="primary"
                disabled={applying || lines.length === 0}
                onClick={() => apply(false)}
              >
                套用
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
