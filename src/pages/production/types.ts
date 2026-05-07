// Shared types extracted from production/index.tsx during the
// component split. Keeping them in one file lets sub-components
// import without circular dependency on the page module.

export type JobCard = {
  id: string; departmentId: string; departmentCode: string; departmentName: string; sequence: number;
  status: "WAITING"|"IN_PROGRESS"|"PAUSED"|"COMPLETED"|"TRANSFERRED"|"BLOCKED";
  dueDate: string; prerequisiteMet: boolean;
  pic1Id: string|null; pic1Name: string; pic2Id: string|null; pic2Name: string;
  completedDate: string|null; estMinutes: number; actualMinutes: number|null;
  category: string; productionTimeMinutes: number; overdue: string;
  wipKey?: string; wipCode?: string; wipType?: string; wipLabel?: string;
  wipQty?: number; rackingNumber?: string;
  // Per-piece progress emitted by the minimal /api/production-orders
  // payload. piecesTotal mirrors wipQty (>=1); piecesDone counts
  // piece_pics rows with pic1Id set. Drives the Completion column's
  // "X/Y" partial-progress badge for multi-piece JCs. Optional because
  // older client caches and the legacy non-minimal path don't carry them.
  piecesTotal?: number;
  piecesDone?: number;
  // ISO timestamp of the most recent operator-driven dueDate edit.
  // NULL until the JC is manually rescheduled. Drives the production
  // Overview matrix' "Edited" cell colour state. Optional so older
  // cached payloads don't break the type at the call site.
  dueDateOverriddenAt?: string | null;
};

export type ProductionOrder = {
  id: string; poNo: string;
  salesOrderId: string; salesOrderNo: string; lineNo: number;
  customerPOId: string; customerReference: string; customerName: string; customerState: string;
  companySOId: string;
  // CO-origin POs (migration 0064): mutex with SO. When the parent doc is a
  // Consignment Order, salesOrderId / companySOId are empty and these two
  // fields carry the CO linkage. Used by the soId column fallback so SOFA
  // rows from a CO display CO-YYMM-NNN instead of a blank cell.
  consignmentOrderId?: string;
  companyCOId?: string;
  productId: string; productCode: string; productName: string; itemCategory: "SOFA"|"BEDFRAME"|"ACCESSORY";
  sizeCode: string; sizeLabel: string; fabricCode: string; quantity: number;
  gapInches: number|null; divanHeightInches: number|null; legHeightInches: number|null;
  specialOrder: string; notes: string;
  status: "PENDING"|"IN_PROGRESS"|"COMPLETED"|"ON_HOLD"|"CANCELLED"|"PAUSED";
  currentDepartment: string; progress: number;
  jobCards: JobCard[];
  startDate: string; targetEndDate: string; completedDate: string|null;
  rackingNumber: string; stockedIn: boolean;
  // Optional axes for the page-level Date Filter — present on the API
  // response (rowToPO emits createdAt) but not always populated. The new
  // customerDeliveryDate axis is a TODO: the production_orders payload
  // doesn't expose it directly today; user needs to clarify which date
  // they meant before this can fully wire up to a column.
  createdAt?: string;
  customerDeliveryDate?: string;
};

// 3-state palette (original) + isEdited text-colour modifier (2026-05-07 v2):
//   done    = teal #3E6570 bg + ✓ + white text
//   overdue = red #9A3A2D bg + white text
//   pending = olive #9C6F1E bg + white text
//
// `isEdited` is a separate flag (not a 4th state) — when true on a non-done
// cell, the text colour overrides to teal/cyan so the operator can spot
// manually-rescheduled cells at a glance without losing the underlying
// overdue/pending background warning. Done cells suppress isEdited (the
// completion supersedes the edit indicator).
export type CellState = "done" | "pending" | "overdue" | "empty";
export type Cell = {
  state: CellState;
  isEdited: boolean;
  totalCards: number;
  doneCards: number;
  earliestDue: string; // YYYY-MM-DD
  latestCompleted: string; // latest completedDate across this dept's cards
};

export type Worker = { id: string; name: string; departmentCode?: string; empNo?: string };

// Stock PO dialog source types — historical WIPs/FGs surfaced for the
// "make-to-stock" picker. Only SKUs previously produced show up.
export type HistoricalWip = {
  wipLabel: string;
  wipKey?: string;
  wipCode?: string;
  wipType?: string;       // DIVAN / HEADBOARD / SOFA_BASE / SOFA_CUSHION / SOFA_ARMREST
  itemCategory?: string;  // BEDFRAME / SOFA
  sourcePoId: string;
  sourceJcId: string;
  sourcePoNo: string;
  productCode: string;
  productName: string;
  sizeCode: string;
  sizeLabel: string;
  fabricCode: string;
};

export type HistoricalFg = {
  sourcePoId: string;
  sourcePoNo: string;
  productCode: string;
  productName: string;
  sizeCode: string;
  sizeLabel: string;
  fabricCode: string;
};
