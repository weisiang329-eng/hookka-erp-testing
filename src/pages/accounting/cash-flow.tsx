import { useState, useEffect, useCallback } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate, cn } from "@/lib/utils";

type BankAccount = {
  id: string;
  bankName: string;
  accountNo: string;
  accountName: string;
  balanceSen: number;
  currency: string;
};

type BankTransaction = {
  id: string;
  bankAccountId: string;
  date: string;
  description: string;
  amountSen: number;
  type: "DEPOSIT" | "WITHDRAWAL" | "TRANSFER";
  reference: string;
  isReconciled: boolean;
  matchedJournalId?: string;
};

type JournalLine = {
  accountCode: string;
  accountName: string;
  debitSen: number;
  creditSen: number;
  description: string;
};

type JournalEntry = {
  id: string;
  entryNo: string;
  date: string;
  description: string;
  lines: JournalLine[];
  status: string;
};

type WeekForecast = {
  weekStart: string;
  arInflowSen: number;
  apOutflowSen: number;
  netSen: number;
  runningBalanceSen: number;
};

type CashFlowData = {
  bankAccounts: BankAccount[];
  bankTransactions: BankTransaction[];
  journalEntries: JournalEntry[];
  forecast: WeekForecast[];
  summary: {
    currentCashSen: number;
    totalInflowsSen: number;
    totalOutflowsSen: number;
    netCashFlowSen: number;
  };
};

const TABS = ["Cash Flow Forecast", "Bank Reconciliation", "Bank Accounts"] as const;
type Tab = (typeof TABS)[number];

export default function CashFlowPage() {
  const [data, setData] = useState<CashFlowData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("Cash Flow Forecast");

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/cash-flow");
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      setData(json);
    } catch {
      // silently handle
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <div className="h-8 w-64 bg-[#F0ECE9] rounded animate-pulse" />
        <div className="grid grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-28 bg-[#F0ECE9] rounded-lg animate-pulse" />
          ))}
        </div>
        <div className="h-96 bg-[#F0ECE9] rounded-lg animate-pulse" />
      </div>
    );
  }

  if (!data) return <div className="p-6 text-[#9A3A2D]">Failed to load cash flow data.</div>;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[#1F1D1B]">Cash Flow & Bank Reconciliation</h1>
        <p className="text-sm text-[#6B7280] mt-1">
          Forecast cash position, reconcile bank statements, and manage accounts
        </p>
      </div>

      {/* Tabs */}
      <div className="border-b border-[#E2DDD8]">
        <div className="flex gap-0">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "px-5 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer",
                activeTab === tab
                  ? "border-[#6B5C32] text-[#6B5C32]"
                  : "border-transparent text-[#6B7280] hover:text-[#1F1D1B] hover:border-[#E2DDD8]"
              )}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "Cash Flow Forecast" && <ForecastTab data={data} />}
      {activeTab === "Bank Reconciliation" && (
        <ReconciliationTab data={data} onRefresh={fetchData} />
      )}
      {activeTab === "Bank Accounts" && (
        <BankAccountsTab data={data} onRefresh={fetchData} />
      )}
    </div>
  );
}

/* ============================================================
   TAB 1: Cash Flow Forecast
   ============================================================ */
