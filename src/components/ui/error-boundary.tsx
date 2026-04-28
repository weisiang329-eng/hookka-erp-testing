import React from "react";
import { Link } from "react-router-dom";

// ── Types ──────────────────────────────────────────────────────────────────

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

// ── Class Component ────────────────────────────────────────────────────────

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ errorInfo });
    // In production you would send to an error reporting service here
    console.error("[ErrorBoundary] Caught error:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <ErrorFallback
          error={this.state.error}
          errorInfo={this.state.errorInfo}
          onReset={this.handleReset}
        />
      );
    }
    return this.props.children;
  }
}

// ── Fallback UI ────────────────────────────────────────────────────────────

interface ErrorFallbackProps {
  error: Error | null;
  errorInfo?: React.ErrorInfo | null;
  onReset?: () => void;
  reset?: () => void;
}

// Detect crashes caused by stale JS chunks — a common symptom after a new
// deploy replaces the chunk hashes the user's browser is still holding
// references to. Hard-reload once (guarded via sessionStorage) so the
// browser picks up the fresh index.html + bundle map.
function isStaleChunkError(err: Error | null): boolean {
  if (!err) return false;
  const msg = `${err.name || ""} ${err.message || ""}`;
  return (
    /ChunkLoadError/i.test(msg) ||
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Loading chunk \d+ failed/i.test(msg) ||
    /Importing a module script failed/i.test(msg)
  );
}

export function ErrorFallback({ error, errorInfo, onReset, reset }: ErrorFallbackProps) {
  const [showDetails, setShowDetails] = React.useState(false);
  const isDev = import.meta.env.DEV;

  // Auto-recover from stale chunks by hard-reloading once.
  React.useEffect(() => {
    if (!isStaleChunkError(error)) return;
    const KEY = "hookka-stale-chunk-reloaded";
    if (sessionStorage.getItem(KEY)) return; // already tried once
    sessionStorage.setItem(KEY, String(Date.now()));
    window.location.reload();
  }, [error]);

  const handleReset = reset ?? onReset;

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6 bg-[#FAF9F7]">
      <div className="w-full max-w-md">
        {/* Icon */}
        <div className="flex justify-center mb-6">
          <div className="rounded-2xl bg-red-50 border border-red-100 p-4">
            <svg
              className="h-10 w-10 text-red-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
              />
            </svg>
          </div>
        </div>

        {/* Heading */}
        <div className="text-center mb-6">
          <h1 className="text-[22px] font-[800] tracking-[-0.5px] text-[#1F1D1B] mb-1">
            Something went wrong
          </h1>
          <p className="text-sm text-[#5A5550]">An error occurred</p>
          <p className="text-sm text-[#6B7280] mt-3 leading-relaxed">
            An unexpected error occurred. You can try again or go back to the
            dashboard.
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3 justify-center mb-6">
          {handleReset && (
            <button
              onClick={handleReset}
              className="inline-flex items-center justify-center gap-2 h-10 px-5 rounded-md text-sm font-medium bg-[#1F1D1B] text-white hover:bg-[#1F1D1B]/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
                />
              </svg>
              Try Again
            </button>
          )}
          <Link
            to="/dashboard"
            className="inline-flex items-center justify-center gap-2 h-10 px-5 rounded-md text-sm font-medium border border-[#E2DDD8] bg-white text-[#1F1D1B] hover:bg-[#F0ECE9] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25"
              />
            </svg>
            Go Home
          </Link>
        </div>

        {/* Dev-only error details */}
        {isDev && error && (
          <div className="border border-[#E2DDD8] rounded-lg overflow-hidden bg-white">
            <button
              onClick={() => setShowDetails((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-3 text-xs font-semibold text-[#5A5550] hover:bg-[#F5F2ED] transition-colors"
            >
              <span>Error details (dev only)</span>
              <svg
                className={`h-3.5 w-3.5 transition-transform ${showDetails ? "rotate-180" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {showDetails && (
              <div className="border-t border-[#E2DDD8] p-4 space-y-3">
                {/* Error message */}
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[#9CA3AF] mb-1">
                    Message
                  </p>
                  <pre className="text-xs text-red-700 bg-red-50 rounded p-3 overflow-auto whitespace-pre-wrap break-words">
                    {error.message}
                  </pre>
                </div>

                {/* Stack trace */}
                {error.stack && (
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wider text-[#9CA3AF] mb-1">
                      Stack
                    </p>
                    <pre className="text-[10px] text-[#6B7280] bg-[#FAF9F7] rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap break-words">
                      {error.stack}
                    </pre>
                  </div>
                )}

                {/* Component stack */}
                {errorInfo?.componentStack && (
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wider text-[#9CA3AF] mb-1">
                      Component stack
                    </p>
                    <pre className="text-[10px] text-[#6B7280] bg-[#FAF9F7] rounded p-3 overflow-auto max-h-32 whitespace-pre-wrap break-words">
                      {errorInfo.componentStack}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Wrapper function component for easy use ────────────────────────────────

/**
 * Drop-in wrapper. Wrap any subtree that might throw:
 *
 *   <WithErrorBoundary>
 *     <SomeRiskyComponent />
 *   </WithErrorBoundary>
 */
export function WithErrorBoundary({
  children,
  fallback,
}: {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  return <ErrorBoundary fallback={fallback}>{children}</ErrorBoundary>;
}
