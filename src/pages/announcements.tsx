// ============================================================
// /announcements — Office posts that every worker sees on their phone.
//
// The office types a Title + Message here and taps Post; the note appears at
// the top of every worker's mobile home screen (worker portal) until it's
// deactivated, deleted, or its optional expiry passes. v1 has NO push.
//
// Backend: /api/announcements (admin, auth-gated via requirePermission). The
// worker side reads /api/worker/announcements. See src/api/routes/announcements.ts.
// ============================================================
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Megaphone,
  Plus,
  Trash2,
  CheckCircle,
  EyeOff,
  Eye,
  ChevronDown,
  ChevronRight,
  BellRing,
  Users,
  Paperclip,
  ImageIcon,
  Video,
  FileText,
  File as FileIcon,
  X,
  Building2,
  UserRound,
  Globe,
} from "lucide-react";
import {
  ANNOUNCEMENT_CATEGORIES,
  ANNOUNCEMENT_CATEGORY_ORDER,
  normalizeAnnouncementCategory,
  type AnnouncementCategory,
} from "@/lib/announcement-category";
import { AnnouncementCategoryBadge } from "@/components/announcement-category-badge";

// One media file attached to a notice. `fileId` lives in the existing
// /api/files store; the worker portal renders it inline (image/video) or as a
// download link (PDF) by `mime`.
type Attachment = {
  fileId: string;
  name: string;
  mime: string;
};

type TargetType = "ALL" | "DEPTS" | "WORKERS" | "MIXED";

type Announcement = {
  id: string;
  title: string;
  body: string;
  isActive: boolean;
  expiresAt: string | null;
  createdAt: string | null;
  createdBy: string | null;
  attachments?: Attachment[];
  targetType?: TargetType;
  targetDeptCodes?: string[];
  targetWorkerIds?: string[];
  category?: AnnouncementCategory;
};

// Minimal shapes from the existing /api/departments + /api/workers list
// endpoints, used to populate the recipient picker.
type DeptOption = { code: string; name: string };
type WorkerOption = {
  id: string;
  name: string;
  empNo: string;
  departmentCode: string;
};

// Coarse media kind for picking the right icon / preview in the composer + list.
function attachmentKind(mime: string): "image" | "video" | "pdf" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  return "file";
}

type ListResponse = { success?: boolean; data?: Announcement[] };

// Read-receipt payload for one announcement (GET /api/announcements/:id/acks).
type AckedWorker = { id: string; name: string; empNo: string; ackedAt: string | null };
type PendingWorker = { id: string; name: string; empNo: string };
type AcksData = {
  total: number;
  ackedCount: number;
  acked: AckedWorker[];
  pending: PendingWorker[];
};
type AcksResponse = { success?: boolean; data?: AcksData };
type RemindResponse = { success?: boolean; pendingCount?: number };

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-MY", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isExpired(a: Announcement): boolean {
  if (!a.expiresAt) return false;
  const t = Date.parse(a.expiresAt);
  return !Number.isNaN(t) && t <= Date.now();
}

// Short "To: …" line for the posted list. ALL → "All workers"; otherwise a
// compact summary like "Packing · 3 people". Dept codes resolve to names via
// the supplied lookup, falling back to the raw code.
function targetSummary(
  a: Announcement,
  deptName: (code: string) => string,
): string {
  const type = a.targetType ?? "ALL";
  if (type === "ALL") return "All workers";
  const depts = a.targetDeptCodes ?? [];
  const workers = a.targetWorkerIds ?? [];
  const parts: string[] = [];
  if (depts.length === 1) parts.push(deptName(depts[0]));
  else if (depts.length > 1)
    parts.push(`${deptName(depts[0])} +${depts.length - 1} depts`);
  if (workers.length > 0)
    parts.push(
      `${workers.length} ${workers.length === 1 ? "person" : "people"}`,
    );
  return parts.length > 0 ? parts.join(" · ") : "All workers";
}

