// ---------------------------------------------------------------------------
// document-drawer.ts — the MODEL behind the right-hand document detail drawer.
//
// The chrome lives in components/ui/document-detail-drawer.tsx. This file holds
// the three decisions that must not be re-implemented per page, and are
// therefore pure + testable without a DOM:
//
//   1. which full-page route a document type's "Open full page" goes to;
//   2. which of the workbench's OWN row-menu entries become sticky action-bar
//      buttons. The row menu already computes what each status allows
//      (`disabled`), so the bar FILTERS that menu — it never keeps a second
//      status table that can disagree with the first;
//   3. the one-line variant / build-spec description, which DELEGATES to the
//      shared `buildSpec` in doc-line-format.ts — the same formatter the DO,
//      Invoice, CN and DR documents print from. A fourth copy of the fabric /
//      DIVAN+LEG / GAP / T.Heights / special-order rules is exactly the drift
//      the shared module exists to prevent.
//
// Adding a second document type is a config entry here plus a body component,
// not a fork of the drawer.
// ---------------------------------------------------------------------------
import { buildSpec, type BuildSpecExtra } from "./doc-line-format";

export type DrawerDocType = "DELIVERY_ORDER";

export type DrawerDocConfig = {
  /** Human label under the document number in the drawer header. */
  label: string;
  /** The document's existing full page. */
  fullPagePath: (id: string) => string;
  /**
   * Row-menu labels this type promotes to the sticky action bar, in the order
   * they should appear. Everything else in the menu (print, QR, refresh) stays
   * in the menu — the bar is for lifecycle moves only.
   */
  actionBarLabels: readonly string[];
  /**
   * Of those, the FORWARD moves — the ones that advance the document down its
   * lifecycle. Rendered as filled buttons; everything else on the bar is an
   * outline. A label list, not a status rule: what is *allowed* still comes
   * only from the row menu.
   */
  primaryActionLabels: readonly string[];
};

export const DRAWER_DOC_CONFIG: Record<DrawerDocType, DrawerDocConfig> = {
  DELIVERY_ORDER: {
    label: "Delivery Order",
    fullPagePath: (id) => `/delivery/${encodeURIComponent(id)}`,
    actionBarLabels: [
      "Reverse to Pending Dispatch",
      "Mark Dispatched",
      "Mark Out for Delivery (In Transit)",
      "Mark Delivered (DO Signed)",
      "Transfer to Invoice",
      "Resend invoice email",
      "Convert to Delivery Return",
      "Cancel Delivery Order",
    ],
    primaryActionLabels: [
      "Mark Dispatched",
      "Mark Out for Delivery (In Transit)",
      "Mark Delivered (DO Signed)",
      "Transfer to Invoice",
    ],
  },
};

/** True when the label is one of the type's forward moves (filled button). */
export function isPrimaryDrawerAction(
  type: DrawerDocType,
  label: string,
): boolean {
  return DRAWER_DOC_CONFIG[type].primaryActionLabels.includes(label);
}

export function drawerFullPagePath(type: DrawerDocType, id: string): string {
  return DRAWER_DOC_CONFIG[type].fullPagePath(id);
}

export function drawerDocLabel(type: DrawerDocType): string {
  return DRAWER_DOC_CONFIG[type].label;
}

/** The shape the drawer needs off a workbench row-menu entry. */
export type DrawerMenuEntry = {
  label: string;
  disabled?: boolean;
  separator?: boolean;
};

/**
 * The sticky action bar for one document: the row menu's own entries, ordered
 * by the type's config, keeping only what the menu itself left ENABLED for this
 * document's current state.
 *
 * So a DRAFT delivery order offers "Mark Dispatched" and a dispatched one
 * offers "Mark Delivered (DO Signed)" for exactly the reason the row menu does
 * — there is only one place that rule is written down.
 */
export function drawerActionBar<T extends DrawerMenuEntry>(
  type: DrawerDocType,
  menu: readonly T[],
): T[] {
  const order = DRAWER_DOC_CONFIG[type].actionBarLabels;
  const byLabel = new Map<string, T>();
  for (const entry of menu) {
    if (entry.separator || entry.disabled) continue;
    if (!byLabel.has(entry.label)) byLabel.set(entry.label, entry);
  }
  return order
    .map((label) => byLabel.get(label))
    .filter((e): e is T => e !== undefined);
}

/**
 * ONE readable variant line for a document line — "PC151-01 / DIVAN 8" + 1"
 * LEG / GAP 12"" for a bedframe, "CG-001 / Size: Queen / 6" LEG" for a sofa.
 *
 * Thin on purpose: every rule lives in buildSpec (doc-line-format.ts), which is
 * what the printed DO / Invoice / CN already use. Screen and paper cannot
 * disagree because there is nothing here to disagree with.
 */
export function drawerLineSpec(
  item: { fabricCode?: string | null; sizeLabel?: string | null },
  extra?: BuildSpecExtra | null,
): string {
  return buildSpec(
    { fabricCode: item.fabricCode ?? "", sizeLabel: item.sizeLabel ?? "" },
    extra ?? undefined,
  );
}
