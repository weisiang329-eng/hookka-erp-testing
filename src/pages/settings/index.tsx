import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Building2,
  Hash,
  Factory,
  Monitor,
  Save,
  Check,
  Clock,
  Calendar,
  DollarSign,
} from "lucide-react";

// ---- Types ----

interface CompanyProfile {
  companyName: string;
  registrationNo: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  bankName: string;
  bankAccountNo: string;
}

interface NumberingRule {
  id: string;
  documentType: string;
  prefix: string;
  format: string;
  reset: "Monthly" | "Yearly";
  counter: number;
}

interface DepartmentConfig {
  code: string;
  name: string;
  color: string;
  workingHoursPerDay: number;
  workersAssigned: number;
}

interface WorkCalendar {
  workingDays: boolean[]; // Mon-Sun
  startTime: string;
  endTime: string;
  lunchBreakHours: number;
  efficiencyFactor: number;
}

interface LeadTime {
  departmentCode: string;
  departmentName: string;
  bedframeDays: number;
  sofaDays: number;
}

interface SpecialSurcharge {
  id: string;
  name: string;
  amountSen: number;
}

interface SystemSettings {
  currency: string;
  currencySymbol: string;
  dateFormat: string;
  timezone: string;
  timezoneAbbr: string;
  utcOffset: string;
  language: string;
  sessionTimeoutHours: number;
  maxConcurrentSessions: number;
  fiscalYearStartMonth: string;
  fiscalYearEndMonth: string;
  systemVersion: string;
}

// ---- Defaults ----

const defaultHookka: CompanyProfile = {
  companyName: "HOOKKA INDUSTRIES SDN BHD",
  registrationNo: "202301XXXXXX (XXXXXXX-X)",
  address: "Lot 7, Jalan PUJ 3/12, Taman Puncak Jalil, 43300 Seri Kembangan, Selangor",
  phone: "+60 3-XXXX XXXX",
  email: "info@hookka.com.my",
  website: "www.hookka.com.my",
  bankName: "Maybank",
  bankAccountNo: "XXXX-XXXX-XXXX",
};

const defaultOhana: CompanyProfile = {
  companyName: "OHANA MARKETING",
  registrationNo: "XXXXXXXXXX (XXXXXXX-X)",
  address: "Lot 7, Jalan PUJ 3/12, Taman Puncak Jalil, 43300 Seri Kembangan, Selangor",
  phone: "+60 3-XXXX XXXX",
  email: "info@ohanamarketing.com.my",
  website: "www.ohanamarketing.com.my",
  bankName: "CIMB Bank",
  bankAccountNo: "XXXX-XXXX-XXXX",
};

const defaultNumbering: NumberingRule[] = [
  { id: "nr-1", documentType: "Sales Order", prefix: "SO", format: "SO-YYMM-XXX", reset: "Monthly", counter: 1 },
  { id: "nr-2", documentType: "Delivery Order", prefix: "DO", format: "DO-YYMM-XXX", reset: "Monthly", counter: 1 },
  { id: "nr-3", documentType: "Purchase Order", prefix: "PO", format: "PO-YYMM-XXX", reset: "Monthly", counter: 1 },
  { id: "nr-4", documentType: "Invoice", prefix: "INV", format: "INV-YYMM-XXX", reset: "Monthly", counter: 1 },
  { id: "nr-5", documentType: "Production Order", prefix: "PO-INT", format: "PO-INT-YYMM-XXX", reset: "Monthly", counter: 1 },
  { id: "nr-6", documentType: "QC Inspection", prefix: "QC", format: "QC-YYMM-XXX", reset: "Monthly", counter: 1 },
  { id: "nr-7", documentType: "Journal Entry", prefix: "JE", format: "JE-YYMM-XXXX", reset: "Monthly", counter: 1 },
];

