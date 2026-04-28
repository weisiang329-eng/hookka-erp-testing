// ---------------------------------------------------------------------------
// Public invite acceptance page — mounted at /invite/:token (NOT behind
// <RequireAuth>). Two phases:
//
//   1. GET /api/auth/invite/:token → show form prefilled from invite
//   2. POST /api/auth/accept-invite → setAuth() + redirect to /
//
// Matches the visual language of /login (same dark panel + orbit frame).
// ---------------------------------------------------------------------------
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { setAuth, type AuthUser } from "@/lib/auth";

type InviteMeta = {
  email: string;
  displayName: string;
  inviterName: string;
  expiresAt: string;
};

type InviteLookupResponse =
  | { success: true; data: InviteMeta }
  | { success: false; error?: string };

type AcceptResponse =
  | { success: true; data: { token: string; user: AuthUser } }
  | { success: false; error?: string };

export default function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<"loading" | "form" | "invalid">(
    "loading",
  );
  const [invite, setInvite] = useState<InviteMeta | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---------- Preflight lookup --------------------------------------------
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!token) {
        setPhase("invalid");
        return;
      }
      try {
        const res = await fetch(`/api/auth/invite/${encodeURIComponent(token)}`);
        const json = (await res.json()) as InviteLookupResponse;
        if (cancelled) return;
        if (!res.ok || !json.success) {
          setPhase("invalid");
          return;
        }
        setInvite(json.data);
        setDisplayName(json.data.displayName ?? "");
        setPhase("form");
      } catch {
        if (!cancelled) setPhase("invalid");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // ---------- Submit -------------------------------------------------------
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/accept-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          password,
          displayName: displayName.trim() || undefined,
        }),
      });
      const json = (await res.json()) as AcceptResponse;
      if (!res.ok || !json.success) {
        setError(
          ("error" in json && json.error) ||
            "Failed to accept invite. It may have expired.",
        );
        return;
      }
      setAuth(json.data);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setSubmitting(false);
    }
  };

  // ---------- Invalid / expired -------------------------------------------
  if (phase === "invalid") {
    return (
      <Shell>
        <h2 className="text-2xl font-bold text-white mb-1">Invite not found</h2>
        <p
          className="mb-8"
          style={{ color: "rgba(255,255,255,.45)", fontSize: "13px" }}
        >
          This invite link is invalid or has expired. Ask the admin who sent it
          to issue a fresh one.
        </p>
        <button
          type="button"
          onClick={() => navigate("/login")}
          className="w-full rounded-lg font-semibold text-white transition-all duration-200 hover:opacity-90"
          style={{
            background: "linear-gradient(135deg, #6B5C32, #8B7A4E)",
            padding: "14px",
            fontSize: "15px",
          }}
        >
          Go to login
        </button>
      </Shell>
    );
  }

  if (phase === "loading") {
    return (
      <Shell>
        <div className="text-center py-8">
          <p style={{ color: "rgba(255,255,255,.55)", fontSize: "13px" }}>
            Checking your invite…
          </p>
        </div>
      </Shell>
    );
  }

  // ---------- Form --------------------------------------------------------
  return (
    <Shell>
      <h2 className="text-2xl font-bold text-white mb-1">Accept your invite</h2>
      <p
        className="mb-8"
        style={{ color: "rgba(255,255,255,.45)", fontSize: "13px" }}
      >
        {invite?.inviterName
          ? `${invite.inviterName} invited you. `
          : "You've been invited. "}
        Set a password to finish onboarding.
      </p>

      <form onSubmit={handleSubmit} className="space-y-5">
        <Field label="Email">
          <ReadOnlyInput value={invite?.email ?? ""} />
        </Field>

        <Field label="Display name">
          <StyledInput
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="How should we address you?"
            autoComplete="name"
          />
        </Field>

        <Field label="New password">
          <StyledInput
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 6 characters"
            autoComplete="new-password"
          />
        </Field>

        <Field label="Confirm password">
          <StyledInput
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Type the password again"
            autoComplete="new-password"
          />
        </Field>

        {error && (
          <div
            className="rounded-lg px-4 py-3 text-sm"
            style={{
              backgroundColor: "rgba(220, 38, 38, 0.1)",
              border: "1px solid rgba(220, 38, 38, 0.3)",
              color: "#FCA5A5",
            }}
            role="alert"
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg font-semibold text-white transition-all duration-200 hover:opacity-90 disabled:opacity-50"
          style={{
            background: "linear-gradient(135deg, #6B5C32, #8B7A4E)",
            padding: "14px",
            fontSize: "15px",
          }}
        >
          {submitting ? "Accepting…" : "Accept & Sign In"}
        </button>
      </form>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Presentation helpers — mirror /login visuals on the left panel only.
// ---------------------------------------------------------------------------

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{`
        .invite-input:focus {
          border-color: #6B5C32 !important;
          box-shadow: 0 0 0 3px rgba(107,92,50,0.2);
          outline: none;
        }
      `}</style>
      <div
        className="flex min-h-screen items-center justify-center p-8"
        style={{
          backgroundColor: "#1F1D1B",
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(107,92,50,.06) 0 1px, transparent 1px 60px), repeating-linear-gradient(90deg, rgba(107,92,50,.06) 0 1px, transparent 1px 60px)",
        }}
      >
        <div
          className="w-full max-w-md rounded-2xl p-10"
          style={{
            backgroundColor: "rgba(255,255,255,.04)",
            border: "1px solid rgba(107,92,50,.2)",
            backdropFilter: "blur(24px)",
            WebkitBackdropFilter: "blur(24px)",
          }}
        >
          <div className="mb-10">
            <img
              src="/hookka-logo.png"
              alt="Hookka 合家"
              className="h-10 w-auto"
              style={{ filter: "brightness(0) invert(1)" }}
            />
          </div>
          {children}
        </div>
      </div>
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        className="block mb-2 uppercase font-medium"
        style={{
          color: "rgba(255,255,255,.5)",
          fontSize: "12px",
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function StyledInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="invite-input w-full rounded-lg px-4 py-3 text-white transition-all duration-200"
      style={{
        backgroundColor: "rgba(255,255,255,.06)",
        border: "1.5px solid rgba(107,92,50,.3)",
        fontSize: "14px",
      }}
    />
  );
}

function ReadOnlyInput({ value }: { value: string }) {
  return (
    <input
      readOnly
      value={value}
      className="w-full rounded-lg px-4 py-3 text-white/80 cursor-not-allowed"
      style={{
        backgroundColor: "rgba(255,255,255,.03)",
        border: "1.5px solid rgba(107,92,50,.2)",
        fontSize: "14px",
      }}
    />
  );
}
