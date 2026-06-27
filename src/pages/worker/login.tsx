// ============================================================
// /worker/login — PIN sign-in for the mobile shop-floor portal
//
// Three screens share this page, swapped via local state:
//   1. mode = "login" — enter empNo + PIN (default)
//   2. mode = "setup" — empNo found but no PIN yet → create one
//   3. mode = "reset" — forgot PIN → verify with phone last-4
//
// The API's /login returns `needsSetup: true` (HTTP 200) when a
// worker has no PIN on record — we flip to setup mode on that.
//
// 2026-06-27 (owner: "logo 100% 一样, 全套新设计"): the SHELL + LOGO
// are now byte-identical to the ERP desktop login (src/pages/login.tsx)
// — same #1F1D1B grid background, glass card, brightness(0) invert(1)
// logo, gold gradient button + btn-shimmer, and the orbiting right-side
// brand panel. We render a `fixed inset-0` overlay so this page breaks
// out of WorkerLayout's max-w-md / black top-bar chrome and fills the
// whole screen exactly like the desktop login. ALL worker behaviour
// (3 modes, handlers, finalizeLogin, every t() i18n call) is unchanged.
// ============================================================
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useT } from "@/lib/worker-i18n";
import {
  WORKER_TOKEN_KEY,
  WORKER_ME_KEY,
  type WorkerMe,
} from "@/layouts/WorkerLayout";

type Mode = "login" | "setup" | "reset";

type WorkerAuthSuccess = {
  success: true;
  token: string;
  worker: WorkerMe;
  needsSetup?: false;
};

type WorkerAuthNeedsSetup = {
  success: false;
  needsSetup: true;
  error?: string;
};

type WorkerAuthError = {
  success: false;
  error?: string;
  needsSetup?: false;
};

type WorkerAuthResponse = WorkerAuthSuccess | WorkerAuthNeedsSetup | WorkerAuthError;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asWorkerMe(v: unknown): WorkerMe | null {
  if (!isRecord(v)) return null;
  const id = asString(v.id);
  const empNo = asString(v.empNo);
  const name = asString(v.name);
  const departmentCode = asString(v.departmentCode);
  if (!id || !empNo || !name || !departmentCode) return null;
  return {
    id,
    empNo,
    name,
    departmentCode,
    position: asString(v.position),
    phone: asString(v.phone),
    nationality: asString(v.nationality),
  };
}

function asWorkerAuthResponse(v: unknown): WorkerAuthResponse | null {
  if (!isRecord(v)) return null;
  if (v.needsSetup === true) {
    return { needsSetup: true, success: false, error: asString(v.error) };
  }
  if (v.success === true && typeof v.token === "string") {
    const worker = asWorkerMe(v.worker);
    if (!worker) return null;
    return { success: true, token: v.token, worker };
  }
  if (v.success === false) {
    return { success: false, error: asString(v.error) };
  }
  return null;
}

