// ---------------------------------------------------------------------------
// Employee quick view — click a row, maintain the person here.
//
// The Employee Master grid had grown to twenty-odd columns (salary, hours, OT
// multiplier, allowance, threshold, statutory, payment method, bank, account,
// join date, nationality…) and the operator was scrolling sideways to edit one
// field (owner 2026-08-02: 「已经很多东西要填写了」). The grid now shows the
// handful of columns you scan a list by; everything else is maintained in here,
// the way the Houzs sales-order quick view works.
//
// Deliberately NOT a form that saves on every keystroke: the drawer holds a
// local draft and writes once, so a half-typed salary never reaches the server.
// ---------------------------------------------------------------------------
import { useState } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  MALAYSIAN_BANKS,
  PAYMENT_METHODS,
  normalizePaymentMethod,
} from "@/lib/payment-method";
import {
  POSITIONS,
  categoryOptions,
  positionHasCategory,
} from "@/lib/employee-options";
import {
  DepartmentMultiSelect,
  type DepartmentOption,
} from "@/components/department-multi-select";
// One money parser. NOTE: hours/day, OT multiplier and efficiency threshold %
// below are NOT money and deliberately keep `parseFloat`.
import { moneyFieldToSen } from "@/lib/money-field";

/** Only what the drawer touches — the page owns the full Worker type. */
export type EmployeeDraft = {
  id: string;
  empNo: string;
  name: string;
  position: string;
  phone: string;
  status: string;
  basicSalarySen: number;
  workingHoursPerDay: number;
  workingDaysPerMonth: number;
  otMultiplier: number;
  efficiencyAllowanceSen: number;
  efficiencyThresholdPct: number;
  epfEnabled: boolean;
  socsoEnabled: boolean;
  eisEnabled: boolean;
  pcbEnabled: boolean;
  // PCB tax declaration. `null` means the employee has not declared it, and
  // that is a real state the payroll engine acts on: it prints "—" for PCB and
  // says it could not be computed, rather than printing RM 0.00 and claiming
  // no tax was due. Never pre-fill these with a plausible default — assuming
  // RESIDENT under-withholds from a non-resident by 30% of gross, assuming
  // SINGLE over-withholds from a married sole earner.
  taxResidency: string | null;
  taxCategory: string | null;
  /** Annual child relief in SEN, or null when undeclared. `0` is a real
   *  declaration (no children). Stored as the relief rather than a headcount
   *  because LHDN's per-child amount depends on the child. */
  taxChildReliefSen: number | null;
  joinDate: string;
  nationality: string;
  /** Every department the person works in; the FIRST is their primary/home. */
  departmentCodes: string[];
  /** Production lines they cover. Empty = all. */
  categories: string[];
  resignedAt: string;
  paymentMethod: string;
  bankName: string;
  bankAccount: string;
  /** Outsourced rather than own staff — drives the OSC-### series. */
  isOutsource: boolean;
  /** "MONTHLY" (default) or "DAILY". */
  payMode: string;
  /** Rate per day worked, sen. Only used when payMode is DAILY. */
  dailyRateSen: number;
};

export type { DepartmentOption };

type Props = {
  employee: EmployeeDraft | null;
  /** Departments to choose from — the SAME list the grid uses. */
  departments: DepartmentOption[];
  saving?: boolean;
  onClose: () => void;
  onSave: (draft: EmployeeDraft) => void;
};

const rm = (sen: number) => (Number(sen) || 0) / 100;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-[#E2DDD8] px-4 py-3">
      <h3 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[#6B5C32]">
        {title}
      </h3>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">{children}</div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
  full,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <label className={`text-[11px] text-[#6B7280] ${full ? "col-span-2" : ""}`}>
      {label}
      {children}
      {hint && <span className="mt-0.5 block text-[10px] text-[#9CA3AF]">{hint}</span>}
    </label>
  );
}

