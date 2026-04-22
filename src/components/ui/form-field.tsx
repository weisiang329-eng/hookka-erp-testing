import * as React from "react";
import { cn } from "@/lib/utils";

export interface FormFieldProps {
  /** Label text shown above the input */
  label: string;
  /** Appends a red asterisk to the label when true */
  required?: boolean;
  /** Error message shown below the input in red. Also triggers red border on children. */
  error?: string;
  /** Optional helper text shown below the input in gray (hidden when error is present) */
  hint?: string;
  /** The input, select, or textarea element(s) to wrap */
  children: React.ReactNode;
  /** Additional class names for the outer wrapper div */
  className?: string;
}

/**
 * FormField — wraps any input/select/textarea with a label, error state, and hint.
 *
 * When `error` is truthy the child element receives a `data-error="true"` attribute
 * via a React.cloneElement call so that inputs styled with the app's warm-stone palette
 * can add a red border automatically. Native elements receive the attribute directly;
 * custom components that forward it will also pick it up.
 *
 * Usage:
 * ```tsx
 * <FormField label="Customer" required error={errors.customer} hint="Select from the list">
 *   <select ...>...</select>
 * </FormField>
 * ```
 */
export function FormField({
  label,
  required,
  error,
  hint,
  children,
  className,
}: FormFieldProps) {
  // Inject error styling into a single direct child if it is a valid React element.
  const enhancedChildren = React.Children.map(children, (child) => {
    if (!React.isValidElement(child)) return child;

    const childProps = child.props as Record<string, unknown>;

    // Build the error-aware className for the child.
    // We support both plain string className and the pattern used by shadcn/cn components.
    const existingClass =
      typeof childProps.className === "string" ? childProps.className : "";

    const errorClass = error
      ? "border-red-400 focus-visible:ring-red-300 focus:ring-red-300 focus:border-red-400"
      : "";

    return React.cloneElement(child as React.ReactElement<Record<string, unknown>>, {
      "data-error": error ? "true" : undefined,
      className: cn(existingClass, errorClass),
    });
  });

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {/* Label row */}
      <label className="text-sm font-medium text-[#374151]">
        {label}
        {required && (
          <span className="ml-0.5 text-red-500" aria-hidden="true">
            {" "}*
          </span>
        )}
      </label>

      {/* Input slot */}
      {enhancedChildren}

      {/* Error message */}
      {error && (
        <p className="text-xs text-red-500 leading-snug" role="alert">
          {error}
        </p>
      )}

      {/* Hint text — suppressed when an error is showing */}
      {!error && hint && (
        <p className="text-xs text-[#9CA3AF] leading-snug">{hint}</p>
      )}
    </div>
  );
}
