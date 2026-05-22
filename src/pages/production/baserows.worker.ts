// Production baseRows compute Web Worker — Phase 2 of the Production
// performance refactor.
//
// Phase 1 extracted the heavy row-building pass into the pure module
// baserows-core.ts. Phase 2 (this file) runs that pure pass OFF the main
// thread so changing a filter or switching department never freezes the
// UI. The page module (index.tsx) posts the render-scope inputs here; the
// worker runs buildPickerIndex → buildBaseRows and posts back the
// resulting DeptRow[].
//
// Why a worker, not just a useTransition: useTransition keeps the page
// INTERRUPTIBLE but the compute still runs on the main thread — a single
// uninterruptible buildBaseRows pass at ~1.8k orders still blocks paint
// for hundreds of ms. Moving the whole pass to a worker frees the main
// thread entirely; the only main-thread cost is structured-cloning the
// inputs in and the rows out.

import { buildPickerIndex, buildBaseRows } from "./baserows-core";
import type { ProductionOrder, DeptRow } from "./types";

// Message the page posts INTO the worker. `reqId` is a monotonically
// increasing sequence number — the page sends one per recompute and only
// accepts the response whose reqId matches the latest post, so a stale
// result from a superseded post (e.g. operator changed the filter again
// before the previous compute finished) is dropped instead of flashing
// outdated rows into the grid.
export type BaseRowsRequest = {
  reqId: number;
  orders: ProductionOrder[];
  filteredOrders: ProductionOrder[];
  mode: "full" | "dept" | "overview";
  activeTab: string;
  today: string;
};

// Message the worker posts BACK. Carries the same reqId so the page can
// match it against the latest request.
export type BaseRowsResponse = {
  reqId: number;
  rows: Array<DeptRow & { _deptCode: string }>;
};

// Module-worker global. Typed locally so this file type-checks without a
// dedicated worker tsconfig lib.
const ctx = self as unknown as Worker;

ctx.onmessage = (e: MessageEvent<BaseRowsRequest>) => {
  const { reqId, orders, filteredOrders, mode, activeTab, today } = e.data;
  // Exact same pure pass the synchronous useMemos ran in Phase 1 — the
  // rendered grid must be byte-identical to before this change.
  const pickerIndex = buildPickerIndex(orders);
  const rows = buildBaseRows(filteredOrders, pickerIndex, mode, activeTab, today);
  const response: BaseRowsResponse = { reqId, rows };
  ctx.postMessage(response);
};
