// ---------------------------------------------------------------------------
// Two-factor sign-in — step 2.
//
// Reached only from /login when POST /api/auth/login answered
// { success: true, totpRequired: true, userId, pendingToken } — i.e. the
// password verified but the account has TOTP enrolled (users.totpEnrolledAt
// is non-null and TOTP_LOGIN_ENFORCEMENT_ENABLED is on in auth.ts).
//
// This page posts { userId, code, pendingToken, rememberMe } to
// POST /api/auth/totp/login-verify, which is what actually issues the
// session cookie. The pendingToken is the server's proof that the password
// step passed — without it that endpoint is a password-free login
// (BUG-2026-08-13-101), so it must be carried through and never dropped.
//
// The code box accepts either a 6-digit TOTP code or one of the recovery
// codes issued at enrolment; the server decides which by shape, and burns a
// recovery code on use.
//
// Nothing is persisted here except the user blob via setAuth(), exactly as
// /login does — the session lives in the HttpOnly cookie the server sets.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { setAuth, type AuthUser } from "@/lib/auth";

type VerifyResponse =
  | { success: true; data: { user: AuthUser; csrfToken: string } }
  | { success: false; error?: string };

type HandoffState = {
  userId?: string;
  pendingToken?: string;
  rememberMe?: boolean;
};

export default function Verify2FAPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state ?? {}) as HandoffState;

  const [code, setCode] = useState("");
  // "totp" = 6-digit app code, "recovery" = one of the single-use codes issued
  // at enrolment. The server decides by shape, so this only changes what the
  // screen asks for — but a prompt that only mentions an authenticator is, to
  // someone who has lost their phone, a dead end with no visible way out.
  const [mode, setMode] = useState<"totp" | "recovery">("totp");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Arriving here directly (bookmark, refresh, back button) means there is no
  // userId and no pendingToken, so the verify call could never succeed. Send
  // the operator back to the password step rather than showing a form that is
  // guaranteed to fail.
  useEffect(() => {
    if (!state.userId) {
      navigate("/login", { replace: true });
      return;
    }
    inputRef.current?.focus();
  }, [state.userId, navigate]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) {
      setError(
        mode === "totp"
          ? "Enter the 6-digit code from your authenticator app."
          : "Enter one of your recovery codes.",
      );
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/totp/login-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          userId: state.userId,
          code: trimmed,
          pendingToken: state.pendingToken,
          rememberMe: state.rememberMe === true,
        }),
      });
      const json = (await res.json()) as VerifyResponse;

      if (!res.ok || !json.success) {
        setError(
          ("error" in json && json.error) ||
            "That code wasn't accepted. Please try again.",
        );
        setCode("");
        inputRef.current?.focus();
        return;
      }

      setAuth({ user: json.data.user, rememberMe: state.rememberMe === true });
      navigate("/dashboard", { replace: true });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Network error. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.screen}>
      <form style={styles.card} onSubmit={onSubmit}>
        <h1 style={styles.title}>Two-factor sign-in</h1>
        <p style={styles.sub}>
          {mode === "totp"
            ? "Enter the 6-digit code from your authenticator app."
            : "Enter one of the recovery codes you saved when you set up two-factor sign-in. Each code works once."}
        </p>

        <label style={styles.label} htmlFor="totp-code">
          {mode === "totp" ? "Authentication code" : "Recovery code"}
        </label>
        <input
          id="totp-code"
          ref={inputRef}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          // Not type="number": recovery codes are alphanumeric, and a number
          // input strips leading zeros from a code like "004821".
          inputMode={mode === "totp" ? "numeric" : "text"}
          autoComplete={mode === "totp" ? "one-time-code" : "off"}
          autoFocus
          disabled={loading}
          placeholder={mode === "totp" ? "000000" : "XXXX-XXXX"}
          style={
            mode === "totp"
              ? styles.input
              : { ...styles.input, letterSpacing: "0.12em", fontSize: 16 }
          }
        />

        {error ? <div style={styles.error}>{error}</div> : null}

        <button type="submit" style={styles.button} disabled={loading}>
          {loading ? "Verifying…" : "Verify"}
        </button>

        <button
          type="button"
          style={styles.link}
          onClick={() => {
            setMode(mode === "totp" ? "recovery" : "totp");
            setCode("");
            setError(null);
            inputRef.current?.focus();
          }}
          disabled={loading}
        >
          {mode === "totp"
            ? "Lost your phone? Use a recovery code"
            : "Use my authenticator app instead"}
        </button>

        {mode === "recovery" && (
          <p style={styles.help}>
            No recovery codes either? An administrator has to reset two-factor
            sign-in on your account before you can get back in.
          </p>
        )}

        <button
          type="button"
          style={styles.link}
          onClick={() => navigate("/login", { replace: true })}
          disabled={loading}
        >
          ← Back to sign in
        </button>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  screen: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#161412",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    background: "#211E1B",
    border: "1px solid #322D28",
    borderRadius: 14,
    padding: 32,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  title: {
    margin: 0,
    color: "#F5F1EA",
    fontSize: 28,
    fontWeight: 700,
    letterSpacing: "-0.01em",
  },
  sub: { margin: "0 0 8px", color: "#9A9288", fontSize: 14, lineHeight: 1.5 },
  label: {
    color: "#8C857C",
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  },
  input: {
    background: "#2A2622",
    border: "1px solid #3A342E",
    borderRadius: 10,
    color: "#F5F1EA",
    fontSize: 20,
    letterSpacing: "0.35em",
    padding: "14px 16px",
    outline: "none",
  },
  error: {
    background: "#3A1F1F",
    border: "1px solid #5C2C2C",
    borderRadius: 10,
    color: "#F0B4B4",
    fontSize: 14,
    lineHeight: 1.5,
    padding: "12px 14px",
  },
  button: {
    marginTop: 8,
    background: "#6B5C32",
    border: "none",
    borderRadius: 10,
    color: "#FFF8E7",
    cursor: "pointer",
    fontSize: 16,
    fontWeight: 600,
    padding: "14px 16px",
  },
  help: {
    color: "#8C857C",
    fontSize: 13,
    lineHeight: 1.5,
    margin: "4px 0 0",
    textAlign: "center",
  },
  link: {
    background: "none",
    border: "none",
    color: "#B9A76A",
    cursor: "pointer",
    fontSize: 14,
    padding: 4,
  },
};
