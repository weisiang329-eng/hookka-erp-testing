// ---------------------------------------------------------------------------
// planning-deadlines.ts — the BACKWARD pass the scheduler has never had.
//
// planning-chain.ts computes, for every job card, the earliest day it COULD
// run (floor = upstream day + handoff). That answers "when can this start?"
// but never "when must this be done?", so the engine cannot tell an order in
// trouble from one with three weeks of room. Its sort key is the raw customer
// delivery date, which treats these two identically:
//
//   SO A — due 20 Aug, six departments left (~12 working days of chain)
//   SO B — due 20 Aug, packing only        (1 day)
//
// A is nearly out of road; B is fine. Ordering by due date alone decides
// between them on the SO reference string.
//
// This module mirrors the forward topology in runSewing / runWood / runFraming
// to walk the chain BACKWARD from the customer's date, giving every department
// a LATEST-FINISH day. Subtracting the floor and the card's own duration gives
// SLACK, which is the priority the packer should actually sort on. Slack is
// self-correcting: an order that slips loses slack and climbs the queue by
// itself, with nobody expediting it by hand.
//
// Negative slack is not a scheduling problem to solve — it is arithmetic
// saying the promise cannot be met. Reported, never quietly absorbed.
//
// Pure: no DB, no clock. The caller injects `backWorkday`, so this always
// agrees with whatever calendar the engine already trusts.
// ---------------------------------------------------------------------------

import type { ChainConfig } from "./planning-capacity";

export type ChainDeptId =
  | "FAB_CUT"
  | "FAB_SEW"
  | "WOOD_CUT"
  | "FOAM_CUTTING"
  | "FRAMING"
  | "WEBBING"
  | "FOAM"
  | "UPHOLSTERY"
  | "PACKING";

export type DeadlineLane = "BEDFRAME" | "SOFA" | "ACCESSORY";

/**
 * Working days reserved between finishing packing and handing the goods to
 * the customer. Packing currently shares the upholstery day and no buffer
 * exists at all, which quietly promises same-day dispatch.
 */
export const DEFAULT_SHIP_BUFFER_DAYS = 1;

export interface DeadlineOptions {
  /** Customer delivery date as a calendar day number, or null when undated. */
  customerDd: number | null;
  lane: DeadlineLane;
  chain: ChainConfig;
  /** Step back `n` WORKING days from `day`. Injected by the caller. */
  backWorkday: (day: number, n: number) => number;
  shipBufferDays?: number;
}

/**
 * Latest finish day per department, mirroring the forward chain exactly:
 *
 *   FAB_CUT  -sewHandoff->  FAB_SEW  -woodHandoff->  WOOD_CUT
 *            -frameHandoff-> FRAMING
 *   FRAMING  -foamHandoff-> FOAM            (sofa base + armrest only)
 *   FRAMING  -uphHandoff->  UPHOLSTERY      (bedframe path)
 *   FOAM     -uphHandoff->  UPHOLSTERY      (sofa path)
 *   UPHOLSTERY -same day->  PACKING
 *   FRAMING    -same day->  WEBBING
 *
 * Every value is null for an undated order — no promise, so no deadline to
 * miss. Undated work must never be treated as infinitely urgent OR as
 * infinitely relaxed; callers sort it last on an explicit tiebreak.
 */
export function deptDeadlines(opts: DeadlineOptions): Record<ChainDeptId, number | null> {
  const empty: Record<ChainDeptId, number | null> = {
    FAB_CUT: null,
    FAB_SEW: null,
    WOOD_CUT: null,
    FOAM_CUTTING: null,
    FRAMING: null,
    WEBBING: null,
    FOAM: null,
    UPHOLSTERY: null,
    PACKING: null,
  };
  if (opts.customerDd === null) return empty;

  const { chain, backWorkday } = opts;
  const buffer = opts.shipBufferDays ?? DEFAULT_SHIP_BUFFER_DAYS;

  // Packing must be finished this many working days before the customer date.
  const packing = backWorkday(opts.customerDd, Math.max(0, buffer));
  // Packing rides the upholstery day, so upholstery shares its deadline.
  const upholstery = packing;

  // Sofa routes through foam bonding; bedframe goes framing -> upholstery.
  const foam = opts.lane === "SOFA" ? backWorkday(upholstery, chain.uphHandoffDays) : null;
  const framing =
    opts.lane === "SOFA"
      ? backWorkday(foam as number, chain.foamHandoffDays)
      : backWorkday(upholstery, chain.uphHandoffDays);

  // Webbing runs the same day as its SO's framing.
  const webbing = framing;
  const woodCut = backWorkday(framing, chain.frameHandoffDays);
  const fabSew = backWorkday(woodCut, chain.woodHandoffDays);
  const fabCut = backWorkday(fabSew, chain.sewHandoffDays);

  // Foam Cutting has no upstream to wait for, so its deadline is set purely by
  // DEMAND: the foam must exist `foamCutLeadDays` before it is bonded. Sofas
  // route through bonding; a bedframe's headboard foam is needed at framing.
  const foamCut = backWorkday(foam ?? framing, chain.foamCutLeadDays);

  return {
    FAB_CUT: fabCut,
    FAB_SEW: fabSew,
    WOOD_CUT: woodCut,
    FOAM_CUTTING: foamCut,
    FRAMING: framing,
    WEBBING: webbing,
    FOAM: foam,
    UPHOLSTERY: upholstery,
    PACKING: packing,
  };
}

export interface SlackInput {
  /** Earliest day this may start (forward pass). */
  floor: number;
  /** Latest day it may finish (backward pass), or null when undated. */
  deadline: number | null;
  /** How many working days of its own the work needs. At least 1. */
  durationDays: number;
}

/**
 * Working days of room left. Negative means the promise is arithmetically
 * impossible — no ordering of the queue can save it, so it must be surfaced
 * rather than scheduled late and hoped over.
 *
 * Undated work returns null; callers sort those behind everything dated.
 */
export function slack(input: SlackInput): number | null {
  if (input.deadline === null) return null;
  const duration = Math.max(1, Math.ceil(input.durationDays));
  return input.deadline - input.floor - duration + 1;
}

/** Work out how many whole working days a minute figure occupies. */
export function durationDays(minutes: number, dailyBudgetMin: number): number {
  if (dailyBudgetMin <= 0) return 1;
  return Math.max(1, Math.ceil(minutes / dailyBudgetMin));
}

export interface PriorityInput {
  slack: number | null;
  deadline: number | null;
  /** Grouping hint (fabric) — same-slack work batches instead of thrashing. */
  groupKey?: string;
  /** Final deterministic tiebreak, e.g. the SO reference. */
  tiebreak: string;
}

/**
 * The sort key the packer consumes, most urgent first.
 *
 * Undated work sorts behind every dated order (a large sentinel rather than
 * null) — it has made no promise, so it may never displace one. Within equal
 * urgency, work is grouped by `groupKey` so batching survives the sort, and
 * `tiebreak` keeps the whole order deterministic run to run.
 */
export const UNDATED_SLACK = 9_000_000;

export function priorityKey(input: PriorityInput): Array<number | string> {
  return [
    input.slack ?? UNDATED_SLACK,
    input.deadline ?? UNDATED_SLACK,
    input.groupKey ?? "",
    input.tiebreak,
  ];
}
