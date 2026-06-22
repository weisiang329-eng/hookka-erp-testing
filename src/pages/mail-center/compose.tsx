// ---------------------------------------------------------------------------
// Mail Center — Compose (start a NEW outbound conversation).
//
// The reply composer in detail.tsx only replies inside an existing thread.
// This dialog lets the operator send a brand-new email to any address (owner
// ask: "Mail Center 不能发信息给别人吗?"). It posts to the existing
// POST /api/mail-center/compose endpoint, which creates the thread + first
// outbound message and SENDS via Brevo (hookka.com is verified there, so this
// works today without any MX change).
//
// Rendered as a fixed-overlay Card the house way (same structure as
// useConfirm's confirmDialog) — there is no generic Dialog primitive.
//
// Exposed as a named `ComposeDialog` (embedded from index.tsx). A thin default
// export is also provided so a lazy import never explodes, but no route mounts
// it — Compose is always a modal over the inbox.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { csrfHeaders } from "@/lib/csrf";
import { saveDraft, deleteDraft, type MailDraft } from "./mail-local";
import {
  validateMailAttachments,
  decodedBase64Bytes,
  isAllowedMailAttachment,
  MAIL_ATTACH_MAX_COUNT,
  MAIL_ATTACH_MAX_TOTAL_BYTES,
} from "@/api/lib/mail-attachments";
import { Mail, Send, Loader2, X, Save, Paperclip } from "lucide-react";

// One picked file held in memory for the compose POST. contentBase64 is the
// RAW base64 (the `data:...;base64,` prefix is stripped on read) so it maps
// 1:1 onto the backend EmailAttachment shape.
type ComposeAttachment = {
  name: string;
  type: string;
  size: number; // decoded byte count (for the chip label + total cap)
  contentBase64: string;
};

// Human-readable file size for the chip label.
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type MailAddress = {
  id: string;
  address: string;
  label: string;
  active: boolean;
};

// Conservative single-@ shape check — mirrors the backend's EMAIL_RE so the
// inline error matches what the server would reject. Not RFC-5322-complete on
// purpose; we only block obvious garbage.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ComposeResponse = {
  ok?: boolean;
  threadId?: string;
  messageId?: string;
  error?: string;
};

export type ComposeDialogProps = {
  open: boolean;
  onClose: () => void;
  // Fired after a successful send (201) so the parent can refresh its list.
  // The dialog already invalidates the threads cache + navigates on its own;
  // this is an extra hook for the embedder if it wants one.
  onSent?: (threadId: string) => void;
  // When resuming a saved draft (from the Drafts folder) the parent passes it
  // here so the form opens pre-filled. Drafts are local-only (mail-local.ts).
  initialDraft?: MailDraft | null;
};