export function EmployeeDrawer({
  employee,
  departments,
  saving,
  onClose,
  onSave,
}: Props) {
  // Seeded once per mount. The caller passes key={employee.id}, so opening a
  // DIFFERENT person remounts with a fresh draft while a background refresh of
  // the list cannot wipe what is being typed — which a props-syncing effect
  // would have done, and which also made this a setState-inside-an-effect.
  const [draft, setDraft] = useState<EmployeeDraft | null>(employee);

  if (!employee || !draft) return null;
  const set = <K extends keyof EmployeeDraft>(k: K, v: EmployeeDraft[K]) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d));
  const isCash = normalizePaymentMethod(draft.paymentMethod) === "CASH";
  // A record holding a position this build no longer lists keeps it as a
  // choice, so opening the drawer on that person cannot silently retitle them
  // on the next save.
  const positionOptions: string[] = [...POSITIONS];
  if (draft.position && !positionOptions.includes(draft.position)) {
    positionOptions.unshift(draft.position);
  }
  if (!draft.position) positionOptions.unshift("");
  // Shown when they ARE resigned, and also whenever a date is already on the
  // record — otherwise flipping someone back to ACTIVE hides a stale leaving
  // date that nobody can see or clear.
  const showResignedAt = draft.status === "RESIGNED" || Boolean(draft.resignedAt);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div className="flex-1 bg-black/25" onClick={saving ? undefined : onClose} />
      <div className="flex h-full w-full max-w-[420px] flex-col bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-[#E2DDD8] px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-[#1F1D1B]">
              {draft.name || "—"}
            </div>
            <div className="mt-0.5 text-[11px] text-[#6B7280]">
              {draft.empNo}
              {draft.departmentCodes[0] ? ` · ${draft.departmentCodes[0].replace(/_/g, " ")}` : ""}
              {draft.position ? ` · ${draft.position}` : ""}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded p-1 text-[#6B7280] hover:bg-[#F3F4F6] disabled:opacity-40"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <Section title="Details">
            <Field label="Employee No">
              <Input
                value={draft.empNo}
                onChange={(e) => set("empNo", e.target.value)}
                className="mt-0.5 h-8 text-xs"
              />
            </Field>
            <Field label="Name">
              <Input
                value={draft.name}
                onChange={(e) => set("name", e.target.value)}
                className="mt-0.5 h-8 text-xs"
              />
            </Field>
            {/* Dropdown, not a text box — the grid and the Add form have always
                been a fixed two-item select, and a free-text Position here let
                a typo ("Operater Leader") silently drop someone out of every
                leader-scoped view. */}
            <Field label="Position">
              <select
                value={draft.position}
                onChange={(e) => set("position", e.target.value)}
                className="mt-0.5 h-8 w-full rounded-md border border-[#D8D2CC] bg-white px-2 text-xs"
              >
                {positionOptions.map((p) => (
                  <option key={p} value={p}>
                    {p || "—"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Phone">
              <Input
                value={draft.phone}
                onChange={(e) => set("phone", e.target.value)}
                className="mt-0.5 h-8 text-xs"
              />
            </Field>
            {/* The SAME control the grid's edit row uses — fourteen loose
                checkboxes here was a second design for one field (owner:
                「department太乱了 做成dropdown」). */}
            <Field label="Departments" hint="First one ticked is their primary department." full>
              <div className="mt-1">
                <DepartmentMultiSelect
                  selectedCodes={draft.departmentCodes}
                  allDepts={departments}
                  onChange={(codes) => set("departmentCodes", codes)}
                  className="w-full"
                />
              </div>
            </Field>
            {/* Category scopes an Operator Leader's Team dashboard, so it is
                meaningless on a plain Operator — hidden there, exactly as the
                grid cell and the Add form do it. */}
            {positionHasCategory(draft.position) && (
              <Field label="Category" hint='"All" covers every line.'>
                <select
                  value={draft.categories[0] ?? ""}
                  onChange={(e) =>
                    set("categories", e.target.value ? [e.target.value] : [])
                  }
                  className="mt-0.5 h-8 w-full rounded-md border border-[#D8D2CC] bg-white px-2 text-xs"
                >
                  <option value="">All</option>
                  {categoryOptions(draft.categories[0]).map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Status">
              <select
                value={draft.status}
                onChange={(e) => set("status", e.target.value)}
                className="mt-0.5 h-8 w-full rounded-md border border-[#D8D2CC] bg-white px-2 text-xs"
              >
                <option value="ACTIVE">ACTIVE</option>
                <option value="INACTIVE">INACTIVE</option>
                <option value="RESIGNED">RESIGNED</option>
              </select>
            </Field>
            {/* Required when resigned — the payroll engine scopes a resigned
                worker's final month by this date, so saving without it would
                pay them for months they were gone. */}
            {showResignedAt && (
              <Field
                label="Resigned on"
                hint={
                  draft.status === "RESIGNED"
                    ? "Required — payroll stops at this date."
                    : "Not resigned; this date is ignored and cleared on save."
                }
              >
                <Input
                  type="date"
                  value={draft.resignedAt || ""}
                  onChange={(e) => set("resignedAt", e.target.value)}
                  className="mt-0.5 h-8 text-xs"
                />
              </Field>
            )}
            <Field label="Join date">
              <Input
                type="date"
                value={draft.joinDate || ""}
                onChange={(e) => set("joinDate", e.target.value)}
                className="mt-0.5 h-8 text-xs"
              />
            </Field>
            <Field label="Nationality">
              <Input
                value={draft.nationality}
                onChange={(e) => set("nationality", e.target.value)}
                className="mt-0.5 h-8 text-xs"
              />
            </Field>
          </Section>

          <Section title="Pay">
            {/* Outsourced people are paid per DAY worked, not a monthly salary
                minus absences — someone who comes five days in a month would
                otherwise be recorded with 21 absences against a salary they
                were never on (owner 2026-08-02). */}
            <Field label="Employment" full>
              <label className="mt-1 flex items-center gap-2 text-[11px] text-[#374151]">
                <input
                  type="checkbox"
                  checked={draft.isOutsource}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setDraft((d) =>
                      d
                        ? {
                            ...d,
                            isOutsource: on,
                            // Turning it on defaults to per-day, which is the
                            // point of the flag; turning it off returns to the
                            // ordinary monthly rule.
                            payMode: on ? "DAILY" : "MONTHLY",
                          }
                        : d,
                    );
                  }}
                />
                Outsourced (paid per day, numbered OSC-###)
              </label>
            </Field>
            {draft.isOutsource && (
              <>
                <Field label="Pay basis">
                  <select
                    value={draft.payMode || "MONTHLY"}
                    onChange={(e) => set("payMode", e.target.value)}
                    className="mt-0.5 h-8 w-full rounded-md border border-[#D8D2CC] bg-white px-2 text-xs"
                  >
                    <option value="DAILY">Per day worked</option>
                    <option value="MONTHLY">Monthly salary</option>
                  </select>
                </Field>
                {draft.payMode === "DAILY" && (
                  <Field label="Rate per day (RM)" hint="Paid for each day they log.">
                    <Input
                      type="number"
                      value={rm(draft.dailyRateSen)}
                      onChange={(e) =>
                        set("dailyRateSen", moneyFieldToSen(e.target.value) ?? draft.dailyRateSen)
                      }
                      className="mt-0.5 h-8 text-xs"
                    />
                  </Field>
                )}
              </>
            )}
            {/* Basic salary and days/month are the MONTHLY model and mean
                nothing for someone paid per day — the day rate above is the
                whole of their pay, and showing a salary field invites someone
                to "fix" the zero and put a phantom salary on an outsourced
                person (owner 2026-08-02).

                HOURS/DAY IS DIFFERENT, and was wrongly hidden with them until
                2026-08-31. It is not part of the monthly model: it is the
                standard day — the thing a short day falls short OF and
                overtime goes above. Without it CHAU logged four hours against
                a nine-hour day and was paid the full RM 85. Owner: 「你应该先看
                他的工作时长，再看他的日薪」. It now sits outside this block. */}
            {draft.payMode !== "DAILY" && (
              <>
                <Field label="Basic salary (RM)">
                  <Input
                    type="number"
                    value={rm(draft.basicSalarySen)}
                    onChange={(e) =>
                      set("basicSalarySen", moneyFieldToSen(e.target.value) ?? draft.basicSalarySen)
                    }
                    className="mt-0.5 h-8 text-xs"
                  />
                </Field>
                <Field label="Days / month" hint="The divisor for the day rate.">
                  <Input
                    type="number"
                    value={draft.workingDaysPerMonth}
                    onChange={(e) => set("workingDaysPerMonth", parseInt(e.target.value) || 0)}
                    className="mt-0.5 h-8 text-xs"
                  />
                </Field>
              </>
            )}
            <Field
              label="Hours / day"
              hint="Their standard day — the OT threshold, and what a short day is short of."
            >
              <Input
                type="number"
                step="0.5"
                value={draft.workingHoursPerDay}
                onChange={(e) => set("workingHoursPerDay", parseFloat(e.target.value) || 0)}
                className="mt-0.5 h-8 text-xs"
              />
            </Field>
            {/* Overtime for per-day people was added 2026-08-31 (「也要放 OT
                rate」), so the multiplier now means something for them too. */}
            {(
              <Field label="OT multiplier">
                <Input
                  type="number"
                  step="0.1"
                  value={draft.otMultiplier}
                  onChange={(e) => set("otMultiplier", parseFloat(e.target.value) || 0)}
                  className="mt-0.5 h-8 text-xs"
                />
              </Field>
            )}
            <Field label="Eff. allowance (RM)">
              <Input
                type="number"
                value={rm(draft.efficiencyAllowanceSen)}
                onChange={(e) =>
                  set(
                    "efficiencyAllowanceSen",
                    moneyFieldToSen(e.target.value) ?? draft.efficiencyAllowanceSen,
                  )
                }
                className="mt-0.5 h-8 text-xs"
              />
            </Field>
            <Field label="Eff. threshold %">
              <Input
                type="number"
                min={0}
                max={100}
                value={draft.efficiencyThresholdPct}
                onChange={(e) => set("efficiencyThresholdPct", parseFloat(e.target.value) || 0)}
                className="mt-0.5 h-8 text-xs"
              />
            </Field>
          </Section>

          <Section title="How they are paid">
            <Field label="Method">
              <select
                value={normalizePaymentMethod(draft.paymentMethod)}
                onChange={(e) => set("paymentMethod", e.target.value)}
                className="mt-0.5 h-8 w-full rounded-md border border-[#D8D2CC] bg-white px-2 text-xs"
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
            {/* Cash hides the bank fields rather than greying them: an account
                left visible next to "Cash" is how someone gets paid twice. */}
            {!isCash && (
              <>
                <Field label="Bank">
                  <select
                    value={draft.bankName}
                    onChange={(e) => set("bankName", e.target.value)}
                    className="mt-0.5 h-8 w-full rounded-md border border-[#D8D2CC] bg-white px-2 text-xs"
                  >
                    <option value="">Select bank…</option>
                    {MALAYSIAN_BANKS.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Account number" full>
                  <Input
                    value={draft.bankAccount}
                    onChange={(e) => set("bankAccount", e.target.value)}
                    className="mt-0.5 h-8 text-xs"
                    placeholder="Account number"
                  />
                </Field>
              </>
            )}
          </Section>

          <Section title="Statutory">
            {([
              ["epfEnabled", "EPF"],
              ["socsoEnabled", "SOCSO"],
              ["eisEnabled", "EIS"],
              ["pcbEnabled", "PCB"],
            ] as Array<[keyof EmployeeDraft, string]>).map(([k, label]) => (
              <label key={String(k)} className="flex items-center gap-2 text-[11px] text-[#374151]">
                <input
                  type="checkbox"
                  checked={Boolean(draft[k])}
                  onChange={(e) => set(k, e.target.checked as never)}
                />
                {label}
              </label>
            ))}
          </Section>

          {/* Only shown when PCB is ON. For everyone else the answer is
              "no tax is withheld", and asking for a tax declaration nobody
              will use invites someone to fill it in with a guess. */}
          {draft.pcbEnabled && (
            <Section title="PCB tax declaration">
              <p className="col-span-2 text-[10px] leading-relaxed text-[#9CA3AF]">
                LHDN&rsquo;s monthly deduction is not a function of salary alone.
                Until these are recorded the payslip shows PCB as &ldquo;&mdash;&rdquo;
                and states that it could not be computed &mdash; it does not show
                RM&nbsp;0.00. Copy what the employee declared; do not estimate.
              </p>
              <Field label="Tax residency">
                <select
                  value={draft.taxResidency ?? ""}
                  onChange={(e) => set("taxResidency", (e.target.value || null) as never)}
                  className="mt-0.5 h-8 w-full rounded-md border border-[#D8D2CC] bg-white px-2 text-xs"
                >
                  <option value="">Not declared</option>
                  <option value="RESIDENT">Resident</option>
                  <option value="NON_RESIDENT">Non-resident (flat 30%)</option>
                </select>
              </Field>
              <Field label="Marital category">
                <select
                  value={draft.taxCategory ?? ""}
                  onChange={(e) => set("taxCategory", (e.target.value || null) as never)}
                  className="mt-0.5 h-8 w-full rounded-md border border-[#D8D2CC] bg-white px-2 text-xs"
                >
                  <option value="">Not declared</option>
                  <option value="SINGLE">Single</option>
                  <option value="MARRIED_SPOUSE_NOT_WORKING">Married, spouse not working</option>
                  <option value="MARRIED_SPOUSE_WORKING">Married, spouse working</option>
                </select>
              </Field>
              <Field label="Annual child relief (RM)" full>
                <Input
                  inputMode="decimal"
                  value={
                    draft.taxChildReliefSen === null || draft.taxChildReliefSen === undefined
                      ? ""
                      : String(draft.taxChildReliefSen / 100)
                  }
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    // Blank clears the declaration back to "not declared";
                    // "0" is a declaration of no children and must survive.
                    if (raw === "") {
                      set("taxChildReliefSen", null as never);
                      return;
                    }
                    set("taxChildReliefSen", moneyFieldToSen(raw) as never);
                  }}
                  className="mt-0.5 h-8 text-xs"
                  placeholder="Leave blank if not declared"
                />
                <p className="mt-1 text-[10px] leading-relaxed text-[#9CA3AF]">
                  RM&nbsp;2,000 per ordinary child; RM&nbsp;8,000 for a child
                  18+ in full-time tertiary education; RM&nbsp;6,000 disabled;
                  RM&nbsp;14,000 disabled and in tertiary education. Enter the
                  employee&rsquo;s declared total &mdash; a headcount &times; 2,000
                  would over-withhold from anyone with a child at university.
                </p>
              </Field>
            </Section>
          )}
        </div>

        {/* Buttons sit LEFT. The toast container is fixed bottom-6 right-6 at
            z-[9999] — the same corner a right-aligned Save would occupy, and
            above this drawer's z-50, so a toast from the previous save silently
            swallowed the next click on Save. The edit looked applied (the field
            was cleared on screen) and nothing reached the server. */}
        <div className="flex items-center gap-2 border-t border-[#E2DDD8] px-4 py-3">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => onSave(draft)} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default EmployeeDrawer;
