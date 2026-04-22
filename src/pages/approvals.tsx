import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { ApprovalRequest } from "@/lib/mock-data";
import {
  ClipboardCheck,
  DollarSign,
  Percent,
  ShoppingCart,
  Calendar,
  Package,
  CreditCard,
  XCircle,
  Loader2,
  Check,
  X,
  ChevronDown,
  ChevronUp,
  Clock,
  User,
} from "lucide-react";

// --- Type config ---
type ApprovalType = ApprovalRequest["type"];

const TYPE_CONFIG: Record<
  ApprovalType,
  { label: string; icon: React.ReactNode; color: string; bgColor: string; borderColor: string }
> = {
  PRICE_OVERRIDE: {
    label: "Price Override",
    icon: <DollarSign className="h-4 w-4" />,
    color: "text-[#6B4A6D]",
    bgColor: "bg-[#F1E6F0]",
    borderColor: "border-[#D1B7D0]",
  },
  DISCOUNT: {
    label: "Discount",
    icon: <Percent className="h-4 w-4" />,
    color: "text-[#3E6570]",
    bgColor: "bg-[#E0EDF0]",
    borderColor: "border-[#A8CAD2]",
  },
  PO_APPROVAL: {
    label: "PO Approval",
    icon: <ShoppingCart className="h-4 w-4" />,
    color: "text-[#4F7C3A]",
    bgColor: "bg-[#EEF3E4]",
    borderColor: "border-[#C6DBA8]",
  },
  LEAVE_REQUEST: {
    label: "Leave Request",
    icon: <Calendar className="h-4 w-4" />,
    color: "text-[#3E6570]",
    bgColor: "bg-[#E0EDF0]",
    borderColor: "border-[#A8CAD2]",
  },
  STOCK_ADJUSTMENT: {
    label: "Stock Adjustment",
    icon: <Package className="h-4 w-4" />,
    color: "text-[#9C6F1E]",
    bgColor: "bg-[#FAEFCB]",
    borderColor: "border-[#E8D597]",
  },
  CREDIT_OVERRIDE: {
    label: "Credit Override",
    icon: <CreditCard className="h-4 w-4" />,
    color: "text-[#9A3A2D]",
    bgColor: "bg-[#F9E1DA]",
    borderColor: "border-[#E8B2A1]",
  },
  SO_CANCELLATION: {
    label: "SO Cancellation",
    icon: <XCircle className="h-4 w-4" />,
    color: "text-[#9A3A2D]",
    bgColor: "bg-[#F9E1DA]",
    borderColor: "border-[#E8B2A1]",
  },
};

const STATUS_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  PENDING: { bg: "bg-[#FAEFCB]", text: "text-[#9C6F1E]", border: "border-[#E8D597]" },
  APPROVED: { bg: "bg-[#EEF3E4]", text: "text-[#4F7C3A]", border: "border-[#C6DBA8]" },
  REJECTED: { bg: "bg-[#F9E1DA]", text: "text-[#9A3A2D]", border: "border-[#E8B2A1]" },
};

function formatAmount(sen: number): string {
  return `RM ${(sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2 })}`;
}

