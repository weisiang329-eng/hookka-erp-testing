// ---------------------------------------------------------------------------
// resource-documents.tsx — attach paperwork and photos to any record.
//
// Owner 2026-08-01: 「这个地方要可以upload我们的purchase agreement 和model 和
// 这个机器的照片」. Built against the SHARED /api/files store (resourceType +
// resourceId) rather than a new table, so it drops onto any module that needs
// documents — equipment today, whatever needs it next without a migration.
//
// Why a document category: a machine accumulates a purchase agreement, a
// warranty card, a manual and a pile of photos. Left as one flat list the
// photos bury the contract, and "where's the warranty" becomes a scroll. The
// category is stored in the filename prefix (the /api/files row has no spare
// column) — ugly but reversible, and it keeps this to zero schema change.
//
// Images render as thumbnails, everything else as a row: a nameplate photo is
// only useful if you can see it without downloading it.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { FileText, Image as ImageIcon, Trash2, Upload } from "lucide-react";

export type DocCategory = "AGREEMENT" | "WARRANTY" | "MANUAL" | "PHOTO" | "OTHER";

const DOC_CATEGORIES: { value: DocCategory; label: string }[] = [
  { value: "AGREEMENT", label: "Purchase agreement / invoice" },
  { value: "WARRANTY", label: "Warranty" },
  { value: "MANUAL", label: "Manual / spec sheet" },
  { value: "PHOTO", label: "Photo" },
  { value: "OTHER", label: "Other" },
];

type FileRow = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt?: string;
};

/** Category is carried as a `CATEGORY__` filename prefix — see the header. */
const PREFIX_RE = /^(AGREEMENT|WARRANTY|MANUAL|PHOTO|OTHER)__/;

function splitName(filename: string): { category: DocCategory; name: string } {
  const m = PREFIX_RE.exec(filename);
  return m
    ? { category: m[1] as DocCategory, name: filename.slice(m[0].length) }
    : { category: "OTHER", name: filename };
}

function isImage(contentType: string, name: string): boolean {
  return (
    contentType.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|heic|heif)$/i.test(name)
  );
}

