// ============================================================
// PwaInstallPrompt — "Add to Home Screen" card for the Worker Portal
//
// PWA Phase 1 install UX. Behaviour by platform:
//   - Android / Chromium: the browser fires `beforeinstallprompt`. We
//     preventDefault() + stash the event, then show an "Install app" button
//     that calls .prompt() on tap. After the user responds the event is
//     single-use, so we hide the card.
//   - iOS Safari: there is NO beforeinstallprompt. We detect iOS + Safari and
//     show a one-line "Share -> Add to Home Screen" hint instead.
//   - Already installed (standalone display-mode, or navigator.standalone on
//     iOS): render nothing — there is nothing to install.
//   - Dismissed: persisted in localStorage so the card never nags again.
//
// Self-contained: no props. Mount once inside the worker layout.
// ============================================================
import { useEffect, useState } from "react";
import { Download, Share, X } from "lucide-react";

const DISMISS_KEY = "hookka.pwa.install.dismissed";

// The shape of the (non-standard but widely-shipped) beforeinstallprompt event.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

// Already running as an installed app? Then there's nothing to prompt.
function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const mql =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches;
  // iOS Safari exposes navigator.standalone instead of the display-mode query.
  const iosStandalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return mql || iosStandalone;
}

// iOS Safari has no beforeinstallprompt — we show a manual hint there only.
function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua);
  // Exclude Chrome / Firefox / Edge on iOS (they can't Add to Home Screen).
  const isSafari = /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
  return isIos && isSafari;
}

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export default function PwaInstallPrompt() {
  // Stashed Android/Chromium install event (null until the browser offers it).
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null,
  );
  // Whether to render at all. Starts hidden; flipped on by the platform checks.
  const [show, setShow] = useState(false);
  // iOS variant (manual hint) vs Android variant (one-tap button).
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    // Installed already, or the worker dismissed the card before → stay hidden.
    if (isStandalone() || wasDismissed()) return;

    // Android / Chromium: capture the install event, show the one-tap button.
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setShow(true);
      setIosHint(false);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);

    // Hide immediately once the app gets installed.
    const onInstalled = () => {
      setShow(false);
      setDeferred(null);
    };
    window.addEventListener("appinstalled", onInstalled);

    // iOS Safari: no event ever fires, so show the manual hint directly.
    /* eslint-disable react-hooks/set-state-in-effect -- one-shot mount-time platform probe; safe single render, no cascade */
    if (isIosSafari()) {
      setIosHint(true);
      setShow(true);
    }
    /* eslint-enable react-hooks/set-state-in-effect */

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore storage failures — worst case the card shows again */
    }
    setShow(false);
  }

  async function install() {
    if (!deferred) return;
    try {
      await deferred.prompt();
      await deferred.userChoice;
    } catch {
      /* user closed the native dialog — nothing to do */
    }
    // The event is single-use; drop it and hide the card either way.
    setDeferred(null);
    setShow(false);
  }

  if (!show) return null;

  return (
    <div className="mb-4 rounded-lg border border-[#D8D2CC] bg-white p-3 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-[#6B5C32] text-white">
          <Download className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[#1F1D1B]">
            Install Hookka app
          </p>
          {iosHint ? (
            <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-[#6B655C]">
              Tap
              <Share className="inline h-3.5 w-3.5" aria-label="Share" />
              Share, then "Add to Home Screen".
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-[#6B655C]">
              Add it to your home screen for faster, full-screen access.
            </p>
          )}
          {!iosHint && (
            <button
              type="button"
              onClick={install}
              className="mt-2 inline-flex items-center gap-1.5 rounded bg-[#6B5C32] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#5a4d2a]"
            >
              <Download className="h-3.5 w-3.5" />
              Install app
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded p-1 text-[#8A8680] transition-colors hover:bg-[#F0ECE9] hover:text-[#1F1D1B]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
