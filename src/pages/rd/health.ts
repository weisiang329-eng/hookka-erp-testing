// ---------------------------------------------------------------------------
// Project / milestone health helpers — shared between the R&D index page
// (project card chips, Summary tab) and the detail page (milestone status
// column). All maths happens on the client off whatever data the SPA already
// has on hand; no server round-trip.
//
// Rules — the source-of-truth list:
//
// PROJECT schedule (project.targetLaunchDate vs today):
//   COMPLETED / CANCELLED              → no chip (terminal states)
//   DRAFT                              → no chip (not started yet)
//   today > targetLaunchDate           → "overdue"   (red)
//   ≤ 7 days to target & not yet at
//     PRODUCTION_READY stage           → "at-risk"   (amber)
//   else                               → "on-track"  (no chip — too noisy)
//
// PROJECT budget (project.actualCost / project.totalBudget):
//   totalBudget == 0                   → no chip
//   actualCost >= totalBudget          → "over-budget"   (red)
//   actualCost >= 80% totalBudget      → "near-budget"   (amber)
//   else                               → no chip
//
// MILESTONE (per-row, milestone.targetDate vs today, milestone.actualDate):
//   actualDate set                     → "done"      (green)
//   no targetDate                      → null        (operator hasn't filled
//                                                     a date — don't badge)
//   today > targetDate                 → "overdue"   (red)
//   targetDate within next 3 days      → "due-soon"  (amber)
//   else                               → "upcoming"  (neutral)
// ---------------------------------------------------------------------------

import type { RDProject } from "@/types";

export type ProjectScheduleHealth = "overdue" | "at-risk" | "on-track";
export type ProjectBudgetHealth = "over-budget" | "near-budget" | "ok";
export type MilestoneHealth = "done" | "overdue" | "due-soon" | "upcoming";

// One shape, both maths — keeps callers from juggling two helpers.
export type ProjectHealth = {
  schedule: ProjectScheduleHealth | null;  // null = not applicable (DRAFT / COMPLETED / CANCELLED)
  daysToTarget: number | null;              // signed; negative = past due
  budget: ProjectBudgetHealth;
  budgetPct: number;                        // 0..∞ — caller can clamp for bar widths
};

// `today` is parameterised so the dashboard can pin to a snapshot date when
// rendering historical reports — defaults to the local-clock today.
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Inclusive whole-day diff: (a - b) in calendar days. Strips the time
// component so DST / clock-drift don't slip a day in either direction.
export function diffDays(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const da = Date.UTC(ay, (am ?? 1) - 1, ad ?? 1);
  const db = Date.UTC(by, (bm ?? 1) - 1, bd ?? 1);
  return Math.round((da - db) / 86400000);
}

export function getProjectHealth(project: RDProject, today: string = todayIso()): ProjectHealth {
  // Schedule
  let schedule: ProjectScheduleHealth | null = null;
  let daysToTarget: number | null = null;
  if (
    project.status !== "COMPLETED" &&
    project.status !== "CANCELLED" &&
    project.status !== "DRAFT" &&
    project.targetLaunchDate &&
    project.targetLaunchDate.length >= 10
  ) {
    daysToTarget = diffDays(project.targetLaunchDate.slice(0, 10), today);
    if (daysToTarget < 0) {
      schedule = "overdue";
    } else if (daysToTarget <= 7 && project.currentStage !== "PRODUCTION_READY") {
      schedule = "at-risk";
    } else {
      schedule = "on-track";
    }
  }

  // Budget — terminal states still get a budget reading because operators
  // want to see overspend on completed projects too.
  let budget: ProjectBudgetHealth = "ok";
  let budgetPct = 0;
  if (project.totalBudget > 0) {
    budgetPct = (project.actualCost / project.totalBudget) * 100;
    if (project.actualCost >= project.totalBudget) {
      budget = "over-budget";
    } else if (budgetPct >= 80) {
      budget = "near-budget";
    }
  }

  return { schedule, daysToTarget, budget, budgetPct };
}

// Per-milestone health. `milestone` is the loose shape rd-projects returns —
// we only need three fields, but typing it `unknown` lets every caller pass
// project.milestones[i] without re-importing the row type.
export function getMilestoneHealth(
  milestone: { targetDate?: string | null; actualDate?: string | null },
  today: string = todayIso(),
): { state: MilestoneHealth | null; daysToTarget: number | null } {
  const target = (milestone.targetDate ?? "").slice(0, 10);
  const actual = (milestone.actualDate ?? "").slice(0, 10);
  if (actual) return { state: "done", daysToTarget: target ? diffDays(actual, target) : null };
  if (!target || target.length < 10) return { state: null, daysToTarget: null };
  const days = diffDays(target, today);
  if (days < 0) return { state: "overdue", daysToTarget: days };
  if (days <= 3) return { state: "due-soon", daysToTarget: days };
  return { state: "upcoming", daysToTarget: days };
}

// Tailwind-compatible class strings for the four health states. Centralised
// so callers in detail.tsx and index.tsx can't drift on colours.
export const PROJECT_SCHEDULE_CHIP: Record<ProjectScheduleHealth, { label: string; cls: string }> = {
  overdue:   { label: "Overdue",   cls: "bg-[#FAE5E0] text-[#9A3A2D] border-[#E8B5AB]" },
  "at-risk": { label: "At Risk",   cls: "bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597]" },
  "on-track": { label: "On Track", cls: "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]" },
};

export const PROJECT_BUDGET_CHIP: Record<Exclude<ProjectBudgetHealth, "ok">, { label: string; cls: string }> = {
  "over-budget":  { label: "Over Budget",  cls: "bg-[#FAE5E0] text-[#9A3A2D] border-[#E8B5AB]" },
  "near-budget":  { label: "Near Budget",  cls: "bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597]" },
};

export const MILESTONE_CHIP: Record<MilestoneHealth, { cls: string }> = {
  done:       { cls: "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]" },
  overdue:    { cls: "bg-[#FAE5E0] text-[#9A3A2D] border-[#E8B5AB]" },
  "due-soon": { cls: "bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597]" },
  upcoming:   { cls: "bg-[#F0ECE9] text-[#6B7280] border-[#E2DDD8]" },
};
