// Production Folders list page.
//
// Each folder is a named archive of job_card ids — operator created one by
// multi-selecting rows on the Production page and clicking "Save to Folder".
// This page lists every folder for the org with name, JC count, created date,
// + open / rename / delete buttons.
//
// Per Wei Siang: delete MUST be available so a misclicked folder is easy to
// remove. Delete only drops the folder row + folder_job_cards entries (the
// underlying job_cards are NOT touched).
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Trash2, FolderOpen, Pencil, Plus } from "lucide-react";
import { readCsrfCookie, CSRF_HEADER_NAME } from "@/lib/csrf";

function csrfHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const csrf = readCsrfCookie();
  if (csrf) h[CSRF_HEADER_NAME] = csrf;
  return h;
}

// SupabaseAdapter auto-camelCases column names. The old comment here claimed
// `jc_count` stayed snake_case "because it comes from a SQL alias" — the
// opposite is true: `columnFrom` (src/api/lib/db-pg.ts:57) falls back to
// `postgres.toCamel` for exactly the names NOT in the rename map, i.e. SQL
// aliases, so the LIST endpoint sends `jcCount`. (job-cards.ts:296 documents
// the same `jc_count -> jcCount` conversion as a 2026-04-28 bug fix.) Only
// POST hand-builds a snake_case literal (production-folders.ts:177), which is
// why the count looked right immediately after creating a folder and went
// blank on the next load. Read dual-keyed. (BUG-2026-08-13-032)
type Folder = {
  id: string;
  name: string;
  description: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  jcCount?: number;
  jc_count?: number;
};

/** The folder's job-card count, whichever spelling the payload used. */
function folderJcCount(f: {
  jcCount?: number;
  jc_count?: number;
}): number {
  return Number(f.jcCount ?? f.jc_count ?? 0);
}

