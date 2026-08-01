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
};

export type DepartmentOption = { code: string; name: string };

type Props = {
  employee: EmployeeDraft | null;
  /** Departments to choose from — the SAME list the grid uses. */
  departments: DepartmentOption[];
  /** Production lines to choose from. */
  categories: readonly string[];
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
  categories,
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
            <Field label="Position">
              <Input
                value={draft.position}
                onChange={(e) => set("position", e.target.value)}
                className="mt-0.5 h-8 text-xs"
              />
            </Field>
            <Field label="Phone">
              <Input
                value={draft.phone}
                onChange={(e) => set("phone", e.target.value)}
                className="mt-0.5 h-8 text-xs"
              />
            </Field>
            <Field label="Departments" hint="First one ticked is their primary department." full>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {departments.map((d) => {
                  const on = draft.departmentCodes.includes(d.code);
                  return (
                    <label key={d.code} className="flex items-center gap-1 text-[11px] text-[#374151]">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          set(
                            "departmentCodes",
                            on
                              ? draft.departmentCodes.filter((c) => c !== d.code)
                              : [...draft.departmentCodes, d.code],
                          )
                        }
                      />
                      {d.name}
                    </label>
                  );
                })}
              </div>
            </Field>
            <Field label="Category" hint="Leave all unticked to cover every line." full>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {categories.map((cat) => {
                  const on = draft.categories.includes(cat);
                  return (
                    <label key={cat} className="flex items-center gap-1 text-[11px] text-[#374151]">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          set(
                            "categories",
                            on
                              ? draft.categories.filter((c) => c !== cat)
                              : [...draft.categories, cat],
                          )
                        }
                      />
                      {cat}
                    </label>
                  );
                })}
              </div>
            </Field>
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
            {draft.status === "RESIGNED" && (
              <Field label="Resigned on">
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
            <Field label="Basic salary (RM)">
              <Input
                type="number"
                value={rm(draft.basicSalarySen)}
                onChange={(e) =>
                  set("basicSalarySen", Math.round((parseFloat(e.target.value) || 0) * 100))
                }
                className="mt-0.5 h-8 text-xs"
              />
            </Field>
            <Field label="OT multiplier">
              <Input
                type="number"
                step="0.1"
                value={draft.otMultiplier}
                onChange={(e) => set("otMultiplier", parseFloat(e.target.value) || 0)}
                className="mt-0.5 h-8 text-xs"
              />
            </Field>
            <Field label="Hours / day" hint="Their standard day — also the OT threshold.">
              <Input
                type="number"
                step="0.5"
                value={draft.workingHoursPerDay}
                onChange={(e) => set("workingHoursPerDay", parseFloat(e.target.value) || 0)}
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
            <Field label="Eff. allowance (RM)">
              <Input
                type="number"
                value={rm(draft.efficiencyAllowanceSen)}
                onChange={(e) =>
                  set(
                    "efficiencyAllowanceSen",
                    Math.round((parseFloat(e.target.value) || 0) * 100),
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
