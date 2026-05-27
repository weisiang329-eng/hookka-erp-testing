// ---------------------------------------------------------------------------
// /setup-2fa — protected page (RequireAuth gates the dashboard layout).
//
// Two-step flow:
//   Step 1 — POST /api/auth/totp/setup-start, render the returned QR code,
//             show the base32 secret for manual entry, ask the user to scan.
//   Step 2 — User types the 6-digit code their authenticator shows. We POST
//             /api/auth/totp/setup-confirm. On success, navigate to
//             /dashboard. On failure, surface the "Wrong code, try again"
//             error inline and let them retry.
//
// "Skip for now" — calls /api/auth/totp/dismiss-prompt (writes an audit row
// so the login flow knows not to re-prompt for 24h) and navigates to
// /dashboard. The Skip button is hidden when navigated to via
// location.state.severity === "hard" (the FE only sends hard severity for
// newly-minted super admins per the soft-enforcement policy).
//
// Recovery codes are deferred to a future enhancement — the spec says ship
// without them now, prompt user to use /api/auth/totp/disable + /enroll later
// if they want recovery codes.
// ---------------------------------------------------------------------------
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

type StartResponse =
  | {
      success: true;
      secret: string;
      otpauthUrl: string;
      qrCodeUrl: string;
    }
  | { success: false; error?: string };

type ConfirmResponse =
  | { success: true; enabledAt: string }
  | { success: false; error?: string };

export default function Setup2FAPage() {
  const navigate = useNavigate();
  const location = useLocation();

  // Severity passed from login.tsx via navigate state. "hard" hides the Skip
  // link so newly-minted super admins can't bypass setup. Default "soft" for
  // direct navigation (e.g. user clicks "Set up 2FA" from a banner later).
  const severity =
    (location.state as { severity?: "soft" | "info" | "hard" } | null)
      ?.severity ?? "soft";

  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);

  // Step 1: kick off setup as soon as the page mounts. We fire-and-forget
  // the request — if it fails the user sees the error and can refresh.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/totp/setup-start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({}),
        });
        const json = (await res.json()) as StartResponse;
        if (cancelled) return;
        if (!res.ok || !json.success) {
          setLoadError(
            ("error" in json && json.error) ||
              "Could not start setup. Refresh the page to try again.",
          );
          return;
        }
        setQrUrl(json.qrCodeUrl);
        setSecret(json.secret);
      } catch {
        if (!cancelled) {
          setLoadError("Network error. Refresh the page to try again.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Step 2: user types the 6-digit code; we verify and on success bounce
  // to /dashboard. The api-client adds the CSRF header automatically for
  // POSTs (read from the hookka_csrf cookie set at login).
  async function handleConfirm(ev: React.FormEvent) {
    ev.preventDefault();
    setCodeError(null);
    const clean = code.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(clean)) {
      setCodeError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setConfirming(true);
    try {
      const res = await fetch("/api/auth/totp/setup-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ code: clean }),
      });
      const json = (await res.json()) as ConfirmResponse;
      if (!res.ok || !json.success) {
        setCodeError(
          ("error" in json && json.error) || "Wrong code, try again",
        );
        return;
      }
      navigate("/dashboard", { replace: true });
    } catch {
      setCodeError("Network error. Try again in a moment.");
    } finally {
      setConfirming(false);
    }
  }

  // Skip — calls dismiss-prompt and goes to the dashboard. The endpoint
  // writes an audit row "totp-dismissed" so the login flow gives the user
  // a 24h cool-off before re-prompting. Hidden when severity = "hard".
  async function handleSkip() {
    try {
      await fetch("/api/auth/totp/dismiss-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });
    } catch {
      // Best-effort — even if dismiss fails, take the user to the dashboard.
    }
    navigate("/dashboard", { replace: true });
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 py-12"
      style={{ background: "#0F0E0C" }}
    >
      <div
        className="w-full max-w-lg rounded-lg p-8"
        style={{
          background: "rgba(35, 32, 27, 0.85)",
          border: "1px solid rgba(139, 122, 78, 0.2)",
        }}
      >
        <h1
          className="text-2xl font-semibold mb-2"
          style={{ color: "#F4EFE3" }}
        >
          Add two-factor sign-in
        </h1>
        <p className="text-sm mb-6" style={{ color: "rgba(244,239,227,0.65)" }}>
          Scan the box below with Google Authenticator, 1Password, Authy, or
          any other authenticator app. Then type the 6-digit code it shows.
        </p>

        {loadError && (
          <div
            className="rounded p-3 mb-4 text-sm"
            style={{
              background: "rgba(220,38,38,0.12)",
              border: "1px solid rgba(220,38,38,0.35)",
              color: "#FCA5A5",
            }}
          >
            {loadError}
          </div>
        )}

        {qrUrl && (
          <div className="flex flex-col items-center mb-6">
            <img
              src={qrUrl}
              alt="Two-factor setup QR code"
              width={240}
              height={240}
              style={{
                background: "#fff",
                padding: 12,
                borderRadius: 8,
              }}
            />
            {secret && (
              <div
                className="mt-4 text-center"
                style={{ color: "rgba(244,239,227,0.6)" }}
              >
                <div className="text-xs mb-1">
                  Or type this into your app by hand:
                </div>
                <code
                  className="text-sm tracking-wider px-3 py-1 rounded select-all"
                  style={{
                    background: "rgba(244,239,227,0.06)",
                    color: "#F4EFE3",
                  }}
                >
                  {secret}
                </code>
              </div>
            )}
          </div>
        )}

        <form onSubmit={handleConfirm} className="space-y-4">
          <div>
            <label
              htmlFor="code"
              className="block text-sm mb-2"
              style={{ color: "rgba(244,239,227,0.75)" }}
            >
              6-digit code from your authenticator
            </label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full px-4 py-3 rounded text-lg tracking-[0.4em] text-center"
              style={{
                background: "rgba(244,239,227,0.06)",
                border: "1.5px solid rgba(139,122,78,0.35)",
                color: "#F4EFE3",
              }}
            />
          </div>

          {codeError && (
            <div
              className="rounded p-3 text-sm"
              style={{
                background: "rgba(220,38,38,0.12)",
                border: "1px solid rgba(220,38,38,0.35)",
                color: "#FCA5A5",
              }}
              role="alert"
            >
              {codeError}
            </div>
          )}

          <button
            type="submit"
            disabled={confirming || !qrUrl}
            className="w-full rounded font-semibold text-white py-3 transition-opacity hover:opacity-90 disabled:opacity-50"
            style={{
              background: "linear-gradient(135deg,#6B5C32,#8B7A4E)",
            }}
          >
            {confirming ? "Checking..." : "Turn on two-factor sign-in"}
          </button>

          {severity !== "hard" && (
            <button
              type="button"
              onClick={handleSkip}
              className="w-full text-sm bg-transparent border-0 cursor-pointer hover:underline"
              style={{ color: "rgba(244,239,227,0.55)" }}
            >
              Skip for now
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