function prettySize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ResourceDocuments({
  resourceType,
  resourceId,
  title = "Documents & photos",
  hint,
}: {
  resourceType: string;
  resourceId: string;
  title?: string;
  hint?: string;
}) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [rows, setRows] = useState<FileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [category, setCategory] = useState<DocCategory>("AGREEMENT");
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/files?resourceType=${encodeURIComponent(resourceType)}&resourceId=${encodeURIComponent(resourceId)}`,
        { credentials: "include" },
      );
      const j = (await res.json().catch(() => null)) as {
        success?: boolean;
        data?: FileRow[];
      } | null;
      setRows(Array.isArray(j?.data) ? j.data : []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [resourceType, resourceId]);

  useEffect(() => {
    if (!resourceId) return;
    // Deferred one tick: `load` flips `loading` synchronously, and doing that
    // inside the effect body triggers a cascading render (react-refresh rule).
    let cancelled = false;
    const t = setTimeout(() => {
      if (!cancelled) void load();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [resourceId, load]);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    // Reset so re-picking the same file fires onChange again.
    if (inputRef.current) inputRef.current.value = "";
    if (picked.length === 0) return;
    setUploading(true);
    let ok = 0;
    const failures: string[] = [];
    try {
      for (const file of picked) {
        const fd = new FormData();
        // Prefix carries the category; the rest is the operator's own filename.
        fd.append(
          "file",
          new File([file], `${category}__${file.name}`, { type: file.type }),
        );
        fd.append("resourceType", resourceType);
        fd.append("resourceId", resourceId);
        // CSRF is injected globally by api-client's fetch patch — no header here.
        const res = await fetch("/api/files", { method: "POST", body: fd });
        const j = (await res.json().catch(() => null)) as {
          success?: boolean;
          error?: string;
        } | null;
        if (res.ok && j?.success) ok += 1;
        else failures.push(`${file.name}: ${j?.error || `HTTP ${res.status}`}`);
      }
    } finally {
      setUploading(false);
    }
    if (ok > 0) toast.success(ok === 1 ? "File uploaded." : `${ok} files uploaded.`);
    // Report per file — a rejected size limit applies to one file, not the batch.
    for (const f of failures) toast.error(f);
    await load();
  }

  async function onDelete(row: FileRow) {
    const { name } = splitName(row.filename);
    const okToGo = await confirm({
      title: "Delete file?",
      message: `${name} will be removed permanently.`,
      danger: true,
    });
    if (!okToGo) return;
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(row.id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(j.error || `Delete failed (HTTP ${res.status})`);
        return;
      }
      toast.success("File deleted.");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }

  const grouped = DOC_CATEGORIES.map((c) => ({
    ...c,
    files: rows
      .map((r) => ({ row: r, ...splitName(r.filename) }))
      .filter((x) => x.category === c.value),
  })).filter((g) => g.files.length > 0);

  return (
    <div className="rounded-lg border border-[#E2DDD8] bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div>
          <div className="text-sm font-semibold text-[#1F1D1B]">{title}</div>
          {hint && <div className="text-xs text-[#9CA3AF]">{hint}</div>}
        </div>
        <div className="flex items-center gap-2">
          <select
            className="h-9 rounded-md border border-[#E2DDD8] bg-white px-2 text-sm"
            value={category}
            onChange={(e) => setCategory(e.target.value as DocCategory)}
            title="What kind of document are you uploading?"
          >
            {DOC_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={onPick}
          />
          <Button
            type="button"
            variant="outline"
            disabled={uploading || !resourceId}
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="h-4 w-4" />
            {uploading ? "Uploading…" : "Upload"}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="py-6 text-center text-sm text-[#9CA3AF]">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-[#E2DDD8] py-6 text-center text-sm text-[#9CA3AF]">
          Nothing attached yet — upload the purchase agreement, warranty, manual
          or photos of the machine.
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map((g) => (
            <div key={g.value}>
              <div className="text-[11px] uppercase tracking-wide text-[#8A8577] mb-1.5">
                {g.label} ({g.files.length})
              </div>
              {/* Photos as a thumbnail grid — a nameplate shot is only useful
                  if you can read it without downloading it first. */}
              {g.value === "PHOTO" ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                  {g.files.map((f) => (
                    <div key={f.row.id} className="group relative">
                      <a
                        href={`/api/files/${encodeURIComponent(f.row.id)}/download`}
                        target="_blank"
                        rel="noreferrer"
                        title={f.name}
                      >
                        <img
                          src={`/api/files/${encodeURIComponent(f.row.id)}/download`}
                          alt={f.name}
                          className="h-24 w-full rounded border border-[#E2DDD8] object-cover"
                          loading="lazy"
                        />
                      </a>
                      <button
                        type="button"
                        onClick={() => void onDelete(f.row)}
                        className="absolute right-1 top-1 hidden rounded bg-white/90 p-1 group-hover:block"
                        style={{ color: "var(--text-danger, #9A3A2D)" }}
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="divide-y divide-[#F0ECE3] rounded border border-[#E2DDD8]">
                  {g.files.map((f) => (
                    <div
                      key={f.row.id}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <a
                        href={`/api/files/${encodeURIComponent(f.row.id)}/download`}
                        target="_blank"
                        rel="noreferrer"
                        className="flex min-w-0 items-center gap-2 text-sm text-[#1F1D1B] hover:underline"
                      >
                        {isImage(f.row.contentType, f.name) ? (
                          <ImageIcon className="h-4 w-4 flex-shrink-0 text-[#6B7280]" />
                        ) : (
                          <FileText className="h-4 w-4 flex-shrink-0 text-[#6B7280]" />
                        )}
                        <span className="truncate">{f.name}</span>
                      </a>
                      <div className="flex flex-shrink-0 items-center gap-3">
                        <span className="text-xs text-[#9CA3AF]">
                          {prettySize(f.row.sizeBytes)}
                        </span>
                        <button
                          type="button"
                          onClick={() => void onDelete(f.row)}
                          style={{ color: "var(--text-danger, #9A3A2D)" }}
                          title="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
