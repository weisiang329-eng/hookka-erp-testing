// ============================================================
// WorkerLayout — Mobile shop-floor portal shell
//
// Everything in /worker/* renders inside this layout. It:
//   1. Guards the routes: if no valid `hookka.worker.token` in
//      localStorage, redirect to /worker/login.
//   2. Renders a compact top bar (brand + language menu).
//   3. Renders a 4-tab bottom navigation bar (Home / Scan / Pay / Me).
//
// The layout is mobile-first — tap targets ≥44px, single-column
// content, bottom nav always sticky. It looks fine on a desktop
// browser too but isn't optimised for it.
// ============================================================
import { Outlet, useLocation, useNavigate, Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { Home, ScanLine, Wallet, User, Globe } from "lucide-react";
import {
  useT,
  useApplyHtmlLang,
  useLangState,
  LANG_LABELS,
  type WorkerLang,
} from "@/lib/worker-i18n";

// Keys used across the portal. Single source of truth so other
// pages (e.g. login) can clear / set them consistently.
export const WORKER_TOKEN_KEY = "hookka.worker.token";
export const WORKER_ME_KEY = "hookka.worker.me";

export type WorkerMe = {
  id: string;
  empNo: string;
  name: string;
  departmentCode: string;
  position?: string;
  phone?: string;
  nationality?: string;
};

// Tiny helper — read the current token synchronously. Used by every
// /worker page via `workerFetch()` to add the auth header.
// eslint-disable-next-line react-refresh/only-export-components -- co-located worker auth helpers; HMR penalty is acceptable
export function getWorkerToken(): string | null {
  try {
    return localStorage.getItem(WORKER_TOKEN_KEY);
  } catch {
    return null;
  }
}

// Clear every piece of worker auth state. Called from logout and
// from any 401 response.
// eslint-disable-next-line react-refresh/only-export-components -- co-located worker auth helpers; HMR penalty is acceptable
export function clearWorkerAuth() {
  try {
    localStorage.removeItem(WORKER_TOKEN_KEY);
    localStorage.removeItem(WORKER_ME_KEY);
  } catch {
    /* ignore */
  }
}

// Fetch wrapper that auto-attaches the X-Worker-Token header and
// bounces to login on 401. Every /worker page should use this
// instead of bare fetch so auth is never accidentally skipped.
// eslint-disable-next-line react-refresh/only-export-components -- co-located worker auth helpers; HMR penalty is acceptable
export async function workerFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = getWorkerToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("X-Worker-Token", token);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    clearWorkerAuth();
    // Don't throw — let the caller see the response. WorkerLayout's
    // storage listener will notice the cleared token and redirect.
    window.dispatchEvent(new Event("storage"));
  }
  return res;
}

export default function WorkerLayout() {
  const t = useT();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useApplyHtmlLang();

  // Reactive token check — redirect to login if missing.
  const [token, setToken] = useState<string | null>(getWorkerToken());

  useEffect(() => {
    // Re-read token from storage whenever another tab (or our own
    // workerFetch 401 handler) changes it.
    const onStorage = () => setToken(getWorkerToken());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!token && pathname !== "/worker/login") {
      navigate("/worker/login", { replace: true });
    }
  }, [token, pathname, navigate]);

  // Login page uses this same layout wrapper for consistent theming,
  // but skips the nav (no point showing tabs before login).
  const isLogin = pathname === "/worker/login";

  return (
    <div className="min-h-screen bg-[#F0ECE9] flex flex-col text-[#1F1D1B]">
      {/* ----- Top bar ----- */}
      <header className="bg-[#1F1D1B] text-white sticky top-0 z-30">
        <div className="max-w-md mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded bg-[#6B5C32] flex items-center justify-center text-sm font-bold">
              H
            </div>
            <span className="text-base font-semibold tracking-tight">
              {t("brand.title")}
            </span>
          </div>
          <LanguageMenu />
        </div>
      </header>

      {/* ----- Page body ----- */}
      <main className="flex-1 max-w-md w-full mx-auto px-4 py-4 pb-28">
        <Outlet />
      </main>

      {/* ----- Bottom tab bar (hidden on login) ----- */}
      {!isLogin && (
        <nav className="fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-[#D8D2CC] shadow-[0_-2px_8px_rgba(0,0,0,0.04)]">
          <div className="max-w-md mx-auto grid grid-cols-4">
            <TabButton
              to="/worker"
              active={pathname === "/worker"}
              icon={<Home className="h-5 w-5" />}
              label={t("nav.home")}
            />
            <TabButton
              to="/worker/scan"
              active={pathname.startsWith("/worker/scan")}
              icon={<ScanLine className="h-5 w-5" />}
              label={t("nav.scan")}
            />
            <TabButton
              to="/worker/pay"
              active={pathname.startsWith("/worker/pay")}
              icon={<Wallet className="h-5 w-5" />}
              label={t("nav.pay")}
            />
            <TabButton
              to="/worker/me"
              active={pathname.startsWith("/worker/me")}
              icon={<User className="h-5 w-5" />}
              label={t("nav.me")}
            />
          </div>
        </nav>
      )}
    </div>
  );
}

// ----- Tab button -----
function TabButton({
  to,
  active,
  icon,
  label,
}: {
  to: string;
  active: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      to={to}
      className={`flex flex-col items-center justify-center gap-1 py-2.5 text-xs min-h-[56px] transition-colors ${
        active
          ? "text-[#6B5C32] font-semibold"
          : "text-[#8A8680] hover:text-[#1F1D1B]"
      }`}
    >
      {icon}
      <span className="leading-none">{label}</span>
    </Link>
  );
}

// ----- Language switcher -----
// Dropdown in the top-right — tap opens a list of the 4 languages.
function LanguageMenu() {
  const [lang, setLang] = useLangState();
  const [open, setOpen] = useState(false);

  // Close on outside click. Pretty lightweight vs adding a popover lib.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-lang-menu]")) setOpen(false);
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [open]);

  return (
    <div className="relative" data-lang-menu>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded hover:bg-white/10 transition-colors"
        aria-label="Change language"
      >
        <Globe className="h-4 w-4" />
        <span className="text-sm">{LANG_LABELS[lang]}</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-40 bg-white text-[#1F1D1B] rounded shadow-lg border border-[#D8D2CC] overflow-hidden">
          {(Object.keys(LANG_LABELS) as WorkerLang[]).map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => {
                setLang(code);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-[#F0ECE9] ${
                code === lang ? "font-semibold text-[#6B5C32]" : ""
              }`}
            >
              {LANG_LABELS[code]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