// ---------------------------------------------------------------------------
// Per-announcement read-receipt panel. Collapsed by default; lazy-fetches the
// acked-vs-pending split only when the office expands it (so the list load
// stays cheap). "Remind un-acked" re-pops the notice for everyone who hasn't
// acknowledged — there is NO push, so remind == re-pop on the worker's next app
// open; the office still uses this list to chase people in person.
// ---------------------------------------------------------------------------
function ReadReceiptPanel({
  announcement,
  onFlash,
  onRemind,
}: {
  announcement: Announcement;
  onFlash: (msg: string) => void;
  onRemind: (scope: "all" | "unacked") => Promise<number | null>;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AcksData | null>(null);
  const [loading, setLoading] = useState(false);
  const [reminding, setReminding] = useState(false);

  const fetchAcks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/announcements/${announcement.id}/acks`);
      if (!res.ok) return;
      const json = (await res.json()) as AcksResponse;
      if (json.success && json.data) setData(json.data);
    } catch {
      /* leave data as-is */
    } finally {
      setLoading(false);
    }
  }, [announcement.id]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    // Lazy-load on first expand; re-fetch on each expand so a freshly-acked
    // worker shows up without a full page reload.
    if (next) await fetchAcks();
  }

  async function handleRemind(scope: "all" | "unacked") {
    setReminding(true);
    try {
      const count = await onRemind(scope);
      if (count != null) {
        onFlash(
          scope === "all"
            ? `Reminder set — it will re-pop for all ${count} ${
                count === 1 ? "worker" : "workers"
              }`
            : count === 0
              ? "Everyone has acknowledged — no one to remind"
              : `Reminder set — it will re-pop for ${count} un-acknowledged ${
                  count === 1 ? "worker" : "workers"
                }`,
        );
      }
      // Refresh the split if the panel is open (counts are unchanged by a
      // remind, but keep it consistent if acks landed in the meantime).
      if (open) await fetchAcks();
    } finally {
      setReminding(false);
    }
  }

  const ackedCount = data?.ackedCount ?? 0;
  const total = data?.total ?? 0;

  return (
    <div className="mt-3 border-t border-[#F0ECE9] pt-3">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center gap-1.5 text-xs font-semibold text-[#6B5C32] hover:text-[#5a4d2a]"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <Users className="h-3.5 w-3.5" />
        {data ? `Read ${ackedCount} of ${total}` : "Read receipts"}
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {loading && !data ? (
            <p className="text-xs text-[#8A8680]">Loading…</p>
          ) : data ? (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {/* Acknowledged */}
                <div className="rounded-lg border border-[#E2DDD8] bg-[#FAFAF8] p-3">
                  <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#2A6B4A]">
                    <CheckCircle className="h-3.5 w-3.5" />
                    Acknowledged ({data.acked.length})
                  </p>
                  {data.acked.length === 0 ? (
                    <p className="text-xs text-[#9CA3AF]">No one yet.</p>
                  ) : (
                    <ul className="space-y-1">
                      {data.acked.map((w) => (
                        <li
                          key={w.id}
                          className="flex items-baseline justify-between gap-2 text-xs"
                        >
                          <span className="min-w-0 truncate text-[#1F1D1B]">
                            {w.name || w.empNo || w.id}
                          </span>
                          <span className="shrink-0 text-[10px] text-[#9CA3AF]">
                            {fmtDateTime(w.ackedAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {/* Pending */}
                <div className="rounded-lg border border-[#E2DDD8] bg-[#FAFAF8] p-3">
                  <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#9A3A2D]">
                    <EyeOff className="h-3.5 w-3.5" />
                    Not yet ({data.pending.length})
                  </p>
                  {data.pending.length === 0 ? (
                    <p className="text-xs text-[#9CA3AF]">Everyone has read it.</p>
                  ) : (
                    <ul className="space-y-1">
                      {data.pending.map((w) => (
                        <li
                          key={w.id}
                          className="min-w-0 truncate text-xs text-[#5A5550]"
                        >
                          {w.name || w.empNo || w.id}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {data.pending.length > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleRemind("unacked")}
                    disabled={reminding}
                    className="gap-1.5"
                  >
                    <BellRing className="h-3.5 w-3.5" />
                    {reminding
                      ? "Reminding…"
                      : `Remind un-acknowledged (${data.pending.length})`}
                  </Button>
                )}
                {total > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleRemind("all")}
                    disabled={reminding}
                    className="gap-1.5"
                  >
                    <BellRing className="h-3.5 w-3.5" />
                    {reminding ? "Reminding…" : `Remind all (${total})`}
                  </Button>
                )}
              </div>
              <p className="text-[10px] leading-snug text-[#9CA3AF]">
                &ldquo;Remind un-acknowledged&rdquo; re-pops only for workers who
                haven&apos;t tapped &ldquo;Got it&rdquo; yet. &ldquo;Remind
                all&rdquo; resets every receipt so the whole team acknowledges
                again. It shows on each worker&apos;s next app open — use the list
                above to chase them in person too.
              </p>
            </>
          ) : (
            <p className="text-xs text-[#9A3A2D]">Couldn&apos;t load read receipts.</p>
          )}
        </div>
      )}
    </div>
  );
}

// Small icon for an attachment kind (composer chips + posted-list rows).
function AttachmentIcon({ mime }: { mime: string }) {
  const kind = attachmentKind(mime);
  if (kind === "image") return <ImageIcon className="h-3.5 w-3.5 shrink-0" />;
  if (kind === "video") return <Video className="h-3.5 w-3.5 shrink-0" />;
  if (kind === "pdf") return <FileText className="h-3.5 w-3.5 shrink-0" />;
  return <FileIcon className="h-3.5 w-3.5 shrink-0" />;
}

// Read-only attachment list shown on a POSTED announcement (the composer uses
// its own removable chips). Images render as a small thumbnail; everything else
// is an icon + name that opens the file in a new tab.
function PostedAttachments({ attachments }: { attachments: Attachment[] }) {
  if (!attachments.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {attachments.map((att) => {
        const href = `/api/files/${att.fileId}/download`;
        const isImage = attachmentKind(att.mime) === "image";
        return (
          <a
            key={att.fileId}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-md border border-[#E2DDD8] bg-[#FAFAF8] px-2 py-1 text-xs text-[#5A5550] hover:bg-[#F3EFE9]"
            title={att.name}
          >
            {isImage ? (
              <img
                src={href}
                alt={att.name}
                className="h-8 w-8 rounded object-cover"
              />
            ) : (
              <AttachmentIcon mime={att.mime} />
            )}
            <span className="max-w-[12rem] truncate">
              {att.name || "attachment"}
            </span>
          </a>
        );
      })}
    </div>
  );
}

export default function AnnouncementsPage() {
  const { confirm } = useConfirm();
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  // Category for the next post (default General Memo). Persisted on POST below.
  const [category, setCategory] = useState<AnnouncementCategory>("GENERAL");
  const [expiresAt, setExpiresAt] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  // Media to attach to the next post. Each file is uploaded to /api/files the
  // moment it's picked; we keep only the lightweight {fileId,name,mime} manifest
  // that gets saved on the announcement POST.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---- Recipient targeting (compose). DEFAULT = everyone ("ALL"). ----
  // audience drives which picker shows; the selected sets can combine (depts +
  // specific people both non-empty → backend stores MIXED).
  const [audience, setAudience] = useState<"ALL" | "DEPTS" | "WORKERS">("ALL");
  const [selDepts, setSelDepts] = useState<Set<string>>(new Set());
  const [selWorkers, setSelWorkers] = useState<Set<string>>(new Set());
  const [deptOpts, setDeptOpts] = useState<DeptOption[]>([]);
  const [workerOpts, setWorkerOpts] = useState<WorkerOption[]>([]);
  const [workerSearch, setWorkerSearch] = useState("");

  // Resolve a dept code → name for the posted "To: …" summary (falls back to
  // the raw code if the dept list hasn't loaded or the code is unknown).
  const deptName = useCallback(
    (code: string) => deptOpts.find((d) => d.code === code)?.name ?? code,
    [deptOpts],
  );

  // Load the dept + worker pickers once on mount (reuses existing endpoints).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [dRes, wRes] = await Promise.all([
          fetch("/api/departments"),
          fetch("/api/workers"),
        ]);
        if (dRes.ok) {
          const dj = (await dRes.json()) as { data?: DeptOption[] };
          if (alive && Array.isArray(dj.data)) {
            setDeptOpts(dj.data.map((d) => ({ code: d.code, name: d.name })));
          }
        }
        if (wRes.ok) {
          const wj = (await wRes.json()) as {
            data?: Array<{
              id: string;
              name: string;
              empNo: string;
              departmentCode: string;
              status?: string;
            }>;
          };
          if (alive && Array.isArray(wj.data)) {
            setWorkerOpts(
              wj.data
                .filter((w) => (w.status ?? "ACTIVE") === "ACTIVE")
                .map((w) => ({
                  id: w.id,
                  name: w.name,
                  empNo: w.empNo,
                  departmentCode: w.departmentCode,
                })),
            );
          }
        }
      } catch {
        /* leave pickers empty — composer still works as "All" */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  function toggleDept(code: string) {
    setSelDepts((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }
  function toggleWorker(id: string) {
    setSelWorkers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  // Reset the targeting back to "everyone" (after a successful post, or when the
  // office switches the audience mode back to All).
  function resetTargeting() {
    setAudience("ALL");
    setSelDepts(new Set());
    setSelWorkers(new Set());
    setWorkerSearch("");
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/announcements");
      if (!res.ok) {
        setLoading(false);
        return;
      }
      const json = (await res.json()) as ListResponse;
      setItems(json.data ?? []);
    } catch {
      /* leave items as-is */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial list load on mount — load() sets state from the fetch result,
    // which is the intended one-shot fetch-on-mount (not a render cascade).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  function showFlash(msg: string) {
    setFlash(msg);
    setTimeout(() => setFlash(null), 2500);
  }

  // Upload each picked file to the SHARED /api/files store (resourceType
  // "announcement"), then keep its {fileId,name,mime} manifest entry. We reuse
  // the existing upload endpoint — no new storage. CSRF is injected globally by
  // api-client (window.fetch patch), so no header needed here.
  async function handleFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    // Reset the input so re-picking the same file fires onChange again.
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (picked.length === 0) return;
    setUploading(true);
    const added: Attachment[] = [];
    let failed = 0;
    let failReason = "";
    try {
      for (const file of picked) {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("resourceType", "announcement");
        // No announcement id yet at compose time — bucket the uploads under a
        // stable "compose" folder; the saved manifest is what links them.
        fd.append("resourceId", "compose");
        const res = await fetch("/api/files", { method: "POST", body: fd });
        const j = (await res.json().catch(() => null)) as {
          success?: boolean;
          data?: { id: string; filename: string; contentType: string };
        } | null;
        if (res.ok && j?.success && j.data) {
          added.push({
            fileId: j.data.id,
            name: j.data.filename || file.name,
            mime: j.data.contentType || file.type,
          });
        } else {
          failed++;
          if (!failReason) {
            const errMsg = (j as { error?: string } | null)?.error;
            failReason = errMsg
              ? `${errMsg} (${res.status})`
              : `HTTP ${res.status}`;
          }
        }
      }
      if (added.length) setAttachments((prev) => [...prev, ...added]);
      if (failed > 0) {
        setError(
          `${failed} file${failed === 1 ? "" : "s"} failed to upload — ${failReason}`,
        );
      }
    } catch {
      setError("Upload failed — network error");
    } finally {
      setUploading(false);
    }
  }

  function removeAttachment(fileId: string) {
    setAttachments((prev) => prev.filter((a) => a.fileId !== fileId));
  }

  async function handlePost(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    setPosting(true);
    try {
      // Derive the targeting payload from the chosen audience. ALL sends empty
      // lists (backend defaults target_type to ALL = everyone); DEPTS / WORKERS
      // send the picked codes/ids. The backend combines them (→ MIXED) if both
      // are non-empty.
      const targetDeptCodes = audience === "DEPTS" ? Array.from(selDepts) : [];
      const targetWorkerIds =
        audience === "WORKERS" ? Array.from(selWorkers) : [];
      const res = await fetch("/api/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          // datetime-local gives a local "YYYY-MM-DDTHH:mm" string; the backend
          // Date.parse handles it. Empty → never expires.
          expiresAt: expiresAt || undefined,
          // Media manifest — already uploaded to /api/files above.
          attachments,
          // Targeting — empty lists = "All workers".
          targetDeptCodes,
          targetWorkerIds,
          // Category — GENERAL | WARNING | SOP | LEARNING.
          category,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setError(err.error || "Failed to post announcement");
        return;
      }
      setTitle("");
      setBody("");
      setCategory("GENERAL");
      setExpiresAt("");
      setAttachments([]);
      resetTargeting();
      showFlash("Announcement posted");
      await load();
    } finally {
      setPosting(false);
    }
  }

  async function toggleActive(a: Announcement) {
    const res = await fetch(`/api/announcements/${a.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !a.isActive }),
    });
    if (res.ok) {
      showFlash(a.isActive ? "Announcement hidden" : "Announcement shown");
      await load();
    }
  }

  async function remove(a: Announcement) {
    const ok = await confirm({
      title: "Delete announcement?",
      message: `Permanently delete "${a.title}"? Workers will no longer see it.`,
      danger: true,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    const res = await fetch(`/api/announcements/${a.id}`, { method: "DELETE" });
    if (res.ok) {
      showFlash("Announcement deleted");
      await load();
    }
  }

  // Re-pop the notice for everyone who hasn't acknowledged. Confirms first (it
  // changes what workers see), then POSTs the remind and returns the un-acked
  // count so the panel can flash it. Returns null if the worker cancels or the
  // request fails.
  async function remind(
    a: Announcement,
    scope: "all" | "unacked",
  ): Promise<number | null> {
    const ok = await confirm({
      title:
        scope === "all"
          ? "Remind ALL workers?"
          : "Remind un-acknowledged workers?",
      message:
        scope === "all"
          ? `Re-pop "${a.title}" on EVERY worker's phone — including those who already tapped "Got it" — and reset the read receipts so everyone acknowledges again. It shows on each worker's next app open.`
          : `Re-pop "${a.title}" on the phones of everyone who hasn't tapped "Got it" yet. It shows on their next app open.`,
      confirmLabel: scope === "all" ? "Remind all" : "Remind",
    });
    if (!ok) return null;
    try {
      const res = await fetch(`/api/announcements/${a.id}/remind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as RemindResponse;
      return typeof json.pendingCount === "number" ? json.pendingCount : 0;
    } catch {
      return null;
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Announcements"
        subtitle="Post a notice that every worker sees on their phone home screen."
      />

      {flash && (
        <div className="flex items-center gap-2 rounded-md bg-[#E7F3EC] px-3 py-2 text-sm text-[#2A6B4A]">
          <CheckCircle className="h-4 w-4" />
          {flash}
        </div>
      )}

      {/* Compose */}
      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handlePost} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-[#5A5550]">
                Title
              </label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Factory closed this Friday (public holiday)"
                maxLength={200}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-[#5A5550]">
                Message <span className="text-[#9CA3AF]">(optional)</span>
              </label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Add any details workers should know…"
                rows={7}
                className="flex min-h-[10rem] w-full resize-y rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-[#1F1D1B] placeholder:text-[#9CA3AF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32] focus-visible:border-transparent"
              />
            </div>
            {/* Media attachments — tutorials (image/video) + SOP PDFs. Each
                file uploads to the shared /api/files store the moment it's
                picked; the chips below are the to-be-saved manifest. */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-[#5A5550]">
                Attachments{" "}
                <span className="text-[#9CA3AF]">
                  (optional — images, videos, PDFs)
                </span>
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*,application/pdf"
                multiple
                onChange={handleFilesPicked}
                className="hidden"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
                className="gap-1.5"
              >
                <Paperclip className="h-3.5 w-3.5" />
                {uploading ? "Uploading…" : "Attach files"}
              </Button>
              {attachments.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {attachments.map((att) => (
                    <span
                      key={att.fileId}
                      className="flex items-center gap-1.5 rounded-md border border-[#E2DDD8] bg-[#FAFAF8] px-2 py-1 text-xs text-[#5A5550]"
                      title={att.name}
                    >
                      <AttachmentIcon mime={att.mime} />
                      <span className="max-w-[12rem] truncate">
                        {att.name || "attachment"}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(att.fileId)}
                        className="text-[#9CA3AF] hover:text-[#9A3A2D]"
                        aria-label={`Remove ${att.name || "attachment"}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            {/* Category — tag the notice as one of four types (default General
                Memo). Segmented buttons, each carrying its own icon + color so
                the office picks visually. Persisted on post and shown as a badge
                on the posted list + every worker surface. */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-[#5A5550]">
                Category
              </label>
              <div className="flex flex-wrap gap-2">
                {ANNOUNCEMENT_CATEGORY_ORDER.map((value) => {
                  const meta = ANNOUNCEMENT_CATEGORIES[value];
                  const Icon = meta.icon;
                  const selected = category === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setCategory(value)}
                      className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium ${
                        selected
                          ? "border-[#6B5C32] bg-[#F3EFE9] text-[#5a4d2a]"
                          : "border-[#E2DDD8] bg-white text-[#5A5550] hover:bg-[#FAFAF8]"
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            </div>
            {/* Recipients — DEFAULT "All". The office can scope the notice to
                specific departments and/or specific workers; the worker portal
                filters server-side so only the targeted phones ever see it. */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-[#5A5550]">
                Recipients
              </label>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    { key: "ALL", label: "All workers", Icon: Globe },
                    { key: "DEPTS", label: "Departments", Icon: Building2 },
                    { key: "WORKERS", label: "Specific people", Icon: UserRound },
                  ] as const
                ).map(({ key, label, Icon }) => {
                  const selected = audience === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => {
                        if (key === "ALL") resetTargeting();
                        else setAudience(key);
                      }}
                      className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium ${
                        selected
                          ? "border-[#6B5C32] bg-[#F3EFE9] text-[#5a4d2a]"
                          : "border-[#E2DDD8] bg-white text-[#5A5550] hover:bg-[#FAFAF8]"
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </button>
                  );
                })}
              </div>

              {audience === "DEPTS" && (
                <div className="mt-3 rounded-lg border border-[#E2DDD8] bg-[#FAFAF8] p-3">
                  {deptOpts.length === 0 ? (
                    <p className="text-xs text-[#9CA3AF]">
                      No departments available.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {deptOpts.map((d) => {
                        const on = selDepts.has(d.code);
                        return (
                          <button
                            key={d.code}
                            type="button"
                            onClick={() => toggleDept(d.code)}
                            className={`rounded-full border px-3 py-1 text-xs font-medium ${
                              on
                                ? "border-[#6B5C32] bg-[#6B5C32] text-white"
                                : "border-[#E2DDD8] bg-white text-[#5A5550] hover:bg-[#F3EFE9]"
                            }`}
                          >
                            {d.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <p className="mt-2 text-[11px] text-[#9CA3AF]">
                    {selDepts.size === 0
                      ? "Pick one or more departments — everyone in them sees this notice."
                      : `${selDepts.size} department${
                          selDepts.size === 1 ? "" : "s"
                        } selected`}
                  </p>
                </div>
              )}

              {audience === "WORKERS" && (
                <div className="mt-3 rounded-lg border border-[#E2DDD8] bg-[#FAFAF8] p-3">
                  <Input
                    value={workerSearch}
                    onChange={(e) => setWorkerSearch(e.target.value)}
                    placeholder="Search workers by name or emp no…"
                    className="mb-2 h-8 text-xs"
                  />
                  {workerOpts.length === 0 ? (
                    <p className="text-xs text-[#9CA3AF]">No workers available.</p>
                  ) : (
                    <div className="max-h-56 space-y-1 overflow-y-auto">
                      {workerOpts
                        .filter((w) => {
                          const q = workerSearch.trim().toLowerCase();
                          if (!q) return true;
                          return (
                            (w.name || "").toLowerCase().includes(q) ||
                            (w.empNo || "").toLowerCase().includes(q)
                          );
                        })
                        .map((w) => {
                          const on = selWorkers.has(w.id);
                          return (
                            <label
                              key={w.id}
                              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-[#F3EFE9]"
                            >
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={() => toggleWorker(w.id)}
                                className="h-3.5 w-3.5 accent-[#6B5C32]"
                              />
                              <span className="min-w-0 flex-1 truncate text-[#1F1D1B]">
                                {w.name || w.empNo || w.id}
                              </span>
                              <span className="shrink-0 text-[10px] text-[#9CA3AF]">
                                {w.empNo}
                                {w.departmentCode ? ` · ${w.departmentCode}` : ""}
                              </span>
                            </label>
                          );
                        })}
                    </div>
                  )}
                  <p className="mt-2 text-[11px] text-[#9CA3AF]">
                    {selWorkers.size === 0
                      ? "Tick the workers who should see this notice."
                      : `${selWorkers.size} ${
                          selWorkers.size === 1 ? "person" : "people"
                        } selected`}
                  </p>
                </div>
              )}
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-[#5A5550]">
                  Hide automatically after{" "}
                  <span className="text-[#9CA3AF]">(optional)</span>
                </label>
                <Input
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                  className="sm:w-64"
                />
              </div>
              <Button type="submit" disabled={posting} className="gap-2">
                <Plus className="h-4 w-4" />
                {posting ? "Posting…" : "Post Announcement"}
              </Button>
            </div>
            {error && <p className="text-sm text-[#9A3A2D]">{error}</p>}
          </form>
        </CardContent>
      </Card>

      {/* List */}
      <div>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-[#8A8680]">
          <Megaphone className="h-4 w-4" />
          Posted Announcements ({items.length})
        </h2>
        {loading ? (
          <p className="text-sm text-[#8A8680]">Loading…</p>
        ) : items.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-[#8A8680]">
              No announcements yet. Post one above and it appears on every
              worker&apos;s phone.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {items.map((a) => {
              const expired = isExpired(a);
              const live = a.isActive && !expired;
              return (
                <Card key={a.id}>
                  <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <AnnouncementCategoryBadge
                          category={normalizeAnnouncementCategory(a.category)}
                        />
                        <span className="font-semibold text-[#1F1D1B]">
                          {a.title}
                        </span>
                        {live ? (
                          <span className="rounded-full bg-[#E7F3EC] px-2 py-0.5 text-[11px] font-semibold text-[#2A6B4A]">
                            Live
                          </span>
                        ) : expired ? (
                          <span className="rounded-full bg-[#F3EFE9] px-2 py-0.5 text-[11px] font-semibold text-[#8A8680]">
                            Expired
                          </span>
                        ) : (
                          <span className="rounded-full bg-[#F3EFE9] px-2 py-0.5 text-[11px] font-semibold text-[#8A8680]">
                            Hidden
                          </span>
                        )}
                      </div>
                      {a.body && (
                        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-[#5A5550]">
                          {a.body}
                        </p>
                      )}
                      <PostedAttachments attachments={a.attachments ?? []} />
                      <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-xs text-[#9CA3AF]">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                            (a.targetType ?? "ALL") === "ALL"
                              ? "bg-[#F3EFE9] text-[#8A8680]"
                              : "bg-[#EDE9F3] text-[#5B4B8A]"
                          }`}
                        >
                          {(a.targetType ?? "ALL") === "ALL" ? (
                            <Globe className="h-3 w-3" />
                          ) : (
                            <Users className="h-3 w-3" />
                          )}
                          To: {targetSummary(a, deptName)}
                        </span>
                      </p>
                      <p className="mt-1 text-xs text-[#9CA3AF]">
                        Posted {fmtDateTime(a.createdAt)}
                        {a.expiresAt
                          ? ` · hides ${fmtDateTime(a.expiresAt)}`
                          : ""}
                      </p>
                      <ReadReceiptPanel
                        announcement={a}
                        onFlash={showFlash}
                        onRemind={(scope) => remind(a, scope)}
                      />
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => toggleActive(a)}
                        className="gap-1.5"
                      >
                        {a.isActive ? (
                          <>
                            <EyeOff className="h-3.5 w-3.5" />
                            Hide
                          </>
                        ) : (
                          <>
                            <Eye className="h-3.5 w-3.5" />
                            Show
                          </>
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => remove(a)}
                        className="gap-1.5 text-[#9A3A2D] hover:bg-[#FDF2F0]"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
