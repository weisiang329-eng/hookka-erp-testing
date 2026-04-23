import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency, formatDateDMY, formatRM } from "@/lib/utils";
import { COA_TYPE_COLOR, SUCCESS, DANGER, INFO, WARNING, ACCENT_PLUM } from "@/lib/design-tokens";
import {
  BookOpen,
  TrendingUp,
  TrendingDown,
  DollarSign,
  FileText,
  ArrowUpRight,
  ArrowDownRight,
  Plus,
  ChevronRight,
  ChevronDown as ChevronDownIcon,
  Trash2,
  Check,
  X,
  CreditCard,
  LayoutDashboard,
  List,
  Users,
  Building2,
  BarChart3,
  Scale,
  Download,
  Filter,
  PieChart,
} from "lucide-react";
import type {
  ChartOfAccount,
  JournalEntry,
  JournalLine,
  ARAgingEntry,
  APAgingEntry,
  PLEntry,
  BalanceSheetEntry,
} from "@/lib/mock-data";

// =============== TYPES ===============

type TabKey = "overview" | "coa" | "journals" | "ar" | "ap" | "pl" | "bs";

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: "overview", label: "Overview", icon: <LayoutDashboard className="h-4 w-4" /> },
  { key: "pl", label: "P&L Report", icon: <BarChart3 className="h-4 w-4" /> },
  { key: "bs", label: "Balance Sheet", icon: <Scale className="h-4 w-4" /> },
  { key: "coa", label: "Chart of Accounts", icon: <List className="h-4 w-4" /> },
  { key: "journals", label: "Journal Entries", icon: <BookOpen className="h-4 w-4" /> },
  { key: "ar", label: "Accounts Receivable", icon: <Users className="h-4 w-4" /> },
  { key: "ap", label: "Accounts Payable", icon: <Building2 className="h-4 w-4" /> },
];

// =============== MAIN PAGE ===============

export default function AccountingPage() {
  const [tab, setTab] = useState<TabKey>("overview");
  const [accounts, setAccounts] = useState<ChartOfAccount[]>([]);
  const [journals, setJournals] = useState<JournalEntry[]>([]);
  const [arData, setArData] = useState<ARAgingEntry[]>([]);
  const [apData, setApData] = useState<APAgingEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch("/api/accounting/coa").then((r) => r.json()),
      fetch("/api/accounting/journals").then((r) => r.json()),
      fetch("/api/accounting/aging").then((r) => r.json()),
    ])
      .then(([coaRes, jeRes, agingRes]) => {
        if (coaRes.success) setAccounts(coaRes.data);
        if (jeRes.success) setJournals(jeRes.data);
        if (agingRes.success) {
          setArData(agingRes.data.ar);
          setApData(agingRes.data.ap);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Accounting</h1>
          <p className="text-xs text-[#6B7280]">General ledger, accounts receivable, and accounts payable</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#E2DDD8]">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
              tab === t.key
                ? "border-[#6B5C32] text-[#6B5C32]"
                : "border-transparent text-[#6B7280] hover:text-[#1F1D1B] hover:border-[#E2DDD8]"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="text-[#6B7280]">Loading accounting data...</div>
        </div>
      ) : (
        <>
          {tab === "overview" && (
            <OverviewTab accounts={accounts} journals={journals} arData={arData} apData={apData} />
          )}
          {tab === "pl" && <PLReportTab />}
          {tab === "bs" && <BalanceSheetTab />}
          {tab === "coa" && <COATab accounts={accounts} onRefresh={fetchAll} />}
          {tab === "journals" && (
            <JournalsTab journals={journals} accounts={accounts} onRefresh={fetchAll} />
          )}
          {tab === "ar" && <ARTab arData={arData} onRefresh={fetchAll} />}
          {tab === "ap" && <APTab apData={apData} onRefresh={fetchAll} />}
        </>
      )}
    </div>
  );
}

// =============== TAB 1: OVERVIEW ===============

