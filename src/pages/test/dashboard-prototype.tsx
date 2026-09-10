import { useState } from "react";
import { SalesOrdersView } from "./SalesOrdersView";
import { DeliveryOrdersView } from "./DeliveryOrdersView";
import { InventoryView } from "./InventoryView";
import { PurchaseOrdersView } from "./PurchaseOrdersView";
import { EmployeesView } from "./EmployeesView";
import { ProductionTrackingView } from "./ProductionTrackingView";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, type TabItem } from "@/components/ui/tabs";

// ---------------------------------------------------------------------------
// Dashboard Prototype — a native React port of the design prototype, which
// used to be a single 8,356-line static HTML report loaded into a sandboxed
// iframe (deleted 2026-09-04). That approach was rejected: wrong theme
// (auto-dark, fought the app's own light theme), boxed internal scrolling,
// and — the real reason — it was a dead end for a REAL page: nothing in an
// injected srcdoc document can be a real, navigable, testable React screen.
//
// This is a from-scratch port, tab by tab, starting with Sales Orders (the
// tab the owner picked first). The other five tabs from the original
// (Delivery Orders / Inventory / Purchase Orders / Employees / Production
// Tracking) are NOT built yet — their buttons are shown, disabled, so the
// full shape of the original is visible while only one tab actually works.
//
// THEME (owner 2026-09-08): the first React port kept the static prototype's
// own look — Fraunces/Public Sans/IBM Plex Mono loaded from Google Fonts, a
// cream (#FBF7F1) background, and a hand-rolled palette that only
// approximated the app's real tokens. That made this page visibly a
// different product from the rest of the ERP. It now uses the SAME
// PageHeader / Card / Tabs / StatusBadge components and the same hex
// tokens (#1F1D1B ink, #6B5C32 taupe, #6B7280 muted, #E2DDD8 border — see
// src/index.css and src/pages/sales/index.tsx) as every other page, and no
// font is loaded — the app's default font-sans (system-ui) applies here too.
// ---------------------------------------------------------------------------

const TABS: TabItem<
  "sales" | "delivery" | "inventory" | "purchase" | "employee" | "production"
>[] = [
  { key: "sales", label: "Sales Orders" },
  { key: "delivery", label: "Delivery Orders" },
  { key: "inventory", label: "Inventory" },
  { key: "purchase", label: "Purchase Orders" },
  { key: "employee", label: "Employees" },
  { key: "production", label: "Production Tracking" },
];

export default function DashboardPrototypePage() {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("sales");

  return (
    <div className="space-y-6 max-md:space-y-4">
      <PageHeader
        title="Overview"
        subtitle="Sales & Customers · live where noted"
        actions={
          <Tabs tabs={TABS} value={tab} onChange={setTab} variant="pill" />
        }
      />

      {tab === "sales" && <SalesOrdersView />}
      {tab === "delivery" && <DeliveryOrdersView />}
      {tab === "inventory" && <InventoryView />}
      {tab === "purchase" && <PurchaseOrdersView />}
      {tab === "employee" && <EmployeesView />}
      {tab === "production" && <ProductionTrackingView />}
    </div>
  );
}
