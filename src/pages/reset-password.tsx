// ---------------------------------------------------------------------------
// /reset-password?token=xxx — public page reached via the email link.
//
// User pastes / lands here, types new password twice, submits. Server
// validates the token (exists, unused, not expired), hashes the new
// password, marks token consumed, and we redirect to /login. We do NOT
// auto-login — see src/api/routes/auth.ts forgot-password section for
// the rationale (stolen-link defense).
//
// Backend: POST /api/auth/reset-password { token, newPassword }.
// ---------------------------------------------------------------------------
import { useState, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // token comes from the email link query string.
  const token = useMemo(() => searchParams.get("token") ?? "", [searchParams]);

  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const mismatch = pw && pw2 && pw !== pw2;
  const tooShort = pw && pw.length < 6;

  async function handleSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (mismatch || tooShort || !pw) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: pw }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
      };
      if (!res.ok || !json.success) {
        setErrorMsg(json.error || "Reset failed. The link may be expired.");
      } else {
        setSuccess(true);
      }
    } catch {
      setErrorMsg("Network error. Try again in a moment.");
    } finally {
      setSubmitting(false);
    }
  }

  // No token in URL = unhelpful state. Send them back.
  if (!token) {
    return (
      <div
        className="min-h-screen flex items-center justify-center px-4"
        style={{ background: "#0F0E0C" }}
      >
        <div
          className="w-full max-w-md rounded-lg p-8 text-center"
          style={{
            background: "rgba(35, 32, 27, 0.85)",
            border: "1px solid rgba(139, 122, 78, 0.2)",
            color: "rgba(255,255,255,.75)",
          }}
        >
          <p className="mb-4">
            This reset link is missing the token. Please use the link from your
            email, or request a new one.
          </p>
          <button
            type="button"
            onClick={() => navigate("/forgot-password")}
            className="px-4 py-2 rounded-md hover:underline"
            style={{
              background: "rgba(139, 122, 78, 0.2)",
              color: "#C9B97E",
              border: "1px solid rgba(139, 122, 78, 0.4)",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            Request a new link
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "#0F0E0C" }}
    >
      <div
        className="w-full max-w-md rounded-lg p-8"
        style={{
          background: "rgba(35, 32, 27, 0.85)",
          border: "1px solid rgba(139, 122, 78, 0.2)",
        }}
      >
        <div className="mb-6">
          <h1
            className="text-2xl font-semibold mb-2"
            style={{ color: "#F4EFE3" }}
          >
            Set a new password
          </h1>
          <p style={{ color: "rgba(255,255,255,.5)", fontSize: "13px" }}>
            Choose something you'll remember — at least 6 characters.
          </p>
        </div>

        {success ? (
          <div
            className="rounded-md p-4 mb-6"
            style={{
              background: "rgba(75, 124, 58, 0.15)",
              border: "1px solid rgba(75, 124, 58, 0.4)",
              color: "rgba(255,255,255,.85)",
              fontSize: "13.5px",
              lineHeight: 1.55,
            }}
          >
            <p className="font-medium mb-1" style={{ color: "#A4D08E" }}>
              Password updated
            </p>
            <p>You can now sign in with your new password.</p>
            <button
              type="button"
              onClick={() => navigate("/login")}
              className="mt-3 w-full py-2.5 rounded-md"
              style={{
                background:
                  "linear-gradient(180deg, #A38444 0%, #8B6F32 100%)",
                color: "#1F1D1B",
                fontSize: "14px",
                fontWeight: 600,
                border: "none",
                cursor: "pointer",
              }}
            >
              Go to sign in
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="pw1"
                className="block mb-1.5 uppercase tracking-wider"
                style={{
                  color: "rgba(255,255,255,.55)",
                  fontSize: "11px",
                  fontWeight: 500,
                }}
              >
                New password
              </label>
              <input
                id="pw1"
                type="password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                required
                autoFocus
                disabled={submitting}
                className="w-full px-3 py-2.5 rounded-md"
                style={{
                  background: "rgba(20, 18, 15, 0.6)",
                  border: "1px solid rgba(139, 122, 78, 0.35)",
                  color: "#F4EFE3",
                  fontSize: "14px",
                }}
              />
              {tooShort && (
                <p
                  className="mt-1.5"
                  style={{ color: "#E8AFA4", fontSize: "12px" }}
                >
                  At least 6 characters.
                </p>
              )}
            </div>
            <div>
              <label
                htmlFor="pw2"
                className="block mb-1.5 uppercase tracking-wider"
                style={{
                  color: "rgba(255,255,255,.55)",
                  fontSize: "11px",
                  fontWeight: 500,
                }}
              >
                Confirm new password
              </label>
              <input
                id="pw2"
                type="password"
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
                required
                disabled={submitting}
                className="w-full px-3 py-2.5 rounded-md"
                style={{
                  background: "rgba(20, 18, 15, 0.6)",
                  border: `1px solid ${mismatch ? "rgba(154, 58, 45, 0.6)" : "rgba(139, 122, 78, 0.35)"}`,
                  color: "#F4EFE3",
                  fontSize: "14px",
                }}
              />
              {mismatch && (
                <p
                  className="mt-1.5"
                  style={{ color: "#E8AFA4", fontSize: "12px" }}
                >
                  Passwords don't match.
                </p>
              )}
            </div>

            {errorMsg && (
              <div
                className="rounded-md px-3 py-2.5"
                style={{
                  background: "rgba(154, 58, 45, 0.15)",
                  border: "1px solid rgba(154, 58, 45, 0.4)",
                  color: "#E8AFA4",
                  fontSize: "13px",
                }}
              >
                {errorMsg}
              </div>
            )}

            <button
              type="submit"
              disabled={
                submitting || !pw || !pw2 || !!mismatch || !!tooShort
              }
              className="w-full py-2.5 rounded-md"
              style={{
                background:
                  "linear-gradient(180deg, #A38444 0%, #8B6F32 100%)",
                color: "#1F1D1B",
                fontSize: "14px",
                fontWeight: 600,
                opacity:
                  submitting || !pw || !pw2 || mismatch || tooShort ? 0.5 : 1,
                cursor:
                  submitting || !pw || !pw2 || mismatch || tooShort
                    ? "not-allowed"
                    : "pointer",
                border: "none",
              }}
            >
              {submitting ? "Saving…" : "Set password"}
            </button>
          </form>
        )}

        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={() => navigate("/login")}
            className="hover:underline bg-transparent border-0 p-0"
            style={{ color: "#8B7A4E", fontSize: "13px", cursor: "pointer" }}
          >
            ← Back to sign in
          </button>
        </div>
      </div>
    </div>
  );
}
