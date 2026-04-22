"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import type { VariantProps } from "class-variance-authority";

// ---------------------------------------------------------------------------
// Spinner — small rotating SVG circle
// ---------------------------------------------------------------------------
function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn("animate-spin", className)}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// LoadingButton
// ---------------------------------------------------------------------------
export interface LoadingButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** When true: shows spinner, disables the button, and prevents double-clicks */
  loading?: boolean;
  /** Label to show in place of children while loading (optional) */
  loadingText?: string;
}

const LoadingButton = React.forwardRef<HTMLButtonElement, LoadingButtonProps>(
  (
    {
      className,
      variant,
      size,
      loading = false,
      loadingText,
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      >
        {loading && (
          <Spinner
            className={cn(
              "shrink-0",
              size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"
            )}
          />
        )}
        {loading && loadingText ? loadingText : children}
      </button>
    );
  }
);

LoadingButton.displayName = "LoadingButton";

export { LoadingButton };
