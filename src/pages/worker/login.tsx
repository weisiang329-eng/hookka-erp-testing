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
      const data = await res.json();

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
    if (!/^\d{4}$/.test(pin)) {
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
      const data = await res.json();
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

  // ----- PIN reset -----
  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^\d{4}$/.test(pin)) {
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
      const data = await res.json();
      if (!data.success) {
        setError(data.error || t("common.error"));
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
  return (
    <div className="pt-6 pb-8">
      <h1 className="text-lg font-bold mb-0.5">
        {mode === "login"
          ? t("login.title")
          : mode === "setup"
            ? t("login.setupTitle")
            : t("login.resetTitle")}
      </h1>
      {mode === "setup" && (
        <p className="text-sm text-[#5A5550] mb-6">{t("login.setupDesc")}</p>
      )}
      {mode === "reset" && (
        <p className="text-sm text-[#5A5550] mb-6">{t("login.phoneLast4")}</p>
      )}
      {mode === "login" && <div className="mb-4" />}

      {mode === "login" && (
        <form onSubmit={handleLogin} className="space-y-4">
          <Field label={t("login.empNo")}>
            <input
              type="text"
              autoComplete="username"
              value={empNo}
              onChange={(e) => setEmpNo(e.target.value)}
              className={inputCls}
              placeholder="EMP-0001"
            />
          </Field>
          <Field label={t("login.pin")}>
            <input
              type="password"
              inputMode="numeric"
              pattern="\d{4}"
              maxLength={4}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              className={inputCls}
              placeholder="••••"
            />
          </Field>
          {error && <p className="text-sm text-[#9A3A2D]">{error}</p>}
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
            className="w-full text-sm text-[#6B5C32] underline pt-2"
          >
            {t("login.forgotPin")}
          </button>
        </form>
      )}

      {mode === "setup" && (
        <form onSubmit={handleSetup} className="space-y-4">
          <Field label={t("login.empNo")}>
            <input
              type="text"
              value={empNo}
              readOnly
              className={`${inputCls} bg-[#F0ECE9]`}
            />
          </Field>
          <Field label={t("login.newPin")}>
            <input
              type="password"
              inputMode="numeric"
              pattern="\d{4}"
              maxLength={4}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              className={inputCls}
              placeholder="••••"
            />
          </Field>
          <Field label={t("login.confirmPin")}>
            <input
              type="password"
              inputMode="numeric"
              pattern="\d{4}"
              maxLength={4}
              value={pin2}
              onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))}
              className={inputCls}
              placeholder="••••"
            />
          </Field>
          {error && <p className="text-sm text-[#9A3A2D]">{error}</p>}
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
            className="w-full text-sm text-[#5A5550] pt-2"
          >
            {t("common.back")}
          </button>
        </form>
      )}

      {mode === "reset" && (
        <form onSubmit={handleReset} className="space-y-4">
          <Field label={t("login.empNo")}>
            <input
              type="text"
              value={empNo}
              onChange={(e) => setEmpNo(e.target.value)}
              className={inputCls}
              placeholder="EMP-0001"
            />
          </Field>
          <Field label={t("login.phoneLast4")}>
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
              placeholder="1234"
            />
          </Field>
          <Field label={t("login.newPin")}>
            <input
              type="password"
              inputMode="numeric"
              pattern="\d{4}"
              maxLength={4}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              className={inputCls}
            />
          </Field>
          <Field label={t("login.confirmPin")}>
            <input
              type="password"
              inputMode="numeric"
              pattern="\d{4}"
              maxLength={4}
              value={pin2}
              onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))}
              className={inputCls}
            />
          </Field>
          {error && <p className="text-sm text-[#9A3A2D]">{error}</p>}
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
            className="w-full text-sm text-[#5A5550] pt-2"
          >
            {t("common.back")}
          </button>
        </form>
      )}
    </div>
  );
}

// ----- tiny UI helpers -----
const inputCls =
  "w-full h-12 px-3 rounded border border-[#D8D2CC] bg-white text-base focus:outline-none focus:ring-2 focus:ring-[#6B5C32] focus:border-[#6B5C32]";
const btnPrimary =
  "w-full h-12 rounded bg-[#6B5C32] hover:bg-[#5a4d2a] disabled:opacity-60 text-white font-semibold text-base transition-colors";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-sm font-medium text-[#5A5550] mb-1.5">{label}</div>
      {children}
    </label>
  );
}
