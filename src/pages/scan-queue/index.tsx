// ---------------------------------------------------------------------------
// /scan-queue/:batchId — background OCR scan progress page.
//
// User flow:
//   1. Modal upload of >2 files POSTs to /api/scan-queue/upload
//   2. Browser navigates here with the returned batchId
//   3. This page polls /api/scan-queue/batch/:batchId every 5s
//   4. Once a row is `done`, "Review" opens the existing scan modal pre-filled
//      with the extracted lines so the operator can confirm and Create as DRAFT
//
// The polling stops once every row is in a terminal state (done | failed | cached)
// to avoid a runaway timer on a finished batch.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Clock,
  Zap,
  RefreshCw,
} from "lucide-react";
import { fetchJson } from "@/lib/fetch-json";

// Light status chip — keeps this page self-contained instead of stretching the
// Badge primitive (which only knows "default" / "status"). Tailwind classes
// follow the rest of the dashboard's chip palette.
function Chip({
  tone,
  icon: Icon,
  children,
}: {
  tone: "neutral" | "blue" | "amber" | "emerald" | "red";
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  const palette: Record<typeof tone, string> = {
    neutral: "bg-[#F0ECE9] text-[#6B5C32] border-[#E2DDD8]",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    red: "bg-red-50 text-red-700 border-red-200",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium border ${palette[tone]}`}
    >
      {Icon ? <Icon className="size-3" /> : null}
      {children}
    </span>
  );
}

// Backend shape — keep narrow; the row's raw_json is opaque from this page.
const ScanRowSchema = z
  .object({
    id: z.string(),
    batchId: z.string(),
    kind: z.union([z.literal("po"), z.literal("supplier")]),
    fileName: z.string(),
    mimeType: z.string(),
    fileSize: z.number(),
    supplierId: z.string().nullable(),
    status: z.union([
      z.literal("queued"),
      z.literal("processing"),
      z.literal("done"),
      z.literal("failed"),
      z.literal("cached"),
    ]),
    rawJson: z.unknown().nullable(),
    error: z.string().nullable(),
    cached: z.boolean(),
    cacheSourceId: z.string().nullable(),
    fileHash: z.string(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  })
  .passthrough();

const BatchSchema = z.object({
  success: z.boolean(),
  data: z.object({
    batchId: z.string(),
    items: z.array(ScanRowSchema),
    summary: z.object({
      total: z.number(),
      done: z.number(),
      failed: z.number(),
      processing: z.number(),
      queued: z.number(),
      cached: z.number(),
    }),
  }),
});

type ScanRow = z.infer<typeof ScanRowSchema>;

const POLL_INTERVAL_MS = 5000;
const TERMINAL = new Set(["done", "failed", "cached"]);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function StatusBadge({ status, cached }: { status: ScanRow["status"]; cached: boolean }) {
  if (status === "queued") return <Chip tone="neutral" icon={Clock}>Queued</Chip>;
  if (status === "processing") {
    // animate-spin needs to live on the icon — emit our own inline chip so we
    // can override the icon class without forking the Chip API.
    return (
      <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium border bg-blue-50 text-blue-700 border-blue-200">
        <Loader2 className="size-3 animate-spin" />
        Processing
      </span>
    );
  }
  if (status === "failed") return <Chip tone="red" icon={AlertTriangle}>Failed</Chip>;
  if (status === "cached" || cached) return <Chip tone="amber" icon={Zap}>Cached</Chip>;
  return <Chip tone="emerald" icon={CheckCircle2}>Done</Chip>;
}

export default function ScanQueueBatchPage() {
  const { batchId = "" } = useParams<{ batchId: string }>();
  const [items, setItems] = useState<ScanRow[]>([]);
  const [summary, setSummary] = useState({
    total: 0,
    done: 0,
    failed: 0,
    processing: 0,
    queued: 0,
    cached: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const allTerminal = useMemo(
    () => items.length > 0 && items.every((it) => TERMINAL.has(it.status)),
    [items],
  );

  const poll = useCallback(async () => {
    if (!batchId) return;
    try {
      const r = await fetchJson(
        `/api/scan-queue/batch/${encodeURIComponent(batchId)}`,
        BatchSchema,
      );
      setItems(r.data.items);
      setSummary(r.data.summary);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount; intentional
    void poll();
  }, [poll]);

  useEffect(() => {
    if (allTerminal) return;
    // eslint-disable-next-line no-restricted-syntax -- polling loop; useInterval doesn't suit because we need to stop on allTerminal
    const id = window.setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [poll, allTerminal]);

  const retry = useCallback(
    async (id: string) => {
      try {
        await fetchJson(
          `/api/scan-queue/${encodeURIComponent(id)}/retry`,
          z.object({ success: z.boolean() }).passthrough(),
          { method: "POST" },
        );
        await poll();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [poll],
  );

  // "Review" target — landing destination depends on kind. For now we route
  // back to the host module's scan modal opener (sales for po, procurement
  // for supplier) with the row id pre-loaded via query string. Those modals
  // can be wired to read ?fromQueue=<rowId>; until then the link simply
  // takes the user back to the originating module.
  const reviewHref = useCallback((it: ScanRow) => {
    if (it.kind === "po") return `/sales?fromQueue=${encodeURIComponent(it.id)}`;
    return `/procurement?fromQueue=${encodeURIComponent(it.id)}`;
  }, []);

  return (
    <div className="p-4 space-y-4 max-w-6xl">
      <div className="flex items-center gap-3">
        <Link
          to="/sales"
          className="text-sm text-muted-foreground hover:underline inline-flex items-center gap-1"
        >
          <ArrowLeft className="size-4" />
          Back
        </Link>
        <h1 className="text-2xl font-semibold">Scan Queue</h1>
        <span className="text-sm text-muted-foreground font-mono">
          {batchId}
        </span>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Batch progress</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-6 text-sm">
            <span>
              <strong>{summary.done + summary.cached}</strong> / {summary.total} done
            </span>
            {summary.cached > 0 && (
              <span className="text-amber-700">
                <Zap className="inline size-3" /> {summary.cached} cached
              </span>
            )}
            {summary.processing > 0 && (
              <span className="text-blue-700">
                <Loader2 className="inline size-3 animate-spin" /> {summary.processing} processing
              </span>
            )}
            {summary.queued > 0 && (
              <span className="text-muted-foreground">
                <Clock className="inline size-3" /> {summary.queued} queued
              </span>
            )}
            {summary.failed > 0 && (
              <span className="text-red-700">
                <AlertTriangle className="inline size-3" /> {summary.failed} failed
              </span>
            )}
            {allTerminal && <Chip tone="emerald" icon={CheckCircle2}>Complete</Chip>}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void poll()}
              className="ml-auto"
            >
              <RefreshCw className="size-3 mr-1" />
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-red-200">
          <CardContent className="py-3 text-sm text-red-700">{error}</CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/30">
              <tr>
                <th className="text-left px-3 py-2 font-medium">File</th>
                <th className="text-left px-3 py-2 font-medium">Size</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-left px-3 py-2 font-medium">Detail</th>
                <th className="text-right px-3 py-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                    No files in this batch.
                  </td>
                </tr>
              ) : (
                items.map((it) => (
                  <tr key={it.id} className="border-b last:border-b-0">
                    <td className="px-3 py-2">
                      <div className="font-medium">{it.fileName}</div>
                      <div className="text-xs text-muted-foreground">
                        {it.kind === "po" ? "Customer PO" : "Supplier doc"}
                        {" · "}
                        <span className="font-mono">{it.fileHash.slice(0, 12)}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {formatSize(it.fileSize)}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={it.status} cached={it.cached} />
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground max-w-md">
                      {it.status === "failed" && it.error ? (
                        <span className="text-red-700">{it.error}</span>
                      ) : it.status === "cached" ? (
                        <span>Reused prior extraction (no Claude call)</span>
                      ) : it.status === "processing" ? (
                        <span>Reading document…</span>
                      ) : it.status === "queued" ? (
                        <span>Waiting in queue</span>
                      ) : (
                        <span>Extraction ready</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {it.status === "done" || it.status === "cached" ? (
                        <Link
                          to={reviewHref(it)}
                          className="inline-flex items-center justify-center rounded-md border border-[#E2DDD8] bg-white px-3 h-9 text-xs font-medium text-[#1F1D1B] hover:bg-[#F0ECE9]"
                        >
                          Review
                        </Link>
                      ) : it.status === "failed" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void retry(it.id)}
                        >
                          Retry
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Tip — you can close this tab. Processing continues in the background and you can
        return to <span className="font-mono">/scan-queue/{batchId}</span> any time to
        pick up where the operator left off.
      </p>
    </div>
  );
}