function OverviewTab({
  accounts,
  journals,
  arData,
  apData,
}: {
  accounts: ChartOfAccount[];
  journals: JournalEntry[];
  arData: ARAgingEntry[];
  apData: APAgingEntry[];
}) {
  const revenue = accounts
    .filter((a) => a.type === "REVENUE" && a.parentCode)
    .reduce((s, a) => s + a.balance, 0);
  const expenses = accounts
    .filter((a) => a.type === "EXPENSE" && a.parentCode)
    .reduce((s, a) => s + a.balance, 0);
  const netProfit = revenue - expenses;
  const totalAR = arData.reduce(
    (s, a) => s + a.currentSen + a.days30Sen + a.days60Sen + a.days90Sen + a.over90Sen,
    0
  );
  const totalAP = apData.reduce(
    (s, a) => s + a.currentSen + a.days30Sen + a.days60Sen + a.days90Sen + a.over90Sen,
    0
  );

  // Aggregate aging buckets
  const arBuckets = [
    { period: "Current", amountSen: arData.reduce((s, a) => s + a.currentSen, 0) },
    { period: "1-30 days", amountSen: arData.reduce((s, a) => s + a.days30Sen, 0) },
    { period: "31-60 days", amountSen: arData.reduce((s, a) => s + a.days60Sen, 0) },
    { period: "61-90 days", amountSen: arData.reduce((s, a) => s + a.days90Sen, 0) },
    { period: "90+ days", amountSen: arData.reduce((s, a) => s + a.over90Sen, 0) },
  ];
  const apBuckets = [
    { period: "Current", amountSen: apData.reduce((s, a) => s + a.currentSen, 0) },
    { period: "1-30 days", amountSen: apData.reduce((s, a) => s + a.days30Sen, 0) },
    { period: "31-60 days", amountSen: apData.reduce((s, a) => s + a.days60Sen, 0) },
    { period: "61-90 days", amountSen: apData.reduce((s, a) => s + a.days90Sen, 0) },
    { period: "90+ days", amountSen: apData.reduce((s, a) => s + a.over90Sen, 0) },
  ];

  const recentJournals = journals.slice(0, 5);

  const recentColumns: Column<JournalEntry>[] = [
    {
      key: "entryNo",
      label: "Entry No.",
      render: (value, row) => <span className="doc-number font-medium">{row.entryNo}</span>,
    },
    {
      key: "date",
      label: "Date",
      render: (value, row) => <span className="text-[#4B5563]">{formatDateDMY(row.date)}</span>,
    },
    {
      key: "description",
      label: "Description",
      render: (value, row) => <span className="font-medium text-[#1F1D1B]">{row.description}</span>,
    },
    {
      key: "totalDebit",
      label: "Total Debit",
      align: "right",
      render: (value, row) => {
        const total = row.lines.reduce((s, l) => s + l.debitSen, 0);
        return <span className="amount font-medium">{formatRM(total)}</span>;
      },
    },
    {
      key: "status",
      label: "Status",
      render: (value, row) => (
        <Badge variant="status" status={row.status}>
          {row.status}
        </Badge>
      ),
    },
  ];

  const overviewContextMenu: ContextMenuItem[] = [
    { label: "View", action: () => {} },
    { label: "Edit", action: () => {} },
    { separator: true, label: "", action: () => {} },
    { label: "Refresh", action: () => {} },
  ];

  return (
    <>
      {/* KPI Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-5">
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Revenue (MTD)</p>
              <p className="text-xl font-bold text-[#4F7C3A]">{formatCurrency(revenue)}</p>
            </div>
            <ArrowUpRight className="h-5 w-5 text-[#4F7C3A]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Expenses (MTD)</p>
              <p className="text-xl font-bold text-[#9A3A2D]">{formatCurrency(expenses)}</p>
            </div>
            <ArrowDownRight className="h-5 w-5 text-[#9A3A2D]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Net Profit</p>
              <p className={`text-xl font-bold ${netProfit >= 0 ? "text-[#4F7C3A]" : "text-[#9A3A2D]"}`}>
                {formatCurrency(netProfit)}
              </p>
            </div>
            <DollarSign className="h-5 w-5 text-[#6B5C32]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">AR Outstanding</p>
              <p className="text-xl font-bold text-[#9C6F1E]">{formatCurrency(totalAR)}</p>
            </div>
            <TrendingUp className="h-5 w-5 text-[#9C6F1E]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">AP Outstanding</p>
              <p className="text-xl font-bold text-[#3E6570]">{formatCurrency(totalAP)}</p>
            </div>
            <TrendingDown className="h-5 w-5 text-[#3E6570]" />
          </CardContent>
        </Card>
      </div>

      {/* AR & AP Aging Summary */}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
        <AgingCard title="Accounts Receivable Aging" icon={<TrendingUp className="h-5 w-5 text-[#6B5C32]" />} buckets={arBuckets} barColor="bg-[#6B5C32]" />
        <AgingCard title="Accounts Payable Aging" icon={<TrendingDown className="h-5 w-5 text-[#6B5C32]" />} buckets={apBuckets} barColor="bg-[#9C6F1E]" />
      </div>

      {/* Recent Journal Entries */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-[#6B5C32]" />
            Recent Journal Entries
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataGrid
            columns={recentColumns}
            data={recentJournals}
            keyField="id"
            gridId="accounting-overview-journals"
            contextMenuItems={overviewContextMenu}
          />
        </CardContent>
      </Card>
    </>
  );
}

function AgingCard({
  title,
  icon,
  buckets,
  barColor,
}: {
  title: string;
  icon: React.ReactNode;
  buckets: { period: string; amountSen: number }[];
  barColor: string;
}) {
  const total = buckets.reduce((s, b) => s + b.amountSen, 0);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {buckets.map((item) => {
            const pct = total > 0 ? Math.round((item.amountSen / total) * 100) : 0;
            return (
              <div key={item.period} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-[#4B5563]">{item.period}</span>
                  <span className="font-medium text-[#1F1D1B]">{formatCurrency(item.amountSen)}</span>
                </div>
                <div className="h-2 bg-[#F0ECE9] rounded-full overflow-hidden">
                  <div className={`h-full ${barColor} rounded-full transition-all`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
          <div className="flex items-center justify-between text-sm font-semibold pt-2 border-t border-[#E2DDD8]">
            <span className="text-[#1F1D1B]">Total</span>
            <span className="text-[#1F1D1B]">{formatCurrency(total)}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// =============== TAB 2: CHART OF ACCOUNTS ===============

function COATab({ accounts, onRefresh }: { accounts: ChartOfAccount[]; onRefresh: () => void }) {
  const { toast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ code: "", name: "", type: "ASSET" as ChartOfAccount["type"], parentCode: "" });
  const [editCode, setEditCode] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    "ASSET": true,
    "LIABILITY": true,
    "EQUITY": true,
    "REVENUE": true,
    "EXPENSE": true,
  });

  const typeOrder: ChartOfAccount["type"][] = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"];
  const typeLabels: Record<string, string> = {
    ASSET: "Assets",
    LIABILITY: "Liabilities",
    EQUITY: "Equity",
    REVENUE: "Revenue",
    EXPENSE: "Expenses",
  };
  // Use the canonical COA type palette from design-tokens.
  // Colour meaning (accounting convention):
  //   ASSET=info, LIABILITY=danger, EQUITY=plum, REVENUE=success, EXPENSE=warning.
  const typeColors: Record<string, string> = {
    ASSET:     `${COA_TYPE_COLOR.ASSET.bg} ${COA_TYPE_COLOR.ASSET.text} ${COA_TYPE_COLOR.ASSET.border}`,
    LIABILITY: `${COA_TYPE_COLOR.LIABILITY.bg} ${COA_TYPE_COLOR.LIABILITY.text} ${COA_TYPE_COLOR.LIABILITY.border}`,
    EQUITY:    `${COA_TYPE_COLOR.EQUITY.bg} ${COA_TYPE_COLOR.EQUITY.text} ${COA_TYPE_COLOR.EQUITY.border}`,
    REVENUE:   `${COA_TYPE_COLOR.REVENUE.bg} ${COA_TYPE_COLOR.REVENUE.text} ${COA_TYPE_COLOR.REVENUE.border}`,
    EXPENSE:   `${COA_TYPE_COLOR.EXPENSE.bg} ${COA_TYPE_COLOR.EXPENSE.text} ${COA_TYPE_COLOR.EXPENSE.border}`,
  };

  const handleAdd = async () => {
    const res = await fetch("/api/accounting/coa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formData),
    });
    const data = await res.json();
    if (data.success) {
      setShowForm(false);
      setFormData({ code: "", name: "", type: "ASSET", parentCode: "" });
      onRefresh();
    } else {
      toast.error(data.error);
    }
  };

  const handleEdit = async (code: string) => {
    const res = await fetch("/api/accounting/coa", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: editName }),
    });
    const data = await res.json();
    if (data.success) {
      setEditCode(null);
      onRefresh();
    }
  };

  const handleDeactivate = async (code: string) => {
    const res = await fetch("/api/accounting/coa", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, isActive: false }),
    });
    const data = await res.json();
    if (data.success) onRefresh();
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Chart of Accounts</h2>
        <Button variant="primary" size="sm" onClick={() => setShowForm(!showForm)}>
          <Plus className="h-4 w-4" /> Add Account
        </Button>
      </div>

      {showForm && (
        <Card>
          <CardContent className="p-4">
            <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 items-end">
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Code</label>
                <input
                  type="text"
                  placeholder="100-0003"
                  value={formData.code}
                  onChange={(e) => setFormData({ ...formData, code: e.target.value })}
                  className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Name</label>
                <input
                  type="text"
                  placeholder="Account Name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Type</label>
                <select
                  value={formData.type}
                  onChange={(e) => setFormData({ ...formData, type: e.target.value as ChartOfAccount["type"] })}
                  className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                >
                  {typeOrder.map((t) => (
                    <option key={t} value={t}>{typeLabels[t]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Parent Code</label>
                <select
                  value={formData.parentCode}
                  onChange={(e) => setFormData({ ...formData, parentCode: e.target.value })}
                  className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                >
                  <option value="">(None - Top Level)</option>
                  {accounts
                    .filter((a) => a.type === formData.type)
                    .map((a) => (
                      <option key={a.code} value={a.code}>
                        {a.code} - {a.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className="flex gap-2">
                <Button variant="primary" size="sm" onClick={handleAdd}>
                  Save
                </Button>
                <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {typeOrder.map((type) => {
        const typeAccounts = accounts.filter((a) => a.type === type);
        const parents = typeAccounts.filter((a) => !a.parentCode);
        const children = (parentCode: string) => typeAccounts.filter((a) => a.parentCode === parentCode);
        const isExpanded = expanded[type];

        return (
          <Card key={type}>
            <div
              className="flex items-center justify-between p-4 cursor-pointer hover:bg-[#F0ECE9]/50"
              onClick={() => setExpanded({ ...expanded, [type]: !isExpanded })}
            >
              <div className="flex items-center gap-2">
                {isExpanded ? <ChevronDownIcon className="h-4 w-4 text-[#6B7280]" /> : <ChevronRight className="h-4 w-4 text-[#6B7280]" />}
                <span className="font-semibold text-[#1F1D1B]">{typeLabels[type]}</span>
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${typeColors[type]}`}>
                  {typeAccounts.length} accounts
                </span>
              </div>
              <span className="font-semibold text-[#1F1D1B]">
                {formatCurrency(typeAccounts.filter((a) => a.parentCode).reduce((s, a) => s + a.balance, 0))}
              </span>
            </div>
            {isExpanded && (
              <CardContent className="pt-0 pb-2">
                <div className="border-t border-[#E2DDD8]">
                  {parents.map((parent) => (
                    <div key={parent.code}>
                      {/* Parent row */}
                      <div className="flex items-center justify-between py-2 px-2 text-sm font-medium text-[#4B5563] border-b border-[#F0ECE9]">
                        <span>{parent.code} - {parent.name}</span>
                      </div>
                      {/* Children */}
                      {children(parent.code).map((child) => (
                        <div
                          key={child.code}
                          className="flex items-center justify-between py-2 px-2 pl-8 text-sm border-b border-[#F0ECE9] hover:bg-[#F0ECE9]/30 group"
                        >
                          <div className="flex items-center gap-3">
                            <span className="text-[#6B7280] font-mono text-xs">{child.code}</span>
                            {editCode === child.code ? (
                              <input
                                type="text"
                                value={editName}
                                onChange={(e) => setEditName(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && handleEdit(child.code)}
                                className="rounded border border-[#E2DDD8] px-2 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
                                autoFocus
                              />
                            ) : (
                              <span className="text-[#1F1D1B]">{child.name}</span>
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            <span className={`font-medium ${child.balance < 0 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>
                              {formatCurrency(Math.abs(child.balance))}
                              {child.balance < 0 ? " CR" : ""}
                            </span>
                            <div className="opacity-0 group-hover:opacity-100 flex gap-1">
                              {editCode === child.code ? (
                                <>
                                  <button onClick={() => handleEdit(child.code)} className="text-[#4F7C3A] hover:text-[#3D6329] p-1 cursor-pointer"><Check className="h-3.5 w-3.5" /></button>
                                  <button onClick={() => setEditCode(null)} className="text-[#6B7280] hover:text-[#1F1D1B] p-1 cursor-pointer"><X className="h-3.5 w-3.5" /></button>
                                </>
                              ) : (
                                <>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setEditCode(child.code); setEditName(child.name); }}
                                    className="text-[#6B7280] hover:text-[#6B5C32] p-1 cursor-pointer"
                                    title="Edit"
                                  >
                                    <FileText className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleDeactivate(child.code); }}
                                    className="text-[#6B7280] hover:text-[#9A3A2D] p-1 cursor-pointer"
                                    title="Deactivate"
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                  {/* Accounts without parent in this type (direct children of the type) */}
                  {typeAccounts
                    .filter((a) => a.parentCode && !parents.find((p) => p.code === a.parentCode))
                    .map((child) => (
                      <div
                        key={child.code}
                        className="flex items-center justify-between py-2 px-2 text-sm border-b border-[#F0ECE9]"
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-[#6B7280] font-mono text-xs">{child.code}</span>
                          <span className="text-[#1F1D1B]">{child.name}</span>
                        </div>
                        <span className="font-medium text-[#1F1D1B]">{formatCurrency(child.balance)}</span>
                      </div>
                    ))}
                </div>
              </CardContent>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// =============== TAB 3: JOURNAL ENTRIES ===============

function JournalsTab({
  journals,
  accounts,
  onRefresh,
}: {
  journals: JournalEntry[];
  accounts: ChartOfAccount[];
  onRefresh: () => void;
}) {
  const [showForm, setShowForm] = useState(false);

  const handlePost = async (id: string) => {
    await fetch(`/api/accounting/journals/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "POSTED" }),
    });
    onRefresh();
  };

  const handleReverse = async (id: string) => {
    await fetch(`/api/accounting/journals/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "REVERSED" }),
    });
    onRefresh();
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/accounting/journals/${id}`, { method: "DELETE" });
      if (!res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: any = await res.json().catch(() => ({}));
        alert(body?.error || `Failed to delete journal entry (HTTP ${res.status})`);
        return;
      }
      onRefresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Network error — journal not deleted");
    }
  };

  const columns: Column<JournalEntry>[] = [
    {
      key: "entryNo",
      label: "Entry No.",
      render: (value, row) => <span className="doc-number font-medium">{row.entryNo}</span>,
    },
    {
      key: "date",
      label: "Date",
      render: (value, row) => <span className="text-[#4B5563]">{formatDateDMY(row.date)}</span>,
    },
    {
      key: "description",
      label: "Description",
      render: (value, row) => <span className="font-medium text-[#1F1D1B]">{row.description}</span>,
    },
    {
      key: "totalDebit",
      label: "Total Debit",
      align: "right",
      render: (value, row) => {
        const total = row.lines.reduce((s, l) => s + l.debitSen, 0);
        return <span className="amount font-medium">{formatRM(total)}</span>;
      },
    },
    {
      key: "totalCredit",
      label: "Total Credit",
      align: "right",
      render: (value, row) => {
        const total = row.lines.reduce((s, l) => s + l.creditSen, 0);
        return <span className="amount font-medium">{formatRM(total)}</span>;
      },
    },
    {
      key: "status",
      label: "Status",
      render: (value, row) => (
        <Badge variant="status" status={row.status}>
          {row.status}
        </Badge>
      ),
    },
  ];

  const contextMenuItems = (row: JournalEntry): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      { label: "View", action: () => {} },
    ];
    if (row.status === "DRAFT") {
      items.push({ label: "Post", action: (r) => handlePost(r.id) });
      items.push({ label: "Delete", danger: true, action: (r) => handleDelete(r.id) });
    }
    if (row.status === "POSTED") {
      items.push({ label: "Reverse", action: (r) => handleReverse(r.id) });
    }
    items.push({ separator: true, label: "", action: () => {} });
    items.push({ label: "Refresh", action: () => onRefresh() });
    return items;
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Journal Entries</h2>
        <Button variant="primary" size="sm" onClick={() => setShowForm(!showForm)}>
          <FileText className="h-4 w-4" /> New Journal Entry
        </Button>
      </div>

      {showForm && <JournalEntryForm accounts={accounts} onSave={() => { setShowForm(false); onRefresh(); }} onCancel={() => setShowForm(false)} />}

      <Card>
        <CardContent className="p-4">
          <DataGrid
            columns={columns}
            data={journals}
            keyField="id"
            gridId="accounting-journals"
            contextMenuItems={contextMenuItems}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function JournalEntryForm({
  accounts,
  onSave,
  onCancel,
}: {
  accounts: ChartOfAccount[];
  onSave: () => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState<JournalLine[]>([
    { accountCode: "", accountName: "", debitSen: 0, creditSen: 0, description: "" },
    { accountCode: "", accountName: "", debitSen: 0, creditSen: 0, description: "" },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const leafAccounts = accounts.filter((a) => a.parentCode);

  const totalDebit = lines.reduce((s, l) => s + l.debitSen, 0);
  const totalCredit = lines.reduce((s, l) => s + l.creditSen, 0);
  const isBalanced = totalDebit === totalCredit && totalDebit > 0;

  const updateLine = (idx: number, field: string, value: string | number) => {
    const updated = [...lines];
    if (field === "accountCode") {
      const acc = accounts.find((a) => a.code === value);
      updated[idx] = { ...updated[idx], accountCode: value as string, accountName: acc?.name || "" };
    } else if (field === "debitSen" || field === "creditSen") {
      // Convert from ringgit input to sen
      const sen = Math.round(Number(value) * 100);
      updated[idx] = { ...updated[idx], [field]: sen };
    } else {
      updated[idx] = { ...updated[idx], [field]: value };
    }
    setLines(updated);
  };

  const addLine = () => {
    setLines([...lines, { accountCode: "", accountName: "", debitSen: 0, creditSen: 0, description: "" }]);
  };

  const removeLine = (idx: number) => {
    if (lines.length <= 2) return;
    setLines(lines.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    setError("");
    if (!date || !description) {
      setError("Date and description are required");
      return;
    }
    if (!isBalanced) {
      setError("Debits must equal credits and be non-zero");
      return;
    }
    const validLines = lines.filter((l) => l.accountCode && (l.debitSen > 0 || l.creditSen > 0));
    if (validLines.length < 2) {
      setError("At least 2 lines with amounts are required");
      return;
    }

    setSaving(true);
    const res = await fetch("/api/accounting/journals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, description, lines: validLines }),
    });
    const data = await res.json();
    setSaving(false);

    if (data.success) {
      onSave();
    } else {
      setError(data.error);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>New Journal Entry</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {error && (
            <div className={`rounded-md ${DANGER.bg} ${DANGER.border} border ${DANGER.text} px-4 py-2 text-sm`}>{error}</div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Date</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Description</label>
              <input
                type="text"
                placeholder="Journal entry description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              />
            </div>
          </div>

          {/* Lines Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-left">
                  <th className="py-2 px-2 text-[#6B7280] font-medium">Account</th>
                  <th className="py-2 px-2 text-[#6B7280] font-medium w-36">Debit (RM)</th>
                  <th className="py-2 px-2 text-[#6B7280] font-medium w-36">Credit (RM)</th>
                  <th className="py-2 px-2 text-[#6B7280] font-medium">Line Description</th>
                  <th className="py-2 px-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => (
                  <tr key={idx} className="border-b border-[#F0ECE9]">
                    <td className="py-1.5 px-2">
                      <select
                        value={line.accountCode}
                        onChange={(e) => updateLine(idx, "accountCode", e.target.value)}
                        className="w-full rounded border border-[#E2DDD8] px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
                      >
                        <option value="">Select account...</option>
                        {leafAccounts.map((a) => (
                          <option key={a.code} value={a.code}>
                            {a.code} - {a.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-1.5 px-2">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0.00"
                        value={line.debitSen ? (line.debitSen / 100).toFixed(2) : ""}
                        onChange={(e) => updateLine(idx, "debitSen", e.target.value)}
                        className="w-full rounded border border-[#E2DDD8] px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
                      />
                    </td>
                    <td className="py-1.5 px-2">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0.00"
                        value={line.creditSen ? (line.creditSen / 100).toFixed(2) : ""}
                        onChange={(e) => updateLine(idx, "creditSen", e.target.value)}
                        className="w-full rounded border border-[#E2DDD8] px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
                      />
                    </td>
                    <td className="py-1.5 px-2">
                      <input
                        type="text"
                        placeholder="Description"
                        value={line.description}
                        onChange={(e) => updateLine(idx, "description", e.target.value)}
                        className="w-full rounded border border-[#E2DDD8] px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
                      />
                    </td>
                    <td className="py-1.5 px-2">
                      {lines.length > 2 && (
                        <button onClick={() => removeLine(idx)} className="text-[#9A3A2D] hover:text-[#9A3A2D] cursor-pointer p-1">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-[#E2DDD8]">
                  <td className="py-2 px-2 font-semibold text-[#1F1D1B]">Totals</td>
                  <td className={`py-2 px-2 text-right font-semibold ${isBalanced ? "text-[#4F7C3A]" : "text-[#9A3A2D]"}`}>
                    {formatCurrency(totalDebit)}
                  </td>
                  <td className={`py-2 px-2 text-right font-semibold ${isBalanced ? "text-[#4F7C3A]" : "text-[#9A3A2D]"}`}>
                    {formatCurrency(totalCredit)}
                  </td>
                  <td colSpan={2} className="py-2 px-2">
                    {!isBalanced && totalDebit > 0 && (
                      <span className="text-xs text-[#9A3A2D]">
                        Difference: {formatCurrency(Math.abs(totalDebit - totalCredit))}
                      </span>
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="flex justify-between">
            <Button variant="outline" size="sm" onClick={addLine}>
              <Plus className="h-3.5 w-3.5" /> Add Line
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onCancel}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={handleSave} disabled={saving || !isBalanced}>
                {saving ? "Saving..." : "Save Journal Entry"}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// =============== TAB 4: ACCOUNTS RECEIVABLE ===============

function ARTab({ arData, onRefresh }: { arData: ARAgingEntry[]; onRefresh: () => void }) {
  const [paymentForm, setPaymentForm] = useState<string | null>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split("T")[0]);
  const [paymentRef, setPaymentRef] = useState("");

  const handlePayment = async (customerId: string) => {
    const amountSen = Math.round(Number(paymentAmount) * 100);
    if (amountSen <= 0) return;

    await fetch("/api/accounting/aging", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "ar", id: customerId, amountSen, date: paymentDate, reference: paymentRef }),
    });

    setPaymentForm(null);
    setPaymentAmount("");
    setPaymentRef("");
    onRefresh();
  };

  const totalOutstanding = arData.reduce(
    (s, a) => s + a.currentSen + a.days30Sen + a.days60Sen + a.days90Sen + a.over90Sen,
    0
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold text-[#1F1D1B]">Accounts Receivable</h2>
          <p className="text-sm text-[#6B7280]">Total Outstanding: <span className="font-semibold text-[#9C6F1E]">{formatCurrency(totalOutstanding)}</span></p>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]/50">
                  <th className="py-3 px-4 text-left text-[#6B7280] font-medium">Customer</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">Current</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">1-30</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">31-60</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">61-90</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">90+</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">Total</th>
                  <th className="py-3 px-4 text-center text-[#6B7280] font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {arData.map((ar) => {
                  const total = ar.currentSen + ar.days30Sen + ar.days60Sen + ar.days90Sen + ar.over90Sen;
                  return (
                    <tr key={ar.customerId} className="border-b border-[#F0ECE9] hover:bg-[#F0ECE9]/30">
                      <td className="py-3 px-4 font-medium text-[#1F1D1B]">{ar.customerName}</td>
                      <td className="py-3 px-4 text-right">{ar.currentSen > 0 ? formatCurrency(ar.currentSen) : "-"}</td>
                      <td className="py-3 px-4 text-right">{ar.days30Sen > 0 ? formatCurrency(ar.days30Sen) : "-"}</td>
                      <td className={`py-3 px-4 text-right ${ar.days60Sen > 0 ? "text-[#9C6F1E]" : ""}`}>{ar.days60Sen > 0 ? formatCurrency(ar.days60Sen) : "-"}</td>
                      <td className={`py-3 px-4 text-right ${ar.days90Sen > 0 ? "text-[#B8601A] font-medium" : ""}`}>{ar.days90Sen > 0 ? formatCurrency(ar.days90Sen) : "-"}</td>
                      <td className={`py-3 px-4 text-right ${ar.over90Sen > 0 ? "text-[#9A3A2D] font-medium" : ""}`}>{ar.over90Sen > 0 ? formatCurrency(ar.over90Sen) : "-"}</td>
                      <td className="py-3 px-4 text-right font-semibold text-[#1F1D1B]">{formatCurrency(total)}</td>
                      <td className="py-3 px-4 text-center">
                        {total > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setPaymentForm(paymentForm === ar.customerId ? null : ar.customerId)}
                          >
                            <CreditCard className="h-3.5 w-3.5" /> Record Payment
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-[#F0ECE9]/50 font-semibold">
                  <td className="py-3 px-4 text-[#1F1D1B]">Total</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(arData.reduce((s, a) => s + a.currentSen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(arData.reduce((s, a) => s + a.days30Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(arData.reduce((s, a) => s + a.days60Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(arData.reduce((s, a) => s + a.days90Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(arData.reduce((s, a) => s + a.over90Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(totalOutstanding)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Payment Form */}
          {paymentForm && (
            <div className="border-t border-[#E2DDD8] p-4 bg-[#F0ECE9]/30">
              <h4 className="text-sm font-medium text-[#1F1D1B] mb-3">
                Record Payment - {arData.find((a) => a.customerId === paymentForm)?.customerName}
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
                <div>
                  <label className="text-xs font-medium text-[#6B7280] mb-1 block">Amount (RM)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={paymentAmount}
                    onChange={(e) => setPaymentAmount(e.target.value)}
                    className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-[#6B7280] mb-1 block">Date</label>
                  <input
                    type="date"
                    value={paymentDate}
                    onChange={(e) => setPaymentDate(e.target.value)}
                    className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-[#6B7280] mb-1 block">Reference</label>
                  <input
                    type="text"
                    placeholder="e.g. Bank Ref No."
                    value={paymentRef}
                    onChange={(e) => setPaymentRef(e.target.value)}
                    className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  />
                </div>
                <div className="flex gap-2">
                  <Button variant="primary" size="sm" onClick={() => handlePayment(paymentForm)}>
                    Submit
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setPaymentForm(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// =============== TAB 5: ACCOUNTS PAYABLE ===============

function APTab({ apData, onRefresh }: { apData: APAgingEntry[]; onRefresh: () => void }) {
  const [paymentForm, setPaymentForm] = useState<string | null>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split("T")[0]);
  const [paymentRef, setPaymentRef] = useState("");

  const handlePayment = async (supplierId: string) => {
    const amountSen = Math.round(Number(paymentAmount) * 100);
    if (amountSen <= 0) return;

    await fetch("/api/accounting/aging", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "ap", id: supplierId, amountSen, date: paymentDate, reference: paymentRef }),
    });

    setPaymentForm(null);
    setPaymentAmount("");
    setPaymentRef("");
    onRefresh();
  };

  const totalOutstanding = apData.reduce(
    (s, a) => s + a.currentSen + a.days30Sen + a.days60Sen + a.days90Sen + a.over90Sen,
    0
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold text-[#1F1D1B]">Accounts Payable</h2>
          <p className="text-sm text-[#6B7280]">Total Outstanding: <span className="font-semibold text-[#3E6570]">{formatCurrency(totalOutstanding)}</span></p>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]/50">
                  <th className="py-3 px-4 text-left text-[#6B7280] font-medium">Supplier</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">Current</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">1-30</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">31-60</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">61-90</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">90+</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">Total</th>
                  <th className="py-3 px-4 text-center text-[#6B7280] font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {apData.map((ap) => {
                  const total = ap.currentSen + ap.days30Sen + ap.days60Sen + ap.days90Sen + ap.over90Sen;
                  return (
                    <tr key={ap.supplierId} className="border-b border-[#F0ECE9] hover:bg-[#F0ECE9]/30">
                      <td className="py-3 px-4 font-medium text-[#1F1D1B]">{ap.supplierName}</td>
                      <td className="py-3 px-4 text-right">{ap.currentSen > 0 ? formatCurrency(ap.currentSen) : "-"}</td>
                      <td className="py-3 px-4 text-right">{ap.days30Sen > 0 ? formatCurrency(ap.days30Sen) : "-"}</td>
                      <td className={`py-3 px-4 text-right ${ap.days60Sen > 0 ? "text-[#9C6F1E]" : ""}`}>{ap.days60Sen > 0 ? formatCurrency(ap.days60Sen) : "-"}</td>
                      <td className={`py-3 px-4 text-right ${ap.days90Sen > 0 ? "text-[#B8601A] font-medium" : ""}`}>{ap.days90Sen > 0 ? formatCurrency(ap.days90Sen) : "-"}</td>
                      <td className={`py-3 px-4 text-right ${ap.over90Sen > 0 ? "text-[#9A3A2D] font-medium" : ""}`}>{ap.over90Sen > 0 ? formatCurrency(ap.over90Sen) : "-"}</td>
                      <td className="py-3 px-4 text-right font-semibold text-[#1F1D1B]">{formatCurrency(total)}</td>
                      <td className="py-3 px-4 text-center">
                        {total > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setPaymentForm(paymentForm === ap.supplierId ? null : ap.supplierId)}
                          >
                            <CreditCard className="h-3.5 w-3.5" /> Record Payment
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-[#F0ECE9]/50 font-semibold">
                  <td className="py-3 px-4 text-[#1F1D1B]">Total</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(apData.reduce((s, a) => s + a.currentSen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(apData.reduce((s, a) => s + a.days30Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(apData.reduce((s, a) => s + a.days60Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(apData.reduce((s, a) => s + a.days90Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(apData.reduce((s, a) => s + a.over90Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(totalOutstanding)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Payment Form */}
          {paymentForm && (
            <div className="border-t border-[#E2DDD8] p-4 bg-[#F0ECE9]/30">
              <h4 className="text-sm font-medium text-[#1F1D1B] mb-3">
                Record Payment - {apData.find((a) => a.supplierId === paymentForm)?.supplierName}
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
                <div>
                  <label className="text-xs font-medium text-[#6B7280] mb-1 block">Amount (RM)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={paymentAmount}
                    onChange={(e) => setPaymentAmount(e.target.value)}
                    className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-[#6B7280] mb-1 block">Date</label>
                  <input
                    type="date"
                    value={paymentDate}
                    onChange={(e) => setPaymentDate(e.target.value)}
                    className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-[#6B7280] mb-1 block">Reference</label>
                  <input
                    type="text"
                    placeholder="e.g. Cheque No."
                    value={paymentRef}
                    onChange={(e) => setPaymentRef(e.target.value)}
                    className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  />
                </div>
                <div className="flex gap-2">
                  <Button variant="primary" size="sm" onClick={() => handlePayment(paymentForm)}>
                    Submit
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setPaymentForm(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// =============== TAB 6: P&L REPORT ===============

type PLData = {
  entries: PLEntry[];
  totals: {
    revenue: number;
    cogs: number;
    grossProfit: number;
    grossProfitPct: number;
    operatingExpenses: number;
    netProfit: number;
    netProfitPct: number;
  };
  revenueByProduct: Record<string, number>;
  revenueByCustomer: Record<string, number>;
  cogsByAccount: Record<string, number>;
  opexByAccount: Record<string, number>;
};

function PLReportTab() {
  const [period, setPeriod] = useState("2026-Q1");
  const [productCategory, setProductCategory] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [plData, setPlData] = useState<PLData | null>(null);
  const [plLoading, setPlLoading] = useState(true);

  const periods = [
    { value: "2026-01", label: "January 2026" },
    { value: "2026-02", label: "February 2026" },
    { value: "2026-03", label: "March 2026" },
    { value: "2026-Q1", label: "Q1 2026" },
    { value: "2026", label: "Full Year 2026" },
  ];

  const productCategories = [
    { value: "", label: "All Products" },
    { value: "BEDFRAME", label: "Bedframe" },
    { value: "SOFA", label: "Sofa" },
    { value: "ACCESSORY", label: "Accessories" },
  ];

  const customerOptions = [
    { value: "", label: "All Customers" },
    { value: "hub-houzs-kl", label: "Houzs KL" },
    { value: "hub-houzs-pg", label: "Houzs PG" },
    { value: "hub-houzs-srw", label: "Houzs SRW" },
    { value: "hub-houzs-sbh", label: "Houzs SBH" },
    { value: "hub-carress", label: "Carress" },
    { value: "hub-conts", label: "The Conts" },
  ];

  const stateOptions = [
    { value: "", label: "All States" },
    { value: "KL", label: "KL" },
    { value: "PG", label: "Penang" },
    { value: "SRW", label: "Sarawak" },
    { value: "SBH", label: "Sabah" },
    { value: "JB", label: "Johor" },
  ];

  const fetchPL = useCallback(() => {
    setPlLoading(true);
    const params = new URLSearchParams();
    if (period) params.set("period", period);
    if (productCategory) params.set("productCategory", productCategory);
    if (customerId) params.set("customerId", customerId);
    if (stateFilter) params.set("state", stateFilter);

    fetch(`/api/accounting/pl?${params.toString()}`)
      .then((r) => r.json())
      .then((res) => {
        if (res.success) setPlData(res.data);
      })
      .finally(() => setPlLoading(false));
  }, [period, productCategory, customerId, stateFilter]);

  useEffect(() => {
    fetchPL();
  }, [fetchPL]);

  const handleExportCSV = () => {
    if (!plData) return;
    const rows: string[][] = [
      ["HOOKKA Industries Sdn Bhd"],
      [`Profit & Loss Statement - ${periods.find((p) => p.value === period)?.label || period}`],
      [],
      ["Section", "Account", "Amount (RM)"],
    ];
    Object.entries(plData.revenueByProduct).forEach(([k, v]) => {
      rows.push(["Revenue", k, (v / 100).toFixed(2)]);
    });
    rows.push(["", "Total Revenue", (plData.totals.revenue / 100).toFixed(2)]);
    rows.push([]);
    Object.entries(plData.cogsByAccount).forEach(([k, v]) => {
      rows.push(["COGS", k, (v / 100).toFixed(2)]);
    });
    rows.push(["", "Total COGS", (plData.totals.cogs / 100).toFixed(2)]);
    rows.push(["", "Gross Profit", (plData.totals.grossProfit / 100).toFixed(2)]);
    rows.push(["", "GP %", `${plData.totals.grossProfitPct}%`]);
    rows.push([]);
    Object.entries(plData.opexByAccount).forEach(([k, v]) => {
      rows.push(["Operating Expenses", k, (v / 100).toFixed(2)]);
    });
    rows.push(["", "Total Operating Expenses", (plData.totals.operatingExpenses / 100).toFixed(2)]);
    rows.push(["", "Net Profit", (plData.totals.netProfit / 100).toFixed(2)]);
    rows.push(["", "Net Margin %", `${plData.totals.netProfitPct}%`]);

    const csv = rows.map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `PL-${period}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (plLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-[#6B7280]">Loading P&L data...</div>
      </div>
    );
  }

  if (!plData) return null;

  const maxRevenue = Math.max(...Object.values(plData.revenueByProduct), 1);
  const maxCustomerRev = Math.max(...Object.values(plData.revenueByCustomer), 1);

  return (
    <div className="space-y-6">
      {/* Filter Bar */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Filter className="h-4 w-4 text-[#6B5C32]" />
            <span className="text-sm font-medium text-[#1F1D1B]">Multi-Dimensional Filters</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Period</label>
              <select
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32] bg-white"
              >
                {periods.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Product Category</label>
              <select
                value={productCategory}
                onChange={(e) => setProductCategory(e.target.value)}
                className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32] bg-white"
              >
                {productCategories.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Customer</label>
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32] bg-white"
              >
                {customerOptions.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">State</label>
              <select
                value={stateFilter}
                onChange={(e) => setStateFilter(e.target.value)}
                className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32] bg-white"
              >
                {stateOptions.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
          </div>
          {(productCategory || customerId || stateFilter) && (
            <div className="mt-2 flex items-center gap-2 text-xs text-[#6B5C32]">
              <span>Active filters:</span>
              {productCategory && <Badge variant="status" status="CONFIRMED">{productCategory}</Badge>}
              {customerId && <Badge variant="status" status="CONFIRMED">{customerOptions.find((c) => c.value === customerId)?.label}</Badge>}
              {stateFilter && <Badge variant="status" status="CONFIRMED">{stateFilter}</Badge>}
              <button onClick={() => { setProductCategory(""); setCustomerId(""); setStateFilter(""); }} className="text-[#9A3A2D] hover:text-[#7A2E24] ml-2 underline cursor-pointer">Clear all</button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* KPI Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">Revenue</p>
            <p className="text-xl font-bold text-[#4F7C3A]">{formatCurrency(plData.totals.revenue)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">COGS</p>
            <p className="text-xl font-bold text-[#9A3A2D]">{formatCurrency(plData.totals.cogs)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">Gross Profit</p>
            <p className="text-xl font-bold text-[#6B5C32]">{formatCurrency(plData.totals.grossProfit)}</p>
            <p className="text-xs text-[#6B7280] mt-1">GP: {plData.totals.grossProfitPct}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">Net Profit</p>
            <p className={`text-xl font-bold ${plData.totals.netProfit >= 0 ? "text-[#4F7C3A]" : "text-[#9A3A2D]"}`}>
              {formatCurrency(plData.totals.netProfit)}
            </p>
            <p className="text-xs text-[#6B7280] mt-1">Margin: {plData.totals.netProfitPct}%</p>
          </CardContent>
        </Card>
      </div>

      {/* P&L Statement */}
      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-[#6B5C32]" />
            Profit & Loss Statement
          </CardTitle>
          <Button variant="outline" size="sm" onClick={handleExportCSV}>
            <Download className="h-4 w-4 mr-1" /> Export CSV
          </Button>
        </CardHeader>
        <CardContent>
          <div className="border border-[#E2DDD8] rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[#F0ECE9]">
                  <th className="text-left px-4 py-2 font-semibold text-[#1F1D1B]">Account</th>
                  <th className="text-right px-4 py-2 font-semibold text-[#1F1D1B]">Amount (RM)</th>
                </tr>
              </thead>
              <tbody>
                {/* Revenue Section — SUCCESS (green) tint */}
                <tr className={SUCCESS.bg}>
                  <td colSpan={2} className={`px-4 py-2 font-semibold ${SUCCESS.text}`}>Revenue</td>
                </tr>
                {Object.entries(plData.revenueByProduct).map(([name, amount]) => (
                  <tr key={name} className="border-t border-[#E2DDD8]/50">
                    <td className="px-4 py-1.5 pl-8 text-[#4B5563]">Sales - {name}</td>
                    <td className="px-4 py-1.5 text-right font-medium text-[#1F1D1B]">{formatCurrency(amount)}</td>
                  </tr>
                ))}
                <tr className={`border-t border-[#E2DDD8] font-semibold ${SUCCESS.bg}`}>
                  <td className={`px-4 py-2 ${SUCCESS.text}`}>Total Revenue</td>
                  <td className={`px-4 py-2 text-right ${SUCCESS.text}`}>{formatCurrency(plData.totals.revenue)}</td>
                </tr>

                {/* COGS Section — DANGER (red) tint, money leaving */}
                <tr className={`${DANGER.bg} border-t-2 border-[#E2DDD8]`}>
                  <td colSpan={2} className={`px-4 py-2 font-semibold ${DANGER.text}`}>Less: Cost of Goods Sold</td>
                </tr>
                {Object.entries(plData.cogsByAccount).map(([name, amount]) => (
                  <tr key={name} className="border-t border-[#E2DDD8]/50">
                    <td className="px-4 py-1.5 pl-8 text-[#4B5563]">{name}</td>
                    <td className={`px-4 py-1.5 text-right font-medium ${DANGER.text}`}>({formatCurrency(amount)})</td>
                  </tr>
                ))}
                <tr className={`border-t border-[#E2DDD8] font-semibold ${DANGER.bg}`}>
                  <td className={`px-4 py-2 ${DANGER.text}`}>Total COGS</td>
                  <td className={`px-4 py-2 text-right ${DANGER.text}`}>({formatCurrency(plData.totals.cogs)})</td>
                </tr>

                {/* Gross Profit */}
                <tr className="border-t-2 border-[#6B5C32] bg-[#F0ECE9] font-bold">
                  <td className="px-4 py-3 text-[#6B5C32]">
                    Gross Profit
                    <span className="ml-2 text-xs font-normal text-[#6B7280]">
                      (GP: {plData.totals.grossProfitPct}%)
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-[#6B5C32]">{formatCurrency(plData.totals.grossProfit)}</td>
                </tr>

                {/* Operating Expenses — WARNING (amber) tint */}
                <tr className={`${WARNING.bg} border-t-2 border-[#E2DDD8]`}>
                  <td colSpan={2} className={`px-4 py-2 font-semibold ${WARNING.text}`}>Less: Operating Expenses</td>
                </tr>
                {Object.entries(plData.opexByAccount).map(([name, amount]) => (
                  <tr key={name} className="border-t border-[#E2DDD8]/50">
                    <td className="px-4 py-1.5 pl-8 text-[#4B5563]">{name}</td>
                    <td className={`px-4 py-1.5 text-right font-medium ${WARNING.text}`}>({formatCurrency(amount)})</td>
                  </tr>
                ))}
                <tr className={`border-t border-[#E2DDD8] font-semibold ${WARNING.bg}`}>
                  <td className={`px-4 py-2 ${WARNING.text}`}>Total Operating Expenses</td>
                  <td className={`px-4 py-2 text-right ${WARNING.text}`}>({formatCurrency(plData.totals.operatingExpenses)})</td>
                </tr>

                {/* Net Profit */}
                <tr className="border-t-2 border-[#1F1D1B] bg-[#1F1D1B] text-white font-bold">
                  <td className="px-4 py-3">
                    Net Profit
                    <span className="ml-2 text-xs font-normal text-gray-300">
                      (Margin: {plData.totals.netProfitPct}%)
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">{formatCurrency(plData.totals.netProfit)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Charts Row */}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
        {/* Revenue by Product */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <PieChart className="h-5 w-5 text-[#6B5C32]" />
              Revenue by Product Category
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Object.entries(plData.revenueByProduct).map(([name, amount]) => {
                const pct = plData.totals.revenue > 0 ? Math.round((amount / plData.totals.revenue) * 100) : 0;
                const colors: Record<string, string> = {
                  BEDFRAME: "bg-[#6B5C32]",
                  SOFA: "bg-[#8B7A4A]",
                  ACCESSORY: "bg-[#A99B6A]",
                };
                return (
                  <div key={name} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-[#4B5563]">{name}</span>
                      <span className="font-medium text-[#1F1D1B]">{formatCurrency(amount)} ({pct}%)</span>
                    </div>
                    <div className="h-3 bg-[#F0ECE9] rounded-full overflow-hidden">
                      <div
                        className={`h-full ${colors[name] || "bg-[#6B5C32]"} rounded-full transition-all`}
                        style={{ width: `${Math.round((amount / maxRevenue) * 100)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Revenue by Customer */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-5 w-5 text-[#6B5C32]" />
              Revenue by Customer
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Object.entries(plData.revenueByCustomer)
                .sort(([, a], [, b]) => b - a)
                .map(([name, amount]) => {
                  const pct = plData.totals.revenue > 0 ? Math.round((amount / plData.totals.revenue) * 100) : 0;
                  return (
                    <div key={name} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-[#4B5563]">{name}</span>
                        <span className="font-medium text-[#1F1D1B]">{formatCurrency(amount)} ({pct}%)</span>
                      </div>
                      <div className="h-3 bg-[#F0ECE9] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[#6B5C32] rounded-full transition-all"
                          style={{ width: `${Math.round((amount / maxCustomerRev) * 100)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
          </CardContent>
        </Card>
      </div>

    </div>
  );
}

// =============== TAB 7: BALANCE SHEET ===============

function BalanceSheetTab() {
  const [bsData, setBsData] = useState<BalanceSheetEntry[]>([]);
  const [bsLoading, setBsLoading] = useState(true);

  useEffect(() => {
    fetch("/api/accounting/pl")
      .then((r) => r.json())
      .then((res) => {
        if (res.success && res.data.balanceSheet) {
          setBsData(res.data.balanceSheet);
        }
      })
      .finally(() => setBsLoading(false));
  }, []);

  if (bsLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-[#6B7280]">Loading balance sheet...</div>
      </div>
    );
  }

  const currentAssets = bsData.filter((e) => e.category === "CURRENT_ASSET");
  const fixedAssets = bsData.filter((e) => e.category === "FIXED_ASSET");
  const currentLiabilities = bsData.filter((e) => e.category === "CURRENT_LIABILITY");
  const longTermLiabilities = bsData.filter((e) => e.category === "LONG_TERM_LIABILITY");
  const equityItems = bsData.filter((e) => e.category === "EQUITY");

  const totalCurrentAssets = currentAssets.reduce((s, e) => s + e.balance, 0);
  const totalFixedAssets = fixedAssets.reduce((s, e) => s + e.balance, 0);
  const totalAssets = totalCurrentAssets + totalFixedAssets;
  const totalCurrentLiab = currentLiabilities.reduce((s, e) => s + e.balance, 0);
  const totalLongTermLiab = longTermLiabilities.reduce((s, e) => s + e.balance, 0);
  const totalLiabilities = totalCurrentLiab + totalLongTermLiab;
  const totalEquity = equityItems.reduce((s, e) => s + e.balance, 0);
  const totalLiabEquity = totalLiabilities + totalEquity;

  const renderBSSection = (
    title: string,
    entries: BalanceSheetEntry[],
    total: number,
    colorClass: string,
    bgClass: string
  ) => (
    <>
      <tr className={bgClass}>
        <td colSpan={3} className={`px-4 py-2 font-semibold ${colorClass}`}>{title}</td>
      </tr>
      {entries.map((e) => (
        <tr key={e.id} className="border-t border-[#E2DDD8]/50">
          <td className="px-4 py-1.5 pl-8 text-[#6B7280] text-xs">{e.accountCode}</td>
          <td className="px-4 py-1.5 text-[#4B5563]">{e.accountName}</td>
          <td className={`px-4 py-1.5 text-right font-medium ${e.balance < 0 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>
            {e.balance < 0 ? `(${formatCurrency(Math.abs(e.balance))})` : formatCurrency(e.balance)}
          </td>
        </tr>
      ))}
      <tr className={`border-t border-[#E2DDD8] ${bgClass} font-semibold`}>
        <td colSpan={2} className={`px-4 py-2 ${colorClass}`}>Total {title}</td>
        <td className={`px-4 py-2 text-right ${colorClass}`}>{formatCurrency(total)}</td>
      </tr>
    </>
  );

  return (
    <div className="space-y-6">
      {/* Balance equation */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-xs text-[#6B7280]">Total Assets</p>
            <p className="text-xl font-bold text-[#3E6570]">{formatCurrency(totalAssets)}</p>
          </CardContent>
        </Card>
        <Card className="flex items-center justify-center">
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-[#6B5C32]">=</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-xs text-[#6B7280]">Liabilities + Equity</p>
            <p className="text-xl font-bold text-[#6B4A6D]">{formatCurrency(totalLiabEquity)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Balance Sheet Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Scale className="h-5 w-5 text-[#6B5C32]" />
            Balance Sheet as at 31 March 2026
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="border border-[#E2DDD8] rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[#F0ECE9]">
                  <th className="text-left px-4 py-2 font-semibold text-[#1F1D1B] w-28">Code</th>
                  <th className="text-left px-4 py-2 font-semibold text-[#1F1D1B]">Account</th>
                  <th className="text-right px-4 py-2 font-semibold text-[#1F1D1B] w-40">Amount (RM)</th>
                </tr>
              </thead>
              <tbody>
                {/* ASSETS — INFO (teal) tint */}
                <tr className={`${INFO.bg} border-t-2 ${INFO.border}`}>
                  <td colSpan={3} className={`px-4 py-2 font-bold text-base ${INFO.text}`}>ASSETS</td>
                </tr>
                {renderBSSection("Current Assets", currentAssets, totalCurrentAssets, INFO.text, INFO.bg)}
                {renderBSSection("Fixed Assets (Net)", fixedAssets, totalFixedAssets, INFO.text, INFO.bg)}
                <tr className={`border-t-2 ${INFO.border} ${INFO.bg} font-bold`}>
                  <td colSpan={2} className={`px-4 py-3 ${INFO.text}`}>TOTAL ASSETS</td>
                  <td className={`px-4 py-3 text-right ${INFO.text}`}>{formatCurrency(totalAssets)}</td>
                </tr>

                {/* LIABILITIES — DANGER (red) tint */}
                <tr className={`${DANGER.bg} border-t-2 ${DANGER.border}`}>
                  <td colSpan={3} className={`px-4 py-2 font-bold text-base ${DANGER.text}`}>LIABILITIES</td>
                </tr>
                {renderBSSection("Current Liabilities", currentLiabilities, totalCurrentLiab, DANGER.text, DANGER.bg)}
                {renderBSSection("Long-Term Liabilities", longTermLiabilities, totalLongTermLiab, DANGER.text, DANGER.bg)}
                <tr className={`border-t border-[#E2DDD8] font-semibold ${DANGER.bg}`}>
                  <td colSpan={2} className={`px-4 py-2 ${DANGER.text}`}>Total Liabilities</td>
                  <td className={`px-4 py-2 text-right ${DANGER.text}`}>{formatCurrency(totalLiabilities)}</td>
                </tr>

                {/* EQUITY — ACCENT_PLUM tint */}
                {renderBSSection("Equity", equityItems, totalEquity, ACCENT_PLUM.text, ACCENT_PLUM.bg)}

                {/* Total L+E */}
                <tr className="border-t-2 border-[#1F1D1B] bg-[#1F1D1B] text-white font-bold">
                  <td colSpan={2} className="px-4 py-3">TOTAL LIABILITIES + EQUITY</td>
                  <td className="px-4 py-3 text-right">{formatCurrency(totalLiabEquity)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Balance check */}
          <div className={`mt-3 p-3 rounded-lg text-sm border ${totalAssets === totalLiabEquity ? `${SUCCESS.bg} ${SUCCESS.text} ${SUCCESS.border}` : `${DANGER.bg} ${DANGER.text} ${DANGER.border}`}`}>
            {totalAssets === totalLiabEquity ? (
              <span className="flex items-center gap-2"><Check className="h-4 w-4" /> Balance sheet is balanced. Assets = Liabilities + Equity</span>
            ) : (
              <span className="flex items-center gap-2"><X className="h-4 w-4" /> Balance sheet is NOT balanced. Difference: {formatCurrency(Math.abs(totalAssets - totalLiabEquity))}</span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
