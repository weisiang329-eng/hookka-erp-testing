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
  // ISO timestamp the operator clicked the "Sent" tick on either the
  // dept main grid (/production/<dept>) or the print-view production
  // sheet (/production/department/<dept>). NULL until handed to floor.
  // Optional for legacy cached payloads.
  distributedAt?: string | null;
  // Server-derived expected dueDate under the *current* leadtime config:
  //   expectedDueDate = parentPO.targetEndDate - leadDaysFor(category, deptCode)
  // The Production overview cell flips to teal text when this differs
  // from the persisted `dueDate` (operator manually moved the JC, or the
  // leadtime config changed underneath it). "" = not computable on the
  // server (no anchor / no category) → FE treats as "on plan, no signal".
  // Optional: legacy cached payloads predate this field.
  expectedDueDate?: string;
  // Predicted fabric meters this JC will consume, computed server-side
  // by walking the parent PO's bom_templates.wipComponents tree and
  // summing FAB_CUT-node fabric materials × node.quantity × po.quantity
  // × symmetric scaling. Populated only for FAB_CUT JCs; undefined for
  // every other dept. Drives the FAB_CUT dept page's Fabric Usage column.
  // Optional: legacy cached payloads predate this field.
  fabricUsageMeters?: number;
};

export type ProductionOrder = {
  id: string; poNo: string;
  salesOrderId: string; salesOrderNo: string; lineNo: number;
  customerPOId: string; customerReference: string; customerName: string; customerState: string;
  // Customer's own SO number (sales_orders.customerSO), or the customer's
  // CO number for CO-origin POs. Server batch-joins it onto the payload
  // (attachCustomerSO). Optional: payloads cached before this shipped
  // (≤60s TTL) won't carry it — readers default to "".
  customerSO?: string;
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
  // response (rowToPO emits createdAt) but not always populated.
  createdAt?: string;
  // Planning dates sourced from the parent SO and merged onto each PO by the
  // production-orders API (soDatesMap, production-orders.ts ~1254). Surfaced as
  // the Overview "Customer DD" + "Our Expected DD" columns (Wei Siang 2026-06-03).
  customerDeliveryDate?: string;
  hookkaExpectedDD?: string;
  // ON HOLD reason (0185) — sourced from the parent SO / CO by the
  // production-orders API (attachCustomerSO). Surfaced on the production grid's
  // ON HOLD chip (tooltip) + a faint reason line. Empty for orders not on hold;
  // payloads cached before this shipped (≤60s TTL) won't carry it → default "".
  holdReason?: string;
  heldBy?: string;
  heldAt?: string;
};

// Simplified 3-state palette per user spec:
//   completed = cyan, pending = amber, overdue = rose.
// "active/blocked/ready" all collapse into "pending" since work is unfinished.
export type CellState = "done" | "pending" | "overdue" | "empty";
export type Cell = {
  state: CellState;
  totalCards: number;
  doneCards: number;
  earliestDue: string; // YYYY-MM-DD
  latestCompleted: string; // latest completedDate across this dept's cards
  // True when at least one of this cell's JCs has a persisted dueDate
  // that differs from the server-computed expectedDueDate (operator
  // manually moved it off the leadtime plan, OR the leadtime config
  // changed underneath it). Suppressed when the cell is fully done —
  // ✓ stays white. CellBox uses this to render teal text.
  isOffLeadtime: boolean;
};

export type Worker = {
  id: string;
  name: string;
  // Legacy single dept (kept populated for back-compat with reports that
  // key on one dept per worker).
  departmentCode?: string;
  // Multi-dept assignment — every dept this worker can cover. Source of
  // truth for PIC dropdown filtering (see src/lib/worker.ts).
  departmentCodes?: string[];
  empNo?: string;
};

