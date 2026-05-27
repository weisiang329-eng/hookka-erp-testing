// ---------------------------------------------------------------------------
// /forgot-password — public page. User enters email, server emails a
// one-hour reset link if the account exists. Always shows the same
// "if account exists, link sent" message to mitigate account enumeration.
//
// Companion to /reset-password — see src/pages/reset-password.tsx.
// Backend: POST /api/auth/forgot-password (src/api/routes/auth.ts).
// ---------------------------------------------------------------------------
import { useState } from "react";
import { useNavigate } from "react-router-dom";

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      // The endpoint always returns 200 (anti-enumeration). Only show
      // an error if the network actually failed.
      if (!res.ok) {
        setErrorMsg("Could not reach the server. Try again in a moment.");
      } else {
        setSubmitted(true);
      }
    } catch {
      setErrorMsg("Network error. Try again in a moment.");
    } finally {
      setSubmitting(false);
    }
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
            Forgot password
          </h1>
          <p style={{ color: "rgba(255,255,255,.5)", fontSize: "13px" }}>
            Enter the email you log in with. We'll send a reset link if the
            account exists.
          </p>
        </div>

        {submitted ? (
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
              Check your email
            </p>
            <p>
              If an account with <strong>{email}</strong> exists, we've sent a
              reset link there. The link expires in 1 hour.
            </p>
            <p className="mt-2" style={{ color: "rgba(255,255,255,.55)" }}>
              Didn't get it? Check spam, or try again in 5 minutes.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="block mb-1.5 uppercase tracking-wider"
                style={{
                  color: "rgba(255,255,255,.55)",
                  fontSize: "11px",
                  fontWeight: 500,
                }}
              >
                Email address
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                placeholder="you@hookka.com"
                disabled={submitting}
                className="w-full px-3 py-2.5 rounded-md"
                style={{
                  background: "rgba(20, 18, 15, 0.6)",
                  border: "1px solid rgba(139, 122, 78, 0.35)",
                  color: "#F4EFE3",
                  fontSize: "14px",
                }}
              />
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
              disabled={submitting || !email}
              className="w-full py-2.5 rounded-md transition-opacity"
              style={{
                background:
                  "linear-gradient(180deg, #A38444 0%, #8B6F32 100%)",
                color: "#1F1D1B",
                fontSize: "14px",
                fontWeight: 600,
                opacity: submitting || !email ? 0.5 : 1,
                cursor: submitting || !email ? "not-allowed" : "pointer",
                border: "none",
              }}
            >
              {submitting ? "Sending…" : "Send reset link"}
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