function ForecastTab({ data }: { data: CashFlowData }) {
  const { summary, forecast } = data;

  // Find max value for bar chart scaling
  const maxVal = Math.max(
    ...forecast.map((w) => Math.max(w.arInflowSen, w.apOutflowSen)),
    1
  );

  const kpis = [
    {
      label: "Current Cash Position",
      value: formatCurrency(summary.currentCashSen),
      color: "text-[#1F1D1B]",
      bg: "bg-[#F0ECE9]",
    },
    {
      label: "Expected Inflows (12w)",
      value: formatCurrency(summary.totalInflowsSen),
      color: "text-[#4F7C3A]",
      bg: "bg-[#EEF3E4]",
    },
    {
      label: "Expected Outflows (12w)",
      value: formatCurrency(summary.totalOutflowsSen),
      color: "text-[#9A3A2D]",
      bg: "bg-[#F9E1DA]",
    },
    {
      label: "Net Cash Flow",
      value: formatCurrency(summary.netCashFlowSen),
      color: summary.netCashFlowSen >= 0 ? "text-[#4F7C3A]" : "text-[#9A3A2D]",
      bg: summary.netCashFlowSen >= 0 ? "bg-[#EEF3E4]" : "bg-[#F9E1DA]",
    },
  ];

  return (
    <div className="space-y-6">
      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map((kpi) => (
          <Card key={kpi.label}>
            <CardContent className="p-5">
              <p className="text-xs font-medium text-[#6B7280] uppercase tracking-wide">
                {kpi.label}
              </p>
              <p className={cn("text-2xl font-bold mt-2", kpi.color)}>{kpi.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Bar chart */}
      <Card>
        <CardHeader>
          <CardTitle>12-Week Cash Flow Chart</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-2 h-48">
            {forecast.map((week) => {
              const inflowPct = (week.arInflowSen / maxVal) * 100;
              const outflowPct = (week.apOutflowSen / maxVal) * 100;
              const weekLabel = new Date(week.weekStart).toLocaleDateString("en-MY", {
                month: "short",
                day: "numeric",
              });
              return (
                <div
                  key={week.weekStart}
                  className="flex-1 flex flex-col items-center gap-1"
                >
                  <div className="flex gap-0.5 items-end h-36 w-full justify-center">
                    <div
                      className="bg-[#4F7C3A] rounded-t min-w-[8px] max-w-[20px] flex-1 transition-all"
                      style={{ height: `${Math.max(inflowPct, 2)}%` }}
                      title={`Inflow: ${formatCurrency(week.arInflowSen)}`}
                    />
                    <div
                      className="bg-[#9A3A2D] rounded-t min-w-[8px] max-w-[20px] flex-1 transition-all"
                      style={{ height: `${Math.max(outflowPct, 2)}%` }}
                      title={`Outflow: ${formatCurrency(week.apOutflowSen)}`}
                    />
                  </div>
                  <span className="text-[10px] text-[#6B7280] text-center leading-tight">
                    {weekLabel}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="flex gap-4 mt-3 justify-center text-xs text-[#6B7280]">
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded bg-[#4F7C3A] inline-block" /> Inflows
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded bg-[#9A3A2D] inline-block" /> Outflows
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Forecast table */}
      <Card>
        <CardHeader>
          <CardTitle>12-Week Forecast Detail</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-[#6B7280]">
                  <th className="text-left py-2 px-3 font-medium">Week</th>
                  <th className="text-right py-2 px-3 font-medium">AR Inflow</th>
                  <th className="text-right py-2 px-3 font-medium">AP Outflow</th>
                  <th className="text-right py-2 px-3 font-medium">Net</th>
                  <th className="text-right py-2 px-3 font-medium">Running Balance</th>
                </tr>
              </thead>
              <tbody>
                {forecast.map((week) => (
                  <tr
                    key={week.weekStart}
                    className="border-b border-[#E2DDD8]/50 hover:bg-[#F0ECE9]/50"
                  >
                    <td className="py-2.5 px-3 font-medium text-[#1F1D1B]">
                      {formatDate(week.weekStart)}
                    </td>
                    <td className="text-right py-2.5 px-3 text-[#4F7C3A]">
                      {week.arInflowSen > 0 ? formatCurrency(week.arInflowSen) : "-"}
                    </td>
                    <td className="text-right py-2.5 px-3 text-[#9A3A2D]">
                      {week.apOutflowSen > 0 ? formatCurrency(week.apOutflowSen) : "-"}
                    </td>
                    <td
                      className={cn(
                        "text-right py-2.5 px-3 font-medium",
                        week.netSen >= 0 ? "text-[#4F7C3A]" : "text-[#9A3A2D]"
                      )}
                    >
                      {formatCurrency(week.netSen)}
                    </td>
                    <td
                      className={cn(
                        "text-right py-2.5 px-3 font-semibold",
                        week.runningBalanceSen >= 0 ? "text-[#1F1D1B]" : "text-[#9A3A2D]"
                      )}
                    >
                      {formatCurrency(week.runningBalanceSen)}
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
}

/* ============================================================
   TAB 2: Bank Reconciliation
   ============================================================ */
function ReconciliationTab({
  data,
  onRefresh,
}: {
  data: CashFlowData;
  onRefresh: () => void;
}) {
  const [selectedAccount, setSelectedAccount] = useState(data.bankAccounts[0]?.id || "");
  const [selectedBankTx, setSelectedBankTx] = useState<string | null>(null);
  const [selectedJE, setSelectedJE] = useState<string | null>(null);
  const [matching, setMatching] = useState(false);

  const accountTxs = data.bankTransactions
    .filter((t) => t.bankAccountId === selectedAccount)
    .sort((a, b) => b.date.localeCompare(a.date));

  const account = data.bankAccounts.find((a) => a.id === selectedAccount);

  // GL total from journal entries (sum debits to Cash & Bank minus credits)
  const glBalance = data.journalEntries.reduce((sum, je) => {
    je.lines.forEach((line) => {
      if (line.accountCode === "100-0001") {
        sum += line.debitSen - line.creditSen;
      }
    });
    return sum;
  }, 0);

  const bankBalance = account?.balanceSen || 0;
  const difference = bankBalance - glBalance;
  const unmatchedCount = accountTxs.filter((t) => !t.isReconciled).length;

  const handleMatch = async () => {
    if (!selectedBankTx || !selectedJE) return;
    setMatching(true);
    try {
      await fetch("/api/cash-flow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reconcile",
          bankTransactionId: selectedBankTx,
          journalEntryId: selectedJE,
        }),
      });
      setSelectedBankTx(null);
      setSelectedJE(null);
      onRefresh();
    } finally {
      setMatching(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Account selector + summary */}
      <div className="flex flex-col lg:flex-row gap-4">
        <Card className="flex-1">
          <CardContent className="p-5">
            <label className="text-xs font-medium text-[#6B7280] uppercase tracking-wide">
              Bank Account
            </label>
            <select
              value={selectedAccount}
              onChange={(e) => {
                setSelectedAccount(e.target.value);
                setSelectedBankTx(null);
                setSelectedJE(null);
              }}
              className="mt-2 w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
            >
              {data.bankAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.bankName} - {a.accountNo}
                </option>
              ))}
            </select>
          </CardContent>
        </Card>

        {/* Reconciliation Summary */}
        <Card className="flex-1">
          <CardContent className="p-5">
            <p className="text-xs font-medium text-[#6B7280] uppercase tracking-wide mb-3">
              Reconciliation Summary
            </p>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <span className="text-[#6B7280]">Bank Balance:</span>
              <span className="text-right font-semibold text-[#1F1D1B]">
                {formatCurrency(bankBalance)}
              </span>
              <span className="text-[#6B7280]">GL Balance:</span>
              <span className="text-right font-semibold text-[#1F1D1B]">
                {formatCurrency(glBalance)}
              </span>
              <span className="text-[#6B7280]">Difference:</span>
              <span
                className={cn(
                  "text-right font-semibold",
                  difference === 0 ? "text-[#4F7C3A]" : "text-[#9A3A2D]"
                )}
              >
                {formatCurrency(difference)}
              </span>
              <span className="text-[#6B7280]">Unmatched Items:</span>
              <span className="text-right font-semibold text-[#1F1D1B]">
                {unmatchedCount}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Match button */}
      {(selectedBankTx || selectedJE) && (
        <div className="flex items-center gap-3 p-3 bg-[#F0ECE9] rounded-lg border border-[#E2DDD8]">
          <span className="text-sm text-[#6B7280]">
            {selectedBankTx && selectedJE
              ? "Both selected - ready to match"
              : "Select one bank transaction and one GL entry to match"}
          </span>
          <Button
            variant="primary"
            size="sm"
            onClick={handleMatch}
            disabled={!selectedBankTx || !selectedJE || matching}
          >
            {matching ? "Matching..." : "Match Selected"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSelectedBankTx(null);
              setSelectedJE(null);
            }}
          >
            Clear
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Bank Statement */}
        <Card>
          <CardHeader>
            <CardTitle>Bank Statement</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] text-[#6B7280]">
                    <th className="text-left py-2 px-2 font-medium">Date</th>
                    <th className="text-left py-2 px-2 font-medium">Description</th>
                    <th className="text-right py-2 px-2 font-medium">Deposit</th>
                    <th className="text-right py-2 px-2 font-medium">Withdrawal</th>
                    <th className="text-center py-2 px-2 font-medium">Rec.</th>
                  </tr>
                </thead>
                <tbody>
                  {accountTxs.map((tx) => (
                    <tr
                      key={tx.id}
                      onClick={() =>
                        !tx.isReconciled &&
                        setSelectedBankTx(selectedBankTx === tx.id ? null : tx.id)
                      }
                      className={cn(
                        "border-b border-[#E2DDD8]/50 transition-colors",
                        tx.isReconciled
                          ? "bg-[#EEF3E4]/50"
                          : "hover:bg-[#F0ECE9]/50 cursor-pointer",
                        selectedBankTx === tx.id && "bg-[#6B5C32]/10 ring-1 ring-[#6B5C32]"
                      )}
                    >
                      <td className="py-2 px-2 text-[#1F1D1B] whitespace-nowrap">
                        {formatDate(tx.date)}
                      </td>
                      <td className="py-2 px-2 text-[#1F1D1B] max-w-[180px] truncate">
                        {tx.description}
                      </td>
                      <td className="text-right py-2 px-2 text-[#4F7C3A]">
                        {tx.amountSen > 0 ? formatCurrency(tx.amountSen) : ""}
                      </td>
                      <td className="text-right py-2 px-2 text-[#9A3A2D]">
                        {tx.amountSen < 0 ? formatCurrency(Math.abs(tx.amountSen)) : ""}
                      </td>
                      <td className="text-center py-2 px-2">
                        {tx.isReconciled ? (
                          <span className="text-[#4F7C3A] font-bold">&#10003;</span>
                        ) : (
                          <span className="text-[#9A3A2D] font-bold">&#10007;</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* GL Transactions */}
        <Card>
          <CardHeader>
            <CardTitle>GL Transactions (Journal Entries)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] text-[#6B7280]">
                    <th className="text-left py-2 px-2 font-medium">Date</th>
                    <th className="text-left py-2 px-2 font-medium">Description</th>
                    <th className="text-right py-2 px-2 font-medium">Debit</th>
                    <th className="text-right py-2 px-2 font-medium">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.journalEntries.map((je) => {
                    const cashLines = je.lines.filter(
                      (l) => l.accountCode === "100-0001"
                    );
                    if (cashLines.length === 0) return null;
                    const totalDebit = cashLines.reduce(
                      (s, l) => s + l.debitSen,
                      0
                    );
                    const totalCredit = cashLines.reduce(
                      (s, l) => s + l.creditSen,
                      0
                    );
                    const isMatched = data.bankTransactions.some(
                      (bt) => bt.matchedJournalId === je.id && bt.isReconciled
                    );
                    return (
                      <tr
                        key={je.id}
                        onClick={() =>
                          !isMatched &&
                          setSelectedJE(selectedJE === je.id ? null : je.id)
                        }
                        className={cn(
                          "border-b border-[#E2DDD8]/50 transition-colors",
                          isMatched
                            ? "bg-[#EEF3E4]/50"
                            : "hover:bg-[#F0ECE9]/50 cursor-pointer",
                          selectedJE === je.id &&
                            "bg-[#6B5C32]/10 ring-1 ring-[#6B5C32]"
                        )}
                      >
                        <td className="py-2 px-2 text-[#1F1D1B] whitespace-nowrap">
                          {formatDate(je.date)}
                        </td>
                        <td className="py-2 px-2 text-[#1F1D1B] max-w-[200px] truncate">
                          {je.description}
                        </td>
                        <td className="text-right py-2 px-2 text-[#4F7C3A]">
                          {totalDebit > 0 ? formatCurrency(totalDebit) : ""}
                        </td>
                        <td className="text-right py-2 px-2 text-[#9A3A2D]">
                          {totalCredit > 0 ? formatCurrency(totalCredit) : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/* ============================================================
   TAB 3: Bank Accounts
   ============================================================ */
function BankAccountsTab({
  data,
  onRefresh,
}: {
  data: CashFlowData;
  onRefresh: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [formAccount, setFormAccount] = useState(data.bankAccounts[0]?.id || "");
  const [formDate, setFormDate] = useState(new Date().toISOString().split("T")[0]);
  const [formDesc, setFormDesc] = useState("");
  const [formAmount, setFormAmount] = useState("");
  const [formType, setFormType] = useState<"DEPOSIT" | "WITHDRAWAL" | "TRANSFER">("DEPOSIT");
  const [formRef, setFormRef] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const totalBalance = data.bankAccounts.reduce((s, a) => s + a.balanceSen, 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formDesc || !formAmount) return;
    setSubmitting(true);
    const amountSen = Math.round(parseFloat(formAmount) * 100);
    try {
      await fetch("/api/cash-flow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add-transaction",
          bankAccountId: formAccount,
          date: formDate,
          description: formDesc,
          amountSen: formType === "WITHDRAWAL" ? -Math.abs(amountSen) : Math.abs(amountSen),
          type: formType,
          reference: formRef,
        }),
      });
      setFormDesc("");
      setFormAmount("");
      setFormRef("");
      setShowForm(false);
      onRefresh();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Total */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-[#6B7280] uppercase tracking-wide">
                Total Across All Accounts
              </p>
              <p className="text-3xl font-bold text-[#1F1D1B] mt-1">
                {formatCurrency(totalBalance)}
              </p>
            </div>
            <Button variant="primary" onClick={() => setShowForm(!showForm)}>
              {showForm ? "Cancel" : "Add Transaction"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Add Transaction form */}
      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>Add Transaction</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-[#6B7280] mb-1">
                  Account
                </label>
                <select
                  value={formAccount}
                  onChange={(e) => setFormAccount(e.target.value)}
                  className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                >
                  {data.bankAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.bankName} - {a.accountNo}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-[#6B7280] mb-1">
                  Date
                </label>
                <input
                  type="date"
                  value={formDate}
                  onChange={(e) => setFormDate(e.target.value)}
                  className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#6B7280] mb-1">
                  Type
                </label>
                <select
                  value={formType}
                  onChange={(e) =>
                    setFormType(e.target.value as "DEPOSIT" | "WITHDRAWAL" | "TRANSFER")
                  }
                  className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                >
                  <option value="DEPOSIT">Deposit</option>
                  <option value="WITHDRAWAL">Withdrawal</option>
                  <option value="TRANSFER">Transfer</option>
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-[#6B7280] mb-1">
                  Description
                </label>
                <input
                  type="text"
                  value={formDesc}
                  onChange={(e) => setFormDesc(e.target.value)}
                  placeholder="Transaction description"
                  className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#6B7280] mb-1">
                  Amount (MYR)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={formAmount}
                  onChange={(e) => setFormAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  required
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-[#6B7280] mb-1">
                  Reference
                </label>
                <input
                  type="text"
                  value={formRef}
                  onChange={(e) => setFormRef(e.target.value)}
                  placeholder="Reference number"
                  className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                />
              </div>
              <div className="flex items-end">
                <Button type="submit" variant="primary" disabled={submitting} className="w-full">
                  {submitting ? "Adding..." : "Add Transaction"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Bank account cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {data.bankAccounts.map((account) => {
          const txs = data.bankTransactions
            .filter((t) => t.bankAccountId === account.id)
            .sort((a, b) => b.date.localeCompare(a.date));

          return (
            <Card key={account.id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>{account.bankName}</CardTitle>
                    <p className="text-sm text-[#6B7280] mt-0.5">{account.accountNo}</p>
                  </div>
                  <Badge>{account.currency}</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="mb-4">
                  <p className="text-xs text-[#6B7280]">Current Balance</p>
                  <p className="text-2xl font-bold text-[#1F1D1B]">
                    {formatCurrency(account.balanceSen, account.currency)}
                  </p>
                  <p className="text-xs text-[#6B7280] mt-1">{account.accountName}</p>
                </div>

                <div>
                  <p className="text-xs font-medium text-[#6B7280] uppercase tracking-wide mb-2">
                    Recent Transactions
                  </p>
                  <div className="space-y-1.5 max-h-56 overflow-y-auto">
                    {txs.slice(0, 8).map((tx) => (
                      <div
                        key={tx.id}
                        className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-[#F0ECE9]/50 text-sm"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-[#1F1D1B] truncate">{tx.description}</p>
                          <p className="text-[10px] text-[#6B7280]">
                            {formatDate(tx.date)} &middot; {tx.reference}
                          </p>
                        </div>
                        <span
                          className={cn(
                            "font-medium ml-3 whitespace-nowrap",
                            tx.amountSen >= 0 ? "text-[#4F7C3A]" : "text-[#9A3A2D]"
                          )}
                        >
                          {tx.amountSen >= 0 ? "+" : ""}
                          {formatCurrency(tx.amountSen)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