// Dept-view scheduling/row types. Extracted from production/index.tsx so
// the pure baseRows compute module (baserows-core.ts) and the page module
// can both import them without a circular dependency.
//
// Dept-view rows: one row per JobCard in the selected dept, flattened
// across all production orders. Matches the "Production Sheet" columns
// the user showed. Each row also carries the upstream (previous) dept's
// scheduling/completion info so the grid can render a pending/overdue/
// done pill like the Google sheet.
export type PrevState = "pending" | "overdue" | "done" | "none";
export type DeptSched = {
  due: string;         // YYYY-MM-DD
  completed: string;   // YYYY-MM-DD or ""
  state: PrevState;    // "none" when no JobCard exists for this dept
  sortKey: number;     // overdue(3)>pending(2)>done(1)>none(0) — for column sort
  poId: string;        // parent production order id (for PATCH routing)
  jobCardId: string;   // the underlying job card id to patch
  deptCode: string;    // this cell's dept code (needed for upstream-lock check)
  wipKey: string;      // this cell's wipKey (scopes the upstream-lock check)
  // True when any job card LATER in DEPT_ORDER within the same wipKey is
  // already COMPLETED or TRANSFERRED. When true, the cell's date picker
  // is disabled — the operator must un-complete the downstream dept first.
  locked: boolean;
};
export type DeptRow = {
  id: string;            // `${po.id}:${jc.id}`
  poId: string;
  jobCardId: string;
  rowNo: number;
  soId: string;          // line-suffixed SO ID, unique per production line (= poNo)
  salesOrderNo: string;  // parent sales order id, NOT unique per line
  salesOrderId: string;  // SO primary key — used to route double-click to /sales/:id
  consignmentOrderId: string;  // CO primary key — used to route to /consignment/:id when SO id is empty
  customerPOId: string;
  customerRef: string;
  customerSO: string;   // customer's own SO no. (CO no. for CO-origin rows)
  customerName: string;
  customerState: string;
  model: string;
  // Full product code (includes variant suffix for SOFA, e.g.
  // "5540-1A(LHF)" / "5540-2A(LHF)"). Bedframe/Accessory share the
  // same value as `model` since their productCode IS the model. Used
  // by the FAB_SEW BASE sticker so workers see which sofa variant
  // they're sewing (1A LHF / 2A RHF / etc.), not just the bare base
  // model number.
  productCode: string;
  // Compartment id (job_cards.wipKey) — links this piece's FAB_SEW &
  // UPHOLSTERY cards (same wipKey, differ only by departmentCode). Drives the
  // per-compartment shared Sew/Uph sticker (wk=) so a scan completes just this
  // piece. Empty string when the card carries no wipKey.
  wipKey: string;
  wip: string;
  category: string;     // SOFA / BEDFRAME / ACCESSORY (from PO/SO item)
  wipType: string;      // DIVAN / HEADBOARD / SOFA_BASE / SOFA_CUSHION / SOFA_ARMREST
  size: string;
  colour: string;
  gap: string;
  divan: string;
  leg: string;
  totalHeight: string;  // gap + divan + leg, inches
  // Order quantity for this row. Always 1 here — every production row is
  // its own SO line (`SO-XXXX-01/-02/…`). Drives the grid "Qty" column.
  qty: number;
  // Pieces to cut = the cutting-recipe panel / piece count
  // (job_cards.wipQty). Distinct from `qty`: a single sofa / divan order
  // (qty 1) can need 2/3/4/6 fabric pieces cut. Drives the "Pieces" grid
  // column, sticker fan-out, the sticker-count badge, and the merged
  // cutting-schedule print total. See BUG-2026-06-01-001.
  piecesToCut: number;
  specialOrder: string; // free-text note from the SO line ("custom legs", "no piping", etc.)
  prodTime: number;     // per-jc production minutes (merged sum on FAB_CUT rows)
  rack: string;         // Packing dept — assigned rack location ("Rack 3")
  dueDate: string;
  // Planning aids (2026-05-28) — batch-joined from the parent SO. The
  // customer's requested delivery date + Hookka's internal expected DD.
  // Read-only columns; "" for CO-origin rows. Help the operator schedule
  // dueDate without overshooting the promise.
  customerDeliveryDate: string;
  hookkaExpectedDD: string;
  completedDate: string;
  // Per-piece progress for the Completion column. piecesTotal floors
  // at 1 (single-piece JCs); piecesDone is 0 until at least one piece
  // has been QR-scanned. Renders "X/Y" when 0 < piecesDone < piecesTotal.
  piecesTotal: number;
  piecesDone: number;
  // ISO timestamp of the "Sent to floor" tick (job_cards.distributedAt).
  // NULL until the operator hands the printed sheet to the production
  // worker. Drives the leftmost Sent column on the dept grid.
  distributedAt: string | null;
  // Derived "Yes"/"No" so the column-level Values filter can group
  // rows by sent-state. Without this the filter sees only the
  // ISO-timestamp string and dumps every row into "(blank)".
  sent: "Yes" | "No";
  // Predicted fabric meters for this WIP, computed server-side by
  // walking the parent PO's BOM template (bom_templates.wipComponents)
  // and summing FAB_CUT-node fabric materials × node.quantity ×
  // po.quantity × scaling. Populated only for FAB_CUT JCs; 0 for
  // every other dept. Drives the FAB_CUT dept page's Fabric Usage
  // column.
  fabricUsage: number;
  pic1: string;
  pic2: string;
  status: string;        // job_card status
  poStatus: string;      // parent production_order status — drives ON_HOLD / CANCELLED styling
  // ON HOLD reason (0185) — copied from the parent SO / CO onto each grid row.
  // Drives the faint italic reason line under the product code + the ON HOLD
  // chip tooltip. Empty for rows whose parent order is not on hold.
  holdReason: string;
  heldBy: string;
  heldAt: string;
  // Scheduling info for every one of the 8 departments — NOT just
  // upstreams. The user can toggle any dept column on/off via the grid's
  // Columns button. Each entry is flattened into `sched_<CODE>` keys so
  // DataGrid can sort/filter per-column without touching a nested object.
  sched_FAB_CUT: DeptSched;
  sched_FAB_SEW: DeptSched;
  sched_FOAM: DeptSched;
  sched_WOOD_CUT: DeptSched;
  sched_FOAM_CUTTING: DeptSched;
  sched_FRAMING: DeptSched;
  sched_WEBBING: DeptSched;
  sched_UPHOLSTERY: DeptSched;
  sched_PACKING: DeptSched;
};

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