export default function WorkerLoginPage() {
  const t = useT();
  const navigate = useNavigate();

  const [mode, setMode] = useState<Mode>("login");
  const [empNo, setEmpNo] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [phoneLast4, setPhoneLast4] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // ----- Login handler -----
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!empNo.trim()) {
      setError(t("common.error"));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/worker-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ empNo: empNo.trim(), pin }),
      });
      const data = asWorkerAuthResponse(await res.json());
      if (!data) {
        setError(t("common.error"));
        return;
      }

      // Server says "no PIN on file yet" → swap to setup screen
      if (data.needsSetup) {
        setMode("setup");
        setPin("");
        setError(null);
        return;
      }
      if (!data.success) {
        setError(data.error || t("common.error"));
        return;
      }
      finalizeLogin(data);
    } catch {
      setError(t("common.error"));
    } finally {
      setLoading(false);
    }
  }

  // ----- First-time PIN setup -----
  async function handleSetup(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(pin)) {
      setError(t("common.error"));
      return;
    }
    if (pin !== pin2) {
      setError(t("login.pinMismatch"));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/worker-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ empNo: empNo.trim(), firstTimePin: pin }),
      });
      const data = asWorkerAuthResponse(await res.json());
      if (!data || !data.success) {
        setError(data?.error || t("common.error"));
        return;
      }
      finalizeLogin(data);
    } catch {
      setError(t("common.error"));
    } finally {
      setLoading(false);
    }
  }

  // ----- PIN reset -----
  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(pin)) {
      setError(t("common.error"));
      return;
    }
    if (pin !== pin2) {
      setError(t("login.pinMismatch"));
      return;
    }
    if (!/^\d{4}$/.test(phoneLast4)) {
      setError(t("common.error"));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/worker-auth/reset-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empNo: empNo.trim(),
          phoneLast4,
          newPin: pin,
        }),
      });
      const data = asWorkerAuthResponse(await res.json());
      if (!data || !data.success) {
        setError(data?.error || t("common.error"));
        return;
      }
      // After reset, fall back to login screen so the worker logs in
      // with the fresh PIN — keeps the flow deliberate.
      setMode("login");
      setPin("");
      setPin2("");
      setPhoneLast4("");
      setError(null);
    } catch {
      setError(t("common.error"));
    } finally {
      setLoading(false);
    }
  }

  // Shared happy-path — store token + worker, go home
  function finalizeLogin(data: { token: string; worker: WorkerMe }) {
    try {
      localStorage.setItem(WORKER_TOKEN_KEY, data.token);
      localStorage.setItem(WORKER_ME_KEY, JSON.stringify(data.worker));
      window.dispatchEvent(new Event("storage"));
    } catch {
      /* ignore */
    }
    navigate("/worker", { replace: true });
  }

  // ----- Render -----
  // Heading + subtitle text per mode (all via t()).
  const heading =
    mode === "login"
      ? t("login.title")
      : mode === "setup"
        ? t("login.setupTitle")
        : t("login.resetTitle");
  const subtitle =
    mode === "setup"
      ? t("login.setupDesc")
      : mode === "reset"
        ? t("login.phoneLast4")
        : t("brand.title");

  return (
    <>
      <style>{`
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        @keyframes orbit1 {
          0% { transform: rotate(0deg) translateX(150px) rotate(0deg); }
          100% { transform: rotate(360deg) translateX(150px) rotate(-360deg); }
        }
        @keyframes orbit2 {
          0% { transform: rotate(0deg) translateX(225px) rotate(0deg); }
          100% { transform: rotate(360deg) translateX(225px) rotate(-360deg); }
        }
        @keyframes orbit3 {
          0% { transform: rotate(0deg) translateX(300px) rotate(0deg); }
          100% { transform: rotate(360deg) translateX(300px) rotate(-360deg); }
        }
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        .btn-shimmer {
          position: relative;
          overflow: hidden;
        }
        .btn-shimmer::after {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: linear-gradient(
            90deg,
            transparent,
            rgba(255,255,255,0.15),
            transparent
          );
          transform: translateX(-100%);
        }
        .btn-shimmer:hover::after {
          animation: shimmer 1.5s ease-in-out;
        }
        .login-input:focus {
          border-color: #6B5C32 !important;
          box-shadow: 0 0 0 3px rgba(107,92,50,0.2);
          outline: none;
        }
        .orbit-dot {
          width: 6px;
          height: 6px;
          background: #6B5C32;
          border-radius: 50%;
          position: absolute;
          top: 50%;
          left: 50%;
        }
        .login-cta {
          background: linear-gradient(135deg, #6B5C32, #8B7A4E);
          padding: 14px;
          font-size: 15px;
        }
        .pin-key {
          width: 56px;
          height: 56px;
          border-radius: 9999px;
          font-size: 20px;
          font-weight: 600;
          color: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all .15s ease;
          border: 1px solid rgba(107,92,50,.3);
          background: rgba(255,255,255,.05);
        }
        .pin-key:active {
          background: linear-gradient(135deg, #6B5C32, #8B7A4E);
          transform: scale(.94);
        }
      `}</style>

      {/* fixed overlay so we break out of WorkerLayout's max-w-md / black
          top-bar chrome and fill the screen exactly like the desktop login */}
      <div className="fixed inset-0 z-50 flex min-h-screen overflow-auto">
        {/* Left Panel - Login Form */}
        <div
          className="flex w-full lg:w-1/2 items-center justify-center p-8 relative"
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
            {/* Logo Row */}
            <div className="mb-10">
              <img
                src="/hookka-logo.png"
                alt="Hookka 合家"
                className="h-10 w-auto"
                style={{ filter: "brightness(0) invert(1)" }}
              />
            </div>

            {/* Title */}
            <h2 className="text-2xl font-bold text-white mb-1">{heading}</h2>
            <p
              className="mb-8"
              style={{ color: "rgba(255,255,255,.45)", fontSize: "13px" }}
            >
              {subtitle}
            </p>

            {/* ----- mode = login ----- */}
            {mode === "login" && (
              <form onSubmit={handleLogin} className="space-y-5">
                <FieldLabel label={t("login.empNo")}>
                  <input
                    type="text"
                    autoComplete="username"
                    value={empNo}
                    onChange={(e) => setEmpNo(e.target.value)}
                    className={inputCls}
                    style={inputStyle}
                    placeholder="EMP-0001"
                  />
                </FieldLabel>
                <FieldLabel label={t("login.pin")}>
                  <input
                    type="password"
                    inputMode="numeric"
                    pattern="\d{6}"
                    maxLength={6}
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                    className={inputCls}
                    style={inputStyle}
                    placeholder="••••••"
                  />
                </FieldLabel>

                {/* Numeric PIN keypad — circular gold keys feed the same
                    `pin` state. Pure convenience on phones; the input above
                    still works for anyone who prefers typing. */}
                <PinPad
                  onDigit={(d) =>
                    setPin((p) => (p.length >= 6 ? p : p + d))
                  }
                  onDelete={() => setPin((p) => p.slice(0, -1))}
                />

                {error && <ErrorBanner>{error}</ErrorBanner>}

                <button type="submit" disabled={loading} className={btnPrimary}>
                  {loading ? t("common.loading") : t("login.submit")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode("reset");
                    setPin("");
                    setPin2("");
                    setError(null);
                  }}
                  className="w-full text-sm pt-2 hover:underline bg-transparent border-0 cursor-pointer"
                  style={{ color: "#8B7A4E" }}
                >
                  {t("login.forgotPin")}
                </button>
              </form>
            )}

            {/* ----- mode = setup ----- */}
            {mode === "setup" && (
              <form onSubmit={handleSetup} className="space-y-5">
                <FieldLabel label={t("login.empNo")}>
                  <input
                    type="text"
                    value={empNo}
                    readOnly
                    className={inputCls}
                    style={{ ...inputStyle, opacity: 0.7 }}
                  />
                </FieldLabel>
                <FieldLabel label={t("login.newPin")}>
                  <input
                    type="password"
                    inputMode="numeric"
                    pattern="\d{6}"
                    maxLength={6}
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                    className={inputCls}
                    style={inputStyle}
                    placeholder="••••••"
                  />
                </FieldLabel>
                <FieldLabel label={t("login.confirmPin")}>
                  <input
                    type="password"
                    inputMode="numeric"
                    pattern="\d{6}"
                    maxLength={6}
                    value={pin2}
                    onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))}
                    className={inputCls}
                    style={inputStyle}
                    placeholder="••••••"
                  />
                </FieldLabel>
                {error && <ErrorBanner>{error}</ErrorBanner>}
                <button type="submit" disabled={loading} className={btnPrimary}>
                  {loading ? t("common.loading") : t("login.submit")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode("login");
                    setPin("");
                    setPin2("");
                    setError(null);
                  }}
                  className="w-full text-sm pt-2 bg-transparent border-0 cursor-pointer"
                  style={{ color: "rgba(255,255,255,.45)" }}
                >
                  {t("common.back")}
                </button>
              </form>
            )}

            {/* ----- mode = reset ----- */}
            {mode === "reset" && (
              <form onSubmit={handleReset} className="space-y-5">
                <FieldLabel label={t("login.empNo")}>
                  <input
                    type="text"
                    value={empNo}
                    onChange={(e) => setEmpNo(e.target.value)}
                    className={inputCls}
                    style={inputStyle}
                    placeholder="EMP-0001"
                  />
                </FieldLabel>
                <FieldLabel label={t("login.phoneLast4")}>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="\d{4}"
                    maxLength={4}
                    value={phoneLast4}
                    onChange={(e) =>
                      setPhoneLast4(e.target.value.replace(/\D/g, ""))
                    }
                    className={inputCls}
                    style={inputStyle}
                    placeholder="1234"
                  />
                </FieldLabel>
                <FieldLabel label={t("login.newPin")}>
                  <input
                    type="password"
                    inputMode="numeric"
                    pattern="\d{6}"
                    maxLength={6}
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                    className={inputCls}
                    style={inputStyle}
                    placeholder="••••••"
                  />
                </FieldLabel>
                <FieldLabel label={t("login.confirmPin")}>
                  <input
                    type="password"
                    inputMode="numeric"
                    pattern="\d{6}"
                    maxLength={6}
                    value={pin2}
                    onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))}
                    className={inputCls}
                    style={inputStyle}
                    placeholder="••••••"
                  />
                </FieldLabel>
                {error && <ErrorBanner>{error}</ErrorBanner>}
                <button type="submit" disabled={loading} className={btnPrimary}>
                  {loading ? t("common.loading") : t("login.resetSubmit")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode("login");
                    setPin("");
                    setPin2("");
                    setPhoneLast4("");
                    setError(null);
                  }}
                  className="w-full text-sm pt-2 bg-transparent border-0 cursor-pointer"
                  style={{ color: "rgba(255,255,255,.45)" }}
                >
                  {t("common.back")}
                </button>
              </form>
            )}
          </div>

          {/* Footer */}
          <div
            className="absolute bottom-6 left-0 right-0 text-center"
            style={{
              color: "rgba(255,255,255,.25)",
              fontSize: "11px",
              letterSpacing: "0.03em",
            }}
          >
            HOOKKA INDUSTRIES SDN BHD &bull; 202501060540 (1661946-X)
          </div>
        </div>

        {/* Right Panel - Brand Side */}
        <div
          className="hidden lg:flex lg:w-1/2 items-center justify-center relative overflow-hidden"
          style={{
            backgroundColor: "#1F1D1B",
            backgroundImage:
              "radial-gradient(ellipse at center, rgba(107,92,50,.08) 0%, transparent 70%)",
          }}
        >
          {/* Orbit Rings */}
          <div
            className="absolute rounded-full"
            style={{
              width: "300px",
              height: "300px",
              border: "1px solid rgba(107,92,50,.08)",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
            }}
          />
          <div
            className="absolute rounded-full"
            style={{
              width: "450px",
              height: "450px",
              border: "1px solid rgba(107,92,50,.08)",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
            }}
          />
          <div
            className="absolute rounded-full"
            style={{
              width: "600px",
              height: "600px",
              border: "1px dashed rgba(107,92,50,.08)",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
            }}
          />

          {/* Orbit Dots */}
          <div
            className="absolute"
            style={{ top: "50%", left: "50%", width: 0, height: 0 }}
          >
            <div
              className="orbit-dot"
              style={{ animation: "orbit1 12s linear infinite" }}
            />
            <div
              className="orbit-dot"
              style={{ animation: "orbit2 18s linear infinite reverse" }}
            />
            <div
              className="orbit-dot"
              style={{ animation: "orbit3 25s linear infinite" }}
            />
          </div>

          {/* Center Content */}
          <div className="relative z-10 flex flex-col items-center text-center">
            <img
              src="/hookka-logo.png"
              alt="Hookka 合家"
              className="mb-6"
              style={{
                height: "140px",
                width: "auto",
                filter: "brightness(0) invert(1)",
              }}
            />

            <p
              className="uppercase mb-6"
              style={{ color: "#8B7A4E", fontSize: "13px", letterSpacing: "4px" }}
            >
              Manufacturing Intelligence Platform
            </p>

            <div
              className="mb-6"
              style={{
                width: "60px",
                height: "1px",
                background:
                  "linear-gradient(90deg, transparent, #6B5C32, transparent)",
              }}
            />

            <div
              className="px-4 py-1.5 rounded-full"
              style={{
                border: "1px solid rgba(107,92,50,.4)",
                color: "#8B7A4E",
                fontSize: "11px",
                letterSpacing: "3px",
              }}
            >
              INDUSTRY 4.0
            </div>
          </div>

          <div
            className="absolute"
            style={{
              top: "24px",
              left: "24px",
              color: "rgba(107,92,50,.4)",
              fontSize: "10px",
              fontFamily: "'Courier New', monospace",
              letterSpacing: "0.08em",
            }}
          >
            HOOKKA INDUSTRIES
          </div>

          <div
            className="absolute flex items-center gap-2"
            style={{
              top: "24px",
              right: "24px",
              color: "rgba(107,92,50,.4)",
              fontSize: "10px",
              fontFamily: "'Courier New', monospace",
              letterSpacing: "0.08em",
            }}
          >
            <span
              className="inline-block rounded-full"
              style={{
                width: "6px",
                height: "6px",
                backgroundColor: "#22c55e",
                animation: "blink 2s ease-in-out infinite",
              }}
            />
            SYSTEM ONLINE
          </div>

          <div
            className="absolute"
            style={{
              bottom: "24px",
              left: "24px",
              color: "rgba(107,92,50,.4)",
              fontSize: "10px",
              fontFamily: "'Courier New', monospace",
              letterSpacing: "0.08em",
            }}
          >
            ERP v2.0 // 2026
          </div>

          <div
            className="absolute"
            style={{
              bottom: "24px",
              right: "24px",
              color: "rgba(107,92,50,.4)",
              fontSize: "10px",
              fontFamily: "'Courier New', monospace",
              letterSpacing: "0.08em",
            }}
          >
            ISO 9001:2015
          </div>
        </div>
      </div>
    </>
  );
}