export default function ProductionFoldersPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/production-folders", { credentials: "include" });
      const j = (await res.json()) as { success: boolean; data: Folder[] };
      if (j.success) setFolders(j.data || []);
    } catch (err) {
      toast.error(`Load failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setLoading(false);
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial mount fetch; refresh's setState calls run after the await resolves
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh is intentionally non-reactive
  }, []);

  const handleDelete = async (folder: Folder) => {
    if (!(await confirm({ title: "Delete folder", message: `Delete folder "${folder.name}"?\n\nThis only removes the folder. The ${folderJcCount(folder)} job card${folderJcCount(folder) === 1 ? "" : "s"} inside stay untouched.`, danger: true }))) return;
    try {
      const res = await fetch(`/api/production-folders/${encodeURIComponent(folder.id)}`, {
        method: "DELETE",
        headers: csrfHeaders(),
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(`Deleted "${folder.name}".`);
      setFolders((prev) => prev.filter((f) => f.id !== folder.id));
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleRenameStart = (folder: Folder) => {
    setRenamingId(folder.id);
    setRenameValue(folder.name);
  };

  const handleRenameSave = async () => {
    const folder = folders.find((f) => f.id === renamingId);
    if (!folder) return;
    const name = renameValue.trim();
    if (!name) {
      toast.error("Name cannot be empty.");
      return;
    }
    try {
      const res = await fetch(`/api/production-folders/${encodeURIComponent(folder.id)}`, {
        method: "PATCH",
        headers: csrfHeaders(),
        body: JSON.stringify({ name }),
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setFolders((prev) => prev.map((f) => (f.id === folder.id ? { ...f, name } : f)));
      setRenamingId(null);
      toast.success("Renamed.");
    } catch (err) {
      toast.error(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Tolerant date formatter — undefined/invalid input does NOT crash the
  // page (was previously `new Date(undefined).toISOString()` throwing
  // RangeError + tripping ErrorBoundary).
  const fmtDate = (iso: string | null | undefined): string => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  };

  // Pre-create an empty folder via a quick prompt. Operator workflow:
  //   "I'm planning tomorrow's Wood Cut sheet — let me make an empty folder
  //    now, then go to Wood Cut tab and Save the right rows into it."
  // No JCs required at create time; the folder shows up immediately with
  // jc_count=0 and the operator can populate it from any dept tab.
  const handleNewFolder = async (): Promise<void> => {
    const name = window.prompt("Folder name:", "");
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Name cannot be empty.");
      return;
    }
    if (trimmed.length > 200) {
      toast.error("Name too long (max 200 chars).");
      return;
    }
    try {
      const res = await fetch("/api/production-folders", {
        method: "POST", headers: csrfHeaders(), credentials: "include",
        body: JSON.stringify({ name: trimmed, jobCardIds: [] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(`Created folder "${trimmed}".`);
      await refresh();
    } catch (err) {
      toast.error(`Create failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="p-4 max-w-5xl mx-auto">
      <div className="mb-4 flex items-center gap-2">
        <h1 className="text-lg font-semibold text-[#3A2E22]">Production Folders</h1>
        <span className="text-[12px] text-[#8A7F73]">— archived schedules</span>
        <div className="flex-1" />
        <Button size="sm" onClick={handleNewFolder} className="bg-[#1F1D1B] hover:bg-[#3A2E22] text-white">
          <Plus className="h-3.5 w-3.5 mr-1" /> New Folder
        </Button>
        <Button size="sm" variant="outline" onClick={refresh}>
          Refresh
        </Button>
      </div>

      <p className="mb-4 text-[12px] text-[#6B5E50]">
        Folders are saved copies of selected job-card lists. Useful for finding back a paper schedule you printed and handed to the floor. Deleting a folder only removes the index — the job cards inside stay live.
      </p>

      {loading ? (
        <div className="text-[12px] text-[#8A7F73]">Loading…</div>
      ) : folders.length === 0 ? (
        <div className="rounded-md border border-dashed border-[#E6E0D9] bg-[#FAF8F4] p-8 text-center">
          <p className="text-[12px] text-[#8A7F73] mb-2">No folders yet.</p>
          <p className="text-[12px] text-[#8A7F73]">
            On any Production dept tab, tick the checkbox on rows → click <strong>Save to Folder</strong> in the toolbar.
          </p>
        </div>
      ) : (
        <div className="grid gap-2">
          {folders.map((folder) => (
            <div
              key={folder.id}
              className="flex items-center gap-3 rounded-md border border-[#E6E0D9] bg-white px-3 py-2 hover:border-[#C9A227]"
            >
              <div className="flex-1 min-w-0">
                {renamingId === folder.id ? (
                  <input
                    type="text"
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={handleRenameSave}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRenameSave();
                      else if (e.key === "Escape") setRenamingId(null);
                    }}
                    className="w-full rounded border border-[#C9A227] bg-white px-2 py-1 text-[13px] font-semibold"
                    maxLength={200}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => navigate(`/production/folders/${folder.id}`)}
                    className="text-left w-full hover:underline"
                  >
                    <div className="text-[13px] font-semibold text-[#1F1D1B]">{folder.name}</div>
                  </button>
                )}
                <div className="text-[11px] text-[#8A7F73] mt-0.5">
                  {folderJcCount(folder)} job card{folderJcCount(folder) === 1 ? "" : "s"} · Created {fmtDate(folder.createdAt)}
                  {folder.createdBy ? ` · by ${folder.createdBy}` : ""}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => navigate(`/production/folders/${folder.id}`)} title="Open folder">
                <FolderOpen className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => handleRenameStart(folder)} title="Rename">
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => handleDelete(folder)} title="Delete folder">
                <Trash2 className="h-3.5 w-3.5 text-red-600" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 text-[12px] text-[#8A7F73]">
        <Plus className="inline h-3.5 w-3.5 mr-1" />
        To create a folder: go to any production dept, multi-select rows, click <strong>Save to Folder</strong>.
      </div>
    </div>
  );
}