const defaultDepartments: DepartmentConfig[] = [
  { code: "FAB_CUT", name: "Fabric Cutting", color: "#3B82F6", workingHoursPerDay: 9, workersAssigned: 8 },
  { code: "FAB_SEW", name: "Fabric Sewing", color: "#6366F1", workingHoursPerDay: 9, workersAssigned: 12 },
  { code: "WOOD_CUT", name: "Wood Cutting", color: "#F59E0B", workingHoursPerDay: 9, workersAssigned: 6 },
  { code: "FOAM", name: "Foam Bonding", color: "#8B5CF6", workingHoursPerDay: 9, workersAssigned: 5 },
  { code: "FRAMING", name: "Framing", color: "#F97316", workingHoursPerDay: 9, workersAssigned: 8 },
  { code: "WEBBING", name: "Webbing", color: "#10B981", workingHoursPerDay: 9, workersAssigned: 4 },
  { code: "UPHOLSTERY", name: "Upholstery", color: "#F43F5E", workingHoursPerDay: 9, workersAssigned: 15 },
  { code: "PACKING", name: "Packing", color: "#06B6D4", workingHoursPerDay: 9, workersAssigned: 6 },
];

const defaultWorkCalendar: WorkCalendar = {
  workingDays: [true, true, true, true, true, true, false], // Mon-Sat on, Sun off
  startTime: "08:00",
  endTime: "18:00",
  lunchBreakHours: 1,
  efficiencyFactor: 85,
};

const defaultLeadTimes: LeadTime[] = [
  { departmentCode: "FAB_CUT", departmentName: "Fabric Cutting", bedframeDays: 1, sofaDays: 2 },
  { departmentCode: "FAB_SEW", departmentName: "Fabric Sewing", bedframeDays: 2, sofaDays: 3 },
  { departmentCode: "WOOD_CUT", departmentName: "Wood Cutting", bedframeDays: 1, sofaDays: 1 },
  { departmentCode: "FOAM", departmentName: "Foam Bonding", bedframeDays: 1, sofaDays: 1 },
  { departmentCode: "FRAMING", departmentName: "Framing", bedframeDays: 1, sofaDays: 2 },
  { departmentCode: "WEBBING", departmentName: "Webbing", bedframeDays: 1, sofaDays: 1 },
  { departmentCode: "UPHOLSTERY", departmentName: "Upholstery", bedframeDays: 2, sofaDays: 3 },
  { departmentCode: "PACKING", departmentName: "Packing", bedframeDays: 1, sofaDays: 1 },
];

const defaultSurcharges: SpecialSurcharge[] = [
  { id: "sc-1", name: "HB Fully Cover", amountSen: 5000 },
  { id: "sc-2", name: "Divan Top Fully Cover", amountSen: 5000 },
  { id: "sc-3", name: "Divan Full Cover", amountSen: 8000 },
  { id: "sc-4", name: "Left Drawer", amountSen: 15000 },
  { id: "sc-5", name: "Right Drawer", amountSen: 15000 },
  { id: "sc-6", name: "Front Drawer", amountSen: 12000 },
  { id: "sc-7", name: "1 Piece Divan", amountSen: 25000 },
  { id: "sc-8", name: "Divan Curve", amountSen: 5000 },
  { id: "sc-9", name: "No Side Panel", amountSen: 4000 },
];

const defaultSystem: SystemSettings = {
  currency: "MYR",
  currencySymbol: "RM",
  dateFormat: "DD/MM/YYYY",
  timezone: "Asia/Kuala_Lumpur",
  timezoneAbbr: "MYT",
  utcOffset: "UTC+8",
  language: "English",
  sessionTimeoutHours: 8,
  maxConcurrentSessions: 3,
  fiscalYearStartMonth: "January",
  fiscalYearEndMonth: "December",
  systemVersion: "1.0.0",
};

// ---- Storage Keys ----
const LS_HOOKKA = "hookka-settings-company-hookka";
const LS_OHANA = "hookka-settings-company-ohana";
const LS_NUMBERING = "hookka-settings-numbering";
const LS_DEPARTMENTS = "hookka-settings-departments";
const LS_WORK_CALENDAR = "hookka-settings-work-calendar";
const LS_LEAD_TIMES = "hookka-settings-lead-times";
const LS_SURCHARGES = "hookka-settings-surcharges";
const LS_SYSTEM = "hookka-settings-system";

