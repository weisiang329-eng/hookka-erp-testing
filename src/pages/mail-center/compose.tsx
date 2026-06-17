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
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { csrfHeaders } from "@/lib/csrf";
import { Mail, Send, Loader2, X } from "lucide-react";

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
};

export function ComposeDialog({ open, onClose, onSent }: ComposeDialogProps) {
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

  // Reset the form each time the dialog is freshly opened. The From override is
  // intentionally preserved across opens (operator's last chosen mailbox).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setTo("");
      setSubject("");
      setBody("");
      setTouchedTo(false);
      setSending(false);
    }
    wasOpen.current = open;
  }, [open]);

  if (!open) return null;

  const noMailbox = activeAddresses.length === 0;
  const onlyOneMailbox = activeAddresses.length === 1;
  // Effective From: explicit pick if it's still a valid active address, else the
  // first active mailbox. Derived — no state sync needed.
  const fromAddress =
    (fromOverride &&
      activeAddresses.some((a) => a.address === fromOverride) &&
      fromOverride) ||
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
