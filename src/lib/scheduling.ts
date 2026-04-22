// ============================================================
// HOOKKA ERP - Backward Scheduling Engine
// Calculates department start/end dates from delivery deadline
// Skips Sundays, respects dependency chains
// ============================================================

import { deptLeadTimes } from "./mock-data";

type DeptScheduleResult = {
  deptCode: string;
  deptName: string;
  startDate: string;
  endDate: string;
  leadDays: number;
};

/**
 * Subtract working days (skip Sundays) from a date.
 * Returns a new Date.
 */
function subtractWorkingDays(from: Date, days: number): Date {
  const result = new Date(from);
  let remaining = days;
  while (remaining > 0) {
    result.setDate(result.getDate() - 1);
    // Skip Sunday (0)
    if (result.getDay() !== 0) {
      remaining--;
    }
  }
  return result;
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Department dependency chain (backward scheduling order):
 *
 * PACKING (end) <- UPHOLSTERY <- { FAB_SEW + FOAM + FRAMING }
 *   FAB_SEW <- FAB_CUT
 *   FRAMING <- WOOD_CUT  (parallel with FAB_CUT -> FAB_SEW)
 *   WEBBING <- FRAMING    (parallel path: WOOD_CUT -> FRAMING -> WEBBING)
 *
 * The backward scheduling works from delivery date:
 * 1. Subtract buffer days -> Hookka Expected DD (Packing end)
 * 2. Packing end -> subtract packing days -> Packing start = Upholstery end
 * 3. Upholstery end -> subtract upholstery days -> Upholstery start
 * 4. Upholstery start = end date for FAB_SEW, FOAM, and FRAMING (all must finish before upholstery)
 * 5. Each branch schedules backward independently:
 *    - FAB_SEW end = Upholstery start -> subtract sewing days -> FAB_SEW start = FAB_CUT end -> subtract cutting days -> FAB_CUT start
 *    - FOAM end = Upholstery start -> subtract foam days -> FOAM start
 *    - FRAMING end = Upholstery start -> subtract framing days -> FRAMING start = WOOD_CUT end -> subtract wood cutting days -> WOOD_CUT start
 *    - WEBBING end = Upholstery start -> subtract webbing days -> WEBBING start (parallel to framing output)
 */
export function calculateBackwardSchedule(
  deliveryDate: string,
  category: "BEDFRAME" | "SOFA"
): DeptScheduleResult[] {
  const delivery = parseDate(deliveryDate);

  // Get lead times for this category
  const getLeadDays = (deptCode: string): number => {
    const lt = deptLeadTimes.find((d) => d.deptCode === deptCode);
    if (!lt) return 0;
    return category === "BEDFRAME" ? lt.bedframeDays : lt.sofaDays;
  };

  // Buffer days
  const bufferDays = category === "BEDFRAME" ? 2 : 1;

  // Step 1: Hookka Expected DD = delivery - buffer (working days)
  const hookkaDD = subtractWorkingDays(delivery, bufferDays);

  // Step 2: Packing end = hookkaDD, Packing start = hookkaDD - packing days
  const packingDays = getLeadDays("PACKING");
  const packingEnd = new Date(hookkaDD);
  const packingStart = subtractWorkingDays(packingEnd, packingDays);

  // Step 3: Upholstery end = packingStart, Upholstery start = packingStart - upholstery days
  const upholsteryDays = getLeadDays("UPHOLSTERY");
  const upholsteryEnd = new Date(packingStart);
  const upholsteryStart = subtractWorkingDays(upholsteryEnd, upholsteryDays);

  // Step 4: All feeder departments must end by upholsteryStart
  const feederEnd = new Date(upholsteryStart);

  // Branch A: FAB_SEW -> FAB_CUT
  const fabSewDays = getLeadDays("FAB_SEW");
  const fabSewEnd = new Date(feederEnd);
  const fabSewStart = subtractWorkingDays(fabSewEnd, fabSewDays);

  const fabCutDays = getLeadDays("FAB_CUT");
  const fabCutEnd = new Date(fabSewStart);
  const fabCutStart = subtractWorkingDays(fabCutEnd, fabCutDays);

  // Branch B: FOAM (independent)
  const foamDays = getLeadDays("FOAM");
  const foamEnd = new Date(feederEnd);
  const foamStart = subtractWorkingDays(foamEnd, foamDays);

  // Branch C: FRAMING -> WOOD_CUT
  const framingDays = getLeadDays("FRAMING");
  const framingEnd = new Date(feederEnd);
  const framingStart = subtractWorkingDays(framingEnd, framingDays);

  const woodCutDays = getLeadDays("WOOD_CUT");
  const woodCutEnd = new Date(framingStart);
  const woodCutStart = subtractWorkingDays(woodCutEnd, woodCutDays);

  // Branch D: WEBBING (parallel, feeds into upholstery)
  const webbingDays = getLeadDays("WEBBING");
  const webbingEnd = new Date(feederEnd);
  const webbingStart = subtractWorkingDays(webbingEnd, webbingDays);

  const results: DeptScheduleResult[] = [
    { deptCode: "FAB_CUT", deptName: "Fabric Cutting", startDate: toISO(fabCutStart), endDate: toISO(fabCutEnd), leadDays: fabCutDays },
    { deptCode: "FAB_SEW", deptName: "Fabric Sewing", startDate: toISO(fabSewStart), endDate: toISO(fabSewEnd), leadDays: fabSewDays },
    { deptCode: "FOAM", deptName: "Foam Bonding", startDate: toISO(foamStart), endDate: toISO(foamEnd), leadDays: foamDays },
    { deptCode: "WOOD_CUT", deptName: "Wood Cutting", startDate: toISO(woodCutStart), endDate: toISO(woodCutEnd), leadDays: woodCutDays },
    { deptCode: "FRAMING", deptName: "Framing", startDate: toISO(framingStart), endDate: toISO(framingEnd), leadDays: framingDays },
    { deptCode: "WEBBING", deptName: "Webbing", startDate: toISO(webbingStart), endDate: toISO(webbingEnd), leadDays: webbingDays },
    { deptCode: "UPHOLSTERY", deptName: "Upholstery", startDate: toISO(upholsteryStart), endDate: toISO(upholsteryEnd), leadDays: upholsteryDays },
    { deptCode: "PACKING", deptName: "Packing", startDate: toISO(packingStart), endDate: toISO(packingEnd), leadDays: packingDays },
  ];

  return results;
}

/**
 * Calculate the Hookka Expected DD from delivery date and category
 */
export function calculateHookkaDD(deliveryDate: string, category: "BEDFRAME" | "SOFA"): string {
  const delivery = parseDate(deliveryDate);
  const bufferDays = category === "BEDFRAME" ? 2 : 1;
  return toISO(subtractWorkingDays(delivery, bufferDays));
}

/**
 * Get the earliest start date from a backward schedule
 */
export function getEarliestStart(schedule: DeptScheduleResult[]): string {
  return schedule.reduce((earliest, s) => s.startDate < earliest ? s.startDate : earliest, schedule[0]?.startDate || "");
}

/**
 * Department color map
 */
export const DEPT_COLORS: Record<string, string> = {
  FAB_CUT: "#3B82F6",
  FAB_SEW: "#6366F1",
  WOOD_CUT: "#F59E0B",
  FOAM: "#8B5CF6",
  FRAMING: "#F97316",
  WEBBING: "#10B981",
  UPHOLSTERY: "#F43F5E",
  PACKING: "#06B6D4",
};

/**
 * Customer color palette for Gantt chart
 */
export const CUSTOMER_COLORS: Record<string, string> = {
  "CARRESS SDN BHD": "#3B82F6",
  "HOUZS KL": "#F59E0B",
  "HOUZS PG": "#10B981",
  "HOUZS SBH": "#8B5CF6",
  "HOUZS SRW": "#F97316",
  "HOUZS CENTURY SDN BHD": "#F43F5E",
  "THE CONTS SDN BHD": "#06B6D4",
};
