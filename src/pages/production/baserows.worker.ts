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
//
// Phase 3 (this revision) — cut the structured-clone + recompute cost.
//
// Before Phase 3 the page re-cloned the ENTIRE unfiltered `orders`
// (~1040 production orders × ~15k job cards) into the worker on EVERY
// post — every filter tweak, every dept switch, every optimistic cell
// edit — and the worker rebuilt the whole picker index each time. For a
// small department that clone + rebuild felt slower than the old
// synchronous compute.
//
// Two facts make that wasteful:
//   1. buildBaseRows only ever reads the picker index as
//      `pickerIndex.get(o.id)` for orders `o` that appear in
//      `filteredOrders` (its cross-PO sibling scan reads `sib.jobCards`
//      directly, never the index). So the worker only needs index
//      entries for the FILTERED orders — never the unfiltered set.
//   2. buildPickerIndex builds each order's entry purely from that
//      order's own jobCards — entries are independent. An order whose
//      jobCards didn't change keeps a byte-identical index entry.
//
// So Phase 3: the page sends only `filteredOrders` (never the unfiltered
// `orders`) plus `dirtyPoIds` — the ids of POs whose content actually
// changed since the last post (an optimistic cell edit dirties one PO; a
// pure filter / dept change dirties none; a refetch dirties all). The
// worker keeps a PER-PO picker-index cache: it rebuilds an entry only
// when that PO is dirty or has no cached entry, and reuses the cache
// otherwise. The rendered grid stays byte-identical — the SAME
// buildBaseRows runs over the SAME filteredOrders, and every index entry
// it reads equals a fresh buildPickerIndex entry.

import { buildOnePickerEntry, buildBaseRows } from "./baserows-core";
import type { PickerByDept } from "./baserows-core";
import type { ProductionOrder, DeptRow } from "./types";

// Message the page posts INTO the worker. `reqId` is a monotonically
// increasing sequence number — the page sends one per recompute and only
// accepts the response whose reqId matches the latest post, so a stale
// result from a superseded post (e.g. operator changed the filter again
// before the previous compute finished) is dropped instead of flashing
// outdated rows into the grid.
//
// `dirtyPoIds` lists the POs whose jobCards changed since the previous
// post (empty for a pure filter / dept change). The worker rebuilds the
// picker-index entry for those POs (and any PO with no cached entry yet)
// and reuses the cache for the rest. `cacheGeneration` lets the worker
// detect a cold cache: the page bumps it whenever it can no longer rely
// on the worker's incremental cache (currently never — kept as a future
// safety valve; a mismatch makes the worker treat every PO as dirty).
export type BaseRowsRequest = {
  reqId: number;
  filteredOrders: ProductionOrder[];
  dirtyPoIds: string[];
  cacheGeneration: number;
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

// Per-PO picker-index cache. Keyed by o.id → that order's PickerByDept.
// Survives across posts; entries are rebuilt only for dirty / uncached
// POs. Entries for POs that drop out of `filteredOrders` are harmless to
// keep (a little memory) — they're simply never read.
const pickerCache = new Map<string, PickerByDept>();
let cacheGeneration = -1;

ctx.onmessage = (e: MessageEvent<BaseRowsRequest>) => {
  const {
    reqId,
    filteredOrders,
    dirtyPoIds,
    cacheGeneration: reqGeneration,
    mode,
    activeTab,
    today,
  } = e.data;

  // Cold-cache reset: if the page signalled a new cache generation, drop
  // every cached entry so each PO is rebuilt from the payload below.
  if (reqGeneration !== cacheGeneration) {
    pickerCache.clear();
    cacheGeneration = reqGeneration;
  }

  // Dirty POs are forced to rebuild even if cached.
  const dirty = new Set(dirtyPoIds);

  // Assemble the picker index buildBaseRows needs: an entry per FILTERED
  // PO. Rebuild from the payload object when the PO is dirty or uncached;
  // reuse the cached entry otherwise. The resulting Map is byte-identical
  // to buildPickerIndex(filteredOrders) — every entry is the pure
  // buildOnePickerEntry of that PO's own jobCards.
  const pickerIndex = new Map<string, PickerByDept>();
  for (const o of filteredOrders) {
    let entry = pickerCache.get(o.id);
    if (!entry || dirty.has(o.id)) {
      entry = buildOnePickerEntry(o);
      pickerCache.set(o.id, entry);
    }
    pickerIndex.set(o.id, entry);
  }

  // Exact same pure pass the synchronous useMemos ran in Phase 1 — the
  // rendered grid must be byte-identical to before this change.
  const rows = buildBaseRows(filteredOrders, pickerIndex, mode, activeTab, today);
  const response: BaseRowsResponse = { reqId, rows };
  ctx.postMessage(response);
};
