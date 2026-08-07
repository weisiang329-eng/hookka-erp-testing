// Public CUSTOMER SATISFACTION SURVEY — opened by a customer from a link the
// office sent them (/s/<token>).
//
// Owner 2026-08-07: "这些是发顾客一个类似 google form submit 选择的，直接评分."
// So this is deliberately a Google-Form-shaped page and nothing more: no
// dashboard chrome, no worker-portal chrome, NO LOGIN. The unguessable 64-hex
// token in the URL is the whole credential, and the backend
// (/api/public/survey) only ever does the two things this page needs — hand
// back the five questions and the five named ratings, and accept one reply.
//
// Everything on screen comes from the server, which reads it out of the code
// catalogue (src/api/lib/kpi-catalog.ts). Nothing about the questions or the
// scale is written twice: change the catalogue and this page changes with it.
//
// The link is SINGLE USE and expires. A spent or expired link shows a plain
// sentence — a customer must never meet an error trace.

import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, MessageSquareHeart, Send } from "lucide-react";
import { csrfHeaders } from "@/lib/csrf";

// ── Backend shape (API contract — see routes/public-kpi-survey.ts) ─────────
type SurveyForm = {
  /** The five questions, in order. */
  questions: string[];
  /** What 1–5 MEAN. Index 0 is a 1 ("Poor"); index 4 is a 5 ("Excellent"). */
  scale: string[];
};

/**
 * Split "Excellent — I could not ask for better" into its name and its
 * explanation so the button can lead with the word and keep the sentence as
 * quiet supporting text. A rung with no dash is shown whole.
 */
function splitRung(label: string): { name: string; hint: string } {
  const i = label.indexOf("—");
  if (i < 0) return { name: label.trim(), hint: "" };
  return { name: label.slice(0, i).trim(), hint: label.slice(i + 1).trim() };
}

