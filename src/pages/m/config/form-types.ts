// ===========================================================================
// Declarative form spec types (Phase 4).
//
// A <FormSheet> renders a full-screen form from a FormSpec: a list of fields
// (text / number / money / date / select / textarea) + an optional line-item
// editor. Each create/edit form (SO / DO / PO / Invoice / Announcement / Mail)
// is just a FormSpec + a submit() that builds the EXACT desktop payload and
// POSTs/PUTs to the existing endpoint.
//
// Money fields hold integer SEN in form state (RM × 100, via roundSen). The
// MoneyField control displays RM and writes sen back.
//
// ADDITIVE: imported only by files under src/pages/m/.
// ===========================================================================
import { type ReactNode } from "react";

export type FieldKind =
  | "text"
  | "number"
  | "money" // integer sen in state, RM in the input
  | "date"
  | "select"
  | "textarea";

export type SelectOption = { value: string; label: string };

export type FormField = {
  /** State key. */
  name: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  placeholder?: string;
  /** Static options for `select` (or supply `optionsUrl`). */
  options?: SelectOption[];
  /**
   * For `select`: fetch options from an existing list endpoint. The mapper
   * turns each raw row into a {value,label}. Fetched via the SWR cache.
   */
  optionsUrl?: string;
  optionsSelect?: (resp: unknown) => unknown[];
  optionsMap?: (row: unknown) => SelectOption;
  /** Render half-width (default) or full-width. */
  full?: boolean;
  /** Optional helper text under the field. */
  hint?: string;
};

/** One column of the line-item editor. */
export type LineItemField = {
  name: string;
  label: string;
  kind: "text" | "number" | "money" | "select";
  required?: boolean;
  options?: SelectOption[];
  optionsUrl?: string;
  optionsSelect?: (resp: unknown) => unknown[];
  optionsMap?: (row: unknown) => SelectOption;
  /** Flex grow weight in the item row (default 1). */
  grow?: number;
  placeholder?: string;
};

export type LineItemSpec = {
  /** State key holding the array of item objects. */
  name: string;
  /** Heading e.g. "Line items". */
  label: string;
  /** Per-item columns. */
  fields: LineItemField[];
  /** A fresh blank item (called on "+ Add"). */
  blank: () => Record<string, unknown>;
  /** qty field name for the Amount = Σ qty×price total. */
  qtyKey?: string;
  /** unit-price (sen) field name for the Amount total. */
  priceKey?: string;
};

export type FormValues = Record<string, unknown>;

export type FormSpec = {
  /** Sheet title, e.g. "New Sales Order". */
  title: string;
  fields: FormField[];
  lineItems?: LineItemSpec;
  /** Initial values (edit prefills; create supplies defaults). */
  initial: FormValues;
  /** Submit label, default "Save". */
  submitLabel?: string;
  /**
   * Build the request + perform it. Returns { ok, error?, navigateTo? }.
   * Implementations live in forms.ts and call mutateJson + refreshList.
   */
  submit: (values: FormValues) => Promise<{
    ok: boolean;
    error?: string;
    /** Route to push on success (e.g. the new doc's L2 detail). */
    navigateTo?: string;
  }>;
  /** Optional client-side validation → error string, or null if valid. */
  validate?: (values: FormValues) => string | null;
  /** Optional banner shown at the top of the form (e.g. a flow note). */
  note?: ReactNode;
};