function loadJSON<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON<T>(key: string, data: T): void {
  localStorage.setItem(key, JSON.stringify(data));
}

// ---- Tabs ----
const tabs = [
  { id: "company", label: "Company Profile", icon: Building2 },
  { id: "numbering", label: "Numbering", icon: Hash },
  { id: "production", label: "Production", icon: Factory },
  { id: "system", label: "System", icon: Monitor },
] as const;

type TabId = (typeof tabs)[number]["id"];

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ---- Helper Component: Toast ----
function SaveToast({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg bg-[#1F1D1B] px-4 py-3 text-sm text-white shadow-lg animate-in fade-in slide-in-from-bottom-2">
      <Check className="h-4 w-4 text-emerald-400" />
      Settings saved successfully
    </div>
  );
}

// ---- Main Page ----
export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<TabId>("company");
  const [showToast, setShowToast] = useState(false);

  // Company Profile state
  const [hookka, setHookka] = useState<CompanyProfile>(defaultHookka);
  const [ohana, setOhana] = useState<CompanyProfile>(defaultOhana);

  // Numbering state
  const [numbering, setNumbering] = useState<NumberingRule[]>(defaultNumbering);

  // Production state
  const [deptConfig, setDeptConfig] = useState<DepartmentConfig[]>(defaultDepartments);
  const [workCalendar, setWorkCalendar] = useState<WorkCalendar>(defaultWorkCalendar);
  const [leadTimes, setLeadTimes] = useState<LeadTime[]>(defaultLeadTimes);
  const [surcharges, setSurcharges] = useState<SpecialSurcharge[]>(defaultSurcharges);

  // System state
  const [systemSettings, setSystemSettings] = useState<SystemSettings>(defaultSystem);

  // Load from localStorage on mount
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot mount-time hydrate from localStorage */
  useEffect(() => {
    setHookka(loadJSON(LS_HOOKKA, defaultHookka));
    setOhana(loadJSON(LS_OHANA, defaultOhana));
    setNumbering(loadJSON(LS_NUMBERING, defaultNumbering));
    setDeptConfig(loadJSON(LS_DEPARTMENTS, defaultDepartments));
    setWorkCalendar(loadJSON(LS_WORK_CALENDAR, defaultWorkCalendar));
    setLeadTimes(loadJSON(LS_LEAD_TIMES, defaultLeadTimes));
    setSurcharges(loadJSON(LS_SURCHARGES, defaultSurcharges));
    setSystemSettings(loadJSON(LS_SYSTEM, defaultSystem));
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const flash = useCallback(() => {
    setShowToast(true);
    // Fire-and-forget toast hide; called from save-button click handler.
    // eslint-disable-next-line no-restricted-syntax -- one-shot toast timer from event handler
    setTimeout(() => setShowToast(false), 2000);
  }, []);

  // Generate preview number
  const previewNumber = (rule: NumberingRule) => {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const digits = rule.format.includes("XXXX") ? 4 : 3;
    const seq = String(rule.counter).padStart(digits, "0");
    return `${rule.prefix}-${yy}${mm}-${seq}`;
  };

  // ---- Renderers ----

  const renderCompanyForm = (
    profile: CompanyProfile,
    setProfile: React.Dispatch<React.SetStateAction<CompanyProfile>>,
    title: string,
    description: string
  ) => {
    const update = (field: keyof CompanyProfile, value: string) =>
      setProfile((prev) => ({ ...prev, [field]: value }));

    const fields: { label: string; field: keyof CompanyProfile; disabled?: boolean; colSpan?: number }[] = [
      { label: "Company Name", field: "companyName" },
      { label: "Registration No.", field: "registrationNo" },
      { label: "Address", field: "address", colSpan: 2 },
      { label: "Phone", field: "phone" },
      { label: "Email", field: "email" },
      { label: "Website", field: "website" },
      { label: "Bank Name", field: "bankName" },
      { label: "Bank Account No.", field: "bankAccountNo" },
    ];

    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
            {fields.map((f) => (
              <div key={f.field} className={f.colSpan === 2 ? "md:col-span-2" : ""}>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">{f.label}</label>
                <Input
                  value={profile[f.field]}
                  onChange={(e) => update(f.field, e.target.value)}
                  disabled={f.disabled}
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  };

  const renderCompanyTab = () => (
    <div className="space-y-6">
      {renderCompanyForm(hookka, setHookka, "HOOKKA INDUSTRIES SDN BHD", "Primary manufacturing entity")}
      {renderCompanyForm(ohana, setOhana, "OHANA MARKETING", "B2B trading entity")}
      <div className="flex justify-end">
        <Button
          variant="primary"
          onClick={() => {
            saveJSON(LS_HOOKKA, hookka);
            saveJSON(LS_OHANA, ohana);
            flash();
          }}
        >
          <Save className="h-4 w-4" />
          Save Changes
        </Button>
      </div>
    </div>
  );

  const renderNumberingTab = () => (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Document Numbering Configuration</CardTitle>
          <CardDescription>Define prefix, format, and reset rules for each document type</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8]">
                  <th className="text-left py-3 px-3 font-medium text-[#374151]">Document Type</th>
                  <th className="text-left py-3 px-3 font-medium text-[#374151]">Prefix</th>
                  <th className="text-left py-3 px-3 font-medium text-[#374151]">Format</th>
                  <th className="text-left py-3 px-3 font-medium text-[#374151]">Reset</th>
                  <th className="text-left py-3 px-3 font-medium text-[#374151]">Preview Next</th>
                  <th className="text-right py-3 px-3 font-medium text-[#374151]"></th>
                </tr>
              </thead>
              <tbody>
                {numbering.map((rule, idx) => (
                  <tr key={rule.id} className="border-b border-[#F0ECE9] hover:bg-[#F0ECE9]/40 transition-colors">
                    <td className="py-3 px-3 font-medium text-[#1F1D1B]">{rule.documentType}</td>
                    <td className="py-3 px-3">
                      <Input
                        className="w-28 h-8 text-xs"
                        value={rule.prefix}
                        onChange={(e) => {
                          const updated = [...numbering];
                          updated[idx] = { ...updated[idx], prefix: e.target.value };
                          setNumbering(updated);
                        }}
                      />
                    </td>
                    <td className="py-3 px-3">
                      <code className="rounded bg-[#F0ECE9] px-2 py-1 text-xs text-[#6B5C32]">{rule.format}</code>
                    </td>
                    <td className="py-3 px-3">
                      <select
                        className="h-8 rounded-md border border-[#E2DDD8] bg-white px-2 text-xs text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                        value={rule.reset}
                        onChange={(e) => {
                          const updated = [...numbering];
                          updated[idx] = { ...updated[idx], reset: e.target.value as "Monthly" | "Yearly" };
                          setNumbering(updated);
                        }}
                      >
                        <option value="Monthly">Monthly</option>
                        <option value="Yearly">Yearly</option>
                      </select>
                    </td>
                    <td className="py-3 px-3">
                      <span className="font-mono text-xs text-[#6B5C32] bg-[#F0ECE9] px-2 py-1 rounded">{previewNumber(rule)}</span>
                    </td>
                    <td className="py-3 px-3 text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          saveJSON(LS_NUMBERING, numbering);
                          flash();
                        }}
                      >
                        <Save className="h-3 w-3" />
                        Save
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );

  const renderProductionTab = () => (
    <div className="space-y-6">
      {/* Department Configuration */}
      <Card>
        <CardHeader>
          <CardTitle>Department Configuration</CardTitle>
          <CardDescription>8 production departments and their settings</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8]">
                  <th className="text-left py-3 px-3 font-medium text-[#374151]">Department</th>
                  <th className="text-left py-3 px-3 font-medium text-[#374151]">Code</th>
                  <th className="text-left py-3 px-3 font-medium text-[#374151]">Color</th>
                  <th className="text-left py-3 px-3 font-medium text-[#374151]">Hours/Day</th>
                  <th className="text-left py-3 px-3 font-medium text-[#374151]">Workers</th>
                </tr>
              </thead>
              <tbody>
                {deptConfig.map((dept, idx) => (
                  <tr key={dept.code} className="border-b border-[#F0ECE9] hover:bg-[#F0ECE9]/40 transition-colors">
                    <td className="py-3 px-3 font-medium text-[#1F1D1B]">{dept.name}</td>
                    <td className="py-3 px-3">
                      <code className="rounded bg-[#F0ECE9] px-2 py-1 text-xs">{dept.code}</code>
                    </td>
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-block h-5 w-5 rounded-full border border-[#E2DDD8]"
                          style={{ backgroundColor: dept.color }}
                        />
                        <span className="text-xs text-[#6B7280]">{dept.color}</span>
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <Input
                        type="number"
                        className="w-20 h-8 text-xs"
                        value={dept.workingHoursPerDay}
                        min={1}
                        max={24}
                        onChange={(e) => {
                          const updated = [...deptConfig];
                          updated[idx] = { ...updated[idx], workingHoursPerDay: Number(e.target.value) };
                          setDeptConfig(updated);
                        }}
                      />
                    </td>
                    <td className="py-3 px-3">
                      <Input
                        type="number"
                        className="w-20 h-8 text-xs"
                        value={dept.workersAssigned}
                        min={0}
                        onChange={(e) => {
                          const updated = [...deptConfig];
                          updated[idx] = { ...updated[idx], workersAssigned: Number(e.target.value) };
                          setDeptConfig(updated);
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Working Calendar */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-[#6B5C32]" />
            <div>
              <CardTitle>Working Calendar</CardTitle>
              <CardDescription>Working days, hours, and efficiency settings</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            {/* Working Days */}
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-3">Working Days</label>
              <div className="flex gap-2 flex-wrap">
                {DAY_LABELS.map((day, idx) => (
                  <button
                    key={day}
                    type="button"
                    onClick={() => {
                      const updated = { ...workCalendar };
                      updated.workingDays = [...updated.workingDays];
                      updated.workingDays[idx] = !updated.workingDays[idx];
                      setWorkCalendar(updated);
                    }}
                    className={`px-4 py-2 rounded-md text-sm font-medium border transition-colors cursor-pointer ${
                      workCalendar.workingDays[idx]
                        ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                        : "bg-white text-[#6B7280] border-[#E2DDD8] hover:bg-[#F0ECE9]"
                    }`}
                  >
                    {day}
                  </button>
                ))}
              </div>
            </div>

            {/* Working Hours */}
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 md:grid-cols-4">
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Start Time</label>
                <div className="relative">
                  <Clock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#6B7280]" />
                  <Input
                    type="time"
                    className="pl-10"
                    value={workCalendar.startTime}
                    onChange={(e) => setWorkCalendar({ ...workCalendar, startTime: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">End Time</label>
                <div className="relative">
                  <Clock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#6B7280]" />
                  <Input
                    type="time"
                    className="pl-10"
                    value={workCalendar.endTime}
                    onChange={(e) => setWorkCalendar({ ...workCalendar, endTime: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Lunch Break (hrs)</label>
                <Input
                  type="number"
                  value={workCalendar.lunchBreakHours}
                  min={0}
                  max={3}
                  step={0.5}
                  onChange={(e) => setWorkCalendar({ ...workCalendar, lunchBreakHours: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Efficiency Factor (%)</label>
                <Input
                  type="number"
                  value={workCalendar.efficiencyFactor}
                  min={0}
                  max={100}
                  onChange={(e) => setWorkCalendar({ ...workCalendar, efficiencyFactor: Number(e.target.value) })}
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Lead Times */}
      <Card>
        <CardHeader>
          <CardTitle>Lead Times by Product Category</CardTitle>
          <CardDescription>Average processing days per department</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8]">
                  <th className="text-left py-3 px-3 font-medium text-[#374151]">Department</th>
                  <th className="text-left py-3 px-3 font-medium text-[#374151]">Bedframe (days)</th>
                  <th className="text-left py-3 px-3 font-medium text-[#374151]">Sofa (days)</th>
                </tr>
              </thead>
              <tbody>
                {leadTimes.map((lt, idx) => (
                  <tr key={lt.departmentCode} className="border-b border-[#F0ECE9] hover:bg-[#F0ECE9]/40 transition-colors">
                    <td className="py-3 px-3 font-medium text-[#1F1D1B]">{lt.departmentName}</td>
                    <td className="py-3 px-3">
                      <Input
                        type="number"
                        className="w-20 h-8 text-xs"
                        value={lt.bedframeDays}
                        min={0}
                        onChange={(e) => {
                          const updated = [...leadTimes];
                          updated[idx] = { ...updated[idx], bedframeDays: Number(e.target.value) };
                          setLeadTimes(updated);
                        }}
                      />
                    </td>
                    <td className="py-3 px-3">
                      <Input
                        type="number"
                        className="w-20 h-8 text-xs"
                        value={lt.sofaDays}
                        min={0}
                        onChange={(e) => {
                          const updated = [...leadTimes];
                          updated[idx] = { ...updated[idx], sofaDays: Number(e.target.value) };
                          setLeadTimes(updated);
                        }}
                      />
                    </td>
                  </tr>
                ))}
                <tr className="bg-[#F0ECE9]/60 font-medium">
                  <td className="py-3 px-3 text-[#1F1D1B]">Total</td>
                  <td className="py-3 px-3 text-[#6B5C32]">{leadTimes.reduce((s, lt) => s + lt.bedframeDays, 0)} days</td>
                  <td className="py-3 px-3 text-[#6B5C32]">{leadTimes.reduce((s, lt) => s + lt.sofaDays, 0)} days</td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Special Order Surcharges */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-[#6B5C32]" />
            <div>
              <CardTitle>Special Order Surcharges</CardTitle>
              <CardDescription>Additional charges for special order configurations</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8]">
                  <th className="text-left py-3 px-3 font-medium text-[#374151]">Option</th>
                  <th className="text-left py-3 px-3 font-medium text-[#374151]">Amount (RM)</th>
                </tr>
              </thead>
              <tbody>
                {surcharges.map((sc, idx) => (
                  <tr key={sc.id} className="border-b border-[#F0ECE9] hover:bg-[#F0ECE9]/40 transition-colors">
                    <td className="py-3 px-3 font-medium text-[#1F1D1B]">{sc.name}</td>
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-[#6B7280]">RM</span>
                        <Input
                          type="number"
                          className="w-28 h-8 text-xs"
                          value={sc.amountSen / 100}
                          min={0}
                          step={5}
                          onChange={(e) => {
                            const updated = [...surcharges];
                            updated[idx] = { ...updated[idx], amountSen: Math.round(Number(e.target.value) * 100) };
                            setSurcharges(updated);
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Save Production Settings */}
      <div className="flex justify-end">
        <Button
          variant="primary"
          onClick={() => {
            saveJSON(LS_DEPARTMENTS, deptConfig);
            saveJSON(LS_WORK_CALENDAR, workCalendar);
            saveJSON(LS_LEAD_TIMES, leadTimes);
            saveJSON(LS_SURCHARGES, surcharges);
            flash();
          }}
        >
          <Save className="h-4 w-4" />
          Save Production Settings
        </Button>
      </div>
    </div>
  );

  const renderSystemTab = () => {
    const MONTHS = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];

    return (
      <div className="space-y-6">
        {/* Display Settings */}
        <Card>
          <CardHeader>
            <CardTitle>Display Settings</CardTitle>
            <CardDescription>Regional and formatting preferences</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Currency</label>
                <Input value={`${systemSettings.currency} (${systemSettings.currencySymbol})`} disabled />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Date Format</label>
                <select
                  className="flex h-10 w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  value={systemSettings.dateFormat}
                  onChange={(e) => setSystemSettings({ ...systemSettings, dateFormat: e.target.value })}
                >
                  <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                  <option value="MM/DD/YYYY">MM/DD/YYYY</option>
                  <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Timezone</label>
                <Input value={`${systemSettings.timezone} (${systemSettings.timezoneAbbr}, ${systemSettings.utcOffset})`} disabled />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Language</label>
                <Input value={systemSettings.language} disabled />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Session Settings */}
        <Card>
          <CardHeader>
            <CardTitle>Session Settings</CardTitle>
            <CardDescription>Security and session management</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Session Timeout (hours)</label>
                <Input
                  type="number"
                  value={systemSettings.sessionTimeoutHours}
                  min={1}
                  max={24}
                  onChange={(e) =>
                    setSystemSettings({ ...systemSettings, sessionTimeoutHours: Number(e.target.value) })
                  }
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Max Concurrent Sessions</label>
                <Input
                  type="number"
                  value={systemSettings.maxConcurrentSessions}
                  min={1}
                  max={10}
                  onChange={(e) =>
                    setSystemSettings({ ...systemSettings, maxConcurrentSessions: Number(e.target.value) })
                  }
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Fiscal Year */}
        <Card>
          <CardHeader>
            <CardTitle>Fiscal Year</CardTitle>
            <CardDescription>Financial year boundaries</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Start Month</label>
                <select
                  className="flex h-10 w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  value={systemSettings.fiscalYearStartMonth}
                  onChange={(e) => setSystemSettings({ ...systemSettings, fiscalYearStartMonth: e.target.value })}
                >
                  {MONTHS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">End Month</label>
                <select
                  className="flex h-10 w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  value={systemSettings.fiscalYearEndMonth}
                  onChange={(e) => setSystemSettings({ ...systemSettings, fiscalYearEndMonth: e.target.value })}
                >
                  {MONTHS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Data & Version */}
        <Card>
          <CardHeader>
            <CardTitle>System Information</CardTitle>
            <CardDescription>Read-only system statistics</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 md:grid-cols-4">
              {[
                { label: "Total Users", value: "5" },
                { label: "Total Records", value: "1,247" },
                { label: "System Version", value: systemSettings.systemVersion },
                { label: "Last Backup", value: "14/04/2026, 02:00" },
              ].map((item) => (
                <div key={item.label} className="rounded-lg border border-[#E2DDD8] bg-[#F0ECE9]/50 p-4">
                  <p className="text-xs text-[#6B7280] mb-1">{item.label}</p>
                  <p className="text-lg font-semibold text-[#1F1D1B]">{item.value}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Save System Settings */}
        <div className="flex justify-end">
          <Button
            variant="primary"
            onClick={() => {
              saveJSON(LS_SYSTEM, systemSettings);
              flash();
            }}
          >
            <Save className="h-4 w-4" />
            Save System Settings
          </Button>
        </div>
      </div>
    );
  };

  // ---- Main Render ----
  return (
    <div className="space-y-6">
      <SaveToast show={showToast} />

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-[#1F1D1B]">Settings</h1>
        <p className="text-xs text-[#6B7280]">System administration and configuration</p>
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-1 border-b border-[#E2DDD8]">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
                isActive
                  ? "border-[#6B5C32] text-[#6B5C32]"
                  : "border-transparent text-[#6B7280] hover:text-[#1F1D1B] hover:border-[#E2DDD8]"
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      {activeTab === "company" && renderCompanyTab()}
      {activeTab === "numbering" && renderNumberingTab()}
      {activeTab === "production" && renderProductionTab()}
      {activeTab === "system" && renderSystemTab()}
    </div>
  );
}