export default function SurveyPage() {
  const { token } = useParams();

  // ── The form (mount fetch) ───────────────────────────────────────────────
  const [form, setForm] = useState<SurveyForm | null>(null);
  const [loading, setLoading] = useState(true);
  // A dead link is not an error to apologise for — it is a plain sentence.
  const [closedMsg, setClosedMsg] = useState<string | null>(null);

  // ── Answers: one 1-5 rating per question, null until chosen ──────────────
  const [answers, setAnswers] = useState<Array<number | null>>([
    null, null, null, null, null,
  ]);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`/api/public/survey/${encodeURIComponent(token)}`, {
        cache: "no-store",
      });
      const j = (await r.json().catch(() => ({}))) as {
        success?: boolean;
        data?: SurveyForm;
        error?: string;
      };
      if (!r.ok || !j.success || !j.data) {
        setForm(null);
        setClosedMsg(
          j.error ||
            "This feedback link is not valid. Please ask your Hookka contact to send a new one.",
        );
      } else {
        setClosedMsg(null);
        setForm(j.data);
      }
    } catch {
      setForm(null);
      setClosedMsg(
        "We could not open the form. Please check your connection and try again.",
      );
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount (public page, no session deps); same pattern as sticker-rack.tsx / do-scan.tsx
    void load();
  }, [load]);

  const allAnswered = answers.every((a) => a !== null);

  const handleSubmit = useCallback(async () => {
    if (!token || sending || !allAnswered) return;
    setSending(true);
    setSendError(null);
    try {
      const r = await fetch(`/api/public/survey/${encodeURIComponent(token)}`, {
        method: "POST",
        // csrfHeaders: a cookieless customer sends no CSRF header (silently
        // omitted); a logged-in staff phone carries the session cookie and the
        // backend then requires the echo — include it so both paths work.
        headers: csrfHeaders(),
        body: JSON.stringify({ answers, comment: comment.trim() || undefined }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
      };
      if (!r.ok || !j.success) {
        // 410 = the link was already used or has expired. That is not a
        // failure the customer can fix by retrying, so retire the form and
        // show the sentence instead of an error under a live Send button.
        if (r.status === 410 || r.status === 404) {
          setForm(null);
          setClosedMsg(j.error || "This feedback link is no longer open.");
          return;
        }
        setSendError(j.error || "Could not send your answers. Please try again.");
        return;
      }
      setDone(true);
    } catch {
      setSendError(
        "We could not send your answers. Please check your connection and try again.",
      );
    } finally {
      setSending(false);
    }
  }, [token, sending, allAnswered, answers, comment]);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#F0ECE9]">
      {/* Header — mirrors the other public phone pages' dark bar. */}
      <header className="bg-[#1F1D1B] text-white">
        <div className="max-w-xl mx-auto px-4 py-5 flex items-center gap-3">
          <div className="h-9 w-9 rounded bg-[#6B5C32] flex items-center justify-center">
            <MessageSquareHeart className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight">Customer Feedback</h1>
            <p className="text-xs text-gray-400">HOOKKA INDUSTRIES</p>
          </div>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-4 py-6 space-y-4 pb-16">
        {loading && (
          <div className="rounded-xl bg-white p-8 text-center shadow-sm border border-[#E6E0D9]">
            <div className="h-8 w-8 mx-auto rounded-full border-4 border-[#6B5C32] border-t-transparent animate-spin" />
            <p className="mt-3 text-sm text-gray-500">Opening the form...</p>
          </div>
        )}

        {/* Sent. The whole page becomes the thank-you — there is nothing left
            to do, and the link will not open again. */}
        {done && (
          <div className="rounded-xl bg-[#4F7C3A] text-white p-8 text-center shadow-sm">
            <CheckCircle2 className="h-14 w-14 mx-auto" strokeWidth={2.5} />
            <p className="text-xl font-bold mt-3">Thank you</p>
            <p className="text-sm opacity-90 mt-2">
              Your answers have been sent to Hookka Industries. This link is now
              closed — you do not need to do anything else.
            </p>
          </div>
        )}

        {!loading && !done && closedMsg && (
          <div className="rounded-xl bg-white p-6 shadow-sm border border-[#E6E0D9]">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-6 w-6 text-[#9C6F1E] shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-[#1F1D1B]">
                  This form is not open
                </p>
                <p className="text-sm text-gray-600 mt-1">{closedMsg}</p>
              </div>
            </div>
          </div>
        )}

        {!loading && !done && form && (
          <>
            <div className="rounded-xl bg-white p-5 shadow-sm border border-[#E6E0D9]">
              <p className="text-base font-bold text-[#1F1D1B]">
                How are we doing?
              </p>
              <p className="text-sm text-gray-600 mt-1.5">
                Five questions, about a minute. Your answers go straight to the
                Hookka office and are used to score the team that looks after
                you. Please answer honestly — an "Acceptable" is far more useful
                to us than a polite "Excellent".
              </p>
            </div>

            {form.questions.map((q, qi) => (
              <fieldset
                key={qi}
                className="rounded-xl bg-white p-4 shadow-sm border border-[#E6E0D9]"
              >
                <legend className="sr-only">{`Question ${qi + 1}`}</legend>
                <p className="text-sm font-bold text-[#1F1D1B] leading-snug">
                  <span className="text-[#9C6F1E]">{qi + 1}.</span> {q}
                </p>
                <div className="mt-3 space-y-2">
                  {/* Best rung first — the scale is stored 1..5, so walk it
                      backwards for display without touching the values. */}
                  {form.scale
                    .map((label, i) => ({ label, value: i + 1 }))
                    .reverse()
                    .map(({ label, value }) => {
                      const { name, hint } = splitRung(label);
                      const chosen = answers[qi] === value;
                      return (
                        <label
                          key={value}
                          className={`flex items-start gap-3 rounded-xl border px-3 py-3 cursor-pointer ${
                            chosen
                              ? "border-[#6B5C32] bg-[#F6F2EC]"
                              : "border-[#E6E0D9] bg-white"
                          }`}
                        >
                          <input
                            type="radio"
                            name={`q${qi}`}
                            value={value}
                            checked={chosen}
                            onChange={() => {
                              setAnswers((prev) => {
                                const next = [...prev];
                                next[qi] = value;
                                return next;
                              });
                              setSendError(null);
                            }}
                            className="mt-1 h-4 w-4 accent-[#6B5C32]"
                          />
                          <span className="min-w-0">
                            <span className="block text-sm font-semibold text-[#1F1D1B]">
                              {name}
                            </span>
                            {hint && (
                              <span className="block text-xs text-gray-500 mt-0.5">
                                {hint}
                              </span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                </div>
              </fieldset>
            ))}

            <div className="rounded-xl bg-white p-4 shadow-sm border border-[#E6E0D9]">
              <label
                htmlFor="survey-comment"
                className="block text-sm font-bold text-[#1F1D1B]"
              >
                Anything else you want us to know? (optional)
              </label>
              <textarea
                id="survey-comment"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={4}
                maxLength={2000}
                className="mt-2 w-full rounded-xl border border-[#E6E0D9] bg-white px-3 py-2.5 text-base text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                placeholder="A specific example helps us more than anything else."
              />
            </div>

            {sendError && (
              <p className="text-sm text-[#9A3A2D] px-1">{sendError}</p>
            )}

            <button
              type="button"
              disabled={!allAnswered || sending}
              onClick={() => void handleSubmit()}
              className="w-full rounded-xl bg-[#9C6F1E] active:bg-[#835D19] text-white py-4 text-lg font-bold shadow-sm flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {sending ? (
                <span className="h-5 w-5 rounded-full border-2 border-current border-t-transparent animate-spin" />
              ) : (
                <Send className="h-5 w-5" />
              )}
              {sending ? "Sending..." : "Send my answers"}
            </button>
            {!allAnswered && (
              <p className="text-xs text-center text-gray-500">
                Please answer all five questions.
              </p>
            )}
            <p className="text-[10px] text-center text-gray-400">
              You can send this form once. Hookka Industries Sdn Bhd.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
