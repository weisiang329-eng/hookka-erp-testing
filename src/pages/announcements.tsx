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
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Megaphone, Plus, Trash2, CheckCircle, EyeOff, Eye } from "lucide-react";

type Announcement = {
  id: string;
  title: string;
  body: string;
  isActive: boolean;
  expiresAt: string | null;
  createdAt: string | null;
  createdBy: string | null;
};

type ListResponse = { success?: boolean; data?: Announcement[] };

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

export default function AnnouncementsPage() {
  const { confirm } = useConfirm();
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

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
    load();
  }, [load]);

  function showFlash(msg: string) {
    setFlash(msg);
    setTimeout(() => setFlash(null), 2500);
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
      const res = await fetch("/api/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          // datetime-local gives a local "YYYY-MM-DDTHH:mm" string; the backend
          // Date.parse handles it. Empty → never expires.
          expiresAt: expiresAt || undefined,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setError(err.error || "Failed to post announcement");
        return;
      }
      setTitle("");
      setBody("");
      setExpiresAt("");
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
                      <p className="mt-1.5 text-xs text-[#9CA3AF]">
                        Posted {fmtDateTime(a.createdAt)}
                        {a.expiresAt
                          ? ` · hides ${fmtDateTime(a.expiresAt)}`
                          : ""}
                      </p>
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
