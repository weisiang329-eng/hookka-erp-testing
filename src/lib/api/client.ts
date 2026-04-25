// ---------------------------------------------------------------------------
// apiClient — the single typed handle every page/component should reach for.
//
// Composition is flat: each resource module exports its own object with the
// CRUD verbs, and we collect them here. Adding a new resource = create a
// file under ./resources and add one line below.
//
// Why a singleton: there's no per-request configuration the SDK needs (auth
// is read from localStorage at call-time, base URL is the same origin).
// A class would give nothing over a frozen object literal.
// ---------------------------------------------------------------------------
import { customers, customerHubs, customerProducts } from "./resources/customers";
import { products } from "./resources/products";
import { salesOrders } from "./resources/sales-orders";
import { productionOrders } from "./resources/production-orders";
import { deliveryOrders } from "./resources/delivery-orders";
import {
  invoices,
  payments,
  creditNotes,
  debitNotes,
  eInvoices,
} from "./resources/billing";
import { purchaseOrders, grns, suppliers } from "./resources/procurement";
import { workers, payslips, attendance } from "./resources/hr";
import {
  equipment,
  maintenance,
  rdProjects,
  consignments,
  bomTemplates,
} from "./resources/operations";

export const apiClient = Object.freeze({
  // Master / customer
  customers,
  customerHubs,
  customerProducts,
  products,

  // Sales pipeline
  salesOrders,
  productionOrders,
  deliveryOrders,

  // Billing
  invoices,
  payments,
  creditNotes,
  debitNotes,
  eInvoices,

  // Procurement
  purchaseOrders,
  grns,
  suppliers,

  // HR
  workers,
  payslips,
  attendance,

  // Operations
  equipment,
  maintenance,
  rdProjects,
  consignments,
  bomTemplates,
});

export type ApiClient = typeof apiClient;
