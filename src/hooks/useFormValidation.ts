"use client";

import { useState, useCallback } from "react";
import type { ValidationResult } from "@/lib/validation";

export type FormErrors = Record<string, string>;

export type UseFormValidation = {
  /** All current field errors keyed by field name */
  errors: FormErrors;
  /**
   * Run a validation function and store its error under `fieldName`.
   * Returns true when the field is valid, false when it has an error.
   *
   * @param fieldName  - The key used to store/clear the error (e.g. "customerName")
   * @param validationFn - A zero-arg function that returns a ValidationResult
   *
   * @example
   * validate("quantity", () => positiveNumber(item.quantity, "Quantity"))
   */
  validate: (fieldName: string, validationFn: () => ValidationResult) => boolean;
  /** Remove the error for a single field */
  clearError: (fieldName: string) => void;
  /** Remove all errors */
  clearAll: () => void;
  /** True when any field has an error */
  hasErrors: boolean;
};

/**
 * useFormValidation — lightweight hook for managing field-level form errors.
 *
 * Designed to work directly with the validators in `@/lib/validation`.
 *
 * @example
 * ```tsx
 * const { errors, validate, clearError, clearAll, hasErrors } = useFormValidation();
 *
 * function handleSubmit() {
 *   const ok = [
 *     validate("customer", () => required(customerId, "Customer")),
 *     validate("deliveryDate", () => required(deliveryDate, "Delivery date")),
 *   ].every(Boolean);
 *
 *   if (!ok) return;
 *   // proceed with submission...
 * }
 * ```
 */
export function useFormValidation(): UseFormValidation {
  const [errors, setErrors] = useState<FormErrors>({});

  const validate = useCallback(
    (fieldName: string, validationFn: () => ValidationResult): boolean => {
      const result = validationFn();

      setErrors((prev) => {
        if (result.valid) {
          // Remove the key entirely when the field becomes valid
          if (!(fieldName in prev)) return prev; // no-op — avoid re-render
          const next = { ...prev };
          delete next[fieldName];
          return next;
        }
        // Store the error message
        if (prev[fieldName] === result.error) return prev; // no-op
        return { ...prev, [fieldName]: result.error ?? "Invalid value" };
      });

      return result.valid;
    },
    []
  );

  const clearError = useCallback((fieldName: string) => {
    setErrors((prev) => {
      if (!(fieldName in prev)) return prev;
      const next = { ...prev };
      delete next[fieldName];
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setErrors({});
  }, []);

  const hasErrors = Object.keys(errors).length > 0;

  return { errors, validate, clearError, clearAll, hasErrors };
}
