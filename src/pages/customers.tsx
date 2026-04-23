import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency, formatRM } from "@/lib/utils";
import type { Customer } from "@/lib/mock-data";
import {
  Plus,
  Building2,
  Phone,
  Mail,
  X,
  Loader2,
  MapPin,
  Users,
  Eye,
  Pencil,
  Trash2,
  RefreshCw,
  Warehouse,
} from "lucide-react";

// ---------- State badge colours ----------
const stateBadgeColors: Record<string, string> = {
  KL: "bg-[#E0EDF0] text-[#3E6570] border-[#A8CAD2]",
  PG: "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]",
  SRW: "bg-[#FBE4CE] text-[#B8601A] border-[#E8B786]",
  SBH: "bg-[#F1E6F0] text-[#6B4A6D] border-[#D1B7D0]",
  JB: "bg-[#F9E1DA] text-[#9A3A2D] border-[#E8B2A1]",
};

function StateBadge({ state }: { state: string }) {
  if (!state) return null;
  const colors = stateBadgeColors[state] || "bg-gray-100 text-gray-700 border-gray-300";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${colors}`}>
      {state}
    </span>
  );
}

// =====================================================================
// Main Page
// =====================================================================
export default function CustomersPage() {
  const [data, setData] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedCustomer, setExpandedCustomer] = useState<string | null>(null);

  // add-form state
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ code: "", name: "", contactName: "", phone: "", email: "", creditTerms: "NET30", creditLimitSen: 0 });
  const [addSaving, setAddSaving] = useState(false);

  // edit customer dialog state
  const [editCustomer, setEditCustomer] = useState<Customer | null>(null);
  const [editCustForm, setEditCustForm] = useState({ name: "", ssmNo: "", companyAddress: "", contactName: "", phone: "", email: "", creditTerms: "", creditLimitSen: 0 });

  // add/edit hub form state
  const [showAddHub, setShowAddHub] = useState(false);
  const [editHubId, setEditHubId] = useState<string | null>(null);
  const [hubForm, setHubForm] = useState({ shortName: "", code: "", state: "KL", contactName: "", phone: "", email: "", address: "" });

  // ---------- Fetch ----------
  const fetchCustomers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/customers");
      const json = await res.json();
      if (json.success) setData(json.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  // ---------- Add ----------
  const handleAdd = async () => {
    setAddSaving(true);
    try {
      const res = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addForm),
      });
      const json = await res.json();
      if (json.success) {
        setData((prev) => [...prev, json.data]);
        setAddForm({ code: "", name: "", contactName: "", phone: "", email: "", creditTerms: "NET30", creditLimitSen: 0 });
        setShowAdd(false);
      }
    } finally {
      setAddSaving(false);
    }
  };

  // ---------- Delete ----------
  const handleDelete = async (customer: Customer) => {
    if (!confirm(`Delete customer "${customer.name}"?`)) return;
    try {
      const res = await fetch(`/api/customers/${customer.id}`, { method: "DELETE" });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json: any = await res.json().catch(() => ({}));
      // res.ok guard — a failed DELETE (foreign-key block, 401, 500) would
      // otherwise let the row disappear from the list locally while the
      // customer stays in the DB. On next reload it reappears "zombie" style.
      if (!res.ok) {
        alert(json?.error || `Failed to delete customer (HTTP ${res.status})`);
        return;
      }
      if (json.success) {
        setData((prev) => prev.filter((c) => c.id !== customer.id));
      } else {
        alert(json.error || "Failed to delete customer");
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : "Network error — customer not deleted");
    }
  };

  // ---------- Persist customer to API ----------
  const persistCustomer = async (updated: Customer) => {
    setData((prev) => prev.map((c) => c.id === updated.id ? updated : c));
    await fetch(`/api/customers/${updated.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });
  };

  // ---------- Edit Customer ----------
  const openEditCustomer = (cust: Customer) => {
    setEditCustomer(cust);
    setEditCustForm({
      name: cust.name,
      ssmNo: cust.ssmNo || "",
      companyAddress: cust.companyAddress || "",
      contactName: cust.contactName,
      phone: cust.phone,
      email: cust.email,
      creditTerms: cust.creditTerms,
      creditLimitSen: cust.creditLimitSen,
    });
  };

  const saveEditCustomer = () => {
    if (!editCustomer) return;
    const updated = { ...editCustomer, ...editCustForm };
    persistCustomer(updated);
    setEditCustomer(null);
  };

  // ---------- KPI calculations ----------
  const totalCustomers = data.length;
  const totalHubs = data.reduce((s, c) => s + (c.deliveryHubs?.length || 0), 0);
  const totalOutstanding = data.reduce((s, c) => s + c.outstandingSen, 0);
  const totalCreditLimit = data.reduce((s, c) => s + c.creditLimitSen, 0);

  // ---------- Columns ----------
  const columns: Column<Customer>[] = [
    {
      key: "code",
      label: "Creditor Code",
      type: "docno",
      width: "120px",
      sortable: true,
    },
    {
      key: "name",
      label: "Customer Name",
      width: "200px",
      sortable: true,
      render: (_value, row) => (
        <div>
          <p className="font-medium text-[#1F1D1B]">{row.name}</p>
          <p className="text-xs text-[#9CA3AF]">{row.contactName}</p>
        </div>
      ),
    },
    {
      key: "deliveryHubs" as keyof Customer,
      label: "Delivery Hubs",
      width: "200px",
      sortable: false,
      render: (_value, row) => {
        const hubs = row.deliveryHubs || [];
        if (hubs.length === 0) return <span className="text-xs text-[#9CA3AF]">No hubs</span>;
        return (
          <div className="flex flex-col gap-0.5">
            {hubs.map((h) => (
              <div key={h.id} className="flex items-center gap-1.5 text-xs">
                <StateBadge state={h.state} />
                <span className="text-[#1F1D1B]">{h.shortName}</span>
              </div>
            ))}
          </div>
        );
      },
    },
    {
      key: "contactName",
      label: "PIC",
      width: "150px",
      sortable: true,
      render: (_value, row) => {
        const hubs = row.deliveryHubs || [];
        if (hubs.length <= 1) return <span className="text-sm">{row.contactName}</span>;
        return (
          <div className="flex flex-col gap-0.5">
            {hubs.map((h) => (
              <span key={h.id} className="text-xs text-[#1F1D1B]">{h.contactName}</span>
            ))}
          </div>
        );
      },
    },
    {
      key: "phone",
      label: "PIC Contact",
      width: "200px",
      render: (_value, row) => {
        const hubs = row.deliveryHubs || [];
        if (hubs.length <= 1) {
          return (
            <div className="space-y-0.5">
              <div className="flex items-center gap-1 text-xs text-[#6B7280]">
                <Phone className="h-3 w-3" />
                {row.phone}
              </div>
              {row.email && (
                <div className="flex items-center gap-1 text-xs text-[#6B7280]">
                  <Mail className="h-3 w-3" />
                  {row.email}
                </div>
              )}
            </div>
          );
        }
        return (
          <div className="flex flex-col gap-0.5">
            {hubs.map((h) => (
              <div key={h.id} className="flex items-center gap-1 text-xs text-[#6B7280]">
                <Phone className="h-3 w-3" />
                {h.phone}
              </div>
            ))}
          </div>
        );
      },
    },
    {
      key: "creditTerms",
      label: "Terms",
      width: "80px",
      sortable: true,
      align: "center",
      render: (_value, row) => <Badge>{row.creditTerms}</Badge>,
    },
    {
      key: "creditLimitSen",
      label: "Credit Limit",
      type: "currency",
      width: "130px",
      sortable: true,
      align: "right",
    },
    {
      key: "outstandingSen",
      label: "Outstanding",
      width: "140px",
      sortable: true,
      align: "right",
      render: (_value, row) => {
        const pct = row.creditLimitSen > 0
          ? (row.outstandingSen / row.creditLimitSen) * 100
          : 0;
        return (
          <div>
            <span className={`font-medium tabular-nums ${pct > 80 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>
              {formatRM(row.outstandingSen)}
            </span>
            <div className="mt-1 h-1 w-full rounded-full bg-[#E2DDD8]">
              <div
                className={`h-1 rounded-full ${
                  pct > 80 ? "bg-[#9A3A2D]" : pct > 50 ? "bg-[#9C6F1E]" : "bg-[#4F7C3A]"
                }`}
                style={{ width: `${Math.min(pct, 100)}%` }}
              />
            </div>
          </div>
        );
      },
    },
  ];

  // ---------- Context menu ----------
  const contextMenuItems: ContextMenuItem[] = [
    {
      label: "View",
      icon: <Eye className="h-3.5 w-3.5" />,
      action: (row: Customer) => setExpandedCustomer(expandedCustomer === row.id ? null : row.id),
    },
    {
      label: "Edit",
      icon: <Pencil className="h-3.5 w-3.5" />,
      action: (row: Customer) => openEditCustomer(row),
    },
    { label: "", separator: true, action: () => {} },
    {
      label: "Delete",
      icon: <Trash2 className="h-3.5 w-3.5" />,
      danger: true,
      action: (row: Customer) => handleDelete(row),
    },
    { label: "", separator: true, action: () => {} },
    {
      label: "Refresh",
      icon: <RefreshCw className="h-3.5 w-3.5" />,
      action: () => fetchCustomers(),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Customers</h1>
          <p className="text-xs text-[#6B7280]">
            Manage customer accounts, delivery hubs, and credit
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => {
            setShowAdd((v) => !v);
          }}
        >
          {showAdd ? (
            <>
              <X className="h-4 w-4" />
              Cancel
            </>
          ) : (
            <>
              <Plus className="h-4 w-4" />
              Add Customer
            </>
          )}
        </Button>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">Total Customers</p>
            <p className="text-xl font-bold text-[#1F1D1B]">{totalCustomers}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">Delivery Hubs</p>
            <p className="text-xl font-bold text-[#1F1D1B]">{totalHubs}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">Total Outstanding</p>
            <p className="text-xl font-bold text-[#1F1D1B]">
              {formatCurrency(totalOutstanding)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">Total Credit Limit</p>
            <p className="text-xl font-bold text-[#1F1D1B]">
              {formatCurrency(totalCreditLimit)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Add Customer Form */}
      {showAdd && (
        <Card className="border-[#6B5C32] border-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">New Customer</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label className="text-xs font-medium text-[#374151] mb-1 block">Creditor Code *</label>
                <Input value={addForm.code} onChange={(e) => setAddForm({ ...addForm, code: e.target.value })} placeholder="e.g. 300-X" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#374151] mb-1 block">Customer Name *</label>
                <Input value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} placeholder="Company name" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#374151] mb-1 block">PIC</label>
                <Input value={addForm.contactName} onChange={(e) => setAddForm({ ...addForm, contactName: e.target.value })} placeholder="e.g. Purchasing" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#374151] mb-1 block">PIC Contact</label>
                <Input value={addForm.phone} onChange={(e) => setAddForm({ ...addForm, phone: e.target.value })} placeholder="011-6151 1613" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#374151] mb-1 block">PIC Email</label>
                <Input value={addForm.email} onChange={(e) => setAddForm({ ...addForm, email: e.target.value })} placeholder="email@example.com" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#374151] mb-1 block">Credit Terms</label>
                <Input value={addForm.creditTerms} onChange={(e) => setAddForm({ ...addForm, creditTerms: e.target.value })} placeholder="NET30" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#374151] mb-1 block">Credit Limit (RM)</label>
                <Input type="number" value={addForm.creditLimitSen / 100} onChange={(e) => setAddForm({ ...addForm, creditLimitSen: Math.round(Number(e.target.value) * 100) })} placeholder="0.00" />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button variant="primary" disabled={!addForm.code || !addForm.name || addSaving} onClick={handleAdd}>
                {addSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Create Customer
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Customer List */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-[#6B5C32]" />
            All Customers
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataGrid<Customer>
            columns={columns}
            data={data}
            keyField="id"
            gridId="customers"
            loading={loading}
            stickyHeader={true}
            emptyMessage="No customers found."
            onRowClick={(row) => setExpandedCustomer(expandedCustomer === row.id ? null : row.id)}
            contextMenuItems={contextMenuItems}
          />
        </CardContent>
      </Card>

      {/* Expanded Customer Detail (Delivery Hubs) */}
      {expandedCustomer && (() => {
        const cust = data.find((c) => c.id === expandedCustomer);
        if (!cust) return null;
        return (
          <Card className="border-[#6B5C32] border-2">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Warehouse className="h-5 w-5 text-[#6B5C32]" />
                  {cust.name} — Delivery Hubs ({cust.deliveryHubs?.length || 0})
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => openEditCustomer(cust)}>
                    <Pencil className="h-4 w-4 mr-1" /> Edit
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => { setShowAddHub(true); setHubForm({ shortName: "", code: "", state: "KL", contactName: "", phone: "", email: "", address: "" }); }}>
                    <Plus className="h-4 w-4 mr-1" /> Add Hub
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setExpandedCustomer(null)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="flex items-center gap-4 mt-2 text-sm text-[#6B7280]">
                <span>Credit Limit: <strong className="text-[#1F1D1B]">{formatRM(cust.creditLimitSen)}</strong></span>
                <span>Outstanding: <strong className="text-[#1F1D1B]">{formatRM(cust.outstandingSen)}</strong></span>
                <span>Terms: <Badge>{cust.creditTerms}</Badge></span>
              </div>
            </CardHeader>
            <CardContent>
              {(!cust.deliveryHubs || cust.deliveryHubs.length === 0) ? (
                <p className="text-sm text-[#9CA3AF] py-4 text-center">No delivery hubs configured</p>
              ) : (
                <div className="space-y-2">
                  {cust.deliveryHubs.map((hub) => (
                    editHubId === hub.id ? (
                      <div key={hub.id} className="p-4 rounded-lg border-2 border-[#6B5C32]/30 bg-[#FAF9F7] space-y-3">
                        <h3 className="text-sm font-semibold text-[#6B5C32]">Edit Hub — {hub.shortName}</h3>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                          <div>
                            <label className="block text-xs text-[#6B7280] mb-1">Hub Name *</label>
                            <Input value={hubForm.shortName} onChange={(e) => setHubForm(f => ({ ...f, shortName: e.target.value }))} className="h-8" />
                          </div>
                          <div>
                            <label className="block text-xs text-[#6B7280] mb-1">Hub Code</label>
                            <Input value={hubForm.code} onChange={(e) => setHubForm(f => ({ ...f, code: e.target.value }))} className="h-8" />
                          </div>
                          <div>
                            <label className="block text-xs text-[#6B7280] mb-1">State *</label>
                            <select value={hubForm.state} onChange={(e) => setHubForm(f => ({ ...f, state: e.target.value }))} className="w-full h-8 rounded border border-[#E2DDD8] px-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20">
                              {["KL","PG","JB","SRW","SBH","IPH","MLK","KCH","KB","KT"].map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs text-[#6B7280] mb-1">Contact Name</label>
                            <Input value={hubForm.contactName} onChange={(e) => setHubForm(f => ({ ...f, contactName: e.target.value }))} className="h-8" />
                          </div>
                          <div>
                            <label className="block text-xs text-[#6B7280] mb-1">Phone</label>
                            <Input value={hubForm.phone} onChange={(e) => setHubForm(f => ({ ...f, phone: e.target.value }))} className="h-8" />
                          </div>
                          <div>
                            <label className="block text-xs text-[#6B7280] mb-1">Email</label>
                            <Input value={hubForm.email} onChange={(e) => setHubForm(f => ({ ...f, email: e.target.value }))} className="h-8" />
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs text-[#6B7280] mb-1">Address *</label>
                          <Input value={hubForm.address} onChange={(e) => setHubForm(f => ({ ...f, address: e.target.value }))} />
                        </div>
                        <div className="flex justify-end gap-2">
                          <Button variant="outline" size="sm" onClick={() => setEditHubId(null)}>Cancel</Button>
                          <Button variant="primary" size="sm" onClick={() => {
                            const cust = data.find(c => c.id === expandedCustomer);
                            if (cust) {
                              persistCustomer({ ...cust, deliveryHubs: cust.deliveryHubs.map(h => h.id === editHubId ? { ...h, ...hubForm } : h) });
                            }
                            setEditHubId(null);
                          }}>Save</Button>
                        </div>
                      </div>
                    ) : (
                      <div key={hub.id} className="flex items-center gap-4 p-3 rounded-lg border border-[#E2DDD8] hover:bg-[#FAF9F7] group">
                        <StateBadge state={hub.state} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm text-[#1F1D1B]">{hub.shortName}</span>
                            <span className="text-xs text-[#9CA3AF] doc-number">{hub.code}</span>
                            <StateBadge state={hub.state} />
                            {hub.isDefault && <Badge className="bg-[#6B5C32]/10 text-[#6B5C32] border-[#6B5C32]/20 text-[10px]">Default</Badge>}
                          </div>
                          <div className="flex items-center gap-3 mt-0.5 text-xs text-[#6B7280]">
                            <span className="flex items-center gap-1"><Users className="h-3 w-3" />{hub.contactName}</span>
                            <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{hub.phone}</span>
                            {hub.email && <span className="flex items-center gap-1"><Mail className="h-3 w-3" />{hub.email}</span>}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-1 text-xs text-[#6B7280] max-w-xs text-right">
                            <MapPin className="h-3 w-3 flex-shrink-0" />
                            <span className="line-clamp-2">{hub.address}</span>
                          </div>
                          <button
                            onClick={() => {
                              setEditHubId(hub.id);
                              setHubForm({ shortName: hub.shortName, code: hub.code, state: hub.state, contactName: hub.contactName, phone: hub.phone, email: hub.email || "", address: hub.address });
                            }}
                            className="p-1.5 rounded hover:bg-[#E2DDD8] opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <Pencil className="h-3.5 w-3.5 text-[#6B5C32]" />
                          </button>
                          <button
                            onClick={() => {
                              if (!confirm(`Delete hub "${hub.shortName}"?`)) return;
                              const cust = data.find(c => c.id === expandedCustomer);
                              if (cust) {
                                persistCustomer({ ...cust, deliveryHubs: cust.deliveryHubs.filter(h => h.id !== hub.id) });
                              }
                            }}
                            className="p-1.5 rounded hover:bg-[#F9E1DA] opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <Trash2 className="h-3.5 w-3.5 text-[#9A3A2D]" />
                          </button>
                        </div>
                      </div>
                    )
                  ))}
                </div>
              )}
              {/* Add Hub Form */}
              {showAddHub && (
                <div className="mt-3 p-4 rounded-lg border-2 border-dashed border-[#6B5C32]/30 bg-[#FAF9F7] space-y-3">
                  <h3 className="text-sm font-semibold text-[#6B5C32]">Add New Hub</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1">Hub Name *</label>
                      <Input value={hubForm.shortName} onChange={(e) => setHubForm(f => ({ ...f, shortName: e.target.value }))} placeholder="e.g. Houzs JB" className="h-8" />
                    </div>
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1">Hub Code *</label>
                      <Input value={hubForm.code} onChange={(e) => setHubForm(f => ({ ...f, code: e.target.value }))} placeholder="e.g. 300-H005" className="h-8" />
                    </div>
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1">State *</label>
                      <select
                        value={hubForm.state}
                        onChange={(e) => setHubForm(f => ({ ...f, state: e.target.value }))}
                        className="w-full h-8 rounded border border-[#E2DDD8] px-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20"
                      >
                        <option value="KL">KL</option>
                        <option value="PG">PG</option>
                        <option value="JB">JB</option>
                        <option value="SRW">SRW</option>
                        <option value="SBH">SBH</option>
                        <option value="IPH">IPH</option>
                        <option value="MLK">MLK</option>
                        <option value="KCH">KCH</option>
                        <option value="KB">KB</option>
                        <option value="KT">KT</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1">Contact Name</label>
                      <Input value={hubForm.contactName} onChange={(e) => setHubForm(f => ({ ...f, contactName: e.target.value }))} placeholder="PIC name" className="h-8" />
                    </div>
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1">Phone</label>
                      <Input value={hubForm.phone} onChange={(e) => setHubForm(f => ({ ...f, phone: e.target.value }))} placeholder="e.g. 012-345 6789" className="h-8" />
                    </div>
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1">Email</label>
                      <Input value={hubForm.email} onChange={(e) => setHubForm(f => ({ ...f, email: e.target.value }))} placeholder="email@example.com" className="h-8" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Address *</label>
                    <Input value={hubForm.address} onChange={(e) => setHubForm(f => ({ ...f, address: e.target.value }))} placeholder="Full delivery address" />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setShowAddHub(false)}>Cancel</Button>
                    <Button variant="primary" size="sm" disabled={!hubForm.shortName || !hubForm.code || !hubForm.address} onClick={() => {
                      const newHub = { id: `hub-${Date.now()}`, ...hubForm, isDefault: false };
                      const cust = data.find(c => c.id === expandedCustomer);
                      if (cust) {
                        persistCustomer({ ...cust, deliveryHubs: [...(cust.deliveryHubs || []), newHub] });
                      }
                      setShowAddHub(false);
                    }}>Save Hub</Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })()}

      {/* Edit Customer Dialog */}
      {editCustomer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
              <h2 className="text-lg font-semibold text-[#1F1D1B]">Edit Customer — {editCustomer.code}</h2>
              <button onClick={() => setEditCustomer(null)} className="p-1 rounded hover:bg-[#E2DDD8]">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <h3 className="text-sm font-semibold text-[#6B5C32]">Company Information</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Customer Name *</label>
                  <Input value={editCustForm.name} onChange={(e) => setEditCustForm(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">SSM No.</label>
                  <Input value={editCustForm.ssmNo} onChange={(e) => setEditCustForm(f => ({ ...f, ssmNo: e.target.value }))} placeholder="e.g. 201901012345" />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-[#6B7280] mb-1">Company Address</label>
                  <Input value={editCustForm.companyAddress} onChange={(e) => setEditCustForm(f => ({ ...f, companyAddress: e.target.value }))} placeholder="Registered company address" />
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">PIC</label>
                  <Input value={editCustForm.contactName} onChange={(e) => setEditCustForm(f => ({ ...f, contactName: e.target.value }))} />
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Phone</label>
                  <Input value={editCustForm.phone} onChange={(e) => setEditCustForm(f => ({ ...f, phone: e.target.value }))} />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-[#6B7280] mb-1">Email</label>
                  <Input value={editCustForm.email} onChange={(e) => setEditCustForm(f => ({ ...f, email: e.target.value }))} />
                </div>
              </div>
              <h3 className="text-sm font-semibold text-[#6B5C32] pt-2">Credit & Terms</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Credit Terms</label>
                  <select
                    value={editCustForm.creditTerms}
                    onChange={(e) => setEditCustForm(f => ({ ...f, creditTerms: e.target.value }))}
                    className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20"
                  >
                    <option value="COD">COD</option>
                    <option value="NET15">NET15</option>
                    <option value="NET30">NET30</option>
                    <option value="NET45">NET45</option>
                    <option value="NET60">NET60</option>
                    <option value="NET90">NET90</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Credit Limit (RM)</label>
                  <Input type="number" value={editCustForm.creditLimitSen / 100} onChange={(e) => setEditCustForm(f => ({ ...f, creditLimitSen: Math.round(Number(e.target.value) * 100) }))} />
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2DDD8]">
              <Button variant="outline" onClick={() => setEditCustomer(null)}>Cancel</Button>
              <Button variant="primary" onClick={saveEditCustomer} disabled={!editCustForm.name}>Save Changes</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