function relativeTime(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" });
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-MY", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type FilterTab = "ALL" | "PENDING" | "APPROVED" | "REJECTED";

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<FilterTab>("ALL");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchApprovals = useCallback(async () => {
    try {
      const res = await fetch("/api/approvals");
      if (!res.ok) return;
      const raw: unknown = await res.json();
      const list = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { data?: unknown })?.data)
          ? (raw as { data: unknown[] }).data
          : [];
      setApprovals(list as typeof approvals);
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchApprovals();
  }, [fetchApprovals]);

  const handleAction = async (id: string, action: "APPROVE" | "REJECT", reason?: string) => {
    setActionLoading(id);
    try {
      const res = await fetch("/api/approvals", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action, reason }),
      });
      if (res.ok) {
        await fetchApprovals();
        setRejectingId(null);
        setRejectReason("");
      }
    } catch {
      // silently ignore
    } finally {
      setActionLoading(null);
    }
  };

  // --- Computed ---
  const pendingCount = approvals.filter((a) => a.status === "PENDING").length;
  const today = new Date().toISOString().slice(0, 10);
  const approvedToday = approvals.filter(
    (a) => a.status === "APPROVED" && a.approvedAt && a.approvedAt.slice(0, 10) === today
  ).length;
  const rejectedToday = approvals.filter(
    (a) => a.status === "REJECTED" && a.approvedAt && a.approvedAt.slice(0, 10) === today
  ).length;
  const thisMonth = new Date().toISOString().slice(0, 7);
  const totalThisMonth = approvals.filter(
    (a) => a.requestedAt.slice(0, 7) === thisMonth
  ).length;

  const filtered =
    activeTab === "ALL"
      ? approvals
      : approvals.filter((a) => a.status === activeTab);

  const tabs: { key: FilterTab; label: string; count: number }[] = [
    { key: "ALL", label: "All", count: approvals.length },
    { key: "PENDING", label: "Pending", count: pendingCount },
    { key: "APPROVED", label: "Approved", count: approvals.filter((a) => a.status === "APPROVED").length },
    { key: "REJECTED", label: "Rejected", count: approvals.filter((a) => a.status === "REJECTED").length },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-[#6B5C32]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <ClipboardCheck className="h-7 w-7 text-[#6B5C32]" />
        <h1 className="text-xl font-bold text-[#1F1D1B]">Approval Queue</h1>
        {pendingCount > 0 && (
          <span className="flex items-center justify-center rounded-full bg-[#9C6F1E] text-white text-xs font-bold h-6 min-w-[24px] px-2">
            {pendingCount}
          </span>
        )}
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-[#6B7280] uppercase tracking-wide">Pending</p>
                <p className="text-2xl font-bold text-[#9C6F1E] mt-1">{pendingCount}</p>
              </div>
              <div className="h-10 w-10 rounded-lg bg-[#FAEFCB] flex items-center justify-center">
                <Clock className="h-5 w-5 text-[#9C6F1E]" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-[#6B7280] uppercase tracking-wide">Approved Today</p>
                <p className="text-2xl font-bold text-[#4F7C3A] mt-1">{approvedToday}</p>
              </div>
              <div className="h-10 w-10 rounded-lg bg-[#EEF3E4] flex items-center justify-center">
                <Check className="h-5 w-5 text-[#4F7C3A]" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-[#6B7280] uppercase tracking-wide">Rejected Today</p>
                <p className="text-2xl font-bold text-[#9A3A2D] mt-1">{rejectedToday}</p>
              </div>
              <div className="h-10 w-10 rounded-lg bg-[#F9E1DA] flex items-center justify-center">
                <X className="h-5 w-5 text-[#9A3A2D]" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-[#6B7280] uppercase tracking-wide">Total This Month</p>
                <p className="text-2xl font-bold text-[#1F1D1B] mt-1">{totalThisMonth}</p>
              </div>
              <div className="h-10 w-10 rounded-lg bg-[#F0ECE9] flex items-center justify-center">
                <ClipboardCheck className="h-5 w-5 text-[#6B5C32]" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-1 bg-[#F0ECE9] rounded-lg p-1 w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors cursor-pointer ${
              activeTab === tab.key
                ? "bg-white text-[#1F1D1B] shadow-sm"
                : "text-[#6B7280] hover:text-[#1F1D1B]"
            }`}
          >
            {tab.label}
            <span className="ml-1.5 text-xs opacity-60">({tab.count})</span>
          </button>
        ))}
      </div>

      {/* Approval List */}
      <div className="space-y-3">
        {filtered.length === 0 && (
          <Card>
            <CardContent className="p-8 text-center text-[#6B7280]">
              No approvals found for this filter.
            </CardContent>
          </Card>
        )}

        {filtered.map((approval) => {
          const cfg = TYPE_CONFIG[approval.type];
          const statusColor = STATUS_COLORS[approval.status];
          const isExpanded = expandedId === approval.id;
          const isRejecting = rejectingId === approval.id;
          const isLoading = actionLoading === approval.id;

          return (
            <Card key={approval.id} className="overflow-hidden">
              {/* Main row */}
              <div
                className="p-4 cursor-pointer hover:bg-[#F0ECE9]/30 transition-colors"
                onClick={() => setExpandedId(isExpanded ? null : approval.id)}
              >
                <div className="flex items-start gap-4">
                  {/* Type icon */}
                  <div
                    className={`h-10 w-10 rounded-lg flex items-center justify-center shrink-0 ${cfg.bgColor} ${cfg.color}`}
                  >
                    {cfg.icon}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${cfg.bgColor} ${cfg.color} ${cfg.borderColor}`}
                          >
                            {cfg.label}
                          </span>
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${statusColor.bg} ${statusColor.text} ${statusColor.border}`}
                          >
                            {approval.status}
                          </span>
                        </div>
                        <h3 className="font-semibold text-[#1F1D1B] mt-1.5 truncate">
                          {approval.title}
                        </h3>
                        <p className="text-sm text-[#6B7280] mt-0.5 line-clamp-1">
                          {approval.description}
                        </p>
                        <div className="flex items-center gap-4 mt-2 text-xs text-[#6B7280]">
                          <span className="font-mono text-[#6B5C32]">
                            {approval.referenceNo}
                          </span>
                          <span className="flex items-center gap-1">
                            <User className="h-3 w-3" />
                            {approval.requestedBy}
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {relativeTime(approval.requestedAt)}
                          </span>
                          {approval.amountSen !== undefined && (
                            <span className="font-semibold text-[#1F1D1B]">
                              {formatAmount(approval.amountSen)}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Actions + expand */}
                      <div className="flex items-center gap-2 shrink-0">
                        {approval.status === "PENDING" && (
                          <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                            <Button
                              size="sm"
                              className="bg-[#4F7C3A] hover:bg-[#3D6329] text-white"
                              disabled={isLoading}
                              onClick={() => handleAction(approval.id, "APPROVE")}
                            >
                              {isLoading ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Check className="h-3.5 w-3.5" />
                              )}
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={isLoading}
                              onClick={() => {
                                setRejectingId(isRejecting ? null : approval.id);
                                setRejectReason("");
                              }}
                            >
                              <X className="h-3.5 w-3.5" />
                              Reject
                            </Button>
                          </div>
                        )}
                        {isExpanded ? (
                          <ChevronUp className="h-4 w-4 text-[#6B7280]" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-[#6B7280]" />
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Reject reason input */}
                {isRejecting && (
                  <div
                    className="mt-3 ml-14 flex gap-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="text"
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="Enter rejection reason..."
                      className="flex-1 rounded-md border border-[#E2DDD8] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32] bg-white"
                      autoFocus
                    />
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={!rejectReason.trim() || isLoading}
                      onClick={() =>
                        handleAction(approval.id, "REJECT", rejectReason.trim())
                      }
                    >
                      {isLoading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        "Confirm Reject"
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setRejectingId(null);
                        setRejectReason("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </div>

              {/* Expanded detail */}
              {isExpanded && (
                <div className="border-t border-[#E2DDD8] bg-[#F0ECE9]/20 px-4 py-4">
                  <div className="ml-14 space-y-4">
                    {/* Description */}
                    <div>
                      <h4 className="text-xs font-semibold text-[#6B7280] uppercase tracking-wide mb-1">
                        Description
                      </h4>
                      <p className="text-sm text-[#1F1D1B]">{approval.description}</p>
                    </div>

                    {/* Metadata */}
                    {approval.metadata && Object.keys(approval.metadata).length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-[#6B7280] uppercase tracking-wide mb-2">
                          Details
                        </h4>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {Object.entries(approval.metadata).map(([key, value]) => (
                            <div
                              key={key}
                              className="rounded-md bg-white border border-[#E2DDD8] px-3 py-2"
                            >
                              <p className="text-[10px] font-medium text-[#6B7280] uppercase">
                                {key}
                              </p>
                              <p className="text-sm font-medium text-[#1F1D1B] mt-0.5">
                                {value}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Approval History */}
                    {(approval.status === "APPROVED" || approval.status === "REJECTED") && (
                      <div>
                        <h4 className="text-xs font-semibold text-[#6B7280] uppercase tracking-wide mb-2">
                          Approval History
                        </h4>
                        <div className="space-y-2">
                          {/* Request event */}
                          <div className="flex items-start gap-3">
                            <div className="h-6 w-6 rounded-full bg-[#E0EDF0] flex items-center justify-center shrink-0 mt-0.5">
                              <User className="h-3 w-3 text-[#3E6570]" />
                            </div>
                            <div>
                              <p className="text-sm text-[#1F1D1B]">
                                <span className="font-medium">{approval.requestedBy}</span>{" "}
                                submitted this request
                              </p>
                              <p className="text-xs text-[#6B7280]">
                                {formatDate(approval.requestedAt)}
                              </p>
                            </div>
                          </div>
                          {/* Decision event */}
                          <div className="flex items-start gap-3">
                            <div
                              className={`h-6 w-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                                approval.status === "APPROVED" ? "bg-[#EEF3E4]" : "bg-[#F9E1DA]"
                              }`}
                            >
                              {approval.status === "APPROVED" ? (
                                <Check className="h-3 w-3 text-[#4F7C3A]" />
                              ) : (
                                <X className="h-3 w-3 text-[#9A3A2D]" />
                              )}
                            </div>
                            <div>
                              <p className="text-sm text-[#1F1D1B]">
                                <span className="font-medium">{approval.approvedBy}</span>{" "}
                                {approval.status === "APPROVED" ? "approved" : "rejected"} this
                                request
                              </p>
                              {approval.approvedAt && (
                                <p className="text-xs text-[#6B7280]">
                                  {formatDate(approval.approvedAt)}
                                </p>
                              )}
                              {approval.reason && (
                                <p className="text-sm text-[#9A3A2D] mt-1 bg-[#F9E1DA] rounded px-2 py-1 border border-[#E8B2A1]">
                                  {approval.reason}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