export function ComposeDialog({
  open,
  onClose,
  onSent,
  initialDraft = null,
}: ComposeDialogProps) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: addresses } = useCachedJson<MailAddress[]>(
    "/api/mail-center/addresses",
    300,
  );

  const activeAddresses = useMemo(
    () => (addresses ?? []).filter((a) => a.active),
    [addresses],
  );

  // Explicit From override the operator picked (empty = follow the default).
  // The effective From is DERIVED below as override || first active mailbox, so
  // we never need an effect to seed it (which trips react-hooks/set-state).
  const [fromOverride, setFromOverride] = useState("");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [touchedTo, setTouchedTo] = useState(false);
  const [sending, setSending] = useState(false);
  // Picked attachments (held in memory only — NOT persisted to a local draft).
  const [files, setFiles] = useState<ComposeAttachment[]>([]);
  // Inline attachment error (count / size / type), mirrors the backend reject.
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Id of the local draft being edited, if this dialog was opened by resuming a
  // draft (so Send / re-save can clear or update the right one).
  const [draftId, setDraftId] = useState<string | null>(null);

  // Reset the form each time the dialog is freshly opened. The From override is
  // intentionally preserved across opens (operator's last chosen mailbox). When
  // opened to resume a draft, seed the fields (and the From) from it instead.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setTo(initialDraft?.to ?? "");
      setSubject(initialDraft?.subject ?? "");
      setBody(initialDraft?.body ?? "");
      setDraftId(initialDraft?.id ?? null);
      setTouchedTo(false);
      setSending(false);
      // Attachments are never persisted in a draft (see mail-local.ts note),
      // so a freshly-opened dialog — even one resuming a draft — starts empty.
      setFiles([]);
      setAttachError(null);
    }
    wasOpen.current = open;
  }, [open, initialDraft]);

  if (!open) return null;

  const noMailbox = activeAddresses.length === 0;
  const onlyOneMailbox = activeAddresses.length === 1;
  // Effective From, derived (no state sync needed): the operator's explicit
  // pick wins; otherwise, when resuming a draft, the draft's saved sender; then
  // the first active mailbox. Each candidate must still be a valid active
  // address to be honoured.
  const draftFrom =
    draftId && initialDraft?.id === draftId ? initialDraft.fromAddress : "";
  const fromAddress =
    (fromOverride &&
      activeAddresses.some((a) => a.address === fromOverride) &&
      fromOverride) ||
    (draftFrom &&
      activeAddresses.some((a) => a.address === draftFrom) &&
      draftFrom) ||
    activeAddresses[0]?.address ||
    "";
  const toValid = EMAIL_RE.test(to.trim());
  const toError = touchedTo && to.trim().length > 0 && !toValid;
  const canSend =
    !sending &&
    !noMailbox &&
    !!fromAddress &&
    toValid &&
    subject.trim().length > 0 &&
    body.trim().length > 0;
  // A draft is worth saving once it has any content — no validation gate.
  const canSaveDraft =
    !sending &&
    !noMailbox &&
    (to.trim().length > 0 ||
      subject.trim().length > 0 ||
      body.trim().length > 0);

  // Save the current form as a LOCAL draft (no backend draft store — see
  // mail-local.ts). Reuses the existing draft id when resuming one.
  function handleSaveDraft() {
    if (!canSaveDraft) return;
    const id = draftId ?? crypto.randomUUID();
    saveDraft({
      id,
      to: to.trim(),
      subject: subject.trim(),
      body,
      fromAddress,
      updatedAt: Date.now(),
    });
    toast.success("Draft saved.");
    onClose();
  }

  // Read one file → raw base64 (strip the `data:<mime>;base64,` prefix). The
  // FileReader result is a data URL; everything after the first comma is the
  // base64 payload the backend expects in EmailAttachment.contentBase64.
  function readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.readAsDataURL(file);
    });
  }

  async function handlePickFiles(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    // Allow re-picking the same file later (clear the input value).
    e.target.value = "";
    if (picked.length === 0) return;
    setAttachError(null);

    // Per-file type gate (mirrors isAllowedMailAttachment on the backend) — do
    // it before the read so an obviously-wrong file never gets decoded.
    const rejected = picked.filter((f) => !isAllowedMailAttachment(f.name));
    if (rejected.length > 0) {
      setAttachError(
        `"${rejected[0].name}" is not an allowed type. Only images and PDF files can be attached.`,
      );
      return;
    }

    // Pre-check RAW file sizes (File.size, synchronous, zero read cost) BEFORE
    // decoding, so an oversized file never gets fully read into memory first —
    // FileReader.readAsDataURL on a huge phone photo / video can hang or crash a
    // low-RAM tab. f.size is the raw byte count ≈ the decoded bytes the cap is
    // enforced on, so this is the same 5 MB ceiling, just applied earlier.
    const existingBytes = files.reduce((sum, f) => sum + f.size, 0);
    const pickedRawBytes = picked.reduce((sum, f) => sum + f.size, 0);
    if (existingBytes + pickedRawBytes > MAIL_ATTACH_MAX_TOTAL_BYTES) {
      setAttachError(
        `Attachments exceed the ${humanSize(MAIL_ATTACH_MAX_TOTAL_BYTES)} limit.`,
      );
      return;
    }

    let read: ComposeAttachment[];
    try {
      read = await Promise.all(
        picked.map(async (f) => {
          const contentBase64 = await readFileAsBase64(f);
          return {
            name: f.name,
            type: f.type,
            // Trust the decoded base64 length, not f.size — that's the number
            // the cap is enforced on (server-side too).
            size: decodedBase64Bytes(contentBase64),
            contentBase64,
          };
        }),
      );
    } catch {
      setAttachError("Could not read one of the files. Please try again.");
      return;
    }

    const next = [...files, ...read];
    // Validate the COMBINED batch with the SAME helper the backend uses, so the
    // operator is rejected here with the identical 5 MB / 10-file / type rule.
    const check = validateMailAttachments(
      next.map((f) => ({ filename: f.name, contentBase64: f.contentBase64 })),
    );
    if (!check.ok) {
      setAttachError(check.error ?? "Invalid attachments.");
      return; // keep the previous selection; don't apply the over-cap batch
    }
    setFiles(next);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setAttachError(null);
  }

  const totalAttachBytes = files.reduce((sum, f) => sum + f.size, 0);

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    try {
      const res = await fetch("/api/mail-center/compose", {
        method: "POST",
        headers: csrfHeaders(),
        credentials: "include",
        body: JSON.stringify({
          fromAddress,
          to: to.trim(),
          subject: subject.trim(),
          text: body,
          ...(files.length > 0
            ? {
                attachments: files.map((f) => ({
                  filename: f.name,
                  contentBase64: f.contentBase64,
                })),
              }
            : {}),
        }),
      });
      let payload: ComposeResponse = {};
      try {
        payload = (await res.json()) as ComposeResponse;
      } catch {
        /* non-JSON body — fall back to a generic message below */
      }
      if (!res.ok || !payload.ok) {
        toast.error(payload.error || "Failed to send email. Please try again.");
        return;
      }
      toast.success("Email sent.");
      // If this came from a saved draft, drop it now that it's been sent.
      if (draftId) deleteDraft(draftId);
      invalidateCachePrefix("/api/mail-center/threads");
      onClose();
      if (payload.threadId) {
        onSent?.(payload.threadId);
        navigate(`/mail-center/${payload.threadId}`);
      }
    } catch {
      toast.error("Failed to send email. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      {/* Backdrop click = close (only while idle, so a send isn't dropped). */}
      <div
        className="fixed inset-0 bg-black/40"
        onClick={() => {
          if (!sending) onClose();
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Compose new email"
        className="relative mx-4 flex max-h-[90vh] w-full max-w-lg flex-col rounded-lg border border-[#E2DDD8] bg-white shadow-xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-[#E2DDD8] px-4 py-3">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-amber-700" />
            <h3 className="text-sm font-semibold text-[#1F1D1B]">New email</h3>
          </div>
          <button
            onClick={() => {
              if (!sending) onClose();
            }}
            aria-label="Close"
            className="rounded-md p-1 text-[#6B7280] transition hover:bg-[#F0ECE9] disabled:opacity-50"
            disabled={sending}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {noMailbox ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              You have no @hookka.com mailbox assigned, so there is no address to
              send from. Ask an admin to assign one in User Management.
            </div>
          ) : (
            <>
              {/* From */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-[#6B7280]">From</label>
                {onlyOneMailbox ? (
                  <div className="flex h-9 items-center rounded-md border border-[#E2DDD8] bg-[#FAF9F7] px-3 text-sm text-[#1F1D1B]">
                    {activeAddresses[0].label
                      ? `${activeAddresses[0].label} · ${activeAddresses[0].address}`
                      : activeAddresses[0].address}
                  </div>
                ) : (
                  <select
                    value={fromAddress}
                    onChange={(e) => setFromOverride(e.target.value)}
                    disabled={sending}
                    className="h-9 w-full rounded-md border border-[#E2DDD8] bg-white px-3 text-sm text-[#1F1D1B] focus:border-[#6B5C32] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {activeAddresses.map((a) => (
                      <option key={a.id} value={a.address}>
                        {a.label ? `${a.label} · ${a.address}` : a.address}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* To */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-[#6B7280]">To</label>
                <Input
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  onBlur={() => setTouchedTo(true)}
                  placeholder="customer@example.com"
                  disabled={sending}
                  aria-invalid={toError}
                  className={toError ? "border-red-400 focus-visible:ring-red-400" : ""}
                />
                {toError && (
                  <p className="text-[11px] text-red-600">
                    Enter a valid email address.
                  </p>
                )}
              </div>

              {/* Subject */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-[#6B7280]">
                  Subject
                </label>
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Subject"
                  disabled={sending}
                />
              </div>

              {/* Body — styled identically to the reply composer in detail.tsx */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-[#6B7280]">
                  Message
                </label>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={8}
                  placeholder="Write your message…"
                  disabled={sending}
                  className="w-full resize-y rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm leading-relaxed focus:border-[#6B5C32] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </div>

              {/* Attachments — removable chips. Images + PDF only, ≤10 files,
                  ≤5 MB total (mirrors the backend cap in mail-attachments.ts). */}
              {files.length > 0 && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-[#6B7280]">
                    Attachments ({files.length}/{MAIL_ATTACH_MAX_COUNT} ·{" "}
                    {humanSize(totalAttachBytes)} of{" "}
                    {humanSize(MAIL_ATTACH_MAX_TOTAL_BYTES)})
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {files.map((f, i) => (
                      <span
                        key={`${f.name}-${i}`}
                        className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-[#E2DDD8] bg-[#FAF9F7] py-1 pl-2 pr-1 text-xs text-[#1F1D1B]"
                      >
                        <Paperclip className="h-3 w-3 shrink-0 text-[#6B7280]" />
                        <span className="truncate">{f.name}</span>
                        <span className="shrink-0 text-[#6B7280]">
                          {humanSize(f.size)}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeFile(i)}
                          disabled={sending}
                          aria-label={`Remove ${f.name}`}
                          className="shrink-0 rounded p-0.5 text-[#6B7280] transition hover:bg-[#F0ECE9] hover:text-[#1F1D1B] disabled:opacity-50"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {attachError && (
                <p className="text-[11px] text-red-600">{attachError}</p>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-[#E2DDD8] bg-[#FAF9F7] px-4 py-3">
          <p className="text-[11px] text-[#6B7280]">
            {noMailbox
              ? ""
              : `Sent via Brevo from ${fromAddress || "your mailbox"}.`}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (!sending) onClose();
              }}
              disabled={sending}
            >
              Cancel
            </Button>
            {!noMailbox && (
              <>
                {/* Hidden picker driven by the Attach button. Images + PDF only;
                    `multiple` so several can be added in one go. */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,application/pdf"
                  multiple
                  className="hidden"
                  onChange={handlePickFiles}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={sending}
                  onClick={() => fileInputRef.current?.click()}
                  title="Attach images or PDF files (max 10 files, 5 MB total)"
                >
                  <Paperclip className="h-4 w-4" />
                  Attach
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={!canSaveDraft}
                  onClick={handleSaveDraft}
                  title="Save this email as a local draft"
                >
                  <Save className="h-4 w-4" />
                  Save draft
                </Button>
              </>
            )}
            <Button
              variant="primary"
              size="sm"
              className="gap-1.5 bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
              disabled={!canSend}
              onClick={handleSend}
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Thin default export — Compose is only ever a modal over the inbox, but a
// lazy import path that lands here should still render something coherent
// rather than throw. It mounts the dialog open and routes back to the inbox
// on close.
export default function ComposePage() {
  const navigate = useNavigate();
  return <ComposeDialog open onClose={() => navigate("/mail-center")} />;
}
