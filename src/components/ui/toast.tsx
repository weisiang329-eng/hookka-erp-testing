"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { useInterval, useTimeout } from "@/lib/scheduler";

// ─── Types ────────────────────────────────────────────────────────────────────

type ToastVariant = "success" | "error" | "warning" | "info";

interface ToastItem {
  id: string;
  variant: ToastVariant;
  message: string;
  /** timestamp when the toast was created (ms) */
  createdAt: number;
}

interface ToastContextValue {
  toast: {
    success: (message: string) => void;
    error: (message: string) => void;
    warning: (message: string) => void;
    info: (message: string) => void;
  };
}

// ─── Context ──────────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue | null>(null);

// ─── Constants ────────────────────────────────────────────────────────────────

const DURATION_MS = 4000;
const MAX_TOASTS = 5;

// ─── Icons ────────────────────────────────────────────────────────────────────

function SuccessIcon() {
  return (
    <svg
      className="h-5 w-5 shrink-0 text-green-600"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg
      className="h-5 w-5 shrink-0 text-red-600"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg
      className="h-5 w-5 shrink-0 text-amber-600"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg
      className="h-5 w-5 shrink-0 text-blue-600"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
    </svg>
  );
}

// ─── Progress bar colours per variant ────────────────────────────────────────

const progressBarColor: Record<ToastVariant, string> = {
  success: "bg-green-600",
  error: "bg-red-600",
  warning: "bg-amber-600",
  info: "bg-blue-600",
};

const iconMap: Record<ToastVariant, React.ReactNode> = {
  success: <SuccessIcon />,
  error: <ErrorIcon />,
  warning: <WarningIcon />,
  info: <InfoIcon />,
};

// ─── Individual Toast ─────────────────────────────────────────────────────────

interface SingleToastProps {
  item: ToastItem;
  onDismiss: (id: string) => void;
}

function SingleToast({ item, onDismiss }: SingleToastProps) {
  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState(100);
  const [dismissing, setDismissing] = useState(false);
  const startTimeRef = useRef(Date.now());

  // Trigger enter animation on mount
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Progress bar countdown — visibility-aware via useInterval. Stop ticking
  // once the user (or auto-dismiss) has triggered the exit animation.
  useInterval(
    () => {
      const elapsed = Date.now() - startTimeRef.current;
      const remaining = Math.max(0, 100 - (elapsed / DURATION_MS) * 100);
      setProgress(remaining);
    },
    dismissing ? null : 50,
  );

  // Auto-dismiss after DURATION_MS. `null` once dismissing has started so the
  // timer doesn't double-fire if the user already clicked the close button.
  useTimeout(
    () => {
      handleDismiss();
    },
    dismissing ? null : DURATION_MS,
  );

  function handleDismiss() {
    if (dismissing) return;
    setDismissing(true);
    setVisible(false);
    // Wait for exit animation before removing from DOM. This is a one-shot
    // delay scheduled inside the click handler / auto-dismiss callback —
    // useTimeout would tie the firing to a render with `dismissing=true`,
    // which the unmount path of a clean exit may never reach. Keep raw.
    // eslint-disable-next-line no-restricted-syntax -- one-shot exit-animation cleanup, fires from event handler not React lifecycle
    setTimeout(() => onDismiss(item.id), 300);
  }

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        "relative flex w-80 items-start gap-3 overflow-hidden rounded-lg border border-stone-200 bg-white px-4 py-3 shadow-lg transition-all duration-300 ease-out",
        visible
          ? "translate-x-0 opacity-100"
          : "translate-x-8 opacity-0"
      )}
    >
      {/* Icon */}
      <span className="mt-0.5">{iconMap[item.variant]}</span>

      {/* Message */}
      <p className="flex-1 text-sm leading-snug text-stone-800">
        {item.message}
      </p>

      {/* Dismiss button */}
      <button
        onClick={handleDismiss}
        className="mt-0.5 shrink-0 rounded p-0.5 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
        aria-label="Dismiss notification"
      >
        <CloseIcon />
      </button>

      {/* Progress bar */}
      <div className="absolute bottom-0 left-0 h-0.5 w-full bg-stone-100">
        <div
          className={cn(
            "h-full transition-none",
            progressBarColor[item.variant]
          )}
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}

// ─── Provider ────────────────────────────────────────────────────────────────

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const addToast = useCallback((variant: ToastVariant, message: string) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => {
      const next = [...prev, { id, variant, message, createdAt: Date.now() }];
      // Keep only the most recent MAX_TOASTS
      return next.slice(-MAX_TOASTS);
    });
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = {
    success: (message: string) => addToast("success", message),
    error: (message: string) => addToast("error", message),
    warning: (message: string) => addToast("warning", message),
    info: (message: string) => addToast("info", message),
  };

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}

      {/* Portal-style fixed container: bottom-right */}
      <div
        aria-label="Notifications"
        className="fixed bottom-6 right-6 z-[9999] flex flex-col-reverse gap-2"
      >
        {toasts.map((item) => (
          <SingleToast key={item.id} item={item} onDismiss={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return ctx;
}
