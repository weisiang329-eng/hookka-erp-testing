// Navigation model for the mobile (phone) UI.
//
// - TABS: the 5 bottom-tab destinations (Home, Sales, Production, Procure, More).
// - MORE_GROUPS: the grouped module list shown on the "More" screen. Each row
//   routes to a module screen under /m/* (Phase 2 builds the real screens; for
//   now they land on a placeholder). NO QR-scan tab anywhere.
import {
  Home,
  ShoppingCart,
  Factory,
  ShoppingBag,
  Truck,
  LayoutGrid,
  Megaphone,
  Mail,
  Users,
  CalendarRange,
  Warehouse,
  Package,
  Receipt,
  UserSquare,
  Wrench,
  UserPlus,
  Shapes,
  HardHat,
  Wallet,
  FlaskConical,
  type LucideIcon,
} from "lucide-react";

export type TabKey = "home" | "sales" | "delivery" | "procure" | "more";

export type TabDef = {
  key: TabKey;
  label: string;
  icon: LucideIcon;
  /** Route this tab navigates to. "more" opens the More screen. */
  path: string;
  /** When true this slot renders as the floating circular center button. */
  raised?: boolean;
};

// Bottom-nav: 5 slots with More as the CENTER raised button (owner 2026-06-28,
// reference: a colored circular grid button popping above the bar). Order per
// dc12 design v12:
//   Home · Sales · [More — center raised button] · Delivery · Procure.
// Production moved to the More menu — for office staff Delivery is a more
// common one-tap target than Production. The `raised` flag tells BottomTabBar
// to render that slot as the floating circular action button.
export const TABS: TabDef[] = [
  { key: "home", label: "Home", icon: Home, path: "/m" },
  { key: "sales", label: "Sales", icon: ShoppingCart, path: "/m/sales" },
  { key: "more", label: "More", icon: LayoutGrid, path: "/m/more", raised: true },
  { key: "delivery", label: "Delivery", icon: Truck, path: "/m/delivery" },
  { key: "procure", label: "Procure", icon: ShoppingBag, path: "/m/procurement" },
];


export type ModuleLink = {
  label: string;
  icon: LucideIcon;
  /** Route under /m/*. Phase 2 replaces placeholders with real screens. */
  path: string;
  /**
   * Optional red count badge (design source: e.g. an unread count on Mail /
   * Announcements). Left unset until a real count source is wired — we never
   * fabricate a number. // TODO: populate from unread mail / new announcements.
   */
  badge?: string | number;
};

export type ModuleGroup = {
  title: string;
  items: ModuleLink[];
};

// Group order + items per dc12 design v12 More menu:
//   Overview → Sales & Customers → Service & Support → Production →
//   Warehouse & Procurement → People & Finance → System.
// Order is owner-exacting (the design source's grouping); icons match the
// dc12 lucide names (megaphone / mail / shopping-cart / users / truck /
// receipt / wrench / factory / calendar-days / shapes / warehouse / package
// / shopping-bag / building-2 / hard-hat / wallet / user-plus).
export const MORE_GROUPS: ModuleGroup[] = [
  {
    title: "Overview",
    items: [
      { label: "Announcements", icon: Megaphone, path: "/m/announcements" },
      { label: "Mail Center", icon: Mail, path: "/m/mail-center" },
    ],
  },
  {
    title: "Sales & Customers",
    items: [
      { label: "Sales Orders", icon: ShoppingCart, path: "/m/sales" },
      { label: "Delivery Orders", icon: Truck, path: "/m/delivery" },
      { label: "Invoices", icon: Receipt, path: "/m/invoices" },
      { label: "Customers", icon: Users, path: "/m/customers" },
    ],
  },
  {
    title: "Service & Support",
    items: [
      { label: "Service Cases", icon: Wrench, path: "/m/servicecases" },
      { label: "Service Orders", icon: Wrench, path: "/m/serviceorders" },
    ],
  },
  {
    title: "Production",
    items: [
      { label: "Production Orders", icon: Factory, path: "/m/production" },
      { label: "Planning", icon: CalendarRange, path: "/m/planning" },
      { label: "Products", icon: Shapes, path: "/m/products" },
      { label: "Warehouse", icon: Warehouse, path: "/m/warehouse" },
      { label: "R&D Projects", icon: FlaskConical, path: "/m/rd" },
    ],
  },
  {
    title: "Warehouse & Procurement",
    items: [
      { label: "Inventory", icon: Package, path: "/m/inventory" },
      { label: "Purchase Orders", icon: ShoppingBag, path: "/m/procurement" },
      { label: "Suppliers", icon: UserSquare, path: "/m/suppliers" },
      { label: "3PL Providers", icon: Truck, path: "/m/logistics" },
    ],
  },
  {
    title: "People & Finance",
    items: [
      { label: "Employees", icon: HardHat, path: "/m/employees" },
      { label: "Receivables", icon: Wallet, path: "/m/receivables" },
    ],
  },
  // System — owner 2026-06-28 design v12: User Management is a SUPER_ADMIN
  // tool but the link belongs here for parity with the desktop /settings/users.
  // The mobile list is read-only (mutations live on the desktop page); see
  // usermgmtConfig in src/pages/m/config/modules.ts.
  {
    title: "System",
    items: [
      { label: "User Management", icon: UserPlus, path: "/m/usermgmt" },
    ],
  },
];

