// ─── Validation Result ───────────────────────────────────────────────────────

export type ValidationResult = {
  valid: boolean;
  error?: string;
};

// ─── Primitive Validators ─────────────────────────────────────────────────────

/**
 * Checks that a value is non-empty.
 * Accepts strings (trims whitespace), numbers (not NaN), and arrays (length > 0).
 */
export function required(
  value: string | number | unknown[] | null | undefined,
  fieldName: string
): ValidationResult {
  if (value === null || value === undefined) {
    return { valid: false, error: `${fieldName} is required` };
  }
  if (typeof value === "string" && value.trim() === "") {
    return { valid: false, error: `${fieldName} is required` };
  }
  if (typeof value === "number" && isNaN(value)) {
    return { valid: false, error: `${fieldName} is required` };
  }
  if (Array.isArray(value) && value.length === 0) {
    return { valid: false, error: `${fieldName} is required` };
  }
  return { valid: true };
}

/**
 * Checks that a number is >= min.
 */
export function minValue(
  value: number,
  min: number,
  fieldName: string
): ValidationResult {
  if (typeof value !== "number" || isNaN(value)) {
    return { valid: false, error: `${fieldName} must be a valid number` };
  }
  if (value < min) {
    return { valid: false, error: `${fieldName} must be at least ${min}` };
  }
  return { valid: true };
}

/**
 * Checks that a number is <= max.
 */
export function maxValue(
  value: number,
  max: number,
  fieldName: string
): ValidationResult {
  if (typeof value !== "number" || isNaN(value)) {
    return { valid: false, error: `${fieldName} must be a valid number` };
  }
  if (value > max) {
    return { valid: false, error: `${fieldName} must be at most ${max}` };
  }
  return { valid: true };
}

/**
 * Checks that a number is strictly greater than 0.
 */
export function positiveNumber(
  value: number,
  fieldName: string
): ValidationResult {
  if (typeof value !== "number" || isNaN(value)) {
    return { valid: false, error: `${fieldName} must be a valid number` };
  }
  if (value <= 0) {
    return { valid: false, error: `${fieldName} must be greater than 0` };
  }
  return { valid: true };
}

/**
 * Checks that a number is >= 0.
 */
export function nonNegativeNumber(
  value: number,
  fieldName: string
): ValidationResult {
  if (typeof value !== "number" || isNaN(value)) {
    return { valid: false, error: `${fieldName} must be a valid number` };
  }
  if (value < 0) {
    return { valid: false, error: `${fieldName} must be 0 or greater` };
  }
  return { valid: true };
}

/**
 * Checks that date >= minDate.
 * Accepts Date objects or date strings parseable by `new Date()`.
 */
export function dateNotBefore(
  date: Date | string,
  minDate: Date | string,
  fieldName: string
): ValidationResult {
  const d = new Date(date);
  const min = new Date(minDate);
  if (isNaN(d.getTime())) {
    return { valid: false, error: `${fieldName} is not a valid date` };
  }
  if (isNaN(min.getTime())) {
    return { valid: false, error: `Minimum date for ${fieldName} is not valid` };
  }
  if (d < min) {
    return {
      valid: false,
      error: `${fieldName} cannot be before ${min.toLocaleDateString("en-MY")}`,
    };
  }
  return { valid: true };
}

/**
 * Checks that date <= maxDate.
 * Accepts Date objects or date strings parseable by `new Date()`.
 */
export function dateNotAfter(
  date: Date | string,
  maxDate: Date | string,
  fieldName: string
): ValidationResult {
  const d = new Date(date);
  const max = new Date(maxDate);
  if (isNaN(d.getTime())) {
    return { valid: false, error: `${fieldName} is not a valid date` };
  }
  if (isNaN(max.getTime())) {
    return { valid: false, error: `Maximum date for ${fieldName} is not valid` };
  }
  if (d > max) {
    return {
      valid: false,
      error: `${fieldName} cannot be after ${max.toLocaleDateString("en-MY")}`,
    };
  }
  return { valid: true };
}

// ─── Domain Validators ────────────────────────────────────────────────────────

export type SOItem = {
  quantity: number;
  basePriceSen: number;
  unitPriceSen?: number;
  fabricCode: string;
  [key: string]: unknown;
};

/**
 * Validates a single Sales Order line item.
 * Returns all errors found (not just the first).
 */
export function validateSOItem(item: SOItem): ValidationResult {
  const errors: string[] = [];

  const qtyResult = positiveNumber(item.quantity, "Quantity");
  if (!qtyResult.valid && qtyResult.error) errors.push(qtyResult.error);

  const baseResult = nonNegativeNumber(item.basePriceSen, "Base price");
  if (!baseResult.valid && baseResult.error) errors.push(baseResult.error);

  // unitPriceSen is optional on the type but must be non-negative if present
  const unitPrice = item.unitPriceSen ?? item.basePriceSen;
  const unitResult = nonNegativeNumber(unitPrice, "Unit price");
  if (!unitResult.valid && unitResult.error) errors.push(unitResult.error);

  const fabricResult = required(item.fabricCode, "Fabric code");
  if (!fabricResult.valid && fabricResult.error) errors.push(fabricResult.error);

  if (errors.length > 0) {
    return { valid: false, error: errors.join("; ") };
  }
  return { valid: true };
}

export type SOOrder = {
  customerName: string;
  items: SOItem[];
  customerDeliveryDate: string;
  [key: string]: unknown;
};

/**
 * Validates a complete Sales Order.
 * Returns all errors found across all fields and items.
 */
export function validateSO(order: SOOrder): ValidationResult {
  const errors: string[] = [];

  const customerResult = required(order.customerName, "Customer name");
  if (!customerResult.valid && customerResult.error) errors.push(customerResult.error);

  if (!order.items || order.items.length === 0) {
    errors.push("Sales order must have at least 1 item");
  } else {
    order.items.forEach((item, idx) => {
      const itemResult = validateSOItem(item);
      if (!itemResult.valid && itemResult.error) {
        errors.push(`Line ${idx + 1}: ${itemResult.error}`);
      }
    });
  }

  const dateResult = required(order.customerDeliveryDate, "Customer delivery date");
  if (!dateResult.valid && dateResult.error) errors.push(dateResult.error);

  if (errors.length > 0) {
    return { valid: false, error: errors.join(" | ") };
  }
  return { valid: true };
}

// ─── Batch Runner ─────────────────────────────────────────────────────────────

/**
 * Runs multiple validation functions and collects all errors.
 * Returns { valid: true } only when every validation passes.
 */
export function validateAll(validations: Array<() => ValidationResult>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  for (const fn of validations) {
    const result = fn();
    if (!result.valid && result.error) {
      errors.push(result.error);
    }
  }

  return { valid: errors.length === 0, errors };
}
