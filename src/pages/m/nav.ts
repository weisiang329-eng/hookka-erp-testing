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
  Menu,
  Megaphone,
  Mail,
  Users,
  CalendarRange,
  Boxes,
  Warehouse,
  Package,
  FileText,
  Receipt,
  UserSquare,
  type LucideIcon,
} from "lucide-react";

export type TabKey = "home" | "sales" | "production" | "procure" | "more";

export type TabDef = {
  key: TabKey;
  label: string;
  icon: LucideIcon;
  /** Route this tab navigates to. "more" opens the More screen. */
  path: string;
};

// Bottom-nav icons mirror the design source exactly:
//   Home → house · Sales → shopping-cart · Production → factory ·
//   Procure → shopping-bag · More → menu.
export const TABS: TabDef[] = [
  { key: "home", label: "Home", icon: Home, path: "/m" },
  { key: "sales", label: "Sales", icon: ShoppingCart, path: "/m/sales" },
  { key: "production", label: "Production", icon: Factory, path: "/m/production" },
  { key: "procure", label: "Procure", icon: ShoppingBag, path: "/m/procurement" },
  { key: "more", label: "More", icon: Menu, path: "/m/more" },
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
      { label: "Customers", icon: Users, path: "/m/customers" },
      { label: "Delivery", icon: Truck, path: "/m/delivery" },
      { label: "Invoices", icon: Receipt, path: "/m/invoices" },
    ],
  },
  {
    title: "Production",
    items: [
      { label: "Production Orders", icon: Factory, path: "/m/production" },
      { label: "Planning", icon: CalendarRange, path: "/m/planning" },
      { label: "Products", icon: Package, path: "/m/products" },
      { label: "Warehouse", icon: Warehouse, path: "/m/warehouse" },
    ],
  },
  {
    title: "Warehouse & Procurement",
    items: [
      { label: "Inventory", icon: Boxes, path: "/m/inventory" },
      { label: "Purchase Orders", icon: FileText, path: "/m/procurement" },
      { label: "Suppliers", icon: UserSquare, path: "/m/suppliers" },
    ],
  },
  {
    title: "People & Finance",
    items: [
      { label: "Employees", icon: Users, path: "/m/employees" },
      { label: "Receivables", icon: Receipt, path: "/m/receivables" },
    ],
  },
];