// ----- tiny UI helpers (re-skinned to match the desktop login) -----
const inputCls =
  "login-input w-full rounded-lg px-4 py-3 text-white transition-all duration-200";
const inputStyle: React.CSSProperties = {
  backgroundColor: "rgba(255,255,255,.06)",
  border: "1.5px solid rgba(107,92,50,.3)",
  fontSize: "14px",
};
const btnPrimary =
  "login-cta btn-shimmer w-full rounded-lg font-semibold text-white transition-all duration-200 hover:opacity-90 disabled:opacity-50";

function FieldLabel({
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

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-lg px-4 py-3 text-sm"
      style={{
        backgroundColor: "rgba(220, 38, 38, 0.1)",
        border: "1px solid rgba(220, 38, 38, 0.3)",
        color: "#FCA5A5",
      }}
      role="alert"
    >
      {children}
    </div>
  );
}

// Numeric keypad for fast PIN entry on a phone. Buttons are type="button"
// so they never submit the form; they only mutate the shared `pin` state.
function PinPad({
  onDigit,
  onDelete,
}: {
  onDigit: (d: string) => void;
  onDelete: () => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-3 justify-items-center">
      {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
        <button
          key={d}
          type="button"
          className="pin-key"
          onClick={() => onDigit(d)}
        >
          {d}
        </button>
      ))}
      <span />
      <button type="button" className="pin-key" onClick={() => onDigit("0")}>
        0
      </button>
      <button
        type="button"
        className="pin-key"
        onClick={onDelete}
        aria-label="Delete"
        style={{ fontSize: "16px" }}
      >
        ⌫
      </button>
    </div>
  );
}
